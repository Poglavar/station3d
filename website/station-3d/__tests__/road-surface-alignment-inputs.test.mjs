// Checks cached road inputs without losing cross-tile duplicate precedence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createRoadSurfaceAlignmentInputs,
    roadSurfaceAlignmentFeatureKey,
} from '../core/road-surface-alignment-inputs.js';
import { createRoadTileRegistrationTask } from '../core/road-tile-registration.js';

const road = (id, extra = {}) => ({ properties: { osm_id: id, highway_type: 'primary', ...extra } });
const entries = features => features.map(feature => [roadSurfaceAlignmentFeatureKey(feature), feature]);

test('cached aggregation preserves tile and feature order through replacement and eviction', () => {
    const inputs = createRoadSurfaceAlignmentInputs();
    const a = road(1); const duplicate = road(1, { name: 'later' });
    const b = road(2); const c = road(3);
    inputs.setTileEntries('a', entries([a, b, a]));
    inputs.setTileEntries('b', entries([duplicate, c]));
    const first = inputs.getFeatures();
    assert.deepEqual(first, [a, b, c]);
    assert.equal(inputs.getFeatures(), first, 'terrain-only refresh reuses the committed input array');
    const replacement = road(1, { name: 'updated' });
    inputs.setTileEntries('a', entries([replacement, b]));
    assert.deepEqual(inputs.getFeatures(), [replacement, b, c], 'updating a tile must not reorder it');
    inputs.removeTile('a');
    assert.deepEqual(inputs.getFeatures(), [duplicate, c], 'eviction promotes the next source');
    inputs.clear();
    assert.deepEqual(inputs.getFeatures(), []);
    inputs.setTileEntries('a', entries([a]));
    assert.deepEqual(inputs.getFeatures(), [a], 'a new session must not inherit old members');
});

test('surface types and anonymous centerlines keep the original deduplication keys', () => {
    const inputs = createRoadSurfaceAlignmentInputs();
    const highway = road(1);
    const path = road(1, { highway_type: 'footway' });
    const railway = road(1, { highway_type: '', railway_type: 'tram' });
    const anonymous = road(null, { centerline_geometry: { type: 'LineString', coordinates: [[16, 45], [17, 45]] } });
    const duplicate = structuredClone(anonymous);
    inputs.setTileEntries('a', entries([highway, path, railway, anonymous, duplicate]));
    assert.deepEqual(inputs.getFeatures(), [highway, path, railway, anonymous]);
});

test('alignment keys are prepared before the tile publishes and are not recomputed on refresh', () => {
    let reads = 0;
    const feature = road(null);
    Object.defineProperty(feature.properties, 'centerline_geometry', {
        get() { reads += 1; return { type: 'LineString', coordinates: [[16, 45], [17, 45]] }; },
    });
    const task = createRoadTileRegistrationTask([feature], { workUnitsPerStep: 1 });
    assert.throws(() => task.result(), /not complete/);
    while (task.step() === 'more') { /* finish bounded registration */ }
    assert.ok(reads > 0);
    reads = 0;
    const inputs = createRoadSurfaceAlignmentInputs();
    inputs.setTileEntries('a', task.result().alignmentEntries);
    assert.deepEqual(inputs.getFeatures(), [feature]);
    inputs.getFeatures();
    inputs.setTileEntries('b', entries([road(2)]));
    inputs.getFeatures();
    assert.equal(reads, 0, 'neither a refresh nor another tile touches the old source geometry');
});
