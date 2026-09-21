import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadFormationModel } from '../core/road-formation.js';
import { advanceRoadFormationDependency, foundationFormationWaitAllowanceMs, pendingRoadFormationChangeTouches, roadFormationWaitExpired } from '../core/road-formation-dependency.js';

const road = latitude => ({ type: 'Feature', properties: { osm_id: 1, highway: 'residential' },
    geometry: { type: 'LineString', coordinates: [[15.9, latitude], [15.901, latitude]] } });

test('a consumer advances unmanaged formation but defers its coordinator-owned successor', () => {
    const model = new RoadFormationModel({ anchorLat: 45.8, anchorLon: 15.9, baseSceneYAtLocal: () => 0 });
    try {
        model.setCenterlineTile('0_0', [road(45.8)]);
        model.setSurfaceTile('0_0', [{ type: 'Feature', properties: { osm_id: 1, highway_type: 'residential' },
            geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79997], [15.901, 45.79997],
                [15.901, 45.80003], [15.9, 45.80003], [15.9, 45.79997]]] } }]);
        let visits = 0;
        while (advanceRoadFormationDependency(model) !== 'ready') assert.ok(++visits < 10000);
        assert.ok(visits > 1);
        const published = model.getSurfaceProfiles();
        assert.ok(published.length > 0);
        const revision = model.surfaceGeometryRevision;
        model.managePublications();
        model.setCenterlineTile('0_0', [road(45.8001)]);
        assert.equal(model.hasPendingBuild(), true);
        assert.equal(advanceRoadFormationDependency(model), 'defer');
        assert.equal(model.hasPendingBuild(), true);
        assert.equal(model.surfaceGeometryRevision, revision);
        assert.equal(model.getSurfaceProfiles(), published, 'a consumer cannot publish the held successor');
    } finally { model.dispose(); }
});

test('absent terrain needs no road build, and a dependency without a stepper waits', () => {
    assert.equal(advanceRoadFormationDependency(null), 'ready');
    assert.equal(advanceRoadFormationDependency({ hasPendingBuild: () => true }), 'defer');
});

test('a building waits only for a pending road change that reaches its footprint', () => {
    const model = new RoadFormationModel({ anchorLat: 45.8, anchorLon: 15.9, baseSceneYAtLocal: () => 0 });
    try {
        model.setCenterlineTile('0_0', [road(45.8)]);
        model.setSurfaceTile('0_0', [{ type: 'Feature', properties: { osm_id: 1, highway_type: 'residential' },
            geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79997], [15.901, 45.79997],
                [15.901, 45.80003], [15.9, 45.80003], [15.9, 45.79997]]] } }]);
        while (advanceRoadFormationDependency(model) !== 'ready') {}
        const near = { minX: 10, maxX: 30, minZ: -10, maxZ: 10 };
        const far = { minX: 900, maxX: 920, minZ: 900, maxZ: 920 };
        assert.equal(pendingRoadFormationChangeTouches(model, near, 24), false, 'nothing pending: nothing to wait for');
        model.managePublications();
        model.invalidateTerrain([{ minX: 0, minZ: -20, maxX: 100, maxZ: 20 }]);
        assert.equal(model.hasPendingBuild(), true);
        assert.equal(pendingRoadFormationChangeTouches(model, near, 24), true, 'the change reaches the footprint');
        assert.equal(pendingRoadFormationChangeTouches(model, far, 24), false, 'a change 900 m away does not');
        assert.equal(pendingRoadFormationChangeTouches(model, { minX: 110, maxX: 130, minZ: 0, maxZ: 5 }, 24), true,
            'the sampler reach beside the footprint counts');
        assert.equal(pendingRoadFormationChangeTouches(model, { minX: 130, maxX: 150, minZ: 0, maxZ: 5 }, 24), false);
        model.invalidateTerrain();
        assert.equal(pendingRoadFormationChangeTouches(model, far, 24), true, 'a full invalidation keeps the wait');
        assert.equal(pendingRoadFormationChangeTouches(model, null, 24), true, 'no footprint: the safe direction');
        assert.equal(pendingRoadFormationChangeTouches({ hasPendingBuild: () => true }, far, 24), true,
            'a model that cannot report changes keeps the wait');
        assert.equal(pendingRoadFormationChangeTouches(null, far, 24), false);
    } finally { model.dispose(); }
});

test('the foundation wait expires after its allowance and never on an unknown clock', () => {
    assert.equal(roadFormationWaitExpired(1000, 1000 + 7999, 8000), false);
    assert.equal(roadFormationWaitExpired(1000, 1000 + 8000, 8000), true);
    assert.equal(roadFormationWaitExpired(1000, 1000 + 2500, 2500), true, 'a transit allowance is shorter');
    assert.equal(roadFormationWaitExpired(1000, 1000, 0), true, 'no allowance: never wait');
    assert.equal(roadFormationWaitExpired(null, 5000, 8000), false);
    assert.equal(roadFormationWaitExpired(1000, NaN, 8000), false);
});

test('a building waits two seconds standing, one in transit and not at all at speed', () => {
    assert.equal(foundationFormationWaitAllowanceMs('stationary'), 2000);
    assert.equal(foundationFormationWaitAllowanceMs('slow'), 2000);
    assert.equal(foundationFormationWaitAllowanceMs('transit'), 1000);
    assert.equal(foundationFormationWaitAllowanceMs('fast'), 0);
    assert.equal(foundationFormationWaitAllowanceMs(undefined), 2000, 'an unknown motion state waits like standing');
});
