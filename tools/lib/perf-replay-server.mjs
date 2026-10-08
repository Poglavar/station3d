// Serve one complete engine distribution and a host against an explicit immutable source archive.
import { createServer } from 'node:http';
import { lstatSync, realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, extname, sep } from 'node:path';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const hasPerfReplayFailure = requests => requests.some(row =>
    row.outcome !== 'pending' && (row.hash === null || row.error != null));
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.wasm': 'application/wasm',
    '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary' };

function normalizedExcludes(exclude) {
    if (!Array.isArray(exclude) || exclude.some(item => typeof item !== 'string')) {
        throw new TypeError('exclude must be an array of relative paths');
    }
    return exclude.map(item => item.replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''));
}

function isExcluded(pathname, excludes) {
    return excludes.some(prefix => prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`)));
}

export async function fingerprintDirectory(root, { exclude = [] } = {}) {
    const rootPath = realpathSync(root), excludes = normalizedExcludes(exclude), entries = [];
    async function visit(directory) {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            if (entry.name.startsWith('.')) continue;
            const file = resolve(directory, entry.name);
            const relativePath = relative(rootPath, file).split(sep).join('/');
            if (isExcluded(relativePath, excludes)) continue;
            if (entry.isDirectory()) await visit(file);
            else if (entry.isFile()) {
                const bytes = await readFile(file);
                entries.push({ file: relativePath, hash: sha256(bytes), bytes: bytes.length });
            }
            // Symlinks and other special files are intentionally not public fingerprint inputs.
        }
    }
    await visit(rootPath);
    return { hash: sha256(JSON.stringify(entries)), entries };
}

export function resolvePublicFile(root, pathname) {
    const decoded = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (decoded.split('/').some(part => part.startsWith('.'))) throw new Error('Private/path traversal request');
    const realRoot = realpathSync(root);
    const file = resolve(realRoot, decoded);
    if (!file.startsWith(realRoot + sep)) throw new Error('Path escapes public root');
    const realFile = realpathSync(file);
    if (realFile !== file || !realFile.startsWith(realRoot + sep)) throw new Error('Symlink path is not public');
    if (!lstatSync(file).isFile()) throw new Error('Public path is not a regular file');
    return file;
}

function fingerprintMap(fingerprint, label) {
    if (!fingerprint || !Array.isArray(fingerprint.entries)) throw new TypeError(`${label} fingerprint is required`);
    return new Map(fingerprint.entries.map(entry => [entry.file, entry]));
}

function normalizeExternalOrigins(origins) {
    if (!Array.isArray(origins)) throw new TypeError('externalOrigins must be an array of exact HTTP(S) origins');
    const normalized = [];
    for (const origin of origins) {
        if (typeof origin !== 'string') throw new TypeError('externalOrigins entries must be strings');
        let parsed;
        try { parsed = new URL(origin); } catch { throw new TypeError(`Invalid external origin: ${origin}`); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin
            || parsed.username || parsed.password) throw new TypeError(`Expected an exact HTTP(S) origin: ${origin}`);
        if (normalized.includes(origin)) throw new TypeError(`Duplicate external origin: ${origin}`);
        normalized.push(origin);
    }
    return new Set(normalized);
}

// The archive currently stores root-relative source keys, so encode the full original URL
// into a query value. This keeps both origin and every path/query byte in archive identity.
function externalArchiveUrl(apiPrefix, target) {
    return `${apiPrefix}__external?url=${encodeURIComponent(target)}`;
}

export async function startPerfReplayServer({ hostRoot, engineDist, engineUrlPrefix = '/vendor/station3d/',
    apiPrefix = '/api/', providerBaseUrl, archive, recording = false, expectedResponses = [], log = () => {}, fingerprints,
    externalOrigins = [], vectorSources = null }) {
    if (!engineUrlPrefix.startsWith('/') || !engineUrlPrefix.endsWith('/')
        || !apiPrefix.startsWith('/') || !apiPrefix.endsWith('/')) throw new Error('URL prefixes must start and end with /');
    const permittedExternalOrigins = normalizeExternalOrigins(externalOrigins);
    if (recording && ((!providerBaseUrl && !permittedExternalOrigins.size) || archive.sealed)) {
        throw new Error('Recording needs a provider URL or external origins and an unsealed archive');
    }
    if (!recording && !archive.sealed) throw new Error('Replay needs a sealed archive');
    const engineMount = engineUrlPrefix.replace(/^\/+|\/+$/g, '');
    const startupFingerprints = fingerprints || {
        host: await fingerprintDirectory(hostRoot, { exclude: [engineMount] }),
        engine: await fingerprintDirectory(engineDist),
    };
    const hostFiles = fingerprintMap(startupFingerprints.host, 'host');
    const engineFiles = fingerprintMap(startupFingerprints.engine, 'engine');
    const requests = [], errors = [], served = new Map(), pending = new Map(), activeRequests = new Set();
    const allowed = (pathname, status) => status < 400 || expectedResponses.some(rule =>
        new RegExp(rule.pathnamePattern).test(pathname) && rule.statuses.includes(status));
    async function handleRequest(req, res) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        const url = new URL(req.url, 'http://replay.local');
        let requestRow = null;
        try {
            if (url.pathname.startsWith(apiPrefix)) {
                const externalEndpoint = `${apiPrefix}__external`;
                const isExternal = url.pathname === externalEndpoint;
                const externalValues = isExternal ? url.searchParams.getAll('url') : [];
                const externalTarget = isExternal && externalValues.length === 1 ? externalValues[0] : null;
                const archiveUrl = isExternal && externalTarget ? externalArchiveUrl(apiPrefix, externalTarget) : url.href;
                requestRow = { at: Date.now(), key: externalTarget || url.pathname + url.search,
                    archiveKey: archiveUrl, hash: null,
                    status: null, providerStatus: null, outcome: 'pending', error: null };
                requests.push(requestRow);
                if (req.method !== 'GET') throw new Error(`Unexpected provider method: ${req.method}`);
                if (isExternal) {
                    if (externalValues.length !== 1 || !externalTarget) throw new Error('External source request needs exactly one absolute url parameter');
                    let target;
                    try { target = new URL(externalTarget); }
                    catch { throw new Error(`Invalid external source URL: ${externalTarget}`); }
                    if (!['http:', 'https:'].includes(target.protocol) || !permittedExternalOrigins.has(target.origin)
                        || target.username || target.password || target.hash) {
                        throw new Error(`External origin is not allowed: ${target.origin}`);
                    }
                }
                // An explicitly configured vector source owns its endpoint for
                // every query. Never mix a new snapshot with old exact responses,
                // or fall back to a provider when its coverage check fails.
                const vector = !isExternal && vectorSources ? await vectorSources.resolve(archiveUrl) : null;
                let source = vector || archive.lookup(archiveUrl);
                let outcome = vector ? 'derived' : 'replayed', providerStatus = null;
                if (!source && recording) {
                    outcome = 'recorded';
                    const key = archiveUrl;
                    if (!pending.has(key)) pending.set(key, (async () => {
                        let upstreamStatus = null;
                        try {
                            const upstream = isExternal ? externalTarget
                                : providerBaseUrl.replace(/\/$/, '') + url.pathname.slice(apiPrefix.length - 1) + url.search;
                            const response = await fetch(upstream, { signal: AbortSignal.timeout(90000),
                                redirect: isExternal ? 'manual' : 'follow' });
                            upstreamStatus = response.status;
                            const body = Buffer.from(await response.arrayBuffer());
                            archive.record(archiveUrl, body, response.headers.get('content-type') || 'application/octet-stream', response.status);
                            archive.save();
                            return { source: archive.lookup(archiveUrl), providerStatus: response.status };
                        } catch (error) {
                            if (upstreamStatus !== null) error.providerStatus = upstreamStatus;
                            throw error;
                        }
                    })().finally(() => pending.delete(key)));
                    const recorded = await pending.get(key);
                    source = recorded.source;
                    providerStatus = recorded.providerStatus;
                }
                requestRow.status = source?.entry.status ?? null;
                requestRow.providerStatus = providerStatus;
                if (!source) {
                    requestRow.outcome = 'miss';
                    throw new Error(`Missing frozen source: ${requestRow.key}`);
                }
                // Verify exactly the bytes sent, including changes after archive open.
                // Do not retain a process-wide body cache for a large provider archive.
                const body = vector ? vector.body : await readFile(source.bodyPath);
                if (body.length !== source.entry.bytes || sha256(body) !== source.entry.hash) {
                    throw new Error(`Corrupt source blob: ${source.entry.hash}`);
                }
                requestRow.hash = source.entry.hash;
                requestRow.outcome = outcome;
                if (vector) {
                    requestRow.fixtureHash = vector.fixtureHash;
                    requestRow.fixtureId = vector.fixtureId;
                    requestRow.featureCount = vector.featureCount;
                    res.setHeader('X-Source-Dataset-SHA256', vector.fixtureHash);
                }
                res.writeHead(source.entry.status, { 'Content-Type': source.entry.contentType,
                    'X-Source-SHA256': source.entry.hash });
                res.end(body);
                return;
            }
            if (!['GET', 'HEAD'].includes(req.method)) throw new Error(`Unexpected host method: ${req.method}`);
            const engine = url.pathname.startsWith(engineUrlPrefix);
            const pathname = engine ? url.pathname.slice(engineUrlPrefix.length) : url.pathname;
            const root = engine ? engineDist : hostRoot;
            const file = resolvePublicFile(root, pathname);
            const body = await readFile(file);
            const filePath = relative(realpathSync(root), file).split(sep).join('/');
            const key = `${engine ? 'engine' : 'host'}/${filePath}`;
            const expected = (engine ? engineFiles : hostFiles).get(filePath);
            if (!expected) throw new Error(`Served file is absent from startup fingerprint: ${key}`);
            const hash = sha256(body);
            if (hash !== expected.hash || body.length !== expected.bytes) throw new Error(`Served file differs from startup fingerprint: ${key}`);
            const previous = served.get(key);
            if (previous && previous.hash !== hash) throw new Error(`Served file changed: ${key}`);
            served.set(key, { file: key, hash, bytes: body.length });
            res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
            res.end(req.method === 'HEAD' ? undefined : body);
        } catch (error) {
            const status = error.code === 'ENOENT' ? 404 : 502;
            if (requestRow) {
                requestRow.outcome = requestRow.outcome === 'miss' ? 'miss' : 'failed';
                requestRow.error = error.message;
                requestRow.providerStatus ??= error.providerStatus ?? null;
                requestRow.serverStatus = status;
            }
            if (!allowed(url.pathname, status)) errors.push({ at: Date.now(), url: url.pathname + url.search,
                status, message: error.message });
            log('source/server', error.message);
            if (!res.headersSent) res.writeHead(status);
            res.end(error.message);
        }
    }
    const server = createServer((req, res) => {
        const task = handleRequest(req, res);
        activeRequests.add(task);
        task.then(() => activeRequests.delete(task), error => {
            errors.push({ at: Date.now(), url: req.url, message: error.message });
            activeRequests.delete(task);
            res.destroy(error);
        });
    });
    await new Promise((accept, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', accept);
    });
    return { origin: `http://127.0.0.1:${server.address().port}`, requests, errors, served,
        async close() {
            server.closeAllConnections();
            await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
            await Promise.allSettled([...activeRequests]);
        } };
}
