// Execute the real catch-all painter and road ring compiler with Three. The
// canvas records paint commands; no browser, timer delay or WebGL is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createGroundCoverFootprints } from '../core/ground-cover-footprints.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { createReceiverFootprintSteps } from '../core/receiver-footprint.js';
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { roadRenderQueryBounds } from '../core/road-render-ground.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { pointInRingNonZero } from '../core/mask-query.js';
import { createGroundReadEvidence, freezeGroundReadEvidence, withGroundReadEvidence } from '../core/ground-read-evidence.js';

const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const ring = x => [{ x, z: 0 }, { x: x + 2, z: 0 }, { x, z: 2 }];

test('the live painter reads committed footprints through redraw, rollback, replacement and eviction', () => {
    let timerId = 0, updates = 0, path = [];
    const timers = new Map(), painted = [];
    const ctx = { fillRect() { painted.length = 0; }, beginPath() { path = []; },
        moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); },
        closePath() {}, fill() { painted.push(path); }, stroke() {} };
    const runtime = vm.createContext({ THREE, createGroundCoverFootprints,
        groundMesh: new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()),
        SIDEWALK_TILE_M: 3, registerShared() {}, applyUrbanGroundSurface() {},
        getGrassTexture: () => new THREE.Texture(), clearUrbanGroundSurfaceMask() {},
        setUrbanGroundSurfaceMask: () => updates++,
        document: { createElement: () => ({ getContext: () => ctx }) },
        setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: id => timers.delete(id),
    });
    const source = readFileSync(new URL('../world/ground-cover.js', import.meta.url), 'utf8');
    vm.runInContext(source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '').replace(/^export /gm, ''), runtime);
    const flush = () => { for (const [id, callback] of timers) { timers.delete(id); callback(); } };
    runtime.beginGroundCover({ enabled: true });
    assert.equal(painted.length, 0);
    const initialUpdates = updates;
    const first = drain(runtime.prepareGroundCoverRoadBucketSteps('a', [['road', [ring(0)]]]));
    assert.equal(timers.size, 0); assert.equal(updates, initialUpdates);
    assert.equal(first.commit(), true); first.finalize(); flush();
    assert.equal(painted.length, 1);
    const original = JSON.stringify(painted);
    const failed = drain(runtime.prepareGroundCoverRoadBucketSteps('a', [['road', [ring(12)]]]));
    assert.equal(failed.commit(), true); failed.rollback(); failed.discard();
    runtime.redraw();
    assert.equal(JSON.stringify(painted), original);
    assert.equal(timers.size, 0, 'failed publication schedules no delayed paint');
    const identical = drain(runtime.prepareGroundCoverRoadBucketSteps('a', [['road', [ring(0)]]]));
    identical.commit(); identical.finalize(); assert.equal(timers.size, 0);
    const next = drain(runtime.prepareGroundCoverRoadBucketSteps('a', [['road', [ring(12)]]]));
    next.commit(); next.finalize(); flush();
    assert.equal(painted.length, 1); assert.notEqual(JSON.stringify(painted), original);
    const clear = drain(runtime.prepareGroundCoverRoadBucketSteps('a', []));
    clear.commit(); clear.finalize(); flush();
    assert.equal(painted.length, 0);
    runtime.beginGroundCover({ enabled: false });
    assert.equal(drain(runtime.prepareGroundCoverRoadBucketSteps('a', [['road', [ring(0)]]])), null);
    assert.equal(timers.size, 0);
    runtime.groundMesh.geometry.dispose(); runtime.groundMesh.material.dispose();
});

