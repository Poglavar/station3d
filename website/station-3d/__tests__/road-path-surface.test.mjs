import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    createRoadPathTangentSampler,
    roadPathUsesNearbyCarriagewayProfile,
} from '../core/road-path-surface.js';

test('ordinary mapped pedestrian paths do not inherit an arbitrary carriageway profile', () => {
    for (const highway_type of ['footway', 'path', 'cycleway', 'steps', 'pedestrian']) {
        assert.equal(roadPathUsesNearbyCarriagewayProfile({
            highway_type,
            tags: { highway: highway_type, surface: 'concrete' },
        }), false, highway_type);
    }
});

test('only explicitly mapped roadside companions inherit carriageway grade', () => {
    assert.equal(roadPathUsesNearbyCarriagewayProfile({
        highway_type: 'footway',
        tags: { highway: 'footway', footway: 'sidewalk' },
    }), true);
    assert.equal(roadPathUsesNearbyCarriagewayProfile({
        highway_type: 'cycleway',
        tags: { highway: 'cycleway', cycleway: 'sidewalk' },
    }), true);
    assert.equal(roadPathUsesNearbyCarriagewayProfile({
        highway_type: 'secondary',
        tags: { sidewalk: 'separate' },
    }), false);
});

test('roadside path tangent sampling follows the nearest local centerline segment', () => {
    const tangentAt = createRoadPathTangentSampler([[
        { x: -20, z: 0 },
        { x: 0, z: 0 },
        { x: 0, z: 20 },
    ]]);
    assert.deepEqual(tangentAt(-10, 2), { tangentX: 1, tangentZ: 0 });
    assert.deepEqual(tangentAt(2, 10), { tangentX: 0, tangentZ: 1 });
    assert.equal(createRoadPathTangentSampler([]), null);
});

test('Station3D does not load a second legacy footpath render feed', async () => {
    const source = await readFile(new URL('../world/decor.js', import.meta.url), 'utf8');
    const start = source.indexOf('function refresh(centerLat, centerLon)');
    const end = source.indexOf('\nexport function rebuildDecorForProposalMask', start);
    const refresh = source.slice(start, end);
    assert.doesNotMatch(refresh, /fetchDecorAsset\(['"]footpaths['"]/);
});
