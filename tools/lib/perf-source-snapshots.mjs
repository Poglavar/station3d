// Read pinned offline HTTP snapshots through a loopback adapter, failing closed
// whenever the manifest, dataset, or response differs from the captured source.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const PERF_HTTP_SNAPSHOT_SCHEMA = 'station3d-perf-http-snapshot-v1';
const SHA256 = /^[a-f0-9]{64}$/i;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const BODY_MAX_BYTES = 40 * 1024 * 1024;
const TIMEOUT_MS = 90_000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function freezeTree(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) freezeTree(child);
    }
    return value;
}

function fail(message) { throw new Error(`Invalid performance snapshot: ${message}`); }

function safePathname(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || value.includes('?')
        || value.includes('#') || value.includes('\\') || value.includes('//') || /[\u0000-\u001f\u007f]/.test(value)) return false;
    let parsed;
    try { parsed = new URL(value, 'http://127.0.0.1'); } catch { return false; }
    if (parsed.origin !== 'http://127.0.0.1' || parsed.pathname !== value) return false;
    for (const segment of value.split('/').slice(1)) {
        let decoded;
        try { decoded = decodeURIComponent(segment); } catch { return false; }
        if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')
            || /[\u0000-\u001f\u007f]/.test(decoded)) return false;
    }
    return true;
}

function safeRelativeFile(value) {
    if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')
        || value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) return false;
    const normalized = value.split('/');
    return normalized.every(segment => segment && segment !== '.' && segment !== '..');
}

function parseOrigin(value) {
    if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) {
        fail('origin must be exactly http://127.0.0.1:<port>');
    }
    const port = Number(value.slice(value.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port > 65535) fail('origin port is out of range');
    return value;
}

function validateManifest(manifest, label) {
    if (!isRecord(manifest) || manifest.schema !== PERF_HTTP_SNAPSHOT_SCHEMA) fail(`${label} has the wrong schema`);
    if (typeof manifest.id !== 'string' || !manifest.id.trim()) fail(`${label}.id is required`);
    if (!Array.isArray(manifest.pathnames) || !manifest.pathnames.length
        || manifest.pathnames.some(pathname => !safePathname(pathname))
        || new Set(manifest.pathnames).size !== manifest.pathnames.length) {
        fail(`${label}.pathnames must be unique safe absolute paths`);
    }
    const coverage = manifest.coverage;
    if (!isRecord(coverage) || coverage.complete !== true || typeof coverage.scope !== 'string' || !coverage.scope.trim()
        || !Array.isArray(coverage.bbox) || coverage.bbox.length !== 4
        || !coverage.bbox.every(Number.isFinite)
        || coverage.bbox[0] < -180 || coverage.bbox[2] > 180 || coverage.bbox[0] >= coverage.bbox[2]
        || coverage.bbox[1] < -90 || coverage.bbox[3] > 90 || coverage.bbox[1] >= coverage.bbox[3]) {
        fail(`${label}.coverage must be complete with a scope and valid bbox`);
    }
    const provenance = manifest.provenance;
    if (!isRecord(provenance) || typeof provenance.capturedAt !== 'string'
        || !Number.isFinite(Date.parse(provenance.capturedAt))
        || typeof provenance.sourceRevision !== 'string' || !provenance.sourceRevision.trim()
        || typeof provenance.transactionSnapshot !== 'string' || !provenance.transactionSnapshot.trim()) {
        fail(`${label}.provenance needs capturedAt, sourceRevision, and transactionSnapshot`);
    }
    if (!Array.isArray(manifest.files) || !manifest.files.length) fail(`${label}.files must be nonempty`);
    const filePaths = new Set();
    for (const file of manifest.files) {
        if (!isRecord(file) || !safeRelativeFile(file.file) || filePaths.has(file.file)
            || !SHA256.test(file.sha256 || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0
            || !['code', 'data'].includes(file.role)) {
            fail(`${label}.files must have unique safe paths, SHA-256 hashes, byte counts, and code/data roles`);
        }
        filePaths.add(file.file);
    }
    return {
        schema: manifest.schema,
        id: manifest.id,
        pathnames: [...manifest.pathnames].sort(),
        coverage: structuredClone(coverage),
        provenance: structuredClone(provenance),
        files: manifest.files.map(file => ({ file: file.file, sha256: file.sha256.toLowerCase(), bytes: file.bytes, role: file.role }))
            .sort((a, b) => a.file.localeCompare(b.file)),
    };
}

async function boundedRead(response, limit, label) {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) {
                await reader.cancel().catch(() => {});
                throw new Error(`${label} exceeds ${limit} bytes`);
            }
            chunks.push(Buffer.from(value));
        }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, total);
}

async function cancelResponse(response) {
    if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
}

async function getSnapshotMetadata(source) {
    const response = await fetch(`${source.origin}/__station3d_snapshot`, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status !== 200) {
        await cancelResponse(response);
        throw new Error(`Snapshot metadata returned HTTP ${response.status}`);
    }
    if (response.headers.get('x-source-dataset-sha256') !== source.manifestHash) {
        await cancelResponse(response);
        throw new Error('Snapshot metadata dataset hash header does not match the pinned manifest');
    }
    const body = await boundedRead(response, MANIFEST_MAX_BYTES, 'Snapshot metadata response');
    if (sha256(body) !== source.manifestHash || !body.equals(source.manifestBytes)) {
        throw new Error('Snapshot metadata bytes do not match the pinned manifest');
    }
}

