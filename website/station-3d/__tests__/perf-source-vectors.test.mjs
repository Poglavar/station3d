import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
    float32Envelope,
    createPerfVectorQuery,
    openPerfVectorSources,
    perfReplaySourceHash,
} from '../../../tools/lib/perf-source-vectors.mjs';
import { openPerfSourceArchive } from '../../../tools/lib/perf-source-archive.mjs';
import { startPerfReplayServer } from '../../../tools/lib/perf-replay-server.mjs';
import { createServer } from 'node:http';

const digest = value => createHash('sha256').update(value).digest('hex');
const rootFor = () => fs.mkdtemp(path.join(os.tmpdir(), 'station3d-perf-vectors-'));

function feature(id, bounds, coordinates = [
    [bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]],
    [bounds[0], bounds[3]], [bounds[0], bounds[1]],
]) {
    return {
        id,
        bounds,
        feature: {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [coordinates] },
            properties: { sourceId: id },
        },
    };
}

function snapshot(features, overrides = {}) {
    return {
        schema: 'station3d-perf-vector-source-v1',
        id: 'test-water',
        pathname: '/api/water',
        crs: 'EPSG:4326',
        query: {
            parameter: 'bbox',
            selection: 'postgis-box2df-overlap-v1',
            maxSpanDegrees: 0.12,
            maxFeatures: 2000,
        },
        coverage: {
            bbox: [-1, -1, 1, 1],
            complete: true,
            rowCount: features.length,
            scope: 'provider-visible-rows',
        },
        provenance: {
            capturedAt: '2026-10-08T00:00:00.000Z',
            sourceRevision: 'water-fixture-r1',
            querySha256: 'a'.repeat(64),
            transactionSnapshot: 'snapshot-001',
        },
        features,
        ...overrides,
    };
}

async function writeSnapshot(root, value, file = 'water.json') {
    const bytes = Buffer.from(JSON.stringify(value));
    await fs.writeFile(path.join(root, file), bytes);
    return { file, sha256: digest(bytes) };
}

async function replayRoots(root) {
    const hostRoot = path.join(root, 'host');
    const engineDist = path.join(root, 'engine');
    await fs.mkdir(hostRoot);
    await fs.mkdir(engineDist);
    return { hostRoot, engineDist };
}

async function startCountingProvider() {
    let hits = 0;
    const server = createServer((_req, res) => { hits++; res.end('upstream'); });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        origin: `http://127.0.0.1:${server.address().port}`,
        get hits() { return hits; },
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
}

test('float32 envelopes round outward, including tiny values around zero', () => {
    const envelope = float32Envelope([0.1, -0.1, 0.2, 0.3]);
    assert.ok(envelope[0] <= 0.1);
    assert.ok(envelope[1] <= -0.1);
    assert.ok(envelope[2] >= 0.2);
    assert.ok(envelope[3] >= 0.3);

    const tiny = float32Envelope([1e-50, -1e-50, 1e-49, 1e-49]);
    assert.ok(tiny[0] <= 1e-50);
    assert.ok(tiny[1] <= -1e-50);
    assert.ok(tiny[2] >= 1e-49);
    assert.ok(tiny[3] >= 1e-49);
    assert.ok(Object.is(tiny[0], -0) || tiny[0] <= 0);
    assert.ok(tiny[1] < 0);
    assert.throws(() => float32Envelope([0, 0, 181, 1]), /bbox|bounds/i);
});

test('vector query preserves exact bbox metadata and inclusively selects authoritative stored bounds', () => {
    const touching = feature('touching', [-1, -1, 0, 0]);
    const interior = feature('inside', [0, 0, 1, 1]);
    // Geometry extends beyond the recorded PostGIS box2df bounds. Selection
    // must use the captured authoritative bounds, not bounds recomputed from
    // rounded GeoJSON coordinates.
    const broadGeometry = feature('stored-bounds-win', [0.25, 0.25, 0.5, 0.5], [
        [0, 0], [0.8, 0], [0.8, 0.8], [0, 0.8], [0, 0],
    ]);
    const query = createPerfVectorQuery(snapshot([interior, touching, broadGeometry]));
    assert.equal(query.pathname, '/api/water');
    const request = 'http://replay.local/api/water?bbox=0%2C0%2C0.1%2C0.1';
    const body = query.query(request);
    assert.equal(body.type, 'FeatureCollection');
    assert.deepEqual(body.features.map(row => row.properties.sourceId), ['inside', 'touching']);
    assert.deepEqual(body.metadata, {
        bbox: [0, 0, 0.1, 0.1],
        feature_count: 2,
        truncated: false,
    });
    assert.deepEqual(query.query('http://replay.local/api/water?bbox=0.6,0.6,0.7,0.7')
        .features.map(row => row.properties.sourceId), ['inside']);
    assert.equal(query.query('http://replay.local/api/other?bbox=0,0,0.1,0.1'), null);
});

