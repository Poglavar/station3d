// Locks the road-structure layer to cooperative rebuilds and batched repeated details.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { roadStructurePublicationKey } from '../core/road-replacement-publication.js';
import {
    BRIDGE_FENCE_HEIGHT_M,
    TUNNEL_ROOF_DEPTH_M,
    UNDERPASS_WALL_CROWN_MAX_GRADE,
    UNDERPASS_WALL_MAX_SEGMENT_M,
} from '../core/road-grade-separation-spec.js';

const source = readFileSync(
    new URL('../world/road-grade-separations.js', import.meta.url),
    'utf8',
);
const walkSource = readFileSync(
    new URL('../modes/cab.js', import.meta.url),
    'utf8',
);
const terrainSource = readFileSync(
    new URL('../world/terrain.js', import.meta.url),
    'utf8',
);
const curbSource = readFileSync(
    new URL('../world/curbs.js', import.meta.url),
    'utf8',
);
const roadsSource = readFileSync(
    new URL('../world/roads.js', import.meta.url),
    'utf8',
);
const laneMarkingsSource = readFileSync(
    new URL('../world/lane-markings.js', import.meta.url),
    'utf8',
);
const streetLampsSource = readFileSync(
    new URL('../world/streetlamps.js', import.meta.url),
    'utf8',
);
const railSource = readFileSync(
    new URL('../world/rails.js', import.meta.url),
    'utf8',
);

function extractFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`could not extract ${name}`);
}

function proofRoot(name) {
    const mesh = new THREE.Mesh();
    markSurfaceClaim(mesh, {
        surfaceClass: 'road-carriageway', coverageState: 'published',
        verticalRelation: 'same-level', verticalBand: 'ground', ownerId: name,
        replacementKey: `roads:structure:${name}`, generation: 1,
    });
    const root = new THREE.Group(); root.name = name; root.add(mesh); return root;
}

test('alignment clear is idempotent and rolls back through the real publication boundary', () => {
    const run = (surfacePublications, alignmentGroups, group = new THREE.Group()) => {
        const replace = new Function(
            'alignmentGroups', 'roadStructurePublicationKey', 'surfacePublications', 'group',
            'disposeGroup', 'annotateRoadStructureInspection',
            `${extractFunction('replaceAlignmentGroup')}; return replaceAlignmentGroup;`,
        )(alignmentGroups, roadStructurePublicationKey, surfacePublications, group, () => {}, () => {});
        return task => replace(task);
    };
    const clearAbsent = new Map();
    const registry = createSurfacePublicationRegistry();
    const apply = run(registry, clearAbsent);
    const absentOne = { id: 'missing', generation: 1, root: null };
    apply(absentOne);
    assert.equal(absentOne.committed, true);
    assert.equal(registry.snapshot().counters.failed, 0);
    const absentTwo = { id: 'missing', generation: 2, root: null };
    apply(absentTwo);
    assert.equal(absentTwo.committed, true);
    assert.equal(registry.snapshot().counters.failed, 0);

    const alignmentGroups = new Map();
    const active = proofRoot('live');
    const scene = new THREE.Group();
    const liveRegistry = createSurfacePublicationRegistry();
    liveRegistry.begin({ key: roadStructurePublicationKey('live'), generation: 1, parent: scene }).publish(active);
    alignmentGroups.set('live', active);
    run(liveRegistry, alignmentGroups)({ id: 'live', generation: 2, root: null });
    assert.equal(alignmentGroups.has('live'), false);
    assert.equal(scene.children.includes(active), false);
    assert.equal(liveRegistry.snapshot().counters.failed, 0);

    const old = proofRoot('rollback-old');
    const next = proofRoot('rollback-next');
    alignmentGroups.set('rollback', old);
    const failingRegistry = {
        begin(options) {
            const ticket = createSurfacePublicationRegistry().begin(options);
            return {
                get state() { return ticket.state; },
                clear(clearOptions) {
                    return ticket.clear({ ...clearOptions, commit: context => {
                        clearOptions.commit(context); throw new Error('injected later commit failure');
                    } });
                },
                publish: ticket.publish.bind(ticket),
            };
        },
    };
    assert.throws(() => run(failingRegistry, alignmentGroups)({ id: 'rollback', generation: 2, root: null }), /injected later commit failure/);
    assert.equal(alignmentGroups.get('rollback'), old);
    assert.equal(next.parent, null);
});

