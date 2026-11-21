import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { RoadFormationModel } from '../core/road-formation.js';
import { roadVerticalCenterlinesFromSurfaceFeaturesSteps } from '../core/road-vertical-alignment.js';
import { railCivilGroundDependencySnapshotSteps } from '../core/rail-road-grade-separation.js';
import { changedCivilGroundDependencyBoundsSteps } from '../core/civil-ground-composition.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
const adapter = source.slice(source.indexOf('function* prepareRoadAlignmentGroundSourcesSteps('),
    source.indexOf('function* prepareRoadFormationGroundSteps('));
const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const lat = 45.8, lon = 16, scale = DEG_TO_RAD * EARTH_RADIUS_M;
const ll = ([x, z]) => [lon + x / (scale * Math.cos(lat * DEG_TO_RAD)), lat - z / scale];
function railRead(height, revision = 1) {
    const profiles = height == null ? [] : [{ bounds: { minX: -30, minZ: -10, maxX: 30, maxZ: 10 },
        points: [-30, 30].map(x => ({ innerX: x, innerZ: 0, roadY: height,
            outerX: x, outerZ: 10, terrainY: height })) }];
    return Object.freeze({ revision, getSurfaceProfiles: () => profiles, getViaductRuns: () => [] });
}

test('candidate rail changes regrade intersecting roads while retaining distant cached profiles', () => {
    let nearY = 0, farSamples = 0, publishedRail = railRead(0);
    const sample = x => { if (x < 100) return nearY; farSamples++; return 20; };
    const model = new RoadFormationModel({ anchorLat: lat, anchorLon: lon, baseSceneYAtLocal: sample });
    for (const [id, x] of [[1, 0], [2, 500]]) {
        model.setCenterlineTile(String(id), [{ properties: { osm_id: id, highway: 'residential' },
            geometry: { type: 'LineString', coordinates: [[x - 20, 0], [x + 20, 0]].map(ll) } }]);
        model.setSurfaceTile(String(id), [{ properties: { osm_id: id, highway_type: 'residential' },
            geometry: { type: 'Polygon', coordinates: [[[-20, -4], [20, -4], [20, 4], [-20, 4], [-20, -4]]
                .map(([dx, z]) => ll([x + dx, z]))] } }]);
    }
    const near = model.getSurfaceProfilesForOsmId(1)[0], far = model.getSurfaceProfilesForOsmId(2)[0];
    // Supply the adapter's published-read boundary; the road solver and its
    // geometry caches below are real, as is the rail dependency fingerprint.
    model.getPublishedBuildInputs = () => ({ context: { railFormation: publishedRail } });
    const runtime = vm.createContext({ roadFormationModel: model,
        loadedSurfaceFeaturesForVerticalAlignments: () => [], roadVerticalCenterlinesFromSurfaceFeaturesSteps,
        railCivilGroundDependencySnapshotSteps, changedCivilGroundDependencyBoundsSteps,
        roadVerticalAlignmentModel: { setCenterlineTile: () => ({ changed: false }) }, SURFACE_ALIGNMENT_SET_KEY: 'surface' });
    vm.runInContext(adapter, runtime);
    const prepare = read => drain(runtime.prepareRoadAlignmentGroundSourcesSteps({
        terrain: Object.freeze({}), railFormation: read, isCurrent: () => true,
        ...GROUND_GENERATION_LIMITS.alignmentSources,
    }));
    const revision = model.revision;
    prepare(railRead(0, 500));
    assert.equal(model.revision, revision, 'object identity and revision alone must not regrade roads');
    assert.equal(model.getSurfaceProfilesForOsmId(1)[0], near);

    farSamples = 0; nearY = 8;
    const raised = railRead(8, 501);
    prepare(raised);
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 }) - 8) < 1e-6);
    assert.equal(model.getSurfaceProfilesForOsmId(2)[0], far);
    assert.equal(farSamples, 0, 'a local rail change must not resample a distant road');

    publishedRail = raised; nearY = 0;
    prepare(railRead(null, 502));
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 })) < 1e-6,
        'rail removal invalidates its former footprint');
    assert.equal(model.getSurfaceProfilesForOsmId(2)[0], far);
    model.dispose();
});
