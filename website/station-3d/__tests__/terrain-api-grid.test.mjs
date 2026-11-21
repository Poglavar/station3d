// Verifies the shared DGU terrain-grid API request and decoding contract used
// by both the browser terrain layer and the GDI experiment asset builder.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    decodeTerrainGridApiPayload,
    decodeTerrainGridApiPayloadSteps,
    fetchTerrainGridApi,
    terrainGridApiUrl,
} from '../core/terrain-api-grid.js';

test('builds a bounded terrain-grid URL against a normalized API base', () => {
    assert.equal(
        terrainGridApiUrl('https://example.test/api/', {
            bbox: [15.9, 45.7, 16.1, 45.9],
            resolutionDeg: 0.00018,
        }),
        'https://example.test/api/terrain/grid?bbox=15.900000,45.700000,16.100000,45.900000&res=0.00018',
    );
    assert.equal(
        terrainGridApiUrl('https://example.test/api/', {
            bbox: [15.9, 45.7, 16.1, 45.9],
            resolutionDeg: 0.00001,
            source: 'best-available',
        }),
        'https://example.test/api/terrain/grid?bbox=15.900000,45.700000,16.100000,45.900000&res=0.00001&source=best-available',
    );
    assert.equal(
        terrainGridApiUrl('https://example.test/api/', {
            bbox: [15.96, 45.8, 15.98, 45.82],
            resolutionDeg: 0.0002,
            source: 'dgu-dtm-20m',
            cacheTile: true,
        }),
        'https://example.test/api/terrain/grid?bbox=15.960000,45.800000,15.980000,45.820000&res=0.0002&source=dgu-dtm-20m&tile=1',
    );
    assert.throws(
        () => terrainGridApiUrl('/api', {
            bbox: [15.9, 45.7, 16.1, 45.9],
            resolutionDeg: 0.00001,
            source: '../invalid',
        }),
        /valid source key/,
    );
});

test('fetches and decodes the API base64 grid without changing metadata', async () => {
    const values = Uint16Array.from([100, 120, 140, 160]);
    const payload = {
        grid: { width: 2, height: 2 },
        dataBase64: Buffer.from(values.buffer).toString('base64'),
        sourceDataBase64: Buffer.from(Uint8Array.from([0, 1, 1, 0])).toString('base64'),
    };
    let receivedUrl = null;
    const result = await fetchTerrainGridApi('/api', {
        bbox: [15, 45, 16, 46],
        resolutionDeg: 0.001,
    }, {
        cache: 'no-store',
        fetchImpl: async (url, options) => {
            receivedUrl = url;
            assert.equal(options.cache, 'no-store');
            return { ok: true, json: async () => payload };
        },
    });
    assert.equal(receivedUrl, '/api/terrain/grid?bbox=15.000000,45.000000,16.000000,46.000000&res=0.001');
    assert.equal(result.metadata, payload);
    assert.deepEqual([...new Uint16Array(result.arrayBuffer)], [...values]);
    assert.deepEqual([...new Uint8Array(result.sourceArrayBuffer)], [0, 1, 1, 0]);
});

test('cooperative payload decoding is byte-identical and yields bounded chunks', () => {
    const data = Uint8Array.from({ length: 420_000 }, (_, index) => index % 251);
    const sources = Uint8Array.from({ length: 310_000 }, (_, index) => index % 3);
    const payload = {
        dataBase64: Buffer.from(data).toString('base64'),
        sourceDataBase64: Buffer.from(sources).toString('base64'),
    };
    const iterator = decodeTerrainGridApiPayloadSteps(payload, { chunkChars: 64 * 1024 });
    const phases = [];
    let step = iterator.next();
    while (!step.done) {
        phases.push(step.value.phase);
        step = iterator.next();
    }
    const cooperative = step.value;
    const synchronous = decodeTerrainGridApiPayload(payload);

    assert.ok(phases.filter(phase => phase === 'decode-data').length > 1);
    assert.ok(phases.filter(phase => phase === 'decode-source data').length > 1);
    assert.deepEqual(
        new Uint8Array(cooperative.arrayBuffer),
        new Uint8Array(synchronous.arrayBuffer),
    );
    assert.deepEqual(
        new Uint8Array(cooperative.sourceArrayBuffer),
        new Uint8Array(synchronous.sourceArrayBuffer),
    );
});

test('streams the body and reports real byte progress when the length is known', async () => {
    const values = Uint16Array.from([100, 120]);
    const payload = {
        grid: { width: 2, height: 1 },
        dataBase64: Buffer.from(values.buffer).toString('base64'),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const half = Math.ceil(bytes.length / 2);
    const chunks = [bytes.slice(0, half), bytes.slice(half)];
    const progress = [];
    const result = await fetchTerrainGridApi('/api', {
        bbox: [15, 45, 16, 46],
        resolutionDeg: 0.001,
    }, {
        onProgress: (report) => progress.push(report),
        fetchImpl: async () => ({
            ok: true,
            headers: { get: (name) => (name === 'content-length' ? String(bytes.length) : null) },
            body: {
                getReader() {
                    let index = 0;
                    return {
                        read: async () => (index < chunks.length
                            ? { done: false, value: chunks[index++] }
                            : { done: true, value: undefined }),
                    };
                },
            },
            json: async () => { throw new Error('json() must not be used when streaming'); },
        }),
    });
    assert.deepEqual([...new Uint16Array(result.arrayBuffer)], [...values]);
    assert.equal(progress.length, 2);
    assert.equal(progress[0].totalBytes, bytes.length);
    assert.equal(progress[0].receivedBytes, half);
    assert.ok(progress[0].fraction > 0 && progress[0].fraction < 1);
    assert.equal(progress[1].fraction, 1);
});

test('falls back to plain json() with no progress reports when the length is unknown', async () => {
    const payload = {
        grid: { width: 1, height: 1 },
        dataBase64: Buffer.from(Uint16Array.from([7]).buffer).toString('base64'),
    };
    const progress = [];
    const result = await fetchTerrainGridApi('/api', {
        bbox: [15, 45, 16, 46],
        resolutionDeg: 0.001,
    }, {
        onProgress: (report) => progress.push(report),
        fetchImpl: async () => ({
            ok: true,
            headers: { get: () => null },
            body: null,
            json: async () => payload,
        }),
    });
    assert.equal(result.metadata, payload);
    assert.equal(progress.length, 0);
});

test('rejects malformed or failed terrain-grid responses', async () => {
    assert.throws(
        () => decodeTerrainGridApiPayload({}),
        /missing data/,
    );
    const failure = fetchTerrainGridApi('/api', {
        bbox: [15, 45, 16, 46],
        resolutionDeg: 0.001,
    }, {
        fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    await assert.rejects(failure, (error) => {
        assert.match(error.message, /HTTP 503/);
        assert.equal(error.status, 503);
        return true;
    });
    await assert.rejects(
        fetchTerrainGridApi('/api', {
            bbox: [15, 45, 16, 46],
            resolutionDeg: 0.001,
        }, {
            fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
        }),
        /missing data/,
    );
});
