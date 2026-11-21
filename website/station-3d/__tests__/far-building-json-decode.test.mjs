// Execute the real far source registration, then its configured parser. Near
// source options must not be mistaken for coverage of this separate consumer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFeatureCollectionJsonParseTask } from '../core/cooperative-feature-collection-json.js';

const source = readFileSync(new URL('../world/buildings-far.js', import.meta.url), 'utf8');
const start = source.indexOf('source = sharedTileSession.getSource({');
const end = source.indexOf('subscription = source.subscribe({', start);
assert.ok(start >= 0 && end > start, 'locate the real far-source registration');

for (const endpoint of ['buildings-render', 'buildings-lod1']) {
    test(`${endpoint} far source decodes across turns with byte-equivalent JSON values`, () => {
        let options;
        const context = vm.createContext({
            source: null,
            sharedTileSession: { getSource(value) { options = value; return {}; } },
            bakeShadow: null,
            farSource: { key: endpoint, endpoint, querySuffix: '&fill=overture' },
            sourceBase: 'https://example.invalid/api',
            FAR_TILE_M: 800, FAR_RING: 1, FAR_KEEP_RING: 2,
            createFeatureCollectionJsonParseTask,
        });
        vm.runInContext(source.slice(start, end), context);
        assert.equal(options.createTextDecodeTask, createFeatureCollectionJsonParseTask,
            'far sources must opt into the existing cooperative parser before delivery');
        assert.equal(options.url({ west: 1, south: 2, east: 3, north: 4 }),
            `https://example.invalid/api/${endpoint}?bbox=1,2,3,4&fill=overture`);
        const payload = JSON.stringify({
            type: 'FeatureCollection', bbox: [1, 2, 3, 4],
            features: Array.from({ length: 65 }, (_, id) => ({
                type: 'Feature', id,
                geometry: { type: 'Polygon', coordinates: [[[1, 2], [3, 2], [1, 4], [1, 2]]] },
                properties: { height: 14.25, label: 'Ulica čipke "features"', parts: [{ id }] },
            })),
            metadata: { source: endpoint, nested: { features: [] } },
        });
        const task = options.createTextDecodeTask(payload);
        let steps = 0, outcome;
        do {
            outcome = task.step();
            assert.ok(++steps < 100, 'bounded fixture must finish');
        } while (!outcome.done);
        assert.ok(steps > 1, 'a complete far response must not parse in one delivery turn');
        assert.deepEqual(outcome.result, JSON.parse(payload),
            'all entity geometry, properties and envelope metadata are preserved');
    });
}
