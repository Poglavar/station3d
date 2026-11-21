// Detailed buildings are cooperatively staged off-scene. A foundation skirt
// can therefore wait for the road layer's authoritative formation generation
// without blinking the building or forcing that generation inside one item.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
    fileURLToPath(new URL('../world/buildings.js', import.meta.url)),
    'utf8',
);

test('a staged foundation cooperatively advances dirty road formation', () => {
    const stage = SRC.slice(
        SRC.indexOf('function* stageBuildingFeatureGdi'),
        SRC.indexOf('function createGdiBuildingBuildTask'),
    );
    assert.match(stage, /while \(pendingRoadFormationChangeTouches\(terrainReference\?\.roadFormation,\s*foundationBounds, FOUNDATION_FORMATION_REACH_M\)\) \{[\s\S]{0,400}roadFormationWaitExpired\(formationWaitStartMs\(terrainReference\?\.roadFormation\), performance\.now\(\),\s*foundationFormationWaitAllowanceMs\(getFrameChunkWorkMotionState\(\)\)\)\) break;\s*yield \{ phase: 'foundation-formation-wait', objectId \};/,
        'a skirt waits only for a pending road change that reaches its footprint, and only for the gate allowance');
    assert.match(SRC, /const publicationRevision = roadFormation\?\.surfaceGeometryRevision \?\? null;[\s\S]{0,600}queueTerrainBuildingRebuild\(\{ bounds: changes\.full \? \[\] : changes\.bounds,/,
        'a formation publication re-checks the tiles its changed profiles touch');
    assert.doesNotMatch(stage, /hasPendingBuild\?\.\(\) === true\) \{\s*yield \{ phase: 'foundation-formation-wait'/,
        'a held coordinated build far away must not freeze the tile');
    assert.match(SRC, /sceneYAtLocal\(x, z, \{ maxDistanceM: 18, allowStale: true \}\)/,
        'the foundation sampler reads published indexes, never a synchronous compile');
    assert.ok(
        stage.indexOf("phase: 'foundation-formation-wait'")
            < stage.indexOf('const foundationSegmentsIterator = foundationSegmentsForMeshFeatureCooperative'),
        'the authority gate runs before a skirt can query engineered ground',
    );
    assert.match(
        stage,
        /while \(!foundationSegmentsStep\.done\) \{\s*yield \{ \.\.\.foundationSegmentsStep\.value, objectId \};/,
        'multipart foundation perimeter extraction returns to the shared queue',
    );
    assert.match(
        stage,
        /while \(!foundationStep\.done\) \{\s*yield \{ \.\.\.foundationStep\.value, objectId \};/,
        'large skirts return to the shared queue between bounded geometry stages',
    );
    assert.match(
        stage,
        /while \(!foundationBufferStep\.done\) \{\s*yield \{ \.\.\.foundationBufferStep\.value, objectId \};/,
        'large immutable buffers return to the shared queue before mesh publication',
    );

    const advance = SRC.slice(
        SRC.indexOf('function createBuildingFeatureWorkItem'),
        SRC.indexOf('function advanceBuildingFeatureWorkItem'),
    );
    assert.match(
        advance,
        /outcome\.phase === 'foundation-formation-wait'[\s\S]*advanceBuildingRoadFormationDependency\(\)[\s\S]*return dependencyStatus === 'ready' \? 'repeat' : dependencyStatus/,
        'the staged item owns one bounded dependency step instead of deferring forever',
    );
    assert.match(
        advance,
        /lastPhase === 'foundation-skirt-geometry'[\s\S]{0,320}pendingRoadFormationChangeTouches\(terrainReference\?\.roadFormation,\s*visibilityBounds, FOUNDATION_FORMATION_REACH_M\);[\s\S]{0,200}roadFormationWaitExpired\(\s*formationWaitStartMs\(terrainReference\?\.roadFormation\), performance\.now\(\),\s*foundationFormationWaitAllowanceMs\(getFrameChunkWorkMotionState\(\)\)\)\) \{[\s\S]{0,120}advanceBuildingRoadFormationDependency\(\)/,
        'every resumed skirt sample advances the bounded dependency before querying it',
    );
    assert.ok(
        advance.indexOf("lastPhase === 'foundation-skirt-geometry'")
            < advance.indexOf('const outcome = task.step()'),
        'the resumed-stage guard must run before the generator can issue a current-data query',
    );
});

test('a footprint building advances road formation before live construction', () => {
    const dependency = SRC.slice(
        SRC.indexOf('function advanceBuildingRoadFormationDependency'),
        SRC.indexOf('function createBuildingFeatureWorkItem'),
    );
    assert.match(dependency, /return advanceRoadFormationDependency\(terrainReference\?\.roadFormation\)/);

    const advance = SRC.slice(
        SRC.indexOf('function createBuildingFeatureWorkItem'),
        SRC.indexOf('function advanceBuildingFeatureWorkItem'),
    );
    assert.match(
        advance,
        /const footprintChangeTouches = BUILDING_SOURCE === 'overture'\s*&& pendingRoadFormationChangeTouches\(terrainReference\?\.roadFormation,\s*visibilityBounds, FOUNDATION_FORMATION_REACH_M\);[\s\S]{0,400}roadFormationWaitExpired\(\s*formationWaitStartMs\(terrainReference\?\.roadFormation\), performance\.now\(\),\s*foundationFormationWaitAllowanceMs\(getFrameChunkWorkMotionState\(\)\)\)\) \{\s*const dependencyStatus = advanceBuildingRoadFormationDependency\(\);\s*inProgress = dependencyStatus === 'repeat';\s*return dependencyStatus;/,
    );
    assert.ok(
        advance.indexOf("BUILDING_SOURCE === 'overture'")
            < advance.indexOf('addBuildingFeature(feature, tileKey, buildContext)'),
        'the footprint path must wait before reserving ids or exposing partial geometry',
    );
});

test('terrain-relative buildings defer before reserving or constructing anything', () => {
    const workItem = SRC.slice(
        SRC.indexOf('function buildingFeatureNeedsTerrainEvidence'),
        SRC.indexOf('function advanceBuildingFeatureWorkItem'),
    );
    assert.match(workItem, /evidenceFoundationSceneY/);
    assert.match(
        workItem,
        /buildingFeatureNeedsTerrainEvidence\(feature\)[\s\S]*buildingTerrainEvidenceState\(feature\)[\s\S]*return 'defer'/,
    );
    assert.ok(
        workItem.indexOf('buildingTerrainEvidenceState(feature)')
            < workItem.indexOf('createGdiBuildingBuildTask'),
        'the evidence barrier runs before task creation and scene mutation',
    );
});

test('loaded terrain NoData settles a footprint building without fabricating a height', () => {
    const workItem = SRC.slice(
        SRC.indexOf('function buildingTerrainEvidenceState'),
        SRC.indexOf('function advanceBuildingFeatureWorkItem'),
    );
    assert.match(workItem, /hasLoadedCoreCoverageAt\?\.\(point\[0\], point\[1\]\) === true/);
    assert.match(
        workItem,
        /terrainEvidenceState === 'no-data'[\s\S]*lastPhase = 'terrain-no-data';[\s\S]*done = true;[\s\S]*return 'done'/,
    );
});

test('terrain refreshes retain the complete building tile until its replacement is ready', () => {
    const drain = SRC.slice(
        SRC.indexOf('function drainTerrainBuildingRebuild'),
        SRC.indexOf('function drainRegionalBuildingRebuild'),
    );
    const begin = SRC.slice(
        SRC.indexOf('function beginTileVisualReplacement'),
        SRC.indexOf('function publishTileVisualReplacementAggregates'),
    );

    assert.match(drain, /beginTileVisualReplacement\(task\.tileKey\)/);
    assert.doesNotMatch(drain, /removeTile\(task\.tileKey\)/,
        'removing first exposes an empty/LOD1 tile for the whole resumable rebuild');
    assert.match(begin, /retainedChildren\.add\(child\)/);
    assert.doesNotMatch(begin, /dropOvertureTileState/,
        'the live regional aggregate must not be mutated while replacement parts are incomplete');
});

test('retained terrain replacements defer their intake throughout movement', () => {
    const onFrame = SRC.slice(
        SRC.indexOf('onFrame(pose, local)'),
        SRC.indexOf('endSession()', SRC.indexOf('onFrame(pose, local)')),
    );
    assert.match(
        onFrame,
        /getFrameChunkWorkMotionState\(\) === 'stationary'[\s\S]*drainTerrainBuildingRebuild\(\)/,
    );
});

test('terrain replacements reuse immutable per-tile facade preprocessing', () => {
    const enqueue = SRC.slice(
        SRC.indexOf('function enqueueTileFeatures'),
        SRC.indexOf('// ─── Cab-mode layer'),
    );
    const terrainDrain = SRC.slice(
        SRC.indexOf('function drainTerrainBuildingRebuild'),
        SRC.indexOf('function drainRegionalBuildingRebuild'),
    );
    assert.match(enqueue, /preparationCache\?\.preparedBuildingInput/);
    assert.match(enqueue, /preparationCache\.preparedBuildingInput = prepared/);
    assert.match(enqueue, /createBuildingBuildContext[\s\S]*contextTemplate/);
    assert.match(
        terrainDrain,
        /enqueueTileFeatures\([\s\S]*current\.streetFacingFeatures[\s\S]*null,[\s\S]*current,/,
        'a terrain replacement must carry the fetched tile cache into its new generation',
    );
});

test('replacement aggregates stage off-screen and swap before old direct meshes disappear', () => {
    const capture = SRC.slice(
        SRC.indexOf('function captureBuildingMeshesForBatching'),
        SRC.indexOf('// Buckets released for assembly'),
    );
    const publish = SRC.slice(
        SRC.indexOf('function publishTileVisualReplacementAggregates'),
        SRC.indexOf('function finishTileVisualReplacement'),
    );
    const finalization = SRC.slice(
        SRC.indexOf('function createBuildingTileFinalizationWorkItem'),
        SRC.indexOf('// Late-bound mask sweep'),
    );

    assert.match(capture, /replacement\.stagedAggregateParts\.push\(record\)/);
    assert.match(publish, /dropOvertureTileState\(key, \{ deferAssembly: true \}\)/);
    assert.match(publish, /publishBuildingAggregatePart\(record\)/);
    assert.ok(
        finalization.indexOf('publishTileVisualReplacementAggregates(tileKey)')
            < finalization.indexOf('queueTileAggregates(tileKey)'),
        'the batcher must receive every staged part before its dirty buckets are queued',
    );
    assert.match(
        finalization,
        /aggregateGate\.await\(tileKey, awaitedBuckets, \(\) => \{\s*const replacement = finishTileVisualReplacement\(tileKey\);\s*publishDetailedTile\([\s\S]*?noteInitialNearTileReady\(tileKey\);/,
        'old direct meshes must stay until the last replacement aggregate has uploaded',
    );
    const coverageGate = finalization.slice(
        finalization.indexOf("label: 'tile-coverage-gate'"),
        finalization.indexOf("label: 'tile-complete'"),
    );
    const tileComplete = finalization.slice(
        finalization.indexOf("label: 'tile-complete'"),
    );
    assert.match(coverageGate, /publishDetailedTile\([\s\S]*noteInitialNearTileReady\(tileKey\)/,
        'startup reveal must wait until observer-tile detail is actually published');
    assert.doesNotMatch(tileComplete, /noteInitialNearTileReady/,
        'queue finalization alone is not proof that detailed coverage is visible');
    for (const phase of [
        'tile-contact-ao',
        'tile-roof-drainage',
        'tile-replacement-parts',
        'tile-aggregate-queue',
        'tile-coverage-gate',
        'tile-complete',
    ]) {
        assert.match(finalization, new RegExp(`label: '${phase}'`));
    }
    const enqueue = SRC.slice(
        SRC.indexOf('function enqueueTileFeatures'),
        SRC.indexOf('// ─── Cab-mode layer'),
    );
    assert.match(enqueue, /createBuildingTileFinalizationWorkItem\(\{/);
    assert.doesNotMatch(
        enqueue.slice(enqueue.indexOf('onComplete: () => {')),
        /addContactAoBatch|addRoofDrainageBatch|queueTileAggregates/,
        'queue completion must not collapse all publication stages into one unbounded task',
    );
    const record = SRC.slice(
        SRC.indexOf('function recordTileBuilding'),
        SRC.indexOf('function registerBuildingEntrance'),
    );
    assert.doesNotMatch(record, /setDetailed\(/,
        'constructing one object must not hide its far prism before tile publication');
});

test('the formation wait is one clock per pending change, keyed on the published generation', () => {
    const helper = SRC.slice(SRC.indexOf('function formationWaitStartMs('), SRC.indexOf('function createBuildingFeatureWorkItem('));
    assert.match(helper, /const published = formation\?\.surfaceGeometrySourceRevision \?\? null;/);
    assert.match(helper, /if \(published !== formationWaitPublishedRevision \|\| formationWaitStartedAtMs === null\) \{\s*formationWaitPublishedRevision = published;\s*formationWaitStartedAtMs = performance\.now\(\);/,
        'a publication resets the clock; nothing else does');
    assert.equal((SRC.match(/formationWaitStartMs\(terrainReference\?\.roadFormation\)/g) || []).length, 4,
        'the staged skirt, the resumed skirt sample, the footprint path and the tile re-check share it');
});
