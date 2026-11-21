// Reproduces scenario startup at the browser boundary and verifies world URL
// normalization happens before the heavy-rail model-terrain guard.

import assert from 'node:assert/strict';
import test from 'node:test';

import { openScenario } from '../debug/scenario-runner.js';

test('bare heavy-rail deep link activates model terrain before opening the cab', async () => {
    const previousWindow = globalThis.window;
    let currentSearch = '?st3d=scenario&id=heavy-rail&checkpoint=split-departure';
    let cabOptions = null;
    const feature = {
        type: 'Feature',
        properties: {
            referenceProjectId: 152,
            sourceId: 'legacy-rail-perkovic-split-v1',
        },
        geometry: {
            type: 'LineString',
            coordinates: [
                [16.440, 43.500, 2],
                [16.450, 43.510, 3],
            ],
        },
    };
    globalThis.window = {
        __railReferenceProjects: {
            referenceFeatures(collection, options) {
                assert.equal(new URLSearchParams(currentSearch).get('elevation'), '1');
                assert.deepEqual(options, { modelTerrainActive: true, solvedOnly: true });
                return collection.features;
            },
        },
    };
    try {
        const result = await openScenario({
            station3D: {
                isModelTerrainActive() {
                    return new URLSearchParams(currentSearch).get('elevation') === '1';
                },
                openCab(_train, _line, _poseFn, options) {
                    cabOptions = options;
                    return true;
                },
            },
            apiBase: 'http://localhost:3000',
            search: currentSearch,
            hostname: 'localhost',
            replaceSearch(nextSearch) {
                currentSearch = nextSearch;
            },
            async fetchImpl(_url, options) {
                assert.equal(options.cache, 'no-store');
                assert.equal(new URLSearchParams(currentSearch).get('elevation'), '1');
                return {
                    ok: true,
                    async json() {
                        return { type: 'FeatureCollection', features: [feature] };
                    },
                };
            },
        });
        assert.equal(result.status, 'ready');
        assert.equal(result.scenarioId, 'heavy-rail');
        assert.equal(cabOptions.railProfileMode, 'solved');
        assert.equal(cabOptions.tracksAlreadySmoothed, true);
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});