function requestPathAndSearch(requestURL) {
    const text = requestURL instanceof URL ? requestURL.href : requestURL;
    if (typeof text !== 'string') throw new TypeError('Snapshot request URL must be a string or URL');
    const match = /^(https?):\/\/([^/?#]+)([^#]*)$/i.exec(text);
    if (!match) throw new TypeError('Snapshot request URL must be absolute and have no fragment');
    let parsed;
    try { parsed = new URL(text); } catch { throw new TypeError('Snapshot request URL is invalid'); }
    if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) {
        throw new TypeError('Snapshot request URL must not contain credentials');
    }
    const rawTail = match[3] || '/';
    const rawPath = rawTail.startsWith('?') ? '/' : rawTail.split('?')[0];
    if (parsed.pathname !== rawPath) throw new TypeError('Snapshot request pathname is ambiguous');
    return { pathname: rawPath, pathAndSearch: rawTail.startsWith('?') ? `/${rawTail}` : rawTail };
}

export async function openPerfSnapshotSources(sources = [], { root = process.cwd() } = {}) {
    if (!Array.isArray(sources)) throw new TypeError('Performance snapshot sources must be an array');
    const rootPath = await realpath(resolve(root));
    const loaded = [];
    const owners = new Map();
    const ids = new Set();

    for (let index = 0; index < sources.length; index++) {
        const input = sources[index];
        if (!isRecord(input) || !safeRelativeFile(input.file) || !SHA256.test(input.sha256 || '')) {
            fail(`source ${index} needs a safe relative manifest file and SHA-256 pin`);
        }
        const origin = parseOrigin(input.origin);
        const manifestPath = resolve(rootPath, input.file);
        const rel = relative(rootPath, manifestPath);
        if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`source ${index} manifest escapes root`);
        const stat = await lstat(manifestPath);
        if (!stat.isFile() || stat.isSymbolicLink()) fail(`source ${index} manifest must be a regular file`);
        const actualPath = await realpath(manifestPath);
        const actualRel = relative(rootPath, actualPath);
        if (!actualRel || actualRel === '..' || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) {
            fail(`source ${index} manifest resolves outside root`);
        }
        if (stat.size > MANIFEST_MAX_BYTES) fail(`source ${index} manifest exceeds ${MANIFEST_MAX_BYTES} bytes`);
        const manifestBytes = await readFile(manifestPath);
        const manifestHash = sha256(manifestBytes);
        if (manifestHash !== input.sha256.toLowerCase()) fail(`source ${index} manifest hash does not match its pin`);
        let manifest;
        try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
        catch (error) { fail(`source ${index} manifest JSON is invalid: ${error.message}`); }
        const identity = validateManifest(manifest, `source ${index}`);
        if (ids.has(identity.id)) fail(`duplicate source id ${identity.id}`);
        ids.add(identity.id);
        const source = { origin, manifestPath, manifestBytes, manifestHash, identity };
        for (const pathname of identity.pathnames) {
            if (owners.has(pathname)) fail(`duplicate owner for pathname ${pathname}`);
            owners.set(pathname, source);
        }
        await getSnapshotMetadata(source);
        loaded.push(source);
    }

    const identities = freezeTree(loaded.map(source => ({ ...source.identity, hash: source.manifestHash }))
        .sort((a, b) => a.id.localeCompare(b.id)));

    async function assertManifestUnchanged(source) {
        const stat = await lstat(source.manifestPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MANIFEST_MAX_BYTES) {
            throw new Error(`Pinned snapshot manifest is no longer a bounded regular file: ${source.identity.id}`);
        }
        const actualPath = await realpath(source.manifestPath);
        const actualRel = relative(rootPath, actualPath);
        if (!actualRel || actualRel === '..' || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) {
            throw new Error(`Pinned snapshot manifest resolves outside root: ${source.identity.id}`);
        }
        const bytes = await readFile(source.manifestPath);
        if (sha256(bytes) !== source.manifestHash || !bytes.equals(source.manifestBytes)) {
            throw new Error(`Pinned snapshot manifest changed: ${source.identity.id}`);
        }
    }

    return {
        identities,
        async resolve(requestURL) {
            const { pathname, pathAndSearch } = requestPathAndSearch(requestURL);
            const source = owners.get(pathname);
            if (!source) return null;
            await assertManifestUnchanged(source);
            const response = await fetch(`${source.origin}${pathAndSearch}`, {
                method: 'GET', redirect: 'manual',
                headers: { 'X-Expected-Source-Dataset-SHA256': source.manifestHash },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (response.status !== 200) {
                await cancelResponse(response);
                throw new Error(`Snapshot ${source.identity.id} returned HTTP ${response.status}`);
            }
            if (response.headers.get('x-source-dataset-sha256') !== source.manifestHash) {
                await cancelResponse(response);
                throw new Error(`Snapshot ${source.identity.id} dataset hash header does not match its pin`);
            }
            const contentType = response.headers.get('content-type') || '';
            if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|\s*$)/i.test(contentType)) {
                await cancelResponse(response);
                throw new Error(`Snapshot ${source.identity.id} response is not JSON`);
            }
            const body = await boundedRead(response, BODY_MAX_BYTES, `Snapshot ${source.identity.id} response`);
            const bodyHash = sha256(body);
            if (response.headers.get('x-source-sha256') !== bodyHash) {
                throw new Error(`Snapshot ${source.identity.id} body hash header does not match response bytes`);
            }
            return {
                entry: { hash: bodyHash, bytes: body.length, status: 200, contentType },
                body,
                fixtureHash: source.manifestHash,
                fixtureId: source.identity.id,
            };
        },
        async verify() {
            for (const source of loaded) {
                await assertManifestUnchanged(source);
                await getSnapshotMetadata(source);
            }
            return identities;
        },
    };
}
