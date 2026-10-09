// PURPOSE: Pin bounded local HTTP fixtures and prove owned provider paths fail closed during replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

import { openPerfSnapshotSources } from '../../../tools/lib/perf-source-snapshots.mjs';
import { perfReplaySourceHash } from '../../../tools/lib/perf-source-vectors.mjs';
import { openPerfSourceArchive } from '../../../tools/lib/perf-source-archive.mjs';
import { openPerfVectorSources } from '../../../tools/lib/perf-source-vectors.mjs';
import { startPerfReplayServer } from '../../../tools/lib/perf-replay-server.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const rootFor = () => fs.mkdtemp(path.join(os.tmpdir(), 'station3d-perf-snapshots-'));
const body = Buffer.from('{"type":"FeatureCollection","features":[]}');

function manifest(overrides = {}) {
    return {
        schema: 'station3d-perf-http-snapshot-v1',
        id: 'water-prod-snapshot',
        pathnames: ['/api/water'],
        coverage: { complete: true, scope: 'provider visible rows', bbox: [15, 45, 17, 46] },
        provenance: {
            capturedAt: '2026-10-08T00:00:00.000Z',
            sourceRevision: 'provider-r17',
            transactionSnapshot: 'snapshot-42',
        },
        files: [{ file: 'provider-code.mjs', sha256: 'a'.repeat(64), bytes: 100, role: 'code' }],
        ...overrides,
    };
}

async function writeManifest(root, value = manifest(), filename = 'snapshot.json') {
    const bytes = Buffer.from(JSON.stringify(value));
    await fs.writeFile(path.join(root, filename), bytes);
    return { file: filename, sha256: digest(bytes) };
}

async function serve(handler) {
    const server = createServer(handler);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
}

function goodHeaders(datasetHash, responseBody) {
    return {
        'content-type': 'application/geo+json; charset=utf-8',
        'x-source-dataset-sha256': datasetHash,
        'x-source-sha256': digest(responseBody),
    };
}

async function fixture(t, options = {}) {
    const root = await rootFor();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = await writeManifest(root, options.manifest || manifest());
    let manifestRequests = 0;
    const requests = [];
    const metadataBytes = Buffer.from(JSON.stringify(options.metadata || manifest(options.metadataOverrides)));
    const metadataHash = options.metadataHash || file.sha256;
    const server = await serve((req, res) => {
        requests.push({ url: req.url, expected: req.headers['x-expected-source-dataset-sha256'] });
        if (req.url === '/__station3d_snapshot') {
            manifestRequests++;
            const status = options.metadataStatus || 200;
            if (options.metadataRedirect) {
                res.writeHead(302, { location: '/elsewhere' });
                res.end();
                return;
            }
            res.writeHead(status, { 'content-type': 'application/json',
                'x-source-dataset-sha256': options.metadataHeader || metadataHash });
            res.end(options.metadataBytes || metadataBytes);
            return;
        }
        if (options.responseRedirect) {
            res.writeHead(302, { location: '/other' });
            res.end();
            return;
        }
        const responseBody = options.responseBody || body;
        res.writeHead(options.responseStatus || 200, {
            ...goodHeaders(options.responseDatasetHeader || file.sha256, responseBody),
            ...(options.responseHeaders || {}),
        });
        res.end(responseBody);
    });
    t.after(() => server.close());
    return { root, file, server, requests, get manifestRequests() { return manifestRequests; } };
}

test('snapshot HTTP sources pin metadata and forward exact owned path/query bytes', async t => {
    const f = await fixture(t);
    const snapshots = await openPerfSnapshotSources([{ ...f.file, origin: f.server.origin }], { root: f.root });

    assert.equal(snapshots.identities.length, 1);
    assert.equal(snapshots.identities[0].id, 'water-prod-snapshot');
    assert.equal(snapshots.identities[0].files[0].file, 'provider-code.mjs');
    assert.equal(f.manifestRequests, 1);
    assert.equal(await snapshots.resolve('http://replay.local/api/other?x=1'), null);

    const requestURL = 'http://replay.local/api/water?bbox=15.982437467636425%2C45.79849299304242%2C15.985015102902617%2C45.8002896153924&source=best-available';
    const result = await snapshots.resolve(requestURL);
    assert.equal(f.requests[1].url, requestURL.slice('http://replay.local'.length));
    assert.equal(f.requests[1].expected, f.file.sha256);
    assert.equal(result.entry.status, 200);
    assert.equal(result.entry.contentType, 'application/geo+json; charset=utf-8');
    assert.equal(result.entry.hash, digest(body));
    assert.equal(result.entry.bytes, body.length);
    assert.deepEqual(result.body, body);
    assert.equal(result.fixtureHash, f.file.sha256);
    assert.equal(result.fixtureId, 'water-prod-snapshot');
    assert.deepEqual(await snapshots.verify(), snapshots.identities);
});

