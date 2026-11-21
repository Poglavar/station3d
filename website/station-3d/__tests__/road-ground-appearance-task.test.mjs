// Execute the production road task and bike/profile builders. Only scene-heavy
// road-ring construction, materials and edging are supplied by this harness;
// aggregate publication and Rapier support have separate integration coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import * as groundReadEvidence from '../core/ground-read-evidence.js';
import { createGroundSurfacePaintRecordSteps } from '../core/ground-surface-paint.js';
import { createGroundBikePaintRecordsSteps } from '../core/ground-bike-paint.js';
import { groundPaintCapacity } from '../core/ground-paint-source-plans.js';
import { createRoadFeatureIdentityIndex } from '../core/road-feature-identity.js';
import { roadGroundPaintEligible, roadReceiverPaintEligible } from '../core/road-ground-paint.js';
import { retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { roadRenderQueryBounds } from '../core/road-render-ground.js';
import { resolveBikeLaneBands, buildBikeLaneQuads, buildCenteredBikeLaneQuads, bikePaintSceneY } from '../core/bike-lane-geometry.js';
import { compileSurfaceClaim, reviseSurfaceClaim, SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_RENDER_ORDER } from '../core/surface-hierarchy.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
const between = (a, b) => { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start); return source.slice(start, end); };
const code = [between('function createRoadFeatureTask(', '// Synchronous drain,'),
    between('function* roadBikeQuadsSteps(', '// Pedestrian paving sits'),
    between('function createBikeLaneGeometryTask(', 'function createBikeLaneGeometry(')].join('\n');
