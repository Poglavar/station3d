// Exercise the production curb height and preparation functions across yields.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { finiteOrNull } from '../core/math.js';
import { retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { resolveCurbSceneYAtLocal } from '../core/curb-height.js';
import { CURB_DRAPE_KIND, CURB_TERRAIN_VERTICES_PER_STEP, curbDrapeHeightSource, stepCurbTerrainDrape } from '../core/curb-terrain-drape.js';
const source = readFileSync(new URL('../world/curbs.js', import.meta.url), 'utf8');
const forbidden = new Proxy({}, { get() { throw new Error('live height provider read'); } });
const runtime = vm.createContext({ finiteOrNull, resolveCurbSceneYAtLocal, curbDrapeHeightSource,
    stepCurbTerrainDrape, CURB_DRAPE_KIND, roadSurfaceSceneOffset: () => .08,
    terrainReference: forbidden, roadFormationModel: forbidden });
vm.runInContext(source.slice(source.indexOf('const curbLandingSurfaceOffsetY ='),
    source.indexOf('function describeTerrainBuildItem(')), runtime);
function view(height) {
    return Object.freeze({ terrain: Object.freeze({ evidenceSceneYAtLocal: (x, z) => height + x * .01 + z * .02 }),
        roadFormation: Object.freeze({ formationAtLocal: (x, z) => x < 5 ? { osmId: 1, roadY: height + .5 } : null,
            sceneYAtLocal: () => null, civilGroundSceneYAtLocal: x => x < 5 ? height + .58 : null }) });
}

test('actual curb drape uses captured road, landing and NoData evidence across resumed ranges', () => {
    const ground = view(2), state = { ground, verticalAlignmentModel: null, terrainYByOwner: new Map() };
    for (const [x, z] of [[1, 1], [10, 10], [21, 7]]) {
        const expected = x < 5 ? 2.5 : 2 + x * .01 + z * .02;
        assert.ok(Math.abs(runtime.terrainYForBuild(state, x, z, [1], null) - expected) < 1e-10);
    }
    // Different samples are deliberately not cache hits: the whole remaining
    // range must stay on the held view after the live provider advances.
    runtime.terrainReference = view(50).terrain; runtime.roadFormationModel = view(50).roadFormation;
    for (const [x, z] of [[2, 3], [11, 9], [22, 8]]) {
        const expected = x < 5 ? 2.5 : 2 + x * .01 + z * .02;
        assert.ok(Math.abs(runtime.terrainYForBuild(state, x, z, [1], null) - expected) < 1e-10);
    }
    const absent = { ground: Object.freeze({ terrain: { evidenceSceneYAtLocal: () => null }, roadFormation: null }),
        verticalAlignmentModel: null, terrainYByOwner: new Map() };
    assert.equal(runtime.terrainYForBuild(absent, 1, 1, null, null), null);
    const raised = { drapeKind: CURB_DRAPE_KIND.TERRAIN_SEAM, localY: -.01 };
    assert.equal(curbDrapeHeightSource(raised.drapeKind, raised.localY), 'raised-side');
    assert.equal(runtime.terrainYForBuild(state, 3, 2, null, null, raised), 2.58);
    // Exceed the finite visit cap so this tests a real suspension regardless
    // of host speed or whether these repeated coordinates hit the height cache.
    const count = CURB_TERRAIN_VERTICES_PER_STEP + 3;
    const positions = Array.from({ length: count }, (_, i) => [1 + i % 3, .1, 1]).flat();
    const item = { positions, start: 0, end: positions.length, osmIds: [1], drapeKind: CURB_DRAPE_KIND.OWNER };
    assert.equal(runtime.applyTerrainBuildItem(state, item), false);
    assert.equal(positions.at(-2), .1, 'remaining vertex has not been processed');
    runtime.terrainReference = view(100).terrain; runtime.roadFormationModel = view(100).roadFormation;
    let complete = false;
    for (let visit = 0; visit < count && !complete; visit++) complete = runtime.applyTerrainBuildItem(state, item);
    assert.equal(complete, true);
    for (let index = 1; index < positions.length; index += 3) assert.equal(positions[index], 2.6);
});

test('curb build serializes a retained owner array once across repeated owner and raised-side samples', () => {
    const ground = view(2), state = { ground, verticalAlignmentModel: null, terrainYByOwner: new Map() };
    let joins = 0;
    const ownerIds = Array.from({ length: 256 }, (_, index) => index + 1);
    ownerIds.join = function (...args) { joins++; return Array.prototype.join.apply(this, args); };
    for (let index = 0; index < 200; index++) {
        const x = 10 + index, z = 20 + index;
        assert.equal(runtime.terrainYForBuild(state, x, z, ownerIds, null), 2 + x * .01 + z * .02);
        assert.equal(runtime.terrainYForBuild(state, x, z, ownerIds, null,
            { drapeKind: CURB_DRAPE_KIND.TERRAIN_SEAM, localY: -.01 }), 2 + x * .01 + z * .02);
    }
    assert.equal(runtime.terrainYForBuild(state, 1, 1, ownerIds, null), 2.5);
    assert.equal(runtime.terrainYForBuild(state, 1, 1, ownerIds, null,
        { drapeKind: CURB_DRAPE_KIND.TERRAIN_SEAM, localY: -.01 }), 2.58);
    assert.equal(joins, 1, 'the retained owner array is serialized once per build');
    const equivalentOwnerIds = Array.from(ownerIds);
    equivalentOwnerIds.join = function (...args) { joins++; return Array.prototype.join.apply(this, args); };
    assert.equal(runtime.terrainYForBuild(state, 10, 20, equivalentOwnerIds, null), 2.5);
    assert.equal(joins, 2, 'an equivalent owner array has its own cached serialization');
    const nextBuild = { ground: view(20), verticalAlignmentModel: null, terrainYByOwner: new Map() };
    assert.equal(runtime.terrainYForBuild(nextBuild, 1, 1, ownerIds, null), 20.5);
    assert.equal(joins, 3, 'a successor build owns a fresh cache and ground read');
});

test('curb preparation stops on stale ground without substituting a new capture or clearing output', () => {
    let valid = true, captures = 0, masks = 0;
    const ground = Object.freeze({ ...view(2), railFormation: null, verticalAlignments: null,
        isCurrent: () => valid });
    const context = vm.createContext({
        CURB_MASK_STAGES: [['masks:first', () => masks++]], FORMATION_DIRTY_PADDING_M: 32,
        captureSurfaceBuildGround: function* () { captures++; yield; return ground; },
        terrainReference: { renderedRailSurface: null }, plannerTrackVolumeGrid: null,
        plannerTrackCorridorVolumes: [], tileLocalBounds: () => ({ minX: 0, minZ: 0, maxX: 40, maxZ: 40 }),
        curbsGroup: {}, tileFeatures: new Map([['0_0', [{}]]]), maskTileFeatures: new Map([['0_0', []]]),
        prepareTileBuildContext() { throw new Error('stale preparation reached geometry'); },
    });
    context.retainReadSnapshot = retainReadSnapshot;
    vm.runInContext(source.slice(source.indexOf('function createTilePrepTask('),
        source.indexOf('function currentRailCutEdgeEvaluator(')), context);
    const task = context.createTilePrepTask('0_0');
    assert.equal(task.step(), 'more'); assert.equal(task.step(), 'more');
    valid = false;
    assert.equal(task.step(), 'stale'); assert.equal(task.isCurrent(), false);
    assert.equal(task.state(), null); assert.equal(captures, 1); assert.equal(masks, 0);
    task.dispose();
});