test('vector query rejects malformed, ambiguous, oversized, and uncovered requests', () => {
    const query = createPerfVectorQuery(snapshot([feature('one', [-0.5, -0.5, 0.5, 0.5])]));
    for (const url of [
        'http://replay.local/api/water',
        'http://replay.local/api/water?bbox=0,0,0.1,0.1&bbox=0,0,0.1,0.1',
        'http://replay.local/api/water?bbox=0,0,0.1,0.1&limit=10',
        'http://replay.local/api/water?bbox=bad,0,0.1,0.1',
        'http://replay.local/api/water?bbox=0,0,0,0.1',
        'http://replay.local/api/water?bbox=0,0,0.121,0.1',
        'http://replay.local/api/water?bbox=0.95,0,1.05,0.1',
    ]) assert.throws(() => query.query(url));

    const tooMany = Array.from({ length: 2000 }, (_, index) =>
        feature(`row-${String(index).padStart(4, '0')}`, [-0.5, -0.5, 0.5, 0.5]));
    const bounded = createPerfVectorQuery(snapshot(tooMany));
    assert.throws(() => bounded.query('http://replay.local/api/water?bbox=0,0,0.1,0.1'), /limit|truncat|feature/i);
});

test('vector snapshots fail closed on invalid schema, incomplete or inconsistent source data', () => {
    const valid = snapshot([feature('one', [-0.5, -0.5, 0.5, 0.5])]);
    const invalid = [
        { ...valid, schema: 'other' },
        { ...valid, coverage: { ...valid.coverage, complete: false } },
        { ...valid, coverage: { ...valid.coverage, rowCount: 2 } },
        { ...valid, features: [valid.features[0], valid.features[0]], coverage: { ...valid.coverage, rowCount: 2 } },
        { ...valid, features: [feature('one', [0.1, 0, 1.1, 1])] },
        { ...valid, features: [{ ...valid.features[0], feature: { type: 'Feature', geometry: null, properties: {} } }] },
        { ...valid, provenance: { ...valid.provenance, querySha256: 'bad' } },
        { ...valid, query: { ...valid.query, selection: 'approximate-overlap' } },
    ];
    for (const value of invalid) assert.throws(() => createPerfVectorQuery(value));
});

test('opened vector sources verify file identity and resolve only their owned exact endpoint', async t => {
    const root = await rootFor(); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const value = snapshot([feature('one', [-0.5, -0.5, 0.5, 0.5])]);
    const sourceFile = await writeSnapshot(root, value);
    const sources = await openPerfVectorSources([sourceFile], { root });
    assert.equal(sources.identities.length, 1);
    assert.equal(await sources.resolve('http://replay.local/api/not-water?bbox=0,0,0.1,0.1'), null);

    const resolved = await sources.resolve('http://replay.local/api/water?bbox=0%2C0%2C0.1%2C0.1');
    assert.equal(resolved.entry.status, 200);
    assert.equal(resolved.entry.contentType, 'application/json');
    assert.equal(resolved.entry.bytes, resolved.body.length);
    assert.equal(resolved.entry.hash, digest(resolved.body));
    assert.equal(resolved.fixtureId, 'test-water');
    assert.equal(resolved.featureCount, 1);
    assert.equal(JSON.parse(resolved.body.toString()).features[0].properties.sourceId, 'one');

    await fs.writeFile(path.join(root, sourceFile.file), JSON.stringify({ ...value, provenance: { ...value.provenance, sourceRevision: 'mutated' } }));
    await assert.rejects(sources.resolve('http://replay.local/api/water?bbox=0,0,0.1,0.1'), /changed|hash|identity|fixture/i);
});

test('source archives reject file mismatches, duplicate endpoint owners, and duplicate feature IDs', async t => {
    const root = await rootFor(); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const one = snapshot([feature('one', [-0.5, -0.5, 0.5, 0.5])]);
    const source = await writeSnapshot(root, one);
    await assert.rejects(openPerfVectorSources([{ ...source, sha256: '0'.repeat(64) }], { root }), /hash|digest|integrity/i);
    await assert.rejects(openPerfVectorSources([source, source], { root }), /duplicate|endpoint|source/i);

    const duplicateIds = snapshot([feature('same', [-0.5, -0.5, 0, 0]), feature('same', [0, 0, 0.5, 0.5])]);
    const duplicateSource = await writeSnapshot(root, duplicateIds, 'duplicate.json');
    await assert.rejects(openPerfVectorSources([duplicateSource], { root }), /duplicate|id/i);
});

test('combined replay identity changes with vector content, coverage, and query semantics', async t => {
    const root = await rootFor(); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const base = snapshot([feature('one', [-0.5, -0.5, 0.5, 0.5])]);
    const changedGeometry = snapshot([feature('one', [-0.5, -0.5, 0.5, 0.5], [
        [-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4], [-0.4, -0.4],
    ])]);
    const changedCoverage = snapshot(base.features, { coverage: { ...base.coverage, bbox: [-0.9, -1, 1, 1] } });
    const changedSemantics = snapshot(base.features, { query: { ...base.query, maxSpanDegrees: 0.1 } });
    const inputs = [base, changedGeometry, changedCoverage, changedSemantics];
    const hashes = [];
    for (let index = 0; index < inputs.length; index++) {
        const file = await writeSnapshot(root, inputs[index], `source-${index}.json`);
        const sources = await openPerfVectorSources([file], { root });
        hashes.push(perfReplaySourceHash('a'.repeat(64), sources));
    }
    assert.equal(perfReplaySourceHash('a'.repeat(64), { identities: [] }), 'a'.repeat(64));
    assert.ok(hashes.every(hash => /^[a-f0-9]{64}$/.test(hash)));
    assert.equal(new Set(hashes).size, hashes.length);
});