test('the real road ring stage carries the once-projected footprint only on a completed mesh', () => {
    const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
    const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
    const runtime = vm.createContext({ THREE, DEG_TO_RAD, EARTH_RADIUS_M,
        createReceiverFootprintSteps, GROUND_GENERATION_LIMITS,
        profNow: () => 0, profAdd() {}, startupTrace: { enabled: false },
        ROAD_STAGED_RING_MIN_POINTS: 64, SIDEWALK_LEVEL_TYPES: new Set(), ROAD_STENCIL_RENDER_ORDER: 1,
        SURFACE_COVERAGE_STATE: { BUILDING: 'building' }, markRoadSurfaceClaim() {},
        // The ring task's bike phase; this fixture carries no cycle lane.
        createRoadBikeGeometrySteps: function* () {},
    });
    vm.runInContext('const ASPHALT_UV_PER_M = 1 / 16;\n'
        + section('function localRoadRing(', '// Aggregated per-sub-step timing')
        + section('function createRoadPolygonGeometryTask(', 'function centerlineLocalPoints(')
        + section('function appendRoadRingSurface(', 'function appendRoadRingTerrainSeam(')
        + section('function createRoadRingTask(', 'function appendPedestrianEdging('), runtime);
    runtime.anchorLat = 45.8; runtime.anchorLon = 16;
    const latScale = DEG_TO_RAD * EARTH_RADIUS_M, lonScale = latScale * Math.cos(45.8 * DEG_TO_RAD);
    const points = [[0, 0], [8, 0], [0, 6], [0, 0]];
    const coords = points.map(([x, z]) => [16 + x / lonScale, 45.8 - z / latScale]);
    const ctx = { rings: [coords], ground: { terrain: null, roadFormation: null, verticalAlignments: null },
        retainingProfiles: [], featureGroup: new THREE.Group(), mat: new THREE.MeshBasicMaterial(), y: 2,
        type: 'residential' };
    const task = runtime.createRoadRingTask(ctx, 0);
    assert.equal(ctx.featureGroup.children.length, 0);
    assert.equal(task.step(), 'done');
    const mesh = ctx.featureGroup.children[0];
    assert.equal(mesh.geometry.attributes.position.count, 3);
    assert.equal(mesh.userData.groundCoverRing.length, 3, 'closing point is not duplicated');
    for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(mesh.userData.groundCoverRing[i].x - points[i][0]) < 1e-8);
        assert.ok(Math.abs(mesh.userData.groundCoverRing[i].z - points[i][1]) < 1e-8);
    }
    coords[0][0] += 1;
    assert.ok(Math.abs(mesh.userData.groundCoverRing[0].x) < 1e-8, 'footprint owns projected coordinates');
    assert.equal(mesh.userData.terrainCutoutRegions, undefined, 'an ineligible receiver grants no terrain cut');
    const physical = { ...ctx, terrainCutoutRequired: true, featureGroup: new THREE.Group(),
        rings: [points.map(([x,z])=>[16+x/lonScale,45.8-z/latScale])], ground: { ...ctx.ground, isCurrent:()=>true } };
    const physicalTask = runtime.createRoadRingTask(physical,0);
    let visits=0,status;
    do { status=physicalTask.step(); assert.ok(++visits<100,'bounded ring work must settle'); } while(status==='more');
    assert.equal(status,'done');assert.ok(visits>1,'physical cut preparation uses cooperative stages');
    const receiver=physical.featureGroup.children[0],cuts=receiver.userData.terrainCutoutRegions;
    assert.equal(cuts.length,1);
    assert.equal(pointInRingNonZero(2,1,cuts[0].ring),true);
    assert.equal(pointInRingNonZero(7,5,cuts[0].ring),false);
    for(let i=1;i<receiver.geometry.attributes.position.array.length;i+=3)assert.equal(receiver.geometry.attributes.position.array[i],2);
    receiver.geometry.dispose();physicalTask.dispose();
    // A distant terrain arrival expires the global read, while this feature's
    // captured region remains unchanged. Exercise the actual feature driver,
    // ring driver and boundary compiler; the former global check threw here.
    let regionalCurrent = true;
    const ground = ownReadSnapshot({ terrain: null, roadFormation: null, verticalAlignments: null,
        isCurrent: () => false, currentWithin: () => () => regionalCurrent }, []);
    const localGroup = new THREE.Group();
    Object.assign(runtime, { ownReadSnapshot, createGroundReadEvidence, freezeGroundReadEvidence, withGroundReadEvidence, retainReadSnapshot, roadRenderQueryBounds,
        captureProposalMaskSnapshot: () => ({ isCurrent: () => true }),
        prepareRoadFeature: (_feature, _tile, read) => ({ ...physical, ground: read, featureGroup: localGroup }),
        appendPedestrianEdging: () => true, appendBikeLanes: () => true,
        finishRoadFeature: value => value.featureGroup,
        disposeRoadFeatureGroup: value => value?.traverse(object => object.geometry?.dispose()) });
    vm.runInContext(section('function createRoadFeatureTask(', 'function buildRoadFeatureGroup('), runtime);
    const feature = { properties: { osm_id: 123 }, geometry: { type: 'Polygon', coordinates: physical.rings } };
    const localTask = runtime.createRoadFeatureTask(feature, 'tile', ground);
    visits = 0;
    do { status = localTask.step(); assert.ok(++visits < 100); } while (status === 'more');
    assert.equal(status, 'done'); assert.equal(localTask.isCurrent(), true);
    assert.equal(localGroup.children[0].userData.terrainCutoutRegions.length, 1);
    regionalCurrent = false;
    assert.equal(localTask.isCurrent(), false, 'an edit within the captured feature region still invalidates the result');
    localTask.dispose(); ground.release();
    mesh.geometry.dispose(); ctx.mat.dispose();
});