test('road structures stage replacements through the frame work queue', () => {
    assert.match(source, /label:\s*'roadStructures'/);
    assert.match(source, /buildQueue\.enqueue\(tasks/);
    assert.match(source, /maxItemsPerFrame:\s*1/);
    assert.match(source, /FRAME_CHUNK_REPEAT_ITEM/);
    assert.match(source, /alignmentModel\.getChangesSince\(builtRevision\)/);
    assert.match(source, /itemPriority:\s*alignmentTaskPriority/);
    assert.match(source, /formation\?\.hasPendingBuild\?\.\(\) === true/);
    assert.match(source, /stepPendingBuildPreparation\?\.\(\)/);
    assert.match(source, /pendingBuildPreparationPhase\?\.\(\)/);
    assert.match(source, /stageDetail \? `\$\{label\}:\$\{stageDetail\}` : label/);
    assert.match(source, /function replaceAlignmentGroup\(task\)/);
    assert.doesNotMatch(source, /function replaceGroup\(nextGroup, revision\)/);
    assert.doesNotMatch(source, /onFrame\(\)\s*\{[^}]*\brebuild\(\)/s);
});

test('bridge safety fences and supports use instancing instead of one mesh per segment', () => {
    assert.match(source, /new THREE\.InstancedMesh\(geometry, material, boxes\.length\)/);
    assert.equal(BRIDGE_FENCE_HEIGHT_M, 2);
    assert.match(source, /'RoadOverpassFenceRails'/);
    assert.match(source, /'RoadOverpassFencePosts'/);
    assert.match(source, /rails\.userData\.walkColliderBoxes = colliderBoxes/);
    assert.match(source, /posts\.userData\.walkColliderBoxes = \[\]/);
    assert.doesNotMatch(source, /RoadOverpassParapets|PARAPET_/);
    assert.match(source, /addBoxInstances\(root, boxes, material, 'RoadOverpassSupports'\)/);
    assert.match(source, /pointAtPlacedSupport\(\s*row,/);
    assert.match(source, /roadStructureSupportClearanceAtLocal\(/);
    assert.match(source, /alignment\.profileYAtS\?\.\(row\.s\)/);
    assert.doesNotMatch(source, /Array\.from\(alignment\.memberOsmIds\)\[0\]/);
});

test('rail viaducts retain Zagreb steel detailing and evacuation parapets', () => {
    assert.match(railSource, /appendSteelBridgeDetailMatrices\(/);
    assert.match(railSource, /addSteelBridgeDetailInstances\(/);
    assert.match(railSource, /addViaductParapetMeshes\(/);
    assert.match(railSource, /viaductDeckHalfWidthM\(/);
    assert.match(
        railSource,
        /addViaductPierInstances\(target, shaftMatrices, capMatrices, pierMaterial\)/,
    );
    assert.doesNotMatch(
        railSource,
        /addViaductPierInstances\(target, shaftMatrices, capMatrices, concrete\)/,
    );
});

test('road bridge deck and fence envelopes include only structural tram corridors', () => {
    assert.match(source, /createStructuralTramCorridorEnvelopeIndex\(/);
    assert.match(
        source,
        /alignment\.kind === 'overpass'[\s\S]{0,180}formationOffsetsAtLocal\(/,
    );
    assert.match(
        source,
        /const aOffsetM = side > 0 \? a\.formationLeftM : -a\.formationRightM/,
        'the existing batched fence builder must consume the expanded formation edge',
    );
    assert.doesNotMatch(
        source,
        /RoadOverpassTramFence|RoadOverpassTramDeck/,
        'tram integration must not add a parallel bridge renderer',
    );
});

test('surface-only paths reuse alignment height without duplicating civil structures', () => {
    assert.match(
        source,
        /rows\.length >= 2 && alignment\.definition\.renderStructure !== false/,
    );
});

test('bridge paths profile and batch their paint instead of adding one draw call per chord', () => {
    assert.match(roadsSource, /const ROAD_VERTICAL_BIKE_MAX_SEGMENT_M = 8;/);
    assert.match(roadsSource, /maxSegmentM:\s*batch\.osmIds\.size === 0/);
    assert.match(
        roadsSource,
        /createBikeLaneGeometryTask\(\s*batchQuads,\s*Array\.from\(batch\.osmIds\),\s*surfaceY,/,
    );
    assert.match(roadsSource, /const batchesByKey = new Map\(\)/);
    assert.match(roadsSource, /getProfileOwnerForOsmId\(osmId\)/);
    assert.match(roadsSource, /terrainDraped: batch\.terrainDraped/);
    const paintMaterialSource = roadsSource.slice(
        roadsSource.indexOf('function getBikePaintMaterial('),
        roadsSource.indexOf('function getRoadMaterial('),
    );
    assert.match(paintMaterialSource, /depthTest:\s*true/);
    assert.match(paintMaterialSource, /depthWrite:\s*false/);
    assert.match(roadsSource, /bikePaintSceneY\(/);
});

test('ordinary overpass approaches receive one batched earthwork mesh', () => {
    assert.match(
        source,
        /if \(!alignment\.definition\.replaceRoadSurface\)[\s\S]*buildEarthwork\(rows,\s*\{\s*closeEnds:\s*false\s*\}\)[\s\S]*`RoadOverpassApproachEarthwork:\$\{alignment\.id\}`/,
    );
    assert.doesNotMatch(
        source,
        /RoadOverpassApproachEarthwork:[\s\S]*addBoxInstances/,
        'approach fill remains one surface mesh rather than per-segment boxes',
    );
});

test('civil concrete uses worn mapped texture on custom and instanced geometry', () => {
    assert.match(source, /createConcreteRaster\(256,/);
    assert.match(source, /map:\s*concreteSurface\.map/);
    assert.match(source, /bumpMap:\s*concreteSurface\.bumpMap/);
    assert.match(source, /function applyCivilConcreteUvs\(geometry\)/);
    assert.match(source, /material === materials\?\.concrete/);
});

test('curb filtering subdivides only near grade-separated owners', () => {
    const endCapFilterSource = curbSource.slice(
        curbSource.indexOf('const featureRingFilters'),
        curbSource.indexOf('const polygons =', curbSource.indexOf('const featureRingFilters')),
    );
    assert.match(
        curbSource,
        /const featureRingFilters = !verticalAlignmentModel\s*\?\s*railAwareRoadRingFilters/,
    );
    assert.match(
        curbSource,
        /const verticalAlignmentModel = ground\.verticalAlignments\?\.getAlignments\(\)\.length[\s\S]{0,120}\? ground\.verticalAlignments : null/,
        'curb filtering reads the already captured alignments without compiling a live model',
    );
    assert.match(endCapFilterSource, /railAwareRoadRingFilters\.nearFilter\(a, b\)/);
    assert.match(curbSource, /const edgeMayTouchRailCut = currentRailCutEdgeEvaluator\(ground\.railFormation\)/,
        'ordinary edges stay on the fast path unless the spatial rail-cut gate includes them');
    assert.match(curbSource, /createBufferedRoadJoinArtifactEvaluator\(osmIds, ROAD_JOIN_CAP_RADIUS_M\)/);
    assert.match(endCapFilterSource, /isBufferedRoadJoinArtifact\(/);
    assert.match(curbSource, /const mixedVerticalUnion/);
    assert.match(curbSource, /curbUnionNeedsSeparatedOwnerChecks\(\{/);
    assert.match(curbSource, /function createSeparatedOwnerEdgeEvaluator\(/);
    assert.match(endCapFilterSource, /edgeMightTouchSeparatedOwners\(a, b\)/);
    assert.match(endCapFilterSource, /hasSeparatedOwnersAt\(mx, mz\)/);
    assert.doesNotMatch(endCapFilterSource, /nearFilter:\s*\(\)\s*=>\s*true/);
});

test('a curb union yields between polygons, ring filtering slices, and emitted runs', () => {
    assert.match(curbSource, /function createRoadFeatureGeometryTask\(context, feature\)/);
    assert.match(
        curbSource,
        /roadFeatureTask = createRoadFeatureGeometryTask\([\s\S]{0,500}return 'more';/,
        'feature setup must yield before the first polygon is built',
    );
    assert.match(curbSource, /const rings = polygons\[polygonIndex\]/);
    assert.match(curbSource, /function createRingRunsTask\(points,/);
    assert.match(curbSource, /CURB_FILTER_WORK_UNITS_PER_STEP = 1/);
    assert.match(curbSource, /const ringStatus = ringTask\.step\(\)/);
    assert.match(curbSource, /appendRunGeometry\(\s*run,\s*curb,\s*ramp,\s*greenRamp/);
    assert.match(
        curbSource,
        /polygonIndex \+= 1;[\s\S]{0,120}polygonIndex < polygons\.length\) return 'more'/,
    );
    assert.doesNotMatch(curbSource, /appendRoadFeatureGeometry\(context, features\[featureIndex\]\)/);
});

test('road queue diagnostics name the feature and cooperative stage', () => {
    assert.match(roadsSource, /phaseLabel:\s*\(\)\s*=>/);
    assert.match(roadsSource, /`road \$\{osmId\} setup`/);
    assert.match(roadsSource, /describeItem:\s*\(feature, featureIndex\)\s*=>/);
    assert.match(roadsSource, /function createRoadRingTask\(ctx, ringIndex, isCurrent =/);
    assert.match(roadsSource, /ROAD_STAGED_RING_MIN_POINTS = 32/);
    assert.match(roadsSource, /const surfaceStatus = surfaceTask\.step\(\)/);
    assert.match(roadsSource, /appendRoadRingSurface\(\s*ctx,\s*surfaceTask\.geometry\(\)/);
    assert.match(roadsSource, /appendRoadRingCollar\(ctx, ringIndex\)/);
    assert.match(roadsSource, /appendRoadRingWall\(ctx, ringIndex\)/);
    assert.match(
        roadsSource,
        /hasPendingBuild\?\.\(\) === true[\s\S]{0,240}stepPendingBuildPreparation\(\) === 'more'[\s\S]{0,80}FRAME_CHUNK_REPEAT_ITEM/,
        'road features must cooperatively prepare a dirty formation before demanding it',
    );
    assert.match(roadsSource, /pendingBuildPreparationPhase\?\.\(\)/);
});

test('aligned road surfaces refine only to their authored profile resolution', () => {
    assert.match(roadsSource, /VERTICAL_ALIGNMENT_SURFACE_MAX_EDGE_M = 8/);
    assert.match(roadsSource, /VERTICAL_ALIGNMENT_SURFACE_MAX_TRIANGLES = 2000/);
    assert.match(
        roadsSource,
        /refinementMaxEdgeM = followsVerticalAlignment[\s\S]{0,120}VERTICAL_ALIGNMENT_SURFACE_MAX_EDGE_M/,
    );
});

test('synthesized underpasses use one structural roadbed with a curbed mapped sidewalk', () => {
    assert.match(source, /RoadUnderpassSidewalk/);
    assert.match(source, /RoadUnderpassCurbs/);
    assert.match(source, /buildUnderpassSidewalkCurbs\(/);
    assert.match(source, /structureOnly = false, includeBandSegment = null/);
    assert.match(source, /roadStructureCompanionSidewalkBandsM\(/);
    assert.match(
        source,
        /function junctionGapAtStation\(alignment, side, stationM\)/,
        'junction mouths must break the companion sidewalk',
    );
    assert.match(
        source,
        /includeBandSegment: \(band, a, b\) => !junctionGapAtStation\(/,
        'the sidewalk curb must break over junction mouths too',
    );
    assert.match(
        source,
        /if \(alignment && junctionGapAtStation\([\s\S]{0,120}side === 1 \? 'left' : 'right',/,
        'approach walls and their terrain collar must break over junction mouths',
    );
    assert.match(
        source,
        /function structurePoint\([\s\S]*row\.point\(surfaceOffsetAt\(row, offsetM\), y\)/,
        'asymmetric tunnel surfaces must resolve their row-specific side offsets',
    );
    assert.match(
        source,
        /rows\.length >= 2\s*&& alignment\.definition\.renderStructure !== false[\s\S]*addReplacementRoad\(/,
        'surface-only path companions must not emit a second replacement roadbed',
    );
    assert.match(curbSource, /function rebuildVerticalAlignmentChangedTiles\(\)/);
    assert.match(
        curbSource,
        /roadVerticalAlignmentModel\.getChangesSince\(roadVerticalAlignmentRevision\)/,
    );
    assert.match(
        curbSource,
        /rebuildVerticalAlignmentChangedTiles\(\);\s*rebuildRailFormationChangedTiles\(\);\s*rebuildFormationChangedTiles\(\);/,
        'all three immutable civil dependencies refresh through bounded tile diffs',
    );
    assert.match(curbSource, /const hasReplacementAlignment = verticalOsmIds\?\.some/);
    assert.match(
        curbSource,
        /hasReplacementAlignment && replacementCorridorTouchesEdge\([\s\S]*verticalAlignmentModel,[\s\S]*a,[\s\S]*b,[\s\S]*18/,
    );
    assert.match(
        curbSource,
        /osmIds\.every\(osmId => \([\s\S]*replacesRoadSurfaceForOsmId\(osmId\)/,
    );
    assert.match(laneMarkingsSource, /laneCountOverrideForOsmId\(props\.osm_id\)/);
});

test('split lower-road profiles render an open cut without a duplicate tunnel roof', () => {
    assert.match(
        source,
        /const openCut = alignment\.definition\.structureMode === 'open-cut';/,
    );
    assert.match(
        source,
        /if \(!openCut\) \{[\s\S]*buildTunnelBox\([\s\S]*addTunnelPortal\(/,
    );
    assert.match(
        source,
        /createUnderpassApproachWallBuilder\([\s\S]*RoadUnderpassApproachWalls/,
    );
});

test('underpass walls reject leaked surface shadows and use a structural roof slab', () => {
    assert.equal(TUNNEL_ROOF_DEPTH_M, 0.7);
    assert.match(source, /aLeftRoofTop/);
    assert.match(source, /const firstSegment = segments\[0\];/);
    assert.match(source, /if \(index === firstSegment\)/);
    assert.match(source, /if \(index === lastSegment\)/);
    assert.match(
        source,
        /`RoadUnderpassBox:\$\{alignment\.id\}`,[\s\S]*receiveShadow:\s*false/,
    );
    assert.match(source, /header\.receiveShadow = false;/);
    assert.match(source, /function createUnderpassApproachWallBuilder\(\s*rows,/);
    assert.match(source, /`RoadUnderpassApproachWalls:\$\{alignment\.id\}`/);
    assert.equal(UNDERPASS_WALL_MAX_SEGMENT_M, 2);
    assert.match(source, /const UNDERPASS_WALL_SECTIONS_PER_STEP = 12;/);
    assert.equal(UNDERPASS_WALL_CROWN_MAX_GRADE, 0.12);
    assert.match(source, /smoothUnderpassWallCrown\(run\)/);
    const containmentApron = Number(source.match(
        /const UNDERPASS_TERRAIN_CONTAINMENT_APRON_M = ([0-9.]+);/,
    )?.[1]);
    assert.ok(
        containmentApron > (3200 / 3072) * Math.SQRT2,
        'the terrain-textured seal must contain a full road-mask pixel diagonal',
    );
    assert.match(source, /`RoadUnderpassTerrainCollar:\$\{alignment\.id\}`/);
    assert.match(source, /getActiveTerrainSurface\(\)/);
    assert.match(source, /terrainCollarOuter/);
    assert.match(
        source,
        /formationHalfWidthM \+ UNDERPASS_FLOOR_WALL_OVERLAP_M/,
    );
    assert.match(
        source,
        /terrainSceneYAtLocal\?\.\(point\.x, point\.z\)/,
    );
    assert.match(source, /const aLeftInner = a\.formationLeftM;/);
    assert.match(source, /const aLeftOuter = aLeftInner \+ TUNNEL_WALL_M;/);
    assert.match(
        source,
        /roadStructureFormationOffsetsAtSampleM\(\s*alignment,\s*alignments,/,
        'each ramp wall row must follow the mapped companion sidewalk envelope',
    );
    const approachWallFunction = 'function createUnderpassApproachWallBuilder(';
    const approachWallSource = source.slice(
        source.indexOf(approachWallFunction),
        source.indexOf(
            'function buildCurbs(',
            source.indexOf(approachWallFunction),
        ),
    );
    assert.doesNotMatch(approachWallSource, /a\.structure !== b\.structure/);
    assert.doesNotMatch(approachWallSource, /\[0,\s*rows\.length - 1\]/);
    assert.match(approachWallSource, /UNDERPASS_WALL_SECTIONS_PER_STEP/);
    const retainingWallStart = roadsSource.indexOf(
        'const wall = new THREE.Mesh(wallGeometry, getRetainingWallMaterial(ctx))',
    );
    const retainingWallBlock = roadsSource.slice(retainingWallStart, retainingWallStart + 700);
    assert.match(retainingWallBlock, /wall\.receiveShadow = false;/);
    assert.match(roadsSource, /createRetainingWallGeometry\(retainingProfile, y, 'earth'\)/);
    assert.match(
        roadsSource,
        /earth\.name = `RoadFormationTerrainCollar:\$\{type\}`/,
        'earth faces must merge into the existing regional collar draw call',
    );
    assert.match(
        roadsSource,
        /buildWorldXZUvsForPositions\(\s*positions,\s*getActiveTerrainSurface\(\)\.uvPerM/,
        'earth faces must carry the collar bucket terrain-UV schema',
    );
    assert.match(
        curbSource,
        /roadFormationModel\?\.civilGroundSceneYAtLocal\?\.\([\s\S]{0,220}surfaceOffsetYAtProfile:\s*curbLandingSurfaceOffsetY,[\s\S]{0,80}allowStale:\s*true/,
        'curb landings must sample the published civil surface without compiling a dirty generation',
    );
    assert.match(roadsSource, /roadReplacementAtLocal:\s*\(x, z, osmId\)/);
    assert.match(
        terrainSource,
        /drawRing\(region\.clearRing \|\| \[\], region\.clearBounds, '#000'\)/,
    );
    assert.match(terrainSource, /region\.cutoutRing \|\| \[\]/);
});

test('street lamps sample the height of their owning road at grade separations', () => {
    assert.match(streetLampsSource, /out\.push\(\{ x: bx, z: bz, osmId \}\)/);
    assert.match(
        streetLampsSource,
        /sceneYAtLocal\(x, z, \{[\s\S]{0,100}osmId,[\s\S]{0,100}maxDistanceM:\s*15,[\s\S]{0,100}allowStale:\s*true/,
        'decorative lamp placement must not synchronously finish a dirty formation generation',
    );
    assert.match(streetLampsSource, /roadFurnitureBlockedByOverpass\(/);
    assert.match(streetLampsSource, /roadVerticalAlignmentModel\.structureAtLocal\(x, z\)/);
});

test('bridge ownership keeps terrain open and supplies reachable walk support', () => {
    const supportCallStart = source.indexOf(
        'buildBridgeSupportSurface(rows)',
        source.indexOf('function createAlignmentBuildTask'),
    );
    const supportCall = source.slice(
        supportCallStart,
        source.indexOf('addBridgeSafetyFences', supportCallStart),
    );
    assert.match(source, /bridgeSupport:\s*new THREE\.MeshBasicMaterial\(\{[\s\S]*visible:\s*false/);
    assert.match(supportCall, /buildMaterials\.bridgeSupport/);
    assert.match(supportCall, /`RoadOverpassSupportSurface:\$\{alignment\.id\}`/);
    assert.match(supportCall, /\{ walkable: true \}/);
    assert.doesNotMatch(supportCall, /buildMaterials\.sidewalk/);
    assert.doesNotMatch(source, /BRIDGE_WALKING_SURFACE_LIFT_M/);
    assert.match(source, /buildBridgeSidewalkSurface\([\s\S]*alignment,[\s\S]*alignments,[\s\S]*\)/);
    assert.match(source, /roadStructureSidewalkBandsM\(/);
    assert.match(source, /BRIDGE_SIDEWALK_JOIN_OVERLAP_M = 0\.6/);
    assert.match(source, /`RoadOverpassSidewalkSurface:\$\{alignment\.id\}`/);
    assert.match(
        terrainSource,
        /if \(profile\.terrainCutoutDisabled\)\s*{[\s\S]*?continue;/,
    );
    assert.match(walkSource, /const reachableStructuralRoadSupportY = reachableWalkSupportY/);
    assert.match(walkSource, /getRoadGradeSeparationsGroup\(\),/);
    const firstModelTouch = walkSource.indexOf(
        'const roadAlignments = state.cabState?.roadVerticalAlignments',
    );
    assert.ok(firstModelTouch >= 0, 'the walk ground query must read the alignment model');
    const firstPlannerTouch = walkSource.indexOf(
        'const insideSurfaceCutout = isPointInsidePlannerSurfaceCutout',
    );
    assert.ok(
        walkSource.indexOf('if (_walkGroundPositionCache.has(positionKey))') < firstPlannerTouch,
        'stationary cache hits must precede planner/rail ownership queries',
    );
    assert.ok(
        walkSource.indexOf('if (_walkGroundCache.has(key))') < firstModelTouch,
        'alignment lookup must stay behind the walk-ground cache',
    );
});

test('terrain cutout revisions batch bounded rings without a full-canvas intersection', () => {
    assert.match(terrainSource, /formationTerrainCutoutMaskRings\(profile\)/);
    assert.match(terrainSource, /formationTerrainCutoutMaskRegions\(profile\)/);
    assert.match(
        terrainSource,
        /region\.bounds \|\| ringBounds\(region\.ring\)/,
        'each exact bounded formation ring should be painted directly',
    );
    assert.match(
        terrainSource,
        /globalCompositeOperation\s*=\s*['"]lighter['"]/,
        'independent ownership and excavation channels must accumulate',
    );
    assert.match(
        terrainSource,
        /coverPavedClipBoundary[\s\S]*context\.stroke\(clipPath\)/,
        'dressed road cuts must close the filtered mask fringe over asphalt',
    );
    assert.match(
        terrainSource,
        /ROAD_MASK_PAVED_EDGE_OVERLAP_M\s*\*\s*2/,
        'the clipped half of the centered edge stroke must retain the full owned overlap',
    );
    assert.doesNotMatch(
        terrainSource,
        /globalCompositeOperation\s*=\s*['"]destination-in['"]/,
        'a 3072px destination-in coverage pass caused recurring 2–7 second terrain hooks',
    );
    assert.match(
        terrainSource,
        /roadMaskBuildTask\.step\(ROAD_MASK_BUILD_SLICE_MS\)/,
        'formation-mask raster work must remain resumable across frames',
    );
    assert.doesNotMatch(
        terrainSource,
        /fillRect\(0, 0, ROAD_MASK_SIZE_PX, ROAD_MASK_SIZE_PX\)/,
        'a fresh canvas is already RGB-black; do not synchronously fill all 9.4M pixels',
    );
    assert.match(
        terrainSource,
        /texture\.premultiplyAlpha\s*=\s*true/,
        'transparent-black initialization must preserve antialiased RGB edge coverage',
    );
});