test('snapshot endpoints own exact archive keys and never fall back after a source failure', async t => {
    const f = await fixture(t);
    const hostRoot = path.join(f.root, 'host'), engineDist = path.join(f.root, 'engine');
    const archiveDir = path.join(f.root, 'archive');
    await fs.mkdir(hostRoot); await fs.mkdir(engineDist);
    const key = '/api/water?bbox=15.9,45.7,16,45.8';
    const archive = openPerfSourceArchive(archiveDir, { mode: 'record' });
    archive.record(key, Buffer.from('{"oldArchive":true}'), 'application/json');
    const snapshots = await openPerfSnapshotSources([{ ...f.file, origin: f.server.origin }], { root: f.root });
    let providerHits = 0;
    const provider = await serve((_req, res) => { providerHits++; res.end('{"liveProvider":true}'); });
    t.after(() => provider.close());
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive,
        snapshotSources: snapshots, recording: true, providerBaseUrl: provider.origin });
    t.after(() => replay.close());

    const first = await fetch(`${replay.origin}${key}`);
    assert.equal(first.status, 200);
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), body);
    assert.equal(replay.requests[0].outcome, 'derived');
    assert.equal(replay.requests[0].fixtureId, 'water-prod-snapshot');

    await fs.writeFile(path.join(f.root, f.file.file), JSON.stringify(manifest({ id: 'tampered' })));
    const failed = await fetch(`${replay.origin}${key}`);
    assert.equal(failed.status, 502);
    assert.match(await failed.text(), /manifest changed/i);
    assert.equal(replay.requests[1].outcome, 'failed');
    assert.equal(replay.requests[1].hash, null);
    assert.equal(archive.size, 1);
    assert.equal(providerHits, 0);
});

test('snapshot and vector sources cannot claim the same replay endpoint', async t => {
    const f = await fixture(t);
    const vectorFile = await writeManifest(f.root, {
        schema: 'station3d-perf-vector-source-v1',
        id: 'vector-water', pathname: '/api/water', crs: 'EPSG:4326',
        query: { parameter: 'bbox', selection: 'postgis-box2df-overlap-v1', maxSpanDegrees: 0.12, maxFeatures: 20 },
        coverage: { bbox: [-1, -1, 1, 1], complete: true, rowCount: 0, scope: 'provider-visible-rows' },
        provenance: { capturedAt: '2026-10-08T00:00:00.000Z', sourceRevision: 'vector-r1',
            querySha256: 'c'.repeat(64), transactionSnapshot: 'snapshot-43' },
        features: [],
    }, 'vector.json');
    const vectorSources = await openPerfVectorSources([vectorFile], { root: f.root });
    const snapshotSources = await openPerfSnapshotSources([{ ...f.file, origin: f.server.origin }], { root: f.root });
    const hostRoot = path.join(f.root, 'host'), engineDist = path.join(f.root, 'engine');
    await fs.mkdir(hostRoot); await fs.mkdir(engineDist);
    const archive = openPerfSourceArchive(path.join(f.root, 'archive'), { mode: 'record' });
    archive.record('/api/ping', Buffer.from('pong'), 'text/plain');
    archive.seal();
    await assert.rejects(startPerfReplayServer({ hostRoot, engineDist, archive, vectorSources, snapshotSources }), /exactly one owner/i);
});

test('snapshot identities change source hash by manifest hash or owned pathname and empty sets retain v1', () => {
    const archiveHash = 'd'.repeat(64);
    const vectors = { identities: [{ pathname: '/api/vector', hash: 'e'.repeat(64) }] };
    const empty = { identities: [] };
    const v1 = digest(JSON.stringify({ schema: 'station3d-perf-source-set-v1', archiveHash,
        vectors: [{ pathname: '/api/vector', hash: 'e'.repeat(64) }] }));
    assert.equal(perfReplaySourceHash(archiveHash, vectors), v1);
    assert.equal(perfReplaySourceHash(archiveHash, vectors, empty), v1);
    assert.equal(perfReplaySourceHash(archiveHash, { identities: [] }, empty), archiveHash);

    const snapshot = { identities: [{ id: 'snapshot', pathnames: ['/api/water'], hash: 'f'.repeat(64) }] };
    const base = perfReplaySourceHash(archiveHash, vectors, snapshot);
    assert.notEqual(base, perfReplaySourceHash(archiveHash, vectors,
        { identities: [{ ...snapshot.identities[0], hash: '0'.repeat(64) }] }));
    assert.notEqual(base, perfReplaySourceHash(archiveHash, vectors,
        { identities: [{ ...snapshot.identities[0], pathnames: ['/api/water', '/api/curbs'] }] }));
});

