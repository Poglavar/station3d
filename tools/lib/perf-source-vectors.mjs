// Frozen provider-visible vector rows, queried without changing geometry or runtime requests.
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SCHEMA = 'station3d-perf-vector-source-v1';
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BYTES = 16 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bits = new DataView(new ArrayBuffer(4));

function bounds(value, label, positive = false) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)
        || value[0] < -180 || value[2] > 180 || value[1] < -90 || value[3] > 90
        || (positive ? value[0] >= value[2] || value[1] >= value[3]
            : value[0] > value[2] || value[1] > value[3])) {
        throw new Error(`Invalid ${label} bounds`);
    }
    return value;
}

function outwardFloat(value, lower) {
    const nearest = Math.fround(value);
    if (lower ? nearest <= value : nearest >= value) return nearest;
    if (nearest === 0) return lower ? -(2 ** -149) : 2 ** -149;
    bits.setFloat32(0, nearest);
    const towardPositive = !lower;
    bits.setUint32(0, bits.getUint32(0) + ((nearest > 0) === towardPositive ? 1 : -1));
    return bits.getFloat32(0);
}

// PostGIS geometry && compares outward-rounded BOX2DF envelopes. Keep this
// conversion separate from the exact requested bbox echoed in the response.
// https://postgis.net/docs/geometry_overlaps.html
export function float32Envelope(value) {
    bounds(value, 'envelope');
    return [outwardFloat(value[0], true), outwardFloat(value[1], true),
        outwardFloat(value[2], false), outwardFloat(value[3], false)];
}

const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const contains = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1]
    && outer[2] >= inner[2] && outer[3] >= inner[3];

function freezeTree(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) freezeTree(child);
    }
    return value;
}

