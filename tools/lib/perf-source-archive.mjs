// Immutable, content-addressed HTTP response cassettes for reproducible audits.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SCHEMA = 'station3d-perf-source-archive-v1';
const LEGACY_SCHEMA = 'station3d-audit-source-fixtures-v2';
const MANIFEST = 'manifest.json';
const HEX_SHA256 = /^[a-f0-9]{64}$/;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const stableJson = value => JSON.stringify(value);

function parseResourceUrl(value) {
    if (typeof value !== 'string' && !(value instanceof URL)) {
        throw new TypeError('Source URL must be a string or URL');
    }
    const text = String(value);
    if (!text || text.includes('#')) throw new TypeError('Source URL must not contain a fragment');
    if (text.startsWith('/')) {
        const question = text.indexOf('?');
        const pathname = question < 0 ? text : text.slice(0, question);
        const search = question < 0 ? '' : text.slice(question);
        if (!pathname.startsWith('/')) throw new TypeError('Source URL must have an absolute path');
        return { pathname, search };
    }
    let parsed;
    try { parsed = new URL(text); } catch { throw new TypeError('Source URL must be absolute or root-relative'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
        throw new TypeError('Source URL must use HTTP or HTTPS');
    }
    return { pathname: parsed.pathname, search: parsed.search };
}

function decodeQueryName(component) {
    const equals = component.indexOf('=');
    const raw = equals < 0 ? component : component.slice(0, equals);
    try { return decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { return null; }
}

function normalizeRules(rules) {
    if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
    return rules.map((rule, index) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)
            || typeof rule.pathnamePattern !== 'string' || !rule.pathnamePattern
            || !Array.isArray(rule.dropQueryParameters)
            || rule.dropQueryParameters.some(name => typeof name !== 'string' || !name)) {
            throw new TypeError(`Invalid source key rule at index ${index}`);
        }
        try { new RegExp(rule.pathnamePattern); } catch { throw new TypeError(`Invalid pathnamePattern at rule ${index}`); }
        if (new Set(rule.dropQueryParameters).size !== rule.dropQueryParameters.length) {
            throw new TypeError(`Duplicate query parameter in rule ${index}`);
        }
        return { pathnamePattern: rule.pathnamePattern, dropQueryParameters: [...rule.dropQueryParameters] };
    });
}

function normalizeAllowedResponses(allowedResponses) {
    if (!Array.isArray(allowedResponses)) throw new TypeError('allowedResponses must be an array');
    return allowedResponses.map((rule, index) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)
            || typeof rule.pathnamePattern !== 'string' || !rule.pathnamePattern
            || !Array.isArray(rule.statuses) || !rule.statuses.length
            || rule.statuses.some(status => !Number.isInteger(status) || status < 100 || status > 599)) {
            throw new TypeError(`Invalid allowed response rule at index ${index}`);
        }
        try { new RegExp(rule.pathnamePattern); } catch { throw new TypeError(`Invalid allowed pathnamePattern at rule ${index}`); }
        if (new Set(rule.statuses).size !== rule.statuses.length) {
            throw new TypeError(`Duplicate status in allowed response rule ${index}`);
        }
        return { pathnamePattern: rule.pathnamePattern, statuses: [...rule.statuses].sort((a, b) => a - b) };
    });
}

function regexMatches(pattern, pathname) {
    return new RegExp(pattern).test(pathname);
}

function responseAllowed(pathname, status, allowedResponses) {
    return status >= 200 && status < 300
        || allowedResponses.some(rule => rule.statuses.includes(status)
            && regexMatches(rule.pathnamePattern, pathname));
}

function sourceKeyFromParts(pathname, search, rules) {
    let query = search.startsWith('?') ? search.slice(1) : search;
    const drop = new Set();
    for (const rule of rules) {
        if (regexMatches(rule.pathnamePattern, pathname)) {
            for (const name of rule.dropQueryParameters) drop.add(name);
        }
    }
    if (drop.size && query) {
        query = query.split('&').filter(component => !drop.has(decodeQueryName(component))).join('&');
    }
    return pathname + (query ? `?${query}` : '');
}