test('an empty snapshot source set has stable identity without making requests', async () => {
    const snapshots = await openPerfSnapshotSources([]);
    assert.deepEqual(snapshots.identities, []);
    assert.deepEqual(await snapshots.verify(), []);
    assert.equal(await snapshots.resolve('http://replay.local/api/water?x=1'), null);
});

test('snapshot sources reject non-loopback origins, invalid coverage, unsafe paths, and duplicate owners', async t => {
    const f = await fixture(t);
    await assert.rejects(openPerfSnapshotSources([{ ...f.file, origin: 'http://localhost:1234' }], { root: f.root }), /127\.0\.0\.1/);
    await assert.rejects(openPerfSnapshotSources([{ ...f.file, origin: 'https://127.0.0.1:1234' }], { root: f.root }), /127\.0\.0\.1/);

    const invalidManifests = [
        manifest({ coverage: { complete: false, scope: 'partial', bbox: [15, 45, 17, 46] } }),
        manifest({ coverage: { complete: true, scope: 'bad', bbox: [15, 46, 17, 45] } }),
        manifest({ pathnames: ['/api/water', '/api/water'] }),
        manifest({ pathnames: ['/api/%2e%2e/private'] }),
        manifest({ files: [{ file: '../secret', sha256: 'b'.repeat(64), bytes: 1, role: 'data' }] }),
    ];
    for (let index = 0; index < invalidManifests.length; index++) {
        const bad = await writeManifest(f.root, invalidManifests[index], `bad-${index}.json`);
        await assert.rejects(openPerfSnapshotSources([{ ...bad, origin: f.server.origin }], { root: f.root }), /snapshot|coverage|path|file|duplicate/i);
    }

    const other = await writeManifest(f.root, manifest({ id: 'second', pathnames: ['/api/water'] }), 'second.json');
    await assert.rejects(openPerfSnapshotSources([
        { ...f.file, origin: f.server.origin }, { ...other, origin: f.server.origin },
    ], { root: f.root }), /duplicate owner/i);
});

test('snapshot metadata and local manifest tampering fail closed', async t => {
    const wrongMetadata = await fixture(t, { metadataHeader: '0'.repeat(64) });
    await assert.rejects(openPerfSnapshotSources([{ ...wrongMetadata.file, origin: wrongMetadata.server.origin }], { root: wrongMetadata.root }), /metadata.*hash header/i);

    const redirect = await fixture(t, { metadataRedirect: true });
    await assert.rejects(openPerfSnapshotSources([{ ...redirect.file, origin: redirect.server.origin }], { root: redirect.root }), /HTTP 302/i);

    const metadataBytesChanged = await fixture(t, { metadataBytes: Buffer.from('{"changed":true}') });
    await assert.rejects(openPerfSnapshotSources([{ ...metadataBytesChanged.file, origin: metadataBytesChanged.server.origin }], { root: metadataBytesChanged.root }), /metadata bytes/i);

    const f = await fixture(t);
    const snapshots = await openPerfSnapshotSources([{ ...f.file, origin: f.server.origin }], { root: f.root });
    await fs.writeFile(path.join(f.root, f.file.file), JSON.stringify(manifest({ id: 'replaced' })));
    await assert.rejects(snapshots.resolve('http://replay.local/api/water?bbox=1,2,3,4'), /manifest changed/i);
});

test('snapshot responses reject wrong status, dataset hash, body hash, and non-JSON content', async t => {
    for (const options of [
        { responseStatus: 404 },
        { responseRedirect: true },
        { responseDatasetHeader: '0'.repeat(64) },
        { responseHeaders: { 'x-source-sha256': '0'.repeat(64) } },
        { responseHeaders: { 'content-type': 'text/plain' } },
    ]) {
        const f = await fixture(t, options);
        const snapshots = await openPerfSnapshotSources([{ ...f.file, origin: f.server.origin }], { root: f.root });
        await assert.rejects(snapshots.resolve('http://replay.local/api/water?x=1'));
    }
});
