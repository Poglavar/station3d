// Verify free-roam options and bounded reference-rail preparation for every host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFreeRoamOptions } from '../core/free-roam-entry.js';

const api = () => ({ areaOfInterestBbox: () => [1, 2, 3, 4], bboxQueryValue: () => '1,2,3,4', referenceFeatures: () => ['track'] });
const okFetch = async () => ({ ok: true, json: async () => ({ features: [] }) });

test('an explicit OSM request fetches nothing and forwards view/proposal options', async () => {
    let calls = 0;
    const options = await prepareFreeRoamOptions({ lat: 1, lon: 2, headingDeg: 35, pitchDeg: -8, proposalIds: ['p1'], railProfileMode: 'osm' }, { apiBaseUrl: 'x', referenceRailApi: api(), fetchFn: async () => { calls++; } });
    assert.equal(calls, 0);
    assert.deepEqual(options, { initialHeadingDeg: 35, initialLookPitchDeg: -8, railProfileMode: 'osm', proposalIds: ['p1'], otherTracks: [] });
});

test('no named mode prefers the reconstructions: solved with the reference lines when the service answers', async () => {
    const warnings = [];
    const options = await prepareFreeRoamOptions({ lat: 45, lon: 16 }, { apiBaseUrl: 'https://api.test', referenceRailApi: api(), fetchFn: okFetch, warn: m => warnings.push(m) });
    assert.equal(options.railProfileMode, 'solved');
    assert.deepEqual(options.otherTracks, ['track']);
    assert.deepEqual(warnings, []);
});

test('no named mode falls back to OSM, with a timestamped warning, when the reference service cannot answer', async () => {
    const cases = [
        ['no API configured', {}],
        ['a failed response', { apiBaseUrl: 'x', referenceRailApi: api(), fetchFn: async () => ({ ok: false, status: 503 }) }],
        ['a network error', { apiBaseUrl: 'x', referenceRailApi: api(), fetchFn: async () => { throw new TypeError('Failed to fetch'); } }],
        ['a malformed body', { apiBaseUrl: 'x', referenceRailApi: api(), fetchFn: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }) }],
    ];
    for (const [label, host] of cases) {
        const warnings = [];
        const options = await prepareFreeRoamOptions({ lat: 45, lon: 16, headingDeg: 3 }, { ...host, warn: m => warnings.push(m) });
        assert.deepEqual(options, { initialHeadingDeg: 3, initialLookPitchDeg: 0, railProfileMode: 'osm', proposalIds: null, otherTracks: [] }, label);
        assert.equal(warnings.length, 1, label);
        assert.match(warnings[0], /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] .+ Drawing OSM rail instead\.$/, label);
    }
});

test('an abort is never turned into an OSM fallback', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    await assert.rejects(() => prepareFreeRoamOptions({ lat: 45, lon: 16 }, { apiBaseUrl: 'x', referenceRailApi: api(), fetchFn: async () => { throw abort; } }), { name: 'AbortError' });
});

test('solved mode bounds request and converts features with solvedOnly', async () => {
    const calls = [];
    const api = { areaOfInterestBbox: points => { calls.push(['bbox', points]); return [1, 2, 3, 4]; }, bboxQueryValue: bbox => { calls.push(['query', bbox]); return '1,2,3,4'; }, referenceFeatures: (data, opts) => { calls.push(['convert', data, opts]); return ['track']; } };
    const signal = new AbortController().signal;
    const options = await prepareFreeRoamOptions({ lat: 45, lon: 16, railProfileMode: 'solved' }, { apiBaseUrl: 'https://api.test', referenceRailApi: api, fetchFn: async (url, init) => { calls.push(['fetch', url, init]); return { ok: true, json: async () => ({ features: [] }) }; }, signal });
    assert.equal(calls[2][0], 'fetch');
    assert.match(calls[2][1], /reference-project-geometry\?bbox=1%2C2%2C3%2C4$/);
    assert.equal(calls[2][2].signal, signal);
    assert.deepEqual(calls.at(-1), ['convert', { features: [] }, { modelTerrainActive: true, solvedOnly: true }]);
    assert.deepEqual(options.otherTracks, ['track']);
});

test('an explicit solved request still rejects non-OK responses and a missing service', async () => {
    await assert.rejects(() => prepareFreeRoamOptions({ lat: 1, lon: 2, railProfileMode: 'solved' }, { apiBaseUrl: 'x', referenceRailApi: { areaOfInterestBbox: () => [], bboxQueryValue: () => '' }, fetchFn: async () => ({ ok: false, status: 503 }) }), /503/);
    await assert.rejects(() => prepareFreeRoamOptions({ lat: 1, lon: 2, railProfileMode: 'solved' }, {}), /unavailable/);
});