export function sourceKey(url, rules = []) {
    const normalizedRules = normalizeRules(rules);
    const { pathname, search } = parseResourceUrl(url);
    return sourceKeyFromParts(pathname, search, normalizedRules);
}

function canonicalEntries(entries) {
    return [...entries].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(entry => ({
        key: entry.key,
        hash: entry.hash,
        bytes: entry.bytes,
        status: entry.status,
        contentType: entry.contentType,
    }));
}

function archiveHash(entries, rules, allowedResponses) {
    return sha256(Buffer.from(stableJson({
        entries: canonicalEntries(entries),
        rules,
        allowedResponses,
    })));
}

function validateEntryShape(entry, label = 'entry') {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.key !== 'string' || !entry.key.startsWith('/')
        || !HEX_SHA256.test(entry.hash)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || !Number.isInteger(entry.status) || entry.status < 100 || entry.status > 599
        || typeof entry.contentType !== 'string' || !entry.contentType) {
        throw new TypeError(`Invalid source archive ${label}`);
    }
}

function verifyBlob(directory, hash, expectedBytes, verified) {
    const previousSize = verified.get(hash);
    if (previousSize !== undefined) {
        if (previousSize !== expectedBytes) throw new Error(`Conflicting byte count for source blob ${hash}`);
        return;
    }
    const file = path.join(directory, hash);
    let stat;
    try { stat = fs.lstatSync(file); } catch { throw new Error(`Missing source blob ${hash}`); }
    if (!stat.isFile()) throw new Error(`Source blob is not a regular file: ${hash}`);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== expectedBytes || sha256(bytes) !== hash) throw new Error(`Corrupt source blob ${hash}`);
    verified.set(hash, expectedBytes);
}

function readManifest(directory) {
    const file = path.join(directory, MANIFEST);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { throw new Error(`Invalid source archive manifest: ${error.message}`); }
}

