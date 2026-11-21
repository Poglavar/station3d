// Locks the metadata handoff between the yielded setup and ring-build stages.
// The road module is browser-bound, so this contract is checked without loading WebGL.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');

function functionBody(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} not found in world/roads.js`);
    const argumentsStart = source.indexOf('(', start);
    let argumentsDepth = 0;
    let argumentsEnd = -1;
    for (let index = argumentsStart; index < source.length; index += 1) {
        if (source[index] === '(') argumentsDepth += 1;
        if (source[index] === ')') argumentsDepth -= 1;
        if (argumentsDepth === 0) {
            argumentsEnd = index;
            break;
        }
    }
    assert.notEqual(argumentsEnd, -1, `${name} has no closing argument list`);
    const bodyStart = source.indexOf('{', argumentsEnd);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(bodyStart + 1, index);
    }
    assert.fail(`${name} has no closing brace`);
}

test('road metadata survives the yielded setup-to-ring handoff', () => {
    const setup = functionBody('prepareRoadFeature');
    const ring = functionBody('appendRoadRingSurface');

    assert.match(setup, /const entityMetadata = roadEntityMetadata\(feature\);/);
    assert.match(
        setup,
        /return\s*{[\s\S]*\bentityMetadata\b[\s\S]*};/,
        'prepareRoadFeature must put entityMetadata on the cross-frame context',
    );
    assert.match(
        ring,
        /const\s*{[\s\S]*\bentityMetadata\b[\s\S]*}\s*=\s*ctx;/,
        'appendRoadRingSurface must read entityMetadata from the cross-frame context',
    );
});

test('vertical-alignment delivery queues only affected road tiles', () => {
    const boundedRebuild = functionBody('enqueueRoadTilesForAlignmentChange');

    assert.match(boundedRebuild, /roadTileMatchesAlignmentChange/);
    assert.match(boundedRebuild, /enqueueTileRoads\(tileKey,\s*features/);
    assert.doesNotMatch(boundedRebuild, /rebuildLoadedTiles/);
    assert.match(source, /const change = roadVerticalAlignmentModel\.setAlignmentTile/);
    assert.match(source, /return enqueueRoadTilesForAlignmentChange\(change\)/);
});

test('alignment revisions transactionally replace already-published member surfaces', () => {
    const boundedRebuild = functionBody('enqueueRoadTilesForAlignmentChange');
    const enqueue = functionBody('enqueueTileRoads');
    const publish = functionBody('publishStagedTileBuild');

    assert.match(boundedRebuild, /const forceRebuildOsmIds = new Set/);
    assert.match(
        boundedRebuild,
        /enqueueTileRoads\(tileKey,\s*features,\s*{[\s\S]*forceRebuildOsmIds/,
    );
    assert.match(enqueue, /entry && !forceRebuild/);
    assert.match(enqueue, /replacementFeatureKeys\.add\(featureKey\)/);
    assert.match(
        publish,
        /entry && \(build\.replacementFeatureKeys\.has\(featureKey\)/,
    );
    assert.match(publish, /const tileRefs = new Set\(entry\.tileRefs\)/);
    assert.match(publish, /disposePublishedRoadEntry\(entry\)/);
});

test('buffered bridge surfaces also deliver non-motor alignment ownership', () => {
    const aggregateRebuild = functionBody('rebuildSurfaceVerticalAlignments');
    const refresh = functionBody('flushSurfaceAlignmentRefreshBatch');

    assert.match(
        aggregateRebuild,
        /roadVerticalCenterlinesFromSurfaceFeatures\([\s\S]*loadedSurfaceFeaturesForVerticalAlignments\(\)/,
        'vertical alignments must be synthesized from the complete loaded surface set',
    );
    assert.match(aggregateRebuild, /SURFACE_ALIGNMENT_SET_KEY/);
    assert.match(
        source,
        /tileFeatures\.set\(tileKey,\s*safeFeatures\);[\s\S]*registration\.alignmentBuild\s*=\s*scheduleChangedRoadSources/,
    );
    assert.match(refresh, /const alignmentChange = rebuildSurfaceVerticalAlignments\(\)/);
    assert.match(
        source,
        /roadVerticalAlignmentModel\?\.roadYAtLocal\([\s\S]*point\.x,[\s\S]*point\.z,[\s\S]*osmId/,
    );
    assert.match(
        source,
        /let refinementMaxEdgeM = followsVerticalAlignment[\s\S]*VERTICAL_ALIGNMENT_SURFACE_MAX_EDGE_M[\s\S]*ENGINEERED_SURFACE_MAX_EDGE_M[\s\S]*DRAPED_SURFACE_MAX_EDGE_M/,
        'aligned roads must use their own bounded surface resolution',
    );
    assert.match(
        source,
        /refinementMaxEdgeM = drapeEdgeMForTriangulation\([\s\S]*sampleStepMAtLocal/,
        'ordinary draped roads must match the rendered terrain resolution',
    );
    assert.match(
        source,
        /const refinementMaxTriangles = followsVerticalAlignment[\s\S]*VERTICAL_ALIGNMENT_SURFACE_MAX_TRIANGLES[\s\S]*ENGINEERED_SURFACE_MAX_TRIANGLES[\s\S]*DRAPED_SURFACE_MAX_TRIANGLES/,
        'aligned roads must use their own bounded triangle budget',
    );
    assert.match(
        source,
        /railFormationProvider\s*=\s*\(\)\s*=>\s*ctx\.railFormation\s*\|\|\s*null/,
        'roads must read the rail model after the later rail layer publishes it',
    );
    assert.match(
        aggregateRebuild,
        /railElevationAslMAtCoordinate:[\s\S]*sampleRailFormationElevationAslMAtCoordinate\([\s\S]*railFormationProvider\?\.\(\)/,
        'surface alignment compilation must sample the canonical rail profile',
    );
});

test('road and bike surfaces preserve an absent alignment sample as fallback', () => {
    const roadGeometry = functionBody('createTerrainConformingRoadGeometryTask');
    const bikeGeometry = functionBody('createBikeLaneGeometryTask');

    for (const body of [roadGeometry, bikeGeometry]) {
        assert.match(
            body,
            /finiteOrNull\(roadVerticalAlignmentModel\?\./,
            'optional alignment samples must use the null-safe numeric guard',
        );
        assert.match(body, /const groundY = alignmentY != null/);
        assert.doesNotMatch(
            body,
            /Number\(roadVerticalAlignmentModel\?\./,
            'Number(null) would turn the end of a partial approach into scene height zero',
        );
    }
});

test('road terrain sampling consumes captured ground and advances in bounded runs', () => {
    const roadGeometry = functionBody('createTerrainConformingRoadGeometryTask');

    assert.match(source, /const ROAD_TERRAIN_SAMPLE_POINTS_PER_STEP = 32/);
    assert.match(roadGeometry, /const \{ terrain: terrainReference, roadFormation: roadFormationModel,[\s\S]*\} = ground;/,
        'geometry must consume the explicit captured ground context');
    assert.doesNotMatch(roadGeometry, /hasPendingBuild|stepPendingBuildPreparation/,
        'low-level geometry must not drain mutable formation state while sampling');
    assert.doesNotMatch(roadGeometry, /formationModel\.revision|formationRevision/,
        'geometry must use the captured generation rather than rereading mutable formation state');
    assert.match(
        roadGeometry,
        /sampleIndex \+ ROAD_TERRAIN_SAMPLE_POINTS_PER_STEP[\s\S]*while \(sampleIndex < end\)/,
        'one queue visit must sample only a bounded point run',
    );
});

test('loaded terrain NoData terminates an unpublished road instead of deferring forever', () => {
    const terrainGeometry = functionBody('createTerrainConformingRoadGeometryTask');
    const polygonGeometry = functionBody('createRoadPolygonGeometryTask');
    const featureTask = functionBody('createRoadFeatureTask');

    assert.match(
        terrainGeometry,
        /if \(!isPermanentTerrainGap\(ground, point\.x, point\.z\)\) \{[\s\S]*?if \(abortOnMissingTerrain\) \{[\s\S]*?code: 'road-surface-terrain-incomplete'[\s\S]*?return 'defer';\s*\}[\s\S]*omission = Object\.freeze\(\{ kind: 'excluded', reason: 'terrain-evidence',\s*x: point\.x, z: point\.z \}\);[\s\S]*phase = 'no-data';[\s\S]*return 'no-data'/,
        'permanence is judged at the failing sample by the shared rule, and the point is carried out',
    );
    assert.doesNotMatch(terrainGeometry, /terrainNoDataIsFinal/, 'no private copy of the gap rule');
    assert.match(polygonGeometry, /status === 'no-data'[\s\S]*omission = terrainTask\.omission\?\.\(\)[\s\S]*return 'no-data'/);
    assert.match(
        featureTask,
        /ringStatus === 'no-data'[\s\S]*omission = ringTask\.omission\?\.\(\)[\s\S]*disposeRoadFeatureGroup\(ctx\.featureGroup\)[\s\S]*return 'abort'/,
        'a partial detached feature is disposed and never published',
    );
    assert.doesNotMatch(featureTask, /featureBounds|isPermanentTerrainGap/,
        'the feature never re-judges permanence at its own centre: a pier way with data at the centre and NoData at one end held the port ground (16 Sep)');
});

test('loaded terrain NoData omits optional pedestrian edging without blocking its road', () => {
    const edging = functionBody('appendPedestrianEdging');
    assert.match(edging, /terminalTerrainNoData = true/);
    assert.match(
        edging,
        /isPermanentTerrainGap\(ctx\.ground, x, z\)[\s\S]*if \(edging === false\)[\s\S]*return terminalTerrainNoData/,
    );
});

test('ordinary pedestrian surfaces consume upstream civil ground instead of stale DTM', () => {
    const roadGeometry = functionBody('createTerrainConformingRoadGeometryTask');
    const prepare = functionBody('prepareRoadFeature');

    assert.match(
        roadGeometry,
        /useComposedCivilGround[\s\S]*inputEvidenceSceneYAtLocal\([\s\S]*CIVIL_GROUND_AUTHORITY\.PATH/,
        'paths must follow rail and road civil work that replaced source terrain',
    );
    assert.match(
        prepare,
        /const usesComposedCivilGround = \(type === 'pedestrian'[\s\S]*SIDEWALK_LEVEL_TYPES\.has\(type\)[\s\S]*!engineered[\s\S]*!followsVerticalAlignment/,
        'only ordinary same-level pedestrian surfaces use composed ground',
    );
});

test('same-level concrete paths seal their exact mesh boundary to adjacent ground', () => {
    const prepare = functionBody('prepareRoadFeature');
    const seam = functionBody('appendRoadRingTerrainSeam');
    const seamClaim = functionBody('sidewalkTerrainSeamClaim');
    const ringTask = functionBody('createRoadRingTask');

    assert.match(
        prepare,
        /const hasTerrainSeam = SIDEWALK_LEVEL_TYPES\.has\(type\)[\s\S]*!engineered[\s\S]*!followsVerticalAlignment[\s\S]*!roadVerticalAlignmentFromProperties/,
        'only ordinary ground-level path surfaces receive the terrain seam',
    );
    assert.match(seam, /surfaceGeometry\?\.getAttribute\?\.\('position'\)\?\.array/);
    assert.match(seam, /buildRoadsideSurfaceTerrainSeamGeometryData\(\{/);
    assert.match(
        seamClaim,
        /surfaceClass: SURFACE_CLASS\.ROAD_EARTHWORK/,
        'the landing collar must retain the adjacent terrain/landuse material contract',
    );
    assert.match(
        seam,
        /inputEvidenceSceneYAtLocal\?\.\([\s\S]*CIVIL_GROUND_AUTHORITY\.PATH/,
        'the landing row must meet the same composed ground authority the path consumes',
    );
    assert.match(
        seam,
        /segmentKeep:[\s\S]*publishedSurfaceAtLocal/,
        'the terrain collar must yield on the carriageway side',
    );
    assert.match(ringTask, /!ctx\.hasTerrainSeam[\s\S]*ROAD_STAGED_RING_MIN_POINTS/);
    assert.match(ringTask, /\? 'terrain-seam'/);
    assert.match(ringTask, /appendRoadRingTerrainSeam\(ctx, surfaceMesh\?\.geometry\)/);
});

test('bike paint rebuilds cooperatively by canonical profile owner and tile region', () => {
    const rebuild = functionBody('createCenteredBikePaintBuildTask');
    const batchBuild = functionBody('createCenteredBikePaintBatchTask');
    const geometry = functionBody('createBikeLaneGeometryTask');

    assert.match(rebuild, /const batchesByKey = new Map\(\)/);
    assert.match(rebuild, /getProfileOwnerForOsmId\(osmId\)/);
    assert.match(rebuild, /batch\.osmIds\.add\(osmId\)/);
    assert.match(
        batchBuild,
        /createBikeLaneGeometryTask\(\s*batchQuads,\s*Array\.from\(batch\.osmIds\),\s*surfaceY,/,
    );
    assert.match(geometry, /roadYForOsmIdsAtLocal\(/);
    assert.match(geometry, /terrainDraped && terrainReference/);
    assert.match(rebuild, /`ordinary:\$\{selected\?\.tileKey \|\| tileKey\}:\$\{terrainDraped \? 'terrain' : 'formation'\}`/);
    assert.match(rebuild, /if \(phase === 'collect'\)/);
    assert.match(rebuild, /if \(phase === 'geometry'\)/);
    assert.match(rebuild, /if \(phase === 'publish'\)/);
    assert.match(
        batchBuild,
        /if \(status === 'more' \|\| status === 'defer'\) return status/,
        'missing terrain defers the batch without publishing partial paint',
    );
    assert.match(source, /const BIKE_LANE_GEOMETRY_QUADS_PER_STEP = 8/);
    assert.match(geometry, /quadIndex \+ BIKE_LANE_GEOMETRY_QUADS_PER_STEP/);
    assert.match(geometry, /const \{ terrain: terrainReference, roadFormation: roadFormationModel,[\s\S]*\} = ground;/,
        'bike geometry must consume the explicit captured ground context');
    assert.doesNotMatch(geometry, /hasPendingBuild|stepPendingBuildPreparation/,
        'bike geometry must not drain mutable formation state while sampling');
    assert.match(source, /label:\s*'bike-paint'/);
    assert.match(source, /if \(item\.step\(\) === 'more'\) return FRAME_CHUNK_REPEAT_ITEM/);
    assert.doesNotMatch(rebuild, /alignedSegmentsByOsmId/);
});

test('surface alignment aggregation deduplicates members and rebuilds after eviction', () => {
    const loadedFeatures = functionBody('loadedSurfaceFeaturesForVerticalAlignments');
    const remove = functionBody('removeTile');
    const refresh = functionBody('flushSurfaceAlignmentRefreshBatch');

    assert.match(loadedFeatures, /return surfaceAlignmentInputs\.getFeatures\(\)/);
    assert.match(functionBody('enqueueRoadTileRegistration'),
        /surfaceAlignmentInputs\.setTileEntries\(tileKey, result\.alignmentEntries\)/);
    assert.match(remove, /tileFeatures\.delete\(tileKey\)/);
    assert.match(remove, /surfaceAlignmentInputs\.removeTile\(tileKey\)/);
    assert.match(
        source,
        /onEvict:[\s\S]*Promise\.all\(\[removeTile\(tileKey\), scheduleSurfaceAlignmentRefresh\(\)\]\)/,
        'evicted members must be absent before a new aggregate generation is scheduled',
    );
    assert.match(refresh, /rebuildSurfaceVerticalAlignments\(\)/);
    assert.equal([...source.matchAll(/tileFeatures = new Map\(\);\s*surfaceAlignmentInputs\.clear\(\);/g)].length,
        2, 'both session start and teardown must reset the cached committed surface inputs');
});

test('same-turn surface arrivals share one alignment generation with per-tile waiters', () => {
    const schedule = functionBody('scheduleSurfaceAlignmentRefresh');
    const refresh = functionBody('flushSurfaceAlignmentRefreshBatch');
    const resolve = functionBody('resolveSurfaceAlignmentBatchWaiters');

    assert.match(schedule, /surfaceAlignmentRefreshBatch/);
    assert.match(schedule, /setTimeout\(/);
    assert.match(schedule, /batch\.tileKeys\.add\(key\)/);
    assert.match(refresh, /for \(const tileKey of batch\.tileKeys\)/);
    assert.match(resolve, /const tileBuild = buildByTile\.get\(tileKey\)/);
    assert.match(resolve, /Promise\.all\(\[tileBuild, \.\.\.sharedDependencies\]\)/);
    assert.match(resolve, /build\.then\(resolve,\s*reject\)/);
});

test('terrain revisions replace already-published road geometry for affected ways', () => {
    const terrainRefresh = functionBody('onTerrainReferenceChanged');
    const schedule = functionBody('scheduleSurfaceAlignmentRefresh');
    const flush = functionBody('flushSurfaceAlignmentRefreshBatch');

    assert.match(
        terrainRefresh,
        /const affectedOsmIds = roadFormationModel\?\.invalidateTerrain/,
        'terrain invalidation must retain the affected way ids returned by the formation model',
    );
    assert.match(
        terrainRefresh,
        /terrainRevisionRoadOsmIds\(features,[\s\S]*forceRebuildOsmIds\.add\(osmId\)/,
        'ordinary terrain-draped surfaces must join the engineered replacement set',
    );
    assert.match(terrainRefresh, /roadTileIntersectsGroundChange\(tileKey,\s*bounds\)/);
    assert.doesNotMatch(terrainRefresh, /rebuildLoadedTiles/);
    assert.match(
        terrainRefresh,
        /index === 0 \? forceRebuildOsmIds : null/,
        'the coalesced refresh batch should copy its completed replacement set only once',
    );
    assert.match(
        terrainRefresh,
        /scheduleSurfaceAlignmentRefresh\(tileKey,\s*{\s*forceRebuildOsmIds/,
        'affected ids must reach the deferred surface refresh batch',
    );
    assert.match(schedule, /batch\.forceRebuildOsmIds\.add\(String\(osmId\)\)/);
    assert.match(
        flush,
        /enqueueTileRoads\(tileKey,\s*features,\s*{\s*forceRebuildOsmIds/,
        'the refreshed tile must replace matching published meshes instead of deduplicating them',
    );
});

test('the buffered surface stream is the sole dynamic vertical-alignment owner', () => {
    assert.doesNotMatch(
        source,
        /roadVerticalAlignmentModel\s*\?\.\s*setCenterlineTile\(tileKey,\s*safeFeatures\)/,
        'the raw graph fragment must not race the synthesized surface alignment',
    );
    assert.doesNotMatch(
        source,
        /roadVerticalAlignmentModel\s*\?\.\s*removeCenterlineTile\(tileKey\)/,
        'the graph stream must not evict a surface-owned vertical alignment',
    );
});

test('resumable tile road builds bound active-view stages and catch up once settled', () => {
    const enqueue = functionBody('enqueueTileRoads');

    assert.match(enqueue, /maxItemsPerFrame:\s*20/);
    assert.match(enqueue, /maxItemsPerSettledFrame:\s*Infinity/);
    assert.match(enqueue, /scaleMaxItemsWithFrameTime:\s*true/);
});