test('HTTP replay gives a registered vector endpoint precedence over old exact bytes', async t => {
    const root = await rootFor(); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { hostRoot, engineDist } = await replayRoots(root);
    const archive = openPerfSourceArchive(path.join(root, 'archive'), { mode: 'record' });
    archive.record('/api/water?bbox=0,0,0.1,0.1', Buffer.from('{"old":true}'), 'application/json');
    archive.record('/api/ping?x=1', Buffer.from('pong'), 'text/plain');
    archive.seal();
    const sourceFile = await writeSnapshot(root, snapshot([feature('one', [-0.5, -0.5, 0.5, 0.5])]));
    const vectorSources = await openPerfVectorSources([sourceFile], { root });
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive, vectorSources });
    t.after(() => replay.close());

    const vectorResponse = await fetch(`${replay.origin}/api/water?bbox=0,0,0.1,0.1`);
    assert.equal(vectorResponse.status, 200);
    const vectorBytes = Buffer.from(await vectorResponse.arrayBuffer());
    assert.equal(vectorResponse.headers.get('x-source-sha256'), digest(vectorBytes));
    assert.equal(vectorResponse.headers.get('x-source-dataset-sha256'), sourceFile.sha256);
    assert.deepEqual(JSON.parse(vectorBytes.toString()).features.map(row => row.properties.sourceId), ['one']);
    assert.equal(replay.requests[0].outcome, 'derived');
    assert.equal(replay.requests[0].fixtureHash, sourceFile.sha256);
    assert.equal(replay.requests[0].hash, digest(vectorBytes));

    const exactResponse = await fetch(`${replay.origin}/api/ping?x=1`);
    assert.equal(await exactResponse.text(), 'pong');
    assert.equal(replay.requests[1].outcome, 'replayed');
    assert.equal(replay.requests[1].hash, digest(Buffer.from('pong')));
});

test('HTTP replay rejects vector query failures without archive or live-provider fallback', async t => {
    const root = await rootFor(); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { hostRoot, engineDist } = await replayRoots(root);
    const archive = openPerfSourceArchive(path.join(root, 'archive'), { mode: 'record' });
    const value = snapshot([feature('one', [-0.5, -0.5, 0.5, 0.5])], {
        query: { parameter: 'bbox', selection: 'postgis-box2df-overlap-v1', maxSpanDegrees: 0.12, maxFeatures: 1 },
    });
    const sourceFile = await writeSnapshot(root, value);
    const vectorSources = await openPerfVectorSources([sourceFile], { root });
    const provider = await startCountingProvider(); t.after(() => provider.close());
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive, vectorSources,
        recording: true, providerBaseUrl: provider.origin });
    t.after(() => replay.close());

    const queries = [
        'bbox=bad,0,0.1,0.1',
        'bbox=2,2,2.1,2.1',
        'bbox=0,0,0.1,0.1',
    ];
    for (const query of queries) {
        const response = await fetch(`${replay.origin}/api/water?${query}`);
        assert.equal(response.status, 502);
        await response.arrayBuffer();
    }
    assert.equal(provider.hits, 0);
    assert.equal(archive.size, 0);
    assert.equal(replay.requests.length, 3);
    assert.ok(replay.requests.every(row => row.outcome === 'failed' && row.hash === null));
});

test('HTTP replay reports a vector file changed after open as failed with no response hash', async t => {
    const root = await rootFor(); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { hostRoot, engineDist } = await replayRoots(root);
    const archive = openPerfSourceArchive(path.join(root, 'archive'), { mode: 'record' });
    archive.record('/api/ping', Buffer.from('pong'), 'text/plain');
    archive.seal();
    const sourceFile = await writeSnapshot(root, snapshot([feature('one', [-0.5, -0.5, 0.5, 0.5])]));
    const vectorSources = await openPerfVectorSources([sourceFile], { root });
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive, vectorSources });
    t.after(() => replay.close());
    await fs.writeFile(path.join(root, sourceFile.file), JSON.stringify({ ...snapshot([]), id: 'mutated' }));

    const response = await fetch(`${replay.origin}/api/water?bbox=0,0,0.1,0.1`);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /hash|changed|identity/i);
    assert.equal(response.headers.get('x-source-sha256'), null);
    assert.equal(replay.requests[0].outcome, 'failed');
    assert.equal(replay.requests[0].hash, null);
    assert.equal(replay.requests[0].fixtureHash, undefined);
});