function writeManifestAtomic(directory, manifest) {
    const file = path.join(directory, MANIFEST);
    const temporary = path.join(directory, `${MANIFEST}.${process.pid}.${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
        fs.renameSync(temporary, file);
    } catch (error) {
        try { fs.unlinkSync(temporary); } catch { /* no temporary file */ }
        throw error;
    }
}

function readV1Archive(directory, manifest, requestedRules, requestedAllowed) {
    if (manifest.schema !== SCHEMA || typeof manifest.sealed !== 'boolean'
        || !Array.isArray(manifest.entries) || !Array.isArray(manifest.rules)
        || !Array.isArray(manifest.allowedResponses)) throw new Error('Invalid source archive manifest schema');
    const rules = normalizeRules(manifest.rules);
    const allowedResponses = normalizeAllowedResponses(manifest.allowedResponses);
    if (requestedRules && stableJson(requestedRules) !== stableJson(rules)) throw new Error('Source archive rules do not match requested rules');
    if (requestedAllowed && stableJson(requestedAllowed) !== stableJson(allowedResponses)) {
        throw new Error('Source archive response exceptions do not match requested exceptions');
    }
    if (manifest.sealed && manifest.entries.length === 0) throw new Error('Sealed source archive must not be empty');
    const entries = new Map(), verified = new Map();
    let previousKey = null;
    for (let index = 0; index < manifest.entries.length; index++) {
        const raw = manifest.entries[index];
        validateEntryShape(raw, `entry at index ${index}`);
        const entry = { key: raw.key, hash: raw.hash, bytes: raw.bytes, status: raw.status, contentType: raw.contentType };
        if (sourceKey(entry.key, rules) !== entry.key) throw new Error(`Non-canonical source key: ${entry.key}`);
        if (!responseAllowed(parseResourceUrl(entry.key).pathname, entry.status, allowedResponses)) {
            throw new Error(`Disallowed source response ${entry.status}: ${entry.key}`);
        }
        if (entries.has(entry.key)) throw new Error(`Duplicate source key: ${entry.key}`);
        if (previousKey !== null && previousKey >= entry.key) throw new Error('Source archive entries are not sorted by key');
        previousKey = entry.key;
        verifyBlob(directory, entry.hash, entry.bytes, verified);
        entries.set(entry.key, entry);
    }
    return { entries, rules, allowedResponses, sealed: manifest.sealed };
}

export function openPerfSourceArchive(directory, options = {}) {
    const mode = options.mode ?? 'replay';
    if (!['record', 'replay'].includes(mode)) throw new TypeError("mode must be 'record' or 'replay'");
    const target = path.resolve(directory);
    const existingManifest = readManifest(target);
    const suppliedRules = options.rules === undefined ? null : normalizeRules(options.rules);
    const suppliedAllowed = options.allowedResponses === undefined ? null : normalizeAllowedResponses(options.allowedResponses);
    let entries = new Map(), rules = suppliedRules || [], allowedResponses = suppliedAllowed || [], sealed = false;

    if (existingManifest) {
        const loaded = readV1Archive(target, existingManifest, suppliedRules, suppliedAllowed);
        entries = loaded.entries;
        rules = loaded.rules;
        allowedResponses = loaded.allowedResponses;
        sealed = loaded.sealed;
    } else {
        if (mode === 'replay') throw new Error(`Source archive manifest not found: ${path.join(target, MANIFEST)}`);
        fs.mkdirSync(target, { recursive: true });
        if (fs.readdirSync(target).length) throw new Error('Refusing to initialize a source archive in a non-empty directory');
        writeManifestAtomic(target, { schema: SCHEMA, sealed: false, rules, allowedResponses, entries: [] });
    }

    const manifest = () => ({ schema: SCHEMA, sealed, rules, allowedResponses, entries: canonicalEntries(entries.values()) });
    const archive = {
        get size() { return entries.size; },
        get sealed() { return sealed; },
        hash() { return archiveHash(entries.values(), rules, allowedResponses); },
        lookup(url) {
            const key = sourceKey(url, rules);
            const entry = entries.get(key);
            return entry ? { entry: { ...entry }, bodyPath: path.join(target, entry.hash) } : null;
        },
        record(url, body, contentType, status = 200) {
            if (mode !== 'record') throw new Error('Cannot record in replay mode');
            if (sealed) throw new Error('Cannot record into a sealed source archive');
            if (!Buffer.isBuffer(body)) throw new TypeError('Source body must be a Buffer');
            if (typeof contentType !== 'string' || !contentType) throw new TypeError('Source contentType must be a non-empty string');
            if (!Number.isInteger(status) || status < 100 || status > 599) throw new TypeError('Invalid source response status');
            const { pathname } = parseResourceUrl(url);
            if (!responseAllowed(pathname, status, allowedResponses)) throw new Error(`Disallowed source response ${status}: ${sourceKey(url, rules)}`);
            const key = sourceKey(url, rules), hash = sha256(body);
            const entry = { key, hash, bytes: body.length, status, contentType };
            const previous = entries.get(key);
            if (previous) {
                if (stableJson(previous) !== stableJson(entry)) throw new Error(`Source changed for immutable key: ${key}`);
                return { ...previous };
            }
            const blobPath = path.join(target, hash);
            try { fs.writeFileSync(blobPath, body, { flag: 'wx' }); }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
                const existing = fs.readFileSync(blobPath);
                if (existing.length !== body.length || sha256(existing) !== hash) throw new Error(`Corrupt existing source blob ${hash}`);
            }
            entries.set(key, entry);
            sealed = false;
            return { ...entry };
        },
        save() {
            if (mode !== 'record') throw new Error('Cannot save in replay mode');
            if (sealed) throw new Error('Cannot save a sealed source archive');
            writeManifestAtomic(target, manifest());
            return archive.hash();
        },
        seal() {
            if (mode !== 'record') {
                if (sealed) return archive.hash();
                throw new Error('Cannot seal in replay mode');
            }
            if (sealed) return archive.hash();
            if (!entries.size) throw new Error('Cannot seal an empty source archive');
            sealed = true;
            try { writeManifestAtomic(target, manifest()); }
            catch (error) { sealed = false; throw error; }
            return archive.hash();
        },
    };
    return archive;
}

function ensureEmptyTarget(target) {
    if (!fs.existsSync(target)) return;
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) throw new Error('Import target must be a directory');
    if (fs.readdirSync(target).length) throw new Error('Import target must be absent or empty');
}

function readLegacyArchive(directory, manifest) {
    if (manifest.schema !== LEGACY_SCHEMA || manifest.complete !== true || !Array.isArray(manifest.entries)) {
        throw new Error('Legacy source archive must use v2 and be complete');
    }
    const entries = [], seenUrls = new Set(), verified = new Map();
    for (let index = 0; index < manifest.entries.length; index++) {
        const row = manifest.entries[index];
        if (!row || typeof row !== 'object' || typeof row.url !== 'string'
            || !HEX_SHA256.test(row.hash) || !Number.isSafeInteger(row.bytes) || row.bytes < 0
            || typeof row.contentType !== 'string' || !row.contentType
            || !Number.isInteger(row.status) || row.status < 100 || row.status > 599) {
            throw new TypeError(`Invalid legacy source entry at index ${index}`);
        }
        if (seenUrls.has(row.url)) throw new Error(`Duplicate legacy source URL: ${row.url}`);
        seenUrls.add(row.url);
        const { pathname } = parseResourceUrl(row.url);
        verifyBlob(directory, row.hash, row.bytes, verified);
        entries.push({ url: row.url, pathname, hash: row.hash, bytes: row.bytes, status: row.status, contentType: row.contentType });
    }
    return entries;
}

export function importPerfSourceArchive(sourceDir, targetDir, options = {}) {
    const source = path.resolve(sourceDir), target = path.resolve(targetDir);
    ensureEmptyTarget(target);
    if (fs.existsSync(source) && fs.existsSync(target) && fs.realpathSync(source) === fs.realpathSync(target)) {
        throw new Error('Source and target archives must be different directories');
    }
    const raw = readManifest(source);
    if (!raw) throw new Error(`Source archive manifest not found: ${path.join(source, MANIFEST)}`);
    const rules = normalizeRules(options.rules ?? []);
    const allowedResponses = normalizeAllowedResponses(options.allowedResponses ?? []);
    let rows;
    if (raw.schema === SCHEMA) {
        const loaded = readV1Archive(source, raw, null, null);
        rows = [...loaded.entries.values()].map(entry => ({ ...entry, pathname: parseResourceUrl(entry.key).pathname }));
    } else if (raw.schema === LEGACY_SCHEMA) {
        rows = readLegacyArchive(source, raw);
    } else {
        throw new Error('Unsupported source archive schema');
    }

    const imported = new Map();
    for (const row of rows) {
        const originalKey = row.key ?? row.url;
        const key = sourceKey(originalKey, rules);
        if (!responseAllowed(parseResourceUrl(key).pathname, row.status, allowedResponses)) {
            throw new Error(`Disallowed imported source response ${row.status}: ${key}`);
        }
        const entry = { key, hash: row.hash, bytes: row.bytes, status: row.status, contentType: row.contentType };
        const previous = imported.get(key);
        if (previous && stableJson(previous) !== stableJson(entry)) throw new Error(`Conflicting origin-independent source key: ${key}`);
        imported.set(key, entry);
    }

    fs.mkdirSync(target, { recursive: true });
    for (const hash of new Set([...imported.values()].map(entry => entry.hash))) {
        fs.copyFileSync(path.join(source, hash), path.join(target, hash), fs.constants.COPYFILE_EXCL);
    }
    const manifest = { schema: SCHEMA, sealed: false, rules, allowedResponses, entries: canonicalEntries(imported.values()) };
    writeManifestAtomic(target, manifest);
    return archiveHash(imported.values(), rules, allowedResponses);
}
