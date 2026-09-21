// Renders civil structures for every resolved road vertical alignment:
// bridge decks and supports above grade, tunnel boxes below grade, plus any
// authored replacement cross-section that owns its full road surface.

import * as THREE from 'three';
import {
    camera,
    getSidewalkTexture,
    renderer,
    scene,
    SIDEWALK_UV_PER_M,
} from '../scene/setup.js';
import {
    disposeGroup,
    registerShared,
    unregisterShared,
} from '../core/dispose.js';
import { createConcreteRaster } from '../core/concrete-texture.js';
import {
    createFrameChunkQueue,
    FRAME_CHUNK_DEFER_ITEM,
    FRAME_CHUNK_REPEAT_ITEM,
} from '../core/frame-chunk-queue.js';
import { noteWorldQueueActive, noteWorldQueueIdle } from '../core/world-ready.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import {
    pointAtPlacedSupport,
    resolveIntelligentPillarSamples,
} from '../core/intelligent-pillar-placement.js';
import { getGrassTexture, GRASS_UV_PER_M } from './decor.js';
import { ASPHALT_UV_PER_M, getAsphaltTexture } from './roads.js';
import {
    applyAuthoredSurfaceOpeningCutout,
    applyPlannerSurfaceCutout,
    createPlannerGeometryMaterialCache,
} from './planner-surface-cutout.js';
import { applyGroundOwnership } from './terrain.js';
import { applySurfaceStencil } from './surface-material-authority.js';
import { applyStreetLampSurfaceLighting } from './streetlamp-lighting.js';
import { getActiveTerrainSurface } from './terrain-surface.js';
import { applyUrbanGroundSurface } from './urban-ground-surface.js';
import {
    isCoveredStructureSample,
    roadReplacementFormationBlend,
    roadStructureCompanionSidewalkBandsM,
    roadStructureSupportClearanceAtLocal,
    roadStructureFormationOffsetsAtSampleM,
    roadStructureFormationOffsetsM,
    roadStructureSidewalkBandsM,
} from '../core/road-vertical-alignment.js';
import {
    BRIDGE_DECK_DEPTH_M,
    BRIDGE_FENCE_HEIGHT_M,
    PIER_SPACING_M,
    TUNNEL_CLEAR_HEIGHT_M,
    TUNNEL_ROOF_DEPTH_M,
    TUNNEL_WALL_M,
    UNDERPASS_WALL_CROWN_MAX_GRADE,
    UNDERPASS_WALL_MAX_SEGMENT_M,
} from '../core/road-grade-separation-spec.js';
import {
    createStructuralTramCorridorEnvelopeIndex,
} from '../core/structural-tram-corridor.js';
import { getSingleTrackBedHalfWidthMeters } from './tram-trackbed-dimensions.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    reviseSurfaceClaim,
} from '../core/surface-hierarchy.js';
import { finiteOrNull } from '../core/math.js';
import { roadStructureHalfWidths as alignmentHalfWidths, roadStructureSampleFrame } from '../core/road-structure-cross-section.js';
import { noteRoadStructureCompiledSource, roadStructureMatchesAlignment, roadStructurePublicationKey } from '../core/road-replacement-publication.js';
import { retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { clipReceiverMeshOpeningsSteps } from '../core/receiver-mesh-openings.js';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { composeReceiverSupportReadsSteps, EMPTY_RECEIVER_SUPPORT_READ } from '../core/receiver-support-read.js';

const EMBANKMENT_SLOPE_RUN_PER_RISE = 1.65;
const BRIDGE_SIDEWALK_SURFACE_LIFT_M = 0.035;
const BRIDGE_SIDEWALK_JOIN_OVERLAP_M = 0.6;
const BRIDGE_FENCE_POST_SPACING_M = 1.5;
const BRIDGE_FENCE_POST_WIDTH_M = 0.08;
const BRIDGE_FENCE_RAIL_WIDTH_M = 0.06;
const BRIDGE_FENCE_RAIL_HEIGHT_M = 0.06;
const BRIDGE_FENCE_RAIL_LEVELS_M = [0.22, 0.82, 1.42, 1.97];
// A visibly structural slab. Synthesized maxheight profiles reserve this depth
// below the crossing formation instead of drawing a zero-thickness roof plane.
const UNDERPASS_ROAD_JOIN_OVERLAP_M = 0.6;
const UNDERPASS_FLOOR_WALL_OVERLAP_M = 0.08;
const UNDERPASS_ROAD_SURFACE_LIFT_M = 0.032;
const UNDERPASS_SIDEWALK_SURFACE_LIFT_M = 0.12;
const UNDERPASS_SIDEWALK_CURB_WIDTH_M = 0.25;
const UNDERPASS_WALL_BASE_OVERLAP_M = 0.25;
const UNDERPASS_WALL_TERRAIN_OVERLAP_M = 0.18;
const UNDERPASS_WALL_SECTIONS_PER_STEP = 12;
// terrain.js rasterizes a 3,200 m window into 3,072 pixels (~1.04 m/texel).
// The terrain-owned collar must extend past a full pixel diagonal so bilinear
// filtering and raster coverage can reveal only matching terrain texture,
// never the empty world below the cut at a ramp mouth or retaining-wall crown.
const UNDERPASS_TERRAIN_CONTAINMENT_APRON_M = 1.6;
const ROAD_CONCRETE_UV_PER_M = 0.25;

let group = null;
let alignmentModel = null;
let roadFormationModel = null;
let structuralTramCorridorEnvelope = null;
let builtRevision = -1;
let requestedRevision = -1;
let buildJob = null;
let buildGeneration = 0;
let materials = null;
const plannerGeometryMaterials = createPlannerGeometryMaterialCache();
let wornConcreteSurface = null;
const alignmentGroups = new Map();
let surfacePublications = null;
let buildFocusX = 0;
let buildFocusZ = 0;
let materialPrewarmState = null;
let groundGenerationLease = null;
let groundManaged = false;
let groundSupportRead = EMPTY_RECEIVER_SUPPORT_READ;
const structureReceiverReads = new WeakMap();
const buildQueue = createFrameChunkQueue({
    label: 'roadStructures',
    frameBudgetMs: 2,
    preferAnimationFrame: true,
    workClass: 'near',
    workTier: 'surface',
    trackWorldReady: false,
});

export function getRoadGradeSeparationsGroup() {
    return group;
}

function pushTriangle(vertices, a, b, c) {
    vertices.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}

function pushQuad(vertices, a, b, c, d) {
    pushTriangle(vertices, a, b, c);
    pushTriangle(vertices, a, c, d);
}

function geometryFromPositions(vertices) {
    if (vertices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(vertices), 3),
    );
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

function makeConcreteTexture(data, size, colorSpace = null) {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    if (colorSpace) texture.colorSpace = colorSpace;
    texture.needsUpdate = true;
    registerShared(texture);
    return texture;
}

function getWornConcreteSurface() {
    if (wornConcreteSurface) return wornConcreteSurface;
    const raster = createConcreteRaster(256, 0x7d12c4);
    wornConcreteSurface = {
        map: makeConcreteTexture(raster.color, raster.size, THREE.SRGBColorSpace),
        bumpMap: makeConcreteTexture(raster.height, raster.size),
    };
    return wornConcreteSurface;
}

// Civil meshes built from raw triangle positions have no UVs. Project each
// face onto its dominant plane so concrete grain stays metre-scaled on decks,
// walls and curbs instead of collapsing to one sampled grey texel.
function applyCivilConcreteUvs(geometry) {
    if (!geometry || geometry.getAttribute('uv')) return geometry;
    const positions = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!positions || index) return geometry;
    const uvs = new Float32Array(positions.count * 2);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const edge = new THREE.Vector3();
    for (let vertex = 0; vertex + 2 < positions.count; vertex += 3) {
        a.fromBufferAttribute(positions, vertex);
        b.fromBufferAttribute(positions, vertex + 1);
        c.fromBufferAttribute(positions, vertex + 2);
        normal.subVectors(b, a).cross(edge.subVectors(c, a)).normalize();
        const horizontal = Math.abs(normal.y) >= Math.max(Math.abs(normal.x), Math.abs(normal.z));
        const xFacing = Math.abs(normal.x) >= Math.abs(normal.z);
        for (let offset = 0; offset < 3; offset++) {
            const point = offset === 0 ? a : offset === 1 ? b : c;
            const uvIndex = (vertex + offset) * 2;
            uvs[uvIndex] = (horizontal ? point.x : xFacing ? point.z : point.x) * ROAD_CONCRETE_UV_PER_M;
            uvs[uvIndex + 1] = (horizontal ? point.z : point.y) * ROAD_CONCRETE_UV_PER_M;
        }
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    return geometry;
}

function addBoxInstances(root, boxes, material, name) {
    if (!Array.isArray(boxes) || boxes.length === 0) return null;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const xAxis = new THREE.Vector3(1, 0, 0);
    const pitchQuaternion = new THREE.Quaternion();
    for (let index = 0; index < boxes.length; index++) {
        const box = boxes[index];
        position.set(box.x, box.y, box.z);
        quaternion.setFromAxisAngle(yAxis, box.heading || 0);
        if (box.pitch) {
            pitchQuaternion.setFromAxisAngle(xAxis, box.pitch);
            quaternion.multiply(pitchQuaternion);
        }
        scale.set(box.width, box.height, box.length);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    root.add(mesh);
    return mesh;
}

function applyWorldUvs(geometry, uvPerM) {
    if (!geometry) return null;
    const positions = geometry.getAttribute('position');
    const uvs = new Float32Array(positions.count * 2);
    for (let index = 0; index < positions.count; index++) {
        uvs[index * 2] = positions.getX(index) * uvPerM;
        uvs[index * 2 + 1] = positions.getZ(index) * uvPerM;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    return geometry;
}

function sampleRows(
    alignment,
    alignments,
    formationOffsetsOverrideM = null,
    tramCorridorEnvelope = null,
) {
    const {
        roadHalfWidthM,
        formationHalfWidthM: defaultFormationHalfWidthM,
    } = alignmentHalfWidths(alignment);
    const fullFormationLeftM = Math.max(
        defaultFormationHalfWidthM,
        Number(formationOffsetsOverrideM?.leftM) || 0,
    );
    const fullFormationRightM = Math.max(
        defaultFormationHalfWidthM,
        Number(formationOffsetsOverrideM?.rightM) || 0,
    );
    return alignment.samples.map((sample, index, samples) => {
        const { ux, uz, nx, nz } = roadStructureSampleFrame(samples, index);
        const replacementFormationBlend = roadReplacementFormationBlend(
            alignment,
            sample,
        );
        const baseFormationOffsetsM = roadStructureFormationOffsetsAtSampleM(
            alignment,
            alignments,
            {
                leftM: roadHalfWidthM + (
                    fullFormationLeftM - roadHalfWidthM
                ) * replacementFormationBlend,
                rightM: roadHalfWidthM + (
                    fullFormationRightM - roadHalfWidthM
                ) * replacementFormationBlend,
            },
            sample,
        );
        // A bridge deck is one structural envelope even when OSM maps its road
        // carriageways and central tram reservation as separate LineStrings.
        // Move the deck edge and its safety fence beyond any longitudinal,
        // structurally tagged tram; ordinary street-running tram is untouched.
        const rowFormationOffsetsM = alignment.kind === 'overpass'
            ? tramCorridorEnvelope?.formationOffsetsAtLocal(
                sample.x,
                sample.z,
                { x: ux, z: uz },
                baseFormationOffsetsM,
            ) || baseFormationOffsetsM
            : baseFormationOffsetsM;
        const formationLeftM = rowFormationOffsetsM.leftM;
        const formationRightM = rowFormationOffsetsM.rightM;
        const rise = Math.max(0, sample.y - sample.terrainY);
        const earthworkRunM = Math.max(1.5, rise * EMBANKMENT_SLOPE_RUN_PER_RISE);
        const bottomLeftM = formationLeftM + earthworkRunM;
        const bottomRightM = formationRightM + earthworkRunM;
        const point = (offset, y = sample.y) => ({
            x: sample.x + nx * offset,
            y,
            z: sample.z + nz * offset,
        });
        return {
            ...sample,
            ux,
            uz,
            nx,
            nz,
            formationLeftM,
            formationRightM,
            formationWidthM: formationLeftM + formationRightM,
            formationCenterOffsetM: (formationLeftM - formationRightM) * 0.5,
            replacementFormationBlend,
            left: point(formationLeftM),
            right: point(-formationRightM),
            bottomLeft: point(bottomLeftM, sample.terrainY - 0.25),
            bottomRight: point(-bottomRightM, sample.terrainY - 0.25),
            point,
        };
    });
}

function surfaceOffsetAt(row, offset) {
    return typeof offset === 'function' ? Number(offset(row)) : Number(offset);
}

function surfacePoint(row, offset, y, alongM = 0) {
    const point = row.point(surfaceOffsetAt(row, offset), y);
    point.x += row.ux * alongM;
    point.z += row.uz * alongM;
    return point;
}

// A junction mouth (a side road joining the approach) keeps the companion
// sidewalk and its curb open over its station span: real sidewalks break at a
// junction, and a continuous strip would bury the connecting road.
function junctionGapAtStation(alignment, side, stationM) {
    for (const range of alignment.junctionGapRanges || []) {
        if (range.side && range.side !== side) continue;
        if (stationM >= range.startM && stationM <= range.endM) return true;
    }
    return false;
}

function buildSurface(
    rows,
    leftOffset,
    rightOffset,
    liftM = 0,
    joinOverlapM = 0,
    includeSegment = null,
) {
    const vertices = [];
    for (let index = 0; index + 1 < rows.length; index++) {
        const a = rows[index];
        const b = rows[index + 1];
        if (includeSegment && !includeSegment(a, b)) continue;
        const aAlongM = index === 0 ? -joinOverlapM : 0;
        const bAlongM = index + 2 === rows.length ? joinOverlapM : 0;
        pushQuad(
            vertices,
            surfacePoint(a, leftOffset, a.y + liftM, aAlongM),
            surfacePoint(b, leftOffset, b.y + liftM, bAlongM),
            surfacePoint(b, rightOffset, b.y + liftM, bAlongM),
            surfacePoint(a, rightOffset, a.y + liftM, aAlongM),
        );
    }
    return geometryFromPositions(vertices);
}

function structureSegmentIndices(rows) {
    const indices = [];
    for (let index = 0; index + 1 < rows.length; index++) {
        if (rows[index].structure && rows[index + 1].structure) indices.push(index);
    }
    return indices;
}

// Segments genuinely buried under the tunnel roof (row.covered, annotated in
// the underpass build). The tagged structure span over-covers — the grade
// runouts descend inside it — so the box, its portals, and the wall skip all
// key on burial depth, never on the tag range alone.
function coveredSegmentIndices(rows) {
    const indices = [];
    for (let index = 0; index + 1 < rows.length; index++) {
        if (rows[index].covered && rows[index + 1].covered) indices.push(index);
    }
    return indices;
}

function structurePoint(row, offsetM, y, alongM) {
    const point = row.point(surfaceOffsetAt(row, offsetM), y);
    point.x += row.ux * alongM;
    point.z += row.uz * alongM;
    return point;
}

function buildStructureSurface(
    rows,
    leftOffset,
    rightOffset,
    liftM = 0,
    joinOverlapM = 0,
    includeSegment = null,
) {
    const vertices = [];
    const segments = structureSegmentIndices(rows);
    if (segments.length === 0) return null;
    const firstSegment = segments[0];
    const lastSegment = segments[segments.length - 1];
    for (const index of segments) {
        const a = rows[index];
        const b = rows[index + 1];
        if (includeSegment && !includeSegment(a, b)) continue;
        const aAlongM = index === firstSegment ? -joinOverlapM : 0;
        const bAlongM = index === lastSegment ? joinOverlapM : 0;
        pushQuad(
            vertices,
            structurePoint(a, leftOffset, a.y + liftM, aAlongM),
            structurePoint(b, leftOffset, b.y + liftM, bAlongM),
            structurePoint(b, rightOffset, b.y + liftM, bAlongM),
            structurePoint(a, rightOffset, a.y + liftM, aAlongM),
        );
    }
    return geometryFromPositions(vertices);
}

function buildEarthwork(rows, { closeEnds = true } = {}) {
    const vertices = [];
    for (let index = 0; index + 1 < rows.length; index++) {
        const a = rows[index];
        const b = rows[index + 1];
        if (a.structure && b.structure) continue;
        pushQuad(vertices, a.left, b.left, b.bottomLeft, a.bottomLeft);
        pushQuad(vertices, b.right, a.right, a.bottomRight, b.bottomRight);
        if (a.structure !== b.structure) {
            const end = a.structure ? a : b;
            pushQuad(vertices, end.right, end.left, end.bottomLeft, end.bottomRight);
        }
    }
    if (closeEnds) {
        for (const index of [0, rows.length - 1]) {
            const row = rows[index];
            pushQuad(vertices, row.right, row.left, row.bottomLeft, row.bottomRight);
        }
    }
    return geometryFromPositions(vertices);
}

function interpolatePoint(a, b, t, y) {
    return {
        x: a.x + (b.x - a.x) * t,
        y,
        z: a.z + (b.z - a.z) * t,
    };
}

function sampledTerrainY(terrainSceneYAtLocal, points, fallbackY) {
    let highest = finiteOrNull(fallbackY);
    for (const point of points) {
        const value = finiteOrNull(terrainSceneYAtLocal?.(point.x, point.z));
        if (value !== null) highest = highest === null ? value : Math.max(highest, value);
    }
    return highest;
}

function underpassWallSection(
    a,
    b,
    t,
    side,
    terrainSceneYAtLocal,
    clearHeightM,
    roofDepthM,
) {
    const aFormationM = side > 0 ? a.formationLeftM : a.formationRightM;
    const bFormationM = side > 0 ? b.formationLeftM : b.formationRightM;
    const aInner = a.point(side * aFormationM);
    const bInner = b.point(side * bFormationM);
    const wallBlend = a.replacementFormationBlend
        + (b.replacementFormationBlend - a.replacementFormationBlend) * t;
    const aOuter = a.point(side * (
        aFormationM + TUNNEL_WALL_M * a.replacementFormationBlend
    ));
    const bOuter = b.point(side * (
        bFormationM + TUNNEL_WALL_M * b.replacementFormationBlend
    ));
    const roadY = a.y + (b.y - a.y) * t;
    const fallbackTerrainY = a.terrainY + (b.terrainY - a.terrainY) * t;
    const inner = interpolatePoint(aInner, bInner, t, roadY);
    const outer = interpolatePoint(aOuter, bOuter, t, roadY);
    const aCollarOuter = a.point(side * (
        aFormationM
        + TUNNEL_WALL_M * wallBlend
        + UNDERPASS_TERRAIN_CONTAINMENT_APRON_M
    ));
    const bCollarOuter = b.point(side * (
        bFormationM
        + TUNNEL_WALL_M * wallBlend
        + UNDERPASS_TERRAIN_CONTAINMENT_APRON_M
    ));
    const terrainCollarOuter = interpolatePoint(
        aCollarOuter,
        bCollarOuter,
        t,
        roadY,
    );
    // Lock the crown to the box face only where the wall actually MEETS the
    // covered box. Keying this on the structure TAG sawtoothed the crown
    // through the shallow tagged stretches: every subdivided section whose
    // endpoint carried the tag spiked to full box height between
    // terrain-crowned interior points.
    const onStructureBoundary = (t <= 1e-9 && a.covered)
        || (t >= 1 - 1e-9 && b.covered);
    const rawTopY = onStructureBoundary
        ? roadY + clearHeightM + roofDepthM
        : Math.max(
            roadY + 0.02,
            roadY + wallBlend * (
                sampledTerrainY(
                    terrainSceneYAtLocal,
                    [inner, outer],
                    fallbackTerrainY,
                ) + UNDERPASS_WALL_TERRAIN_OVERLAP_M
                - roadY
            ),
        );
    const bottomY = roadY - UNDERPASS_WALL_BASE_OVERLAP_M;
    const sampledCollarTerrainY = finiteOrNull(terrainSceneYAtLocal?.(
        terrainCollarOuter.x,
        terrainCollarOuter.z,
    ));
    terrainCollarOuter.y = sampledCollarTerrainY !== null
        ? sampledCollarTerrainY + 0.025
        : rawTopY;
    return {
        roadY,
        wallBlend,
        rawTopY,
        crownLocked: onStructureBoundary || wallBlend <= 1e-6,
        innerBottom: { ...inner, y: bottomY },
        outerBottom: { ...outer, y: bottomY },
        innerTop: { ...inner, y: rawTopY },
        outerTop: { ...outer, y: rawTopY },
        terrainCollarOuter,
    };
}

function underpassWallSectionDistanceM(a, b) {
    return Math.hypot(
        b.innerBottom.x - a.innerBottom.x,
        b.innerBottom.z - a.innerBottom.z,
    );
}

function smoothUnderpassWallCrown(run) {
    if (!Array.isArray(run) || run.length < 2) return;
    const top = run.map(section => section.rawTopY);
    for (let index = 1; index < top.length; index++) {
        const distanceM = underpassWallSectionDistanceM(
            run[index - 1],
            run[index],
        );
        top[index] = Math.max(
            top[index],
            top[index - 1] - distanceM * UNDERPASS_WALL_CROWN_MAX_GRADE,
        );
    }
    for (let index = top.length - 2; index >= 0; index--) {
        const distanceM = underpassWallSectionDistanceM(
            run[index],
            run[index + 1],
        );
        top[index] = Math.max(
            top[index],
            top[index + 1] - distanceM * UNDERPASS_WALL_CROWN_MAX_GRADE,
        );
    }
    for (let index = 0; index < run.length; index++) {
        // Portal crowns and the zero-depth road joins are exact contracts. The
        // slope-limited envelope smooths only the terrain-owned span between
        // them, so it cannot reopen either seam.
        const topY = run[index].crownLocked ? run[index].rawTopY : top[index];
        run[index].innerTop.y = topY;
        run[index].outerTop.y = topY;
    }
}

function collectUnderpassWallSpecs(rows, alignment = null) {
    const runs = [];
    for (const side of [-1, 1]) {
        let run = null;
        for (let index = 0; index + 1 < rows.length; index++) {
            const a = rows[index];
            const b = rows[index + 1];
            if (a.covered && b.covered) {
                run = null;
                continue;
            }
            // A side road joining at grade must not face a wall or its raised
            // terrain collar across its mouth — the band was severing the
            // connecting road right where it meets the approach.
            if (alignment && junctionGapAtStation(
                alignment,
                side === 1 ? 'left' : 'right',
                (a.s + b.s) * 0.5,
            )) {
                run = null;
                continue;
            }
            const segmentLengthM = Math.hypot(b.x - a.x, b.z - a.z);
            const steps = Math.max(
                1,
                Math.ceil(segmentLengthM / UNDERPASS_WALL_MAX_SEGMENT_M),
            );
            if (!run) {
                run = [];
                runs.push(run);
                run.push({ a, b, t: 0, side, section: null });
            }
            for (let step = 1; step <= steps; step++) {
                run.push({
                    a,
                    b,
                    t: step / steps,
                    side,
                    section: null,
                });
            }
            if (b.covered) run = null;
        }
    }
    return runs;
}

function createUnderpassApproachWallBuilder(
    rows,
    terrainSceneYAtLocal,
    clearHeightM,
    roofDepthM,
    alignment = null,
) {
    const runs = collectUnderpassWallSpecs(rows, alignment);
    const samples = runs.flat();
    const vertices = [];
    const collarVertices = [];
    let sampleIndex = 0;
    let edgeIndex = 0;
    let edges = null;
    let geometry = null;
    return {
        step() {
            if (sampleIndex < samples.length) {
                const end = Math.min(
                    samples.length,
                    sampleIndex + UNDERPASS_WALL_SECTIONS_PER_STEP,
                );
                for (; sampleIndex < end; sampleIndex++) {
                    const spec = samples[sampleIndex];
                    spec.section = underpassWallSection(
                        spec.a,
                        spec.b,
                        spec.t,
                        spec.side,
                        terrainSceneYAtLocal,
                        clearHeightM,
                        roofDepthM,
                    );
                }
                return { done: false, geometry: null };
            }
            if (!edges) {
                const sectionRuns = runs.map(run => run.map(spec => spec.section));
                for (const run of sectionRuns) smoothUnderpassWallCrown(run);
                edges = sectionRuns.flatMap(run => (
                    run.slice(1).map((end, index) => ({
                        start: run[index],
                        end,
                    }))
                ));
            }
            if (edgeIndex < edges.length) {
                const endIndex = Math.min(
                    edges.length,
                    edgeIndex + UNDERPASS_WALL_SECTIONS_PER_STEP,
                );
                for (; edgeIndex < endIndex; edgeIndex++) {
                    const { start, end } = edges[edgeIndex];
                    pushQuad(
                        vertices,
                        start.innerBottom,
                        end.innerBottom,
                        end.innerTop,
                        start.innerTop,
                    );
                    pushQuad(
                        vertices,
                        end.outerBottom,
                        start.outerBottom,
                        start.outerTop,
                        end.outerTop,
                    );
                    pushQuad(
                        vertices,
                        start.innerTop,
                        end.innerTop,
                        end.outerTop,
                        start.outerTop,
                    );
                    pushQuad(
                        collarVertices,
                        start.outerTop,
                        end.outerTop,
                        end.terrainCollarOuter,
                        start.terrainCollarOuter,
                    );
                }
                return { done: false, geometry: null };
            }
            if (!geometry) {
                geometry = {
                    wall: geometryFromPositions(vertices),
                    collar: geometryFromPositions(collarVertices),
                };
            }
            return { done: true, geometry };
        },
    };
}

function buildCurbs(rows, offsets) {
    const vertices = [];
    const heightM = 0.18;
    const widthM = 0.3;
    for (let index = 0; index + 1 < rows.length; index++) {
        const a = rows[index];
        const b = rows[index + 1];
        for (const offset of offsets) {
            const inward = offset < 0 ? widthM : -widthM;
            const aOuter = a.point(offset, a.y);
            const bOuter = b.point(offset, b.y);
            const aTopOuter = a.point(offset, a.y + heightM);
            const bTopOuter = b.point(offset, b.y + heightM);
            const aTopInner = a.point(offset + inward, a.y + heightM);
            const bTopInner = b.point(offset + inward, b.y + heightM);
            pushQuad(vertices, aOuter, bOuter, bTopOuter, aTopOuter);
            pushQuad(vertices, aTopOuter, bTopOuter, bTopInner, aTopInner);
        }
    }
    return geometryFromPositions(vertices);
}

function buildUnderpassSidewalkCurbs(
    rows,
    bands,
    { structureOnly = false, includeBandSegment = null } = {},
) {
    const vertices = [];
    const segments = structureOnly
        ? structureSegmentIndices(rows)
        : rows.slice(0, -1).map((_row, index) => index);
    if (segments.length === 0) return null;
    const firstSegment = segments[0];
    const lastSegment = segments[segments.length - 1];
    for (const index of segments) {
        const a = rows[index];
        const b = rows[index + 1];
        const aAlongM = index === firstSegment
            ? -UNDERPASS_ROAD_JOIN_OVERLAP_M
            : 0;
        const bAlongM = index === lastSegment
            ? UNDERPASS_ROAD_JOIN_OVERLAP_M
            : 0;
        for (const band of bands) {
            if (includeBandSegment && !includeBandSegment(band, a, b)) continue;
            const roadEdgeM = band.side === 'left'
                ? band.rightOffsetM
                : band.leftOffsetM;
            const sidewalkEdgeM = roadEdgeM + (
                band.side === 'left'
                    ? UNDERPASS_SIDEWALK_CURB_WIDTH_M
                    : -UNDERPASS_SIDEWALK_CURB_WIDTH_M
            );
            const aRoadBottom = structurePoint(
                a,
                roadEdgeM,
                a.y + UNDERPASS_ROAD_SURFACE_LIFT_M,
                aAlongM,
            );
            const bRoadBottom = structurePoint(
                b,
                roadEdgeM,
                b.y + UNDERPASS_ROAD_SURFACE_LIFT_M,
                bAlongM,
            );
            const aRoadTop = structurePoint(
                a,
                roadEdgeM,
                a.y + UNDERPASS_SIDEWALK_SURFACE_LIFT_M,
                aAlongM,
            );
            const bRoadTop = structurePoint(
                b,
                roadEdgeM,
                b.y + UNDERPASS_SIDEWALK_SURFACE_LIFT_M,
                bAlongM,
            );
            const aSidewalkTop = structurePoint(
                a,
                sidewalkEdgeM,
                a.y + UNDERPASS_SIDEWALK_SURFACE_LIFT_M,
                aAlongM,
            );
            const bSidewalkTop = structurePoint(
                b,
                sidewalkEdgeM,
                b.y + UNDERPASS_SIDEWALK_SURFACE_LIFT_M,
                bAlongM,
            );
            pushQuad(
                vertices,
                aRoadBottom,
                bRoadBottom,
                bRoadTop,
                aRoadTop,
            );
            pushQuad(
                vertices,
                aRoadTop,
                bRoadTop,
                bSidewalkTop,
                aSidewalkTop,
            );
        }
    }
    return geometryFromPositions(vertices);
}

function buildBridgeDeck(rows) {
    const vertices = [];
    for (let index = 0; index + 1 < rows.length; index++) {
        const a = rows[index];
        const b = rows[index + 1];
        if (!(a.structure && b.structure)) continue;
        const aLeftBottom = { ...a.left, y: a.y - BRIDGE_DECK_DEPTH_M };
        const bLeftBottom = { ...b.left, y: b.y - BRIDGE_DECK_DEPTH_M };
        const aRightBottom = { ...a.right, y: a.y - BRIDGE_DECK_DEPTH_M };
        const bRightBottom = { ...b.right, y: b.y - BRIDGE_DECK_DEPTH_M };
        pushQuad(vertices, a.left, b.left, bLeftBottom, aLeftBottom);
        pushQuad(vertices, b.right, a.right, aRightBottom, bRightBottom);
        pushQuad(vertices, aLeftBottom, bLeftBottom, bRightBottom, aRightBottom);
    }
    return geometryFromPositions(vertices);
}

function buildBridgeSupportSurface(rows) {
    const vertices = [];
    for (let index = 0; index + 1 < rows.length; index++) {
        const a = rows[index];
        const b = rows[index + 1];
        if (!(a.structure && b.structure)) continue;
        pushQuad(
            vertices,
            a.left,
            b.left,
            b.right,
            a.right,
        );
    }
    return geometryFromPositions(vertices);
}

function buildBridgeSidewalkSurface(
    rows,
    roadHalfWidthM,
    alignment,
    alignments,
) {
    const vertices = [];
    const structureSegments = [];
    for (let index = 0; index + 1 < rows.length; index++) {
        if (rows[index].structure && rows[index + 1].structure) {
            structureSegments.push(index);
        }
    }
    if (structureSegments.length === 0) return null;
    const firstSegment = structureSegments[0];
    const lastSegment = structureSegments[structureSegments.length - 1];
    const formationOffsetsM = {
        leftM: Math.max(...rows.map(row => row.formationLeftM)),
        rightM: Math.max(...rows.map(row => row.formationRightM)),
    };
    const bands = roadStructureSidewalkBandsM(
        roadHalfWidthM,
        formationOffsetsM,
        alignment,
        alignments,
    );
    const point = (row, offsetM, alongM = 0) => {
        const value = row.point(offsetM, row.y + BRIDGE_SIDEWALK_SURFACE_LIFT_M);
        value.x += row.ux * alongM;
        value.z += row.uz * alongM;
        return value;
    };
    for (const index of structureSegments) {
        const a = rows[index];
        const b = rows[index + 1];
        const aAlongM = index === firstSegment
            ? -BRIDGE_SIDEWALK_JOIN_OVERLAP_M
            : 0;
        const bAlongM = index === lastSegment
            ? BRIDGE_SIDEWALK_JOIN_OVERLAP_M
            : 0;
        for (const band of bands) {
            pushQuad(
                vertices,
                point(a, band.leftOffsetM, aAlongM),
                point(b, band.leftOffsetM, bAlongM),
                point(b, band.rightOffsetM, bAlongM),
                point(a, band.rightOffsetM, aAlongM),
            );
        }
    }
    return geometryFromPositions(vertices);
}

function addBridgeSafetyFences(root, rows, material) {
    const railBoxes = [];
    const postBoxes = [];
    const colliderBoxes = [];
    const postKeys = new Set();
    for (let index = 0; index + 1 < rows.length; index++) {
        const a = rows[index];
        const b = rows[index + 1];
        if (!(a.structure && b.structure)) continue;
        for (const side of [-1, 1]) {
            const aOffsetM = side > 0 ? a.formationLeftM : -a.formationRightM;
            const bOffsetM = side > 0 ? b.formationLeftM : -b.formationRightM;
            const aSide = a.point(aOffsetM);
            const bSide = b.point(bOffsetM);
            const dx = bSide.x - aSide.x;
            const dy = bSide.y - aSide.y;
            const dz = bSide.z - aSide.z;
            const horizontalLengthM = Math.hypot(dx, dz);
            const lengthM = Math.hypot(horizontalLengthM, dy);
            if (lengthM < 0.05) continue;
            const heading = Math.atan2(dx, dz);
            const pitch = -Math.atan2(dy, Math.max(1e-6, horizontalLengthM));
            for (const levelM of BRIDGE_FENCE_RAIL_LEVELS_M) {
                railBoxes.push({
                    x: (aSide.x + bSide.x) * 0.5,
                    y: (aSide.y + bSide.y) * 0.5 + levelM,
                    z: (aSide.z + bSide.z) * 0.5,
                    width: BRIDGE_FENCE_RAIL_WIDTH_M,
                    height: BRIDGE_FENCE_RAIL_HEIGHT_M,
                    length: lengthM,
                    heading,
                    pitch,
                });
            }
            colliderBoxes.push({
                cx: (aSide.x + bSide.x) * 0.5,
                cz: (aSide.z + bSide.z) * 0.5,
                hx: BRIDGE_FENCE_RAIL_WIDTH_M * 0.75,
                hz: horizontalLengthM * 0.5,
                sin: Math.sin(heading),
                cos: Math.cos(heading),
                minY: Math.min(aSide.y, bSide.y),
                maxY: Math.max(aSide.y, bSide.y) + BRIDGE_FENCE_HEIGHT_M,
                guard: true,
            });
            const postSteps = Math.max(
                1,
                Math.ceil(horizontalLengthM / BRIDGE_FENCE_POST_SPACING_M),
            );
            for (let step = 0; step <= postSteps; step++) {
                const t = step / postSteps;
                const x = aSide.x + dx * t;
                const y = aSide.y + dy * t;
                const z = aSide.z + dz * t;
                const key = `${side}:${Math.round(x * 10)}:${Math.round(z * 10)}`;
                if (postKeys.has(key)) continue;
                postKeys.add(key);
                postBoxes.push({
                    x,
                    y: y + BRIDGE_FENCE_HEIGHT_M * 0.5,
                    z,
                    width: BRIDGE_FENCE_POST_WIDTH_M,
                    height: BRIDGE_FENCE_HEIGHT_M,
                    length: BRIDGE_FENCE_POST_WIDTH_M,
                    heading,
                });
            }
        }
    }
    const rails = addBoxInstances(
        root,
        railBoxes,
        material,
        'RoadOverpassFenceRails',
    );
    if (rails) rails.userData.walkColliderBoxes = colliderBoxes;
    const posts = addBoxInstances(
        root,
        postBoxes,
        material,
        'RoadOverpassFencePosts',
    );
    // Rails already publish one continuous collider per fence segment. Avoid
    // indexing every decorative upright as a redundant walk obstacle.
    if (posts) posts.userData.walkColliderBoxes = [];
}

function structureRows(rows) {
    return rows.filter(row => row.structure);
}

function addBridgeSupports(root, alignment, rows, material, formation = roadFormationModel) {
    const candidates = [];
    let nextS = alignment.structureStartM + PIER_SPACING_M;
    for (const row of structureRows(rows)) {
        if (row.s + 0.01 < nextS || row.s >= alignment.structureEndM - 8) continue;
        candidates.push(row);
        nextS += PIER_SPACING_M;
    }
    const resolved = resolveIntelligentPillarSamples(
        candidates,
        (x, z) => roadStructureSupportClearanceAtLocal(
            alignment,
            formation,
            x,
            z,
        ),
    );
    const boxes = [];
    for (const row of resolved) {
        const baseY = finiteOrNull(
            alignment.terrainSceneYAtLocal(row.x, row.z),
        );
        if (baseY === null) continue;
        const resolvedDeckY = Number(alignment.profileYAtS?.(row.s));
        const topY = (
            Number.isFinite(resolvedDeckY) ? resolvedDeckY : row.y
        ) - BRIDGE_DECK_DEPTH_M;
        const heightM = topY - baseY;
        if (heightM < 2.5) continue;
        const heading = Math.atan2(row.ux, row.uz);
        boxes.push({
            x: row.x,
            y: baseY + heightM * 0.5,
            z: row.z,
            width: 1.4,
            height: heightM,
            length: 1.6,
            heading,
        });
        const capCenter = pointAtPlacedSupport(
            row,
            row.formationCenterOffsetM,
            topY - 0.325,
        );
        boxes.push({
            x: capCenter.x,
            y: capCenter.y,
            z: capCenter.z,
            width: 1.8,
            height: 0.65,
            length: row.formationWidthM * 0.7,
            heading: heading + Math.PI * 0.5,
        });
    }
    addBoxInstances(root, boxes, material, 'RoadOverpassSupports');
}

function addAbutment(root, row, material) {
    const riseM = row.y - row.terrainY;
    if (riseM < 1.5) return;
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(row.formationWidthM + 1.5, riseM, 1.2),
        material,
    );
    const center = row.point(row.formationCenterOffsetM, row.terrainY + riseM * 0.5);
    mesh.position.set(center.x, center.y, center.z);
    mesh.rotation.y = Math.atan2(row.ux, row.uz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
}

function nearestStructureBoundary(rows, stationM) {
    let best = null;
    for (const row of rows) {
        const distanceM = Math.abs(row.s - stationM);
        if (!best || distanceM < best.distanceM) best = { row, distanceM };
    }
    return best?.row || null;
}

function buildTunnelBox(
    rows,
    clearHeightM = TUNNEL_CLEAR_HEIGHT_M,
    roofDepthM = TUNNEL_ROOF_DEPTH_M,
) {
    const vertices = [];
    const segments = coveredSegmentIndices(rows);
    if (segments.length === 0) return null;
    const firstSegment = segments[0];
    const lastSegment = segments[segments.length - 1];
    for (const index of segments) {
        const a = rows[index];
        const b = rows[index + 1];
        const aLeftInner = a.formationLeftM;
        const bLeftInner = b.formationLeftM;
        const aRightInner = a.formationRightM;
        const bRightInner = b.formationRightM;
        const aLeftOuter = aLeftInner + TUNNEL_WALL_M;
        const bLeftOuter = bLeftInner + TUNNEL_WALL_M;
        const aRightOuter = aRightInner + TUNNEL_WALL_M;
        const bRightOuter = bRightInner + TUNNEL_WALL_M;
        const aLeftFloor = a.point(aLeftInner, a.y - 0.25);
        const bLeftFloor = b.point(bLeftInner, b.y - 0.25);
        const aRightFloor = a.point(-aRightInner, a.y - 0.25);
        const bRightFloor = b.point(-bRightInner, b.y - 0.25);
        const aLeftOuterFloor = a.point(aLeftOuter, a.y - 0.25);
        const bLeftOuterFloor = b.point(bLeftOuter, b.y - 0.25);
        const aRightOuterFloor = a.point(-aRightOuter, a.y - 0.25);
        const bRightOuterFloor = b.point(-bRightOuter, b.y - 0.25);
        const aLeftRoof = a.point(aLeftInner, a.y + clearHeightM);
        const bLeftRoof = b.point(bLeftInner, b.y + clearHeightM);
        const aRightRoof = a.point(-aRightInner, a.y + clearHeightM);
        const bRightRoof = b.point(-bRightInner, b.y + clearHeightM);
        const aLeftRoofTop = a.point(
            aLeftOuter,
            a.y + clearHeightM + roofDepthM,
        );
        const bLeftRoofTop = b.point(
            bLeftOuter,
            b.y + clearHeightM + roofDepthM,
        );
        const aRightRoofTop = a.point(
            -aRightOuter,
            a.y + clearHeightM + roofDepthM,
        );
        const bRightRoofTop = b.point(
            -bRightOuter,
            b.y + clearHeightM + roofDepthM,
        );
        pushQuad(vertices, aLeftFloor, bLeftFloor, bLeftRoof, aLeftRoof);
        pushQuad(vertices, bRightFloor, aRightFloor, aRightRoof, bRightRoof);
        pushQuad(
            vertices,
            bLeftOuterFloor,
            aLeftOuterFloor,
            aLeftRoofTop,
            bLeftRoofTop,
        );
        pushQuad(
            vertices,
            aRightOuterFloor,
            bRightOuterFloor,
            bRightRoofTop,
            aRightRoofTop,
        );
        pushQuad(vertices, aLeftRoof, bLeftRoof, bRightRoof, aRightRoof);
        pushQuad(
            vertices,
            aLeftRoofTop,
            aRightRoofTop,
            bRightRoofTop,
            bLeftRoofTop,
        );
        pushQuad(vertices, aLeftRoof, aLeftRoofTop, bLeftRoofTop, bLeftRoof);
        pushQuad(vertices, bRightRoof, bRightRoofTop, aRightRoofTop, aRightRoof);
        if (index === firstSegment) {
            pushQuad(
                vertices,
                aLeftRoof,
                aRightRoof,
                aRightRoofTop,
                aLeftRoofTop,
            );
        }
        if (index === lastSegment) {
            pushQuad(
                vertices,
                bRightRoof,
                bLeftRoof,
                bLeftRoofTop,
                bRightRoofTop,
            );
        }
    }
    return geometryFromPositions(vertices);
}

function addTunnelPortal(
    root,
    row,
    material,
    clearHeightM = TUNNEL_CLEAR_HEIGHT_M,
) {
    const heading = Math.atan2(row.ux, row.uz);
    const widthM = row.formationWidthM + TUNNEL_WALL_M * 2;
    const header = new THREE.Mesh(
        new THREE.BoxGeometry(widthM, 0.8, 0.8),
        material,
    );
    const center = row.point(
        row.formationCenterOffsetM,
        row.y + clearHeightM - 0.4,
    );
    header.position.set(center.x, center.y, center.z);
    header.rotation.y = heading;
    header.castShadow = true;
    // The terrain above does not cast into the sun map. Letting this sealed
    // header receive it projects surface cars through the railway formation.
    header.receiveShadow = false;
    root.add(header);
}

function createMaterials() {
    const terrainSurface = getActiveTerrainSurface();
    const concreteSurface = getWornConcreteSurface();
    const terrainCollarClaim = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.ROAD_EARTHWORK,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        ownerId: 'road-grade-separation-earthwork',
        sourceId: 'world/road-grade-separations.js',
        supportReady: true,
        cutsBackstop: true,
    });
    const terrainCollar = applyStreetLampSurfaceLighting(new THREE.MeshStandardMaterial({
                map: terrainSurface.map,
                bumpMap: terrainSurface.bumpMap,
                bumpScale: terrainSurface.bumpScale,
                color: 0xffffff,
                roughness: 0.96,
                metalness: 0,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -1,
            }));
    applySurfaceStencil(terrainCollar, terrainCollarClaim);
    applyGroundOwnership(terrainCollar, terrainCollarClaim);
    applyPlannerSurfaceCutout(terrainCollar, terrainCollarClaim);
    applyUrbanGroundSurface(terrainCollar, terrainCollarClaim, {
        fieldPatchwork: true,
    });
    terrainCollar.userData.worldUvPerM = terrainSurface.uvPerM;
    const result = {
        asphalt: new THREE.MeshStandardMaterial({
            map: getAsphaltTexture(),
            color: 0xffffff,
            roughness: 0.94,
        }),
        earth: new THREE.MeshStandardMaterial({
            map: getGrassTexture(),
            color: 0xffffff,
            roughness: 1,
            side: THREE.DoubleSide,
        }),
        concrete: new THREE.MeshStandardMaterial({
            map: concreteSurface.map,
            bumpMap: concreteSurface.bumpMap,
            bumpScale: 0.35,
            color: 0xe3e0d8,
            roughness: 0.96,
            metalness: 0,
            side: THREE.DoubleSide,
        }),
        terrainCollar,
        metal: new THREE.MeshStandardMaterial({
            color: 0x5e686b,
            metalness: 0.72,
            roughness: 0.42,
        }),
        sidewalk: new THREE.MeshStandardMaterial({
            map: getSidewalkTexture(),
            color: 0xffffff,
            roughness: 0.94,
        }),
        // The visible asphalt, sidewalks, and cycleway already own the bridge
        // top. This continuous mesh exists only as a walk-ray safety net across
        // their independent OSM polygon joins; rendering it exposed transverse
        // sidewalk-grey strips wherever those polygons did not tessellate alike.
        bridgeSupport: new THREE.MeshBasicMaterial({
            visible: false,
            side: THREE.DoubleSide,
        }),
        redPaint: new THREE.MeshStandardMaterial({
            color: 0xa8452f,
            roughness: 0.9,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
        }),
        whitePaint: new THREE.MeshBasicMaterial({
            color: 0xf2f2ed,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -3,
        }),
    };
    // A permanent authored landmark may replace part of an otherwise valid
    // generic road tunnel. Clip every visible civil material inside that exact
    // bounded volume, while leaving planner/rail cutouts out of the terrain
    // collar (it already receives the same authored opening through the
    // planner-surface hook above).
    for (const material of Object.values(result)) {
        if (material !== terrainCollar && material.visible !== false) {
            applyAuthoredSurfaceOpeningCutout(material);
        }
    }
    return result;
}

function addMesh(root, geometry, material, name, {
    castShadow = false,
    receiveShadow = true,
    walkable = false,
} = {}) {
    if (!geometry) return null;
    if (material === materials?.concrete) applyCivilConcreteUvs(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    if (walkable) mesh.userData.walkableSurface = true;
    root.add(mesh);
    return mesh;
}

function addReplacementRoad(root, alignment, rows, materials, alignments) {
    const crossSection = alignment.definition.crossSection || {};
    if (!alignment.definition.replaceRoadSurface) return;
    const structureOnly = alignment.definition.replaceRoadSurfaceRange === 'structure';
    const formationHalfWidthM = Number(crossSection.formationHalfWidthM)
        || alignmentHalfWidths(alignment).formationHalfWidthM;
    const roadHalfWidthM = Number(crossSection.carriagewayHalfWidthM)
        || alignmentHalfWidths(alignment).roadHalfWidthM;
    const ownsUnderpassFormation = alignment.kind === 'underpass'
        && alignment.definition.replacementCarriagewayOnly;
    const formationOffsetsM = {
        leftM: Math.max(...rows.map(row => row.formationLeftM)),
        rightM: Math.max(...rows.map(row => row.formationRightM)),
    };
    const companionSidewalkBands = ownsUnderpassFormation
        ? roadStructureCompanionSidewalkBandsM(
            roadHalfWidthM,
            formationOffsetsM,
            alignment,
            alignments,
        )
        : [];
    const sidewalkSides = new Set(
        companionSidewalkBands.map(band => band.side),
    );
    const surfaceLeftOffsetM = ownsUnderpassFormation
        ? (sidewalkSides.has('left')
            ? roadHalfWidthM
            : row => row.formationLeftM + (
                UNDERPASS_FLOOR_WALL_OVERLAP_M
                * row.replacementFormationBlend
            ))
        : (alignment.kind === 'underpass'
            && alignment.definition.replacementCarriagewayOnly
            ? formationHalfWidthM + UNDERPASS_FLOOR_WALL_OVERLAP_M
            : roadHalfWidthM);
    const surfaceRightOffsetM = ownsUnderpassFormation
        ? (sidewalkSides.has('right')
            ? -roadHalfWidthM
            : row => -row.formationRightM - (
                UNDERPASS_FLOOR_WALL_OVERLAP_M
                * row.replacementFormationBlend
            ))
        : -surfaceLeftOffsetM;
    const roadSurfaceLiftM = ownsUnderpassFormation
        ? UNDERPASS_ROAD_SURFACE_LIFT_M
        : 0.02;
    addMesh(
        root,
        applyWorldUvs(
            structureOnly
                ? buildStructureSurface(
                    rows,
                    surfaceLeftOffsetM,
                    surfaceRightOffsetM,
                    roadSurfaceLiftM,
                    UNDERPASS_ROAD_JOIN_OVERLAP_M,
                )
                : buildSurface(
                    rows,
                    surfaceLeftOffsetM,
                    surfaceRightOffsetM,
                    roadSurfaceLiftM,
                    ownsUnderpassFormation ? UNDERPASS_ROAD_JOIN_OVERLAP_M : 0,
                ),
            ASPHALT_UV_PER_M,
        ),
        materials.asphalt,
        `RoadAlignmentSurface:${alignment.id}`,
        { walkable: true },
    );
    if (alignment.definition.replacementCarriagewayOnly) {
        for (const band of companionSidewalkBands) {
            const outerOffsetM = band.side === 'left'
                ? row => row.formationLeftM + (
                    UNDERPASS_FLOOR_WALL_OVERLAP_M
                    * row.replacementFormationBlend
                )
                : row => -row.formationRightM - (
                    UNDERPASS_FLOOR_WALL_OVERLAP_M
                    * row.replacementFormationBlend
                );
            const sidewalkEdgeM = (
                band.side === 'left' ? roadHalfWidthM : -roadHalfWidthM
            ) + (
                band.side === 'left'
                    ? UNDERPASS_SIDEWALK_CURB_WIDTH_M
                    : -UNDERPASS_SIDEWALK_CURB_WIDTH_M
            );
            const sidewalkLeftOffsetM = band.side === 'left'
                ? outerOffsetM
                : sidewalkEdgeM;
            const sidewalkRightOffsetM = band.side === 'left'
                ? sidewalkEdgeM
                : outerOffsetM;
            const includeSegment = (a, b) => !junctionGapAtStation(
                alignment,
                band.side,
                (a.s + b.s) * 0.5,
            );
            addMesh(
                root,
                applyWorldUvs(
                    structureOnly
                        ? buildStructureSurface(
                            rows,
                            sidewalkLeftOffsetM,
                            sidewalkRightOffsetM,
                            UNDERPASS_SIDEWALK_SURFACE_LIFT_M,
                            UNDERPASS_ROAD_JOIN_OVERLAP_M,
                            includeSegment,
                        )
                        : buildSurface(
                            rows,
                            sidewalkLeftOffsetM,
                            sidewalkRightOffsetM,
                            UNDERPASS_SIDEWALK_SURFACE_LIFT_M,
                            UNDERPASS_ROAD_JOIN_OVERLAP_M,
                            includeSegment,
                        ),
                    SIDEWALK_UV_PER_M,
                ),
                materials.sidewalk,
                `RoadUnderpassSidewalk:${alignment.id}:${band.side}`,
                { walkable: true },
            );
        }
        addMesh(
            root,
            buildUnderpassSidewalkCurbs(
                rows,
                companionSidewalkBands,
                {
                    structureOnly,
                    includeBandSegment: (band, a, b) => !junctionGapAtStation(
                        alignment,
                        band.side,
                        (a.s + b.s) * 0.5,
                    ),
                },
            ),
            materials.concrete,
            `RoadUnderpassCurbs:${alignment.id}`,
            { castShadow: true },
        );
        return;
    }
    const sidewalkOnRight = crossSection.sidewalkSide === 'right';
    const sidewalkLeft = sidewalkOnRight ? -roadHalfWidthM : formationHalfWidthM;
    const sidewalkRight = sidewalkOnRight ? -formationHalfWidthM : roadHalfWidthM;
    addMesh(
        root,
        applyWorldUvs(
            buildSurface(rows, sidewalkLeft, sidewalkRight, 0.035),
            SIDEWALK_UV_PER_M,
        ),
        materials.sidewalk,
        `RoadAlignmentSidewalk:${alignment.id}`,
        { walkable: true },
    );
    const vergeLeft = sidewalkOnRight ? formationHalfWidthM : -roadHalfWidthM;
    const vergeRight = sidewalkOnRight ? roadHalfWidthM : -formationHalfWidthM;
    addMesh(
        root,
        applyWorldUvs(
            buildSurface(rows, vergeLeft, vergeRight, 0.025),
            GRASS_UV_PER_M,
        ),
        materials.earth,
        `RoadAlignmentVerge:${alignment.id}`,
    );
    const medianHalfWidthM = Number(crossSection.medianHalfWidthM) || 0;
    if (medianHalfWidthM > 0) {
        addMesh(
            root,
            applyWorldUvs(
                buildSurface(rows, medianHalfWidthM, -medianHalfWidthM, 0.04),
                GRASS_UV_PER_M,
            ),
            materials.earth,
            `RoadAlignmentMedian:${alignment.id}`,
        );
    }
    const cyclewayWidthM = Number(crossSection.cyclewayWidthM) || 0;
    const cyclewayOffsetM = Number(crossSection.cyclewayOffsetM) || 0;
    if (cyclewayWidthM > 0) {
        addMesh(
            root,
            buildSurface(
                rows,
                cyclewayOffsetM + cyclewayWidthM * 0.5,
                cyclewayOffsetM - cyclewayWidthM * 0.5,
                0.045,
            ),
            materials.redPaint,
            `RoadAlignmentCycleway:${alignment.id}`,
        );
    }
    const curbOffsets = [
        -roadHalfWidthM,
        roadHalfWidthM,
        ...(medianHalfWidthM > 0 ? [-medianHalfWidthM, medianHalfWidthM] : []),
    ];
    addMesh(
        root,
        buildCurbs(rows, curbOffsets),
        materials.concrete,
        `RoadAlignmentCurbs:${alignment.id}`,
        { castShadow: true },
    );
    for (const offset of curbOffsets) {
        addMesh(
            root,
            buildSurface(rows, offset + 0.06, offset - 0.06, 0.055),
            materials.whitePaint,
            `RoadAlignmentMarking:${alignment.id}`,
            { receiveShadow: false },
        );
    }
    addMesh(
        root,
        applyWorldUvs(buildEarthwork(rows), GRASS_UV_PER_M),
        materials.earth,
        `RoadAlignmentEarthwork:${alignment.id}`,
        { castShadow: true },
    );
}

function createAlignmentBuildTask(
    alignment,
    alignments,
    buildMaterials,
    tramCorridorEnvelope,
    formation = roadFormationModel,
) {
    const root = new THREE.Group();
    root.name = `RoadGradeSeparation:${alignment.id}`;
    noteRoadStructureCompiledSource(root, alignment);
    const alignmentDefinition = alignment.definition || {};
    let alignmentSceneYRange = null;
    for (const sample of alignment.samples || []) {
        const sceneY = Number(sample?.y);
        if (!Number.isFinite(sceneY)) continue;
        if (!alignmentSceneYRange) {
            alignmentSceneYRange = { start: sceneY, end: sceneY, min: sceneY, max: sceneY };
            continue;
        }
        alignmentSceneYRange.end = sceneY;
        alignmentSceneYRange.min = Math.min(alignmentSceneYRange.min, sceneY);
        alignmentSceneYRange.max = Math.max(alignmentSceneYRange.max, sceneY);
    }
    root.userData.roadVerticalAlignment = {
        id: alignment.id,
        kind: alignment.kind,
        source: alignmentDefinition.source || 'authored',
        memberOsmIds: alignmentDefinition.memberOsmIds || [],
        replaceRoadSurfaceOsmIds: alignmentDefinition.replaceRoadSurface
            ? alignmentDefinition.replaceRoadSurfaceOsmIds || Array.from(alignment.memberOsmIds || []) : [],
        crossingCount: alignmentDefinition.crossings?.length || 0,
        crossingUpperOsmIds: Array.from(new Set(
            (alignmentDefinition.crossings || []).flatMap(
                crossing => (crossing.upperOsmIds || []).map(String),
            ),
        )),
        peakElevationAslM: alignmentDefinition.profile?.peakElevationAslM ?? null,
        sceneYRange: alignmentSceneYRange,
    };
    const { roadHalfWidthM, formationHalfWidthM } = alignmentHalfWidths(alignment);
    const rows = sampleRows(
        alignment,
        alignments,
        roadStructureFormationOffsetsM(
            alignment,
            alignments,
            formationHalfWidthM,
        ),
        tramCorridorEnvelope,
    );
    const stages = [];
    let stageDetail = '';
    if (rows.length >= 2
        && alignment.definition.renderStructure !== false) {
        stages.push(() => {
            addReplacementRoad(
                root,
                alignment,
                rows,
                buildMaterials,
                alignments,
            );
            return true;
        });
    }
    if (rows.length >= 2 && alignment.definition.renderStructure !== false) {
        if (alignment.kind === 'overpass') {
            stages.push(
                () => {
                    // The streamed road/path polygons own the visible top, but
                    // their raised approaches still need physical fill beneath
                    // them. Replacement alignments already emit this mesh in
                    // addReplacementRoad; normal OSM overpasses need it here.
                    if (!alignment.definition.replaceRoadSurface) {
                        addMesh(
                            root,
                            applyWorldUvs(
                                buildEarthwork(rows, { closeEnds: false }),
                                GRASS_UV_PER_M,
                            ),
                            buildMaterials.earth,
                            `RoadOverpassApproachEarthwork:${alignment.id}`,
                            { castShadow: true },
                        );
                    }
                    return true;
                },
                () => {
                    addMesh(
                        root,
                        applyWorldUvs(
                            buildBridgeSidewalkSurface(
                                rows,
                                roadHalfWidthM,
                                alignment,
                                alignments,
                            ),
                            SIDEWALK_UV_PER_M,
                        ),
                        buildMaterials.sidewalk,
                        `RoadOverpassSidewalkSurface:${alignment.id}`,
                        { walkable: true },
                    );
                    return true;
                },
                () => {
                    addMesh(
                        root,
                        buildBridgeSupportSurface(rows),
                        buildMaterials.bridgeSupport,
                        `RoadOverpassSupportSurface:${alignment.id}`,
                        { walkable: true },
                    );
                    return true;
                },
                () => {
                    addMesh(
                        root,
                        buildBridgeDeck(rows),
                        buildMaterials.concrete,
                        `RoadOverpassDeck:${alignment.id}`,
                        { castShadow: true },
                    );
                    return true;
                },
                () => {
                    addBridgeSafetyFences(root, rows, buildMaterials.metal);
                    return true;
                },
                () => {
                    stageDetail = 'supports';
                    // Clearance sampling reads the formation index. A dirty
                    // model otherwise completes its entire city generation in
                    // the first pillar query, turning this one stage into a
                    // 100+ ms queue item. Advance the same cooperative build
                    // contract roads use before placing any supports.
                    if (formation?.hasPendingBuild?.() === true) {
                        const formationStatus = formation
                            .stepPendingBuildPreparation?.();
                        stageDetail = formation
                            .pendingBuildPreparationPhase?.()
                            || 'supports formation setup';
                        if (formationStatus === 'more') return false;
                    }
                    addBridgeSupports(root, alignment, rows, buildMaterials.concrete, formation);
                    return true;
                },
                () => {
                    const start = nearestStructureBoundary(
                        rows,
                        alignment.structureStartM,
                    );
                    if (start) addAbutment(root, start, buildMaterials.concrete);
                    return true;
                },
                () => {
                    const end = nearestStructureBoundary(
                        rows,
                        alignment.structureEndM,
                    );
                    if (end) addAbutment(root, end, buildMaterials.concrete);
                    return true;
                },
            );
        } else {
            const clearHeightM = Number(alignment.definition.clearHeightM)
                || TUNNEL_CLEAR_HEIGHT_M;
            const roofDepthM = Number(alignment.definition.roofDepthM)
                || TUNNEL_ROOF_DEPTH_M;
            const openCut = alignment.definition.structureMode === 'open-cut';
            // Covered rows carry fill and a box; open "structure" rows are a
            // trench (the grade runouts descend inside the tagged span). The
            // box, its portals, and the wall skip all read this. Bores decide
            // covered by station (fixed portal carve), dips by measured cover
            // — one rule shared with the terrain cutout builder.
            for (const row of rows) {
                row.covered = !openCut
                    && isCoveredStructureSample(alignment, row, clearHeightM, roofDepthM);
            }
            if (alignment.definition.replacementCarriagewayOnly) {
                let wallBuilder = null;
                stages.push(() => {
                    if (!wallBuilder) {
                        wallBuilder = createUnderpassApproachWallBuilder(
                            rows,
                            alignment.terrainSceneYAtLocal,
                            clearHeightM,
                            roofDepthM,
                            alignment,
                        );
                    }
                    const result = wallBuilder.step();
                    if (!result.done) return false;
                    addMesh(
                        root,
                        result.geometry.wall,
                        buildMaterials.concrete,
                        `RoadUnderpassApproachWalls:${alignment.id}`,
                        { castShadow: false, receiveShadow: false },
                    );
                    addMesh(
                        root,
                        applyWorldUvs(
                            result.geometry.collar,
                            buildMaterials.terrainCollar.userData.worldUvPerM,
                        ),
                        buildMaterials.terrainCollar,
                        `RoadUnderpassTerrainCollar:${alignment.id}`,
                        { castShadow: false, receiveShadow: true },
                    );
                    return true;
                });
            }
            if (!openCut) {
                stages.push(
                    () => {
                        const boxGeometry = buildTunnelBox(
                            rows,
                            clearHeightM,
                            roofDepthM,
                        );
                        if (boxGeometry) {
                            addMesh(
                                root,
                                boxGeometry,
                                buildMaterials.concrete,
                                `RoadUnderpassBox:${alignment.id}`,
                                // The roof still occludes daylight, but the sealed walls
                                // must not receive car shadows through non-casting terrain.
                                { castShadow: true, receiveShadow: false },
                            );
                        }
                        return true;
                    },
                    () => {
                        // One portal pair per BURIED run: its faces sit where
                        // the fill genuinely starts and ends, not at the
                        // tagged structure-range stations.
                        let previousCovered = false;
                        for (let index = 0; index < rows.length; index++) {
                            const covered = !!rows[index].covered;
                            if (covered && !previousCovered) {
                                addTunnelPortal(
                                    root,
                                    rows[index],
                                    buildMaterials.concrete,
                                    clearHeightM,
                                );
                            }
                            if (!covered && previousCovered) {
                                addTunnelPortal(
                                    root,
                                    rows[index - 1],
                                    buildMaterials.concrete,
                                    clearHeightM,
                                );
                            }
                            previousCovered = covered;
                        }
                        if (previousCovered) {
                            addTunnelPortal(
                                root,
                                rows[rows.length - 1],
                                buildMaterials.concrete,
                                clearHeightM,
                            );
                        }
                        return true;
                    },
                );
            }
        }
    }
    let stageIndex = 0;
    let lastStageIndex = 0;
    return {
        id: alignment.id,
        alignment,
        root,
        committed: false,
        step() {
            if (stageIndex >= stages.length) return true;
            lastStageIndex = stageIndex;
            stageDetail = '';
            if (stages[stageIndex]()) stageIndex += 1;
            return stageIndex >= stages.length;
        },
        phaseLabel() {
            const label = `${alignment.kind} stage ${lastStageIndex + 1}/${stages.length}`;
            return stageDetail ? `${label}:${stageDetail}` : label;
        },
    };
}

function createRemovalTask(id) {
    return {
        id,
        alignment: null,
        root: null,
        committed: false,
        step: () => true,
    };
}

function alignmentBounds(alignment) {
    if (!alignment || !Array.isArray(alignment.samples)) return null;
    return alignment.samples.reduce((bounds, sample) => ({
        minX: Math.min(bounds.minX, sample.x),
        minZ: Math.min(bounds.minZ, sample.z),
        maxX: Math.max(bounds.maxX, sample.x),
        maxZ: Math.max(bounds.maxZ, sample.z),
    }), {
        minX: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxZ: -Infinity,
    });
}

function alignmentTaskPriority(task) {
    const bounds = task.bounds;
    if (!bounds) return 0;
    const dx = buildFocusX < bounds.minX
        ? bounds.minX - buildFocusX
        : buildFocusX > bounds.maxX
            ? buildFocusX - bounds.maxX
            : 0;
    const dz = buildFocusZ < bounds.minZ
        ? bounds.minZ - buildFocusZ
        : buildFocusZ > bounds.maxZ
            ? buildFocusZ - bounds.maxZ
            : 0;
    return -(dx * dx + dz * dz);
}

function replaceAlignmentGroup(task) {
    const previous = alignmentGroups.get(task.id) || null;
    const rollback = () => {
        if (previous) alignmentGroups.set(task.id, previous);
        else alignmentGroups.delete(task.id);
    };
    const replacementKey = roadStructurePublicationKey(task.id);
    const generation = task.generation;
    const publicationTicket = surfacePublications?.begin?.({
        key: replacementKey,
        generation,
        parent: group,
        retire: (_context, root) => disposeGroup(root),
    }) || null;
    if (task.root?.children.length > 0) {
        annotateRoadStructureInspection(task.root, {
            replacementKey,
            generation,
        });
        const commit = () => { alignmentGroups.set(task.id, task.root); };
        if (publicationTicket) {
            try {
                publicationTicket.publish(task.root, { commit, rollback });
            } catch (error) {
                // The publication registry already discarded the detached
                // candidate. Prevent queue cancellation from disposing it a
                // second time while preserving the prior active alignment.
                task.root = null;
                throw error;
            }
        } else {
            group.add(task.root);
            commit();
            if (previous) disposeGroup(previous);
        }
    } else {
        if (task.root) disposeGroup(task.root);
        // An already absent structure is a successful clear. Map.delete's
        // change flag is not the publication transaction's success result.
        const commit = () => { alignmentGroups.delete(task.id); };
        if (publicationTicket) publicationTicket.clear({ commit, rollback });
        else {
            commit();
            if (previous) disposeGroup(previous);
        }
    }
    task.committed = true;
}

function roadStructureInspectionSpec(rawName) {
    const name = String(rawName || 'Road structure');
    if (/embank|terrain|collar|slope|batter/i.test(name)) return {
        id: 'road-structure-earthworks',
        label: 'Road-structure earthworks',
        category: 'Civil works',
        source: 'world/road-grade-separations.js · cut/fill transition geometry',
        order: 143,
    };
    if (/sidewalk|walkway|curb/i.test(name)) return {
        id: 'road-structure-sidewalks',
        label: 'Structure sidewalks and curbs',
        category: 'Transport',
        source: 'world/road-grade-separations.js · carried pedestrian surfaces',
        order: 144,
    };
    if (/tunnel|underpass|wall|portal|floor/i.test(name)) return {
        id: 'road-underpasses',
        label: 'Road underpasses and walls',
        category: 'Civil works',
        source: 'world/road-grade-separations.js · underpass/tunnel structures',
        order: 145,
    };
    if (/bridge|deck|pier|support|parapet|fence|girder/i.test(name)) return {
        id: 'road-bridges',
        label: 'Road bridges and supports',
        category: 'Civil works',
        source: 'world/road-grade-separations.js · bridge structures',
        order: 146,
    };
    return {
        id: 'road-structures-other',
        label: 'Other road structures',
        category: 'Civil works',
        source: 'world/road-grade-separations.js · solved vertical alignment',
        order: 147,
    };
}

function annotateRoadStructureInspection(root, { replacementKey, generation }) {
    const colliderState = root.userData.groundColliderState ??= { published: false };
    root.traverse((object) => {
        if (!object?.isMesh) return;
        // Migrate the physical floor receivers together. Lateral civil walls
        // keep their current collision adapter until it consumes cut faces;
        // turning a clipped box into an unrecognised BufferGeometry here
        // would otherwise remove walk collision outside the opening too.
        const materialClaim = object.material?.userData?.surfaceClaim;
        const physical = object.userData?.walkableSurface === true
            || materialClaim?.capabilities?.support === true;
        object.userData.groundPhysicalReceiver = physical;
        if (physical) {
            object.userData.groundColliderFamily = 'authored-surfaces';
            object.userData.groundColliderState = colliderState;
        }
        markInspectionLayer(object, roadStructureInspectionSpec(object.name));
        if (materialClaim) {
            markSurfaceClaim(object, reviseSurfaceClaim(materialClaim, {
                ownerId: root?.name || null,
                structureId: root?.name || null,
                replacementKey,
                generation,
            }));
            return;
        }
        markSurfaceClaim(object, {
            surfaceClass: SURFACE_CLASS.STRUCTURE,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
            ownerId: root?.name || null,
            sourceId: 'world/road-grade-separations.js',
            structureId: root?.name || null,
            replacementKey,
            generation,
            supportReady: physical,
        });
    });
}

function disposeUncommittedTasks(tasks) {
    for (const task of tasks) {
        if (!task.committed && task.root) disposeGroup(task.root);
    }
}

function ensureSessionResources() {
    if (!group) {
        group = new THREE.Group();
        group.name = 'RoadGradeSeparations';
        markInspectionLayer(group, {
            id: 'road-structures-container',
            label: 'Road structure renderer',
            category: 'Civil works',
            source: 'world/road-grade-separations.js · solved road vertical alignments',
            order: 140,
            containerOnly: true,
        });
        scene.add(group);
    }
    if (!materials) {
        materials = createMaterials();
        registerShared(...Object.values(materials));
    }
}

function disposeSessionResources() {
    for (const material of plannerGeometryMaterials.take()) { unregisterShared(material); material.dispose(); }
    if (group) disposeGroup(group);
    group = null;
    alignmentGroups.clear();
    if (materials) {
        const values = Object.values(materials);
        unregisterShared(...values);
        for (const material of values) material.dispose();
        materials = null;
    }
}

const ROAD_STRUCTURE_MATERIAL_PREWARM_READY_LABEL = 'road-structure-material-prewarm';

function* createRoadStructureMaterialPrewarm(root, geometry) {
    for (const [name, material] of Object.entries(materials || {})) {
        if (!material || material.visible === false) continue;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `RoadStructureMaterialPrewarm:${name}`;
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        root.add(mesh);
        yield { phase: 'road-structure-material-prewarm:create', name };
    }
    yield* prewarmDetachedObject(root, {
        renderer,
        camera,
        targetScene: scene,
        asyncShaders: true,
        label: ROAD_STRUCTURE_MATERIAL_PREWARM_READY_LABEL,
        uploadBatch: 1,
        sliceMs: 2,
        uploadGeometry: false,
    });
}

function settleRoadStructureMaterialPrewarm(state) {
    if (!state || state.settled) return;
    state.settled = true;
    state.iterator?.return?.();
    state.root.clear();
    state.geometry.dispose();
    if (materialPrewarmState === state) materialPrewarmState = null;
    noteWorldQueueIdle(ROAD_STRUCTURE_MATERIAL_PREWARM_READY_LABEL);
}

function startRoadStructureMaterialPrewarm() {
    if (materialPrewarmState) settleRoadStructureMaterialPrewarm(materialPrewarmState);
    const root = new THREE.Group();
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const state = {
        root,
        geometry,
        iterator: createRoadStructureMaterialPrewarm(root, geometry),
        job: null,
        settled: false,
    };
    materialPrewarmState = state;
    noteWorldQueueActive(ROAD_STRUCTURE_MATERIAL_PREWARM_READY_LABEL);
    const settle = () => settleRoadStructureMaterialPrewarm(state);
    state.job = buildQueue.enqueue([state], (item) => {
        const outcome = item.iterator.next();
        return outcome.done ? undefined : FRAME_CHUNK_DEFER_ITEM;
    }, {
        onComplete: settle,
        onCancel: settle,
        onError: settle,
        maxItemsPerFrame: 1,
        maxItemsPerSettledFrame: 1,
        priority: Number.MAX_SAFE_INTEGER,
        describeItem: () => 'road structure material GPU prewarm',
    });
}

function retireAlignmentGroups() {
    for (const [alignmentId, root] of alignmentGroups) {
        if (surfacePublications?.retire?.(roadStructurePublicationKey(alignmentId), {
            root,
            reason: 'road-structures-layer-ended',
        })) continue;
        disposeGroup(root);
    }
    alignmentGroups.clear();
}

// Reserve before holding a formation model. Older ordinary structure work
// must be allowed to finish with its own captured inputs first.
function admitRoadStructureGroundGeneration({ isCurrent = () => true } = {}) {
    if (typeof isCurrent !== 'function') throw new TypeError('Structure admission requires validity');
    if (!group || !surfacePublications || !alignmentModel || buildJob || groundGenerationLease) {
        throw Object.assign(new Error('Road structures have older preparation in progress'), { code: 'ground-dependency-busy' });
    }
    const parent = group, sourceModel = alignmentModel, previousRevision = builtRevision;
    const lease = {};
    const localCurrent = () => groundGenerationLease === lease && group === parent
        && alignmentModel === sourceModel && builtRevision === previousRevision && !buildJob;
    const release = () => {
        if (groundGenerationLease !== lease) return false;
        groundGenerationLease = null; return true;
    };
    const admission = Object.freeze({ isCurrent: () => localCurrent() && isCurrent(),
        localCurrent, release, setCancel(cancel) {
            if (typeof cancel !== 'function' || !localCurrent()) throw new Error('Invalid structure admission');
            lease.cancel = cancel;
        } });
    lease.admission = admission; lease.cancel = release;
    groundGenerationLease = lease;
    return admission;
}

// Builds the same civil geometry as requestRebuild. Only publication is handed
// to the common group. The root view is explicit proof for downstream source
// road removal; it never consults the live registry for an unprepared successor.
function* prepareRoadStructureGroundGenerationSteps({ admission, ground, additionalAlignmentIds = [],
    openingChangedBounds = [], maxAlignments, maxSamples, maxObjects, maxGeometryBytes,
    maxVertices, maxTriangles, isCurrent = () => true }) {
    for (const [name, limit] of Object.entries({ maxAlignments, maxSamples, maxObjects, maxGeometryBytes, maxVertices, maxTriangles })) {
        if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError(`Invalid structure limit ${name}`);
    }
    if (groundGenerationLease?.admission !== admission || !admission.isCurrent()) {
        throw Object.assign(new Error('Road structure admission expired'), { code: 'ground-dependency-busy' });
    }
    if (!Object.isFrozen(ground) || typeof ground.isCurrent !== 'function'
        || typeof ground.verticalAlignments?.getAlignments !== 'function'
        || !Object.hasOwn(ground, 'roadFormation') || !Array.isArray(additionalAlignmentIds)
        || !Array.isArray(openingChangedBounds)) {
        admission.release();
        throw new TypeError('Road structures require the complete captured alignment/road graph');
    }
    const tasks = [], entries = [], previousRoots = new Map(), nextRoots = new Map();
    const generation = ++buildGeneration, oldBuilt = builtRevision, oldRequested = requestedRevision;
    const previousSupport = groundSupportRead;
    const previousColliderStates = new Map();
    let held = null, handedOff = false, settled = false, committed = false, upload = null;
    const ownCurrent = () => !settled && !committed && admission.localCurrent()
        && [...previousRoots].every(([id, root]) => (alignmentGroups.get(id) || null) === root);
    const current = () => ownCurrent() && admission.isCurrent() && isCurrent() && held.isCurrent();
    const check = () => {
        if (!current()) throw Object.assign(new Error('Road structure inputs changed'), { code: 'ground-generation-stale' });
    };
    const release = () => { held?.release?.(); held = null; admission.release(); };
    const discard = () => {
        if (settled || committed) return false;
        settled = true; upload?.return?.(); upload = null;
        for (const entry of entries) if (entry.ticket.state === 'pending') entry.ticket.discard();
        disposeUncommittedTasks(tasks);
        release(); return true;
    };
    admission.setCancel(discard);
    try {
        held = retainReadSnapshot(ground, 'road-structure-ground-generation');
        const alignments = held.verticalAlignments.getAlignments();
        if (alignments.length > maxAlignments || alignmentGroups.size > maxAlignments) {
            throw Object.assign(new Error('Road structure set exceeds admission'), { code: 'ground-generation-capacity' });
        }
        const byId = new Map(), forced = new Set(additionalAlignmentIds);
        for (const alignment of alignments) {
            if (!alignment?.id || byId.has(alignment.id) || !Array.isArray(alignment.samples)
                || alignment.samples.length > maxSamples) {
                throw Object.assign(new Error('Invalid or excessive structure alignment'), { code: 'ground-generation-capacity' });
            }
            byId.set(alignment.id, alignment);
            yield { phase: 'road-structure-admission' }; check();
        }
        for (const id of forced) if (!byId.has(id) && !alignmentGroups.has(id)) {
            throw new TypeError('Unknown affected road structure');
        }
        const ids = new Set([...alignmentGroups.keys(), ...byId.keys()]);
        if (ids.size > maxAlignments || additionalAlignmentIds.length > maxAlignments) {
            throw Object.assign(new Error('Road structure replacement set exceeds admission'), { code: 'ground-generation-capacity' });
        }
        for (const id of ids) {
            const previous = alignmentGroups.get(id) || null, alignment = byId.get(id);
            previousRoots.set(id, previous);
            const previousRead = previous && structureReceiverReads.get(previous);
            const openingChanged = previousRead ? openingChangedBounds.some(a => previousRead.surfaces.some(({ bounds: b }) =>
                a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ)) : !held.openings?.empty && !!held.openings;
            if (previous && alignment && !forced.has(id) && !openingChanged && roadStructureMatchesAlignment(previous, alignment)) {
                nextRoots.set(roadStructurePublicationKey(id), Object.freeze({ root: previous }));
                continue;
            }
            // An empty resolved alignment is an intentional clear. A partially
            // sampled replacement is not allowed to open its old backstop.
            if (alignment && alignment.definition.renderStructure !== false && alignment.samples.length < 2) {
                throw Object.assign(new Error('Road structure lacks complete alignment evidence'), { code: 'road-structure-evidence-unavailable' });
            }
            const task = alignment ? createAlignmentBuildTask(alignment, alignments, materials,
                structuralTramCorridorEnvelope, held.roadFormation) : createRemovalTask(id);
            task.generation = generation; tasks.push(task);
            yield { phase: 'road-structure-create', id }; check();
        }
        const buffers = new Set(); let bytes = 0, objects = 0;
        for (const task of tasks) {
            while (!task.step()) { yield { phase: task.phaseLabel?.(), id: task.id }; check(); }
            if (task.root?.children.length) {
                annotateRoadStructureInspection(task.root, { replacementKey: roadStructurePublicationKey(task.id), generation });
                if (held.openings && !held.openings.empty) {
                    // These are detached compiler outputs. Clipping precedes
                    // both GPU upload and the captured walk/physics face read.
                    const pending = [{ object: task.root, parentMatrix: new THREE.Matrix4() }];
                    while (pending.length) {
                        const { object, parentMatrix } = pending.pop();
                        const local = object.matrixAutoUpdate
                            ? new THREE.Matrix4().compose(object.position, object.quaternion, object.scale) : object.matrix;
                        const worldMatrix = new THREE.Matrix4().multiplyMatrices(parentMatrix, local);
                        for (const child of object.children) pending.push({ object: child, parentMatrix: worldMatrix });
                        if (!object.isMesh || !object.userData.groundPhysicalReceiver) continue;
                        const clipped = yield* clipReceiverMeshOpeningsSteps({ mesh: object, worldMatrix, openingRead: held.openings,
                            maxObjects, maxVertices, maxTriangles, maxGeometryBytes, isCurrent: current });
                        clipped.material = plannerGeometryMaterials.get(clipped.material);
                        if (clipped !== object) {
                            const parent = object.parent;
                            for (const child of [...object.children]) clipped.add(child);
                            parent.remove(object); parent.add(clipped);
                            object.geometry.dispose();
                        }
                        yield { phase: 'road-structure-openings', id: task.id }; check();
                    }
                    annotateRoadStructureInspection(task.root, { replacementKey: roadStructurePublicationKey(task.id), generation });
                }
                const stack = [task.root];
                while (stack.length) {
                    const object = stack.pop();
                    if (++objects > maxObjects) throw Object.assign(new Error('Road structure object budget exceeded'), { code: 'ground-generation-capacity' });
                    for (const child of object.children || []) stack.push(child);
                    for (const attribute of [object.geometry?.index, ...Object.values(object.geometry?.attributes || {}), object.instanceMatrix, object.instanceColor]) {
                        const buffer = attribute?.array?.buffer;
                        if (buffer && !buffers.has(buffer)) { buffers.add(buffer); bytes += buffer.byteLength; }
                    }
                    if (bytes > maxGeometryBytes) throw Object.assign(new Error('Road structure geometry budget exceeded'), { code: 'ground-generation-capacity' });
                    let deadline = performance.now() + .5;
                    for (const coordinate of object.geometry?.attributes.position?.array || []) {
                        if (!Number.isFinite(coordinate)) throw Object.assign(new Error('Road structure has missing geometry evidence'), { code: 'road-structure-evidence-unavailable' });
                        if (performance.now() >= deadline) {
                            yield { phase: 'road-structure-evidence', id: task.id }; check(); deadline = performance.now() + .5;
                        }
                    }
                    yield { phase: 'road-structure-resource-admission', id: task.id }; check();
                }
                upload = prewarmDetachedObject(task.root, { renderer, camera, targetScene: scene,
                    asyncShaders: true, label: 'road-structure-ground-generation', uploadBatch: 1, sliceMs: 1 });
                for (;;) {
                    check(); const next = upload.next(); if (next.done) break;
                    yield next.value;
                }
                upload = null;
                nextRoots.set(roadStructurePublicationKey(task.id), Object.freeze({ root: task.root, generation }));
            } else if (task.root) { disposeGroup(task.root); task.root = null; }
            const oldRoot = previousRoots.get(task.id);
            const ticket = surfacePublications.begin({ key: roadStructurePublicationKey(task.id), generation,
                parent: group, retire: (_context, root) => disposeGroup(root) });
            entries.push({ ticket, ...(task.root ? { root: task.root } : { clear: true }), isCurrent: current,
                commit() {
                    // Other entries may have promoted their slots already.
                    // The registry preflight checked the complete graph.
                    if (settled || committed || !admission.localCurrent()
                        || (alignmentGroups.get(task.id) || null) !== oldRoot) return false;
                    if (task.root) alignmentGroups.set(task.id, task.root); else alignmentGroups.delete(task.id);
                    task.committed = true; return true;
                }, rollback() {
                    if (oldRoot) alignmentGroups.set(task.id, oldRoot); else alignmentGroups.delete(task.id);
                    task.committed = false;
                }, discard() {},
            });
        }
        const supportReads = [];
        let supportVertices = 0, supportTriangles = 0;
        for (const { root } of nextRoots.values()) {
            previousColliderStates.set(root, root.userData.groundColliderState.published);
            let read = structureReceiverReads.get(root);
            if (!read) {
                read = yield* captureReceiverMeshReadSteps({ root, revision: generation,
                    include: mesh => mesh.userData.groundPhysicalReceiver === true,
                    maxObjects, maxVertices, maxTriangles, isCurrent: current });
                structureReceiverReads.set(root, read);
            }
            for (const surface of read.surfaces) {
                supportVertices += surface.positions.length / 3;
                supportTriangles += (surface.indices?.length ?? surface.positions.length / 3) / 3;
                if (supportVertices > maxVertices || supportTriangles > maxTriangles) {
                    throw Object.assign(new Error('Complete structure support capacity exceeded'), { code: 'ground-generation-capacity' });
                }
                yield { phase: 'road-structure-support-admission' }; check();
            }
            supportReads.push(read);
        }
        const supportRead = yield* composeReceiverSupportReadsSteps(previousSupport, supportReads, { isCurrent: current });
        const revision = held.verticalAlignments.revision;
        entries.push({ ticket: surfacePublications.begin({ key: 'roads:structures:state', generation }), clear: true,
            isCurrent: current, commit() {
                if (settled || committed || !admission.localCurrent()) return false;
                committed = true; builtRevision = revision; requestedRevision = revision;
                groundSupportRead = supportRead;
                for (const { root } of nextRoots.values()) root.userData.groundColliderState.published = true;
                return true;
            }, rollback() {
                committed = false; builtRevision = oldBuilt; requestedRevision = oldRequested; groundSupportRead = previousSupport;
                for (const [root, wasPublished] of previousColliderStates) root.userData.groundColliderState.published = wasPublished;
            }, discard });
        check(); handedOff = true;
        return Object.freeze({ entries, isCurrent: current, discard,
            supportRead,
            structurePublications: Object.freeze({ getActive: key => nextRoots.get(key) || null }),
            usage: Object.freeze({ alignments: tasks.length, objects, geometryBytes: bytes }),
            finalize() {
                if (settled || !committed) return false;
                settled = true; release(); return true;
            },
        });
    } finally { if (!handedOff) discard(); }
}

function requestRebuild() {
    if (!alignmentModel || groundGenerationLease) return;
    ensureSessionResources();
    const revision = alignmentModel.revision;
    requestedRevision = revision;
    const generation = ++buildGeneration;
    if (buildJob) buildQueue.cancel(buildJob);
    buildJob = null;

    const changes = alignmentModel.getChangesSince(builtRevision);
    const inputs = alignmentModel.captureBuildInputs('road-structure-build');
    const alignments = inputs.alignments;
    const tasks = [];
    try {
        const byId = new Map(alignments.map(alignment => [alignment.id, alignment]));
        const changedIds = changes.full || builtRevision < 0
            ? new Set([...alignmentGroups.keys(), ...byId.keys()])
            : new Set(changes.ids || []);
        if (changedIds.size === 0) {
            builtRevision = revision;
            inputs.release();
            return;
        }
        for (const id of changedIds) {
            const alignment = byId.get(id);
            const task = alignment
                ? createAlignmentBuildTask(
                    alignment,
                    alignments,
                    materials,
                    structuralTramCorridorEnvelope,
                )
                : createRemovalTask(id);
            task.bounds = alignmentBounds(alignment);
            task.generation = generation;
            tasks.push(task);
        }
        const job = buildQueue.enqueue(tasks, (task) => {
            if (!alignmentModel || alignmentModel.revision !== revision || generation !== buildGeneration) {
                buildQueue.cancel(job);
                return undefined;
            }
            if (!task.step()) return FRAME_CHUNK_REPEAT_ITEM;
            replaceAlignmentGroup(task);
            return undefined;
        }, {
            maxItemsPerFrame: 1,
            describeItem: task => task.phaseLabel?.() || `remove ${task.id}`,
            itemPriority: alignmentTaskPriority,
            reorderBetweenItems: true,
            onComplete: () => {
                buildJob = null;
                inputs.release();
                if (!alignmentModel
                    || generation !== buildGeneration
                    || alignmentModel.revision !== revision) {
                    disposeUncommittedTasks(tasks);
                    return;
                }
                builtRevision = revision;
            },
            onCancel: () => {
                if (generation === buildGeneration) buildJob = null;
                disposeUncommittedTasks(tasks);
                inputs.release();
            },
            onError: () => {
                if (generation === buildGeneration) buildJob = null;
                disposeUncommittedTasks(tasks);
                inputs.release();
            },
        });
        buildJob = job;
    } catch (error) {
        disposeUncommittedTasks(tasks);
        inputs.release();
        throw error;
    }
}

export const roadGradeSeparationsLayer = {
    groundReady: () => !!group && !!alignmentModel && !buildJob && !groundGenerationLease,
    manageGroundPublications() { groundManaged = true; },
    admitGroundGeneration: admitRoadStructureGroundGeneration,
    prepareGroundGenerationSteps: prepareRoadStructureGroundGenerationSteps,
    beginSession(ctx) {
        groundManaged = false;
        groundSupportRead = EMPTY_RECEIVER_SUPPORT_READ;
        groundGenerationLease?.cancel();
        surfacePublications = ctx?.surfacePublications || null;
        alignmentModel = ctx?.roadVerticalAlignments || null;
        roadFormationModel = ctx?.roadFormation || null;
        structuralTramCorridorEnvelope = createStructuralTramCorridorEnvelopeIndex(
            ctx?.otherTracks || [],
            {
                anchorLat: ctx?.anchorLat,
                anchorLon: ctx?.anchorLon,
                halfWidthForFeature: feature => getSingleTrackBedHalfWidthMeters(
                    feature?.properties || {},
                ),
            },
        );
        builtRevision = -1;
        requestedRevision = -1;
        buildFocusX = 0;
        buildFocusZ = 0;
        ensureSessionResources();
        startRoadStructureMaterialPrewarm();
        requestRebuild();
    },
    onFrame(_pose, local) {
        buildFocusX = Number.isFinite(local?.x) ? local.x : 0;
        buildFocusZ = Number.isFinite(local?.z) ? local.z : 0;
        if (!groundManaged && !groundGenerationLease && alignmentModel && alignmentModel.revision !== requestedRevision) {
            requestRebuild();
        }
    },
    endSession() {
        groundManaged = false;
        groundGenerationLease?.cancel();
        buildGeneration += 1;
        if (buildJob) buildQueue.cancel(buildJob);
        buildJob = null;
        buildQueue.clear();
        if (materialPrewarmState) {
            settleRoadStructureMaterialPrewarm(materialPrewarmState);
        }
        retireAlignmentGroups();
        disposeSessionResources();
        alignmentModel = null;
        roadFormationModel = null;
        structuralTramCorridorEnvelope = null;
        builtRevision = -1;
        requestedRevision = -1;
        surfacePublications = null;
        groundSupportRead = EMPTY_RECEIVER_SUPPORT_READ;
    },
};