export function createPerfVectorQuery(snapshot) {
    const data = structuredClone(snapshot);
    if (data?.schema !== SCHEMA || typeof data.id !== 'string' || !data.id
        || typeof data.pathname !== 'string' || !/^\/[A-Za-z0-9_/-]+$/.test(data.pathname)
        || data.crs !== 'EPSG:4326') throw new Error('Invalid vector source schema or endpoint');
    const query = data.query;
    if (query?.parameter !== 'bbox' || query.selection !== 'postgis-box2df-overlap-v1'
        || !Number.isFinite(query.maxSpanDegrees) || query.maxSpanDegrees <= 0 || query.maxSpanDegrees > 180
        || !Number.isSafeInteger(query.maxFeatures) || query.maxFeatures < 1) {
        throw new Error('Unsupported vector query semantics');
    }
    const coverage = data.coverage;
    bounds(coverage?.bbox, 'coverage', true);
    if (coverage.complete !== true || coverage.scope !== 'provider-visible-rows'
        || !Number.isSafeInteger(coverage.rowCount) || coverage.rowCount < 0
        || !Array.isArray(data.features) || data.features.length !== coverage.rowCount) {
        throw new Error('Vector coverage must be complete with a matching row count');
    }
    const provenance = data.provenance;
    if (!provenance || typeof provenance.capturedAt !== 'string' || !Number.isFinite(Date.parse(provenance.capturedAt))
        || typeof provenance.sourceRevision !== 'string' || !provenance.sourceRevision
        || !SHA256.test(provenance.querySha256)
        || typeof provenance.transactionSnapshot !== 'string' || !provenance.transactionSnapshot) {
        throw new Error('Vector source needs snapshot and query provenance');
    }
    const ids = new Set(), coveredEnvelope = float32Envelope(coverage.bbox);
    for (const row of data.features) {
        if (typeof row?.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('Duplicate or invalid vector feature id');
        ids.add(row.id);
        bounds(row.bounds, 'feature');
        if (row.bounds.some(value => Math.fround(value) !== value)) throw new Error('Feature bounds must be authoritative float32 envelopes');
        if (!overlaps(row.bounds, coveredEnvelope)) throw new Error('Feature lies outside the exported query coverage');
        if (row.feature?.type !== 'Feature' || !row.feature.geometry
            || !['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].includes(row.feature.geometry.type)) {
            throw new Error('Invalid vector GeoJSON feature');
        }
    }
    // The source query has no guaranteed SQL row ordering. A stable feature id
    // order gives both builds the same payload and leaves feature contents intact.
    data.features.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    freezeTree(data);
    return Object.freeze({ pathname: data.pathname, id: data.id,
        query(value) {
            const url = new URL(value, 'http://vector-source.local');
            if (url.pathname !== data.pathname) return null;
            if (url.hash || [...url.searchParams.keys()].some(key => key !== query.parameter)
                || url.searchParams.getAll(query.parameter).length !== 1) throw new Error('Expected exactly one bbox query parameter');
            const parts = url.searchParams.get(query.parameter).split(',');
            if (parts.some(part => !part.trim())) throw new Error('Invalid query bounds');
            const bbox = bounds(parts.map(Number), 'query', true);
            if (bbox[2] - bbox[0] > query.maxSpanDegrees || bbox[3] - bbox[1] > query.maxSpanDegrees) {
                throw new Error('Vector query exceeds the supported span');
            }
            if (!contains(coverage.bbox, bbox)) throw new Error('Vector query is outside complete source coverage');
            const envelope = float32Envelope(bbox);
            const features = data.features.filter(row => overlaps(row.bounds, envelope)).map(row => row.feature);
            if (features.length >= query.maxFeatures) throw new Error('Vector query reaches the provider truncation limit');
            return { type: 'FeatureCollection', metadata: { bbox, feature_count: features.length, truncated: false }, features };
        } });
}

async function verifiedBytes(file, expectedHash) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Vector source must be a bounded regular file');
    const bytes = await readFile(file);
    if (hash(bytes) !== expectedHash) throw new Error('Vector source hash mismatch');
    return bytes;
}

export async function openPerfVectorSources(specifications = [], { root = '.' } = {}) {
    if (!Array.isArray(specifications)) throw new Error('vectorSources must be an array');
    const sources = new Map(), identities = [];
    for (const specification of specifications) {
        if (typeof specification?.file !== 'string' || !specification.file || !SHA256.test(specification.sha256)) {
            throw new Error('Vector source needs a file and its SHA-256');
        }
        const file = resolve(root, specification.file), expectedHash = specification.sha256;
        const data = JSON.parse(await verifiedBytes(file, expectedHash));
        const source = createPerfVectorQuery(data);
        if (sources.has(source.pathname)) throw new Error('Duplicate vector source endpoint');
        sources.set(source.pathname, { file, expectedHash, source });
        identities.push({ id: source.id, pathname: source.pathname, hash: expectedHash,
            coverage: data.coverage, query: data.query, provenance: data.provenance });
    }
    identities.sort((a, b) => a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0);
    freezeTree(identities);
    return Object.freeze({ identities,
        async resolve(value) {
            const url = new URL(value, 'http://vector-source.local');
            const owner = sources.get(url.pathname);
            if (!owner) return null;
            // Verify the frozen input for every served query, just like an exact
            // response blob. A changed file must not hide behind a parsed cache.
            await verifiedBytes(owner.file, owner.expectedHash);
            const result = owner.source.query(url);
            const body = Buffer.from(JSON.stringify(result));
            return { entry: { hash: hash(body), bytes: body.length, status: 200, contentType: 'application/json' },
                body, fixtureHash: owner.expectedHash, fixtureId: owner.source.id, featureCount: result.features.length };
        } });
}

export function perfReplaySourceHash(archiveHash, vectorSources) {
    if (!SHA256.test(archiveHash)) throw new Error('Invalid archive hash');
    if (!vectorSources.identities.length) return archiveHash;
    return hash(JSON.stringify({ schema: 'station3d-perf-source-set-v1', archiveHash,
        vectors: vectorSources.identities.map(source => ({ pathname: source.pathname, hash: source.hash })) }));
}
