import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { RailFormationModel } from '../core/rail-formation.js';

const source = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
const block = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
function fixture() {
    const invalidations = [];
    const r = vm.createContext({ group: {}, railGroundGenerationLease: null, pendingRailFormationBuild: null,
        pendingRailVisualRefresh: null, pendingRailStructuresRefresh: null, pendingCrossingFormationRefresh: null,
        pendingEmbeddedTramMeshRefresh: null, railSessionToken: 1, lastFeatures: [], lastStops: [], groundManaged: true,
        streamedRailTileFeatures: null, streamedRailBaseFeatures: [], lastTerrainSource: {}, resolveStandaloneRailFeatures: v => v,
        lastTerrain: {}, lastRailFormation: { getViaductRuns: () => [{}] },
        lastRoadFormation: { hasPendingBuild: () => false }, lastRoadVerticalAlignments: {},
        streamedRailInputRevision: 1, sampledTrackbedRevision: 1, renderedRailSurfaceRevision: 1, lastPhotoTrackFrame: null,
        lastPillarClearance: {}, pillarClearanceReady: true, pillarClearanceLoading: false, mappedSeaStructuresRevision: 1,
        photoStationStructureRevision: 1, lastBridgeStyleLocationId: 'fixture', lastBridgeStyleCityId: 'fixture',
        streamedRailDirty: true, streamedRailDirtySinceMs: 1, streamedRailRetryAfterMs: 10, streamedRailChangedTileKeys: new Set(['a']),
        terrainRevisionDirty: true, terrainDirtyFullRefresh: true, terrainDirtyBounds: [{ minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
        mappedSeaStructuresDirty: true, streamedRailSource: null,
        groundCoordinator: { invalidate: (...args) => invalidations.push(args) }, mappedSeaChangeSubscription: null,
        subscribeMappedSeaChanges(callback) { r.seaChanged = callback; return () => {}; },
        isSolvedRailFeature: () => false,
    });
    vm.runInContext(block('function* admitRailGroundGenerationSteps(', '// Civil construction precedes road ownership.')
        + block('function* resolveStandaloneRailFeaturesSteps(', 'function replaceStreamedRailFeatures(')
        + block('export function isRailSurfacePreloadSettled(', "if (typeof window !== 'undefined')").replace('export function', 'function'), r);
    r.admitRailGroundGeneration = options => {
        const steps = r.admitRailGroundGenerationSteps(options);
        let next; do { next = steps.next(); } while (!next.done);
        return next.value;
    };
    return { r, invalidations };
}

test('managed rail publication acknowledges consumed pre-cutover dirt only after successful publication', () => {
    const { r } = fixture();
    let lease = r.admitRailGroundGeneration({ isCurrent: () => true, maxFeatures: 10 });
    assert.equal(r.isRailSurfacePreloadSettled(), false); lease.release();
    assert.equal(r.isRailSurfacePreloadSettled(), false, 'discard preserves the old obligation');
    lease = r.admitRailGroundGeneration({ isCurrent: () => true, maxFeatures: 10 });
    assert.equal(lease.acknowledge({ x: 0, z: 0 }), true); lease.release();
    assert.equal(r.isRailSurfacePreloadSettled(), true);
    assert.equal(r.terrainDirtyFullRefresh, false); assert.equal(r.terrainDirtyBounds.length, 0);
});

test('published rail geometry with a valid empty earthwork model is ready for shared ground admission',()=>{
    const features=JSON.parse(readFileSync(new URL('./fixtures/planner-backstop-before.json',import.meta.url))).fixtures[0].features;
    const model=new RailFormationModel({features,anchorLat:45,anchorLon:16,baseSceneYAtLocal:()=>0});
    try {
        assert.equal(model.revision,0,'local-level planner geometry does not create terrain-relative earthworks');
        const {r}=fixture();r.lastFeatures=features;r.streamedRailBaseFeatures=features;r.lastRailFormation=null;
        const expression=block('    groundReady: () =>','    manageGroundPublications(').trim()
            .replace(/^groundReady: /,'').replace(/,$/,'');
        const ready=vm.runInContext(`(${expression})`,r);
        assert.equal(ready(),true);
        const lease=r.admitRailGroundGeneration({isCurrent:()=>true,maxFeatures:10});assert.ok(lease);
        assert.equal(ready(),false,'the captured source lease prevents competing preparation');lease.release();
        for(const key of ['pendingRailFormationBuild','pendingRailVisualRefresh','pendingRailStructuresRefresh',
            'pendingCrossingFormationRefresh','pendingEmbeddedTramMeshRefresh']) {
            r[key]={};assert.equal(ready(),false,key);r[key]=null;
        }
        r.group=null;assert.equal(ready(),true,'the transactional first publisher accepts a null predecessor');
        const initialLease=r.admitRailGroundGeneration({isCurrent:()=>true,maxFeatures:10});
        assert.ok(initialLease,'the shared coordinator can admit the first rail generation');initialLease.release();
    }finally{model.dispose();}
});

test('late rail source and sea changes retain their pending obligations', () => {
    const { r } = fixture(), lease = r.admitRailGroundGeneration({ isCurrent: () => true, maxFeatures: 10 });
    r.streamedRailInputRevision++;
    assert.equal(lease.acknowledge({ x: 0, z: 0 }), false); lease.release();
    assert.equal(r.streamedRailDirty, true); assert.equal(r.terrainRevisionDirty, true); assert.equal(r.mappedSeaStructuresDirty, true);
    const next = r.admitRailGroundGeneration({ isCurrent: () => true, maxFeatures: 10 }); r.mappedSeaStructuresRevision++;
    next.acknowledge({ x: 0, z: 0 }); next.release(); assert.equal(r.mappedSeaStructuresDirty, true);
});

test('mapped sea changes invalidate managed rail structures and keep the ordinary dirty path for unmanaged sessions', () => {
    const { r, invalidations } = fixture();
    vm.runInContext(block('const mappedSeaSessionToken = railSessionToken;', 'terrainChangeSubscription = lastTerrainSource'), r);
    r.seaChanged();
    assert.equal(r.mappedSeaStructuresRevision, 2); assert.equal(r.mappedSeaStructuresDirty, true);
    assert.equal(invalidations.length, 1); assert.equal(invalidations[0][0], 'rails'); assert.equal(invalidations[0][1].full, true);
    r.groundManaged = false; r.mappedSeaStructuresDirty = false; r.seaChanged();
    assert.equal(r.mappedSeaStructuresDirty, true); assert.equal(invalidations.length, 1);
    r.railSessionToken++; r.seaChanged(); assert.equal(r.mappedSeaStructuresRevision, 3);
});