const receiver = Object.freeze({ key: 'terrain', verticalBand: 'ground', coverageRevision: 'captured' });
function fixture({ type = 'residential', grade = false, points = 2, cycling = { cycleway: 'lane' }, ringOutcome = null } = {}) {
    const warnings = [];
    const feature = { properties: { osm_id: 42, highway_type: type, width_meters: 6, tags: cycling,
        centerline_geometry: { type: 'LineString', coordinates: Array.from({ length: points }, (_, i) => [i * .001 / (points - 1), 0]) } },
        geometry: { type: 'Polygon', coordinates: [[[0, -.00003], [.001, -.00003], [.001, .00003], [0, .00003], [0, -.00003]]] } };
    const surfaceClass = type === 'cycleway' ? SURFACE_CLASS.CYCLEWAY : type === 'footway' ? SURFACE_CLASS.BUFFERED_SIDEWALK : SURFACE_CLASS.ROAD_CARRIAGEWAY;
    const claim = compileSurfaceClaim({ surfaceClass, ownerId: 'way:42', supportReady: true, cutsBackstop: true,
        verticalBand: grade ? null : 'ground', verticalRelation: grade ? 'grade-separated' : 'same-level' });
    const group = new THREE.Group(), physical = new THREE.BufferGeometry();
    physical.setAttribute('position', new THREE.Float32BufferAttribute([0,4,0, 1,4,0, 0,4,1], 3));
    const positions = physical.attributes.position.array.slice();
    let disposed = 0, leases = 0, heightQueries = 0;
    physical.addEventListener('dispose', () => disposed++);
    const failHeight = () => { heightQueries++; throw new Error('appearance sampled terrain'); };
    const model = { isCurrent: () => true, terrain: { evidenceSceneYAtLocal: failHeight },
        roadFormation: { sceneYAtLocal: failHeight },
        verticalAlignments: grade ? { getAlignmentForOsmId: () => ({}), roadYForOsmIdsAtLocal: x => 8 + .05 * x } : null,
        retain() { leases++; let active = true; return { ...model, release() { if (active) { active = false; leases--; } } }; } };
    const ctx = { feature, type, osm_id: 42, y: .034, tileKey: '0_0', surfaceClaim: claim, featureGroup: group,
        rings: feature.geometry.coordinates, followsVerticalAlignment: grade,
        paintOnly: !grade && roadGroundPaintEligible({ type }),
        paintAppearance: !grade && (roadGroundPaintEligible({ type }) || roadReceiverPaintEligible({ claim, type })), tRoadTotal: 0 };
    const runtime = vm.createContext({ ...groundReadEvidence, THREE, Object, Array, Set, Map, Math, Number, performance,
        createGroundSurfacePaintRecordSteps, createGroundBikePaintRecordsSteps, groundPaintCapacity,
        resolveBikeLaneBands, buildBikeLaneQuads, buildCenteredBikeLaneQuads, bikePaintSceneY,
        compileSurfaceClaim, reviseSurfaceClaim, SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_RENDER_ORDER,
        DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull, retainReadSnapshot, roadRenderQueryBounds,
        groundPaint: { receiver }, groundManaged: true, anchorLat: 0, anchorLon: 0,
        roadFeatureIdentities: createRoadFeatureIdentityIndex(),
        SIDEWALK_LEVEL_TYPES: new Set(['footway', 'path', 'cycleway', 'steps', 'bridleway']),
        ROAD_VERTICAL_BIKE_MAX_SEGMENT_M: 8, BIKE_LANE_GEOMETRY_QUADS_PER_STEP: 8,
        captureProposalMaskSnapshot: () => ({ isCurrent: () => true }),
        prepareRoadFeature: (_feature, _tile, ground) => Object.assign(ctx, { ground }),
        createRoadRingTask: () => ({ step() { if (ringOutcome) return ringOutcome.status; group.add(new THREE.Mesh(physical, new THREE.MeshStandardMaterial())); return 'done'; },
            phaseLabel: () => 'ring', dispose() {}, ...(ringOutcome?.omission ? { omission: () => ringOutcome.omission } : {}) }),
        console: { warn: (...args) => warnings.push(args.join(' ')) },
        appendPedestrianEdging: () => true, roadGroundPaintStyle: type => ({ key: type, revision: '1' }),
        getRoadSurfaceY: () => .046, getBikePaintMaterial: () => new THREE.MeshStandardMaterial({ color: 0xa8452f }),
        applyWorldRoadUvs() {}, markSurfaceClaim: (object, value) => { object.userData.surfaceClaim = compileSurfaceClaim(value); },
        disposeRoadFeatureGroup: root => root?.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); }),
        startupTrace: { enabled: false }, profAdd() {},
    });
    vm.runInContext(code, runtime);
    const task = runtime.createRoadFeatureTask(feature, '0_0', model);
    const finish = () => { for (let i = 0; i < 10000; i++) { const status = task.step(); assert.notEqual(status, 'defer'); if (status === 'done') return task.group(); } assert.fail('road task failed to finish'); };
    return { task, finish, group, physical, positions, warnings, stats: () => ({ leases, disposed, heightQueries }) };
}
test('a ring that proved its terrain gap permanent excludes the road at that point instead of rejecting the generation', () => {
    const omission = Object.freeze({ kind: 'excluded', reason: 'terrain-evidence', x: 12.34, z: -5.6 });
    const abort = f => { for (let i = 0; i < 100; i++) { const status = f.task.step(); if (status === 'abort') return; assert.notEqual(status, 'done'); } assert.fail('no abort'); };
    const f = fixture({ cycling: {}, ringOutcome: { status: 'no-data', omission } });
    try {
        abort(f);
        assert.equal(f.task.group(), null);
        assert.deepEqual(f.task.omission(), omission, 'the ring decides, with its point');
        assert.equal(f.warnings.length, 1);
        assert.match(f.warnings[0], /^\[\d{4}-\d\d-\d\dT[^\]]+\] \[roads\] road 42 excluded from the ground generation: terrain-evidence at 12\.3,-5\.6$/);
    } finally { f.task.dispose(); }
    // A ring that cannot say why it has no data keeps the old rejection: the generation retries.
    const bare = fixture({ cycling: {}, ringOutcome: { status: 'no-data' } });
    try {
        abort(bare);
        assert.equal(bare.task.omission().kind, 'unavailable'); assert.equal(bare.task.omission().reason, 'terrain-evidence');
        assert.deepEqual(bare.warnings, []);
    } finally { bare.task.dispose(); }
});
test('production profiled road task keeps its physical ring and emits base plus side-cycle paint without height work', () => {
    const f = fixture();
    try {
        const group = f.finish();
        assert.equal(group.children.length, 1); assert.equal(group.children[0].geometry, f.physical);
        assert.deepEqual(f.physical.attributes.position.array, f.positions);
        assert.deepEqual(Array.from(group.userData.groundPaintRecords, record => record.claim.surfaceClass), ['road-carriageway', 'cycleway']);
        assert.equal(group.userData.groundPaintRecords[1].sourcePriority, 1);
        assert.deepEqual(f.stats(), { leases: 0, disposed: 0, heightQueries: 0 });
    } finally { f.task.dispose(); }
});
test('production paint-only bicycle footway has centered red coverage and no extra deck mesh', () => {
    const f = fixture({ type: 'footway', cycling: { bicycle: 'designated' } });
    try { const group = f.finish(); assert.equal(group.children.length, 0); const records = group.userData.groundPaintRecords;
        assert.equal(records.length, 2); assert.equal(records[1].claim.surfaceClass, SURFACE_CLASS.CYCLEWAY);
        assert.equal(records[1].polygons.length, 1); assert.equal(records[1].claim.capabilities.support, false);
        assert.equal(f.stats().heightQueries, 0);
    } finally { f.task.dispose(); }
});
test('production carried cycle path uses captured deck heights and never contributes ordinary receiver paint', () => {
    const f = fixture({ type: 'cycleway', grade: true });
    try { const group = f.finish(); assert.equal(group.userData.groundPaintRecords, undefined);
        assert.equal(group.children.length, 2); const lane = group.children.find(child => child.name === 'RoadSurface:bike-lane');
        assert.equal(lane.userData.surfaceClaim.verticalRelation, 'grade-separated');
        const p = lane.geometry.attributes.position;
        assert.ok(p.count > 4, 'long two-node deck is profiled along short chords');
        for (let i = 0; i < p.count; i++) assert.ok(Math.abs(p.getY(i) - (8 + .05 * p.getX(i) + .052)) < 1e-5);
        assert.equal(f.stats().heightQueries, 0); assert.equal(f.stats().leases, 0);
    } finally { f.task.dispose(); }
});
test('cancelling production road task during cycle compilation retires its detached physical ring and read lease', () => {
    const f = fixture({ points: 64 });
    while (!f.task.phaseLabel().endsWith(' bike')) assert.equal(f.task.step(), 'more');
    assert.equal(f.task.step(), 'more');
    assert.equal(f.group.userData.groundPaintRecords.length, 1, 'unfinished cycle record is private');
    f.task.dispose();
    assert.equal(f.task.group(), null); assert.deepEqual(f.stats(), { leases: 0, disposed: 1, heightQueries: 0 });
});
