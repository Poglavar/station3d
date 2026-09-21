// Renders light and heavy rail within a moving maxRadiusM window around the
// cab. Street tram uses slim rails over a paved bed with flush edge bands;
// mainline rail uses taller/wider steel, concrete sleepers and ballast.
//
// Also paints a narrow cobblestone trackbed strip under each segment
// (a gauge/count-derived distance on each side of the centreline) so the
// gauge-and-shoulder area looks distinct from the surrounding asphalt
// without claiming the entire OSM tram road buffer width.
//
// The full route remains available to driver physics and vertical-profile
// design, while only the nearby render geometry is rebuilt during the ride.

import * as THREE from 'three';
import { getApiBase } from '../core/api.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
import { ensurePersistentRenderRootAttached } from '../core/persistent-render-root.js';
import {
    disposeGroup,
    disposeGroupCooperatively,
    registerShared,
} from '../core/dispose.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import { decodeRoadTile } from '../core/road-tile-binary.js';
import { smoothRailTrackFeatures } from './rail-track-smoothing.js';
import {
    mergeStreamedRailFeatureTiles,
    railFeaturesFromRoadSurfaces,
    streamedRailFeatureSetSignature,
} from '../core/streamed-rail-features.js';
import {
    HEAVY_RAIL_DISTANT_SLEEPER_TILE_LENGTH_M,
    HEAVY_RAIL_DISTANT_SLEEPER_TILE_WIDTH_M,
    heavyRailDistantSleeperMask,
    planHeavyRailSleepers,
} from '../core/heavy-rail-dressing.js';
import {
    partitionRailSegmentsIntoCellsSteps,
    changedRailSegmentRenderCellKeys,
    railRenderCellSignature,
    junctionIncidentsFromSegments,
    railRenderCellCenter,
    railSegmentMidpointCellKey,
    railSegmentOwnedCellKeys,
    boundsIntersectAnyRailSegment,
    railSegmentsIntersectingBounds,
    railRenderSegmentBatchesSteps,
} from '../core/rail-render-cells.js';
import {
    RAIL_BUILD_DISPOSITION,
    RAIL_VISUAL_REFRESH_DISPOSITION,
    pendingRailFormationBuildDisposition,
    pendingRailVisualRefreshDisposition,
    railFeatureChords,
    streamedRailRefreshAllowed,
} from '../core/rail-formation-build-policy.js';
import {
    createFrameChunkQueue,
    FRAME_CHUNK_REPEAT_ITEM,
    FRAME_CHUNK_DEFER_ITEM,
    getFrameChunkSequence,
} from '../core/frame-chunk-queue.js';
import {
    buildFormationSurfaceApronGeometryDataSteps,
    buildFormationTerrainCollarGeometryDataSteps,
    buildRetainingWallPositionsSteps,
    buildWallFaceUvsForPositions,
    visibleFormationBoundaryPiecesSteps,
} from '../core/road-formation.js';
import { trianglePositionChunkRanges } from '../core/triangle-geometry-chunks.js';
import { createDalmatianStoneRaster } from '../core/dalmatian-stone-texture.js';
import { createConcreteRaster } from '../core/concrete-texture.js';
import {
    SESSION_CAPABILITY,
    sessionCapabilityEnabled,
} from '../core/session-capabilities.js';
import { ensureRoadIndex } from '../core/road-index.js';
import { getLocation } from '../core/locations.js';
import { isPhotoWorld } from './photoreal.js';
import { detectAtGradeLevelCrossingsSteps } from './level-crossing-detect.js';
import {
    buildTunnelPortalRoofCapFootprint,
    DEFAULT_RENDERED_TUNNEL_CLEAR_HEIGHT_M,
    DEFAULT_TUNNEL_COVER_THRESHOLD_M,
    dedupeRailTunnelPortalMouths,
    isEngineeredRailFeature,
    railBoreHalfWidthM,
    RENDERED_TUNNEL_BED_ABOVE_RAIL_M,
    RailFormationModel,
    TUNNEL_COVER_TOLERANCE_M,
    TUNNEL_PORTAL_TERRAIN_OPENING_INSIDE_M,
} from '../core/rail-formation.js';
import {
    createEmbeddedTramRoadEndpointResolver,
    EMBEDDED_TRAM_MAX_LATERAL_M,
    flagRailFormationBoundarySegmentsForRoadOpeningsSteps,
    flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps,
    isOrdinaryOsmTramFeature,
    isPotentialRoadCarriedTramFeature,
    noteRailCivilGroundMutation,
    railCivilGroundDependencySnapshot,
    railCivilGroundDependencySnapshotSteps,
    roadCarriedTramDeckSignature,
    roadDeckForCarriedTramAtLocal,
    resampleEmbeddedTramRoadSegmentHeights,
    resampleEmbeddedTramRoadSegmentHeightsSteps,
    railViaductPillarClearanceAtLocal,
    roadUnderRailFormationOpenings,
} from '../core/rail-road-grade-separation.js';
import { CIVIL_GROUND_AUTHORITY, changedCivilGroundDependencyBoundsSteps } from '../core/civil-ground-composition.js';
import { railBridgeStyleForLocation } from '../core/rail-bridge-style.js';
import { planSteelBridgeDetailStations } from '../core/rail-steel-bridge-detail.js';
import { extendViaductDeckSamples } from '../core/rail-viaduct-deck.js';
import {
    resolveViaductPierFootingY,
    resolveViaductSupportCandidates,
} from '../core/rail-viaduct-supports.js';
import {
    planTunnelDistanceMarkers,
    TUNNEL_MARKER_CENTRE_ABOVE_FLOOR_M,
} from '../core/tunnel-distance-markers.js';
import { buildTunnelMarkerPlates } from './tunnel-marker-plates.js';
import {
    prepareStationTrackRoutes,
    resolvePlannerStationTrackAnchor,
    splitStationTrackRouteBySegmentOwners,
    stationTrackRouteMatches,
} from '../core/planner-station-track-anchor.js';
import {
    getModelCoveredStationRouteRange,
    modelStationNeedsCoveredRoute,
} from '../core/model-covered-station.js';
import { isAuthoredPlannerRailFeature } from '../core/proposal-track.js';
import {
    getOwnedEndpointTrackSpacingM,
    plannerSegmentOwnerProperties,
    stationFlaresThatSplayTrackCenters,
} from '../core/planner-station-flare.js';
import { camera, renderer, scene } from '../scene/setup.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import {
    canBuildPhotorealRigidStation,
    getPhotorealStationStructure,
    getPhotorealStationStructureRevision,
    isPhotorealRevealed,
} from './photoreal.js';
import { captureProposalMaskSnapshot, isLineStringMaskedByProposals } from './proposals.js';
import { getTrackbedMaterialForRails } from './roads.js';
import {
    isPointInMappedSea,
    mappedSeaSurfaceSceneY,
    subscribeMappedSeaChanges,
} from './water.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { surfacePublicationIdentityForObject } from '../core/surface-publication-registry.js';
import { captureGroundReadSnapshot } from '../core/terrain-snapshot.js';
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { bindRenderOriginShader } from '../core/render-origin.js';
import { installRevisionedMaterialCompilePatch } from '../core/revisioned-material-compile-patch.js';
import { authoredAbsoluteRailSceneY } from '../core/rail-vehicle-elevation.js';
import { buildRailTunnelSpanIndex } from '../core/tunnel-occlusion.js';

// Tunnel and surface trackbed must use one material. A former self-lit tunnel
// variant changed tone at a depth threshold, including in deep open cuts.
// Shadow reception is disabled on the meshes below, so the shared lit material
// remains night-aware without accepting surface-car shadows through a roof.
function getTunnelTrackbedMaterial() {
    return getTrackbedMaterialForRails(RAIL_GRADE_SEPARATED_CLAIM);
}

// Rail-bar steel and the flat-curb band are shared singletons: the trackbed is
// built per render cell, and a fresh material (and curb canvas texture) per
// cell would multiply GPU programs and uploads by the cell count. Shared via
// registerShared so disposeGroup on any one cell leaves the others intact.
let sharedRailBarMaterial = null;
let sharedRailSameLevelStencilMaterial = null;
let sharedHeavyRailBallastTexture = null;
let sharedHeavyRailSleeperMaterial = null;
let sharedHeavyRailSleeperGeometry = null;
const sharedHeavyRailBallastMaterials = new Map();

// One analytical opening, normally disabled. The campaign demolition swaps a
// short real bridge span for animated wreck geometry without rebuilding any
// 600 m rail render cells or hiding the rest of their track. Absolute local
// coordinates survive floating-origin shifts through uRenderOriginXZ.
const campaignRailDemolitionUniforms = {
    uCampaignRailDemolitionEnabled: { value: 0 },
    uCampaignRailDemolitionCenter: { value: new THREE.Vector2() },
    uCampaignRailDemolitionAxis: { value: new THREE.Vector2(0, 1) },
    uCampaignRailDemolitionHalfExtents: { value: new THREE.Vector2(1, 1) },
};
let publishedCampaignRailDemolitionCutout = null;

export function setCampaignRailDemolitionCutout(spec = null) {
    const centerX = Number(spec?.centerX);
    const centerZ = Number(spec?.centerZ);
    const rawAxisX = Number(spec?.axisX);
    const rawAxisZ = Number(spec?.axisZ);
    const halfLengthM = Number(spec?.halfLengthM);
    const halfWidthM = Number(spec?.halfWidthM);
    const axisLength = Math.hypot(rawAxisX, rawAxisZ);
    if (![centerX, centerZ, halfLengthM, halfWidthM].every(Number.isFinite)
        || !(axisLength > 1e-6)
        || !(halfLengthM > 0)
        || !(halfWidthM > 0)) {
        campaignRailDemolitionUniforms.uCampaignRailDemolitionEnabled.value = 0;
        publishedCampaignRailDemolitionCutout = null;
        return null;
    }
    const normalized = Object.freeze({
        centerX,
        centerZ,
        axisX: rawAxisX / axisLength,
        axisZ: rawAxisZ / axisLength,
        halfLengthM,
        halfWidthM,
    });
    campaignRailDemolitionUniforms.uCampaignRailDemolitionCenter.value.set(centerX, centerZ);
    campaignRailDemolitionUniforms.uCampaignRailDemolitionAxis.value.set(
        normalized.axisX,
        normalized.axisZ,
    );
    campaignRailDemolitionUniforms.uCampaignRailDemolitionHalfExtents.value.set(
        halfLengthM,
        halfWidthM,
    );
    campaignRailDemolitionUniforms.uCampaignRailDemolitionEnabled.value = 1;
    publishedCampaignRailDemolitionCutout = normalized;
    return normalized;
}

export function getCampaignRailDemolitionCutout() {
    return publishedCampaignRailDemolitionCutout;
}

function applyCampaignRailDemolitionCutout(material) {
    if (!material) return material;
    installRevisionedMaterialCompilePatch(material, {
        id: 'campaign-rail-demolition-cutout',
        revision: 'v1',
        apply(shader) {
            bindRenderOriginShader(shader);
            Object.assign(shader.uniforms, campaignRailDemolitionUniforms);
            shader.vertexShader = shader.vertexShader
                .replace(
                    '#include <common>',
                    '#include <common>\nvarying vec3 vCampaignRailDemolitionWorldPos;',
                )
                .replace(
                    '#include <displacementmap_vertex>',
                    `#include <displacementmap_vertex>
vec4 campaignRailDemolitionPosition = vec4(transformed, 1.0);
#ifdef USE_BATCHING
    campaignRailDemolitionPosition = batchingMatrix * campaignRailDemolitionPosition;
#endif
#ifdef USE_INSTANCING
    campaignRailDemolitionPosition = instanceMatrix * campaignRailDemolitionPosition;
#endif
vCampaignRailDemolitionWorldPos = (modelMatrix * campaignRailDemolitionPosition).xyz;`,
                );
            shader.fragmentShader = shader.fragmentShader
                .replace(
                    '#include <common>',
                    `#include <common>
varying vec3 vCampaignRailDemolitionWorldPos;
uniform float uCampaignRailDemolitionEnabled;
uniform vec2 uCampaignRailDemolitionCenter;
uniform vec2 uCampaignRailDemolitionAxis;
uniform vec2 uCampaignRailDemolitionHalfExtents;`,
                )
                .replace(
                    '#include <clipping_planes_fragment>',
                    `vec2 campaignRailDemolitionWorldXZ = vCampaignRailDemolitionWorldPos.xz + uRenderOriginXZ;
vec2 campaignRailDemolitionDelta = campaignRailDemolitionWorldXZ - uCampaignRailDemolitionCenter;
float campaignRailDemolitionAlong = dot(campaignRailDemolitionDelta, uCampaignRailDemolitionAxis);
float campaignRailDemolitionAcross = dot(
    campaignRailDemolitionDelta,
    vec2(-uCampaignRailDemolitionAxis.y, uCampaignRailDemolitionAxis.x)
);
if (uCampaignRailDemolitionEnabled > 0.5 &&
    abs(campaignRailDemolitionAlong) <= uCampaignRailDemolitionHalfExtents.x &&
    abs(campaignRailDemolitionAcross) <= uCampaignRailDemolitionHalfExtents.y) discard;
#include <clipping_planes_fragment>`,
                );
        },
    });
    material.userData ||= {};
    material.userData.campaignRailDemolitionCutout = true;
    return material;
}

function railObjectParticipatesInCampaignDemolition(name) {
    return name.startsWith('TramRailBars')
        || name.startsWith('HeavyRailBallast')
        || name.startsWith('HeavyRailSleepers')
        || name.startsWith('ProposalRailViaduct')
        || name.startsWith('ProposalRailSteel');
}

function getRailSameLevelStencilMaterial() {
    if (!sharedRailSameLevelStencilMaterial) {
        sharedRailSameLevelStencilMaterial = applySurfaceStencil(new THREE.MeshBasicMaterial({
            depthWrite: false,
            depthTest: false,
            side: THREE.DoubleSide,
        }), RAIL_PRIORITY_PREPASS_CLAIM);
        registerShared(sharedRailSameLevelStencilMaterial);
    }
    return sharedRailSameLevelStencilMaterial;
}

function getRailBarMaterial() {
    if (!sharedRailBarMaterial) {
        // Polished worn steel: high metalness + low roughness so the rail head
        // catches the sky (scene.environment PMREM) — the strongest
        // ground-level tram cue there is. Slightly light base so it reads.
        sharedRailBarMaterial = new THREE.MeshStandardMaterial({
            color: 0xb9c0c8,
            emissive: 0x252a30,
            emissiveIntensity: 0.45,
            metalness: 0.9,
            roughness: 0.22,
            envMapIntensity: 1.2,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: SURFACE_POLYGON_OFFSET.RAIL_STEEL.factor,
            polygonOffsetUnits: SURFACE_POLYGON_OFFSET.RAIL_STEEL.units,
        });
        registerShared(sharedRailBarMaterial);
    }
    return sharedRailBarMaterial;
}

function ballastHash(x, y, seed = 0x6b616d65) {
    let value = (seed ^ Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca77)) >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    return (value ^ (value >>> 16)) >>> 0;
}

function getHeavyRailBallastTexture() {
    if (sharedHeavyRailBallastTexture) return sharedHeavyRailBallastTexture;
    const size = 256;
    const cellSize = 12;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const cellX = Math.floor(x / cellSize);
            const cellY = Math.floor(y / cellSize);
            let nearestD2 = Infinity;
            let secondD2 = Infinity;
            let nearestHash = 0;
            for (let oy = -1; oy <= 1; oy += 1) {
                for (let ox = -1; ox <= 1; ox += 1) {
                    const sx = cellX + ox;
                    const sy = cellY + oy;
                    const hash = ballastHash(sx, sy);
                    const jitterX = ((hash & 0xff) / 255 - 0.5) * 0.72;
                    const jitterY = (((hash >>> 8) & 0xff) / 255 - 0.5) * 0.72;
                    const centerX = (sx + 0.5 + jitterX) * cellSize;
                    const centerY = (sy + 0.5 + jitterY) * cellSize;
                    const dx = x - centerX;
                    const dy = y - centerY;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < nearestD2) {
                        secondD2 = nearestD2;
                        nearestD2 = d2;
                        nearestHash = hash;
                    } else if (d2 < secondD2) {
                        secondD2 = d2;
                    }
                }
            }
            const joint = Math.sqrt(secondD2) - Math.sqrt(nearestD2) < 1.15;
            const grain = ((ballastHash(x, y, 0x51a11a57) & 0xff) / 255 - 0.5) * 14;
            const stoneTone = 92 + ((nearestHash >>> 16) & 0x1f);
            const tone = joint ? 53 + grain * 0.35 : stoneTone + grain;
            const warm = ((nearestHash >>> 24) & 0x0f) - 7;
            // The concrete ties remain legible after their 3D boxes become
            // sub-pixel. Because this mask uses the same 0.325 m phase as the
            // instance planner, the close geometry dissolves into its own
            // mipmapped image instead of visibly switching to another pattern.
            const sleeperMask = heavyRailDistantSleeperMask(
                (x + 0.5) / size,
                (y + 0.5) / size,
            );
            const sleeperTone = 122 + grain * 0.18;
            const finalTone = tone + (sleeperTone - tone) * sleeperMask * 0.78;
            const index = (y * size + x) * 4;
            data[index] = Math.max(0, Math.min(255, Math.round(finalTone + warm * 0.9)));
            data[index + 1] = Math.max(0, Math.min(255, Math.round(finalTone + warm * 0.35)));
            data[index + 2] = Math.max(0, Math.min(255, Math.round(finalTone - 5 - warm * 0.2)));
            data[index + 3] = 255;
        }
    }
    sharedHeavyRailBallastTexture = new THREE.DataTexture(
        data,
        size,
        size,
        THREE.RGBAFormat,
    );
    sharedHeavyRailBallastTexture.wrapS = THREE.RepeatWrapping;
    sharedHeavyRailBallastTexture.wrapT = THREE.RepeatWrapping;
    sharedHeavyRailBallastTexture.colorSpace = THREE.SRGBColorSpace;
    sharedHeavyRailBallastTexture.minFilter = THREE.LinearMipmapLinearFilter;
    sharedHeavyRailBallastTexture.magFilter = THREE.LinearFilter;
    sharedHeavyRailBallastTexture.generateMipmaps = true;
    sharedHeavyRailBallastTexture.anisotropy = 8;
    // Trackbed UVs are metres / 16. Along the track, one image repeat is four
    // exact sleeper spacings; across it, one repeat spans the full tie plus a
    // narrow ballast margin.
    sharedHeavyRailBallastTexture.repeat.set(
        16 / HEAVY_RAIL_DISTANT_SLEEPER_TILE_LENGTH_M,
        16 / HEAVY_RAIL_DISTANT_SLEEPER_TILE_WIDTH_M,
    );
    sharedHeavyRailBallastTexture.needsUpdate = true;
    registerShared(sharedHeavyRailBallastTexture);
    return sharedHeavyRailBallastTexture;
}

function getHeavyRailBallastMaterial(claim) {
    if (sharedHeavyRailBallastMaterials.has(claim)) {
        return sharedHeavyRailBallastMaterials.get(claim);
    }
    const material = new THREE.MeshStandardMaterial({
        map: getHeavyRailBallastTexture(),
        color: 0xc5c0b5,
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: SURFACE_POLYGON_OFFSET.RAIL_TRACKBED.factor,
        polygonOffsetUnits: SURFACE_POLYGON_OFFSET.RAIL_TRACKBED.units,
    });
    applySurfaceStencil(material, claim);
    applyGroundOwnership(material, claim);
    applyPlannerSurfaceCutout(material, claim);
    registerShared(material);
    sharedHeavyRailBallastMaterials.set(claim, material);
    return material;
}

function getHeavyRailSleeperMaterial() {
    if (!sharedHeavyRailSleeperMaterial) {
        sharedHeavyRailSleeperMaterial = new THREE.MeshStandardMaterial({
            color: 0x77766f,
            roughness: 0.98,
            metalness: 0,
        });
        registerShared(sharedHeavyRailSleeperMaterial);
    }
    return sharedHeavyRailSleeperMaterial;
}

function getHeavyRailSleeperGeometry() {
    if (!sharedHeavyRailSleeperGeometry) {
        sharedHeavyRailSleeperGeometry = new THREE.BoxGeometry(1, 1, 1);
        registerShared(sharedHeavyRailSleeperGeometry);
    }
    return sharedHeavyRailSleeperGeometry;
}

// Switch-throat fans: a turnout has three or more swept strips meeting at one
// centre point; their individual mitered quads cannot cover the fan-shaped
// area between all branches. Incidents are node-keyed {x, z, ySeg, halfWidth}
// entries (core/rail-render-cells.js). Split out of the strip builder so the
// render-cell path can hand a cell the COMPLETE fan of every node it owns even
// when some arms' chords are rendered by neighbouring cells — a fan built from
// half its arms is not a smaller fan, it is a hole in the paved footprint.
function addJunctionPatchMeshes(
    g,
    junctionIncidents,
    nameSuffix = '',
    { cullable = false, stencilPrepass = false, heavyRail = null } = {},
) {
    const junctionPositions = [];
    const junctionUvs = [];
    const junctionIndices = [];
    const JUNCTION_PATCH_STEPS = 24;
    for (const incidents of (junctionIncidents || new Map()).values()) {
        if (incidents.length <= 2) continue;
        const junctionIsHeavyRail = incidents.some(incident => incident.heavyRail === true);
        if (!stencilPrepass && heavyRail !== null && junctionIsHeavyRail !== heavyRail) continue;
        if (stencilPrepass && !incidents.every(incident => incident.ownsCivilGround === true)) {
            continue;
        }
        const center = incidents[0];
        const halfWidth = Math.max(...incidents.map(incident => incident.halfWidth));
        const y = TRACKBED_Y
            + incidents.reduce((sum, incident) => sum + incident.ySeg, 0) / incidents.length
            + 0.0005;
        const base = junctionPositions.length / 3;
        junctionPositions.push(center.x, y, center.z);
        junctionUvs.push(center.x * TRACKBED_UV_PER_M, center.z * TRACKBED_UV_PER_M);
        for (let step = 0; step <= JUNCTION_PATCH_STEPS; step++) {
            const angle = (step / JUNCTION_PATCH_STEPS) * Math.PI * 2;
            const x = center.x + Math.cos(angle) * halfWidth;
            const z = center.z + Math.sin(angle) * halfWidth;
            junctionPositions.push(x, y, z);
            junctionUvs.push(x * TRACKBED_UV_PER_M, z * TRACKBED_UV_PER_M);
            if (step > 0) junctionIndices.push(base, base + step, base + step + 1);
        }
    }
    if (junctionIndices.length === 0) return;
    const junctionGeom = new THREE.BufferGeometry();
    junctionGeom.setAttribute('position', new THREE.Float32BufferAttribute(junctionPositions, 3));
    junctionGeom.setAttribute('uv', new THREE.Float32BufferAttribute(junctionUvs, 2));
    junctionGeom.setIndex(junctionIndices);
    junctionGeom.computeVertexNormals();
    junctionGeom.computeBoundingSphere();
    const junctionMesh = new THREE.Mesh(
        junctionGeom,
        stencilPrepass
            ? getRailSameLevelStencilMaterial()
            : heavyRail
                ? getHeavyRailBallastMaterial(RAIL_GRADE_SEPARATED_CLAIM)
                : getTrackbedMaterialForRails(RAIL_GRADE_SEPARATED_CLAIM),
    );
    junctionMesh.name = stencilPrepass
        ? `RailSameLevelPriorityJunctionPatches${nameSuffix}`
        : heavyRail
            ? `HeavyRailBallastJunctionPatches${nameSuffix}`
            : `TramTrackbedJunctionPatches${nameSuffix}`;
    junctionMesh.userData.surfaceType = stencilPrepass
        ? 'rail-same-level-priority'
        : heavyRail
            ? 'heavy-rail-ballast'
            : 'tram-trackbed';
    junctionMesh.userData.surfacePriorityPrepass = stencilPrepass;
    junctionMesh.renderOrder = stencilPrepass
        ? SURFACE_RENDER_ORDER.RAIL_SAME_LEVEL_PREPASS
        : TRACKBED_RENDER_ORDER;
    junctionMesh.receiveShadow = false;
    if (!cullable) junctionMesh.frustumCulled = false;
    g.add(junctionMesh);
}

let sharedFlatCurbMaterial = null;
function getFlatCurbMaterial() {
    if (!sharedFlatCurbMaterial) {
        const map = createTrackbedFlatCurbTexture();
        sharedFlatCurbMaterial = new THREE.MeshStandardMaterial({
            map,
            color: 0xffffff,
            roughness: 0.95,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: SURFACE_POLYGON_OFFSET.RAIL_TRACKBED_CURB.factor,
            polygonOffsetUnits: SURFACE_POLYGON_OFFSET.RAIL_TRACKBED_CURB.units,
        });
        registerShared(sharedFlatCurbMaterial, map);
    }
    return sharedFlatCurbMaterial;
}
import { getActiveTerrainSurface } from './terrain-surface.js';
import {
    applyGroundOwnership,
} from './terrain.js';
import { applyUrbanGroundSurface } from './urban-ground-surface.js';
import { applyPlannerSurfaceCutout } from './planner-surface-cutout.js';
import { applySurfaceStencil } from './surface-material-authority.js';
import { applyJunctionEndpointLifts } from './junction-lifts.js';
import { createPillarClearanceEvaluator } from '../core/pillar-clearance.js';
import { GROUND_SURFACE_LEVELS } from './ground-surface-levels.js';
import {
    buildTrackCorridorVolumes,
    isPlannerUndergroundRampSegment,
    PLANNER_OPEN_CUT_HALF_WIDTH_M,
} from './track-corridors.js';
import {
    getRenderedRailTrackbedHalfWidthAtSpacingMeters,
    getTrackbedHalfWidthMeters,
    getRailFormationHalfWidthMeters,
    getTrackbedInnerEdgeAtSpacingMeters,
    getTrackCenterSpacingMeters,
    getTrackCenterOffsetsAtSpacingMeters,
    getTrackGaugeMeters,
    getRailVisualProfile,
    isHeavyRailProperties,
    PLANNER_UNDERGROUND_STATION_CORE_HALF_LENGTH_M,
    PLANNER_UNDERGROUND_STATION_FLARE_LENGTH_M,
    TRAM_TRACKBED_FLAT_CURB_WIDTH_M,
} from './tram-trackbed-dimensions.js';
import {
    buildRailTrackbedSupportIndexResumable,
    canonicalizeStructuralTramCorridors,
    createStructuralTramTrackbedSupportIndex,
} from '../core/structural-tram-corridor.js';
import {
    activateRenderedRailTerrainCutoutRegions,
    activateViaductTerrainCutoutRegions,
    buildRenderedRailSurfaceRegions,
    buildViaductTerrainCutoutRegionsSteps,
    createRenderedRailSurfaceMaskModelFromRegionsSteps,
    renderedRailSegmentOwnsCivilGround,
    renderedRailTerrainCutoutRegionsSignatureSteps,
} from '../core/rendered-rail-surface.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_POLYGON_OFFSET,
    SURFACE_RENDER_ORDER,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    reviseSurfaceClaim,
} from '../core/surface-hierarchy.js';

function publishedRailClaim(
    surfaceClass,
    verticalRelation,
    { paintsColor = true, supportReady = false, cutsBackstop = false } = {},
) {
    return compileSurfaceClaim({
        surfaceClass,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation,
        verticalBand: verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL
            ? 'ground'
            : null,
        ownerId: `rail-material:${surfaceClass}:${verticalRelation}`,
        sourceId: 'world/rails.js',
        paintsColor,
        supportReady,
        cutsBackstop,
    });
}

const RAIL_SAME_LEVEL_CLAIM = publishedRailClaim(
    SURFACE_CLASS.RAIL_TRACKBED,
    SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    { supportReady: true, cutsBackstop: true },
);
const RAIL_GRADE_SEPARATED_CLAIM = publishedRailClaim(
    SURFACE_CLASS.RAIL_TRACKBED,
    SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
    { supportReady: true, cutsBackstop: true },
);
const RAIL_PRIORITY_PREPASS_CLAIM = publishedRailClaim(
    SURFACE_CLASS.RAIL_TRACKBED,
    SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    { paintsColor: false, cutsBackstop: true },
);
const RAIL_EARTHWORK_CLAIM = publishedRailClaim(
    SURFACE_CLASS.RAIL_EARTHWORK,
    SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    { supportReady: true, cutsBackstop: true },
);
import {
    VIADUCT_DECK_EDGE_MARGIN_M,
    VIADUCT_DECK_TOP_BELOW_TRACKBED_M,
    VIADUCT_PARAPET_HEIGHT_M,
    VIADUCT_PARAPET_PICKET_SIZE_M,
    VIADUCT_PARAPET_RAIL_BANDS_M,
    VIADUCT_PARAPET_RAIL_HALF_WIDTH_M,
    viaductDeckHalfWidthM,
    viaductParapetOffsetM,
    viaductParapetPickets,
    viaductSlabMesh,
} from '../core/viaduct-parapet.js';
import {
    buildPlannerSurfaceCutStationAccessPlans,
    getPlannerStopLevel,
} from './planner-station-layout.js';
import {
    boundsIntersectRenderWindow,
    filterTrianglePositionsByRenderWindowSteps,
    filterTriangleGeometryByRenderWindowSteps,
    isPointWithinRenderWindow,
} from '../core/render-budgets.js';
import {
    CAB_RING,
    NEAR_ROAD_STREAM_OPTIONS,
    TILE_M,
} from '../core/tile-stream.js';
import { weldIndexedPositions } from '../core/indexed-position-weld.js';
import { smoothRailHeadNormalsSteps } from '../core/rail-head-normal-smoothing.js';
import {
    DEFAULT_STREAMED_RAIL_REFRESH_POLICY,
    streamedRailChangedNearObserver,
    streamedRailObserverTilesSettled,
    streamedRailRefreshDue,
} from '../core/streamed-rail-refresh.js';
import {
    isSolvedRailFeature,
    normalizeRailProfileMode,
    resolveRailProfileFeaturesSteps,
    resolveStreamedRailSessionFeatures,
    resolveStreamedRailSessionFeaturesSteps,
} from '../core/rail-profile-source.js';

const RAILS_RENDER_RADIUS_M = 3500;
const RAILS_REBUILD_M = 1200;
// A moving observer may publish a still-loading rail snapshot after crossing
// this much ground. A stationary observer waits for the shared road stream to
// settle, avoiding a full network rebuild for every look-ahead tile.
const STREAMED_RAIL_PROGRESS_M = 350;
const RAIL_WALL_WINDOW_PADDING_M = 40;
// WebGL buffer creation is indivisible once handed to the driver. Keep each
// dressing mesh below ~0.8 MB across position/normal/UV attributes so one
// cooperative prewarm step remains a real frame-sized item.
const RAIL_DRESSING_CHUNK_MAX_VERTICES = 24_000;
// Directional road prefetch changes on heading buckets while the camera turns.
// Level-crossing detection may lazily rebuild the complete road-formation
// index, so running it for every intermediate tile revision can consume an
// entire frame repeatedly. Crossings are static dressing: process only the
// latest revision after both the road burst and the turn have settled.
const LEVEL_CROSSING_ROAD_SETTLE_MS = 300;
const LEVEL_CROSSING_TURN_IDLE_MS = 300;
const VIADUCT_DECK_THICKNESS_M = 0.8;
const VIADUCT_PIER_SPACING_M = 30;
const VIADUCT_PIER_WIDTH_M = 1.4;
const VIADUCT_PIER_DEPTH_M = 1.6;
const VIADUCT_PIER_CAP_HEIGHT_M = 0.55;
const VIADUCT_PIER_CAP_WIDTH_M = 2.2;
const VIADUCT_PIER_CAP_DEPTH_M = 1.8;
const VIADUCT_PIER_MIN_HEIGHT_M = 1;
const VIADUCT_PIER_WATER_EMBED_M = 3;
const VIADUCT_PIER_SLIDE_STEP_M = 1;
const VIADUCT_PIER_SLIDE_MAX_M = 24;
const STEEL_BRIDGE_DETAIL_SPACING_M = 2.4;
const STEEL_BRIDGE_FLANGE_WIDTH_M = 0.28;
const STEEL_BRIDGE_FLANGE_HEIGHT_M = 0.13;
const STEEL_BRIDGE_STIFFENER_DEPTH_M = 0.16;
const STEEL_BRIDGE_STIFFENER_WIDTH_M = 0.18;
const STEEL_BRIDGE_BOLT_RADIUS_M = 0.055;
const STEEL_BRIDGE_BOLT_DEPTH_M = 0.065;
// Bored-tunnel tube (the mirror of the viaduct deck): a masonry box swept along
// the rail where RailFormationModel flags deep ground cover. The hill above is
// left intact (that span is excluded from the cut earthworks), so only the
// interior + portal frames are drawn. The bore half-width lives in
// rail-formation.js (railBoreHalfWidthM) so the open cut can flare to meet it.
const TUNNEL_CEIL_HEIGHT_M = DEFAULT_RENDERED_TUNNEL_CLEAR_HEIGHT_M;
const TUNNEL_FLOOR_DROP_M = 0.5;       // ballast floor sits this far below the trackbed
const TUNNEL_LIGHT_DROP_M = 0.15;      // fixture hangs this far below the ceiling
// Discrete ceiling light fixtures (blocky 3D boxes) instead of one long ribbon.
const TUNNEL_LIGHT_SPACING_M = 5;       // gap between fixtures along the bore
// Distance-marker plates ride on the bore walls at this height above the
// ballast floor — at the driver's eye, matching the planner tube's contract.
const TUNNEL_LIGHT_BOX_LENGTH_M = 1.0;  // along-track length of each fixture
const TUNNEL_LIGHT_BOX_WIDTH_M = 0.9;   // cross-track width
const TUNNEL_LIGHT_BOX_HEIGHT_M = 0.22; // fixture thickness (reads as a 3D box)
// Portal facade at each tunnel mouth: a hillside wall with a hole framing the
// bore. It seals the see-through gap ABOVE the tube (ceiling → retained ground)
// and to the SIDES (bore wall → cut wall) without any face across the track.
const TUNNEL_PORTAL_WING_M = 1.6;      // facade reaches this far beyond the bore on each side (jamb width)
const TUNNEL_PORTAL_MIN_CROWN_M = 0.45;
const TUNNEL_PORTAL_MAX_CROWN_M = 1.6;
const TUNNEL_PORTAL_CROWN_OVERLAP_M = 0.2; // small burial overlap, never a terrain-height tower
// World-tiled procedural civil-works surfaces: coursed stone lines the bore +
// portal, board-formed concrete faces the open-cut retaining walls. Two
// different rasters (not one re-tinted map) so they read as distinct materials,
// and both use a seed distinct from the building stone.
const TUNNEL_STONE_TILE_M = 3.2;       // stone course repeat along the bore (metres)
const CUT_CONCRETE_TILE_M = 4.0;       // concrete panel repeat on the cut walls (metres)
let _tunnelStoneSurface = null;
let _cutConcreteSurface = null;

// One authoritative tram-bed footprint: the outer edge of each 10 cm rail,
// plus 0.5 m of paved shoulder. No wider synthetic asphalt corridor is drawn
// underneath it; adjacent pixels belong to the actual mapped road, pavement,
// or greenery surface.
// Physically above every streamed OSM road/pedestrian surface (≤0.047), not
// merely depth-biased above it. The old 3 mm separation could disappear at a
// grazing cab angle and looked like a short draw-distance cutoff.
const TRACKBED_Y      = GROUND_SURFACE_LEVELS.tramBed;
// At switch/merge nodes, multiple flat trackbed quads overlap exactly at the
// same endpoint and used to z-fight. Give each incident branch a tiny,
// deterministic endpoint lift so one branch always wins the depth test while
// the track still reads visually flat.
const TRACKBED_JUNCTION_Y_STEP = 0.001;
// Match roads.js's world-space base UV scale. The shared trackbed texture
// applies its own 10x repeat, making one 256px image cover 1.6 m and each
// 16px paver roughly 10 cm. The former 0.25 value compounded that repeat and
// squeezed the same image into 40 cm (~2.5 cm pavers).
const TRACKBED_UV_PER_M = 1 / 16;
// The tram bed is the highest-priority ground surface. The explicit render
// order complements its stronger material depth bias in roads.js.
const TRACKBED_RENDER_ORDER = SURFACE_RENDER_ORDER.RAIL_TRACKBED;
// Flush concrete curb bands delineate the tram bed without creating a raised
// obstacle. Each band occupies the outermost part of the bed, so the complete
// paved assembly still ends exactly 0.5 m beyond the rail, and is segmented
// into roughly metre-long curb stones.
const TRACKBED_FLAT_CURB_W = TRAM_TRACKBED_FLAT_CURB_WIDTH_M;
const TRACKBED_FLAT_CURB_Y = GROUND_SURFACE_LEVELS.tramBedFlatCurb;
const TRACKBED_FLAT_CURB_RENDER_ORDER = SURFACE_RENDER_ORDER.RAIL_TRACKBED_CURB;
const TRACKBED_FLAT_CURB_REPEAT_M = 1.0;
const UNCOVERED_SWITCH_MARKER_Y = 0.7;
const UNCOVERED_SWITCH_MARKER_RADIUS_M = 0.55;
const RAIL_CIVIL_GROUND_SNAPSHOT_PADDING_M = 15;
const EMPTY_RAIL_CIVIL_GROUND_SNAPSHOT = Object.freeze({
    entries: Object.freeze([]),
    bounds: Object.freeze([]),
    signature: '',
});

let uncoveredSwitchMarkerGeo = null;
let uncoveredSwitchMarkerMat = null;
let uncoveredSwitchCoverageCache = null;

let group = null;
let lastFeatures = null;
let lastAnchorLat = 0;
let lastAnchorLon = 0;
let lastMaxRadiusM = RAILS_RENDER_RADIUS_M;
let lastRenderCenterX = 0;
let lastRenderCenterZ = 0;
let lastSwitchRules = null;
let lastDriverGraph = null;
let lastRoutedSegments = null;
let lastRampOpenCutVolumes = [];
let lastStops = [];
let lastTerrain = null;
// Construction reads source elevation. The public provider describes the
// currently displayed receiver window and is only a publication destination.
let lastTerrainSource = null;
let lastRailFormation = null;
let enclosedRailTunnelSpanSource = null;
let enclosedRailTunnelSpans = [];

export function getEnclosedRailTunnelSpans() {
    if (enclosedRailTunnelSpanSource === lastRailFormation) return enclosedRailTunnelSpans;
    enclosedRailTunnelSpanSource = lastRailFormation;
    enclosedRailTunnelSpans = buildRailTunnelSpanIndex(lastRailFormation?.getTunnelRuns?.() || []);
    return enclosedRailTunnelSpans;
}
let publishedRailCivilGroundSnapshot = EMPTY_RAIL_CIVIL_GROUND_SNAPSHOT;
let publishedRailCivilGroundSnapshotModel = null;
let publishedRailCivilGroundSnapshotRevision = -1;
let publishedRailCivilGroundSnapshotMutation = -1;
let pendingPublishedRailCivilGroundSnapshot = null;
let releaseCivilGroundAuthority = null;
let lastRoadFormation = null;
let lastRoadVerticalAlignments = null;
// Acknowledged only with the matching private boundary generation.
let publishedRailBoundaryInputs = null;
let pendingRailBoundaryInputs = null;
let pendingRailBoundarySinceMs = 0;
let lastRoadCarriedTramRevision = -1;
let pendingRoadCarriedTramRevision = -1;
let pendingRoadCarriedTramSinceMs = 0;
let lastRoadCarriedTramDeckSignature = '';
let lastEmbeddedTramRoadRevision = -1;
let pendingEmbeddedTramRoadRevision = -1;
let pendingEmbeddedTramRoadSinceMs = 0;
let pendingEmbeddedTramMeshRefresh = null;
let lastRailPillarRoadSignature = '';
let lastRailsHeadingDeg = null;
let lastRailsHeadingChangeMs = 0;
let lastPhotoTrackFrame = null;
let lastBridgeStyleLocationId = null;
let lastBridgeStyleCityId = null;
// GTA does not load Zagreb's static tram GeoJSON. Its already-fetched Croatia
// road tiles carry the same OSM centreline geometry, so retain just the rail
// features per tile and feed their deduplicated union into this renderer.
let streamedRailSource = null;
let streamedRailSubscription = null;
let streamedRailTileFeatures = null;
let streamedRailDeliveredTileKeys = new Set();
let streamedRailChangedTileKeys = new Set();
let streamedRailBaseFeatures = [];
let streamedRailAppliedSignature = '';
let streamedRailInputRevision = 0;
// One immutable source-resolution result per session/input/terrain revision.
// Road-only ground generations must not solve the unchanged rail source again.
let resolvedStreamedRailSource = null;
let streamedRailDirty = false;
let streamedRailLastChangeMs = 0;
let streamedRailDirtySinceMs = 0;
let streamedRailRetryAfterMs = 0;
let streamedRailLastAppliedMs = Number.NaN;
let streamedRailLastAppliedX = 0;
let streamedRailLastAppliedZ = 0;
let streamedRailHasAppliedSet = false;
let streamedRailSessionContext = null;
let streamedRailProfileMode = 'osm';
let activeRailTrafficRevision = 0;
let railFormationRevision = 0;
let terrainChangeSubscription = null;
let terrainRevisionDirty = false;
// The island-hall stations the most recent rails build widened the track centres
// for — see getStationTrackSpacingFlares().
let lastTrackSpacingStationFlares = [];
let lastStationFlares = [];
let lastPillarClearance = null;
let lastSampledTrackbedSegments = [];
let sampledTrackbedRevision = 0;
let railTrackbedSupportIndex = createStructuralTramTrackbedSupportIndex([]);
// One cooperative formation slice is bounded by items, not time, and several
// fit in a frame. Spending a few milliseconds here is what turns a ~700-slice
// Zagreb formation build from twelve seconds of frames into about two.
const RAIL_FORMATION_MODEL_STEP_BUDGET_MS = 3;
let addRenderedTrackSegmentMeshes = null;
// Persistent render-cell state for every non-structural rail chord. This also
// includes ordinary street-running tram track: road-owned rails use the same
// bars/bed/curb materials as the fixed network, so keeping a second citywide
// sibling batch only made terrain and road revisions rebuild identical mesh
// machinery synchronously. Cell groups survive rebuildVisibleRails and only
// cells whose content signature changed are disposed and rebuilt.
let railCellsRoot = null;
let railCellGroupsState = new Map();
let railCellSignaturesState = new Map();
// Exact footprints are published only after the matching render-cell group is
// in the scene. The exact stencil prepass and visible geometry land in that
// same group, so a synchronous new-before-old swap makes "ground beats void"
// true even while cells stream/rebuild.
let railCellSurfaceRegionsState = new Map();
let renderedRailSurfaceRevision = 0;
let renderedRailTerrainCutoutRevision = 0;
let renderedRailTerrainCutoutPublishedSignature = '';
let viaductTerrainCutoutRevision = 0;
let viaductTerrainCutoutPublishedSignature = '';
let viaductTerrainCutoutCache = null;
let railCellContextKey = '';
let lastCellRenderedSegments = [];
let railCellQueue = null;
let railCellBuildToken = 0;
// Terrain/movement refreshes stage detached generations, but their WebGL
// uploads must share the delivery allowance with Worker packets. Running a
// render-based upload directly in rails.onFrame let it collide with thousands
// of far-building uploads and block the driver for 440 ms.
let railGpuUploadQueue = null;
let railDressingQueue = null;
let railRetirementQueue = null;
let surfacePublications = null;
let groundPublications = null;
let getGroundPhysics = null;
// Persistent viaduct/tunnel structures: rebuilt only when their build key
// changes (runs geometry, styles, window, photo state, pillar/road coupling)
// or when a terrain revision touches a run (the key cannot see pier ground).
let railStructuresGroup = null;
let railStructuresKey = null;
// Terrain-change bounds accumulated between refreshes; an event without
// bounds forces the full refresh path.
let terrainDirtyBounds = [];
let terrainDirtyFullRefresh = false;
let mappedSeaChangeSubscription = null;
let mappedSeaStructuresDirty = false;
let mappedSeaStructuresRevision = 0;
let pendingRailFormationBuild = null;
let pendingRailVisualRefresh = null;
let railGroundGenerationLease = null;
let groundCoordinator = null;
let groundManaged = false;
let pendingRailStructuresRefresh = null;
let pendingCrossingFormationRefresh = null;
let pillarClearanceReady = false;
let pillarClearanceLoading = false;
let railSessionToken = 0;
let photoStationStructureRevision = 0;

function replacePendingRailFormationBuild(build) {
    const previous = pendingRailFormationBuild;
    if (previous === build) return;
    pendingRailFormationBuild = build;
    previous?.civilGroundSnapshotIterator?.return?.();
    if (previous?.model !== build?.model) previous?.model?.dispose?.();
}

function discardPendingRailFormationBuild() {
    replacePendingRailFormationBuild(null);
}

function failRailFormationBuild(build, error) {
    build.failure = Object.freeze({ code: error.code || 'rail-formation-build', message: String(error.message || error) });
    build.civilGroundSnapshotIterator?.return?.();
    build.civilGroundSnapshotIterator = null;
    build.model?.dispose?.();
    build.model = null;
    build.modelBuilt = false;
    // Record after disposing this attempt so its own releases cannot trigger
    // an immediate retry. Other owners releasing a capacity slot can.
    build.readReleaseRevision = lastTerrain?.readReleaseRevision;
}

function createPendingRailFormationBuild(features, fields) {
    const build = { ...fields, features, model: null, failure: null,
        inputRevision: streamedRailInputRevision, terrainRevision: Number(lastTerrain?.revision) || 0 };
    try {
        build.model = createRailFormationModel(features, {
            terrainChangedBounds: fields.fullRefresh ? null : fields.changeBounds,
            deferredBuild: true,
        });
    } catch (error) {
        failRailFormationBuild(build, error);
        replacePendingRailFormationBuild(build);
        throw error;
    }
    replacePendingRailFormationBuild(build);
    return build;
}

function discardPendingRailVisualRefresh() {
    const refresh = pendingRailVisualRefresh;
    pendingRailVisualRefresh = null;
    discardRailVisualRefresh(refresh);
}

function discardRailVisualRefresh(refresh) {
    if (refresh?.publicationJob) railCellQueue?.cancel(refresh.publicationJob);
    refresh?.publicationSteps?.return?.();
    refresh?.formationPublication?.discard();
    refresh?.groundBuild?.return?.();
    refresh?.segmentBuild?.return?.();
    refresh?.ownershipBuild?.return?.();
    cancelRailDressingPreparation(refresh);
    cancelRailGpuUploadStage(refresh, {
        iteratorProperty: 'dressingPrewarm',
        jobProperty: 'dressingPrewarmJob',
    });
    cancelRailGpuUploadStage(refresh, {
        iteratorProperty: 'structuresPrewarm',
        jobProperty: 'structuresPrewarmJob',
    });
    cancelRailGpuUploadStage(refresh, {
        iteratorProperty: 'candidatePrewarm',
        jobProperty: 'candidatePrewarmJob',
    });
    const candidate = refresh?.candidate;
    if (candidate?.root && candidate.committed !== true) {
        enqueueRailRetirement(candidate.root);
    } else if (!candidate?.committed) {
        const pendingDressing = refresh?.formationDressingGroup;
        if (pendingDressing) enqueueRailRetirement(pendingDressing);
        const pendingStructures = refresh?.structuresGroup;
        if (pendingStructures && pendingStructures !== railStructuresGroup) {
            enqueueRailRetirement(pendingStructures);
        }
    }
    refresh?.ground?.release();
    if (refresh) refresh.ground = null;
}

// One complete shared read is used by trackbed, dressing and structures until
// the detached visual candidate publishes or is discarded. Roads already
// cache/copy this graph cooperatively for their own builders and curbs.
function* captureRailVisualGroundSteps(refresh, owner = 'rail-visual') {
    const session = railSessionToken;
    const features = lastFeatures, terrain = lastTerrain, rail = lastRailFormation;
    const stops = lastStops, photoFrame = lastPhotoTrackFrame;
    const road = lastRoadFormation, alignment = lastRoadVerticalAlignments;
    const railRevision = rail?.revision, railMutation = rail?.civilGroundMutationRevision || 0;
    const terrainRevision = terrain?.revision, roadRevision = road?.revision;
    const roadGeometry = road?.surfaceGeometryRevision, roadPublication = road?.surfacePublicationRevision;
    const alignmentRevision = alignment?.revision;
    const clearance = lastPillarClearance, clearanceReady = pillarClearanceReady;
    const seaRevision = mappedSeaStructuresRevision, stationRevision = photoStationStructureRevision;
    const location = lastBridgeStyleLocationId, city = lastBridgeStyleCityId;
    const photo = isPhotoWorld();
    const proposalMask = captureProposalMaskSnapshot();
    const sourcesCurrent = () => session === railSessionToken && features === lastFeatures
        && stops === lastStops && photoFrame === lastPhotoTrackFrame
        && terrain === lastTerrain && terrain?.revision === terrainRevision
        && rail === lastRailFormation && rail?.revision === railRevision
        && (rail?.civilGroundMutationRevision || 0) === railMutation
        && road === lastRoadFormation
        && alignment === lastRoadVerticalAlignments && alignment?.revision === alignmentRevision
        && clearance === lastPillarClearance && clearanceReady === pillarClearanceReady
        && seaRevision === mappedSeaStructuresRevision && stationRevision === photoStationStructureRevision
        && location === lastBridgeStyleLocationId && city === lastBridgeStyleCityId
        && photo === isPhotoWorld() && proposalMask.isCurrent();
    // Also available if acquiring a read throws. A failed attempt must wait
    // for changed inputs/capacity instead of resuming a closed iterator.
    refresh.captureInputsCurrent = () => sourcesCurrent() && road?.revision === roadRevision
        && road?.surfaceGeometryRevision === roadGeometry && road?.surfacePublicationRevision === roadPublication;
    const ground = yield* streamedRailSessionContext.captureSurfaceBuildGround(owner);
    if (!ground) return null;
    const radius = lastMaxRadiusM + RAIL_WALL_WINDOW_PADDING_M;
    const roadInputsCurrent = ground.currentWithin?.({
        minX: refresh.centerX - radius, maxX: refresh.centerX + radius,
        minZ: refresh.centerZ - radius, maxZ: refresh.centerZ + radius,
    }) || ground.isCurrent;
    refresh.captureInputsCurrent = () => sourcesCurrent() && roadInputsCurrent();
    let candidateRail = null, handedOff = false;
    try {
        if (refresh.formationPublication?.model) {
            const model = refresh.formationPublication.model;
            candidateRail = yield* model.captureReadSnapshotSteps({ baseSceneYAtLocal: model.baseSceneYAtLocal });
        }
        const candidateCurrent = () => !refresh.formationPublication || refresh.formationPublication.entry.isCurrent();
        if (!sourcesCurrent() || !roadInputsCurrent() || !candidateCurrent()) return null;
        handedOff = true;
        return ownReadSnapshot({ terrain: ground.terrain,
        railFormation: refresh.formationPublication ? candidateRail : ground.railFormation,
        roadFormation: ground.roadFormation, roadSupportCacheSource: road,
        verticalAlignments: ground.verticalAlignments, proposalMask, mappedWater: ground.mappedWater,
        isCurrent: () => sourcesCurrent() && roadInputsCurrent() && candidateCurrent(),
        }, [ground, candidateRail]);
    } finally { if (!handedOff) { candidateRail?.release(); ground.release(); } }
}

function* prepareRailSegmentOwnershipSteps(segments) {
    const result = [];
    let started = performance.now();
    for (const segment of segments) {
        const ownsCivilGround = renderedRailSegmentOwnsCivilGround(segment);
        result.push(segment.ownsCivilGround === ownsCivilGround ? segment : { ...segment, ownsCivilGround });
        if (performance.now() - started >= .5) { yield { phase: 'rail-segment-ownership' }; started = performance.now(); }
    }
    // Evidence obligations are metadata on the solved array, not one chord.
    for (const key of Object.keys(segments)) if (!/^\d+$/.test(key)) result[key] = segments[key];
    return result;
}

// One visit advances the existing deferred visual pipeline. Queries come
// from one retained graph; upload stages remain on the shared delivery queue.
function stepRailVisualPreparation(refresh, publish = true) {
    refresh.visualPreparationPhase = 'rail-generation:visual-preparation';
    if (refresh.candidate?.committed) return true;
    if (refresh.uploadError) throw refresh.uploadError;
    if (refresh.dressingError) throw refresh.dressingError;
    if (!refresh.ground) {
        refresh.groundBuild ||= captureRailVisualGroundSteps(refresh);
        const next = refresh.groundBuild.next();
        if (next.done) {
            refresh.groundBuild = null;
            refresh.ground = next.value;
            if (!refresh.ground) restartPendingRailVisualRefresh(refresh);
        }
        return false;
    }
    const refreshPhase = refresh.reason === 'movement'
        ? 'movementRefresh'
        : refresh.reason === 'streamed'
            ? 'streamedRefresh'
            : 'terrainRefresh';
    if (Array.isArray(refresh.resampleSegments) && !Array.isArray(refresh.precomputedSegments)) {
        refresh.precomputedSegments = resampleRailTrackbedSegmentsForTerrain(refresh.resampleSegments, {
            terrain: refresh.ground.terrain, railFormation: refresh.ground.railFormation,
            roadFormation: refresh.ground.roadFormation, roadVerticalAlignments: refresh.ground.verticalAlignments,
            roadSupportCacheSource: refresh.ground.roadSupportCacheSource,
            photoTrackFrame: lastPhotoTrackFrame,
        });
        refresh.resampleSegments = null;
        return false;
    }
    if (!Array.isArray(refresh.precomputedSegments)) {
        if (!Array.isArray(refresh.stationFlares)) {
            const flaresStarted = railStreamNowMs();
            refresh.stationFlares = buildUndergroundStationFlareProfiles(
                refresh.features || lastFeatures,
                lastStops,
                lastAnchorLat,
                lastAnchorLon,
                lastPhotoTrackFrame,
            );
            recordLayerFrameMs(
                `rails:${refreshPhase}:segmentFlares`,
                railStreamNowMs() - flaresStarted,
            );
            return false;
        }
        if (!refresh.segmentBuild) {
            refresh.segmentBuild = computeRailTrackbedSegmentsResumable(
                refresh.features || lastFeatures,
                lastAnchorLat,
                lastAnchorLon,
                lastMaxRadiusM,
                {
                    rampOpenCutVolumes: lastRampOpenCutVolumes,
                    stationFlares: refresh.stationFlares,
                    terrain: refresh.ground.terrain,
                    railFormation: refresh.ground.railFormation,
                    roadFormation: refresh.ground.roadFormation,
                    roadSupportCacheSource: refresh.ground.roadSupportCacheSource,
                    roadVerticalAlignments: refresh.ground.verticalAlignments,
                    proposalMask: refresh.ground.proposalMask,
                    photoTrackFrame: lastPhotoTrackFrame,
                    centerX: refresh.centerX,
                    centerZ: refresh.centerZ,
                },
            );
        }
        const segmentStepStarted = railStreamNowMs();
        const outcome = refresh.segmentBuild.next();
        recordLayerFrameMs(
            `rails:${refreshPhase}:segments:${outcome.value?.phase || 'finalize'}`,
            railStreamNowMs() - segmentStepStarted,
        );
        if (!outcome.done) return false;
        refresh.segmentBuild = null;
        refresh.precomputedSegments = outcome.value;
        return false;
    }
    if (!refresh.ownershipPrepared) {
        refresh.ownershipBuild ||= prepareRailSegmentOwnershipSteps(refresh.precomputedSegments);
        const next = refresh.ownershipBuild.next();
        if (next.done) { refresh.precomputedSegments = next.value; refresh.ownershipBuild = null; refresh.ownershipPrepared = true; }
        return false;
    }
    if (!refresh.formationDressingGroup) {
        const dressing = new THREE.Group();
        dressing.name = 'RailFormationDressing';
        refresh.formationDressingGroup = dressing;
    }
    if (!refresh.formationDressingComplete) {
        refresh.visualPreparationPhase = 'rail-generation:dressing';
        enqueueRailDressingPreparation(refresh, refresh.formationDressingGroup, {
            maxRadiusM: lastMaxRadiusM, readyProperty: 'formationDressingComplete',
        });
        return false;
    }
    if (!refresh.formationDressingGpuReady) {
        if (!refresh.dressingPrewarm) {
            refresh.dressingPrewarm = createRailGpuPrewarm(
                refresh.formationDressingGroup,
                'rail-dressing-gpu-prewarm',
            );
        }
        enqueueRailGpuUploadStage(refresh, {
            iteratorProperty: 'dressingPrewarm',
            jobProperty: 'dressingPrewarmJob',
            readyProperty: 'formationDressingGpuReady',
            label: 'rail-dressing-gpu-prewarm',
        });
        return false;
    }
    if (!refresh.structuresPrepared) {
        const structuresStarted = railStreamNowMs();
        if (!Array.isArray(refresh.stationFlares)) {
            refresh.stationFlares = buildUndergroundStationFlareProfiles(
                refresh.features || lastFeatures,
                lastStops,
                lastAnchorLat,
                lastAnchorLon,
                lastPhotoTrackFrame,
            );
        }
        refresh.structuresKey = railStructuresBuildKey(
            refresh.ground.railFormation,
            refresh.stationFlares,
            refresh.centerX,
            refresh.centerZ,
            lastMaxRadiusM,
            railPillarRoadSurfaceSignature(refresh.ground.railFormation, refresh.ground.roadFormation),
            refresh.ground.mappedWater,
        );
        if (!railStructuresGroup
            || refresh.structuresKey !== railStructuresKey) {
            let structurePhaseStarted = structuresStarted;
            refresh.structuresGroup = createRailStructuresGroup(
                refresh.ground.railFormation,
                refresh.ground.terrain,
                refresh.stationFlares,
                refresh.centerX,
                refresh.centerZ,
                lastMaxRadiusM,
                name => {
                    const completedAt = railStreamNowMs();
                    recordLayerFrameMs(
                        `rails:${refreshPhase}:structures:${name}`,
                        completedAt - structurePhaseStarted,
                    );
                    structurePhaseStarted = completedAt;
                },
                refresh.ground.roadFormation,
                refresh.ground.mappedWater,
            );
        } else {
            refresh.structuresGpuReady = true;
        }
        refresh.structuresPrepared = true;
        recordLayerFrameMs(
            `rails:${refreshPhase}:structures`,
            railStreamNowMs() - structuresStarted,
        );
        return false;
    }
    if (!refresh.structuresGpuReady) {
        if (!refresh.structuresPrewarm) {
            refresh.structuresPrewarm = createRailGpuPrewarm(
                refresh.structuresGroup,
                'rail-structures-gpu-prewarm',
            );
        }
        enqueueRailGpuUploadStage(refresh, {
            iteratorProperty: 'structuresPrewarm',
            jobProperty: 'structuresPrewarmJob',
            readyProperty: 'structuresGpuReady',
            label: 'rail-structures-gpu-prewarm',
        });
        return false;
    }
    if (!refresh.candidatePrepared) {
        const visualStarted = railStreamNowMs();
        refresh.candidate = prepareVisibleRails(
            refresh.centerX,
            refresh.centerZ,
            {
                precomputedSegments: refresh.precomputedSegments,
                precomputedFormationDressing: refresh.formationDressingGroup,
                precomputedStationFlares: refresh.stationFlares,
                precomputedStructures: refresh.structuresGroup,
                precomputedStructuresKey: refresh.structuresKey,
                ground: refresh.ground,
                features: refresh.features || lastFeatures,
            },
        );
        refresh.candidatePrepared = true;
        recordLayerFrameMs(
            `rails:${refreshPhase}:visualBuild`,
            railStreamNowMs() - visualStarted,
        );
        return false;
    }
    if (refresh.candidate && !refresh.candidateGpuReady) {
        if (!refresh.candidatePrewarm) {
            refresh.candidatePrewarm = createRailGpuPrewarm(
                refresh.candidate.root,
                'rail-candidate-gpu-prewarm',
            );
        }
        enqueueRailGpuUploadStage(refresh, {
            iteratorProperty: 'candidatePrewarm',
            jobProperty: 'candidatePrewarmJob',
            readyProperty: 'candidateGpuReady',
            label: 'rail-candidate-gpu-prewarm',
        });
        return false;
    }
    if (!refresh.candidate || !publish) return true;
    enqueueRailPublicationPreparation(refresh);
    return refresh.candidate.committed === true || refresh.publicationComplete === true;
}

function* admitRailGroundGenerationSteps({ isCurrent, maxFeatures, terrainRead = null }) {
    if (typeof isCurrent !== 'function' || !Number.isSafeInteger(maxFeatures) || maxFeatures <= 0) {
        throw new TypeError('Rail generation requires explicit bounded admission');
    }
    // The first coordinated generation has no published rail root yet. Its
    // transactional publisher explicitly supports a null predecessor and
    // installs the prepared root on commit.
    if (railGroundGenerationLease || pendingRailFormationBuild || pendingRailVisualRefresh
        || pendingRailStructuresRefresh || pendingCrossingFormationRefresh || pendingEmbeddedTramMeshRefresh) return null;
    const session = railSessionToken, parent = group, oldFeatures = lastFeatures, stops = lastStops;
    let sourceSignature = null;
    const managed = groundManaged;
    const terrain = lastTerrain, rail = lastRailFormation, road = lastRoadFormation, alignment = lastRoadVerticalAlignments;
    const inputRevision = streamedRailInputRevision, sampledRevision = sampledTrackbedRevision;
    const coverageRevision = renderedRailSurfaceRevision, photoFrame = lastPhotoTrackFrame;
    const clearance = lastPillarClearance, clearanceReady = pillarClearanceReady;
    const sea = mappedSeaStructuresRevision, station = photoStationStructureRevision;
    const location = lastBridgeStyleLocationId, city = lastBridgeStyleCityId;
    const lease = {};
    const current = () => railGroundGenerationLease === lease && isCurrent() && session === railSessionToken
        && parent === group && oldFeatures === lastFeatures && stops === lastStops
        && terrain === lastTerrain && rail === lastRailFormation && road === lastRoadFormation && alignment === lastRoadVerticalAlignments
        && inputRevision === streamedRailInputRevision && sampledRevision === sampledTrackbedRevision
        && coverageRevision === renderedRailSurfaceRevision && photoFrame === lastPhotoTrackFrame
        && clearance === lastPillarClearance && clearanceReady === pillarClearanceReady
        && sea === mappedSeaStructuresRevision && station === photoStationStructureRevision
        && location === lastBridgeStyleLocationId && city === lastBridgeStyleCityId;
    const release = () => { if (railGroundGenerationLease === lease) railGroundGenerationLease = null; };
    lease.cancel = release; railGroundGenerationLease = lease;
    let handedOff = false;
    try {
        const features = managed ? (streamedRailTileFeatures
            ? yield* resolveCurrentStreamedRailFeaturesSteps(terrainRead || lastTerrainSource,
                source => { sourceSignature = streamedRailFeatureSetSignature(source); })
            : yield* resolveStandaloneRailFeaturesSteps(streamedRailBaseFeatures, terrainRead || lastTerrainSource)) : lastFeatures;
        if (!Array.isArray(features) || features.length > maxFeatures) throw new RangeError('Rail feature capacity exceeded');
        if (!current()) throw Object.assign(new Error('Rail source admission expired'), { code: 'ground-generation-stale' });
        const admission = Object.freeze({ features, isCurrent: current, release,
            constructionInputs: Object.freeze({ session, inputRevision,
                stops: Object.freeze((stops || []).slice()), stopsSignature: JSON.stringify(stops || []), photoFrame }),
            acknowledge({ x, z }) {
                if (!managed) return true;
                // Publication has changed the receiver pointers already. Only
                // the captured source/session epoch may acknowledge this set.
                if (session !== railSessionToken || inputRevision !== streamedRailInputRevision) return false;
                if (sourceSignature !== null) {
                    streamedRailAppliedSignature = sourceSignature;
                    streamedRailLastAppliedMs = railStreamNowMs();
                    streamedRailLastAppliedX = x; streamedRailLastAppliedZ = z;
                    streamedRailHasAppliedSet = true;
                }
                streamedRailDirty = false; streamedRailDirtySinceMs = 0;
                streamedRailRetryAfterMs = 0; streamedRailChangedTileKeys.clear();
                // The first managed generation also consumes terrain work queued
                // before the coordinator took ownership. Its former onFrame path
                // no longer runs, so acknowledging only streamed tiles leaves the
                // support-readiness gate permanently dirty after a complete swap.
                terrainRevisionDirty = false; terrainDirtyFullRefresh = false; terrainDirtyBounds = [];
                if (sea === mappedSeaStructuresRevision) mappedSeaStructuresDirty = false;
                return true;
            },
            setCancel(callback) { if (typeof callback !== 'function') throw new TypeError('Rail generation requires cancellation'); lease.cancel = callback; } });
        handedOff = true; return admission;
    } finally { if (!handedOff) release(); }
}

// A moving terrain window must carry the already-published rail receiver with
// it. This admission deliberately captures the published feature/profile set;
// streamed source changes stay pending for the next full physical generation.
// Without this leaf lease coordinated mode bypasses the ordinary rail onFrame
// recenter path, so a cab can leave the fixed 3.5 km render/collision window.
function admitRailWindowGroundGeneration({ isCurrent, constructionInputs = null } = {}) {
    if (typeof isCurrent !== 'function') {
        throw new TypeError('Rail window generation requires a currentness guard');
    }
    if (!group || railGroundGenerationLease || pendingRailFormationBuild || pendingRailVisualRefresh
        || pendingRailStructuresRefresh || pendingCrossingFormationRefresh || pendingEmbeddedTramMeshRefresh) return null;
    const session = railSessionToken, parent = group, features = lastFeatures;
    const formation = lastRailFormation, terrain = lastTerrain, road = lastRoadFormation;
    const alignment = lastRoadVerticalAlignments, inputRevision = streamedRailInputRevision;
    const sampledRevision = sampledTrackbedRevision, coverageRevision = renderedRailSurfaceRevision;
    const lease = {};
    const current = () => railGroundGenerationLease === lease && isCurrent()
        && session === railSessionToken && parent === group && features === lastFeatures
        && formation === lastRailFormation && terrain === lastTerrain && road === lastRoadFormation
        && alignment === lastRoadVerticalAlignments && inputRevision === streamedRailInputRevision
        && sampledRevision === sampledTrackbedRevision && coverageRevision === renderedRailSurfaceRevision;
    const release = () => {
        if (railGroundGenerationLease !== lease) return false;
        railGroundGenerationLease = null;
        return true;
    };
    const admission = Object.freeze({ features,
        constructionInputs: constructionInputs ? Object.freeze({ ...constructionInputs }) : null,
        isCurrent: current, release,
        setCancel(callback) {
            if (typeof callback !== 'function' || !current()) throw new Error('Invalid rail window cancellation');
            lease.cancel = callback;
        },
        acknowledge() { return current(); },
    });
    lease.cancel = release;
    railGroundGenerationLease = lease;
    return admission;
}

// Civil construction precedes road ownership. Capture the rail-only result
// after rail neighbours, tunnel mouths and station access have resolved. Road
// profiles consume this immutable view; later road cuts change the private
// receiver model, never the ground with which those same roads were designed.
function* prepareRailConstructionGroundSteps({ admission, terrain, changedBounds = null, previous = null,
    reusePublished = false,
    maxSegments, maxProfiles, maxProfilePoints, isCurrent = () => true }) {
    if (!admission?.isCurrent || !Object.isFrozen(terrain) || !terrain.evidenceSceneYAtLocal
        || typeof reusePublished !== 'boolean'
        || ![maxSegments, maxProfiles, maxProfilePoints].every(value => Number.isSafeInteger(value) && value > 0)
        || typeof isCurrent !== 'function') throw new TypeError('Rail construction requires admitted sources, terrain and explicit limits');
    let model = null, read = null, handedOff = false, settled = false, ownershipStarted = false, ownershipPublication = null;
    const current = () => !settled && admission.isCurrent() && isCurrent();
    const check = () => { if (!current()) throw Object.assign(new Error('Rail construction changed'), { code: 'ground-generation-stale' }); };
    const releaseRead = () => { read?.release(); read = null; };
    const discard = () => {
        if (settled) return false;
        settled = true; releaseRead();
        if (!['committed', 'published'].includes(ownershipPublication?.state)) model?.dispose();
        model = null; return true;
    };
    try {
        check();
        const inputs = admission.constructionInputs;
        const previousInputs = previous?.constructionInputs;
        const reused = !!inputs && !!previousInputs
            && (previousInputs.terrainRevision === terrain.revision || reusePublished)
            && ['session', 'inputRevision', 'stopsSignature', 'photoFrame'].every(key => previousInputs[key] === inputs[key]);
        if (reused) {
            const fork = previous.forkCompiledGenerationSteps();
            try { for (;;) {
                check(); const next = fork.next();
                if (next.done) { model = next.value; break; }
                yield next.value;
            } } finally { fork.return(); }
        } else model = createRailFormationModel(admission.features, { terrainRead: terrain,
            stops: inputs?.stops, terrainChangedBounds: changedBounds, deferredBuild: true });
        if (!model) throw Object.assign(new Error('Rail construction has no terrain'), { code: 'rail-receiver-evidence-unavailable' });
        let countedProfiles = 0, points = 0;
        do {
            check();
            const step = model.stepPendingBuild();
            while (countedProfiles < model.profiles.length) points += model.profiles[countedProfiles++].points?.length || 0;
            if (model.segments.length > maxSegments || model.profiles.length > maxProfiles || points > maxProfilePoints) {
                throw Object.assign(new Error('Rail construction exceeds its admitted geometry'), { code: 'ground-generation-capacity' });
            }
            yield { phase: `rail-construction:${step.phase}` };
        } while (model.hasPendingBuild());
        model.revision = ++railFormationRevision;
        const capture = model.captureReadSnapshotSteps({ baseSceneYAtLocal: model.baseSceneYAtLocal });
        try { for (;;) {
            check(); const next = capture.next(); if (next.done) { read = next.value; break; } yield next.value;
        } } finally { capture.return(); }
        read = ownReadSnapshot({ ...read, constructionInputs: Object.freeze({ ...inputs, terrainRevision: terrain.revision }) }, [read]);
        check(); handedOff = true;
        return Object.freeze({ read, isCurrent: current, discard,
            usage: Object.freeze({ segments: model.segments.length, profiles: model.profiles.length, profilePoints: points, reused }),
            takeOwnershipModel() {
                check();
                if (ownershipStarted) throw new Error('Rail construction ownership was already prepared');
                ownershipStarted = true; return model;
            },
            bindPublication(publication) {
                if (ownershipPublication || publication.model !== model || publication.state !== 'prepared') {
                    throw new Error('Invalid rail construction publication');
                }
                ownershipPublication = publication;
            },
            finalize() {
                if (settled || ownershipPublication?.state !== 'published') return false;
                // The final receiver publication now owns this model. Derived
                // road reads keep their own construction snapshot handles.
                settled = true; releaseRead(); model = null; return true;
            },
        });
    } finally { if (!handedOff) discard(); }
}

function* prepareRailOwnershipGroundSteps({ admission, construction, roadFormation, verticalAlignments,
    retainedCrossings = [], retainedOpenings = [], maxCrossings, maxOpenings,
    maxDependencyEntries, maxDependencyBounds, isCurrent = () => true }) {
    if (!admission?.isCurrent || !construction?.isCurrent || !Object.isFrozen(roadFormation)
        || !roadFormation?.nearbyCenterlineSegments || !Object.isFrozen(verticalAlignments)
        || !verticalAlignments?.getAlignments || !Array.isArray(retainedCrossings) || !Array.isArray(retainedOpenings)
        || ![maxCrossings, maxOpenings, maxDependencyEntries, maxDependencyBounds].every(value => Number.isSafeInteger(value) && value > 0)
        || retainedCrossings.length > maxCrossings || retainedOpenings.length > maxOpenings || typeof isCurrent !== 'function') {
        throw new TypeError('Rail ownership requires complete captured road/alignment inputs and bounded retained openings');
    }
    const current = () => admission.isCurrent() && construction.isCurrent() && isCurrent();
    const check = () => { if (!current()) throw Object.assign(new Error('Rail ownership changed'), { code: 'ground-generation-stale' }); };
    let read = null, publication = null, handedOff = false, settled = false, roadOwner = null, alignmentOwner = null;
    const refresh = { inputs: { ...railBoundaryInputs(), roadRevision: roadFormation.revision,
        alignmentRevision: verticalAlignments.revision }, crossings: new Map(), openings: new Map(),
    crossingRevision: levelCrossingAccumRevision + 1, ground: { isCurrent: current } };
    const discard = () => {
        if (settled) return false;
        settled = true; read?.release(); read = null; publication?.discard(); construction.discard(); return true;
    };
    try {
        roadOwner = retainReadSnapshot(roadFormation, 'rail-ownership-road'); roadFormation = roadOwner;
        alignmentOwner = retainReadSnapshot(verticalAlignments, 'rail-ownership-alignment'); verticalAlignments = alignmentOwner;
        check(); const model = construction.takeOwnershipModel();
        const found = yield* detectAtGradeLevelCrossingsSteps(construction.read, roadFormation, { isCurrent: current });
        check();
        for (const values of [retainedCrossings, found || []]) for (const frame of values) {
            refresh.crossings.set(`${Math.round(frame.x)},${Math.round(frame.z)}`, frame);
            if (refresh.crossings.size > maxCrossings) throw Object.assign(new Error('Rail crossing capacity exceeded'), { code: 'ground-generation-capacity' });
            yield { phase: 'rail-ownership:crossing' }; check();
        }
        for (const opening of retainedOpenings) refresh.openings.set(opening.key, opening);
        for (const alignment of verticalAlignments.getAlignments()) {
            for (const opening of roadUnderRailFormationOpenings([alignment])) {
                refresh.openings.set(opening.key, opening);
                if (refresh.openings.size > maxOpenings) throw Object.assign(new Error('Rail opening capacity exceeded'), { code: 'ground-generation-capacity' });
            }
            yield { phase: 'rail-ownership:opening' }; check();
        }
        yield* flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps(model, roadFormation, { isCurrent: current }); check();
        yield* flagRailFormationBoundarySegmentsForRoadOpeningsSteps(model, [...refresh.openings.values()], { isCurrent: current }); check();
        yield* flagRetainingWallsForCrossingsSteps(model, [...refresh.crossings.values()], current); check();
        const civil = yield* railCivilGroundDependencySnapshotSteps(model, RAIL_CIVIL_GROUND_SNAPSHOT_PADDING_M); check();
        const changedBounds = yield* changedCivilGroundDependencyBoundsSteps(publishedRailCivilGroundSnapshot.entries || [], civil.entries,
            { maxEntries: maxDependencyEntries, maxBounds: maxDependencyBounds, isCurrent: current });
        check();
        publication = prepareRailFormationPublication(model, admission.features,
            { civilGroundSnapshot: civil, revisionPrepared: true, recordBuildTimings: false, owner: refresh });
        construction.bindPublication(publication);
        refresh.formationPublication = publication;
        const capture = model.captureReadSnapshotSteps({ baseSceneYAtLocal: model.baseSceneYAtLocal });
        try { for (;;) {
            check(); const next = capture.next(); if (next.done) { read = next.value; break; } yield next.value;
        } } finally { capture.return(); }
        check();
        const acknowledgement = prepareRailBoundaryAcknowledgement(refresh);
        handedOff = true;
        return Object.freeze({ read, changedBounds, formationPublication: publication, additionalEntries: [acknowledgement],
            isCurrent: () => !settled && current() && publication.entry.isCurrent(), discard,
            finalize() {
                if (settled || publication.state !== 'published') return false;
                settled = true; read.release(); read = null; construction.finalize(); return true;
            },
        });
    } finally { roadOwner?.release?.(); alignmentOwner?.release?.(); if (!handedOff) discard(); }
}

// Reuse every ordinary visual stage, but return its complete prepared entries
// to the shared coordinator before either render or collision can publish.
function* prepareRailGroundGenerationSteps({ admission, ground, centerX, centerZ, isCurrent,
    formationPublication = null, additionalEntries = [], maxSegments, maxCells }) {
    if (!admission?.isCurrent || !Object.isFrozen(ground) || typeof ground?.isCurrent !== 'function'
        || !['terrain', 'roadFormation', 'railFormation', 'verticalAlignments', 'proposalMask', 'roadSupportCacheSource']
            .every(key => Object.hasOwn(ground, key)) || !ground.proposalMask?.isCurrent
        || ![centerX, centerZ].every(Number.isFinite) || typeof isCurrent !== 'function'
        || ![maxSegments, maxCells].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('Rail receiver requires admitted sources, complete ground and explicit limits');
    }
    const refresh = { centerX, centerZ, reason: 'ground-generation', features: admission.features,
        formationPublication, coordinatedDressing: true };
    let prepared = null, held = null, handedOff = false, settled = false;
    const current = () => !settled && admission.isCurrent() && ground.isCurrent() && isCurrent();
    refresh.isCurrent = current;
    const release = () => { discardRailVisualRefresh(refresh); held?.release(); held = null; admission.release(); };
    const discard = () => {
        if (settled) return false;
        settled = true;
        // Preparation may return false before it owns a publication candidate.
        // In either case, the admitted terrain reads and source lease must end.
        try { if (prepared) prepared.discard(); } finally { release(); }
        return true;
    };
    admission.setCancel(discard);
    try {
        if (!current()) return null;
        held = retainReadSnapshot(ground, 'rail-receiver-generation');
        refresh.ground = ownReadSnapshot({ ...held, isCurrent: current }, [held]); held = null;
        for (;;) {
            if (!current()) return null;
            const ready = stepRailVisualPreparation(refresh, false);
            if ((refresh.precomputedSegments?.length || 0) > maxSegments) throw new RangeError('Rail receiver segment capacity exceeded');
            if (ready) break;
            yield { phase: refresh.visualPreparationPhase,
                ...(refresh.dressingBuildJob || refresh.dressingPrewarmJob || refresh.structuresPrewarmJob || refresh.candidatePrewarmJob
                    ? { deferFrame: true } : {}) };
        }
        if (!refresh.candidate || refresh.precomputedSegments?.terrainEvidenceIncomplete
            || refresh.candidate.incompleteCellKeys?.size || refresh.candidate.structuralEvidenceIncomplete) {
            // Name the cells so the gap can be found; an unlocatable rejection
            // holds every layer's ground and reads as "no shore" (Split, 2026-09-16).
            const cellKeys = [...new Set([
                ...(refresh.precomputedSegments?.terrainEvidenceIncompleteCellKeys || []),
                ...(refresh.candidate?.incompleteCellKeys || []),
            ])].map(String).sort();
            const details = { cellKeys: cellKeys.slice(0, 8), cellCount: cellKeys.length,
                structural: refresh.precomputedSegments?.terrainEvidenceIncompleteStructural === true
                    || refresh.candidate?.structuralEvidenceIncomplete === true,
                missingChords: refresh.precomputedSegments?.terrainEvidenceMissingChordCount || 0,
                candidate: !!refresh.candidate };
            throw Object.assign(new Error('Rail receiver has incomplete terrain evidence'
                + (cellKeys.length ? ` in cell ${cellKeys[0]}${cellKeys.length > 1 ? ` (+${cellKeys.length - 1})` : ''}` : '')
                + (details.structural ? ' (structural)' : '')), { code: 'rail-receiver-evidence-unavailable', details });
        }
        prepared = yield* prepareRailCandidatePublicationSteps(refresh.candidate, { ground: refresh.ground,
            isCurrent: current, replaceRoot: true, formationPublication, features: admission.features,
            additionalEntries, preparePhysics: false, maxCells });
        if (!prepared || !current()) return null;
        const entries = prepared.entries.map((entry, index) => index === prepared.entries.length - 1 ? { ...entry, discard } : entry);
        handedOff = true;
        return { ...prepared, entries, isCurrent: () => current() && prepared.isCurrent(), discard,
            finalize() {
                if (settled || !prepared.finalize()) return false;
                admission.acknowledge?.({ x: centerX, z: centerZ });
                settled = true; release(); return true;
            } };
    } finally { if (!handedOff) discard(); }
}

// Readiness and currentness are checked on every visit, including the visit
// immediately before publication. Failure preserves one pending obligation.
function stepPendingRailVisualPreparation() {
    const refresh = pendingRailVisualRefresh;
    if (!refresh) return false;
    if (refresh.candidate?.committed) return true;
    if (refresh.failure) {
        const capacityReleased = refresh.failure.code === 'terrain-publication-capacity'
            && typeof lastTerrain?.readReleaseRevision === 'number'
            && refresh.readReleaseRevision !== lastTerrain.readReleaseRevision;
        if (refresh.failure.isCurrent() && !capacityReleased) return false;
        restartPendingRailVisualRefresh(refresh);
        return false;
    }
    if (refresh.ground && !refresh.ground.isCurrent()) {
        restartPendingRailVisualRefresh(refresh);
        return false;
    }
    try {
        if (!stepRailVisualPreparation(refresh)) return false;
    } catch (error) {
        failRailVisualRefresh(refresh, error);
        throw error;
    }
    if (!refresh.ground.isCurrent()) {
        restartPendingRailVisualRefresh(refresh);
        return false;
    }
    return true;
}

function restartPendingRailVisualRefresh(refresh) {
    const replacement = { centerX: refresh.centerX, centerZ: refresh.centerZ, reason: refresh.reason,
        streamedSignature: refresh.streamedSignature, streamedInputRevision: refresh.streamedInputRevision,
        features: refresh.features, formationPublication: refresh.formationPublication };
    refresh.formationPublication = null;
    discardPendingRailVisualRefresh();
    pendingRailVisualRefresh = replacement;
    return replacement;
}

function failRailVisualRefresh(refresh, error) {
    const isCurrent = refresh.captureInputsCurrent;
    const replacement = restartPendingRailVisualRefresh(refresh);
    replacement.failure = { code: error.code || 'rail-visual-build', message: String(error.message || error), isCurrent };
    replacement.readReleaseRevision = lastTerrain?.readReleaseRevision;
}

function discardPendingRailStructuresRefresh() {
    const refresh = pendingRailStructuresRefresh;
    if (!refresh) return;
    refresh.groundBuild?.return?.();
    refresh.groundBuild = null;
    cancelRailGpuUploadStage(refresh, {
        iteratorProperty: 'prewarm',
        jobProperty: 'prewarmJob',
    });
    if (refresh.structuresGroup && refresh.structuresGroup !== railStructuresGroup) {
        enqueueRailRetirement(refresh.structuresGroup);
    }
    refresh.structuresGroup = null;
    refresh.ground?.release();
    refresh.ground = null;
    pendingRailStructuresRefresh = null;
}

function discardPendingCrossingFormationRefresh() {
    const refresh = pendingCrossingFormationRefresh;
    if (!refresh) return;
    if (refresh.publicationJob) railCellQueue?.cancel(refresh.publicationJob);
    refresh.publicationSteps?.return?.();
    refresh.formationPublication?.discard();
    cancelRailDressingPreparation(refresh);
    refresh.groundBuild?.return?.();
    refresh.groundBuild = null;
    cancelRailGpuUploadStage(refresh, {
        iteratorProperty: 'prewarm',
        jobProperty: 'prewarmJob',
    });
    if (refresh.replacement && !refresh.candidate?.committed) enqueueRailRetirement(refresh.replacement);
    refresh.replacement = null;
    refresh.ground?.release();
    refresh.ground = null;
    pendingCrossingFormationRefresh = null;
}

function buildUndergroundStationFlareProfiles(
    features,
    stops,
    anchorLat,
    anchorLon,
    photoTrackFrame = null,
) {
    const metersPerDegree = DEG_TO_RAD * EARTH_RADIUS_M;
    const scaleLon = metersPerDegree * Math.cos(anchorLat * DEG_TO_RAD);
    const rawRoutes = [];
    for (let featureIndex = 0; featureIndex < (features || []).length; featureIndex++) {
        const feature = features[featureIndex];
        const coords = feature?.geometry?.type === 'LineString'
            ? feature.geometry.coordinates
            : null;
        if (!coords || coords.length < 2) continue;
        const properties = feature.properties || {};
        const usesPhotoFrame = properties.elevationDatum === 'asl' && !!photoTrackFrame;
        rawRoutes.push(...splitStationTrackRouteBySegmentOwners({
            routeKey: featureIndex,
            trackId: properties.trackId ?? null,
            trackIds: Array.isArray(properties.trackIds) ? properties.trackIds : [],
            segmentTrackIds: Array.isArray(properties.segmentTrackIds)
                ? properties.segmentTrackIds
                : null,
            properties,
            usesPhotoFrame,
            points: coords.map(([lon, lat, relativeHeightM = 0]) => {
                const point = usesPhotoFrame
                    ? photoTrackFrame.toScene(lon, lat, Number(relativeHeightM) || 0)
                    : {
                        x: (lon - anchorLon) * scaleLon,
                        y: Number(relativeHeightM) || 0,
                        z: -(lat - anchorLat) * metersPerDegree,
                    };
                return { ...point, lon, lat, relativeHeightM: Number(relativeHeightM) || 0 };
            }),
        }));
    }
    const routes = prepareStationTrackRoutes(rawRoutes);
    return (stops || [])
        .filter((stop) => {
            if (!photoTrackFrame || stop?.trackId == null) return getPlannerStopLevel(stop) === -1;
            return getPhotorealStationStructure(stop) === 'tunnel'
                && canBuildPhotorealRigidStation(stop);
        })
        .map(stop => {
            const lon = Number(stop?.lng ?? stop?.lon);
            const lat = Number(stop?.lat);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
            const trackId = stop?.trackId ?? null;
            const usesPhotoFrame = !!photoTrackFrame && routes.some(route => (
                route.usesPhotoFrame && stationTrackRouteMatches(route, trackId)
            ));
            const local = usesPhotoFrame
                ? photoTrackFrame.toScene(lon, lat, Number(stop?.elevM) || 0)
                : {
                    x: (lon - anchorLon) * scaleLon,
                    z: -(lat - anchorLat) * metersPerDegree,
                };
            const anchor = resolvePlannerStationTrackAnchor({
                stopX: local.x,
                stopZ: local.z,
                stopTrackId: trackId,
                usePhotoFrame: usesPhotoFrame,
                routes,
                tangentHalfSpanM: 12,
                maxSnapDistanceM: trackId == null ? 2 : Infinity,
            });
            if (!anchor) return null;
            const coveredRoute = !usesPhotoFrame && modelStationNeedsCoveredRoute(anchor)
                ? getModelCoveredStationRouteRange(anchor)
                : null;
            return {
                x: anchor.x,
                z: anchor.z,
                trackId,
                coveredRoute: coveredRoute ? {
                    route: anchor.route,
                    startM: coveredRoute.startM,
                    endM: coveredRoute.endM,
                } : null,
            };
        })
        .filter(Boolean);
}

function featureMatchesStation(properties, station) {
    if (station.trackId == null) return true;
    const key = String(station.trackId);
    if (properties?.trackId != null && String(properties.trackId) === key) return true;
    return (properties?.trackIds || []).some(trackId => String(trackId) === key);
}

// Track spacing is resolved per polyline vertex and swept linearly between
// them. Planner routes only carry vertices where the user bent the line, so a
// long straight underground run can cross a whole station without one vertex
// inside its flare envelope: both endpoints then resolve to running spacing
// and the rails sweep straight through the island platform. Sample the
// envelope explicitly instead of hoping a vertex lands in it.
const STATION_FLARE_ENVELOPE_M = PLANNER_UNDERGROUND_STATION_CORE_HALF_LENGTH_M
    + PLANNER_UNDERGROUND_STATION_FLARE_LENGTH_M;
const STATION_FLARE_SAMPLE_STEP_M = 4;

function densifyCoordsForStationFlares(coords, properties, stationFlares, toLocal) {
    const stations = (stationFlares || []).filter(station => (
        featureMatchesStation(properties, station)
    ));
    if (stations.length === 0 || !coords || coords.length < 2) return coords;

    const reachM = STATION_FLARE_ENVELOPE_M + STATION_FLARE_SAMPLE_STEP_M;
    const densified = [];
    for (let i = 0; i < coords.length - 1; i++) {
        const from = coords[i];
        const to = coords[i + 1];
        densified.push(from);
        const start = toLocal(from[0], from[1]);
        const end = toLocal(to[0], to[1]);
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const lengthSq = dx * dx + dz * dz;
        const lengthM = Math.sqrt(lengthSq);
        if (lengthM < STATION_FLARE_SAMPLE_STEP_M) continue;

        const fractions = new Set();
        for (const station of stations) {
            // Where does this chord enter and leave the station's envelope?
            const nearestT = ((station.x - start.x) * dx + (station.z - start.z) * dz) / lengthSq;
            const perpM = Math.hypot(
                start.x + dx * nearestT - station.x,
                start.z + dz * nearestT - station.z,
            );
            if (perpM >= reachM) continue;
            const halfChordM = Math.sqrt(reachM * reachM - perpM * perpM);
            const enterT = Math.max(0, nearestT - halfChordM / lengthM);
            const leaveT = Math.min(1, nearestT + halfChordM / lengthM);
            if (leaveT <= enterT) continue;
            const steps = Math.max(1, Math.ceil(
                (leaveT - enterT) * lengthM / STATION_FLARE_SAMPLE_STEP_M,
            ));
            for (let step = 0; step <= steps; step++) {
                const t = enterT + (leaveT - enterT) * (step / steps);
                if (t > 1e-6 && t < 1 - 1e-6) fractions.add(t);
            }
        }
        const startElev = Number.isFinite(from[2]) ? from[2] : 0;
        const endElev = Number.isFinite(to[2]) ? to[2] : 0;
        for (const t of [...fractions].sort((left, right) => left - right)) {
            densified.push([
                from[0] + (to[0] - from[0]) * t,
                from[1] + (to[1] - from[1]) * t,
                startElev + (endElev - startElev) * t,
            ]);
        }
    }
    densified.push(coords[coords.length - 1]);
    return densified;
}

// DTM samples are roughly 20 m apart. Long OSM chords need matching interior
// vertices or their rails would bridge over whole hillsides in one straight
// line even though the terrain mesh below is correctly sampled.
function densifyCoordsForTerrain(coords, terrain, toLocal, maxSegmentM = 20) {
    if (!terrain || !coords || coords.length < 2) return coords;
    const densified = [];
    for (let index = 0; index < coords.length - 1; index++) {
        const from = coords[index];
        const to = coords[index + 1];
        densified.push(from);
        const start = toLocal(from[0], from[1]);
        const end = toLocal(to[0], to[1]);
        const steps = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.z - start.z) / maxSegmentM));
        const startElevation = Number.isFinite(Number(from[2])) ? Number(from[2]) : 0;
        const endElevation = Number.isFinite(Number(to[2])) ? Number(to[2]) : 0;
        for (let step = 1; step < steps; step++) {
            const t = step / steps;
            densified.push([
                from[0] + (to[0] - from[0]) * t,
                from[1] + (to[1] - from[1]) * t,
                startElevation + (endElevation - startElevation) * t,
            ]);
        }
    }
    densified.push(coords[coords.length - 1]);
    return densified;
}

function featureOwnsCorridor(feature, volume) {
    const properties = feature?.properties || {};
    const featureIds = new Set();
    if (properties.trackId != null) featureIds.add(String(properties.trackId));
    for (const trackId of properties.trackIds || []) featureIds.add(String(trackId));
    if (volume.ownerTrackId != null && featureIds.has(String(volume.ownerTrackId))) return true;
    return (volume.ownerTrackIds || []).some(trackId => featureIds.has(String(trackId)));
}

function segmentIntersectsCorridorFootprint(x1, z1, x2, z2, volume, padding = 0.25) {
    const toLocal = (x, z) => {
        const dx = x - volume.centerX;
        const dz = z - volume.centerZ;
        return {
            right: dx * volume.rightX + dz * volume.rightZ,
            along: dx * volume.alongX + dz * volume.alongZ,
        };
    };
    const a = toLocal(x1, z1);
    const b = toLocal(x2, z2);
    const minRight = -volume.halfWidth - padding;
    const maxRight = volume.halfWidth + padding;
    const minAlong = -volume.halfDepth - padding;
    const maxAlong = volume.halfDepth + padding;
    let tMin = 0;
    let tMax = 1;
    const clip = (origin, delta, min, max) => {
        if (Math.abs(delta) < 1e-9) return origin >= min && origin <= max;
        let enter = (min - origin) / delta;
        let exit = (max - origin) / delta;
        if (enter > exit) [enter, exit] = [exit, enter];
        tMin = Math.max(tMin, enter);
        tMax = Math.min(tMax, exit);
        return tMin <= tMax;
    };
    return clip(a.right, b.right - a.right, minRight, maxRight)
        && clip(a.along, b.along - a.along, minAlong, maxAlong);
}

function isRailSegmentOverUndergroundRamp(feature, x1, z1, x2, z2, yStart, yEnd, volumes) {
    // A genuine viaduct may cross above an open ramp. Everything else is
    // removed unless it belongs to the ramp's own planner track.
    if (Math.min(yStart, yEnd) > 0.5) return false;
    return (volumes || []).some(volume =>
        !featureOwnsCorridor(feature, volume)
        && segmentIntersectsCorridorFootprint(x1, z1, x2, z2, volume));
}

function createTrackbedFlatCurbTexture() {
    const W = 128, H = 32;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(W, H);
    const data = image.data;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const grain = Math.floor((Math.random() - 0.5) * 22);
            const speck = Math.random() < 0.025 ? -24 : 0;
            const tone = Math.max(54, Math.min(116, 88 + grain + speck));
            data[i + 0] = tone + 5;
            data[i + 1] = tone + 3;
            data[i + 2] = tone;
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    // Repeating transverse joint plus dirty long edges: visibly a flush row
    // of curb stones, not another strip of roadbed.
    ctx.fillStyle = 'rgba(28,27,25,0.86)';
    ctx.fillRect(0, 0, 2.2, H);
    ctx.fillStyle = 'rgba(34,33,30,0.78)';
    ctx.fillRect(0, 0, W, 2);
    ctx.fillRect(0, H - 2, W, 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    return texture;
}

function makeNodeKey(lng, lat) {
    return `${Number(lng).toFixed(7)},${Number(lat).toFixed(7)}`;
}

const TRACK_JOIN_MITER_LIMIT = 3;

function makeJoinVector(a, b) {
    if (!a) return b || { x: 1, z: 0 };
    if (!b) return a;
    // Normals can be sign-reversed when neighbouring OSM ways use opposite
    // coordinate directions. The bed is symmetric, so align them before
    // averaging; rail side labels may swap but the physical pair still joins.
    let bx = b.x, bz = b.z;
    if (a.x * bx + a.z * bz < 0) { bx = -bx; bz = -bz; }
    let mx = a.x + bx, mz = a.z + bz;
    const len = Math.hypot(mx, mz);
    if (len < 1e-5) return a;
    mx /= len;
    mz /= len;
    const denom = Math.max(1 / TRACK_JOIN_MITER_LIMIT, Math.abs(mx * bx + mz * bz));
    const scale = Math.min(TRACK_JOIN_MITER_LIMIT, 1 / denom);
    return { x: mx * scale, z: mz * scale };
}

function alignJoinVector(join, normal) {
    return join.x * normal.x + join.z * normal.z < 0
        ? { x: -join.x, z: -join.z }
        : join;
}

function getUncoveredSwitchMarkerGeo() {
    if (!uncoveredSwitchMarkerGeo) {
        uncoveredSwitchMarkerGeo = new THREE.SphereGeometry(UNCOVERED_SWITCH_MARKER_RADIUS_M, 12, 10);
        registerShared(uncoveredSwitchMarkerGeo);
    }
    return uncoveredSwitchMarkerGeo;
}

function getUncoveredSwitchMarkerMat() {
    if (!uncoveredSwitchMarkerMat) {
        uncoveredSwitchMarkerMat = new THREE.MeshStandardMaterial({
            color: 0xfacc15,
            emissive: 0x7c5a00,
            roughness: 0.6,
            metalness: 0.05,
        });
        registerShared(uncoveredSwitchMarkerMat);
    }
    return uncoveredSwitchMarkerMat;
}

function buildUncoveredSwitchMarkers(
    graph,
    switchRules,
    routedSegments,
    anchorLat,
    anchorLon,
    maxRadiusM,
    centerX = 0,
    centerZ = 0,
) {
    if (!graph || !routedSegments || !window.TramSwitchUtils || typeof window.TramSwitchUtils.getUncoveredSwitchInfos !== 'function') {
        return null;
    }

    const coverageStartedMs = performance.now();
    let uncovered;
    if (uncoveredSwitchCoverageCache?.graph === graph
        && uncoveredSwitchCoverageCache.switchRules === switchRules
        && uncoveredSwitchCoverageCache.routedSegments === routedSegments) {
        uncovered = uncoveredSwitchCoverageCache.uncovered;
    } else {
        const directedUsage = typeof window.TramSwitchUtils.buildDirectedSwitchUsage === 'function'
            ? window.TramSwitchUtils.buildDirectedSwitchUsage(graph, routedSegments)
            : null;
        uncovered = window.TramSwitchUtils.getUncoveredSwitchInfos(
            graph,
            switchRules,
            directedUsage,
        );
        // These three inputs are immutable for one rail session. Terrain and
        // streamed road revisions rebuild visual rails but cannot alter switch
        // coverage, so retain the expensive topology answer until endSession.
        uncoveredSwitchCoverageCache = {
            graph,
            switchRules,
            routedSegments,
            uncovered,
        };
    }
    recordLayerFrameMs('rails:markers:coverage', performance.now() - coverageStartedMs);
    if (!uncovered || uncovered.length === 0) return null;

    const assemblyStartedMs = performance.now();
    const M_PER_DEG = DEG_TO_RAD * EARTH_RADIUS_M;
    const cosAnchor = Math.cos(anchorLat * DEG_TO_RAD);
    const SCALE_LON = M_PER_DEG * cosAnchor;
    const markerGroup = new THREE.Group();
    markerGroup.name = 'UncoveredTramSwitchMarkers';

    for (const coverage of uncovered) {
        const node = graph.nodes[coverage.switchNodeId];
        if (!node) continue;
        const x = (node.lng - anchorLon) * SCALE_LON;
        const z = -(node.lat - anchorLat) * M_PER_DEG;
        if (!isPointWithinRenderWindow(x, z, centerX, centerZ, maxRadiusM)) continue;
        const marker = new THREE.Mesh(getUncoveredSwitchMarkerGeo(), getUncoveredSwitchMarkerMat());
        marker.position.set(x, UNCOVERED_SWITCH_MARKER_Y, z);
        const scale = coverage.hasAnyRules ? 1.0 : 1.25;
        marker.scale.setScalar(scale);
        marker.userData.switchCoverage = coverage;
        marker.userData.switchKey = coverage.switchKey;
        marker.userData.missingIncomingKeys = coverage.missingIncomingKeys.slice();
        marker.castShadow = false;
        marker.receiveShadow = false;
        markerGroup.add(marker);
    }

    recordLayerFrameMs('rails:markers:assembly', performance.now() - assemblyStartedMs);

    return markerGroup.children.length > 0 ? markerGroup : null;
}

function authoredRailSceneY(properties, elevationM, railFormation, terrain) {
    return authoredAbsoluteRailSceneY({
        elevationM,
        elevationMode: properties?.elevationMode,
        elevationDatum: properties?.elevationDatum,
        absoluteToSceneY: heightM => {
            const fromFormation = finiteOrNull(
                railFormation?.absoluteSceneYAtHeight?.(heightM),
            );
            return fromFormation !== null
                ? fromFormation
                : terrain?.absoluteToSceneY?.(heightM);
        },
    });
}

function markTerrainEvidenceIncomplete(items, {
    cellKeys = [],
    structural = false,
    missingChordCount = 0,
} = {}) {
    const incompleteCellKeys = Object.freeze(
        [...new Set(cellKeys || [])].map(String).sort(),
    );
    const incomplete = structural || incompleteCellKeys.length > 0;
    if (incomplete) {
        Object.defineProperty(items, 'terrainEvidenceIncomplete', {
            value: true,
            enumerable: false,
        });
        Object.defineProperty(items, 'terrainEvidenceIncompleteCellKeys', {
            value: incompleteCellKeys,
            enumerable: false,
        });
        Object.defineProperty(items, 'terrainEvidenceIncompleteStructural', {
            value: structural === true,
            enumerable: false,
        });
        Object.defineProperty(items, 'terrainEvidenceMissingChordCount', {
            value: Math.max(0, Number(missingChordCount) || 0),
            enumerable: false,
        });
    }
    return items;
}

function retainPublishedRailSegmentsForIncompleteOwners(
    nextSegments,
    previousSegments,
    incompleteCellKeys,
) {
    const protectedKeys = new Set(incompleteCellKeys || []);
    const protectStructural = nextSegments?.terrainEvidenceIncompleteStructural === true;
    if (protectedKeys.size === 0 && !protectStructural) return nextSegments;
    const belongsToProtectedOwner = segment => (
        (protectStructural && isPotentialRoadCarriedTramFeature(segment))
        || protectedKeys.has(railSegmentMidpointCellKey(segment))
    );
    const retained = [
        ...(nextSegments || []).filter(segment => !belongsToProtectedOwner(segment)),
        ...(previousSegments || []).filter(belongsToProtectedOwner),
    ];
    return markTerrainEvidenceIncomplete(retained, {
        cellKeys: protectedKeys,
        structural: nextSegments?.terrainEvidenceIncompleteStructural === true,
        missingChordCount: nextSegments?.terrainEvidenceMissingChordCount,
    });
}

function finalizeComputedRailTrackbedSegments(segments, {
    terrainEvidenceIncompleteCellKeys = new Set(),
    terrainEvidenceIncompleteStructural = false,
    terrainEvidenceMissingChordCount = 0,
    formationQueryMs = 0,
} = {}) {
    const tStructuralCorridors = performance.now();
    const canonicalSegments = canonicalizeStructuralTramCorridors(segments, {
        targetCenterSpacingM: segment => getTrackCenterSpacingMeters(
            segment?.feature?.properties || segment?.properties || {},
        ),
    });
    // Preserve the unlifted vertical solution. A terrain-only OSM refresh can
    // then resample every endpoint and apply junction lifts exactly once,
    // without repeating densification and the complete horizontal solve.
    for (const segment of canonicalSegments) {
        segment._railBaseYStart = segment.yStart;
        segment._railBaseYEnd = segment.yEnd;
    }
    segments.splice(0, segments.length, ...canonicalSegments);
    recordLayerFrameMs(
        'rails:segs:structuralCorridors',
        performance.now() - tStructuralCorridors,
    );
    // Degree-two nodes are ordinary continuations even when an OSM way split
    // puts the two segments in different features. Give both endpoints one
    // shared cross-section so their bed and rail edges meet exactly.
    const incidentsByNode = new Map();
    for (const segment of segments) {
        const start = incidentsByNode.get(segment.startKey) || [];
        start.push({ segment, endpoint: 'start', normal: { x: segment.px, z: segment.pz } });
        incidentsByNode.set(segment.startKey, start);
        const end = incidentsByNode.get(segment.endKey) || [];
        end.push({ segment, endpoint: 'end', normal: { x: segment.px, z: segment.pz } });
        incidentsByNode.set(segment.endKey, end);
    }
    for (const incidents of incidentsByNode.values()) {
        if (incidents.length !== 2) continue;
        const shared = makeJoinVector(incidents[0].normal, incidents[1].normal);
        for (const incident of incidents) {
            const join = alignJoinVector(shared, incident.normal);
            if (incident.endpoint === 'start') {
                incident.segment.startJoinX = join.x;
                incident.segment.startJoinZ = join.z;
            } else {
                incident.segment.endJoinX = join.x;
                incident.segment.endJoinZ = join.z;
            }
        }
    }
    // Kept: this was 137 ms of a 182 ms phase before the cull moved above it,
    // and it is the number that would regress if anything expensive drifts back
    // ahead of the render-window test.
    recordLayerFrameMs('rails:segs:formationQuery', formationQueryMs);
    const tLifts = performance.now();
    const lifted = applyJunctionEndpointLifts(segments, TRACKBED_JUNCTION_Y_STEP);
    recordLayerFrameMs('rails:segs:junctionLifts', performance.now() - tLifts);
    return markTerrainEvidenceIncomplete(lifted, {
        cellKeys: terrainEvidenceIncompleteCellKeys,
        structural: terrainEvidenceIncompleteStructural,
        missingChordCount: terrainEvidenceMissingChordCount,
    });
}

export function computeRailTrackbedSegments(
    features,
    anchorLat,
    anchorLon,
    maxRadiusM = RAILS_RENDER_RADIUS_M,
    options = {},
) {
    if (!features || features.length === 0) {
        return options.rawResult === true
            ? {
                segments: [],
                terrainEvidenceIncompleteCellKeys: new Set(),
                terrainEvidenceIncompleteStructural: false,
                terrainEvidenceMissingChordCount: 0,
                formationQueryMs: 0,
                nextSegmentIndex: Number(options.segmentIndexOffset) || 0,
            }
            : [];
    }

    const M_PER_DEG = DEG_TO_RAD * EARTH_RADIUS_M;
    const cosAnchor = Math.cos(anchorLat * DEG_TO_RAD);
    const SCALE_LON = M_PER_DEG * cosAnchor;
    const centerX = Number(options.centerX) || 0;
    const centerZ = Number(options.centerZ) || 0;
    const stationFlares = options.stationFlares || [];
    // A route-following covered station still owns a tunnel cutout, but keeps
    // the ordinary track spacing and a side platform. Only rigid island halls
    // widen the two track centres through the station.
    const trackSpacingStationFlares = stationFlaresThatSplayTrackCenters(stationFlares);
    const terrain = options.terrain || null;
    const railFormation = options.railFormation || null;
    const roadVerticalAlignments = options.roadVerticalAlignments || null;
    const roadFormation = options.roadFormation || null;
    const photoTrackFrame = options.photoTrackFrame || null;

    const segments = [];
    const terrainEvidenceIncompleteCellKeys = new Set();
    let terrainEvidenceIncompleteStructural = false;
    let terrainEvidenceMissingChordCount = 0;
    let formationQueryMs = 0;
    let segmentIndex = Math.max(0, Number(options.segmentIndexOffset) || 0);
    for (const f of features) {
        // Tram rails inside proposal polygons would render through the
        // middle of a proposed lake / park / square. Mask same as roads.
        // Authored planner tracks run through their own district plan and can
        // be vertically separated from every footprint above them. A generic
        // 2D mask cannot delete that explicit tunnel/viaduct authority. Only
        // un-authored background rails remain eligible for proposal masking.
        if (!isAuthoredPlannerRailFeature(f) && (options.proposalMask
            ? options.proposalMask.isLineStringMasked(f) : isLineStringMaskedByProposals(f))) continue;
        const geom = f.geometry;
        if (!geom || geom.type !== 'LineString') continue;
        const trackProperties = f.properties || {};
        const ordinaryEmbeddedTram = isOrdinaryOsmTramFeature(f);
        const gaugeM = getTrackGaugeMeters(trackProperties);
        const isAuthoredPhotoProfile = trackProperties.elevationDatum === 'asl'
            && photoTrackFrame;
        const toLocal = (lng, lat, relativeHeightM = 0) => isAuthoredPhotoProfile
            ? photoTrackFrame.toScene(lng, lat, relativeHeightM)
            : {
                x: (lng - anchorLon) * SCALE_LON,
                z: -(lat - anchorLat) * M_PER_DEG,
                y: relativeHeightM,
            };
        // Densify one ORIGINAL owned segment at a time. Flattening the combined
        // feature first lost segmentTrackIds, allowing a station on one branch
        // to flare a colocated perpendicular branch owned by another track.
        const coords = [];
        const ownedProperties = [];
        const sourceCoords = geom.coordinates || [];
        for (let sourceIndex = 0; sourceIndex < sourceCoords.length - 1; sourceIndex++) {
            const segmentProperties = plannerSegmentOwnerProperties(trackProperties, sourceIndex);
            const terrainCoords = densifyCoordsForTerrain(
                [sourceCoords[sourceIndex], sourceCoords[sourceIndex + 1]],
                terrain,
                toLocal,
            );
            const segmentCoords = densifyCoordsForStationFlares(
                terrainCoords,
                segmentProperties,
                trackSpacingStationFlares,
                toLocal,
            );
            if (segmentCoords.length < 2) continue;
            if (coords.length === 0) coords.push(segmentCoords[0]);
            for (let index = 1; index < segmentCoords.length; index++) {
                coords.push(segmentCoords[index]);
                ownedProperties.push(segmentProperties);
            }
        }
        const localPoints = (coords || []).map(([lng, lat, elevation]) =>
            toLocal(lng, lat, Number.isFinite(Number(elevation)) ? Number(elevation) : 0));
        const embeddedRoadAtPoint = ordinaryEmbeddedTram
            ? createEmbeddedTramRoadEndpointResolver({
                roadFormation,
                feature: f,
                points: localPoints,
            })
            : null;
        const frames = [];
        for (let i = 0; i < localPoints.length - 1; i++) {
            const dx = localPoints[i + 1].x - localPoints[i].x;
            const dz = localPoints[i + 1].z - localPoints[i].z;
            const len = Math.hypot(dx, dz);
            frames.push(len > 1e-6 ? { x: dz / len, z: -dx / len } : null);
        }
        const joins = localPoints.map((_, i) => makeJoinVector(frames[i - 1], frames[i]));
        // Cumulative along-feature distance — used as the U origin for
        // each segment's trackbed quad so adjacent segments on a
        // straight stretch tile continuously instead of restarting the
        // pattern at every polyline vertex.
        let cumU = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            const segmentProperties = ownedProperties[i] || trackProperties;
            // Optional third component = track elevation in metres
            // (planner levels × 10 m); OSM features stay 2D → 0.
            const [lng1, lat1, elev1] = coords[i];
            const [lng2, lat2, elev2] = coords[i + 1];
            const x1 = localPoints[i].x;
            const z1 = localPoints[i].z;
            const x2 = localPoints[i + 1].x;
            const z2 = localPoints[i + 1].z;
            const cx = (x1 + x2) * 0.5;
            const cz = (z1 + z2) * 0.5;
            const dx = x2 - x1;
            const dz = z2 - z1;
            const len = Math.hypot(dx, dz);
            // Keep short connectors — smoothing fillets legitimately produce
            // sub-metre segments, and skipping them reads as gaps in the
            // trackbed. Only true slivers are dropped.
            // Curve smoothing can legitimately insert centimetre-scale
            // transition chords. Dropping anything below 20 cm left a dark
            // break across all four rails at exactly the places where a
            // horizontal or vertical curve changed segment. Keep every
            // meaningful chord; reject only numerical duplicate points.
            if (len < 0.01) continue;
            // Cull to the render window HERE, not eighty lines further down.
            //
            // Everything below — two railFormation.formationAtLocal spatial
            // queries per chord, the elevation resolution, the ramp/open-cut
            // test — used to run for every chord in the feature set, and only
            // then was the segment discarded for being outside the radius.
            // Measured: 14,602 chords doing 29,204 queries to produce 1,434
            // segments, so roughly nine in ten of those queries were thrown
            // away. formationQuery alone was 137 ms of a 182 ms phase.
            //
            // cumU MUST still advance: it is the U-texture origin along the
            // feature, and skipping it would restart the trackbed pattern at
            // the first visible chord after a gap.
            if (!isPointWithinRenderWindow(cx, cz, centerX, centerZ, maxRadiusM)) {
                cumU += len;
                continue;
            }
            // Planner tracks encode RELATIVE levels in coordinate[2]. A
            // proposal with authored EVRF2000 heights is already converted
            // to scene Y by RailFormationModel and must not add those absolute
            // metres a second time — and the same goes for ground-relative
            // authored elevations, which the formation seats as terrain +
            // offset: adding coordinate[2] here again would double the lift.
            const formationCarriesElevation = trackProperties.elevationMode === 'absolute'
                || trackProperties.elevationMode === 'ground-relative';
            const relativeYStart = !formationCarriesElevation && Number.isFinite(elev1) ? elev1 : 0;
            const relativeYEnd = !formationCarriesElevation && Number.isFinite(elev2) ? elev2 : 0;
            // Resolved by STATION (cumU is this chord's start station along the
            // feature), never by plan-nearest projection: a spiral/loop feature
            // holds BOTH passes of its self-crossing in one alignment, and the
            // nearest-in-plan segment at the crossing is arbitrarily the other
            // pass — which seated one chord end a deck below and hung the
            // trackbed as a vertical curtain between the levels. Station is
            // also cheaper than the two spatial queries this replaces.
            const tFormation0 = performance.now();
            const designedStart = railFormation?.formationAtFeatureStation(f, cumU);
            const designedEnd = railFormation?.formationAtFeatureStation(f, cumU + len);
            // An authored absolute profile remains the rail's provisional
            // vertical authority while its civil formation publication catches
            // up. This also covers visual-only tunnel companions. Falling back
            // to DGU terrain here makes the drivable rail visibly drape, then
            // jump into its cut/fill/tunnel once formation arrives.
            const authoredAbsoluteStartY = authoredRailSceneY(
                trackProperties,
                elev1,
                railFormation,
                terrain,
            );
            const authoredAbsoluteEndY = authoredRailSceneY(
                trackProperties,
                elev2,
                railFormation,
                terrain,
            );
            const railDirection = { x: dx, z: dz };
            const carriedRoadDeckStart = roadDeckForCarriedTramAtLocal(
                roadVerticalAlignments,
                f,
                x1,
                z1,
                railDirection,
            );
            const carriedRoadDeckEnd = roadDeckForCarriedTramAtLocal(
                roadVerticalAlignments,
                f,
                x2,
                z2,
                railDirection,
            );
            const embeddedRoadStart = embeddedRoadAtPoint?.(i, railDirection) || null;
            const embeddedRoadEnd = embeddedRoadAtPoint?.(i + 1, railDirection) || null;
            formationQueryMs += performance.now() - tFormation0;
            // No TerrainReference means an intentional flat model world. A
            // present reference with a null evidence sample means a terrain
            // world whose local source data has not arrived yet.
            const terrainEvidenceStart = terrain
                ? finiteOrNull(terrain.evidenceSceneYAt?.(lng1, lat1))
                : 0;
            const terrainEvidenceEnd = terrain
                ? finiteOrNull(terrain.evidenceSceneYAt?.(lng2, lat2))
                : 0;
            const embeddedRoadFallbackYStart = isAuthoredPhotoProfile
                ? localPoints[i].y
                : carriedRoadDeckStart
                    ? carriedRoadDeckStart.roadY
                    : designedStart
                        ? designedStart.railY + relativeYStart
                        : authoredAbsoluteStartY !== null
                            ? authoredAbsoluteStartY
                            : terrainEvidenceStart !== null
                                ? relativeYStart + terrainEvidenceStart
                                : null;
            const embeddedRoadFallbackYEnd = isAuthoredPhotoProfile
                ? localPoints[i + 1].y
                : carriedRoadDeckEnd
                    ? carriedRoadDeckEnd.roadY
                    : designedEnd
                        ? designedEnd.railY + relativeYEnd
                        : authoredAbsoluteEndY !== null
                            ? authoredAbsoluteEndY
                            : terrainEvidenceEnd !== null
                                ? relativeYEnd + terrainEvidenceEnd
                                : null;
            const embeddedRoadEligibleStart = !isAuthoredPhotoProfile && !carriedRoadDeckStart;
            const embeddedRoadEligibleEnd = !isAuthoredPhotoProfile && !carriedRoadDeckEnd;
            const yStart = embeddedRoadEligibleStart && embeddedRoadStart
                ? embeddedRoadStart.roadY
                : embeddedRoadFallbackYStart;
            const yEnd = embeddedRoadEligibleEnd && embeddedRoadEnd
                ? embeddedRoadEnd.roadY
                : embeddedRoadFallbackYEnd;
            if (finiteOrNull(yStart) === null || finiteOrNull(yEnd) === null) {
                // The fallback ground may remain visible, but a terrain-relative
                // rail chord is not publishable until both endpoints have real
                // elevation evidence. Retain only the atomic render cells that
                // own this strip or either junction fan; unrelated nearby cells
                // can still publish while a terrain revision retries the gap.
                terrainEvidenceMissingChordCount += 1;
                if (isPotentialRoadCarriedTramFeature(f)) {
                    // Structural tram geometry is still one unchunked sibling
                    // batch, so it retains the previous complete generation.
                    terrainEvidenceIncompleteStructural = true;
                } else {
                    for (const key of railSegmentOwnedCellKeys({
                        x1, z1, x2, z2,
                    })) terrainEvidenceIncompleteCellKeys.add(key);
                }
                cumU += len;
                continue;
            }
            const startTrackSpacingM = getOwnedEndpointTrackSpacingM(
                segmentProperties,
                x1,
                z1,
                isAuthoredPhotoProfile ? null : relativeYStart,
                trackSpacingStationFlares,
            );
            const endTrackSpacingM = getOwnedEndpointTrackSpacingM(
                segmentProperties,
                x2,
                z2,
                isAuthoredPhotoProfile ? null : relativeYEnd,
                trackSpacingStationFlares,
            );
            const startTrackCenterOffsetsM = getTrackCenterOffsetsAtSpacingMeters(
                segmentProperties,
                startTrackSpacingM,
            );
            const endTrackCenterOffsetsM = getTrackCenterOffsetsAtSpacingMeters(
                segmentProperties,
                endTrackSpacingM,
            );
            const startTrackbedHalfWidthM = getRenderedRailTrackbedHalfWidthAtSpacingMeters(
                segmentProperties,
                startTrackSpacingM,
            );
            const endTrackbedHalfWidthM = getRenderedRailTrackbedHalfWidthAtSpacingMeters(
                segmentProperties,
                endTrackSpacingM,
            );
            const startTrackbedInnerEdgeM = getTrackbedInnerEdgeAtSpacingMeters(
                segmentProperties,
                startTrackSpacingM,
            );
            const endTrackbedInnerEdgeM = getTrackbedInnerEdgeAtSpacingMeters(
                segmentProperties,
                endTrackSpacingM,
            );
            if (isRailSegmentOverUndergroundRamp(
                f,
                x1,
                z1,
                x2,
                z2,
                relativeYStart,
                relativeYEnd,
                options.rampOpenCutVolumes,
            )) {
                cumU += len;
                continue;
            }
            {
                const ux = dx / len;
                const uz = dz / len;
                segments.push({
                    cx, cz, len,
                    x1, z1, x2, z2,
                    feature: f,
                    properties: segmentProperties,
                    angle: Math.atan2(dx, dz),
                    px: uz, pz: -ux,
                    startJoinX: joins[i].x,
                    startJoinZ: joins[i].z,
                    endJoinX: joins[i + 1].x,
                    endJoinZ: joins[i + 1].z,
                    uStart: cumU,
                    startKey: makeNodeKey(lng1, lat1),
                    endKey: makeNodeKey(lng2, lat2),
                    yStart,
                    yEnd,
                    relativeYStart,
                    relativeYEnd,
                    structureStart: designedStart?.structure || null,
                    structureEnd: designedEnd?.structure || null,
                    gaugeM,
                    heavyRail: isHeavyRailProperties(segmentProperties),
                    startTrackCenterOffsetsM,
                    endTrackCenterOffsetsM,
                    startTrackbedHalfWidthM,
                    endTrackbedHalfWidthM,
                    startTrackbedInnerEdgeM,
                    endTrackbedInnerEdgeM,
                    ...(ordinaryEmbeddedTram ? {
                        // The build just paid for these spatial queries. Keep
                        // the exact answers beside the transient segment so
                        // the post-build signature does not immediately query
                        // every endpoint again. Identity + revision make this
                        // unusable for detecting a later road-model change.
                        _embeddedRoadSupport: {
                            formation: options.roadSupportCacheSource ?? roadFormation,
                            revision: Number(roadFormation?.surfaceGeometryRevision ?? roadFormation?.revision) || 0,
                            publicationRevision: Number(roadFormation?.surfacePublicationRevision) || 0,
                            start: embeddedRoadStart,
                            end: embeddedRoadEnd,
                        },
                        _embeddedRoadFallbackYStart: embeddedRoadFallbackYStart,
                        _embeddedRoadFallbackYEnd: embeddedRoadFallbackYEnd,
                        _embeddedRoadEligibleStart: embeddedRoadEligibleStart,
                        _embeddedRoadEligibleEnd: embeddedRoadEligibleEnd,
                    } : {}),
                    _railAuthoredAbsoluteStartY: authoredAbsoluteStartY,
                    _railAuthoredAbsoluteEndY: authoredAbsoluteEndY,
                    sortKey: `${makeNodeKey(lng1, lat1)}>${makeNodeKey(lng2, lat2)}#${segmentIndex}`,
                });
                segmentIndex += 1;
            }
            cumU += len;
        }
    }
    const rawResult = {
        segments,
        terrainEvidenceIncompleteCellKeys,
        terrainEvidenceIncompleteStructural,
        terrainEvidenceMissingChordCount,
        formationQueryMs,
        nextSegmentIndex: segmentIndex,
    };
    if (options.rawResult === true) return rawResult;
    return finalizeComputedRailTrackbedSegments(segments, rawResult);
}

// Reuses the authoritative segment compiler one immutable source feature at a
// time. Cross-feature canonicalization, joins, and lifts still run once over
// the combined result, so the cooperative and synchronous outputs are exact.
export function* computeRailTrackbedSegmentsResumable(
    features,
    anchorLat,
    anchorLon,
    maxRadiusM = RAILS_RENDER_RADIUS_M,
    options = {},
) {
    const sourceFeatures = Array.isArray(features) ? features : [];
    const segments = [];
    const terrainEvidenceIncompleteCellKeys = new Set();
    let terrainEvidenceIncompleteStructural = false;
    let terrainEvidenceMissingChordCount = 0;
    let formationQueryMs = 0;
    let segmentIndex = 0;

    for (let featureIndex = 0; featureIndex < sourceFeatures.length; featureIndex++) {
        const result = computeRailTrackbedSegments(
            [sourceFeatures[featureIndex]],
            anchorLat,
            anchorLon,
            maxRadiusM,
            {
                ...options,
                rawResult: true,
                segmentIndexOffset: segmentIndex,
            },
        );
        segments.push(...result.segments);
        for (const key of result.terrainEvidenceIncompleteCellKeys) {
            terrainEvidenceIncompleteCellKeys.add(key);
        }
        terrainEvidenceIncompleteStructural ||= result.terrainEvidenceIncompleteStructural;
        terrainEvidenceMissingChordCount += result.terrainEvidenceMissingChordCount;
        formationQueryMs += result.formationQueryMs;
        segmentIndex = result.nextSegmentIndex;
        yield {
            phase: 'features',
            completed: featureIndex + 1,
            total: sourceFeatures.length,
        };
    }

    return finalizeComputedRailTrackbedSegments(segments, {
        terrainEvidenceIncompleteCellKeys,
        terrainEvidenceIncompleteStructural,
        terrainEvidenceMissingChordCount,
        formationQueryMs,
    });
}

// In OSM profile mode a terrain revision can alter vertical evidence but not
// LineString topology, gauge, joins, UV stationing, or render-cell ownership.
// Re-evaluate the same vertical precedence as computeRailTrackbedSegments over
// the already-solved chords, then reapply deterministic junction lifts once.
// Solved/profile modes do not use this path because terrain clearance can
// change their resolved feature geometry.
function resampleRailTrackbedSegmentsForTerrain(segments, options) {
    const {
        terrain,
        railFormation,
        roadFormation,
        roadVerticalAlignments,
        photoTrackFrame,
    } = options || {};
    const terrainEvidenceIncompleteCellKeys = new Set();
    let terrainEvidenceIncompleteStructural = false;
    let terrainEvidenceMissingChordCount = 0;
    const baseSegments = (segments || []).flatMap((segment) => {
        if (!segment) return [];
        const properties = segment.feature?.properties || segment.properties || {};
        const isAuthoredPhotoProfile = properties.elevationDatum === 'asl'
            && photoTrackFrame;
        const direction = {
            x: Number(segment.x2) - Number(segment.x1),
            z: Number(segment.z2) - Number(segment.z1),
        };
        const relativeYStart = finiteOrNull(segment.relativeYStart) ?? 0;
        const relativeYEnd = finiteOrNull(segment.relativeYEnd) ?? 0;
        const designedStart = railFormation?.formationAtFeatureStation?.(
            segment.feature,
            segment.uStart,
        );
        const designedEnd = railFormation?.formationAtFeatureStation?.(
            segment.feature,
            Number(segment.uStart) + Number(segment.len),
        );
        const carriedRoadDeckStart = roadDeckForCarriedTramAtLocal(
            roadVerticalAlignments,
            segment.feature,
            segment.x1,
            segment.z1,
            direction,
        );
        const carriedRoadDeckEnd = roadDeckForCarriedTramAtLocal(
            roadVerticalAlignments,
            segment.feature,
            segment.x2,
            segment.z2,
            direction,
        );
        const terrainStart = terrain
            ? finiteOrNull(terrain.evidenceSceneYAtLocal?.(segment.x1, segment.z1))
            : 0;
        const terrainEnd = terrain
            ? finiteOrNull(terrain.evidenceSceneYAtLocal?.(segment.x2, segment.z2))
            : 0;
        const authoredAbsoluteStartY = finiteOrNull(
            segment._railAuthoredAbsoluteStartY,
        );
        const authoredAbsoluteEndY = finiteOrNull(
            segment._railAuthoredAbsoluteEndY,
        );
        const fallbackStart = isAuthoredPhotoProfile
            ? (finiteOrNull(segment._railBaseYStart) ?? segment.yStart)
            : carriedRoadDeckStart
                ? carriedRoadDeckStart.roadY
                : designedStart
                    ? designedStart.railY + relativeYStart
                    : authoredAbsoluteStartY !== null
                        ? authoredAbsoluteStartY
                        : terrainStart !== null
                            ? relativeYStart + terrainStart
                            : null;
        const fallbackEnd = isAuthoredPhotoProfile
            ? (finiteOrNull(segment._railBaseYEnd) ?? segment.yEnd)
            : carriedRoadDeckEnd
                ? carriedRoadDeckEnd.roadY
                : designedEnd
                    ? designedEnd.railY + relativeYEnd
                    : authoredAbsoluteEndY !== null
                        ? authoredAbsoluteEndY
                        : terrainEnd !== null
                            ? relativeYEnd + terrainEnd
                            : null;
        if (finiteOrNull(fallbackStart) === null || finiteOrNull(fallbackEnd) === null) {
            terrainEvidenceMissingChordCount += 1;
            if (isPotentialRoadCarriedTramFeature(segment)) {
                terrainEvidenceIncompleteStructural = true;
            } else {
                for (const key of railSegmentOwnedCellKeys(segment)) {
                    terrainEvidenceIncompleteCellKeys.add(key);
                }
            }
            return [];
        }
        return [{
            ...segment,
            yStart: fallbackStart,
            yEnd: fallbackEnd,
            structureStart: designedStart?.structure || null,
            structureEnd: designedEnd?.structure || null,
            _railBaseYStart: fallbackStart,
            _railBaseYEnd: fallbackEnd,
            ...(isOrdinaryOsmTramFeature(segment) ? {
                _embeddedRoadFallbackYStart: fallbackStart,
                _embeddedRoadFallbackYEnd: fallbackEnd,
                _embeddedRoadEligibleStart: !isAuthoredPhotoProfile
                    && !carriedRoadDeckStart,
                _embeddedRoadEligibleEnd: !isAuthoredPhotoProfile
                    && !carriedRoadDeckEnd,
            } : {}),
        }];
    });
    return markTerrainEvidenceIncomplete(
        applyJunctionEndpointLifts(
            resampleEmbeddedTramRoadSegmentHeights(roadFormation, baseSegments, {
                supportCacheSource: options.roadSupportCacheSource ?? roadFormation,
            }),
            TRACKBED_JUNCTION_Y_STEP,
        ),
        {
            cellKeys: terrainEvidenceIncompleteCellKeys,
            structural: terrainEvidenceIncompleteStructural,
            missingChordCount: terrainEvidenceMissingChordCount,
        },
    );
}

// Level-crossing wall suppression. Where an AT-GRADE track crosses a road, the
// battered concrete retaining wall along BOTH trackbed edges would wall the
// (undipped) road into a concrete trough — the reported "underpass". A lone
// at-grade node between fill nodes leaves the flanking segments walled, so the
// road threads between two rising walls. Flagging the ring segments near the
// crossing internal makes buildRetainingWallPositionsSteps + the collar builder skip
// them, so the road stays flat and crosses the trackbed at grade. Only genuine
// at-grade crossings are touched (fill ≤ ~0.6 m there, walls near-zero anyway),
// so no fill/cut/viaduct wall is ever dropped. Idempotent: flags persist on the
// cached profiles, so a later rail rebuild honours them.
const LEVEL_CROSSING_WALL_CLEAR_M = 4.5;   // ~road half-width + a small margin
function* flagRetainingWallsForCrossingsSteps(railFormation, crossings, isCurrent) {
    if (!crossings.length) return 0;
    let suppressed = 0, started = performance.now();
    for (const profile of railFormation?.getSurfaceProfiles?.() || []) {
        if (performance.now() - started >= .5) { yield { phase: 'crossing-wall-profile' }; started = performance.now(); }
        if (!isCurrent()) return null;
        const points = profile?.points, flags = profile?.internalSegments;
        if (!Array.isArray(points) || !Array.isArray(flags)) continue;
        for (let i = 0; i < points.length; i++) {
            if (performance.now() - started >= .5) { yield { phase: 'crossing-wall-segment' }; started = performance.now(); }
            if (!isCurrent()) return null;
            if (flags[i]) continue;
            const a = points[i], b = points[(i + 1) % points.length];
            const mx = (a.innerX + b.innerX) / 2, mz = (a.innerZ + b.innerZ) / 2;
            for (const crossing of crossings) {
                if (performance.now() - started >= .5) { yield { phase: 'crossing-wall-candidate' }; started = performance.now(); }
                if (!isCurrent()) return null;
                const r = (Number(crossing.halfWidthM) || 3) + LEVEL_CROSSING_WALL_CLEAR_M;
                if ((mx - crossing.x) ** 2 + (mz - crossing.z) ** 2 <= r * r) {
                    flags[i] = true; suppressed++; break;
                }
            }
        }
    }
    if (suppressed) noteRailCivilGroundMutation(railFormation);
    return suppressed;
}

// Rails owns the ONE level-crossing detection. As /roads tiles stream in (and
// evict as the cab moves), new at-grade track×road crossings appear near the
// track; accumulate them permanently, keyed by rounded position (a crossing is
// a fixed feature — its zebra must not vanish when its road tile evicts). The
// rendering layer (world/level-crossings.js) reads this shared set.
let levelCrossingAccum = new Map();
let levelCrossingAccumRevision = 0;
let roadUnderRailOpeningAccum = new Map();
export function getAccumulatedLevelCrossings() {
    return { crossings: [...levelCrossingAccum.values()], revision: levelCrossingAccumRevision };
}

// The island-hall stations whose envelope the last rails build actually widened
// the two track centres for. Anything that rides these rails must take its
// lateral offset from THIS list rather than deciding for itself which stops
// flare, or it ends up beside the track instead of on it. Empty before the
// first rails build, which is the safe answer: ordinary running spacing.
export function getStationTrackSpacingFlares() {
    return lastTrackSpacingStationFlares;
}

// Read-only contract for layers that must sit on the exact rendered alignment.
export function getSampledRailTrackbedSegments() {
    return { segments: lastSampledTrackbedSegments, revision: sampledTrackbedRevision };
}

// Build one coverage successor from all changed and retained cells. Model,
// ring/index data and revision acknowledgements stay private until commit.
function* prepareRenderedRailSurfaceCoverageSteps(cellRegions, {
    ground, railSource = lastRailFormation, terrainSource = lastTerrain,
    isCurrent = () => true, now = () => performance.now(),
}) {
    if (!ground || !Object.hasOwn(ground, 'terrain') || !Object.hasOwn(ground, 'railFormation')) {
        throw new TypeError('Rail coverage requires explicit ground inputs');
    }
    const provider = lastTerrain, session = railSessionToken;
    const previous = { revision: renderedRailSurfaceRevision,
        model: provider?.renderedRailSurface || null, terrainRevision: renderedRailTerrainCutoutRevision,
        terrainSignature: renderedRailTerrainCutoutPublishedSignature,
        viaductRevision: viaductTerrainCutoutRevision, viaductSignature: viaductTerrainCutoutPublishedSignature,
        viaductCache: viaductTerrainCutoutCache };
    const current = () => isCurrent() && session === railSessionToken && lastTerrain === provider
        && renderedRailSurfaceRevision === previous.revision
        && renderedRailTerrainCutoutRevision === previous.terrainRevision
        && viaductTerrainCutoutRevision === previous.viaductRevision;
    if (!current()) return null;
    const regions = [], terrainCutouts = [];
    const terrainY = ground.terrain?.evidenceSceneYAtLocal
        ? (x, z) => ground.terrain.evidenceSceneYAtLocal(x, z) : null;
    let started = now();
    for (const values of cellRegions.values()) {
        if (now() - started >= .5) {
            yield { phase: 'rail-cell-coverage' }; started = now();
            if (!current()) return null;
        }
        for (const region of values) {
            if (now() - started >= .5) {
                yield { phase: 'rail-cell-coverage-regions' }; started = now();
                if (!current()) return null;
            }
            regions.push(region);
            // Embedded tram retains its exact stencil strips and central gap;
            // broad terrain ownership belongs only to continuous opaque beds.
            if (region.ownsCivilGround !== true) terrainCutouts.push(...activateRenderedRailTerrainCutoutRegions([region], terrainY));
        }
    }
    const terrainSignature = yield* renderedRailTerrainCutoutRegionsSignatureSteps(terrainCutouts, { now, isCurrent: current });
    if (terrainSignature === null) return null;
    const nextRevision = (oldSignature, signature, oldRevision, count) => oldSignature === ''
        ? oldRevision + (count > 0 ? 1 : 0) : oldRevision + (signature !== oldSignature ? 1 : 0);
    const terrainRevision = nextRevision(previous.terrainSignature, terrainSignature, previous.terrainRevision, terrainCutouts.length);
    const sourceRevision = Number(ground.terrain?.revision) || 0;
    let viaductCache = previous.viaductCache;
    if (!viaductCache || viaductCache.railFormation !== railSource || viaductCache.terrain !== terrainSource
        || viaductCache.terrainRevision !== sourceRevision) {
        const candidates = yield* buildViaductTerrainCutoutRegionsSteps(ground.railFormation?.getViaductRuns?.() || [], {
            trackbedSurfaceOffsetM: TRACKBED_Y, coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            now, isCurrent: current,
        });
        if (!candidates) return null;
        const active = [];
        for (const candidate of candidates) {
            if (now() - started >= .5) {
                yield { phase: 'rail-viaduct-activation' }; started = now();
                if (!current()) return null;
            }
            active.push(...activateViaductTerrainCutoutRegions([candidate], terrainY));
        }
        const signature = yield* renderedRailTerrainCutoutRegionsSignatureSteps(active, { now, isCurrent: current });
        if (signature === null) return null;
        viaductCache = { railFormation: railSource, terrain: terrainSource, terrainRevision: sourceRevision,
            regions: active, signature,
            revision: nextRevision(previous.viaductSignature, signature, previous.viaductRevision, active.length) };
    }
    const model = yield* createRenderedRailSurfaceMaskModelFromRegionsSteps(regions, {
        revision: previous.revision + 1, terrainCutoutRegions: terrainCutouts, terrainCutoutRevision: terrainRevision,
        viaductTerrainCutoutRegions: viaductCache.regions, viaductTerrainCutoutRevision: viaductCache.revision,
        now, isCurrent: current,
    });
    if (!model || !current()) return null;
    let committed = false, settled = false;
    const entry = { clear: true, isCurrent: () => !committed && !settled && current(),
        commit() {
            if (committed || settled || lastTerrain !== provider || session !== railSessionToken
                || renderedRailSurfaceRevision !== previous.revision) return false;
            committed = true;
            renderedRailSurfaceRevision = model.revision;
            renderedRailTerrainCutoutRevision = terrainRevision;
            renderedRailTerrainCutoutPublishedSignature = terrainSignature;
            viaductTerrainCutoutCache = viaductCache;
            viaductTerrainCutoutRevision = viaductCache.revision;
            viaductTerrainCutoutPublishedSignature = viaductCache.signature;
            provider?.setRenderedRailSurface?.(model);
            return true;
        },
        rollback() {
            if (!committed || settled) return;
            renderedRailSurfaceRevision = previous.revision;
            renderedRailTerrainCutoutRevision = previous.terrainRevision;
            renderedRailTerrainCutoutPublishedSignature = previous.terrainSignature;
            viaductTerrainCutoutRevision = previous.viaductRevision;
            viaductTerrainCutoutPublishedSignature = previous.viaductSignature;
            viaductTerrainCutoutCache = previous.viaductCache;
            provider?.setRenderedRailSurface?.(previous.model);
            committed = false;
        },
        discard() { if (!committed) settled = true; },
    };
    return { entry, read: model, discard: entry.discard,
        finalize() { if (!committed || settled) return false; settled = true; return true; } };
}

function railCellPublicationKey(cellKey) {
    return `rail-cell:${cellKey}`;
}

function railCellStateSnapshot(cellKey) {
    return {
        group: railCellGroupsState.get(cellKey) || null,
        regions: railCellSurfaceRegionsState.has(cellKey)
            ? railCellSurfaceRegionsState.get(cellKey)
            : null,
        hasRegions: railCellSurfaceRegionsState.has(cellKey),
        signature: railCellSignaturesState.has(cellKey)
            ? railCellSignaturesState.get(cellKey)
            : null,
        hasSignature: railCellSignaturesState.has(cellKey),
    };
}

function restoreRailCellState(cellKey, snapshot) {
    if (snapshot.group) railCellGroupsState.set(cellKey, snapshot.group);
    else railCellGroupsState.delete(cellKey);
    if (snapshot.hasRegions) railCellSurfaceRegionsState.set(cellKey, snapshot.regions);
    else railCellSurfaceRegionsState.delete(cellKey);
    if (snapshot.hasSignature) railCellSignaturesState.set(cellKey, snapshot.signature);
    else railCellSignaturesState.delete(cellKey);
}

function renderedRailCellSurfaceRegions(cell, junctionSegments = lastCellRenderedSegments) {
    if (!cell) return [];
    return buildRenderedRailSurfaceRegions(cell.segments, {
        surfaceOffsetM: TRACKBED_Y,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        // A junction fan is owned by the node's cell and contains the complete
        // incident set, including arms whose strips belong to neighbouring
        // cells. Build ownership from that same global solved generation but
        // only for the nodes this now-visible group actually published.
        junctionSegments,
        junctionNodeKeys: cell.junctionIncidents?.keys?.() || [],
    });
}

// Walk mode asks this tiny analytic index instead of raycasting the complete
// merged rail mesh. Every rendered trackbed is firm; the walk reach gate keeps
// an overhead viaduct from becoming support for somebody passing underneath.
export function tramTrackbedSupportYAtLocal(x, z, options) {
    return railTrackbedSupportIndex.supportYAtLocal(x, z, options);
}

export const railTrackbedSupportYAtLocal = tramTrackbedSupportYAtLocal;

// Coalesce road/rail input changes, but acknowledge them only after the
// corresponding private flags and geometry publish. A stale attempt leaves
// both the previous boundary and this obligation intact.
function railBoundaryInputs() {
    return { rail: lastRailFormation, railRevision: lastRailFormation?.revision,
        railMutation: lastRailFormation?.civilGroundMutationRevision || 0,
        road: lastRoadFormation, roadRevision: lastRoadFormation?.revision,
        alignment: lastRoadVerticalAlignments, alignmentRevision: lastRoadVerticalAlignments?.revision };
}

function sameRailBoundaryInputs(a, b) {
    return !!a && !!b && Object.keys(a).every(key => a[key] === b[key]);
}

function scheduleRailBoundaryRefresh(centerX, centerZ) {
    if (pendingCrossingFormationRefresh || !lastRailFormation || !lastRoadFormation) return false;
    const inputs = railBoundaryInputs(), now = railStreamNowMs();
    if (sameRailBoundaryInputs(inputs, publishedRailBoundaryInputs)) return false;
    if (!sameRailBoundaryInputs(inputs, pendingRailBoundaryInputs)) {
        pendingRailBoundaryInputs = inputs; pendingRailBoundarySinceMs = now; return false;
    }
    if (now - pendingRailBoundarySinceMs < LEVEL_CROSSING_ROAD_SETTLE_MS
        || (lastRailsHeadingDeg != null && now - lastRailsHeadingChangeMs < LEVEL_CROSSING_TURN_IDLE_MS)) return false;
    return rebuildCrossingSuppressedFormationMeshes(centerX, centerZ);
}

function prepareRailBoundaryAcknowledgement(refresh) {
    const oldInputs = publishedRailBoundaryInputs, oldCrossings = levelCrossingAccum;
    const oldRevision = levelCrossingAccumRevision, oldOpenings = roadUnderRailOpeningAccum;
    let committed = false;
    return { clear: true, isCurrent: () => refresh.ground.isCurrent()
            && oldInputs === publishedRailBoundaryInputs && oldCrossings === levelCrossingAccum
            && oldRevision === levelCrossingAccumRevision && oldOpenings === roadUnderRailOpeningAccum,
        commit() {
            committed = true;
            levelCrossingAccum = refresh.crossings;
            levelCrossingAccumRevision = refresh.crossingRevision;
            roadUnderRailOpeningAccum = refresh.openings;
            publishedRailBoundaryInputs = { ...refresh.inputs,
                rail: refresh.formationPublication?.model || refresh.inputs.rail,
                railRevision: refresh.formationPublication?.model?.revision ?? refresh.inputs.railRevision,
                railMutation: refresh.formationPublication?.model?.civilGroundMutationRevision ?? refresh.inputs.railMutation };
            return true;
        }, rollback() {
            if (!committed) return;
            levelCrossingAccum = oldCrossings; levelCrossingAccumRevision = oldRevision;
            roadUnderRailOpeningAccum = oldOpenings; publishedRailBoundaryInputs = oldInputs; committed = false;
        }, discard() {},
    };
}

function* prepareRailBoundaryGroundSteps(refresh) {
    const ground = yield* captureRailVisualGroundSteps(refresh, 'rail-boundary-inputs');
    if (!ground) return null;
    let model = null, read = null, handedOff = false;
    const current = () => pendingCrossingFormationRefresh === refresh && refresh.parent === group
        && sameRailBoundaryInputs(refresh.inputs, railBoundaryInputs()) && ground.isCurrent();
    try {
        if (!current()) return null;
        const copy = refresh.inputs.rail.forkCompiledGenerationSteps();
        try {
            while (current()) {
                const next = copy.next();
                if (next.done) { model = next.value; break; }
                yield next.value;
            }
        } finally { copy.return(); }
        if (!model || !current()) return null;
        refresh.crossings = new Map(); refresh.openings = new Map();
        refresh.crossingRevision = levelCrossingAccumRevision;
        let started = performance.now();
        for (const [key, value] of levelCrossingAccum) {
            refresh.crossings.set(key, value);
            if (performance.now() - started >= .5) { yield { phase: 'rail-boundary-crossing-copy' }; started = performance.now(); if (!current()) return null; }
        }
        for (const [key, value] of roadUnderRailOpeningAccum) {
            refresh.openings.set(key, value);
            if (performance.now() - started >= .5) { yield { phase: 'rail-boundary-opening-copy' }; started = performance.now(); if (!current()) return null; }
        }
        const previous = publishedRailBoundaryInputs;
        const changes = previous?.rail === refresh.inputs.rail && typeof refresh.inputs.road?.getChangesSince === 'function'
            ? refresh.inputs.road.getChangesSince(previous.roadRevision) : { full: true, bounds: [] };
        const crossings = yield* detectAtGradeLevelCrossingsSteps(model, ground.roadFormation,
            { ...(changes.full ? {} : { changedBounds: changes.bounds }), isCurrent: current });
        if (!crossings || !current()) return null;
        for (const frame of crossings) {
            const key = `${Math.round(frame.x)},${Math.round(frame.z)}`;
            if (!refresh.crossings.has(key)) { refresh.crossings.set(key, frame); refresh.crossingRevision++; }
            if (performance.now() - started >= .5) { yield { phase: 'rail-boundary-crossings' }; started = performance.now(); if (!current()) return null; }
        }
        for (const alignment of ground.verticalAlignments?.getAlignments?.() || []) {
            for (const opening of roadUnderRailFormationOpenings([alignment])) refresh.openings.set(opening.key, opening);
            yield { phase: 'rail-boundary-openings' }; if (!current()) return null;
        }
        const retained = yield* flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps(model, ground.roadFormation, { isCurrent: current });
        if (retained === null || !current()) return null;
        const openings = yield* flagRailFormationBoundarySegmentsForRoadOpeningsSteps(model, [...refresh.openings.values()], { isCurrent: current });
        if (openings === null || !current()) return null;
        const level = yield* flagRetainingWallsForCrossingsSteps(model, [...refresh.crossings.values()], current);
        if (level === null || !current()) return null;
        refresh.noGeometryChange = retained + openings + level === 0;
        if (refresh.noGeometryChange) {
            model.dispose(); model = null; handedOff = true; return ground;
        }
        model.revision = ++railFormationRevision;
        const civil = yield* railCivilGroundDependencySnapshotSteps(model, RAIL_CIVIL_GROUND_SNAPSHOT_PADDING_M);
        if (!current()) return null;
        refresh.formationPublication = prepareRailFormationPublication(model, lastFeatures,
            { civilGroundSnapshot: civil, revisionPrepared: true, recordBuildTimings: false, owner: refresh });
        read = yield* model.captureReadSnapshotSteps({ baseSceneYAtLocal: model.baseSceneYAtLocal });
        if (!current()) return null;
        handedOff = true;
        return ownReadSnapshot({ ...ground, railFormation: read,
            isCurrent: () => current() && refresh.formationPublication.entry.isCurrent() }, [ground, read]);
    } finally {
        if (!handedOff) { read?.release(); ground.release(); refresh.formationPublication?.discard(); model?.dispose(); }
    }
}

// Road centreline tiles arrive after the first rail mesh is normally visible.
// Once that burst settles, rebuild only when a bridge-tagged tram's resolved
// deck ownership actually changed. The road model's broad revision also moves
// for unrelated tiles; treating it as direct rail invalidation produced a
// 180-400 ms full-network rebuild while travelling through every new road tile.
function refreshRoadCarriedTramGeometry() {
    if (!lastRoadVerticalAlignments
        || !(lastFeatures || []).some(isPotentialRoadCarriedTramFeature)) {
        return false;
    }
    const revision = lastRoadVerticalAlignments.revision;
    if (revision === lastRoadCarriedTramRevision) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (revision !== pendingRoadCarriedTramRevision) {
        pendingRoadCarriedTramRevision = revision;
        pendingRoadCarriedTramSinceMs = now;
        return false;
    }
    if (now - pendingRoadCarriedTramSinceMs < LEVEL_CROSSING_ROAD_SETTLE_MS) {
        return false;
    }
    if (lastRailsHeadingDeg != null
        && now - lastRailsHeadingChangeMs < LEVEL_CROSSING_TURN_IDLE_MS) {
        return false;
    }
    lastRoadCarriedTramRevision = revision;
    const nextSignature = roadCarriedTramDeckSignature(
        lastRoadVerticalAlignments,
        lastSampledTrackbedSegments,
    );
    if (nextSignature === lastRoadCarriedTramDeckSignature) return false;
    lastRoadCarriedTramDeckSignature = nextSignature;
    return true;
}

function refreshEmbeddedTramRoadGeometry() {
    if (!lastRoadFormation) return false;
    const revision = lastRoadFormation.revision;
    if (revision === lastEmbeddedTramRoadRevision) return false;
    const previousRevision = lastEmbeddedTramRoadRevision;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (revision !== pendingEmbeddedTramRoadRevision) {
        pendingEmbeddedTramRoadRevision = revision;
        pendingEmbeddedTramRoadSinceMs = now;
        return false;
    }
    if (now - pendingEmbeddedTramRoadSinceMs < LEVEL_CROSSING_ROAD_SETTLE_MS) {
        return false;
    }
    if (lastRailsHeadingDeg != null
        && now - lastRailsHeadingChangeMs < LEVEL_CROSSING_TURN_IDLE_MS) {
        return false;
    }
    const roadChanges = typeof lastRoadFormation.getChangesSince === 'function'
        ? lastRoadFormation.getChangesSince(previousRevision)
        : { full: true, bounds: [] };
    lastEmbeddedTramRoadRevision = revision;
    const nextPillarSignature = railPillarRoadSurfaceSignature(
        lastRailFormation,
        lastRoadFormation,
    );
    const pillarsChanged = nextPillarSignature !== lastRailPillarRoadSignature;
    lastRailPillarRoadSignature = nextPillarSignature;
    if (pillarsChanged) return 'structures';
    const embeddedSegments = lastSampledTrackbedSegments
        .filter(isOrdinaryOsmTramFeature);
    if (embeddedSegments.length === 0) return false;
    if (!roadChanges.full && !boundsIntersectAnyRailSegment(
        embeddedSegments,
        roadChanges.bounds,
        EMBEDDED_TRAM_MAX_LATERAL_M,
    )) return false;
    return {
        kind: 'embedded',
        changedBounds: roadChanges.full ? null : roadChanges.bounds,
    };
}

function railPillarRoadSurfaceSignature(railFormation, roadFormation) {
    if (!railFormation?.getViaductRuns || !roadFormation?.surfaceAtLocal) return '';
    const entries = [];
    for (const run of railFormation.getViaductRuns() || []) {
        const firstStation = run.startStation + Math.min(
            VIADUCT_PIER_SPACING_M * 0.5,
            run.lengthM * 0.5,
        );
        for (let station = firstStation;
            station < run.endStation - 0.5;
            station += VIADUCT_PIER_SPACING_M) {
            const candidateOffsets = [0];
            for (let offset = VIADUCT_PIER_SLIDE_STEP_M;
                offset <= VIADUCT_PIER_SLIDE_MAX_M;
                offset += VIADUCT_PIER_SLIDE_STEP_M) {
                candidateOffsets.push(offset, -offset);
            }
            const occupancy = [];
            for (const offset of candidateOffsets) {
                const candidateStation = station + offset;
                if (candidateStation <= run.startStation + 0.5
                    || candidateStation >= run.endStation - 0.5) continue;
                const sample = sampleViaductRunAtStation(run, candidateStation);
                const surface = sample
                    ? roadFormation.surfaceAtLocal(sample.x, sample.z)
                    : null;
                occupancy.push(surface?.osmId == null ? '-' : String(surface.osmId));
            }
            entries.push(`${station.toFixed(1)}:${occupancy.join(',')}`);
        }
    }
    return entries.join('|');
}

function* addRailDressingMeshChunksSteps(target, {
    positions,
    uvs = null,
    uvScale = 1,
    wallUvs = false,
    material,
    name,
    renderOrder,
}) {
    const ranges = trianglePositionChunkRanges(positions?.length, {
        maxVertices: RAIL_DRESSING_CHUNK_MAX_VERTICES,
    });
    const meshes = [];
    try {
        for (let chunkIndex = 0; chunkIndex < ranges.length; chunkIndex++) {
            yield { phase: 'mesh-chunk', chunkIndex };
            const range = ranges[chunkIndex];
            const chunkPositions = new Float32Array(range.positionEnd - range.positionStart);
            for (let index = range.positionStart; index < range.positionEnd; index++) {
                if ((index - range.positionStart) % 2048 === 0) yield { phase: 'mesh-positions' };
                chunkPositions[index - range.positionStart] = positions[index];
            }
            let chunkUvs;
            if (wallUvs) {
                yield { phase: 'mesh-wall-uvs' };
                chunkUvs = buildWallFaceUvsForPositions(chunkPositions);
            } else {
                chunkUvs = new Float32Array(range.uvEnd - range.uvStart);
                for (let index = range.uvStart; index < range.uvEnd; index++) {
                    if ((index - range.uvStart) % 2048 === 0) yield { phase: 'mesh-uvs' };
                    chunkUvs[index - range.uvStart] = uvs[index] * uvScale;
                }
            }
            yield { phase: 'mesh-normals-bounds' };
            const geometry = new THREE.BufferGeometry();
            let attached = false;
            try {
                geometry.setAttribute('position', new THREE.BufferAttribute(chunkPositions, 3));
                geometry.setAttribute('uv', new THREE.BufferAttribute(chunkUvs, 2));
                geometry.computeVertexNormals();
                geometry.computeBoundingSphere();
                const mesh = new THREE.Mesh(geometry, material);
                mesh.name = chunkIndex === 0 ? name : `${name}:${chunkIndex + 1}`;
                mesh.receiveShadow = true;
                mesh.renderOrder = renderOrder;
                mesh.frustumCulled = false;
                target.add(mesh);
                meshes.push(mesh);
                attached = true;
            } finally {
                if (!attached) geometry.dispose();
            }
        }
        return meshes;
    } finally {
        // Before the first mesh exists, the suspended builder is the only
        // material owner. Attached meshes belong to the caller's detached root
        // and are retired together, including cancellation after a partial build.
        if (meshes.length === 0) material.dispose();
    }
}

function* addRailFormationRetainingWallsSteps(
    target,
    railFormation,
    centerX,
    centerZ,
    maxRadiusM,
) {
    const profiles = railFormation?.getSurfaceProfiles?.() || [];
    if (profiles.length === 0) return;
    const positions = [];
    const wallRadiusM = maxRadiusM + RAIL_WALL_WINDOW_PADDING_M;
    for (const profile of profiles) {
        yield { phase: 'dressing-profile' };
        const bounds = profile.terrainCutoutBounds
            || profile.outerBounds
            || profile.bounds;
        if (bounds && !boundsIntersectRenderWindow(bounds, centerX, centerZ, wallRadiusM)) continue;
        const visiblePositions = yield* filterTrianglePositionsByRenderWindowSteps(
            yield* buildRetainingWallPositionsSteps(profile, TRACKBED_Y),
            centerX,
            centerZ,
            wallRadiusM,
        );
        for (let index = 0; index < visiblePositions.length; index++) {
            if (index % 2048 === 0) yield { phase: 'wall-positions' };
            positions.push(visiblePositions[index]);
        }
    }
    if (positions.length === 0) return;
    // Board-formed concrete — a flat, coursed face, deliberately a different
    // material family from the tunnel's coursed stone so cut and bore read apart.
    yield { phase: 'wall-material' };
    const concrete = getCutConcreteSurface();
    const material = new THREE.MeshStandardMaterial({
        map: concrete.map,
        bumpMap: concrete.bumpMap,
        bumpScale: 0.4,
        color: 0xe8e6e0,
        roughness: 0.96,
        metalness: 0,
        side: THREE.DoubleSide,
    });
    const meshes = yield* addRailDressingMeshChunksSteps(target, {
        positions,
        wallUvs: true,
        material,
        name: 'RailFormationRetainingWalls',
        renderOrder: SURFACE_RENDER_ORDER.RAIL_STRUCTURE,
    });
    // Cut walls are solid for the walker: one yaw box per ring segment where
    // the wall stands over a metre tall. Fill-side walls (top at bed level)
    // stay non-blocking automatically — walk-collision skips anything the
    // walker could step onto.
    const wallBoxes = [];
    for (const profile of profiles) {
        yield { phase: 'dressing-profile' };
        const points = profile.points || [];
        for (let index = 0; index < points.length; index++) {
            yield { phase: 'wall-collider-segment' };
            if (profile.internalSegments && profile.internalSegments[index]) continue;
            const a = points[index];
            const b = points[(index + 1) % points.length];
            for (const [visibleA, visibleB] of yield* visibleFormationBoundaryPiecesSteps(
                profile,
                index,
                a,
                b,
            )) {
                yield { phase: 'wall-collider-piece' };
                const topY = Math.max(visibleA.terrainY, visibleB.terrainY);
                const bedY = Math.min(visibleA.roadY, visibleB.roadY) + TRACKBED_Y;
                if (topY - bedY < 1) continue;   // shallow: climbable, not a wall
                const dx = visibleB.innerX - visibleA.innerX;
                const dz = visibleB.innerZ - visibleA.innerZ;
                const length = Math.hypot(dx, dz);
                if (length < 0.05) continue;
                const tangentX = dx / length;
                const tangentZ = dz / length;
                // Ordinary neighbouring wall boxes overlap by 20 cm so no
                // collision seam opens between samples. A clipped endpoint is
                // an intentional portal edge, however: stop exactly there or
                // the invisible overlap narrows the usable staircase again.
                const startPadM = Number.isFinite(visibleA._boundaryT)
                    && visibleA._boundaryT > 1e-9 ? 0 : 0.2;
                const endPadM = Number.isFinite(visibleB._boundaryT)
                    && visibleB._boundaryT < 1 - 1e-9 ? 0 : 0.2;
                const startX = visibleA.innerX - tangentX * startPadM;
                const startZ = visibleA.innerZ - tangentZ * startPadM;
                const endX = visibleB.innerX + tangentX * endPadM;
                const endZ = visibleB.innerZ + tangentZ * endPadM;
                wallBoxes.push({
                    cx: (startX + endX) * 0.5,
                    cz: (startZ + endZ) * 0.5,
                    hx: (length + startPadM + endPadM) * 0.5,
                    hz: 0.25,
                    sin: -tangentZ,
                    cos: tangentX,
                    minY: bedY - 0.5,
                    maxY: topY,
                });
            }
        }
    }
    if (wallBoxes.length > 0 && meshes[0]) {
        meshes[0].userData.walkColliderBoxes = wallBoxes;
    }
}

function* addRailFormationTerrainCollarsSteps(
    target,
    railFormation,
    centerX,
    centerZ,
    maxRadiusM,
) {
    const profiles = railFormation?.getSurfaceProfiles?.() || [];
    if (profiles.length === 0) return;
    const positionChunks = [];
    const uvChunks = [];
    let positionCount = 0;
    let uvCount = 0;
    const collarRadiusM = maxRadiusM + RAIL_WALL_WINDOW_PADDING_M;
    for (const profile of profiles) {
        yield { phase: 'dressing-profile' };
        const bounds = profile.overlapBounds || profile.outerBounds || profile.bounds;
        if (bounds && !boundsIntersectRenderWindow(
            bounds,
            centerX,
            centerZ,
            collarRadiusM,
        )) continue;
        // The level drainage/cess apron and the terrain seam use the same
        // regional ground material and ownership lifetime. Batch them into one
        // mesh: the missing apron no longer reveals the terrain-mask underlay,
        // and sealing it adds no draw call or material.
        for (const builder of [buildFormationSurfaceApronGeometryDataSteps, buildFormationTerrainCollarGeometryDataSteps]) {
            const geometryData = yield* builder(profile, TRACKBED_Y);
            const visible = yield* filterTriangleGeometryByRenderWindowSteps(
                geometryData,
                centerX,
                centerZ,
                collarRadiusM,
            );
            if (visible.positions.length === 0) continue;
            positionChunks.push(visible.positions);
            uvChunks.push(visible.uvs);
            positionCount += visible.positions.length;
            uvCount += visible.uvs.length;
        }
    }
    if (positionCount === 0) return;
    const surface = getActiveTerrainSurface();
    // A nationwide streamed rail revision can put hundreds of thousands of
    // values in one visible collar build. Passing that array through spread
    // syntax turns every value into a function argument and exceeds the JS
    // call-stack/argument limit. Copy chunks directly into fixed typed arrays.
    const positions = new Float32Array(positionCount);
    const uvs = new Float32Array(uvCount);
    let positionOffset = 0;
    let uvOffset = 0;
    for (let chunkIndex = 0; chunkIndex < positionChunks.length; chunkIndex++) {
        const positionChunk = positionChunks[chunkIndex];
        for (let index = 0; index < positionChunk.length; index++) {
            if (index % 2048 === 0) yield { phase: 'collar-positions' };
            positions[positionOffset + index] = positionChunk[index];
        }
        positionOffset += positionChunk.length;
        const uvChunk = uvChunks[chunkIndex];
        for (let index = 0; index < uvChunk.length; index++) {
            if (index % 2048 === 0) yield { phase: 'collar-uvs' };
            uvs[uvOffset + index] = uvChunk[index];
        }
        uvOffset += uvChunk.length;
    }
    const material = new THREE.MeshStandardMaterial({
        map: surface.map,
        bumpMap: surface.bumpMap,
        bumpScale: surface.bumpScale,
        roughness: 0.96,
        metalness: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
    });
    applySurfaceStencil(material, RAIL_EARTHWORK_CLAIM);
    applyGroundOwnership(material, RAIL_EARTHWORK_CLAIM);
    applyPlannerSurfaceCutout(material, RAIL_EARTHWORK_CLAIM);
    applyUrbanGroundSurface(material, RAIL_EARTHWORK_CLAIM, {
        urbanGround: false,
    });
    // The builder's UVs are metres (flat spans = world XZ, steep spans = their
    // true arc/section metres); each bounded upload chunk applies the active
    // terrain texture density without changing that shared phase.
    yield* addRailDressingMeshChunksSteps(target, {
        positions,
        uvs,
        uvScale: surface.uvPerM,
        material,
        name: 'RailFormationTerrainCollar',
        renderOrder: SURFACE_RENDER_ORDER.RAIL_EARTHWORK,
    });
}

function segmentWithinRenderWindow(a, b, centerX, centerZ, radiusM) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared > 1e-9
        ? Math.max(0, Math.min(1,
            ((centerX - a.x) * dx + (centerZ - a.z) * dz) / lengthSquared,
        ))
        : 0;
    const nearestX = a.x + dx * t;
    const nearestZ = a.z + dz * t;
    return (nearestX - centerX) ** 2 + (nearestZ - centerZ) ** 2 <= radiusM ** 2;
}

function visibleViaductSampleSlices(run, centerX, centerZ, radiusM) {
    const slices = [];
    let active = null;
    const samples = run?.samples || [];
    for (let index = 0; index < samples.length - 1; index++) {
        const a = samples[index];
        const b = samples[index + 1];
        if (segmentWithinRenderWindow(a, b, centerX, centerZ, radiusM)) {
            if (!active) active = [a];
            active.push(b);
        } else if (active) {
            slices.push(active);
            active = null;
        }
    }
    if (active) slices.push(active);
    return slices;
}

const COVERED_STATION_TUNNEL_OVERLAP_M = 1.5;
const COVERED_STATION_ROUTE_SNAP_M = 8;

function pointInsideCoveredStationRoute(station, x, z) {
    const ownership = station?.coveredRoute;
    const route = ownership?.route;
    if (!route?.points?.length || !route?.chainagesM?.length) return false;
    const startM = ownership.startM + COVERED_STATION_TUNNEL_OVERLAP_M;
    const endM = ownership.endM - COVERED_STATION_TUNNEL_OVERLAP_M;
    if (!(endM > startM)) return false;

    let nearestDistanceSq = Infinity;
    let nearestChainageM = null;
    for (let index = 0; index < route.points.length - 1; index++) {
        const from = route.points[index];
        const to = route.points[index + 1];
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq <= 1e-9) continue;
        const t = Math.max(0, Math.min(
            1,
            ((x - from.x) * dx + (z - from.z) * dz) / lengthSq,
        ));
        const projectedX = from.x + dx * t;
        const projectedZ = from.z + dz * t;
        const distanceSq = (x - projectedX) ** 2 + (z - projectedZ) ** 2;
        if (distanceSq >= nearestDistanceSq) continue;
        nearestDistanceSq = distanceSq;
        nearestChainageM = route.chainagesM[index]
            + (route.chainagesM[index + 1] - route.chainagesM[index]) * t;
    }
    return nearestDistanceSq <= COVERED_STATION_ROUTE_SNAP_M ** 2
        && nearestChainageM > startM
        && nearestChainageM < endM;
}

function tunnelSampleSlicesOutsideStations(
    run,
    samples,
    stationFlares,
    centerX,
    centerZ,
    radiusM,
) {
    const properties = run?.alignment?.feature?.properties || {};
    const ownedStations = (stationFlares || []).filter(station => (
        stationTrackRouteMatches(properties, station.trackId)
    ));
    if (ownedStations.length === 0) {
        return visibleViaductSampleSlices({ samples }, centerX, centerZ, radiusM);
    }

    // The station supplies its own hall and tapered throats over this complete
    // envelope. Ordinary bored-tunnel walls must stop before it; otherwise the
    // narrow running bore continues through the widened island cross-section
    // and covers both flared tracks.
    // Let the running tube overlap the rigid throat instead of stopping one
    // sample (formerly four metres) before it. The portal adapter at the exact
    // throat end then owns the bore-width transition with no open longitudinal
    // span. Covered-route stations use their exact chainage range below.
    const rigidExclusionM = STATION_FLARE_ENVELOPE_M
        - COVERED_STATION_TUNNEL_OVERLAP_M;
    const slices = [];
    let active = null;
    for (let index = 0; index < samples.length - 1; index++) {
        const a = samples[index];
        const b = samples[index + 1];
        const midpointX = (a.x + b.x) * 0.5;
        const midpointZ = (a.z + b.z) * 0.5;
        const insideStation = ownedStations.some(station => (
            station.coveredRoute
                ? pointInsideCoveredStationRoute(station, midpointX, midpointZ)
                : Math.hypot(midpointX - station.x, midpointZ - station.z)
                    <= rigidExclusionM
        ));
        const visible = !insideStation
            && segmentWithinRenderWindow(a, b, centerX, centerZ, radiusM);
        if (visible) {
            if (!active) active = [a];
            active.push(b);
        } else if (active) {
            slices.push(active);
            active = null;
        }
    }
    if (active) slices.push(active);
    return slices;
}

// The deck surface sits at the trackbed datum; the walkways are the strips of
// this same slab left exposed beside the trackbed.
const VIADUCT_DECK_TOP_OFFSET_M = TRACKBED_Y - VIADUCT_DECK_TOP_BELOW_TRACKBED_M;

function viaductGeometryFromSlab(slab) {
    if (!slab) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(slab.positions, 3));
    geometry.setIndex(slab.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

function pushBridgeBoxMatrix(matrices, dummy, {
    x,
    y,
    z,
    angle,
    width,
    height,
    depth,
}) {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, angle, 0);
    dummy.scale.set(width, height, depth);
    dummy.updateMatrix();
    matrices.push(dummy.matrix.clone());
}

function appendSteelBridgeDetailMatrices(
    samples,
    halfWidthM,
    boxMatrices,
    boltMatrices,
    dummy,
) {
    for (let index = 0; index + 1 < samples.length; index++) {
        const a = samples[index];
        const b = samples[index + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lengthM = Math.hypot(dx, dz);
        if (!(lengthM > 1e-6)) continue;
        const normalX = dz / lengthM;
        const normalZ = -dx / lengthM;
        const angle = Math.atan2(dx, dz);
        const x = (a.x + b.x) * 0.5;
        const z = (a.z + b.z) * 0.5;
        const topY = (a.railY + b.railY) * 0.5 + TRACKBED_Y - 0.015;
        const bottomY = topY - VIADUCT_DECK_THICKNESS_M;
        for (const side of [-1, 1]) {
            const sideX = x + normalX * side * (halfWidthM + 0.08);
            const sideZ = z + normalZ * side * (halfWidthM + 0.08);
            for (const y of [
                topY - STEEL_BRIDGE_FLANGE_HEIGHT_M * 0.5,
                bottomY + STEEL_BRIDGE_FLANGE_HEIGHT_M * 0.5,
            ]) {
                pushBridgeBoxMatrix(boxMatrices, dummy, {
                    x: sideX,
                    y,
                    z: sideZ,
                    angle,
                    width: STEEL_BRIDGE_FLANGE_WIDTH_M,
                    height: STEEL_BRIDGE_FLANGE_HEIGHT_M,
                    depth: lengthM + 0.08,
                });
            }
        }
    }

    const up = new THREE.Vector3(0, 1, 0);
    const outward = new THREE.Vector3();
    for (const placement of planSteelBridgeDetailStations(samples, {
        spacingM: STEEL_BRIDGE_DETAIL_SPACING_M,
    })) {
        const topY = placement.railY + TRACKBED_Y - 0.015;
        const bottomY = topY - VIADUCT_DECK_THICKNESS_M;
        for (const side of [-1, 1]) {
            const normalX = placement.normalX * side;
            const normalZ = placement.normalZ * side;
            pushBridgeBoxMatrix(boxMatrices, dummy, {
                x: placement.x + normalX * (halfWidthM + 0.075),
                y: (topY + bottomY) * 0.5,
                z: placement.z + normalZ * (halfWidthM + 0.075),
                angle: placement.angle,
                width: STEEL_BRIDGE_STIFFENER_DEPTH_M,
                height: VIADUCT_DECK_THICKNESS_M - 0.08,
                depth: STEEL_BRIDGE_STIFFENER_WIDTH_M,
            });
            outward.set(normalX, 0, normalZ).normalize();
            for (const y of [topY - 0.2, bottomY + 0.2]) {
                dummy.position.set(
                    placement.x + normalX * (halfWidthM + 0.18),
                    y,
                    placement.z + normalZ * (halfWidthM + 0.18),
                );
                dummy.quaternion.setFromUnitVectors(up, outward);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                boltMatrices.push(dummy.matrix.clone());
            }
        }
    }
}

function buildViaductDeckGeometry(samples, halfWidthM) {
    return viaductGeometryFromSlab(viaductSlabMesh(samples, {
        halfWidthM,
        topOffsetM: VIADUCT_DECK_TOP_OFFSET_M,
        bottomOffsetM: VIADUCT_DECK_TOP_OFFSET_M - VIADUCT_DECK_THICKNESS_M,
    }));
}

function sampleViaductRunAtStation(run, stationM) {
    const samples = run?.samples || [];
    if (samples.length < 2) return null;
    const station = Number(stationM);
    let low = 0;
    let high = samples.length - 2;
    while (low <= high) {
        const index = Math.floor((low + high) * 0.5);
        const a = samples[index];
        const b = samples[index + 1];
        if (station < a.station - 1e-6) {
            high = index - 1;
            continue;
        }
        if (station > b.station + 1e-6) {
            low = index + 1;
            continue;
        }
        const span = Math.max(1e-6, b.station - a.station);
        const t = Math.max(0, Math.min(1, (station - a.station) / span));
        return {
            station,
            x: a.x + (b.x - a.x) * t,
            z: a.z + (b.z - a.z) * t,
            railY: a.railY + (b.railY - a.railY) * t,
            angle: Math.atan2(b.x - a.x, b.z - a.z),
        };
    }
    return null;
}

function resolveViaductPiers(run, stationM, clearance) {
    const clearanceAt = candidate => clearance(candidate.x, candidate.z, {
        ignoreTrackFeature: run?.alignment?.feature || null,
    });
    return resolveViaductSupportCandidates({
        nominalStation: stationM,
        startStation: run.startStation,
        endStation: run.endStation,
        sampleAt: station => sampleViaductRunAtStation(run, station),
        clearanceAt,
        stepM: VIADUCT_PIER_SLIDE_STEP_M,
        maxOffsetM: VIADUCT_PIER_SLIDE_MAX_M,
    });
}

function addViaductPierInstances(target, shaftMatrices, capMatrices, material) {
    const add = (name, matrices) => {
        if (matrices.length === 0) return;
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
        mesh.name = name;
        for (let index = 0; index < matrices.length; index++) mesh.setMatrixAt(index, matrices[index]);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        target.add(mesh);
    };
    add('ProposalRailViaductPiers', shaftMatrices);
    add('ProposalRailViaductPierCaps', capMatrices);
}

function addSteelBridgeDetailInstances(target, boxMatrices, boltMatrices, style) {
    if (style.kind !== 'steel-girder') return;
    const add = (name, geometry, material, matrices) => {
        if (matrices.length === 0) {
            geometry.dispose();
            material.dispose();
            return;
        }
        const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
        mesh.name = name;
        for (let index = 0; index < matrices.length; index++) {
            mesh.setMatrixAt(index, matrices[index]);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        target.add(mesh);
    };
    add(
        'ProposalRailSteelGirderDetails',
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ ...style.details, flatShading: true }),
        boxMatrices,
    );
    add(
        'ProposalRailSteelGirderFasteners',
        new THREE.CylinderGeometry(
            STEEL_BRIDGE_BOLT_RADIUS_M,
            STEEL_BRIDGE_BOLT_RADIUS_M,
            STEEL_BRIDGE_BOLT_DEPTH_M,
            8,
        ),
        new THREE.MeshStandardMaterial({ ...style.fasteners, flatShading: true }),
        boltMatrices,
    );
}

function addRailViaducts(target, railFormation, terrain, centerX, centerZ, maxRadiusM, roadFormation = lastRoadFormation, mappedWater = null) {
    const runs = railFormation?.getViaductRuns?.() || [];
    if (runs.length === 0) return;
    const style = railBridgeStyleForLocation({
        locationId: lastBridgeStyleLocationId,
        styleCityId: lastBridgeStyleCityId,
    });
    const deckMaterial = new THREE.MeshStandardMaterial({
        ...style.deck,
        side: THREE.DoubleSide,
        flatShading: true,
    });
    const pierMaterial = new THREE.MeshStandardMaterial({
        ...style.piers,
        side: THREE.DoubleSide,
    });
    let deckCount = 0;
    const shaftMatrices = [];
    const capMatrices = [];
    const steelBoxMatrices = [];
    const steelBoltMatrices = [];
    const picketMatrices = [];
    const parapetSlabs = [];
    const dummy = new THREE.Object3D();
    const clearance = (x, z, options) => railViaductPillarClearanceAtLocal(
        lastPillarClearance, roadFormation, x, z, options,
    );
    const visibleRadiusM = maxRadiusM + RAIL_WALL_WINDOW_PADDING_M;
    for (const run of runs) {
        // The deck carries an evacuation walkway each side of the trackbed,
        // closed by the 1.6 m parapet — a trackbed-wide deck has nowhere to
        // stand when a train fails mid-span.
        const deckHalfWidthM = viaductDeckHalfWidthM(
            run.alignment.halfWidthM,
            VIADUCT_DECK_EDGE_MARGIN_M,
        );
        const parapetOffsetM = viaductParapetOffsetM(
            run.alignment.halfWidthM,
            VIADUCT_DECK_EDGE_MARGIN_M,
        );
        const visibleSlices = visibleViaductSampleSlices(run, centerX, centerZ, visibleRadiusM);
        const placedPierStations = new Set();
        for (const samples of visibleSlices) {
            const extendedSamples = extendViaductDeckSamples(samples, run);
            const geometry = buildViaductDeckGeometry(
                extendedSamples,
                deckHalfWidthM,
            );
            if (!geometry) continue;
            const mesh = new THREE.Mesh(geometry, deckMaterial);
            mesh.name = 'ProposalRailViaductDeck';
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.renderOrder = SURFACE_RENDER_ORDER.RAIL_STRUCTURE;
            target.add(mesh);
            deckCount += 1;
            if (style.kind === 'steel-girder') {
                appendSteelBridgeDetailMatrices(
                    extendedSamples,
                    deckHalfWidthM,
                    steelBoxMatrices,
                    steelBoltMatrices,
                    dummy,
                );
            }
            for (const side of [-1, 1]) {
                for (const picket of viaductParapetPickets(samples, {
                    offsetM: parapetOffsetM * side,
                    baseOffsetM: VIADUCT_DECK_TOP_OFFSET_M,
                })) {
                    dummy.position.set(picket.x, picket.y + VIADUCT_PARAPET_HEIGHT_M * 0.5, picket.z);
                    dummy.rotation.set(0, picket.angle, 0);
                    dummy.scale.set(
                        VIADUCT_PARAPET_PICKET_SIZE_M,
                        VIADUCT_PARAPET_HEIGHT_M,
                        VIADUCT_PARAPET_PICKET_SIZE_M,
                    );
                    dummy.updateMatrix();
                    picketMatrices.push(dummy.matrix.clone());
                }
                for (const band of VIADUCT_PARAPET_RAIL_BANDS_M) {
                    const slab = viaductSlabMesh(samples, {
                        centerOffsetM: parapetOffsetM * side,
                        halfWidthM: VIADUCT_PARAPET_RAIL_HALF_WIDTH_M,
                        topOffsetM: VIADUCT_DECK_TOP_OFFSET_M + band.top,
                        bottomOffsetM: VIADUCT_DECK_TOP_OFFSET_M + band.bottom,
                    });
                    if (slab) parapetSlabs.push(slab);
                }
            }
        }
        if (!pillarClearanceReady || !terrain) continue;
        const firstRunStation = run.startStation + Math.min(
            VIADUCT_PIER_SPACING_M * 0.5,
            run.lengthM * 0.5,
        );
        for (const samples of visibleSlices) {
            const visibleStartStation = samples[0].station;
            const visibleEndStation = samples[samples.length - 1].station;
            const stepCount = Math.max(
                0,
                Math.ceil((visibleStartStation - firstRunStation) / VIADUCT_PIER_SPACING_M),
            );
            const firstVisibleStation = firstRunStation + stepCount * VIADUCT_PIER_SPACING_M;
            for (let station = firstVisibleStation;
                station <= visibleEndStation + 0.5 && station < run.endStation - 0.5;
                station += VIADUCT_PIER_SPACING_M) {
                for (const pier of resolveViaductPiers(run, station, clearance)) {
                    const stationKey = pier.station.toFixed(1);
                    if (placedPierStations.has(stationKey) || !isPointWithinRenderWindow(
                        pier.x,
                        pier.z,
                        centerX,
                        centerZ,
                        visibleRadiusM,
                    )) continue;
                    placedPierStations.add(stationKey);
                    const deckBottomY = pier.railY + TRACKBED_Y
                        - VIADUCT_DECK_TOP_BELOW_TRACKBED_M
                        - VIADUCT_DECK_THICKNESS_M;
                    const terrainY = finiteOrNull(
                        terrain.evidenceSceneYAtLocal?.(pier.x, pier.z),
                    );
                    const footingY = resolveViaductPierFootingY({
                        terrainY,
                        mappedSea: mappedWater ? mappedWater.contains(pier.x, pier.z) : isPointInMappedSea(pier.x, pier.z),
                        seaSurfaceY: mappedWater ? mappedWater.sceneY : mappedSeaSurfaceSceneY(),
                        waterEmbedDepthM: VIADUCT_PIER_WATER_EMBED_M,
                    });
                    if (footingY === null) continue;
                    const capBottomY = deckBottomY - VIADUCT_PIER_CAP_HEIGHT_M;
                    const shaftHeightM = capBottomY - footingY;
                    if (!Number.isFinite(shaftHeightM)
                        || shaftHeightM < VIADUCT_PIER_MIN_HEIGHT_M) continue;
                    dummy.position.set(pier.x, footingY + shaftHeightM * 0.5, pier.z);
                    dummy.rotation.set(0, pier.angle, 0);
                    dummy.scale.set(VIADUCT_PIER_WIDTH_M, shaftHeightM, VIADUCT_PIER_DEPTH_M);
                    dummy.updateMatrix();
                    shaftMatrices.push(dummy.matrix.clone());
                    dummy.position.set(
                        pier.x,
                        deckBottomY - VIADUCT_PIER_CAP_HEIGHT_M * 0.5,
                        pier.z,
                    );
                    dummy.scale.set(
                        VIADUCT_PIER_CAP_WIDTH_M,
                        VIADUCT_PIER_CAP_HEIGHT_M,
                        VIADUCT_PIER_CAP_DEPTH_M,
                    );
                    dummy.updateMatrix();
                    capMatrices.push(dummy.matrix.clone());
                }
            }
        }
    }
    addSteelBridgeDetailInstances(
        target,
        steelBoxMatrices,
        steelBoltMatrices,
        style,
    );
    addViaductPierInstances(target, shaftMatrices, capMatrices, pierMaterial);
    addViaductParapetMeshes(target, picketMatrices, parapetSlabs);
    if (deckCount === 0) deckMaterial.dispose();
    if (shaftMatrices.length === 0 && capMatrices.length === 0) pierMaterial.dispose();
}

// One white material, two draw calls for every parapet in the window: the
// pickets as a single instanced box, the top/mid rails of every run merged
// into one geometry. Thin members cast no shadows — thousands of instanced
// bars would bill the shadow map for something no one can see.
function addViaductParapetMeshes(target, picketMatrices, parapetSlabs) {
    if (picketMatrices.length === 0 && parapetSlabs.length === 0) return;
    const white = new THREE.MeshStandardMaterial({
        color: 0xf2f4f6,
        roughness: 0.5,
        metalness: 0.1,
    });
    if (picketMatrices.length > 0) {
        const pickets = new THREE.InstancedMesh(
            new THREE.BoxGeometry(1, 1, 1),
            white,
            picketMatrices.length,
        );
        pickets.name = 'ProposalRailViaductParapetPickets';
        for (let index = 0; index < picketMatrices.length; index++) {
            pickets.setMatrixAt(index, picketMatrices[index]);
        }
        pickets.instanceMatrix.needsUpdate = true;
        pickets.castShadow = false;
        pickets.receiveShadow = false;
        pickets.frustumCulled = false;
        target.add(pickets);
    }
    if (parapetSlabs.length > 0) {
        const positions = [];
        const indices = [];
        for (const slab of parapetSlabs) {
            const base = positions.length / 3;
            for (let index = 0; index < slab.positions.length; index++) {
                positions.push(slab.positions[index]);
            }
            for (let index = 0; index < slab.indices.length; index++) {
                indices.push(base + slab.indices[index]);
            }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const railsMesh = new THREE.Mesh(geometry, white);
        railsMesh.name = 'ProposalRailViaductParapetRails';
        railsMesh.castShadow = false;
        railsMesh.receiveShadow = false;
        target.add(railsMesh);
    }
}

// Shared, world-metre-tiled DataTexture (UVs are supplied in metres, so the
// repeat is 1/tileM). Mirrors the building-stone loader; registerShared keeps a
// single cached copy across cab rebuilds.
function makeTiledCivilTexture(data, size, tileM, colorSpace = null) {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.repeat.set(1 / tileM, 1 / tileM);
    if (colorSpace) texture.colorSpace = colorSpace;
    texture.needsUpdate = true;
    registerShared(texture);
    return texture;
}

function getTunnelStoneSurface() {
    if (_tunnelStoneSurface) return _tunnelStoneSurface;
    const raster = createDalmatianStoneRaster(256, 0x7a11e5);
    _tunnelStoneSurface = {
        map: makeTiledCivilTexture(raster.color, raster.size, TUNNEL_STONE_TILE_M, THREE.SRGBColorSpace),
        bumpMap: makeTiledCivilTexture(raster.height, raster.size, TUNNEL_STONE_TILE_M),
    };
    return _tunnelStoneSurface;
}

function getCutConcreteSurface() {
    if (_cutConcreteSurface) return _cutConcreteSurface;
    const raster = createConcreteRaster(256, 0x3c0c2e);
    _cutConcreteSurface = {
        map: makeTiledCivilTexture(raster.color, raster.size, CUT_CONCRETE_TILE_M, THREE.SRGBColorSpace),
        bumpMap: makeTiledCivilTexture(raster.height, raster.size, CUT_CONCRETE_TILE_M),
    };
    return _cutConcreteSurface;
}

// Half-width of the bore for a run's rail half-width. Delegates to the shared
// definition in rail-formation so the flared open cut and the tube agree exactly.
function tunnelBoreHalfWidth(railHalfWidthM, explicitHalfWidthM = null) {
    const explicit = finiteOrNull(explicitHalfWidthM);
    return explicit !== null && explicit > 0
        ? explicit
        : railBoreHalfWidthM(railHalfWidthM);
}

function tunnelRunSection(run) {
    const railHalfWidthM = run?.halfWidthM ?? run?.alignment?.halfWidthM ?? 1.15;
    const clearHeightM = finiteOrNull(run?.tunnelClearHeightM);
    const portalCrownM = finiteOrNull(run?.tunnelPortalCrownM);
    const portalTerrainOpeningInsideM = finiteOrNull(
        run?.tunnelPortalTerrainOpeningInsideM,
    );
    return {
        railHalfWidthM,
        boreHalfWidthM: tunnelBoreHalfWidth(railHalfWidthM, run?.boreHalfWidthM),
        clearHeightM: clearHeightM !== null && clearHeightM > 0
            ? clearHeightM : TUNNEL_CEIL_HEIGHT_M,
        portalCrownM: portalCrownM !== null && portalCrownM > 0
            ? portalCrownM : null,
        portalTerrainOpeningInsideM: portalTerrainOpeningInsideM !== null
            && portalTerrainOpeningInsideM >= 0
            ? portalTerrainOpeningInsideM : TUNNEL_PORTAL_TERRAIN_OPENING_INSIDE_M,
        physicalId: run?.tunnelPhysicalId || null,
        trackCount: Math.max(1, Number(run?.tunnelTrackCount) || 1),
        trackSpacingM: finiteOrNull(run?.tunnelTrackSpacingM),
    };
}

// Sweep a masonry box (floor, ceiling, both walls) along a visible sample slice,
// appending into the shared position/index buffers. Face winding points into the
// bore; the renderer keeps this shell FrontSide so its ceiling cannot become a
// visible exterior roof where coarse terrain dips around a portal.
function appendTunnelTube(samples, section, positions, indices, uvs) {
    if (!samples || samples.length < 2) return;
    const frames = [];
    for (let index = 0; index < samples.length - 1; index++) {
        const dx = samples[index + 1].x - samples[index].x;
        const dz = samples[index + 1].z - samples[index].z;
        const length = Math.hypot(dx, dz);
        frames.push(length > 1e-6 ? { x: dz / length, z: -dx / length } : null);
    }
    const joins = samples.map((_, index) => makeJoinVector(frames[index - 1], frames[index]));
    const hw = section.boreHalfWidthM;
    // Per-sample cross-section corners + a metre-space U (station) for texturing.
    let cumU = 0;
    const rows = samples.map((sample, index) => {
        const join = joins[index];
        if (index > 0) {
            cumU += Math.hypot(sample.x - samples[index - 1].x, sample.z - samples[index - 1].z);
        }
        const bedY = sample.railY + RENDERED_TUNNEL_BED_ABOVE_RAIL_M;
        const floorY = bedY - TUNNEL_FLOOR_DROP_M;
        const ceilY = bedY + section.clearHeightM;
        return {
            lx: sample.x - join.x * hw, lz: sample.z - join.z * hw,
            rx: sample.x + join.x * hw, rz: sample.z + join.z * hw,
            floorY, ceilY,
            u: Number.isFinite(sample.station) ? sample.station : cumU,
        };
    });
    // Each of the four faces is swept as its OWN vertex strip so computeVertexNormals
    // gives flat per-face normals — the wall/ceiling/floor junctions render as crisp
    // edges (item: readable box) instead of one smoothed grey blob. V is metre-space
    // perimeter distance so the stone courses wrap continuously around the section.
    const wallH = section.clearHeightM + TUNNEL_FLOOR_DROP_M;
    const width = 2 * hw;
    const vLF = 0;
    const vLC = wallH;
    const vRC = wallH + width;
    const vRF = 2 * wallH + width;
    const vLF2 = 2 * wallH + 2 * width;
    const sweepFace = (cornerA, cornerB, vA, vB) => {
        const base = positions.length / 3;
        for (const row of rows) {
            const a = cornerA(row);
            const b = cornerB(row);
            positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
            uvs.push(row.u, vA, row.u, vB);
        }
        for (let index = 0; index < rows.length - 1; index++) {
            const p = base + index * 2;
            const q = base + (index + 1) * 2;
            indices.push(p, p + 1, q, p + 1, q + 1, q);
        }
    };
    const LF = (row) => [row.lx, row.floorY, row.lz];
    const LC = (row) => [row.lx, row.ceilY, row.lz];
    const RC = (row) => [row.rx, row.ceilY, row.rz];
    const RF = (row) => [row.rx, row.floorY, row.rz];
    sweepFace(LF, LC, vLF, vLC);   // left wall
    sweepFace(LC, RC, vLC, vRC);   // ceiling
    sweepFace(RC, RF, vRC, vRF);   // right wall
    sweepFace(RF, LF, vRF, vLF2);  // floor
}

// Floors the open cut-and-cover MOUTHS beside the trackbed. appendTunnelTube's
// floor covers only the buried middle; in the flared mouth (the cut wall widens
// from the rail half-width out to the bore half-width) the wide ledge had no floor,
// so the dark night sky showed through as purple patches. This sweeps a floor over
// the FULL run at each sample's precomputed flared half-width (sample._floorHalfW),
// a hair below the tube floor so the buried overlap stays hidden and can't z-fight.
function appendTunnelFloorStrip(samples, positions, indices, uvs) {
    if (!samples || samples.length < 2) return;
    const frames = [];
    for (let index = 0; index < samples.length - 1; index++) {
        const dx = samples[index + 1].x - samples[index].x;
        const dz = samples[index + 1].z - samples[index].z;
        const length = Math.hypot(dx, dz);
        frames.push(length > 1e-6 ? { x: dz / length, z: -dx / length } : null);
    }
    const joins = samples.map((_, index) => makeJoinVector(frames[index - 1], frames[index]));
    const base = positions.length / 3;
    let cumU = 0;
    for (let index = 0; index < samples.length; index++) {
        const sample = samples[index];
        if (index > 0) {
            cumU += Math.hypot(sample.x - samples[index - 1].x, sample.z - samples[index - 1].z);
        }
        const join = joins[index];
        const hw = Number.isFinite(sample._floorHalfW) ? sample._floorHalfW : tunnelBoreHalfWidth(1.15);
        const bedY = sample.railY + RENDERED_TUNNEL_BED_ABOVE_RAIL_M;
        const y = bedY - TUNNEL_FLOOR_DROP_M - 0.02;
        const u = Number.isFinite(sample.station) ? sample.station : cumU;
        positions.push(
            sample.x - join.x * hw, y, sample.z - join.z * hw,
            sample.x + join.x * hw, y, sample.z + join.z * hw,
        );
        uvs.push(u, 0, u, 2 * hw);
    }
    for (let index = 0; index < samples.length - 1; index++) {
        const p = base + index * 2;
        const q = base + (index + 1) * 2;
        indices.push(p, p + 1, q, p + 1, q + 1, q);
    }
}

// Distance-marker plates ("◀ 345") on the bore walls: every 50 m of chainage,
// the remaining metres to the portal the countdown runs toward — right wall (in
// the direction of increasing chainage) counts down to the far mouth, left wall
// to the near one. Placed only inside the drawn station-free tube slices, so a
// plate never floats in a station hall where the bore is suppressed.
function collectTunnelDistanceMarkerPlacements(buried, tubeSlices, section, out) {
    if (!Array.isArray(buried) || buried.length < 2) return;
    const stStart = Number(buried[0].station);
    const stEnd = Number(buried[buried.length - 1].station);
    if (!Number.isFinite(stStart) || !Number.isFinite(stEnd) || stEnd <= stStart) return;
    const sliceRanges = (tubeSlices || [])
        .map((slice) => [Number(slice[0]?.station), Number(slice[slice.length - 1]?.station)])
        .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    if (sliceRanges.length === 0) return;
    const plans = planTunnelDistanceMarkers([{ startM: stStart, endM: stEnd }]);
    const boreHalf = section.boreHalfWidthM;
    let cursor = 0;
    for (const plan of plans) {
        const d = plan.chainageM;
        if (!sliceRanges.some(([a, b]) => d >= a - 1e-6 && d <= b + 1e-6)) continue;
        while (cursor < buried.length - 2
            && Number(buried[cursor + 1].station) < d) cursor++;
        const a = buried[cursor];
        const b = buried[cursor + 1];
        const sta = Number(a?.station);
        const stb = Number(b?.station);
        if (!Number.isFinite(sta) || !Number.isFinite(stb) || stb <= sta) continue;
        const f = Math.max(0, Math.min(1, (d - sta) / (stb - sta)));
        const x = a.x + (b.x - a.x) * f;
        const z = a.z + (b.z - a.z) * f;
        const railY = a.railY + (b.railY - a.railY) * f;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        // Same basis as appendTunnelTube: join=(dz,−dx) is the LEFT of travel,
        // so the driver's right wall is the minus side. Text runs toward the
        // reader's right; the chevron points along the countdown (plates doc).
        const jx = dz / len;
        const jz = -dx / len;
        const ax = dx / len;
        const az = dz / len;
        const faceOffset = boreHalf - 0.03;
        const floorY = railY + RENDERED_TUNNEL_BED_ABOVE_RAIL_M - TUNNEL_FLOOR_DROP_M;
        const y = floorY + TUNNEL_MARKER_CENTRE_ABOVE_FLOOR_M;
        if (plan.rightM != null) {
            out.push({
                x: x - jx * faceOffset, y, z: z - jz * faceOffset,
                dirX: -ax, dirZ: -az,
                text: plan.rightM,
            });
        }
        if (plan.leftM != null) {
            out.push({
                x: x + jx * faceOffset, y, z: z + jz * faceOffset,
                dirX: ax, dirZ: az,
                text: plan.leftM,
            });
        }
    }
}

// Discrete emissive light fixtures along the tube ceiling — short glowing boxes
// (~1 m) every ~5 m, so the bore reads as a lit tunnel with visible 3D lighting
// elements instead of one continuous ribbon. Collects world placements; the
// caller builds them as one InstancedMesh. Spacing is by true chainage so the
// fixtures stay evenly spaced regardless of how densely the run is sampled.
// One yaw-aligned collider box per tube wall segment, both sides, so the
// walker SLIDES along the bore instead of walking out through the masonry.
// Yaw frame matches walk-collision's pushCollider (three RotationY): the box's
// local X axis in world is (cos, -sin) in (x, z).
function collectTunnelWallColliders(samples, section, out) {
    if (!samples || samples.length < 2) return;
    const boreHalf = section.boreHalfWidthM;
    for (let index = 0; index < samples.length - 1; index++) {
        const a = samples[index];
        const b = samples[index + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 1e-6) continue;
        const cos = dx / length;
        const sin = -dz / length;
        const normalX = dz / length;
        const normalZ = -dx / length;
        const bedY = Math.min(a.railY, b.railY) + TRACKBED_Y;
        for (const side of [-1, 1]) {
            const wallCenterOffset = side * (boreHalf - 0.15);
            out.push({
                cx: (a.x + b.x) * 0.5 + normalX * wallCenterOffset,
                cz: (a.z + b.z) * 0.5 + normalZ * wallCenterOffset,
                hx: length * 0.5 + 0.3,
                hz: 0.3,
                sin,
                cos,
                minY: bedY - 0.5,
                maxY: bedY + Math.min(section.clearHeightM, 5.5),
            });
        }
    }
}

function collectTunnelLightBoxes(samples, section, out) {
    if (!samples || samples.length < 2) return;
    let dist = 0;
    let nextAt = TUNNEL_LIGHT_SPACING_M * 0.5;   // first fixture half a gap in
    for (let index = 0; index < samples.length - 1; index++) {
        const a = samples[index];
        const b = samples[index + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const segLen = Math.hypot(dx, dz);
        if (segLen < 1e-6) continue;
        const angleY = Math.atan2(dx, dz);
        while (nextAt <= dist + segLen) {
            const t = (nextAt - dist) / segLen;
            const railY = a.railY + (b.railY - a.railY) * t;
            const bedY = railY + RENDERED_TUNNEL_BED_ABOVE_RAIL_M;
            out.push({
                x: a.x + dx * t,
                z: a.z + dz * t,
                y: bedY + section.clearHeightM
                    - TUNNEL_LIGHT_DROP_M - TUNNEL_LIGHT_BOX_HEIGHT_M * 0.5,
                angleY,
            });
            nextAt += TUNNEL_LIGHT_SPACING_M;
        }
        dist += segLen;
    }
}

// Frame the bore opening at one tunnel mouth. `alongX/alongZ` is the track
// direction through the mouth (used only for the perpendicular); the facade
// lies in the plane perpendicular to it. It is a hillside wall (bore wall out
// to the jambs, ceiling up to the retained ground) with a rectangular hole
// exactly matching the tube cross-section, so nothing crosses the track.
function appendTunnelPortal(mouth, alongX, alongZ, section, positions, indices, uvs) {
    const length = Math.hypot(alongX, alongZ);
    if (!(length > 1e-6)) return;
    const join = { x: alongZ / length, z: -alongX / length };
    const hw = section.boreHalfWidthM;
    const negativeWingM = Math.max(
        TUNNEL_PORTAL_WING_M,
        finiteOrNull(mouth.portalRetainedBenchM?.negativeNormalM) ?? 0,
    );
    const positiveWingM = Math.max(
        TUNNEL_PORTAL_WING_M,
        finiteOrNull(mouth.portalRetainedBenchM?.positiveNormalM) ?? 0,
    );
    const negativeOuter = -hw - negativeWingM;
    const positiveOuter = hw + positiveWingM;
    const bedY = mouth.railY + RENDERED_TUNNEL_BED_ABOVE_RAIL_M;
    const floorY = bedY - TUNNEL_FLOOR_DROP_M;
    const ceilY = bedY + section.clearHeightM;
    // The facade is a short civil collar, not a terrain-height extrusion. A
    // robust retained-ground sample can raise it only inside a strict local
    // crown band; the actual hill owns everything above that overlap.
    const retainedY = Number(mouth.terrainMaxY);
    const requestedCrownM = section.portalCrownM ?? (
        Number.isFinite(retainedY) ? retainedY - ceilY : TUNNEL_PORTAL_MIN_CROWN_M
    );
    const crownM = Math.max(
        TUNNEL_PORTAL_MIN_CROWN_M,
        Math.min(TUNNEL_PORTAL_MAX_CROWN_M, requestedCrownM),
    );
    const hillTopY = ceilY + crownM + TUNNEL_PORTAL_CROWN_OVERLAP_M;
    // UV in metres: U across the facade (cross offset), V up it (height), so the
    // portal shares the bore's stone scale.
    const at = (offset, y) => [
        mouth.x + join.x * offset, y, mouth.z + join.z * offset, offset, y,
    ];
    const quad = (p0, p1, p2, p3) => {
        const base = positions.length / 3;
        for (const p of [p0, p1, p2, p3]) {
            positions.push(p[0], p[1], p[2]);
            uvs.push(p[3], p[4]);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    // Left jamb, right jamb (full height beside the bore) and the lintel above
    // it. Together they leave the bore rectangle (±hw, floorY→ceilY) open.
    quad(at(negativeOuter, floorY), at(-hw, floorY), at(-hw, hillTopY), at(negativeOuter, hillTopY));
    quad(at(hw, floorY), at(positiveOuter, floorY), at(positiveOuter, hillTopY), at(hw, hillTopY));
    quad(at(-hw, ceilY), at(hw, ceilY), at(hw, hillTopY), at(-hw, hillTopY));

    // The DTM aperture extends a few metres into the hill so coarse terrain
    // triangles cannot hang through the bore. Seal precisely that otherwise
    // uncovered throat with a thin masonry roof, buried just beyond and beside
    // the aperture. Its faces join this existing portal batch, so the repair
    // adds no mesh or draw call and never roofs the open approach.
    if (!mouth.portalHasTerrainOpening || !mouth.portalInterior) return;
    const cap = buildTunnelPortalRoofCapFootprint({
        mouth,
        interior: mouth.portalInterior,
        boreHalfWidthM: hw,
        terrainOpeningInsideM: section.portalTerrainOpeningInsideM,
        negativeHalfWidthM: Math.abs(negativeOuter),
        positiveHalfWidthM: positiveOuter,
        physicalId: section.physicalId,
        side: mouth.portalSide,
    });
    if (!cap) return;
    const [mouthNegative, insideNegative, insidePositive, mouthPositive] = cap.ring;
    const interiorDistanceM = Math.hypot(
        mouth.portalInterior.x - mouth.x,
        mouth.portalInterior.z - mouth.z,
    );
    const adjacentRailDeltaM = Number(mouth.portalInterior.railY) - Number(mouth.railY);
    const capGradeDeltaM = interiorDistanceM > 1e-6 && Number.isFinite(adjacentRailDeltaM)
        ? adjacentRailDeltaM * cap.insideM / interiorDistanceM
        : 0;
    const innerCeilY = ceilY + capGradeDeltaM;
    const innerTopY = hillTopY + capGradeDeltaM;
    const inwardX = (mouth.portalInterior.x - mouth.x) / interiorDistanceM;
    const inwardZ = (mouth.portalInterior.z - mouth.z) / interiorDistanceM;
    const topPoint = (point, y) => {
        const dx = point.x - mouth.x;
        const dz = point.z - mouth.z;
        return [
            point.x,
            y,
            point.z,
            dx * join.x + dz * join.z,
            dx * inwardX + dz * inwardZ,
        ];
    };
    const sidePoint = (point, y, alongM) => [point.x, y, point.z, alongM, y];
    const endPoint = (point, y) => {
        const dx = point.x - mouth.x;
        const dz = point.z - mouth.z;
        return [point.x, y, point.z, dx * join.x + dz * join.z, y];
    };
    quad(
        topPoint(mouthNegative, hillTopY),
        topPoint(insideNegative, innerTopY),
        topPoint(insidePositive, innerTopY),
        topPoint(mouthPositive, hillTopY),
    );
    quad(
        sidePoint(mouthNegative, ceilY, 0),
        sidePoint(insideNegative, innerCeilY, cap.insideM),
        sidePoint(insideNegative, innerTopY, cap.insideM),
        sidePoint(mouthNegative, hillTopY, 0),
    );
    quad(
        sidePoint(insidePositive, innerCeilY, cap.insideM),
        sidePoint(mouthPositive, ceilY, 0),
        sidePoint(mouthPositive, hillTopY, 0),
        sidePoint(insidePositive, innerTopY, cap.insideM),
    );
    quad(
        endPoint(insideNegative, innerCeilY),
        endPoint(insidePositive, innerCeilY),
        endPoint(insidePositive, innerTopY),
        endPoint(insideNegative, innerTopY),
    );
}

function addRailTunnels(
    target,
    railFormation,
    stationFlares,
    centerX,
    centerZ,
    maxRadiusM,
) {
    const runs = railFormation?.getTunnelRuns?.() || [];
    if (runs.length === 0) return;
    const positions = [];
    const indices = [];
    const uvs = [];
    const portalPositions = [];
    const portalIndices = [];
    const portalUvs = [];
    const portalMouths = [];
    const lightBoxes = [];
    const wallColliderBoxes = [];
    const markerPlacements = [];
    const visibleRadiusM = maxRadiusM + RAIL_WALL_WINDOW_PADDING_M;
    for (const run of runs) {
        const section = tunnelRunSection(run);
        // A shared two-track bore is swept around the midpoint measured from
        // both physical centrelines. The solved samples remain the drive path;
        // boreSamples are the laterally shifted civil axis only.
        const samples = run.boreSamples || run.samples;
        // Tube and portal share the civil run's exact endpoints. The formation
        // outside the tunnel owns the widening approach; no part of the mapped
        // tunnel is silently converted into an open cut.
        const startIndex = run.portalStartMouthIndex;
        const endIndex = run.portalEndMouthIndex;
        const buried = (startIndex != null && endIndex != null && endIndex > startIndex)
            ? samples.slice(startIndex, endIndex + 1)
            : null;
        if (buried) {
            const tubeSlices = tunnelSampleSlicesOutsideStations(
                run,
                buried,
                stationFlares,
                centerX,
                centerZ,
                visibleRadiusM,
            );
            for (const sliceSamples of tubeSlices) {
                appendTunnelTube(sliceSamples, section, positions, indices, uvs);
                collectTunnelLightBoxes(sliceSamples, section, lightBoxes);
                collectTunnelWallColliders(sliceSamples, section, wallColliderBoxes);
            }
            collectTunnelDistanceMarkerPlacements(buried, tubeSlices, section, markerPlacements);
        }
        // Floor the complete bore. The approach's concrete formation reaches the
        // same width at the endpoint, so the two surfaces overlap without a gap.
        if (startIndex != null && endIndex != null && samples.length > 1) {
            const lastIdx = samples.length - 1;
            const floorRunSamples = samples.map((sample, k) => {
                let hw;
                if (k >= startIndex && k <= endIndex) {
                    hw = section.boreHalfWidthM;
                } else {
                    const frac = (k < startIndex)
                        ? (startIndex > 0 ? k / startIndex : 1)
                        : ((lastIdx - endIndex) > 0 ? (lastIdx - k) / (lastIdx - endIndex) : 1);
                    hw = section.railHalfWidthM
                        + (section.boreHalfWidthM - section.railHalfWidthM) * frac + 0.15;
                }
                return { ...sample, _floorHalfW: hw };
            });
            for (const floorSamples of tunnelSampleSlicesOutsideStations(
                run,
                floorRunSamples,
                stationFlares,
                centerX,
                centerZ,
                visibleRadiusM,
            )) {
                appendTunnelFloorStrip(floorSamples, positions, indices, uvs);
            }
        }
        // Frame the bore at its published endpoint (headwall + jambs, no face
        // across the track). This seals the hill around the opening without
        // moving the visible portal away from its OSM/solved chainage.
        const s = samples;
        for (const mouthIndex of [run.portalStartMouthIndex, run.portalEndMouthIndex]) {
            if (mouthIndex == null || !s || !s[mouthIndex]) continue;
            const mouth = s[mouthIndex];
            if (!isPointWithinRenderWindow(mouth.x, mouth.z, centerX, centerZ, visibleRadiusM)) continue;
            const isStartMouth = mouthIndex === run.portalStartMouthIndex;
            const ahead = s[mouthIndex + 1] || mouth;
            const behind = s[mouthIndex - 1] || mouth;
            const interior = isStartMouth ? ahead : behind;
            portalMouths.push({
                x: mouth.x,
                z: mouth.z,
                mouth,
                interior,
                alongX: ahead.x - behind.x,
                alongZ: ahead.z - behind.z,
                section,
                physicalId: section.physicalId,
                side: isStartMouth ? 'start' : 'end',
                hasTerrainOpening: isStartMouth
                    ? run.portalStartHasTerrainOpening === true
                    : run.portalEndHasTerrainOpening === true,
                portalRetainedBenchM: isStartMouth
                    ? run.portalStartRetainedBenchM
                    : run.portalEndRetainedBenchM,
            });
        }
    }
    const uniquePortalMouths = dedupeRailTunnelPortalMouths(portalMouths);
    for (const portal of uniquePortalMouths) {
        appendTunnelPortal(
            {
                ...portal.mouth,
                portalRetainedBenchM: portal.portalRetainedBenchM,
                portalInterior: portal.interior,
                portalHasTerrainOpening: portal.hasTerrainOpening,
                portalSide: portal.side,
            },
            portal.alongX,
            portal.alongZ,
            portal.section,
            portalPositions,
            portalIndices,
            portalUvs,
        );
    }
    if (positions.length === 0 && portalPositions.length === 0) return;
    const stone = getTunnelStoneSurface();
    const tunnelMaterial = (side) => new THREE.MeshStandardMaterial({
        map: stone.map,
        bumpMap: stone.bumpMap,
        bumpScale: 0.6,
        color: 0x9c968c,
        roughness: 0.97,
        metalness: 0,
        emissive: 0x14130f,
        side,
    });
    const geometryFrom = (meshPositions, meshIndices, meshUvs) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(meshPositions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(meshUvs, 2));
        geometry.setIndex(meshIndices);
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        return geometry;
    };
    if (positions.length > 0) {
        // The swept shell is interior-facing only. Double-sided masonry made
        // the outside of the ceiling read as an exposed roof slab wherever the
        // coarse DTM dipped at a portal; from above that surface must not exist.
        const mesh = new THREE.Mesh(
            geometryFrom(positions, indices, uvs),
            tunnelMaterial(THREE.FrontSide),
        );
        mesh.name = 'ProposalRailTunnel';
        // Solid bore walls for walk mode: without these the walker strolls through
        // the masonry into the hill, at which point ground detection has nothing
        // sane to answer. walk-collision reads these explicit yaw-boxes off
        // userData (the tube itself is swept custom geometry, not BoxGeometry).
        if (wallColliderBoxes.length > 0) mesh.userData.walkColliderBoxes = wallColliderBoxes;
        mesh.userData.sections = runs.map(run => ({
            physicalId: run.tunnelPhysicalId || null,
            trackCount: Math.max(1, Number(run.tunnelTrackCount) || 1),
            trackSpacingM: finiteOrNull(run.tunnelTrackSpacingM),
            centerOffsetM: finiteOrNull(run.tunnelCenterOffsetM) ?? 0,
            boreHalfWidthM: finiteOrNull(run.boreHalfWidthM),
            clearHeightM: finiteOrNull(run.tunnelClearHeightM) ?? TUNNEL_CEIL_HEIGHT_M,
        }));
        // The sealed masonry interior must never sample the global shadow map:
        // surface cars and trees otherwise leak blocky projections through the roof.
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.renderOrder = SURFACE_RENDER_ORDER.RAIL_STRUCTURE;
        mesh.frustumCulled = false;
        target.add(mesh);
    }
    if (portalPositions.length > 0) {
        // Portal facades need both approach and tunnel faces, but live in their
        // own mesh so that requirement can never make the entire roof two-sided.
        const portalMesh = new THREE.Mesh(
            geometryFrom(portalPositions, portalIndices, portalUvs),
            tunnelMaterial(THREE.DoubleSide),
        );
        portalMesh.name = 'ProposalRailTunnelPortals';
        portalMesh.userData.portalCount = uniquePortalMouths.length;
        portalMesh.castShadow = true;
        portalMesh.receiveShadow = false;
        portalMesh.renderOrder = SURFACE_RENDER_ORDER.RAIL_STRUCTURE;
        portalMesh.frustumCulled = false;
        target.add(portalMesh);
    }

    if (lightBoxes.length > 0) {
        // One InstancedMesh of short glowing boxes. Emissive (self-lit) rather
        // than real lights: a light per fixture would add to every material's
        // per-fragment light loop scene-wide — a real perf hit in a 2M-triangle
        // view — so the boxes read AS the light, and ambient keeps the bore
        // legible between them.
        const boxGeometry = new THREE.BoxGeometry(
            TUNNEL_LIGHT_BOX_WIDTH_M, TUNNEL_LIGHT_BOX_HEIGHT_M, TUNNEL_LIGHT_BOX_LENGTH_M,
        );
        const boxMaterial = new THREE.MeshStandardMaterial({
            color: 0x2a2620,
            emissive: 0xffe6b0,
            emissiveIntensity: 1.7,
            roughness: 1,
            metalness: 0,
        });
        const lightMesh = new THREE.InstancedMesh(boxGeometry, boxMaterial, lightBoxes.length);
        lightMesh.name = 'ProposalRailTunnelLights';
        const matrix = new THREE.Matrix4();
        const quaternion = new THREE.Quaternion();
        const yAxis = new THREE.Vector3(0, 1, 0);
        const position = new THREE.Vector3();
        const scale = new THREE.Vector3(1, 1, 1);
        for (let index = 0; index < lightBoxes.length; index++) {
            const box = lightBoxes[index];
            position.set(box.x, box.y, box.z);
            quaternion.setFromAxisAngle(yAxis, box.angleY);
            matrix.compose(position, quaternion, scale);
            lightMesh.setMatrixAt(index, matrix);
        }
        lightMesh.instanceMatrix.needsUpdate = true;
        lightMesh.castShadow = false;
        lightMesh.receiveShadow = false;
        lightMesh.renderOrder = TRACKBED_RENDER_ORDER;
        lightMesh.frustumCulled = false;
        target.add(lightMesh);
    }

    for (const plateMesh of buildTunnelMarkerPlates(markerPlacements)) {
        plateMesh.renderOrder = TRACKBED_RENDER_ORDER;
        target.add(plateMesh);
    }
}

// Collars, walls and their collider boxes share the same captured generation.
// The caller owns this detached root throughout preparation and cancellation.
function* createRailFormationDressingSteps(dressing, railFormation, centerX, centerZ, maxRadiusM) {
    for (const [kind, buildSteps] of [
        ['collars', addRailFormationTerrainCollarsSteps],
        ['retainingWalls', addRailFormationRetainingWallsSteps],
    ]) {
        for (const step of buildSteps(dressing, railFormation, centerX, centerZ, maxRadiusM)) {
            yield { ...step, phase: kind + ':' + step.phase };
        }
    }
}

function createRailStructuresGroup(
    railFormation,
    terrain,
    stationFlares,
    centerX,
    centerZ,
    maxRadiusM,
    phase = () => {},
    roadFormation = lastRoadFormation,
    mappedWater = null,
) {
    const structures = new THREE.Group();
    structures.name = 'RailStructures';
    addRailViaducts(structures, railFormation, terrain, centerX, centerZ, maxRadiusM, roadFormation, mappedWater);
    phase('viaducts');
    addRailTunnels(structures, railFormation, stationFlares, centerX, centerZ, maxRadiusM);
    phase('tunnels');
    return structures;
}

function build(
    features,
    anchorLat,
    anchorLon,
    maxRadiusM,
    switchRules = null,
    driverGraph = null,
    routedSegments = null,
    rampOpenCutVolumes = [],
    stops = [],
    terrain = null,
    railFormation = null,
    roadVerticalAlignments = null,
    photoTrackFrame = null,
    centerX = 0,
    centerZ = 0,
    precomputedSegments = null,
    precomputedFormationDressing = null,
    precomputedStationFlares = null,
    precomputedStructures = null,
    precomputedStructuresKey = null,
    roadFormation = lastRoadFormation,
) {
    const g = new THREE.Group();
    g.name = 'TramRails';
    const candidate = {
        root: g,
        stationFlares: [],
        trackSpacingStationFlares: [],
        segments: [],
        formationDressingGroup: null,
        structuresGroup: null,
        structuresKey: null,
        cellRenderedSegments: [],
    };
    if (!features || features.length === 0) return candidate;
    // Time this candidate assembly separately from the preceding cooperative
    // geometry and GPU stages. The overlay needs actual work per invocation;
    // elapsed time across scheduler yields is not CPU build time.
    // recordLayerFrameMs is a no-op unless the overlay is up.
    let tPhase = performance.now();
    const phase = (name) => {
        const now = performance.now();
        recordLayerFrameMs(`rails:build:${name}`, now - tPhase);
        tPhase = now;
    };

    const stationFlares = Array.isArray(precomputedStationFlares)
        ? precomputedStationFlares
        : buildUndergroundStationFlareProfiles(
            features,
            stops,
            anchorLat,
            anchorLon,
            photoTrackFrame,
        );
    // Publish what THIS build actually splayed, so anything positioning itself
    // against these rails (ambient trains) reads the same answer instead of
    // re-deriving it. Kept in step with the render radius on purpose: a station
    // outside it has no rails to be misaligned with either.
    candidate.stationFlares = stationFlares;
    candidate.trackSpacingStationFlares = stationFlaresThatSplayTrackCenters(stationFlares)
        .map(station => ({ x: station.x, z: station.z, trackId: station.trackId }));
    phase('flares');
    const segments = Array.isArray(precomputedSegments)
        ? precomputedSegments
        : computeRailTrackbedSegments(features, anchorLat, anchorLon, maxRadiusM, {
            rampOpenCutVolumes,
            stationFlares,
            terrain,
            railFormation,
            roadFormation,
            roadVerticalAlignments,
            photoTrackFrame,
            centerX,
            centerZ,
        });
    candidate.segments = segments;
    phase('segments');   // computeRailTrackbedSegments
    phase('railSupport');
    if (segments.length === 0) {
        // A staged terrain refresh may already own unpublished dressing. It
        // cannot be attached to an empty rail build and has no other owner.
        if (precomputedFormationDressing) disposeGroup(precomputedFormationDressing);
        if (precomputedStructures) disposeGroup(precomputedStructures);
        return candidate;
    }

    // Timed individually. These four ran INSIDE what the first instrumentation
    // pass called `sweep:emit`, because the phase clock started above them — so
    // a ~125 ms reading was blamed on the chord loop when the loop was only
    // about a fifth of it. Rewriting the loop with typed arrays was still worth
    // it (16.7x on the loop in isolation, byte-identical output) but it moved
    // the total by only ~20 ms, which is what exposed the mislabelling.
    if (!precomputedFormationDressing) throw new Error('Rail publication requires prepared formation dressing');
    const formationDressing = precomputedFormationDressing;
    candidate.formationDressingGroup = formationDressing;
    g.add(formationDressing);
    // Viaducts and tunnels persist across rebuilds behind a content key; a
    // terrain refresh away from every run re-attaches the previous group
    // without rebuilding a single pier.
    const structuresKey = precomputedStructuresKey || railStructuresBuildKey(
        railFormation,
        stationFlares,
        centerX,
        centerZ,
        maxRadiusM,
        railPillarRoadSurfaceSignature(railFormation, roadFormation),
    );
    if (precomputedStructures) {
        candidate.structuresGroup = precomputedStructures;
        candidate.structuresKey = precomputedStructuresKey || structuresKey;
    } else if (railStructuresGroup && structuresKey === railStructuresKey) {
        candidate.structuresGroup = railStructuresGroup;
        candidate.structuresKey = railStructuresKey;
    } else {
        const structures = createRailStructuresGroup(
            railFormation,
            terrain,
            stationFlares,
            centerX,
            centerZ,
            maxRadiusM,
            phase,
            roadFormation,
        );
        candidate.structuresGroup = structures;
        candidate.structuresKey = structuresKey;
    }
    // Reusing the published structures must not move them out of the visible
    // generation while this detached candidate is staged across frames.
    if (candidate.structuresGroup
        && candidate.structuresGroup !== railStructuresGroup) {
        g.add(candidate.structuresGroup);
    }

    // Sweep each rail through the same mitered endpoint cross-sections as the
    // bed. Independent BoxGeometry chords left visible air gaps wherever the
    // heading changed; these merged prisms share exact joint edges.
    // Preallocated typed arrays, written by index — NOT growable arrays with
    // spread pushes. Measured 2026-07-27: this loop was 125 ms of a 198 ms rail
    // rebuild (241 ms at startup) while `bed`, which walks the same segments and
    // emits comparable geometry into preallocated Float32Arrays, cost 13 ms.
    //
    // The old form paid, PER PRISM: a freshly-defined `point` closure, eight
    // three-element array allocations, a 24-argument spread push into a growable
    // array, and a `[-1, 1]` literal allocated once per track. None of that is
    // the geometry — it is all garbage.
    //
    // The vertex layout and index winding below are unchanged, deliberately:
    // this is the same mesh, built without the allocations.
    // Keep the renderer shared while allowing the handful of road-carried tram
    // chords to live in their own replaceable batch. A streamed deck-height
    // change must never rebuild/weld the citywide ordinary rail mesh.
    if (!addRenderedTrackSegmentMeshes) {
    // cullable: per-cell meshes carry tight bounds and use normal frustum
    // culling; the unchunked whole-window batches (embedded/structural) keep
    // culling off because their aggregate bounds sit awkwardly against the
    // moving cab frustum.
    addRenderedTrackSegmentMeshes = (
        g,
        segments,
        phase,
        nameSuffix = '',
        {
            cullable = false,
            junctionIncidents = null,
            computeRailNormals = true,
        } = {},
    ) => {
    if (!segments || segments.length === 0) return;
    let prismCount = 0;
    for (const s of segments) {
        prismCount += Math.min(
            s.startTrackCenterOffsetsM.length,
            s.endTrackCenterOffsetsM.length,
        ) * 2;   // two rails per track
    }
    const railPositions = new Float32Array(prismCount * 8 * 3);
    const railIndices = new Uint32Array(prismCount * 24);
    let pv = 0;
    let pi = 0;
    for (const s of segments) {
        const railProfile = getRailVisualProfile(s.properties);
        const railWidthM = railProfile.railWidthM;
        const railHeightM = railProfile.railHeightM;
        const railCenterAboveDatumM = railProfile.railCenterAboveDatumM;
        const startJoinX = s.startJoinX;
        const startJoinZ = s.startJoinZ;
        const endJoinX = s.endJoinX;
        const endJoinZ = s.endJoinZ;
        const startCenterY = railCenterAboveDatumM + s.yStart;
        const endCenterY = railCenterAboveDatumM + s.yEnd;
        const startBottomY = startCenterY - railHeightM * 0.5;
        const startTopY = startCenterY + railHeightM * 0.5;
        const endBottomY = endCenterY - railHeightM * 0.5;
        const endTopY = endCenterY + railHeightM * 0.5;
        const trackCount = Math.min(
            s.startTrackCenterOffsetsM.length,
            s.endTrackCenterOffsetsM.length,
        );
        for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
            const startTrackCenterOffset = s.startTrackCenterOffsetsM[trackIndex];
            const endTrackCenterOffset = s.endTrackCenterOffsetsM[trackIndex];
            for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
                const side = sideIndex === 0 ? -1 : 1;
                const startRailCenterOffset = startTrackCenterOffset + s.gaugeM * 0.5 * side;
                const endRailCenterOffset = endTrackCenterOffset + s.gaugeM * 0.5 * side;
                const startLowOffset = startRailCenterOffset - railWidthM * 0.5;
                const startHighOffset = startRailCenterOffset + railWidthM * 0.5;
                const endLowOffset = endRailCenterOffset - railWidthM * 0.5;
                const endHighOffset = endRailCenterOffset + railWidthM * 0.5;
                const base = pv / 3;
                // Same eight vertices, same order: start low/high × bottom/top,
                // then end low/high × bottom/top.
                railPositions[pv++] = s.x1 + startJoinX * startLowOffset;
                railPositions[pv++] = startBottomY;
                railPositions[pv++] = s.z1 + startJoinZ * startLowOffset;
                railPositions[pv++] = s.x1 + startJoinX * startLowOffset;
                railPositions[pv++] = startTopY;
                railPositions[pv++] = s.z1 + startJoinZ * startLowOffset;
                railPositions[pv++] = s.x1 + startJoinX * startHighOffset;
                railPositions[pv++] = startBottomY;
                railPositions[pv++] = s.z1 + startJoinZ * startHighOffset;
                railPositions[pv++] = s.x1 + startJoinX * startHighOffset;
                railPositions[pv++] = startTopY;
                railPositions[pv++] = s.z1 + startJoinZ * startHighOffset;
                railPositions[pv++] = s.x2 + endJoinX * endLowOffset;
                railPositions[pv++] = endBottomY;
                railPositions[pv++] = s.z2 + endJoinZ * endLowOffset;
                railPositions[pv++] = s.x2 + endJoinX * endLowOffset;
                railPositions[pv++] = endTopY;
                railPositions[pv++] = s.z2 + endJoinZ * endLowOffset;
                railPositions[pv++] = s.x2 + endJoinX * endHighOffset;
                railPositions[pv++] = endBottomY;
                railPositions[pv++] = s.z2 + endJoinZ * endHighOffset;
                railPositions[pv++] = s.x2 + endJoinX * endHighOffset;
                railPositions[pv++] = endTopY;
                railPositions[pv++] = s.z2 + endJoinZ * endHighOffset;
                // top and bottom
                railIndices[pi++] = base + 1; railIndices[pi++] = base + 5; railIndices[pi++] = base + 7;
                railIndices[pi++] = base + 1; railIndices[pi++] = base + 7; railIndices[pi++] = base + 3;
                railIndices[pi++] = base + 0; railIndices[pi++] = base + 2; railIndices[pi++] = base + 6;
                railIndices[pi++] = base + 0; railIndices[pi++] = base + 6; railIndices[pi++] = base + 4;
                // low and high vertical sides
                railIndices[pi++] = base + 0; railIndices[pi++] = base + 4; railIndices[pi++] = base + 5;
                railIndices[pi++] = base + 0; railIndices[pi++] = base + 5; railIndices[pi++] = base + 1;
                railIndices[pi++] = base + 2; railIndices[pi++] = base + 3; railIndices[pi++] = base + 7;
                railIndices[pi++] = base + 2; railIndices[pi++] = base + 7; railIndices[pi++] = base + 6;
            }
        }
    }
    // A miscounted pre-pass would silently leave zeroed vertices at the origin,
    // dragging triangles across the world from (0,0,0) — loud here instead.
    if (pv !== railPositions.length || pi !== railIndices.length) {
        console.error('[rails] sweep pre-count wrong:'
            + ` wrote ${pv}/${railPositions.length} floats, ${pi}/${railIndices.length} indices`);
    }
    // Split because the two halves need opposite fixes and the phase timer
    // could not tell them apart: `emit` is the chord loop; `weld` joins shared
    // endpoints and, for whole-window meshes, calculates normals. Cell batches
    // defer their normals until every batch exists so joints share one solve.
    // The generated mesh has positions only, so use the position-specialised
    // indexed weld: the generic Three utility walks the index buffer (three
    // references per emitted vertex) and supports attributes/morph targets this
    // mesh cannot have.
    phase('sweep:emit');
    const welded = weldIndexedPositions(railPositions, railIndices, 1e-4);
    const railGeom = new THREE.BufferGeometry();
    // BufferAttribute, not Float32BufferAttribute: the typed-array subclasses
    // re-wrap with `new Float32Array(array)`, which copies. These are already
    // the right type and exactly sized.
    railGeom.setAttribute('position', new THREE.BufferAttribute(welded.positions, 3));
    railGeom.setIndex(new THREE.BufferAttribute(welded.indices, 1));
    // The sweep is assembled one chord at a time. Weld identical degree-two
    // endpoints before calculating normals so polished rail heads shade as
    // one continuous extrusion instead of showing a dark joint per chord.
    if (computeRailNormals) railGeom.computeVertexNormals();
    railGeom.computeBoundingSphere();
    phase('sweep:weld');
    const railMesh = new THREE.Mesh(railGeom, getRailBarMaterial());
    // Retain the long-standing object-name contract used by diagnostics and
    // browser probes; the merged mesh now contains both visual rail profiles.
    railMesh.name = `TramRailBars${nameSuffix}`;
    railMesh.receiveShadow = true;
    railMesh.renderOrder = SURFACE_RENDER_ORDER.RAIL_STEEL;
    // Whole-window batches keep draw-eligibility even when their aggregate
    // bounds sit awkwardly against the moving cab frustum; per-cell meshes
    // have tight bounds and cull normally.
    if (!cullable) railMesh.frustumCulled = false;
    g.add(railMesh);
    phase('sweep:mesh');

    // ── Cobblestone trackbed strip ────────────────────────────────────
    // One merged BufferGeometry covering every segment as a flat
    // gauge-derived strip (2.1 m for Zagreb's metre-gauge tram). UVs are
    // computed in segment-LOCAL coords (along
    // the rail direction × across the rail direction) so the tile
    // pattern stays parallel to travel — matching the real Zagreb
    // trackbed where pavers are laid in line with the rails, not with
    // the compass. The U axis uses the segment's `uStart` (cumulative
    // distance along the parent LineString) so adjacent segments on a
    // straight stretch tile continuously; curves naturally re-align,
    // which is also how real cobblestone laying handles bends.
    // Two strips per segment — one per track. While the tracks run together
    // their inner edges are both on the centreline, so the strips meet and read
    // as the single bed they always were. Where the tracks flare apart at an
    // underground station the strips separate, leaving the station floor (and
    // the island platform standing on it) uncovered instead of paving straight
    // through the platform.
    // Deep-underground spans (roofed tunnel runs) split into their own mesh
    // with a SELF-LIT material: the shared sun-lit bed received the shadow
    // projections of surface objects straight through the tunnel roof, and
    // (before the lamp vertical band) street-lamp glow discs too.
    const TRACKBED_TUNNEL_BELOW_M = -(
        DEFAULT_TUNNEL_COVER_THRESHOLD_M - TUNNEL_COVER_TOLERANCE_M
    );
    // The Y test means "depth below the flat world's ground plane" — valid in
    // MODEL sessions only. In photo/asl sessions scene Y is height above the
    // session DATUM, so an at-grade track at a lower ASL than the spawn
    // classified as "tunnel bed" and drew a visible two-tone seam mid-field.
    // Photo tunnel interiors are photoreal's own dressing; the split has no
    // job there.
    const isDeepSegment = (segment) => !isPhotoWorld()
        && segment.yStart < TRACKBED_TUNNEL_BELOW_M
        && segment.yEnd < TRACKBED_TUNNEL_BELOW_M;
    const surfaceSegments = segments.filter((segment) => !isDeepSegment(segment));
    const tunnelSegments = segments.filter(isDeepSegment);
    const buildBedBuffers = (bedSegments) => {
    const N = bedSegments.length;
    const positions = new Float32Array(N * 2 * 4 * 3);
    const uvs       = new Float32Array(N * 2 * 4 * 2);
    const indices   = new Uint32Array(N * 2 * 6);
    let pi = 0, ui = 0, ii = 0, vBase = 0;
    for (const s of bedSegments) {
        const uBack  = s.uStart * TRACKBED_UV_PER_M;
        const uFront = (s.uStart + s.len) * TRACKBED_UV_PER_M;
        const yBack  = TRACKBED_Y + s.yStart;
        const yFront = TRACKBED_Y + s.yEnd;
        const startInner = s.startTrackbedInnerEdgeM ?? 0;
        const endInner = s.endTrackbedInnerEdgeM ?? 0;
        // side = -1 → left strip, +1 → right strip. Corners run CCW from above.
        for (const side of [-1, 1]) {
            const startOuterOffset = side * s.startTrackbedHalfWidthM;
            const endOuterOffset = side * s.endTrackbedHalfWidthM;
            const startInnerOffset = side * startInner;
            const endInnerOffset = side * endInner;
            const corners = side < 0
                ? [
                    // [worldX, worldY, worldZ, u, v]
                    [s.x1 + s.startJoinX * startOuterOffset, yBack, s.z1 + s.startJoinZ * startOuterOffset, uBack, startOuterOffset * TRACKBED_UV_PER_M],
                    [s.x2 + s.endJoinX * endOuterOffset, yFront, s.z2 + s.endJoinZ * endOuterOffset, uFront, endOuterOffset * TRACKBED_UV_PER_M],
                    [s.x2 + s.endJoinX * endInnerOffset, yFront, s.z2 + s.endJoinZ * endInnerOffset, uFront, endInnerOffset * TRACKBED_UV_PER_M],
                    [s.x1 + s.startJoinX * startInnerOffset, yBack, s.z1 + s.startJoinZ * startInnerOffset, uBack, startInnerOffset * TRACKBED_UV_PER_M],
                ]
                : [
                    [s.x1 + s.startJoinX * startInnerOffset, yBack, s.z1 + s.startJoinZ * startInnerOffset, uBack, startInnerOffset * TRACKBED_UV_PER_M],
                    [s.x2 + s.endJoinX * endInnerOffset, yFront, s.z2 + s.endJoinZ * endInnerOffset, uFront, endInnerOffset * TRACKBED_UV_PER_M],
                    [s.x2 + s.endJoinX * endOuterOffset, yFront, s.z2 + s.endJoinZ * endOuterOffset, uFront, endOuterOffset * TRACKBED_UV_PER_M],
                    [s.x1 + s.startJoinX * startOuterOffset, yBack, s.z1 + s.startJoinZ * startOuterOffset, uBack, startOuterOffset * TRACKBED_UV_PER_M],
                ];
            for (const [wx, wy, wz, u, v] of corners) {
                positions[pi++] = wx;
                positions[pi++] = wy;
                positions[pi++] = wz;
                uvs[ui++] = u;
                uvs[ui++] = v;
            }
            indices[ii++] = vBase + 0; indices[ii++] = vBase + 1; indices[ii++] = vBase + 2;
            indices[ii++] = vBase + 0; indices[ii++] = vBase + 2; indices[ii++] = vBase + 3;
            vBase += 4;
        }
    }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
        geom.setIndex(new THREE.BufferAttribute(indices, 1));
        geom.computeVertexNormals();
        geom.computeBoundingSphere();
        return geom;
    };
    const addBedMesh = (
        bedSegments,
        material,
        name,
        receiveShadow,
        { stencilPrepass = false, heavyRail = false } = {},
    ) => {
        if (bedSegments.length === 0) return;
        const mesh = new THREE.Mesh(buildBedBuffers(bedSegments), material);
        mesh.name = name;
        mesh.userData.surfaceType = stencilPrepass
            ? 'rail-same-level-priority'
            : heavyRail
                ? 'heavy-rail-ballast'
                : 'tram-trackbed';
        mesh.userData.surfacePriorityPrepass = stencilPrepass;
        mesh.userData.halfWidthM = Math.max(
            ...bedSegments.flatMap(segment => [
                segment.startTrackbedHalfWidthM,
                segment.endTrackbedHalfWidthM,
            ]),
        );
        mesh.userData.shoulderOutsideRailM = Math.max(
            ...bedSegments.map(segment => getRailVisualProfile(
                segment.properties,
            ).trackbedShoulderM),
        );
        mesh.renderOrder = stencilPrepass
            ? SURFACE_RENDER_ORDER.RAIL_SAME_LEVEL_PREPASS
            : TRACKBED_RENDER_ORDER;
        mesh.receiveShadow = receiveShadow;
        if (!cullable) mesh.frustumCulled = false;
        g.add(mesh);
    };
    const lightSurfaceSegments = surfaceSegments.filter(segment => !segment.heavyRail);
    const heavySurfaceSegments = surfaceSegments.filter(segment => segment.heavyRail);
    const lightTunnelSegments = tunnelSegments.filter(segment => !segment.heavyRail);
    const heavyTunnelSegments = tunnelSegments.filter(segment => segment.heavyRail);
    const sameLevelLightSegments = lightSurfaceSegments.filter(
        segment => segment.ownsCivilGround === true,
    );
    const gradeSeparatedLightSegments = lightSurfaceSegments.filter(
        segment => segment.ownsCivilGround !== true,
    );
    const sameLevelHeavySegments = heavySurfaceSegments.filter(
        segment => segment.ownsCivilGround === true,
    );
    const gradeSeparatedHeavySegments = heavySurfaceSegments.filter(
        segment => segment.ownsCivilGround !== true,
    );
    addBedMesh(
        sameLevelLightSegments,
        getTrackbedMaterialForRails(RAIL_SAME_LEVEL_CLAIM),
        `TramTrackbed${nameSuffix}`,
        false,
    );
    addBedMesh(
        gradeSeparatedLightSegments,
        getTrackbedMaterialForRails(RAIL_GRADE_SEPARATED_CLAIM),
        `TramTrackbedGradeSeparated${nameSuffix}`,
        false,
    );
    addBedMesh(
        lightTunnelSegments,
        getTunnelTrackbedMaterial(),
        `TramTrackbedTunnel${nameSuffix}`,
        false,
    );
    addBedMesh(
        sameLevelHeavySegments,
        getHeavyRailBallastMaterial(RAIL_SAME_LEVEL_CLAIM),
        `HeavyRailBallast${nameSuffix}`,
        true,
        { heavyRail: true },
    );
    addBedMesh(
        gradeSeparatedHeavySegments,
        getHeavyRailBallastMaterial(RAIL_GRADE_SEPARATED_CLAIM),
        `HeavyRailBallastGradeSeparated${nameSuffix}`,
        true,
        { heavyRail: true },
    );
    addBedMesh(
        heavyTunnelSegments,
        getHeavyRailBallastMaterial(RAIL_GRADE_SEPARATED_CLAIM),
        `HeavyRailBallastTunnel${nameSuffix}`,
        false,
        { heavyRail: true },
    );
    addBedMesh(
        [...sameLevelLightSegments, ...sameLevelHeavySegments],
        getRailSameLevelStencilMaterial(),
        `RailSameLevelPriority${nameSuffix}`,
        false,
        { stencilPrepass: true },
    );

    // Fill only the switch throat between meeting strips; greenery and other
    // ground surfaces must never poke through the paved footprint at the
    // shared node. Whole-batch calls derive incidents from their own segments
    // (the historical behaviour); the render-cell path injects the cell's
    // node-owned incident lists so a boundary fan keeps all of its arms.
    phase('bed');
    const resolvedJunctionIncidents = junctionIncidents
        || junctionIncidentsFromSegments(segments);
    addJunctionPatchMeshes(g, resolvedJunctionIncidents, nameSuffix, {
        cullable,
        heavyRail: false,
    });
    addJunctionPatchMeshes(g, resolvedJunctionIncidents, nameSuffix, {
        cullable,
        heavyRail: true,
    });
    addJunctionPatchMeshes(g, resolvedJunctionIncidents, nameSuffix, {
        cullable,
        stencilPrepass: true,
    });

    // Heavy rail is physically legible at a glance: regular concrete sleepers
    // bridge the two rails and sit partly buried in the ballast. Instancing
    // keeps one draw call per 600 m render cell instead of one mesh per tie.
    const sleeperPlacements = planHeavyRailSleepers(segments);
    if (sleeperPlacements.length > 0) {
        const sleepers = new THREE.InstancedMesh(
            getHeavyRailSleeperGeometry(),
            getHeavyRailSleeperMaterial(),
            sleeperPlacements.length,
        );
        sleepers.name = `HeavyRailSleepers${nameSuffix}`;
        const matrix = new THREE.Matrix4();
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        sleeperPlacements.forEach((placement, index) => {
            position.set(placement.x, placement.y, placement.z);
            quaternion.setFromAxisAngle(up, placement.angleY);
            scale.set(placement.lengthM, placement.heightM, placement.widthM);
            matrix.compose(position, quaternion, scale);
            sleepers.setMatrixAt(index, matrix);
        });
        sleepers.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        sleepers.instanceMatrix.needsUpdate = true;
        sleepers.computeBoundingSphere();
        sleepers.castShadow = false;
        sleepers.receiveShadow = true;
        if (!cullable) sleepers.frustumCulled = false;
        g.add(sleepers);
    }

    // Light rail alone gets one flush curb band per segment side. Heavy rail's
    // broad ballast shoulder replaces this fragile 16 cm edge and therefore
    // cannot expose a buried tram curb when the terrain mask is resampled.
    // Junction endpoint lifts are
    // inherited from the bed so the borders remain deterministic at switches.
    // (The curb is not split by depth like the bed.)
    phase('junctions');
    const curbSegments = segments.filter(segment => !segment.heavyRail);
    const curbSegmentCount = curbSegments.length;
    if (curbSegmentCount > 0) {
    const curbPositions = new Float32Array(curbSegmentCount * 2 * 4 * 3);
    const curbUvs = new Float32Array(curbSegmentCount * 2 * 4 * 2);
    const curbIndices = new Uint32Array(curbSegmentCount * 2 * 6);
    let spi = 0, sui = 0, sii = 0, svBase = 0;
    for (const s of curbSegments) {
        const yBack = TRACKBED_FLAT_CURB_Y + s.yStart;
        const yFront = TRACKBED_FLAT_CURB_Y + s.yEnd;
        const uBack = s.uStart / TRACKBED_FLAT_CURB_REPEAT_M;
        const uFront = (s.uStart + s.len) / TRACKBED_FLAT_CURB_REPEAT_M;
        for (const side of [-1, 1]) {
            const startInner = (s.startTrackbedHalfWidthM - TRACKBED_FLAT_CURB_W) * side;
            const startOuter = s.startTrackbedHalfWidthM * side;
            const endInner = (s.endTrackbedHalfWidthM - TRACKBED_FLAT_CURB_W) * side;
            const endOuter = s.endTrackbedHalfWidthM * side;
            const corners = [
                [s.x1 + s.startJoinX * startInner, yBack, s.z1 + s.startJoinZ * startInner],
                [s.x2 + s.endJoinX * endInner, yFront, s.z2 + s.endJoinZ * endInner],
                [s.x2 + s.endJoinX * endOuter, yFront, s.z2 + s.endJoinZ * endOuter],
                [s.x1 + s.startJoinX * startOuter, yBack, s.z1 + s.startJoinZ * startOuter],
            ];
            for (const [wx, wy, wz] of corners) {
                curbPositions[spi++] = wx;
                curbPositions[spi++] = wy;
                curbPositions[spi++] = wz;
            }
            curbUvs[sui++] = uBack; curbUvs[sui++] = 0;
            curbUvs[sui++] = uFront; curbUvs[sui++] = 0;
            curbUvs[sui++] = uFront; curbUvs[sui++] = 1;
            curbUvs[sui++] = uBack; curbUvs[sui++] = 1;
            curbIndices[sii++] = svBase + 0;
            curbIndices[sii++] = svBase + 1;
            curbIndices[sii++] = svBase + 2;
            curbIndices[sii++] = svBase + 0;
            curbIndices[sii++] = svBase + 2;
            curbIndices[sii++] = svBase + 3;
            svBase += 4;
        }
    }
    const curbGeom = new THREE.BufferGeometry();
    curbGeom.setAttribute('position', new THREE.BufferAttribute(curbPositions, 3));
    curbGeom.setAttribute('uv', new THREE.BufferAttribute(curbUvs, 2));
    curbGeom.setIndex(new THREE.BufferAttribute(curbIndices, 1));
    curbGeom.computeVertexNormals();
    curbGeom.computeBoundingSphere();
    const curbMesh = new THREE.Mesh(curbGeom, getFlatCurbMaterial());
    curbMesh.name = `TramTrackbedFlatCurbs${nameSuffix}`;
    curbMesh.userData.widthM = TRACKBED_FLAT_CURB_W;
    curbMesh.userData.trackbedHalfWidthM = Math.max(
        ...curbSegments.flatMap(segment => [
            segment.startTrackbedHalfWidthM,
            segment.endTrackbedHalfWidthM,
        ]),
    );
    curbMesh.renderOrder = TRACKBED_FLAT_CURB_RENDER_ORDER;
    curbMesh.receiveShadow = true;
    if (!cullable) curbMesh.frustumCulled = false;
    g.add(curbMesh);
    }
    phase('curbs');
    };
    }

    const structuralSegments = segments.filter(isPotentialRoadCarriedTramFeature);
    // Fixed rail and ordinary street-running tram are the citywide bulk. Both
    // are rendered by one persistent cell lifecycle, so a road or terrain
    // revision rebuilds only changed 600 m cells. The global chord solve above
    // already fixed cross-feature joins and junction lifts; sharing cells also
    // preserves a complete junction fan where the two kinds meet. Structural
    // road-carried trams keep their small replaceable sibling batch because
    // their paired-corridor ownership and road-deck refresh are separate.
    candidate.cellRenderedSegments = segments.filter(
        segment => !isPotentialRoadCarriedTramFeature(segment),
    );
    if (structuralSegments.length > 0) {
        const structuralGroup = new THREE.Group();
        structuralGroup.name = 'StructuralTramTrackGeometry';
        addRenderedTrackSegmentMeshes(
            structuralGroup,
            structuralSegments,
            name => phase(`structural:${name}`),
            'Structural',
        );
        g.add(structuralGroup);
    }

    const uncoveredSwitchMarkers = buildUncoveredSwitchMarkers(
        driverGraph,
        switchRules,
        routedSegments,
        anchorLat,
        anchorLon,
        maxRadiusM,
        centerX,
        centerZ,
    );
    if (uncoveredSwitchMarkers) g.add(uncoveredSwitchMarkers);
    phase('markers');

    return candidate;
}

// A road-deck revision changes only the height of structurally tagged tram
// chords. Re-sample those few source features and replace their sibling batch;
// the ordinary citywide rails, formation structures, stations, and markers stay
// untouched. On Most mladosti this changes the invalidation from ~1,400 chords
// plus a citywide weld to roughly fifteen carried-tram chords.
function rebuildRoadCarriedTramMeshes(centerX, centerZ) {
    if (!group || !lastFeatures || !lastRoadVerticalAlignments
        || !lastFeatures.some(isPotentialRoadCarriedTramFeature)) return false;
    discardPendingEmbeddedTramMeshRefresh();
    pendingEmbeddedTramMeshRefresh = { centerX, centerZ, kind: 'structural',
        roadFormation: lastRoadFormation, roadRevision: Number(lastRoadFormation?.revision) || 0 };
    return true;
}

function* prepareRoadCarriedTramMeshSteps(pending, options) {
    const structuralFeatures = lastFeatures.filter(isPotentialRoadCarriedTramFeature);
    const next = yield* computeRailTrackbedSegmentsResumable(structuralFeatures,
        lastAnchorLat, lastAnchorLon, lastMaxRadiusM, {
            centerX: pending.centerX, centerZ: pending.centerZ,
            terrain: options.ground.terrain, railFormation: options.ground.railFormation,
            roadFormation: options.ground.roadFormation, roadVerticalAlignments: options.ground.verticalAlignments,
            roadSupportCacheSource: options.ground.roadSupportCacheSource, proposalMask: options.ground.proposalMask,
            photoTrackFrame: lastPhotoTrackFrame, rampOpenCutVolumes: lastRampOpenCutVolumes,
        });
    if (!options.isCurrent() || next.terrainEvidenceIncomplete) return false;
    const previous = new Map(options.sourceSegments.filter(isPotentialRoadCarriedTramFeature).map(s => [s.sortKey, s]));
    for (const segment of next) {
        const old = previous.get(segment.sortKey);
        if (old) for (const key of ['startJoinX', 'startJoinZ', 'endJoinX', 'endJoinZ']) segment[key] = old[key];
        yield { phase: 'rail-structural-joins' };
    }
    const structural = yield* prepareRailSegmentOwnershipSteps(next);
    const compiled = yield* prepareRailCellGeometrySteps(null, { segments: structural,
        junctionIncidents: junctionIncidentsFromSegments(structural) }, null, options.isCurrent);
    if (!compiled) return false;
    if (!options.isCurrent()) { if (compiled.root) enqueueRailRetirement(compiled.root); return false; }
    if (compiled.root) compiled.root.name = 'StructuralTramTrackGeometry';
    pending.candidate = { segments: [...options.sourceSegments.filter(s => !isPotentialRoadCarriedTramFeature(s)), ...structural],
        cellRenderedSegments: options.cellSegments, centerX: pending.centerX, centerZ: pending.centerZ,
        structuralReplacement: true, structuralGroup: compiled.root };
    try {
        return yield* publishRailCandidateSteps(pending.candidate, {
            ground: options.ground, isCurrent: options.isCurrent, cellKeys: new Set() });
    } finally {
        if (!pending.candidate.committed && compiled.root) enqueueRailRetirement(compiled.root);
    }
}

// Ordinary street-running tram rails consume the streamed road formation only
// for their Y coordinates. Re-sample that subset, then feed it back into the
// persistent rail-cell set. Cell signatures rebuild only affected 600 m chunks
// while fixed rail, civil works, stations and markers remain untouched.
function rebuildEmbeddedTramMeshes(centerX, centerZ, options) {
    return (function* rebuildEmbeddedTramMeshSteps() {
        if (!group || !lastFeatures || !lastRoadFormation) return false;
        const roadFormation = options.ground.roadFormation;
        const changedBounds = Array.isArray(options?.changedBounds)
            ? options.changedBounds
            : null;
        const x = finiteOrNull(centerX) ?? lastRenderCenterX;
        const z = finiteOrNull(centerZ) ?? lastRenderCenterZ;
        const previousEmbedded = options.sourceSegments
            .filter(isOrdinaryOsmTramFeature);
        if (previousEmbedded.length === 0) return false;
        const affectedEmbedded = Array.isArray(changedBounds)
            ? railSegmentsIntersectingBounds(
                previousEmbedded,
                changedBounds,
                EMBEDDED_TRAM_MAX_LATERAL_M,
            )
            : previousEmbedded;
        if (affectedEmbedded.length === 0) return false;
        yield { phase: 'select' };

        const resampledEmbedded = yield* resampleEmbeddedTramRoadSegmentHeightsSteps(
            roadFormation,
            affectedEmbedded,
            { preserveEndpointOffsets: true, segmentsPerYield: 8,
                supportCacheSource: options.ground.roadSupportCacheSource },
        );
        const previousEmbeddedBySortKey = new Map(
            affectedEmbedded.map(segment => [segment.sortKey, segment]),
        );
        let changedSegmentCount = 0;
        const nextAffectedEmbedded = [];
        const supportUpdates = [];
        for (let index = 0; index < resampledEmbedded.length; index += 1) {
            const segment = resampledEmbedded[index];
            const previous = previousEmbeddedBySortKey.get(segment.sortKey);
            // Reuse exact no-ops so the render-cell signature cache stays hot.
            if (previous
                && previous.yStart === segment.yStart
                && previous.yEnd === segment.yEnd) {
                // Published chords stay untouched while a successor yields.
                // Advance only their derived memo after preparation completes.
                supportUpdates.push([previous, segment._embeddedRoadSupport]);
                nextAffectedEmbedded.push(previous);
            } else {
                changedSegmentCount += 1;
                nextAffectedEmbedded.push(segment);
            }
            if ((index + 1) % 64 === 0) yield { phase: 'compare' };
        }
        if (changedSegmentCount === 0) {
            for (const [segment, support] of supportUpdates) segment._embeddedRoadSupport = support;
            return false;
        }

        const replacements = new Map();
        for (let index = 0; index < nextAffectedEmbedded.length; index += 1) {
            const segment = nextAffectedEmbedded[index];
            replacements.set(segment.sortKey, segment);
            if ((index + 1) % 128 === 0) yield { phase: 'replacement-index' };
        }
        const replaceAffected = segment => (
            isOrdinaryOsmTramFeature(segment)
                ? (replacements.get(segment.sortKey) || segment)
                : segment
        );
        const nextPublishedSegments = [];
        for (let index = 0; index < options.sourceSegments.length; index += 1) {
            nextPublishedSegments.push(replaceAffected(options.sourceSegments[index]));
            if ((index + 1) % 256 === 0) yield { phase: 'publication-array' };
        }
        const nextCellSegments = [];
        for (let index = 0; index < options.cellSegments.length; index += 1) {
            nextCellSegments.push(replaceAffected(options.cellSegments[index]));
            if ((index + 1) % 256 === 0) yield { phase: 'cell-array' };
        }

        const candidate = { segments: nextPublishedSegments, cellRenderedSegments: nextCellSegments,
            centerX: x, centerZ: z };
        options.onCandidate?.(candidate);
        return yield* publishRailCandidateSteps(candidate, { ground: options.ground,
            isCurrent: options.isCurrent,
            cellKeys: changedRailSegmentRenderCellKeys(affectedEmbedded, nextAffectedEmbedded) });

    }());
}

function scheduleEmbeddedTramMeshRefresh(centerX, centerZ, changedBounds) {
    discardPendingEmbeddedTramMeshRefresh();
    if (!group || !lastFeatures || !lastRoadFormation) return false;
    pendingEmbeddedTramMeshRefresh = {
        centerX, centerZ, changedBounds,
        roadFormation: lastRoadFormation,
        roadRevision: Number(lastRoadFormation.revision) || 0,
    };
    return true;
}

function restartEmbeddedTramMeshRefresh(pending) {
    // The source cursor may already acknowledge this attempt. Carry its
    // original bounds forward together with changes that arrived meanwhile.
    const changes = pending.roadFormation === lastRoadFormation
        ? lastRoadFormation?.getChangesSince?.(pending.roadRevision)
        : null;
    const bounds = Array.isArray(pending.changedBounds) && changes?.full === false
        ? [...pending.changedBounds, ...changes.bounds] : null;
    return pending.kind === 'structural' ? rebuildRoadCarriedTramMeshes(pending.centerX, pending.centerZ)
        : scheduleEmbeddedTramMeshRefresh(pending.centerX, pending.centerZ, bounds);
}

function discardPendingEmbeddedTramMeshRefresh() {
    const pending = pendingEmbeddedTramMeshRefresh;
    pending?.groundBuild?.return?.();
    pending?.iterator?.return?.();
    pending?.ground?.release();
    if (pending) pending.groundBuild = pending.iterator = pending.ground = null;
    pendingEmbeddedTramMeshRefresh = null;
}

function stepPendingEmbeddedTramMeshRefresh() {
    const pending = pendingEmbeddedTramMeshRefresh;
    if (!pending) return false;
    if (pending.candidate?.committed) { discardPendingEmbeddedTramMeshRefresh(); return true; }
    if (pending.failure) {
        const capacityReleased = pending.failure.code === 'terrain-publication-capacity'
            && typeof lastTerrain?.readReleaseRevision === 'number'
            && pending.readReleaseRevision !== lastTerrain.readReleaseRevision;
        if (pending.failure.isCurrent() && !capacityReleased) return false;
        return restartEmbeddedTramMeshRefresh(pending);
    }
    if (pending.ground && !pending.captureInputsCurrent()) {
        return restartEmbeddedTramMeshRefresh(pending);
    }
    const startedMs = performance.now();
    let outcome;
    try {
        if (!pending.ground) {
            pending.groundBuild ||= captureRailVisualGroundSteps(pending, 'rail-embedded-tram');
            const next = pending.groundBuild.next();
            if (next.done) {
                pending.groundBuild = null;
                pending.ground = next.value;
                if (!pending.ground) return restartEmbeddedTramMeshRefresh(pending);
                const groundCurrent = pending.captureInputsCurrent;
                const sourceSegments = lastSampledTrackbedSegments, cellSegments = lastCellRenderedSegments;
                const revision = sampledTrackbedRevision, parent = group;
                pending.captureInputsCurrent = () => groundCurrent() && parent === group
                    && revision === sampledTrackbedRevision && sourceSegments === lastSampledTrackbedSegments
                    && cellSegments === lastCellRenderedSegments;
                const options = { changedBounds: pending.changedBounds, ground: pending.ground,
                    sourceSegments, cellSegments, isCurrent: pending.captureInputsCurrent,
                    onCandidate: candidate => { pending.candidate = candidate; } };
                pending.iterator = pending.kind === 'structural'
                    ? prepareRoadCarriedTramMeshSteps(pending, options)
                    : rebuildEmbeddedTramMeshes(pending.centerX, pending.centerZ, options);
            }
            outcome = { done: false, value: { phase: 'capture' } };
        } else {
            outcome = pending.iterator.next();
        }
    } catch (error) {
        const isCurrent = pending.captureInputsCurrent;
        discardPendingEmbeddedTramMeshRefresh();
        pending.failure = { code: error.code || 'rail-embedded-build', message: String(error.message || error), isCurrent };
        pending.readReleaseRevision = lastTerrain?.readReleaseRevision;
        pendingEmbeddedTramMeshRefresh = pending;
        throw error;
    }
    const elapsedMs = performance.now() - startedMs;
    const phase = outcome.done ? 'complete' : outcome.value?.phase || 'stage';
    recordLayerFrameMs(`rails:embeddedRoad:${phase}`, elapsedMs);
    recordLayerFrameMs('rails:embeddedRoad', elapsedMs);
    if (outcome.done) discardPendingEmbeddedTramMeshRefresh();
    return true;
}

// A road surface can disqualify one viaduct-pier station, but it cannot change
// rail chords, formation walls, station flares, or tunnel geometry. Stage only
// the persistent structures batch, upload its detached buffers through the
// shared delivery queue, and keep the previous complete batch visible until an
// atomic swap. Publishing the whole replacement directly from onFrame made the
// next visible render upload every buffer together (35-51 ms on the Split cab).
function scheduleRailStructuresRefresh(reason) {
    if (!group || !lastRailFormation) return false;
    const structuresKey = railStructuresBuildKey(
        lastRailFormation,
        lastStationFlares,
        lastRenderCenterX,
        lastRenderCenterZ,
        lastMaxRadiusM,
        lastRailPillarRoadSignature,
    );
    const current = pendingRailStructuresRefresh;
    if (current
        && current.reason === reason
        && current.structuresKey === structuresKey
        && current.mappedSeaRevision === mappedSeaStructuresRevision) {
        return true;
    }
    discardPendingRailStructuresRefresh();
    const structuresGroup = new THREE.Group();
    structuresGroup.name = 'RailStructures';
    pendingRailStructuresRefresh = {
        reason,
        sessionToken: railSessionToken,
        parent: group,
        railFormation: lastRailFormation,
        terrain: lastTerrain,
        terrainRevision: Number(lastTerrain?.revision) || 0,
        stationFlares: lastStationFlares,
        centerX: lastRenderCenterX,
        centerZ: lastRenderCenterZ,
        maxRadiusM: lastMaxRadiusM,
        structuresKey,
        mappedSeaRevision: mappedSeaStructuresRevision,
        structuresGroup,
        stage: 'viaducts',
    };
    return true;
}

function railStructuresRefreshIsCurrent(refresh) {
    if (!refresh || pendingRailStructuresRefresh !== refresh) return false;
    if (refresh.sessionToken !== railSessionToken
        || refresh.parent !== group
        || refresh.railFormation !== lastRailFormation
        || refresh.terrain !== lastTerrain
        || refresh.terrainRevision !== (Number(lastTerrain?.revision) || 0)
        || refresh.stationFlares !== lastStationFlares
        || refresh.mappedSeaRevision !== mappedSeaStructuresRevision) {
        return false;
    }
    return refresh.structuresKey === railStructuresBuildKey(
        lastRailFormation,
        lastStationFlares,
        lastRenderCenterX,
        lastRenderCenterZ,
        lastMaxRadiusM,
        lastRailPillarRoadSignature,
    );
}

function stepRailStructuresPreparation(refresh) {
    if (refresh.uploadError) throw refresh.uploadError;
    if (!refresh.ground) {
        refresh.groundBuild ||= captureRailVisualGroundSteps(refresh, 'rail-structures');
        const next = refresh.groundBuild.next();
        if (next.done) {
            refresh.groundBuild = null;
            refresh.ground = next.value;
            if (!refresh.ground) restartRailStructuresRefresh(refresh);
        }
        return false;
    }
    const started = railStreamNowMs();
    if (refresh.stage === 'viaducts') {
        addRailViaducts(
            refresh.structuresGroup,
            refresh.ground.railFormation,
            refresh.ground.terrain,
            refresh.centerX,
            refresh.centerZ,
            refresh.maxRadiusM,
            refresh.ground.roadFormation,
            refresh.ground.mappedWater,
        );
        refresh.stage = 'tunnels';
        recordLayerFrameMs(
            `rails:${refresh.reason}:viaducts`,
            railStreamNowMs() - started,
        );
        return false;
    }
    if (refresh.stage === 'tunnels') {
        addRailTunnels(
            refresh.structuresGroup,
            refresh.ground.railFormation,
            refresh.stationFlares,
            refresh.centerX,
            refresh.centerZ,
            refresh.maxRadiusM,
        );
        annotateRailInspectionLayers(refresh.structuresGroup);
        refresh.prewarm = createRailGpuPrewarm(
            refresh.structuresGroup,
            `rail-${refresh.reason}-gpu-prewarm`,
        );
        enqueueRailGpuUploadStage(refresh, {
            iteratorProperty: 'prewarm',
            jobProperty: 'prewarmJob',
            readyProperty: 'gpuReady',
            failedProperty: 'prewarmFailed',
            label: `rail-${refresh.reason}-gpu-prewarm`,
            isCurrent: () => pendingRailStructuresRefresh === refresh,
        });
        refresh.stage = 'prewarm';
        recordLayerFrameMs(
            `rails:${refresh.reason}:tunnels`,
            railStreamNowMs() - started,
        );
        return false;
    }
    return refresh.gpuReady === true;
}

function restartRailStructuresRefresh(refresh) {
    discardPendingRailStructuresRefresh();
    return scheduleRailStructuresRefresh(refresh.reason);
}

function stepPendingRailStructuresRefresh() {
    const refresh = pendingRailStructuresRefresh;
    if (!refresh) return false;
    if (refresh.failure) {
        const capacityReleased = refresh.failure.code === 'terrain-publication-capacity'
            && typeof lastTerrain?.readReleaseRevision === 'number'
            && refresh.readReleaseRevision !== lastTerrain.readReleaseRevision;
        if (refresh.failure.isCurrent() && !capacityReleased) return false;
        return restartRailStructuresRefresh(refresh);
    }
    if (!railStructuresRefreshIsCurrent(refresh) || (refresh.ground && !refresh.ground.isCurrent())) {
        return restartRailStructuresRefresh(refresh);
    }
    try {
        if (!stepRailStructuresPreparation(refresh)) return true;
    } catch (error) {
        const isCurrent = refresh.captureInputsCurrent;
        discardPendingRailStructuresRefresh();
        refresh.failure = { code: error.code || 'rail-structures-build', message: String(error.message || error), isCurrent };
        refresh.readReleaseRevision = lastTerrain?.readReleaseRevision;
        pendingRailStructuresRefresh = refresh;
        throw error;
    }
    if (!railStructuresRefreshIsCurrent(refresh) || !refresh.ground.isCurrent()) {
        return restartRailStructuresRefresh(refresh);
    }
    const started = railStreamNowMs();
    const previousStructures = railStructuresGroup;
    refresh.parent.add(refresh.structuresGroup);
    if (previousStructures?.parent) previousStructures.parent.remove(previousStructures);
    railStructuresGroup = refresh.structuresGroup;
    railStructuresKey = refresh.structuresKey;
    refresh.ground.release();
    refresh.ground = null;
    pendingRailStructuresRefresh = null;
    if (previousStructures) enqueueRailRetirement(previousStructures);
    recordLayerFrameMs(
        `rails:${refresh.reason}:swap`,
        railStreamNowMs() - started,
    );
    return true;
}

function scheduleRailStructuresForRoadSurface() {
    return scheduleRailStructuresRefresh('pillarRoad');
}

function scheduleRailStructuresForMappedSea() {
    return scheduleRailStructuresRefresh('mappedSea');
}

// Rebuild ONLY what crossing ownership can change: at-grade roads suppress a
// near-zero wall trough, while road-under-rail structures open the rail
// embankment walls/collar around their authored void.
//
// The suppression sets flags on profile.internalSegments, and exactly two
// builders read them: the retaining walls and the terrain collar. Rebuilding the
// whole rails group for that was the largest remaining stutter in the world —
// 170-185 ms in one frame, several times a ride, because a ride keeps streaming
// roads and every newly discovered crossing earned another full rebuild.
//
// The reduced rebuild also prepares its profiles, triangles and collision boxes
// cooperatively. A queue around either whole builder still produced measured
// 53–137 ms items; yields inside those loops let the shared scheduler bound work.
function rebuildCrossingSuppressedFormationMeshes(centerX, centerZ) {
    if (!group || !lastRailFormation) return false;
    discardPendingCrossingFormationRefresh();
    const x = finiteOrNull(centerX) ?? lastRenderCenterX;
    const z = finiteOrNull(centerZ) ?? lastRenderCenterZ;
    const replacement = new THREE.Group();
    replacement.name = 'RailCrossingFormationReplacement';
    pendingCrossingFormationRefresh = {
        inputs: railBoundaryInputs(),
        replacement,
        parent: group,
        centerX: x,
        centerZ: z,
        maxRadiusM: lastMaxRadiusM,
        stage: 'dressing',
    };
    return true;
}

function railFormationDressingChunkMeshes(rootObject, baseName) {
    const matches = [];
    rootObject?.traverse?.((object) => {
        if (object?.name === baseName || object?.name?.startsWith(`${baseName}:`)) {
            matches.push(object);
        }
    });
    return matches;
}

function stepRailCrossingPreparation(refresh) {
    if (refresh.uploadError) throw refresh.uploadError;
    if (refresh.dressingError) throw refresh.dressingError;
    if (refresh.publicationComplete && !refresh.candidate?.committed) {
        restartRailCrossingRefresh(refresh); return false;
    }
    if (!refresh.ground) {
        refresh.groundBuild ||= prepareRailBoundaryGroundSteps(refresh);
        const next = refresh.groundBuild.next();
        if (next.done) {
            refresh.groundBuild = null;
            refresh.ground = next.value;
            if (!refresh.ground) restartRailCrossingRefresh(refresh);
        }
        return false;
    }
    if (refresh.noGeometryChange) {
        enqueueRailBoundaryPublication(refresh);
        return refresh.candidate?.committed === true;
    }
    const startedMs = performance.now();
    if (refresh.stage === 'dressing') {
        if (!refresh.dressingCpuReady) {
            enqueueRailDressingPreparation(refresh, refresh.replacement, {
                maxRadiusM: refresh.maxRadiusM, readyProperty: 'dressingCpuReady',
                isCurrent: () => pendingCrossingFormationRefresh === refresh,
            });
            return false;
        }
        refresh.prewarm = createRailGpuPrewarm(refresh.replacement, 'rail-crossing-gpu-prewarm');
        enqueueRailGpuUploadStage(refresh, {
            iteratorProperty: 'prewarm', jobProperty: 'prewarmJob', readyProperty: 'gpuReady',
            label: 'rail-crossing-gpu-prewarm',
            isCurrent: () => pendingCrossingFormationRefresh === refresh,
        });
        refresh.stage = 'prewarm';
        recordLayerFrameMs('rails:wallMeshes:prewarmQueue', performance.now() - startedMs);
        return false;
    }
    if (!refresh.gpuReady) return false;
    enqueueRailBoundaryPublication(refresh);
    return refresh.candidate?.committed === true;
}

// Even a no-op flag pass acknowledges its input revisions at the same shared
// boundary. It needs no replacement mesh, query index or physics reservation.
function* publishRailBoundaryAcknowledgementSteps(refresh, entry, isCurrent) {
    const ticket = surfacePublications.begin({ key: 'rails:boundary-inputs:0', generation: ++railCellBuildToken });
    const batch = surfacePublications.prepareBatch([{ ...entry, ticket }]);
    let boundary = null, result = null, failure = null;
    try {
        if (batch.state !== 'staged') return false;
        while (isCurrent() && !boundary) {
            boundary = groundPublications.enqueue(batch, { onPublished() { refresh.candidate.committed = true; } });
            if (!boundary) yield { phase: 'rail-boundary-ack-slot', deferFrame: true };
        }
        if (!boundary) return false;
        boundary.promise.then(value => { result = value; }, error => { failure = error; });
        while (!result && !failure) yield { phase: 'rail-boundary-ack-publish', deferFrame: true };
        if (failure) throw failure;
        return refresh.candidate.committed === true;
    } finally {
        if (!refresh.candidate.committed) {
            boundary?.cancel('rail-boundary-ack-superseded');
            if (batch.state === 'staged') batch.discard('rail-boundary-ack-superseded');
        }
    }
}

function enqueueRailBoundaryPublication(refresh) {
    if (refresh.publicationJob || refresh.publicationSteps || refresh.publicationComplete) return;
    const current = () => pendingCrossingFormationRefresh === refresh && refresh.parent === group && refresh.ground.isCurrent();
    const entry = prepareRailBoundaryAcknowledgement(refresh);
    refresh.candidate = { centerX: refresh.centerX, centerZ: refresh.centerZ,
        segments: lastSampledTrackbedSegments, cellRenderedSegments: lastCellRenderedSegments,
        dressingReplacement: !refresh.noGeometryChange, dressingGroup: refresh.replacement };
    const steps = refresh.noGeometryChange ? publishRailBoundaryAcknowledgementSteps(refresh, entry, current)
        : publishRailCandidateSteps(refresh.candidate, { ground: refresh.ground, isCurrent: current,
            formationPublication: refresh.formationPublication, cellKeys: new Set(), additionalEntries: [entry] });
    enqueueRailPublicationSteps(refresh, steps);
}

function restartRailCrossingRefresh(refresh) {
    return rebuildCrossingSuppressedFormationMeshes(refresh.centerX, refresh.centerZ);
}

function stepCrossingSuppressedFormationMeshes() {
    const refresh = pendingCrossingFormationRefresh;
    if (!refresh) return false;
    if (refresh.candidate?.committed) {
        refresh.publicationSteps?.return?.(); refresh.publicationSteps = null;
        refresh.ground?.release(); refresh.ground = null;
        pendingCrossingFormationRefresh = null;
        return true;
    }
    if (!group || !lastRailFormation) {
        discardPendingCrossingFormationRefresh();
        return false;
    }
    if (refresh.failure) {
        const capacityReleased = refresh.failure.code === 'terrain-publication-capacity'
            && typeof lastTerrain?.readReleaseRevision === 'number'
            && refresh.readReleaseRevision !== lastTerrain.readReleaseRevision;
        if (refresh.failure.isCurrent() && !capacityReleased) return false;
        return restartRailCrossingRefresh(refresh);
    }
    if (refresh.parent !== group || (refresh.ground && !refresh.ground.isCurrent())) {
        return restartRailCrossingRefresh(refresh);
    }
    try {
        if (!stepRailCrossingPreparation(refresh)) return true;
    } catch (error) {
        const isCurrent = refresh.captureInputsCurrent;
        discardPendingCrossingFormationRefresh();
        refresh.failure = { code: error.code || 'rail-crossing-build', message: String(error.message || error), isCurrent };
        refresh.readReleaseRevision = lastTerrain?.readReleaseRevision;
        pendingCrossingFormationRefresh = refresh;
        throw error;
    }
    if (refresh.parent !== group || !refresh.ground.isCurrent()) {
        return restartRailCrossingRefresh(refresh);
    }
    return false;
}

// Walk mode reads the rails group for its explicit collider boxes (bore walls,
// cut retaining walls). The group is rebuilt on travel; the collider cache
// re-signatures on its uuid/child count, so it follows automatically.
export function getRailsGroupForWalkColliders() {
    return group;
}

function railStreamNowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function markStreamedRailSetChanged(tileKey = null) {
    const now = railStreamNowMs();
    if (tileKey != null) streamedRailChangedTileKeys.add(String(tileKey));
    streamedRailInputRevision += 1;
    if (!streamedRailDirty) streamedRailDirtySinceMs = now;
    streamedRailDirty = true;
    streamedRailLastChangeMs = now;
    streamedRailRetryAfterMs = 0;
    if (groundManaged) groundCoordinator.invalidate('rails', { keys: tileKey == null ? [] : [String(tileKey)] });
}

function ensurePillarClearanceForFormation(features) {
    if (pillarClearanceReady || pillarClearanceLoading
        || !(lastRailFormation?.getViaductRuns?.() || []).length) return;
    const mySessionToken = railSessionToken;
    pillarClearanceLoading = true;
    ensureRoadIndex().then(() => {
        if (mySessionToken !== railSessionToken) return;
        lastPillarClearance = createPillarClearanceEvaluator(
            lastAnchorLat,
            lastAnchorLon,
            features || [],
        );
        pillarClearanceReady = true;
        pillarClearanceLoading = false;
        rebuildVisibleRails(lastRenderCenterX, lastRenderCenterZ);
    }).catch(() => {
        if (mySessionToken === railSessionToken) pillarClearanceLoading = false;
    });
}

function createRailFormationModel(features, {
    terrainChangedBounds = null,
    deferredBuild = false,
    terrainRead = null,
    previousModel = lastRailFormation,
    stops: suppliedStops = lastStops,
    anchorLat = lastAnchorLat,
    anchorLon = lastAnchorLon,
    photoTrackFrame = lastPhotoTrackFrame,
} = {}) {
    if (!terrainRead && !lastTerrainSource) return null;
    if (terrainRead && (!Object.isFrozen(terrainRead)
        || !['station3d-terrain-read-snapshot-v1', 'station3d-ground-read-snapshot-v1'].includes(terrainRead.contract)
        || typeof terrainRead.evidenceSceneYAtLocal !== 'function'
        || typeof terrainRead.absoluteToSceneY !== 'function')) {
        throw new TypeError('Rail formation requires a captured candidate terrain read');
    }
    const terrain = terrainRead ? retainReadSnapshot(terrainRead, 'rail-formation-build')
        : captureGroundReadSnapshot(lastTerrainSource, 'rail-formation-build');
    // Stop records, like decoded terrain buffers, are immutable source data.
    // Capture membership so a later feed/session replacement cannot alter a
    // deferred station-access build or its assembly reuse key.
    const stops = (suppliedStops || []).slice();
    try {
        return new RailFormationModel({
            readInputs: terrain,
            assemblyReuse: {
                previousModel,
                terrainChangedBounds,
                contextKey: JSON.stringify(stops),
            },
            anchorLat,
            anchorLon,
            features: features || [],
            // A visual terrain fallback prevents void; it is not elevation
            // evidence. Long OSM ways routinely extend beyond the moving DGU
            // window, so only sampled terrain may steer their vertical grade.
            baseSceneYAtLocal: (x, z) => terrain.evidenceSceneYAtLocal(x, z),
            absoluteSceneYAtHeight: heightM => terrain.absoluteToSceneY(heightM),
            halfWidthForFeature: feature => getRailFormationHalfWidthMeters(
                feature?.properties || {},
            ),
            surfaceHalfWidthForFeature: feature => (
                getRenderedRailTrackbedHalfWidthAtSpacingMeters(
                    feature?.properties || {},
                )
            ),
            // In the model-terrain world, inferred OSM rail is an engineered
            // cut/fill and must daylight its uphill edge just like an authored
            // alignment. A photo frame means the visible reality mesh owns the
            // near-ground shape, so widening a synthetic trench there is wrong.
            crossSlopeBenchForInferred: !photoTrackFrame,
            stationAccessPlanner: ({ alignment, anchorLat, anchorLon, baseSceneYAtLocal }) => (
                buildPlannerSurfaceCutStationAccessPlans({
                    stops,
                    alignment,
                    anchorLat,
                    anchorLon,
                    baseSceneYAtLocal,
                })
            ),
            deferredBuild,
        });
    } finally {
        terrain.release?.();
    }
}

function installRailCivilGroundSnapshot(model, snapshot) {
    pendingPublishedRailCivilGroundSnapshot?.iterator?.return?.();
    publishedRailCivilGroundSnapshot = snapshot || EMPTY_RAIL_CIVIL_GROUND_SNAPSHOT;
    publishedRailCivilGroundSnapshotModel = model || null;
    publishedRailCivilGroundSnapshotRevision = Number(model?.revision) || -1;
    publishedRailCivilGroundSnapshotMutation =
        Number(model?.civilGroundMutationRevision) || 0;
    pendingPublishedRailCivilGroundSnapshot = null;
}

function resetRailCivilGroundSnapshot() {
    pendingPublishedRailCivilGroundSnapshot?.iterator?.return?.();
    publishedRailCivilGroundSnapshot = EMPTY_RAIL_CIVIL_GROUND_SNAPSHOT;
    publishedRailCivilGroundSnapshotModel = null;
    publishedRailCivilGroundSnapshotRevision = -1;
    publishedRailCivilGroundSnapshotMutation = -1;
    pendingPublishedRailCivilGroundSnapshot = null;
}

function stepPublishedRailCivilGroundSnapshot() {
    const model = lastRailFormation;
    if (!model) {
        if (publishedRailCivilGroundSnapshotModel) resetRailCivilGroundSnapshot();
        return false;
    }
    const revision = Number(model.revision) || 0;
    const mutation = Number(model.civilGroundMutationRevision) || 0;
    if (publishedRailCivilGroundSnapshotModel === model
        && publishedRailCivilGroundSnapshotRevision === revision
        && publishedRailCivilGroundSnapshotMutation === mutation) return false;
    if (!pendingPublishedRailCivilGroundSnapshot
        || pendingPublishedRailCivilGroundSnapshot.model !== model
        || pendingPublishedRailCivilGroundSnapshot.revision !== revision
        || pendingPublishedRailCivilGroundSnapshot.mutation !== mutation) {
        pendingPublishedRailCivilGroundSnapshot?.iterator?.return?.();
        pendingPublishedRailCivilGroundSnapshot = {
            model,
            revision,
            mutation,
            iterator: railCivilGroundDependencySnapshotSteps(
                model,
                RAIL_CIVIL_GROUND_SNAPSHOT_PADDING_M,
            ),
        };
    }
    const pending = pendingPublishedRailCivilGroundSnapshot;
    const startedMs = railStreamNowMs();
    const outcome = pending.iterator.next();
    recordLayerFrameMs(
        `rails:civilGroundSnapshot:${outcome.value?.phase || 'finalize'}`,
        railStreamNowMs() - startedMs,
    );
    if (!outcome.done) return true;
    if (lastRailFormation === model
        && (Number(model.revision) || 0) === revision
        && (Number(model.civilGroundMutationRevision) || 0) === mutation) {
        installRailCivilGroundSnapshot(model, outcome.value);
    } else {
        pendingPublishedRailCivilGroundSnapshot = null;
    }
    return true;
}

// Prepare model/civil-query state before changing the shared authority. This
// entry can join the receiver/cell/mask/physics group; finalization owns only
// acknowledgement and retirement, so a later member can roll the model back.
function prepareRailFormationPublication(model, features, {
    recordBuildTimings = true, revisionPrepared = false, civilGroundSnapshot = null, owner = null,
} = {}) {
    const previous = lastRailFormation, terrain = lastTerrain, context = streamedRailSessionContext;
    const session = railSessionToken;
    const previousRevision = previous?.revision, previousMutation = previous?.civilGroundMutationRevision;
    const previousTerrainModel = terrain?.railFormation;
    const previousContextModel = context?.railFormation;
    const next = model?.revision ? model : null;
    if (next && next !== previous && !revisionPrepared) next.revision = ++railFormationRevision;
    const nextRevision = next?.revision, nextMutation = next?.civilGroundMutationRevision;
    const snapshot = next ? civilGroundSnapshot || railCivilGroundDependencySnapshot(next,
        RAIL_CIVIL_GROUND_SNAPSHOT_PADDING_M) : EMPTY_RAIL_CIVIL_GROUND_SNAPSHOT;
    const oldCivil = { snapshot: publishedRailCivilGroundSnapshot,
        model: publishedRailCivilGroundSnapshotModel, revision: publishedRailCivilGroundSnapshotRevision,
        mutation: publishedRailCivilGroundSnapshotMutation, pending: pendingPublishedRailCivilGroundSnapshot };
    const oldVisual = pendingRailVisualRefresh, oldStructures = pendingRailStructuresRefresh;
    const oldCrossing = pendingCrossingFormationRefresh, oldEmbedded = pendingEmbeddedTramMeshRefresh;
    let committed = false, settled = false;
    const ownStateCurrent = () => railSessionToken === session && lastRailFormation === previous
        && lastTerrain === terrain && streamedRailSessionContext === context;
    const entry = { clear: true,
        isCurrent: () => !committed && !settled && ownStateCurrent()
            && previous?.revision === previousRevision && previous?.civilGroundMutationRevision === previousMutation
            && next?.revision === nextRevision && next?.civilGroundMutationRevision === nextMutation
            && publishedRailCivilGroundSnapshot === oldCivil.snapshot,
        commit() {
            // All dependencies were checked before the first group mutation.
            // Only this adapter's own pointer state is guarded during the swap.
            if (committed || settled || !ownStateCurrent()) return false;
            committed = true;
            lastRailFormation = next;
            publishedRailCivilGroundSnapshot = snapshot;
            publishedRailCivilGroundSnapshotModel = next;
            publishedRailCivilGroundSnapshotRevision = Number(next?.revision) || -1;
            publishedRailCivilGroundSnapshotMutation = next ? Number(next.civilGroundMutationRevision) || 0 : -1;
            pendingPublishedRailCivilGroundSnapshot = null;
            if (context) context.railFormation = next;
            terrain?.setRailFormation?.(next);
            return true;
        },
        rollback() {
            if (!committed || settled) return;
            lastRailFormation = previous;
            publishedRailCivilGroundSnapshot = oldCivil.snapshot;
            publishedRailCivilGroundSnapshotModel = oldCivil.model;
            publishedRailCivilGroundSnapshotRevision = oldCivil.revision;
            publishedRailCivilGroundSnapshotMutation = oldCivil.mutation;
            pendingPublishedRailCivilGroundSnapshot = oldCivil.pending;
            if (context) context.railFormation = previousContextModel;
            terrain?.setRailFormation?.(previousTerrainModel);
            committed = false;
        },
        discard() {
            if (settled || committed) return;
            settled = true;
            if (model !== previous) model?.dispose?.();
        },
    };
    return { entry, model: next, civilGroundSnapshot: snapshot, discard: entry.discard,
        get state() { return settled ? (committed ? 'published' : 'discarded') : committed ? 'committed' : 'prepared'; },
        finalize() {
            if (!committed || settled) return false;
            settled = true;
            oldCivil.pending?.iterator?.return?.();
            if (previous !== next) {
                // Cancel only producers captured from the previous authority.
                // A coordinator may already have prepared a new visual owner.
                if (oldVisual !== owner && pendingRailVisualRefresh === oldVisual) discardPendingRailVisualRefresh();
                if (oldStructures !== owner && pendingRailStructuresRefresh === oldStructures) discardPendingRailStructuresRefresh();
                if (oldCrossing !== owner && pendingCrossingFormationRefresh === oldCrossing) discardPendingCrossingFormationRefresh();
                if (oldEmbedded !== owner && pendingEmbeddedTramMeshRefresh === oldEmbedded) discardPendingEmbeddedTramMeshRefresh();
                previous?.dispose?.();
            }
            if (model !== next) model?.dispose?.();
            ensurePillarClearanceForFormation(features);
            if (recordBuildTimings) for (const [stage, ms] of Object.entries(next?.buildTimings || {})) {
                // Feature/reuse counters share the report, but are not durations.
                if (stage.endsWith('Ms')) recordLayerFrameMs(`rails:formation:${stage}`, ms);
            }
            return true;
        },
    };
}

function publishRailFormation(model, features, options = {}) {
    const publication = prepareRailFormationPublication(model, features, options);
    if (!publication.entry.isCurrent() || !publication.entry.commit()) {
        publication.discard(); return lastRailFormation;
    }
    publication.finalize();
    return lastRailFormation;
}

// terrainChangedBounds: formation rebuilds now enter through the cooperative
// pending-build path below; keep this boundary between publication and build
// diagnostics explicit for the isolated publication contract tests.
// Kept out of the per-frame overlay: the model already measures every build
// stage, and the performance harness can read the completed report after the
// timing window without adding observer work to the frame that stuttered.
export function getRailFormationBuildReport() {
    if (!lastRailFormation) return null;
    return {
        revision: lastRailFormation.revision,
        alignments: lastRailFormation.alignments?.length || 0,
        segments: lastRailFormation.segments?.length || 0,
        profiles: lastRailFormation.profiles?.length || 0,
        viaductRuns: lastRailFormation.viaductRuns?.length || 0,
        tunnelRuns: lastRailFormation.tunnelRuns?.length || 0,
        renderCenter: Object.freeze({ x: lastRenderCenterX, z: lastRenderCenterZ }),
        buildTimings: { ...(lastRailFormation.buildTimings || {}) },
    };
}

// The road source also carries Zagreb's street-running tram geometry. For a
// bounded campaign level, "all road tiles arrived" is therefore not enough:
// the derived rail formation, embedded-track road coupling, support index and
// render-cell successor must all have reached one complete generation. This is
// deliberately stronger than ordinary moving-world readiness.
export function isRailSurfacePreloadSettled(preload) {
    const points = Array.isArray(preload?.points) ? preload.points : [];
    if (streamedRailSource) {
        for (const point of points) {
            if (!streamedRailSource.isLoadedAtLocal(point?.x, point?.z)) return false;
        }
    }
    return streamedRailDirty !== true
        && terrainRevisionDirty !== true
        && mappedSeaStructuresDirty !== true
        && !pendingRailFormationBuild
        && !pendingRailVisualRefresh
        && !pendingRailStructuresRefresh
        && !pendingCrossingFormationRefresh
        && !pendingEmbeddedTramMeshRefresh
        && pillarClearanceLoading !== true
        && lastRoadFormation?.hasPendingBuild?.() !== true;
}

if (typeof window !== 'undefined') {
    window.__s3dRailFormationBuildReport = () => getRailFormationBuildReport();
    // Which condition of isRailSurfacePreloadSettled() is holding a campaign
    // drive gate open. The gate is one boolean over a dozen inputs, so a level
    // that never becomes ready says nothing about why; diagnosing one cost a
    // whole bake run.
    window.__s3dRailPreloadGate = (preload = null) => ({
        corridorLoaded: !streamedRailSource || !Array.isArray(preload?.points)
            || preload.points.every(point => streamedRailSource.isLoadedAtLocal(point?.x, point?.z)),
        streamedRailDirty,
        terrainRevisionDirty,
        mappedSeaStructuresDirty,
        pendingRailFormationBuild: !!pendingRailFormationBuild,
        railFormationFailure: pendingRailFormationBuild?.failure || null,
        pendingRailVisualRefresh: pendingRailVisualRefresh?.reason ?? null,
        railVisualFailure: pendingRailVisualRefresh?.failure ? {
            code: pendingRailVisualRefresh.failure.code, message: pendingRailVisualRefresh.failure.message,
        } : null,
        pendingRailStructuresRefresh: !!pendingRailStructuresRefresh,
        railStructuresFailure: pendingRailStructuresRefresh?.failure ? {
            code: pendingRailStructuresRefresh.failure.code, message: pendingRailStructuresRefresh.failure.message,
        } : null,
        pendingCrossingFormationRefresh: !!pendingCrossingFormationRefresh,
        railCrossingFailure: pendingCrossingFormationRefresh?.failure ? {
            code: pendingCrossingFormationRefresh.failure.code, message: pendingCrossingFormationRefresh.failure.message,
        } : null,
        pendingEmbeddedTramMeshRefresh: !!pendingEmbeddedTramMeshRefresh,
        railEmbeddedFailure: pendingEmbeddedTramMeshRefresh?.failure ? {
            code: pendingEmbeddedTramMeshRefresh.failure.code, message: pendingEmbeddedTramMeshRefresh.failure.message,
        } : null,
        railPublicationPending: !!pendingRailVisualRefresh?.publicationSteps,
        railPublicationPhase: pendingRailVisualRefresh?.publicationPhase || null,
        pillarClearanceLoading,
        roadFormationPendingBuild: lastRoadFormation?.hasPendingBuild?.() === true,
    });
}

function resolveCurrentStreamedRailFeatures(terrain = lastTerrainSource, onSourceSet = null) {
    const steps = resolveCurrentStreamedRailFeaturesSteps(terrain, onSourceSet);
    let next;
    do { next = steps.next(); } while (!next.done);
    return next.value;
}

function* resolveCurrentStreamedRailFeaturesSteps(terrain = lastTerrainSource, onSourceSet = null) {
    const key = { session: railSessionToken, inputRevision: streamedRailInputRevision,
        tiles: streamedRailTileFeatures, supplied: streamedRailBaseFeatures, mode: streamedRailProfileMode,
        terrainSource: lastTerrainSource, terrainRevision: Number(terrain?.revision) || 0,
        terrainContract: terrain?.contract || null, hasTerrain: !!terrain };
    if (resolvedStreamedRailSource && Object.keys(key).every(name => resolvedStreamedRailSource.key[name] === key[name])) {
        onSourceSet?.(resolvedStreamedRailSource.streamed);
        return resolvedStreamedRailSource.features;
    }
    const streamed = streamedRailTileFeatures
        ? mergeStreamedRailFeatureTiles(streamedRailTileFeatures)
        : [];
    onSourceSet?.(streamed);
    // Match tram-sim's rendering path: the source OSM LineStrings receive the
    // same light corner smoothing before rails and trackbed are swept. Resolve
    // from these RAW inputs every time; re-resolving lastFeatures would apply a
    // terrain-clearance correction repeatedly after DGU detail revisions.
    yield { phase: 'rail-source:merge' };
    const smoothedStreamed = smoothRailTrackFeatures(streamed);
    yield { phase: 'rail-source:smoothing' };
    const features = yield* resolveStreamedRailSessionFeaturesSteps({
        suppliedFeatures: streamedRailBaseFeatures,
        streamedOsmFeatures: smoothedStreamed,
        mode: streamedRailProfileMode,
        terrainReference: terrain,
    });
    // Retain derived features without retaining a captured terrain reader.
    if (key.session === railSessionToken && key.inputRevision === streamedRailInputRevision
        && key.terrainSource === lastTerrainSource) resolvedStreamedRailSource = { key, streamed, features };
    return features;
}

function resolveStandaloneRailFeatures(features, terrain) {
    const steps = resolveStandaloneRailFeaturesSteps(features, terrain);
    let next;
    do { next = steps.next(); } while (!next.done);
    return next.value;
}

function* resolveStandaloneRailFeaturesSteps(features, terrain) {
    const source = Array.isArray(features) ? features : [];
    const solved = source.filter(isSolvedRailFeature);
    if (solved.length === 0) return source;
    return yield* resolveRailProfileFeaturesSteps({
        osmFeatures: source.filter(feature => !isSolvedRailFeature(feature)),
        solvedFeatures: solved,
        mode: 'solved',
        terrainReference: terrain,
    });
}

function replaceStreamedRailFeatures(centerX, centerZ) {
    if (!streamedRailTileFeatures) return false;
    const streamed = mergeStreamedRailFeatureTiles(streamedRailTileFeatures);
    const signature = streamedRailFeatureSetSignature(streamed);
    if (signature === streamedRailAppliedSignature) {
        streamedRailDirty = false;
        streamedRailDirtySinceMs = 0;
        streamedRailRetryAfterMs = 0;
        streamedRailChangedTileKeys.clear();
        return false;
    }

    const features = resolveCurrentStreamedRailFeatures();
    // A streamed set can contain the complete city rail network. Building its
    // vertical formation synchronously was the remaining 115-270 ms rail hook.
    // Stage the immutable candidate cooperatively and keep the previous complete
    // formation + render generation authoritative until publication finishes.
    createPendingRailFormationBuild(features, {
        fullRefresh: false,
        changeBounds: [],
        centerX: Number(centerX) || 0,
        centerZ: Number(centerZ) || 0,
        canResampleSolvedChords: false,
        reason: 'streamed',
        signature,
    });
    return true;
}

// Whether a terrain change can have reached anything the in-flight formation
// build samples: the published geometry, or the unpublished features' own
// chords, which the published test cannot see before the first publication.
// Without a local frame to test in, assume it did — that is the old behaviour.
function terrainBoundsTouchPendingRailBuild(changeBounds) {
    if (railTerrainChangeImpact(changeBounds).any) return true;
    const build = pendingRailFormationBuild;
    if (typeof build?.model?.toLocal !== 'function') return true;
    return boundsIntersectAnyRailSegment(
        railFeatureChords(build.features, (lon, lat) => build.model.toLocal(lon, lat)),
        changeBounds,
        RAIL_TERRAIN_REFRESH_PAD_M,
    );
}

// Everything rails renders that samples terrain, tested against the change
// rects: solved chords (trackbed, bars, curbs, fans), formation profiles
// (collars, walls, aprons), and viaduct/tunnel runs (piers reach the ground).
// Rect-vs-rect reuses the chord test — a chord's AABB IS the rect. Returns
// separately whether structures (viaduct/tunnel runs) were touched, so the
// persistent structures group is only invalidated when its pier/portal ground
// actually changed.
const RAIL_TERRAIN_REFRESH_PAD_M = RAIL_WALL_WINDOW_PADDING_M;
function railTerrainChangeImpact(changeBounds) {
    const runChords = (runs) => {
        for (const run of runs || []) {
            const samples = run?.samples || [];
            for (let index = 1; index < samples.length; index += 1) {
                if (boundsIntersectAnyRailSegment([{
                    x1: samples[index - 1].x,
                    z1: samples[index - 1].z,
                    x2: samples[index].x,
                    z2: samples[index].z,
                }], changeBounds, RAIL_TERRAIN_REFRESH_PAD_M)) return true;
            }
        }
        return false;
    };
    const structures = runChords(lastRailFormation?.getViaductRuns?.())
        || runChords(lastRailFormation?.getTunnelRuns?.());
    if (structures) return { any: true, structures: true };
    if (lastSampledTrackbedSegments.terrainEvidenceIncomplete === true) {
        // The last publication deliberately omitted unready cell owners. A
        // terrain event can complete one of those omitted chords, which is not
        // present in the sampled array and therefore cannot intersect the
        // event bounds below. Retry the full solve until every cell is ready.
        return { any: true, structures: false };
    }
    if (boundsIntersectAnyRailSegment(
        lastSampledTrackbedSegments,
        changeBounds,
        RAIL_TERRAIN_REFRESH_PAD_M,
    )) return { any: true, structures: false };
    const rectHit = (b) => !!b && boundsIntersectAnyRailSegment(
        [{ x1: b.minX, z1: b.minZ, x2: b.maxX, z2: b.maxZ }],
        changeBounds,
        RAIL_TERRAIN_REFRESH_PAD_M,
    );
    for (const profile of lastRailFormation?.getSurfaceProfiles?.() || []) {
        if (rectHit(profile?.overlapBounds || profile?.terrainCutoutBounds
            || profile?.outerBounds || profile?.bounds)) {
            return { any: true, structures: false };
        }
    }
    return { any: false, structures: false };
}

// Every input the viaduct/tunnel builders consume. Terrain under the runs is
// deliberately absent — the terrain-refresh path clears the key explicitly
// when its change bounds touch a run.
function railStructuresBuildKey(
    railFormation,
    stationFlares,
    centerX,
    centerZ,
    maxRadiusM,
    pillarRoadSignature = null,
    mappedWater = null,
) {
    const parts = [
        String(centerX), String(centerZ), String(maxRadiusM),
        String(lastBridgeStyleLocationId), String(lastBridgeStyleCityId),
        pillarClearanceReady ? '1' : '0',
        isPhotoWorld() ? '1' : '0',
        String(photoStationStructureRevision),
        String(mappedWater?.signature ?? mappedSeaStructuresRevision),
        String(pillarRoadSignature
            ?? railPillarRoadSurfaceSignature(railFormation, lastRoadFormation)
            ?? ''),
        JSON.stringify(stationFlares ?? null),
    ];
    const pushRuns = (runs, tag) => {
        for (const run of runs || []) {
            parts.push(
                tag,
                String(run.startStation), String(run.endStation), String(run.lengthM),
                String(run.portalStartHasTerrainOpening ?? ''),
                String(run.portalEndHasTerrainOpening ?? ''),
            );
            for (const sample of run.samples || []) {
                parts.push(String(sample.x), String(sample.z), String(sample.railY));
            }
        }
    };
    pushRuns(railFormation?.getViaductRuns?.(), 'v');
    pushRuns(railFormation?.getTunnelRuns?.(), 't');
    return parts.join('');
}

function createRailBuildPhaseTimer() {
    let lastMs = performance.now();
    return (name) => {
        const nowMs = performance.now();
        recordLayerFrameMs(`rails:build:${name}`, nowMs - lastMs);
        lastMs = nowMs;
    };
}

function createRailRenderCellGroup(cellKey) {
    const cellGroup = new THREE.Group();
    cellGroup.name = `RailRenderCell:${cellKey}`;
    cellGroup.userData.railCellKey = cellKey;
    return cellGroup;
}

function createRailGpuPrewarm(root, label = 'rail-gpu-prewarm') {
    return prewarmDetachedObject(root, {
        renderer,
        camera,
        targetScene: scene,
        // KHR_parallel_shader_compile lets the driver finish material programs
        // while the previous generation remains visible. A synchronous compile
        // deferred its real wait until the first 1x1 draw (158–434 ms cold).
        asyncShaders: true,
        label,
        uploadBatch: 8,
        maxUploadBytes: 256 * 1024,
    });
}

function stepRailGpuPrewarm(iterator) {
    const startedMs = performance.now();
    const outcome = iterator.next();
    const phase = String(outcome.value?.phase || 'complete');
    const shortPhase = phase.startsWith('rail-') ? phase : `rail-gpu-prewarm:${phase}`;
    recordLayerFrameMs(`rails:${shortPhase}`, performance.now() - startedMs);
    return outcome;
}

function cancelRailGpuPrewarm(iterator) {
    // A suspended detached prewarm may already own its 1x1 WebGLRenderTarget.
    // Dropping the iterator without closing it skips the generator's finally
    // block and leaks the target's renderer textures across sessions.
    iterator?.return?.();
}

function cancelRailCellNormalSmoothing(iterator) {
    iterator?.return?.();
}

function ensureRailGpuUploadQueue() {
    if (!railGpuUploadQueue) {
        railGpuUploadQueue = createFrameChunkQueue({
            label: 'rail-gpu-upload',
            frameBudgetMs: 1,
            preferAnimationFrame: true,
            workClass: 'delivery',
            pauseDuringMovement: false,
            trackWorldReady: false,
        });
    }
    return railGpuUploadQueue;
}

function ensureRailDressingQueue() {
    if (!railDressingQueue) railDressingQueue = createFrameChunkQueue({
        label: 'rail-dressing', frameBudgetMs: 1,
        preferAnimationFrame: true, workClass: 'near', workTier: 'surface',
        pauseDuringMovement: false, trackWorldReady: false,
    });
    return railDressingQueue;
}

function cancelRailDressingPreparation(refresh) {
    if (!refresh) return;
    if (refresh.dressingBuildJob) railDressingQueue?.cancel(refresh.dressingBuildJob);
    else refresh.dressingBuild?.return?.();
    refresh.dressingBuildJob = null;
    refresh.dressingBuild = null;
    refresh.dressingBuildSession = null;
}

function advanceRailDressingIterator(refresh, iterator) {
    const started = performance.now();
    let next;
    try {
        // One bounded visit for both standalone visuals and coordinated ground.
        for (let count = 0; count < 64; count++) {
            next = iterator.next();
            refresh.dressingPhase = next.value?.phase || 'complete';
            if (next.done || performance.now() - started >= .25) break;
        }
        return next;
    } finally {
        recordLayerFrameMs('rails:terrainDressing:prepare', performance.now() - started);
    }
}

function enqueueRailDressingPreparation(refresh, target, {
    maxRadiusM, readyProperty,
    isCurrent = refresh.isCurrent || (() => pendingRailVisualRefresh === refresh),
}) {
    if (refresh.dressingBuildJob || refresh[readyProperty]) return;
    if (!refresh.dressingBuild) {
        refresh.dressingBuild = createRailFormationDressingSteps(target, refresh.ground.railFormation,
            refresh.centerX, refresh.centerZ, maxRadiusM);
        refresh.dressingBuildSession = railSessionToken;
    }
    const session = refresh.dressingBuildSession;
    const current = () => railSessionToken === session && isCurrent() && refresh.ground.isCurrent();
    const iterator = refresh.dressingBuild;
    if (refresh.coordinatedDressing) {
        // This CPU work belongs to the ground compiler's existing slice. A
        // child queue made the coordinator poll every frame while a second
        // allowance throttled its dependency and hid its CPU cost as waiting.
        if (!current()) { cancelRailDressingPreparation(refresh); return; }
        if (advanceRailDressingIterator(refresh, iterator).done) {
            refresh.dressingBuild = null;
            refresh.dressingBuildSession = null;
            if (current()) refresh[readyProperty] = true;
        }
        return;
    }
    let job = null;
    const settle = completed => {
        if (refresh.dressingBuildJob === job) refresh.dressingBuildJob = null;
        if (refresh.dressingBuild === iterator) {
            refresh.dressingBuild = null;
            refresh.dressingBuildSession = null;
        }
        if (completed && current()) refresh[readyProperty] = true;
        else iterator.return();
    };
    job = ensureRailDressingQueue().enqueue([iterator], steps => {
        if (!current()) { steps.return(); return undefined; }
        const next = advanceRailDressingIterator(refresh, steps);
        return next.done ? undefined : FRAME_CHUNK_REPEAT_ITEM;
    }, {
        describeItem: () => refresh.dressingPhase || 'queued',
        onComplete: () => settle(true), onCancel: () => settle(false),
        onError: error => { if (isCurrent()) refresh.dressingError = error; settle(false); },
    });
    refresh.dressingBuildJob = job;
}

function ensureRailRetirementQueue() {
    if (!railRetirementQueue) {
        railRetirementQueue = createFrameChunkQueue({
            label: 'rail-retire',
            frameBudgetMs: 1,
            preferAnimationFrame: true,
            workClass: 'delivery',
            pauseDuringMovement: false,
            trackWorldReady: false,
        });
    }
    return railRetirementQueue;
}

function finishRailRetirement(item) {
    if (!item?.iterator) return;
    let outcome = item.iterator.next();
    while (!outcome.done) outcome = item.iterator.next();
    item.iterator = null;
}

function enqueueRailRetirement(root) {
    if (!root) return null;
    root.removeFromParent();
    const item = {
        iterator: disposeGroupCooperatively(root),
        phase: 'queued',
    };
    return ensureRailRetirementQueue().enqueue([item], (candidate) => {
        const outcome = candidate.iterator.next();
        candidate.phase = String(outcome.value?.phase || 'complete');
        if (outcome.done) {
            candidate.iterator = null;
            return undefined;
        }
        return FRAME_CHUNK_REPEAT_ITEM;
    }, {
        maxItemsPerFrame: 64,
        describeItem: candidate => `rail generation ${candidate.phase}`,
        // Teardown is allowed to finish synchronously; abandoning a suspended
        // iterator would leak whatever resources its remaining subtree owns.
        onCancel: () => finishRailRetirement(item),
        onError: () => finishRailRetirement(item),
    });
}

function cancelRailGpuUploadStage(refresh, {
    iteratorProperty,
    jobProperty,
} = {}) {
    if (!refresh) return;
    const job = refresh[jobProperty];
    if (job) ensureRailGpuUploadQueue().cancel(job);
    else cancelRailGpuPrewarm(refresh[iteratorProperty]);
    refresh[jobProperty] = null;
    refresh[iteratorProperty] = null;
}

function enqueueRailGpuUploadStage(refresh, {
    iteratorProperty,
    jobProperty,
    readyProperty,
    failedProperty = null,
    label,
    isCurrent = refresh.isCurrent || (() => pendingRailVisualRefresh === refresh),
} = {}) {
    if (!refresh?.[iteratorProperty] || refresh[jobProperty]) return;
    const iterator = refresh[iteratorProperty];
    let lastPhase = `${label}:queued`;
    let job = null;
    const settle = ({ completed = false, failed = false } = {}) => {
        if (refresh[jobProperty] === job) refresh[jobProperty] = null;
        if (refresh[iteratorProperty] === iterator) refresh[iteratorProperty] = null;
        if (completed && isCurrent()) {
            refresh[readyProperty] = true;
        } else {
            cancelRailGpuPrewarm(iterator);
            if (failed && failedProperty && isCurrent()) refresh[failedProperty] = true;
        }
    };
    job = ensureRailGpuUploadQueue().enqueue([iterator], (candidate) => {
        const outcome = stepRailGpuPrewarm(candidate);
        lastPhase = String(outcome.value?.phase || `${label}:complete`);
        return outcome.done ? undefined : FRAME_CHUNK_REPEAT_ITEM;
    }, {
        maxItemsPerFrame: 1,
        describeItem: () => lastPhase,
        onComplete: () => settle({ completed: true }),
        onCancel: () => settle(),
        onError: error => {
            if (isCurrent()) refresh.uploadError = error;
            settle({ failed: true });
        },
    });
    refresh[jobProperty] = job;
}

function ensureRailCellQueue() {
    if (!railCellQueue) {
        railCellQueue = createFrameChunkQueue({
            label: 'rail-cells',
            frameBudgetMs: 4,
            preferAnimationFrame: true,
            workClass: 'near',
            workTier: 'surface',
            // Cell builds must progress during a ride — arriving terrain and
            // streamed tiles dirty cells exactly while the cab is moving.
            pauseDuringMovement: false,
        });
    }
    return railCellQueue;
}

// Prepare a complete cell off-scene. Every mesh batch and normal/upload step
// remains on FrameChunkQueue; no cell may publish from this compiler.
function* prepareRailCellGeometrySteps(cellKey, cell, generation, isCurrent) {
    const root = cellKey === null ? new THREE.Group() : createRailRenderCellGroup(cellKey);
    let normals = null, prewarm = null, handedOff = false;
    const measure = (label, callback) => {
        const started = performance.now();
        try { return callback(); }
        finally { recordLayerFrameMs(`rails:cells:${label}`, performance.now() - started); }
    };
    try {
        const batches = yield* railRenderSegmentBatchesSteps(cell.segments, { isCurrent });
        if (!batches) return null;
        for (let index = 0; index < batches.length; index++) {
            if (!isCurrent()) return null;
            measure('geometry', () => addRenderedTrackSegmentMeshes(root, batches[index],
                () => {}, `Batch${index}`, { cullable: true,
                    junctionIncidents: new Map(), computeRailNormals: false }));
            yield { phase: 'rail-cell-geometry' };
        }
        normals = smoothRailHeadNormalsSteps(root.children
            .filter(child => child.name.startsWith('TramRailBars')).map(child => child.geometry).filter(Boolean));
        while (isCurrent()) {
            const next = measure('normals', () => normals.next());
            if (next.done) { normals = null; break; }
            yield { phase: 'rail-cell-normals' };
        }
        if (!isCurrent()) return null;
        const empty = cell.segments.length === 0;
        const stages = empty ? [{}, { stencilPrepass: true }]
            : [{ heavyRail: false }, { heavyRail: true }, { stencilPrepass: true }];
        for (const options of stages) {
            if (!isCurrent()) return null;
            measure('junctions', () => addJunctionPatchMeshes(root, cell.junctionIncidents, '', { cullable: true, ...options }));
            yield { phase: 'rail-cell-junctions' };
        }
        if (!isCurrent()) return null;
        if (!root.children.length) return { root: null };
        annotateRailInspectionLayers(root, cellKey === null ? {} : { replacementKey: railCellPublicationKey(cellKey), generation });
        prewarm = createRailGpuPrewarm(root, 'rail-cell-gpu-prewarm');
        let frame = -1;
        while (isCurrent() && prewarm) {
            const sequence = getFrameChunkSequence();
            if (sequence === frame) { yield { phase: 'rail-cell-gpu-frame', deferFrame: true }; continue; }
            const next = stepRailGpuPrewarm(prewarm);
            if (next.done) { prewarm = null; break; }
            if (next.value?.deferFrame) frame = sequence;
            yield next.value;
        }
        if (!isCurrent()) return null;
        handedOff = true;
        return { root };
    } finally {
        cancelRailCellNormalSmoothing(normals);
        cancelRailGpuPrewarm(prewarm);
        if (!handedOff) enqueueRailRetirement(root);
    }
}

// One rail generation owns its visible cells, sampled heights, walk support,
// exact terrain footprint and affected GTA families. All allocation/index work
// precedes the shared boundary; rollback restores the exact former pointers.
function* prepareRailCandidatePublicationSteps(candidate, {
    ground, isCurrent, replaceRoot = false, formationPublication = null,
    features = lastFeatures, cellKeys = null, additionalEntries = [], preparePhysics = true, maxCells = null,
} = {}) {
    if (!surfacePublications || !groundPublications) throw new Error('Rails require the shared ground publication boundary');
    const parent = group, session = railSessionToken, generation = ++railCellBuildToken;
    const previousSegments = lastSampledTrackbedSegments, previousCells = lastCellRenderedSegments;
    const previousSupport = railTrackbedSupportIndex, previousRevision = sampledTrackbedRevision;
    const sampledChanged = candidate.segments !== previousSegments || candidate.cellRenderedSegments !== previousCells;
    const nextSampledRevision = previousRevision + (sampledChanged ? 1 : 0);
    const previousContext = railCellContextKey, nextContext = `photo:${isPhotoWorld() ? 1 : 0}`;
    const oldFeatures = lastFeatures, oldTrafficRevision = activeRailTrafficRevision;
    const context = streamedRailSessionContext, oldContextFeatures = context?.otherTracks;
    const oldStructures = railStructuresGroup, oldStructuresKey = railStructuresKey;
    const previousState = { x: lastRenderCenterX, z: lastRenderCenterZ, flares: lastStationFlares,
        spacing: lastTrackSpacingStationFlares, dirty: terrainRevisionDirty,
        deck: lastRoadCarriedTramDeckSignature, embedded: lastEmbeddedTramRoadRevision,
        pendingEmbedded: pendingEmbeddedTramRoadRevision, pillar: lastRailPillarRoadSignature };
    const previousStructural = candidate.structuralReplacement
        ? parent?.getObjectByName('StructuralTramTrackGeometry') || null : null;
    const dressingParent = candidate.dressingReplacement ? parent?.getObjectByName('RailFormationDressing') || parent : null;
    const previousDressing = dressingParent ? ['RailFormationRetainingWalls', 'RailFormationTerrainCollar']
        .flatMap(name => railFormationDressingChunkMeshes(dressingParent, name)).map(root => ({ root, parent: root.parent })) : [];
    const nextDressing = candidate.dressingReplacement ? [...candidate.dressingGroup.children] : [];
    const physicsSession = preparePhysics ? getGroundPhysics?.() || null : null;
    const families = replaceRoot || candidate.dressingReplacement ? ['rail-trackbed', 'rail-formation-dressings'] : ['rail-trackbed'];
    const region = physicsSession?.captureGroundPublicationRegion(families) || null;
    const current = () => !discarded && !committed && isCurrent() && session === railSessionToken && parent === group
        && previousSegments === lastSampledTrackbedSegments && previousRevision === sampledTrackbedRevision
        && oldFeatures === lastFeatures && (!formationPublication || formationPublication.entry.isCurrent())
        && (!preparePhysics || (getGroundPhysics?.() || null) === physicsSession
            && (region ? region.isCurrent() : !physicsSession?.captureGroundPublicationRegion(families)));
    const entries = [], preparedRoots = [];
    let coverage = null, physics = null;
    let committed = false, finalized = false, discarded = false, handedOff = false;
    const discard = () => {
        if (finalized || committed || discarded) return;
        discarded = true;
        physics?.entry.discard(); coverage?.discard();
        for (const entry of entries) if (entry.ticket?.state === 'pending') entry.ticket.discard();
        for (const root of preparedRoots.splice(0)) enqueueRailRetirement(root);
    };
    try {
        if (!current()) return false;
        const protectedKeys = candidate.incompleteCellKeys || new Set();
        const selection = nextContext === previousContext ? cellKeys : null;
        const cells = yield* partitionRailSegmentsIntoCellsSteps(candidate.cellRenderedSegments, undefined, selection, { isCurrent: current });
        if (!cells) return false;
        const nextRegions = new Map();
        for (const [key, value] of railCellSurfaceRegionsState) {
            nextRegions.set(key, value);
            yield { phase: 'rail-cell-retained-coverage' };
            if (!current()) return false;
        }
        const keys = selection ? [...selection] : [...new Set([...railCellSignaturesState.keys(), ...cells.keys()])];
        if (maxCells !== null && (!Number.isSafeInteger(maxCells) || maxCells <= 0 || keys.length > maxCells)) {
            throw new RangeError('Rail receiver cell capacity exceeded');
        }
        keys.sort((a, b) => {
            const ca = railRenderCellCenter(a), cb = railRenderCellCenter(b);
            return Math.hypot(ca.x - candidate.centerX, ca.z - candidate.centerZ)
                - Math.hypot(cb.x - candidate.centerX, cb.z - candidate.centerZ);
        });
        for (const key of keys) {
            if (!current()) return false;
            if (protectedKeys.has(key)) continue;
            const cell = cells.get(key), signature = cell ? railRenderCellSignature(cell) : '';
            if (nextContext === previousContext && signature === (railCellSignaturesState.get(key) || '')) continue;
            yield { phase: 'rail-cell-signature' };
            const compiled = cell ? yield* prepareRailCellGeometrySteps(key, cell, generation, current) : { root: null };
            if (!compiled) return false;
            const root = compiled.root;
            if (root) preparedRoots.push(root);
            const regions = root ? renderedRailCellSurfaceRegions(cell, candidate.cellRenderedSegments) : null;
            if (regions) nextRegions.set(key, regions); else nextRegions.delete(key);
            const old = railCellStateSnapshot(key);
            const ticket = surfacePublications.begin({ key: railCellPublicationKey(key), generation,
                parent: railCellsRoot, retire: (_context, retiring) => enqueueRailRetirement(retiring) });
            entries.push({ ticket, ...(root ? { root } : { clear: true }), isCurrent: current,
                commit() {
                    if (root) { railCellGroupsState.set(key, root); railCellSurfaceRegionsState.set(key, regions);
                        railCellSignaturesState.set(key, signature); }
                    else { railCellGroupsState.delete(key); railCellSurfaceRegionsState.delete(key); railCellSignaturesState.delete(key); }
                    return true;
                }, rollback: () => restoreRailCellState(key, old), discard() { root?.removeFromParent(); },
            });
            yield { phase: 'rail-cell-entry' };
        }
        let support = previousSupport;
        if (sampledChanged) {
            const supportSteps = buildRailTrackbedSupportIndexResumable(candidate.segments, { surfaceYOffsetM: TRACKBED_Y });
            try {
                support = null;
                while (current()) {
                    const next = supportSteps.next();
                    if (next.done) { support = next.value; break; }
                    yield { phase: 'rail-support-index' };
                }
            } finally { supportSteps.return(); }
        }
        if (!support || !current()) return false;
        coverage = yield* prepareRenderedRailSurfaceCoverageSteps(nextRegions, {
            ground, railSource: formationPublication?.model || lastRailFormation, isCurrent: current });
        if (!coverage || !current()) return false;
        if (region) {
            physics = yield* region.prepareSteps({
                'rail-trackbed': { snapshot: { segments: candidate.segments, revision: nextSampledRevision } },
                'rail-formation-dressings': { formation: ground.railFormation,
                    formationSource: formationPublication?.model || lastRailFormation,
                    sourceRevision: ground.railFormation?.revision || 0 },
            }, current, (label, callback) => {
                const started = performance.now();
                try { return callback(); } finally { recordLayerFrameMs(`rails:${label}`, performance.now() - started); }
            });
            if (!physics || !current()) return false;
        }
        const deck = roadCarriedTramDeckSignature(ground.verticalAlignments, candidate.segments);
        const pillar = railPillarRoadSurfaceSignature(ground.railFormation, ground.roadFormation);
        const embedded = ground.roadFormation ? Number(ground.roadFormation.revision) || 0 : -1;
        if (replaceRoot) annotateRailInspectionLayers(candidate.root);
        if (formationPublication) entries.push({ ...formationPublication.entry, discard() {},
            ticket: surfacePublications.begin({ key: 'rails:formation', generation }) });
        for (let i = 0; i < additionalEntries.length; i++) entries.push({ ...additionalEntries[i],
            ticket: surfacePublications.begin({ key: `rails:boundary-inputs:${i}`, generation }) });
        entries.push({ ...coverage.entry, ticket: surfacePublications.begin({ key: 'rails:coverage', generation }) });
        entries.push({ ticket: surfacePublications.begin({ key: 'rails:support', generation }), clear: true,
            isCurrent: () => current() && (!physics || physics.entry.isCurrent()),
            commit() {
                // Source currency was checked for the entire group before any
                // member moved. Do not reject the model member's own promotion.
                committed = true;
                if (replaceRoot) {
                    candidate.root.add(railCellsRoot);
                    if (candidate.structuresGroup) candidate.root.add(candidate.structuresGroup);
                    scene.add(candidate.root); parent?.removeFromParent(); group = candidate.root;
                    railStructuresGroup = candidate.structuresGroup; railStructuresKey = candidate.structuresKey;
                    lastRenderCenterX = candidate.centerX; lastRenderCenterZ = candidate.centerZ;
                    lastStationFlares = candidate.stationFlares; lastTrackSpacingStationFlares = candidate.trackSpacingStationFlares;
                    terrainRevisionDirty = false;
                    lastFeatures = features;
                    if (features !== oldFeatures) { activeRailTrafficRevision++; if (context) context.otherTracks = features; }
                }
                if (candidate.structuralReplacement) {
                    previousStructural?.removeFromParent();
                    if (candidate.structuralGroup) parent.add(candidate.structuralGroup);
                }
                if (candidate.dressingReplacement) {
                    for (const { root } of previousDressing) root.removeFromParent();
                    for (const root of nextDressing) dressingParent.add(root);
                }
                lastSampledTrackbedSegments = candidate.segments; sampledTrackbedRevision = nextSampledRevision;
                lastCellRenderedSegments = candidate.cellRenderedSegments; railTrackbedSupportIndex = support;
                railCellContextKey = nextContext;
                lastRoadCarriedTramDeckSignature = deck;
                lastEmbeddedTramRoadRevision = pendingEmbeddedTramRoadRevision = embedded;
                lastRailPillarRoadSignature = pillar;
                return physics?.entry.commit() ?? true;
            },
            rollback() {
                if (!committed) return;
                physics?.entry.rollback();
                if (replaceRoot) {
                    candidate.root.removeFromParent();
                    if (parent) { parent.add(railCellsRoot); scene.add(parent); }
                    else railCellsRoot.removeFromParent();
                    if (oldStructures && oldStructures === candidate.structuresGroup) parent?.add(oldStructures);
                    group = parent; railStructuresGroup = oldStructures; railStructuresKey = oldStructuresKey;
                    lastRenderCenterX = previousState.x; lastRenderCenterZ = previousState.z;
                    lastStationFlares = previousState.flares; lastTrackSpacingStationFlares = previousState.spacing;
                    terrainRevisionDirty = previousState.dirty; lastFeatures = oldFeatures; activeRailTrafficRevision = oldTrafficRevision;
                    if (context) context.otherTracks = oldContextFeatures;
                }
                if (candidate.structuralReplacement) {
                    candidate.structuralGroup?.removeFromParent(); if (previousStructural) parent.add(previousStructural);
                }
                if (candidate.dressingReplacement) {
                    for (const root of nextDressing) candidate.dressingGroup.add(root);
                    for (const { root, parent: oldParent } of previousDressing) oldParent.add(root);
                }
                lastSampledTrackbedSegments = previousSegments; sampledTrackbedRevision = previousRevision;
                lastCellRenderedSegments = previousCells; railTrackbedSupportIndex = previousSupport;
                railCellContextKey = previousContext; lastRoadCarriedTramDeckSignature = previousState.deck;
                lastEmbeddedTramRoadRevision = previousState.embedded; pendingEmbeddedTramRoadRevision = previousState.pendingEmbedded;
                lastRailPillarRoadSignature = previousState.pillar; committed = false;
            }, discard,
        });
        handedOff = true;
        return { entries, isCurrent: current, discard,
            formationRead: ground.railFormation,
            renderedRailSurface: coverage.read,
            railTrackbedRead: Object.freeze({ snapshot: Object.freeze({ segments: candidate.segments, revision: nextSampledRevision }) }),
            railFormationDressingRead: Object.freeze({ formation: ground.railFormation,
                formationSource: formationPublication?.model || lastRailFormation,
                sourceRevision: ground.railFormation?.revision || 0 }),
            finalize() {
                if (!committed || finalized || discarded) return false;
                finalized = true; candidate.committed = true;
                physics?.finalize(); coverage.finalize(); formationPublication?.finalize();
                if (replaceRoot && parent && parent !== candidate.root) enqueueRailRetirement(parent);
                if (previousStructural) enqueueRailRetirement(previousStructural);
                for (const { root } of previousDressing) enqueueRailRetirement(root);
                preparedRoots.length = 0;
                return true;
            } };
    } finally { if (!handedOff) discard(); }
}

function* publishRailCandidateSteps(candidate, options = {}) {
    let prepared = null, batch = null, boundary = null, result = null, error = null, published = false;
    try {
        prepared = yield* prepareRailCandidatePublicationSteps(candidate, options);
        if (!prepared) return false;
        batch = surfacePublications.prepareBatch(prepared.entries);
        if (batch.state !== 'staged') return false;
        while (prepared.isCurrent() && !boundary) {
            boundary = groundPublications.enqueue(batch, { onPublished(value) {
                result = value; published = true; prepared.finalize();
            } });
            if (!boundary) yield { phase: 'rail-publication-slot', deferFrame: true };
        }
        if (!boundary) return false;
        boundary.promise.then(value => { result = value; }, failure => { error = failure; });
        while (!result && !error) yield { phase: 'rail-publication-boundary', deferFrame: true };
        if (error) throw error;
        return candidate.committed === true;
    } finally {
        if (!published) {
            boundary?.cancel('rail-generation-superseded');
            if (batch?.state === 'staged') batch.discard('rail-generation-superseded');
            if (prepared) prepared.discard();
        }
    }
}

function enqueueRailPublicationPreparation(refresh) {
    if (refresh.publicationJob || refresh.candidate.committed) return;
    const current = () => pendingRailVisualRefresh === refresh && refresh.ground.isCurrent();
    const steps = refresh.publicationSteps || publishRailCandidateSteps(refresh.candidate, {
        ground: refresh.ground, isCurrent: current, replaceRoot: true,
        formationPublication: refresh.formationPublication, features: refresh.features || lastFeatures,
    });
    enqueueRailPublicationSteps(refresh, steps);
}

function enqueueRailPublicationSteps(refresh, steps) {
    refresh.publicationSteps = steps;
    refresh.publicationJob = ensureRailCellQueue().enqueue([steps], iterator => {
        const next = iterator.next();
        refresh.publicationPhase = next.value?.phase || 'complete';
        if (next.done) { refresh.publicationComplete = true; refresh.publicationSucceeded = next.value; return; }
        return next.value?.deferFrame ? FRAME_CHUNK_DEFER_ITEM : FRAME_CHUNK_REPEAT_ITEM;
    }, { maxItemsPerFrame: 64, describeItem: () => 'prepared rail generation',
        onComplete: () => { refresh.publicationJob = null; },
        onCancel: () => { steps.return(); refresh.publicationJob = null; },
        onError: error => { steps.return(); refresh.publicationJob = null; refresh.uploadError = error; },
    });
}

function prepareVisibleRails(
    centerX = lastRenderCenterX,
    centerZ = lastRenderCenterZ,
    {
        precomputedSegments = null,
        precomputedFormationDressing = null,
        precomputedStationFlares = null,
        precomputedStructures = null,
        precomputedStructuresKey = null,
        ground = null,
        features = lastFeatures,
    } = {},
) {
    if (!features) return null;
    let transactionPhaseStartedMs = performance.now();
    const transactionPhase = (name) => {
        const nowMs = performance.now();
        recordLayerFrameMs(
            `rails:visualTransaction:${name}`,
            nowMs - transactionPhaseStartedMs,
        );
        transactionPhaseStartedMs = nowMs;
    };
    discardPendingCrossingFormationRefresh();
    let nextSegments = precomputedSegments;
    if (!Array.isArray(nextSegments)) {
        const stationFlares = buildUndergroundStationFlareProfiles(
            features,
            lastStops,
            lastAnchorLat,
            lastAnchorLon,
            lastPhotoTrackFrame,
        );
        nextSegments = computeRailTrackbedSegments(
            features,
            lastAnchorLat,
            lastAnchorLon,
            lastMaxRadiusM,
            {
                rampOpenCutVolumes: lastRampOpenCutVolumes,
                stationFlares,
                terrain: ground ? ground.terrain : lastTerrain,
                railFormation: ground ? ground.railFormation : lastRailFormation,
                roadFormation: ground ? ground.roadFormation : lastRoadFormation,
                roadSupportCacheSource: ground ? ground.roadSupportCacheSource : lastRoadFormation,
                roadVerticalAlignments: ground ? ground.verticalAlignments : lastRoadVerticalAlignments,
                proposalMask: ground?.proposalMask,
                photoTrackFrame: lastPhotoTrackFrame,
                centerX,
                centerZ,
            },
        );
    }
    const incompleteCellKeys = new Set(
        nextSegments?.terrainEvidenceIncompleteCellKeys || [],
    );
    if (nextSegments.terrainEvidenceIncomplete === true
        && nextSegments.terrainEvidenceIncompleteStructural !== true
        && incompleteCellKeys.size === 0) {
        // Reject legacy/inexact incomplete inputs that cannot name an atomic
        // owner. Cell keys protect chunked rails; the structural flag protects
        // the one unchunked carried-tram sibling batch.
        return null;
    }
    if (nextSegments.terrainEvidenceIncomplete === true) {
        nextSegments = retainPublishedRailSegmentsForIncompleteOwners(
            nextSegments,
            lastSampledTrackbedSegments,
            incompleteCellKeys,
        );
    }
    transactionPhase('validate');
    const resolvedCenterX = Number(centerX) || 0;
    const resolvedCenterZ = Number(centerZ) || 0;
    const candidate = build(
        features,
        lastAnchorLat,
        lastAnchorLon,
        lastMaxRadiusM,
        lastSwitchRules,
        lastDriverGraph,
        lastRoutedSegments,
        lastRampOpenCutVolumes,
        lastStops,
        ground ? ground.terrain : lastTerrain,
        ground ? ground.railFormation : lastRailFormation,
        ground ? ground.verticalAlignments : lastRoadVerticalAlignments,
        lastPhotoTrackFrame,
        resolvedCenterX,
        resolvedCenterZ,
        nextSegments,
        precomputedFormationDressing,
        precomputedStationFlares,
        precomputedStructures,
        precomputedStructuresKey,
        ground ? ground.roadFormation : lastRoadFormation,
    );
    transactionPhase('build');
    return {
        ...candidate,
        centerX: resolvedCenterX,
        centerZ: resolvedCenterZ,
        incompleteCellKeys,
    };
}

// Startup, style, proposal and clearance changes use the same deferred path
// as streaming. Keep the previous complete generation until its replacement
// has finished CPU preparation and GPU prewarm.
function rebuildVisibleRails(centerX = lastRenderCenterX, centerZ = lastRenderCenterZ) {
    if (!lastFeatures) return false;
    // Clearance I/O and proposal callbacks can finish after the shared owner
    // takes over. Its onFrame path deliberately stops the ordinary publisher;
    // leaving a request there would also block admission of its successor.
    if (groundManaged) return groundCoordinator.invalidate('rails', { reason: 'rail-visual-refresh' });
    const previous = pendingRailVisualRefresh;
    const replacement = { centerX, centerZ, reason: previous?.reason || 'requested',
        streamedSignature: previous?.streamedSignature,
        streamedInputRevision: previous?.streamedInputRevision };
    discardPendingRailVisualRefresh();
    pendingRailVisualRefresh = replacement;
    return true;
}

function railInspectionSpecForName(rawName) {
    const name = String(rawName || 'Rail geometry');
    if (name.includes('FormationTerrainCollar')) return {
        id: 'rail-earthworks',
        label: 'Rail embankments and cut slopes',
        category: 'Civil works',
        source: 'world/rails.js · RailFormation terrain collar',
        order: 151,
    };
    if (name.includes('FormationRetainingWalls')) return {
        id: 'rail-retaining-walls',
        label: 'Rail retaining walls',
        category: 'Civil works',
        source: 'world/rails.js · RailFormation retaining faces',
        order: 152,
    };
    if (name.includes('Viaduct') || name.includes('Bridge')) return {
        id: 'rail-viaducts',
        label: 'Rail viaducts and bridges',
        category: 'Civil works',
        source: 'world/rails.js · engineered rail structures',
        order: 153,
    };
    if (name.includes('Tunnel')) return {
        id: 'rail-tunnels',
        label: 'Rail tunnels',
        category: 'Civil works',
        source: 'world/rails.js · engineered rail tunnel geometry',
        order: 154,
    };
    if (name.includes('TrackbedFlatCurbs')) return {
        id: 'rail-trackbed-curbs',
        label: 'Rail trackbed curbs',
        category: 'Transport',
        source: 'world/rails.js · flat trackbed edge profiles',
        order: 156,
    };
    if (name.includes('Trackbed') || name.includes('Ballast')) return {
        id: 'rail-trackbed',
        label: 'Rail trackbed',
        category: 'Transport',
        source: 'world/rails.js · rendered trackbed surface',
        order: 155,
    };
    return {
        id: 'rail-bars-and-fittings',
        label: 'Rails and track fittings',
        category: 'Transport',
        source: 'world/rails.js · rendered rail geometry',
        order: 157,
    };
}

function annotateRailInspectionLayers(root, {
    replacementKey = null,
    generation = railCellBuildToken,
} = {}) {
    markInspectionLayer(root, {
        id: 'rails-container',
        label: 'Rail renderer',
        category: 'Transport',
        source: 'world/rails.js',
        order: 150,
        containerOnly: true,
    });
    root.traverse((object) => {
        if (!object?.isMesh) return;
        markInspectionLayer(object, railInspectionSpecForName(object.name));
        const name = String(object.name || '');
        if (railObjectParticipatesInCampaignDemolition(name)) {
            for (const material of Array.isArray(object.material)
                ? object.material
                : [object.material]) {
                applyCampaignRailDemolitionCutout(material);
            }
        }
        const publishedIdentity = surfacePublicationIdentityForObject(object);
        const parentCellKey = object.parent?.userData?.railCellKey || null;
        const objectReplacementKey = replacementKey
            || publishedIdentity?.key
            || (parentCellKey ? railCellPublicationKey(parentCellKey) : null);
        const objectGeneration = replacementKey
            ? generation
            : publishedIdentity?.generation ?? generation;
        const materialClaim = (Array.isArray(object.material)
            ? object.material.find(material => material?.userData?.surfaceClaim)
            : object.material)?.userData?.surfaceClaim || null;
        if (materialClaim) {
            markSurfaceClaim(object, reviseSurfaceClaim(materialClaim, {
                coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
                ownerId: objectReplacementKey
                    || parentCellKey
                    || object.parent?.name
                    || object.name
                    || null,
                replacementKey: objectReplacementKey,
                generation: objectGeneration,
            }));
            return;
        }
        const sameLevelPrepass = name.includes('RailSameLevelPriority');
        const tunnelTrackbed = name.includes('TrackbedTunnel') || name.includes('BallastTunnel');
        const trackbed = name.includes('Trackbed')
            || name.includes('Ballast')
            || name.includes('JunctionPatches');
        const trackbedCurb = name.includes('TrackbedFlatCurbs');
        const railSteel = name.includes('RailBars');
        const surfaceClass = sameLevelPrepass || trackbed
            ? trackbedCurb
                ? SURFACE_CLASS.RAIL_TRACKBED_CURB
                : SURFACE_CLASS.RAIL_TRACKBED
            : railSteel
                ? SURFACE_CLASS.RAIL_STEEL
                : SURFACE_CLASS.STRUCTURE;
        const verticalRelation = sameLevelPrepass
            ? SURFACE_VERTICAL_RELATION.SAME_LEVEL
            : tunnelTrackbed
                ? SURFACE_VERTICAL_RELATION.GRADE_SEPARATED
                : SURFACE_VERTICAL_RELATION.UNKNOWN;
        markSurfaceClaim(object, {
            surfaceClass,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            verticalRelation,
            verticalBand: sameLevelPrepass ? 'ground' : null,
            ownerId: objectReplacementKey
                || parentCellKey
                || object.parent?.name
                || object.name
                || null,
            sourceId: 'world/rails.js',
            replacementKey: objectReplacementKey,
            generation: objectGeneration,
            paintsColor: !sameLevelPrepass,
            supportReady: !sameLevelPrepass
                && (surfaceClass === SURFACE_CLASS.RAIL_TRACKBED
                || (surfaceClass === SURFACE_CLASS.STRUCTURE
                    && object.userData?.walkableSurface === true)),
            cutsBackstop: !sameLevelPrepass
                && surfaceClass === SURFACE_CLASS.RAIL_TRACKBED,
        });
    });
}

// Advances the pending formation model within the frame budget. The model reads
// terrain evidence and its own features only, so this is safe while the road
// formation is dirty; every later stage (civil ground snapshot, trackbed
// segments, visual publication) reads roads and waits for their generation.
// Returns true once the model is built, or when nothing is pending.
function stepPendingRailFormationModel() {
    const build = pendingRailFormationBuild;
    if (!build || build.modelBuilt) return true;
    if (build.failure) {
        // A failed iterator must never resume as a completed partial model or
        // become an every-frame exception loop. Keep the old published rail
        // and retry after an input changes or real capacity is released.
        const capacityReleased = build.failure.code === 'terrain-publication-capacity'
            && typeof lastTerrain?.readReleaseRevision === 'number'
            && build.readReleaseRevision !== lastTerrain.readReleaseRevision;
        if (build.inputRevision === streamedRailInputRevision
            && build.terrainRevision === (Number(lastTerrain?.revision) || 0)
            && !capacityReleased) return false;
        if (build.reason === 'streamed') streamedRailDirty = true;
        else {
            terrainRevisionDirty = true;
            if (build.fullRefresh) terrainDirtyFullRefresh = true;
            else if (!terrainDirtyFullRefresh) terrainDirtyBounds.push(...build.changeBounds);
        }
        discardPendingRailFormationBuild();
        return false;
    }
    const stepStarted = railStreamNowMs();
    let outcome;
    try {
        do {
            outcome = build.model?.stepPendingBuild?.() || { done: true, phase: 'finalize' };
        } while (!outcome.done
            && railStreamNowMs() - stepStarted < RAIL_FORMATION_MODEL_STEP_BUDGET_MS);
    } catch (error) {
        failRailFormationBuild(build, error);
        throw error;
    }
    recordLayerFrameMs(
        `rails:${build.reason === 'streamed' ? 'streamedFormation' : 'terrainFormation'}:${outcome.phase}`,
        railStreamNowMs() - stepStarted,
    );
    if (!outcome.done) return false;
    build.modelBuilt = true;
    if (build.model?.revision) {
        build.model.revision = ++railFormationRevision;
        build.revisionPrepared = true;
    }
    return true;
}

export const railsLayer = {
    // Published rail geometry can have no terrain-relative earthworks (for
    // example a local-level planner ramp). Its null formation is a completed
    // empty result; waiting for a model here prevents its first shared build.
    groundReady: () => !railGroundGenerationLease && !pendingRailFormationBuild
        && !pendingRailVisualRefresh && !pendingRailStructuresRefresh && !pendingCrossingFormationRefresh
        && !pendingEmbeddedTramMeshRefresh,
    manageGroundPublications(coordinator) { groundCoordinator = coordinator; groundManaged = true; },
    admitGroundGenerationSteps: admitRailGroundGenerationSteps,
    admitWindowGroundGeneration: admitRailWindowGroundGeneration,
    prepareConstructionGroundSteps: prepareRailConstructionGroundSteps,
    prepareOwnershipGroundSteps: prepareRailOwnershipGroundSteps,
    prepareGroundGenerationSteps: prepareRailGroundGenerationSteps,
    beginSession(ctx) {
        groundManaged = false; groundCoordinator = ctx.groundCoordinator || null;
        railGroundGenerationLease?.cancel();
        railSessionToken += 1;
        surfacePublications = ctx.surfacePublications || null;
        groundPublications = ctx.groundPublications || null;
        getGroundPhysics = ctx.getGroundPhysics || null;
        if (!railCellsRoot) { railCellsRoot = new THREE.Group(); railCellsRoot.name = 'RailRenderCells'; }
        releaseCivilGroundAuthority?.();
        releaseCivilGroundAuthority = null;
        lastPillarClearance = null;
        pillarClearanceReady = false;
        lastTrackSpacingStationFlares = [];
        lastStationFlares = [];
        streamedRailSubscription?.();
        streamedRailSource = null;
        streamedRailSubscription = null;
        streamedRailTileFeatures = null;
        streamedRailDeliveredTileKeys.clear();
        streamedRailChangedTileKeys.clear();
        streamedRailBaseFeatures = [];
        streamedRailAppliedSignature = '';
        streamedRailInputRevision = 0;
        resolvedStreamedRailSource = null;
        streamedRailDirty = false;
        streamedRailLastChangeMs = 0;
        streamedRailDirtySinceMs = 0;
        streamedRailRetryAfterMs = 0;
        streamedRailLastAppliedMs = Number.NaN;
        streamedRailLastAppliedX = 0;
        streamedRailLastAppliedZ = 0;
        streamedRailHasAppliedSet = false;
        streamedRailSessionContext = null;
        streamedRailProfileMode = 'osm';
        activeRailTrafficRevision += 1;
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        mappedSeaChangeSubscription?.();
        mappedSeaChangeSubscription = null;
        mappedSeaStructuresDirty = false;
        mappedSeaStructuresRevision = 0;
        terrainRevisionDirty = false;
        terrainDirtyBounds = [];
        terrainDirtyFullRefresh = false;
        discardPendingRailFormationBuild();
        resetRailCivilGroundSnapshot();
        discardPendingRailVisualRefresh();
        discardPendingRailStructuresRefresh();
        discardPendingCrossingFormationRefresh();
        const {
            anchorLat,
            anchorLon,
            otherTracks,
            allStops,
            customTrackCorridors,
            switchRules,
            driverGraph,
            routedSegments,
            terrain,
            roadFormation,
            roadVerticalAlignments,
            photoTrackFrame,
            sharedTileSession,
            sessionCapabilities,
            railProfileMode,
            locationId,
            styleCityId,
        } = ctx;
        const suppliedTracks = Array.isArray(otherTracks) ? otherTracks : [];
        const streamsCroatiaRails = sessionCapabilityEnabled(
            sessionCapabilities,
            SESSION_CAPABILITY.CROATIA_RAIL_STREAMING,
        )
            && !!sharedTileSession;
        if (suppliedTracks.length === 0 && !streamsCroatiaRails) return;
        releaseCivilGroundAuthority = ctx.civilGround?.setGroundAuthority(
            CIVIL_GROUND_AUTHORITY.RAIL,
            {
                id: 'rail-formation',
                // Profiles exist only for actual cut/fill. Rail tunnels and
                // viaducts deliberately return null and remain structures.
                sampleSceneYAtLocal: (x, z) => (
                    lastRailFormation?.civilGroundSceneYAtLocal?.(
                        x,
                        z,
                        { surfaceOffsetY: TRACKBED_Y },
                    )
                ),
                sampleEvidenceSceneYAtLocal: (x, z) => (
                    lastRailFormation?.civilGroundSceneYAtLocal?.(
                        x,
                        z,
                        { surfaceOffsetY: TRACKBED_Y },
                    )
                ),
                dependencySnapshot: () => publishedRailCivilGroundSnapshot,
            },
        ) || null;
        streamedRailProfileMode = normalizeRailProfileMode(railProfileMode);
        streamedRailBaseFeatures = suppliedTracks;
        lastTerrainSource = ctx.terrainSource || terrain || null;
        lastFeatures = streamsCroatiaRails
            ? resolveStreamedRailSessionFeatures({
                suppliedFeatures: suppliedTracks,
                streamedOsmFeatures: [],
                mode: streamedRailProfileMode,
                terrainReference: lastTerrainSource,
            })
            : resolveStandaloneRailFeatures(suppliedTracks, lastTerrainSource);
        lastAnchorLat = anchorLat;
        lastAnchorLon = anchorLon;
        lastMaxRadiusM = RAILS_RENDER_RADIUS_M;
        lastRenderCenterX = 0;
        lastRenderCenterZ = 0;
        lastSwitchRules = switchRules || null;
        lastDriverGraph = driverGraph || null;
        lastRoutedSegments = routedSegments || null;
        uncoveredSwitchCoverageCache = null;
        lastStops = allStops || [];
        lastTerrain = terrain || null;
        const mappedSeaSessionToken = railSessionToken;
        mappedSeaChangeSubscription = subscribeMappedSeaChanges((_coastline, { groundPublished = false } = {}) => {
            if (mappedSeaSessionToken !== railSessionToken) return;
            if (groundManaged && groundPublished) return;
            if ((lastRailFormation?.getViaductRuns?.() || []).length === 0) return;
            mappedSeaStructuresRevision += 1;
            mappedSeaStructuresDirty = true;
            if (groundManaged) groundCoordinator.invalidate('rails', { full: true });
        });
        terrainChangeSubscription = lastTerrainSource?.onChange?.((revision, event) => {
            if (groundManaged) return;
            terrainRevisionDirty = true;
            streamedRailRetryAfterMs = 0;
            // Keep the change bounds: the refresh handler skips the whole
            // resolve→formation→rebuild pipeline when no rail geometry lies
            // inside them. An event without bounds means "unknown extent" and
            // forces the full refresh, exactly like world/roads.js treats it.
            const changeBounds = Array.isArray(event?.bounds) ? event.bounds : [];
            if (changeBounds.length === 0) terrainDirtyFullRefresh = true;
            else if (!terrainDirtyFullRefresh) terrainDirtyBounds.push(...changeBounds);
        }) || null;
        lastRoadFormation = roadFormation || null;
        lastRoadVerticalAlignments = roadVerticalAlignments || null;
        lastRoadCarriedTramRevision = -1;
        pendingRoadCarriedTramRevision = -1;
        pendingRoadCarriedTramSinceMs = 0;
        lastRoadCarriedTramDeckSignature = '';
        lastEmbeddedTramRoadRevision = -1;
        pendingEmbeddedTramRoadRevision = -1;
        pendingEmbeddedTramRoadSinceMs = 0;
        discardPendingEmbeddedTramMeshRefresh();
        lastRailPillarRoadSignature = '';
        lastRailsHeadingDeg = null;
        lastRailsHeadingChangeMs = 0;
        publishedRailBoundaryInputs = pendingRailBoundaryInputs = null;
        pendingRailBoundarySinceMs = 0;
        levelCrossingAccum = new Map();
        levelCrossingAccumRevision = 0;
        roadUnderRailOpeningAccum = new Map();
        lastPhotoTrackFrame = photoTrackFrame || null;
        lastBridgeStyleLocationId = locationId || null;
        lastBridgeStyleCityId = styleCityId || null;
        photoStationStructureRevision = getPhotorealStationStructureRevision();
        streamedRailSessionContext = ctx;
        // The shared ground coordinator owns the initial formation. Its
        // construction stage is already cooperative and publishes formation,
        // track cells, terrain cuts, roads and collision in one transaction.
        // Starting a private formation here duplicates the expensive solve and
        // leaves its detached visual successor racing the same streamed road
        // inputs, which can hold the loading curtain until timeout.
        ctx.railFormation = null;
        lastRampOpenCutVolumes = buildTrackCorridorVolumes(customTrackCorridors, anchorLat, anchorLon, {
            halfWidth: PLANNER_OPEN_CUT_HALF_WIDTH_M,
            elevatedRightExtension: 0,
            segmentFilter: ({ properties, startElevationM, endElevationM }) =>
                properties?.elevationMode !== 'absolute'
                && properties?.elevationDatum !== 'asl'
                && isPlannerUndergroundRampSegment(startElevationM, endElevationM),
        });
        // Visual cells, structures and pillar clearance are staged by that
        // coordinated publication; publishing them here would build the same
        // startup generation twice.
        if (streamsCroatiaRails) {
            streamedRailTileFeatures = new Map();
            streamedRailDeliveredTileKeys.clear();
            streamedRailChangedTileKeys.clear();
            // roadsLayer starts first and owns this source configuration. The
            // same key gives us its decoded payloads (including late replay)
            // without another fetch. Supplying the complete configuration also
            // keeps this layer correct in a focused test or future layer order.
            streamedRailSource = sharedTileSession.getSource({
                key: 'roads:cab',
                label: 'roads',
                url: (bb) => `${getApiBase()}/roads/cab?bbox=${bb.west},${bb.south},${bb.east},${bb.north}&format=bin`,
                decodeBody: decodeRoadTile,
                ...NEAR_ROAD_STREAM_OPTIONS,
            });
            streamedRailSubscription = streamedRailSource.subscribe({
                onFetch: (features, tileKey) => {
                    // Empty payloads settle the local publication barrier too:
                    // they prove that a tile contains no additional rail.
                    streamedRailDeliveredTileKeys.add(tileKey);
                    const next = railFeaturesFromRoadSurfaces(features || []);
                    const previous = streamedRailTileFeatures.get(tileKey) || [];
                    if (streamedRailFeatureSetSignature(previous)
                        === streamedRailFeatureSetSignature(next)) return;
                    if (next.length > 0) streamedRailTileFeatures.set(tileKey, next);
                    else streamedRailTileFeatures.delete(tileKey);
                    markStreamedRailSetChanged(tileKey);
                },
                onEvict: (tileKey) => {
                    streamedRailDeliveredTileKeys.delete(tileKey);
                    if (!streamedRailTileFeatures.has(tileKey)) return;
                    streamedRailTileFeatures.delete(tileKey);
                    markStreamedRailSetChanged(tileKey);
                },
            });
            streamedRailSource.ensureAround(0, 0);
        }
    },
    onFrame(pose, local) {
        const x = Number(local?.x);
        const z = Number(local?.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return;
        // Cell geometry is deliberately retained across outer rail-generation
        // swaps. A late cooperative retirement must never leave that reusable
        // root detached: it contains the ballast, sleepers and steel which are
        // the opaque backstop over terrain openings.
        ensurePersistentRenderRootAttached(group, railCellsRoot);
        const regionalLocation = getLocation();
        const nextBridgeLocationId = regionalLocation.regionalLocationId || regionalLocation.id || null;
        const nextBridgeStyleCityId = regionalLocation.styleCityId || regionalLocation.id || null;
        const headingDeg = Number(pose?.headingDeg);
        if (streamedRailSource) {
            const surfacePreload = pose?.surfaceStreamingPreload;
            if (surfacePreload) {
                streamedRailSource.ensurePinnedPoints(surfacePreload.points, {
                    signature: surfacePreload.signature,
                    priorityX: surfacePreload.priority?.x,
                    priorityZ: surfacePreload.priority?.z,
                    headingDeg: surfacePreload.priority?.headingDeg,
                });
            }
            streamedRailSource.ensureAround(x, z, {
                headingDeg: Number.isFinite(headingDeg) ? headingDeg : undefined,
            });
        }
        if (Number.isFinite(headingDeg)) {
            if (lastRailsHeadingDeg == null) {
                lastRailsHeadingDeg = headingDeg;
            } else {
                const headingDelta = Math.abs(
                    ((headingDeg - lastRailsHeadingDeg + 540) % 360) - 180,
                );
                if (headingDelta > 0.01) {
                    lastRailsHeadingDeg = headingDeg;
                    lastRailsHeadingChangeMs = typeof performance !== 'undefined'
                        ? performance.now()
                        : Date.now();
                }
            }
        }
        if (groundManaged || railGroundGenerationLease) return;
        // Road tiles advance the formation revision before its queued build
        // publishes the corresponding spatial indexes. Every reconciliation
        // below can sample the road (embedded tram heights, crossing ownership,
        // pillar clearance, or a complete rail rebuild). Sampling current data
        // while that generation is dirty calls RoadFormationModel._ensureBuilt
        // and used to hide a 157-189 ms road build inside rails:terrainRefresh.
        // Keep the old rail mesh visible and, critically, consume none of the
        // rail dirty/revision flags until roads has atomically published it.
        // The formation model itself reads no road data, so it keeps building
        // meanwhile: waiting here used to cost the first rail snapshot most of
        // the frames of a streaming start.
        if (lastRoadFormation?.hasPendingBuild?.() === true) {
            stepPendingRailFormationModel();
            return;
        }
        if (pendingEmbeddedTramMeshRefresh
            && stepPendingEmbeddedTramMeshRefresh()) return;
        if (pendingRailFormationBuild) {
            // A tile delivered since this build was staged does not invalidate
            // it: the set it was built from is still a complete, exact rail
            // network as of that revision. It publishes as a snapshot and the
            // streamed refresh then catches up with the newer input. Dropping
            // it here restarted the build on every delivery, so a streaming
            // start showed no rail until the whole corridor had settled.
            const disposition = pendingRailFormationBuildDisposition({
                terrainRevisionDirty,
                terrainFullRefresh: terrainDirtyFullRefresh,
                terrainTouchesRail: terrainRevisionDirty
                    && !terrainDirtyFullRefresh
                    && terrainBoundsTouchPendingRailBuild(terrainDirtyBounds),
            });
            if (disposition === RAIL_BUILD_DISPOSITION.CONSUME_TERRAIN) {
                // The revision reached neither the published rail geometry nor
                // the chords this build samples, so the model it is preparing
                // is still exact. Consume the flag here and keep the progress;
                // discarding the build used to livelock against the streamed
                // refresh (core/rail-formation-build-policy.js).
                terrainDirtyBounds = [];
                terrainRevisionDirty = false;
            }
            if (disposition === RAIL_BUILD_DISPOSITION.DROP_TERRAIN) {
                // The unpublished task sampled an older terrain generation.
                // Put its consumed bounds back so the replacement compares
                // against the still-published formation, then discard it.
                if (pendingRailFormationBuild.fullRefresh) {
                    terrainDirtyFullRefresh = true;
                } else if (!terrainDirtyFullRefresh) {
                    terrainDirtyBounds.push(...pendingRailFormationBuild.changeBounds);
                }
                discardPendingRailFormationBuild();
            } else {
                const build = pendingRailFormationBuild;
                if (!stepPendingRailFormationModel()) return;
                const stepStarted = railStreamNowMs();
                if (!build.civilGroundSnapshot) {
                    if (!build.civilGroundSnapshotIterator) {
                        build.civilGroundSnapshotIterator =
                            railCivilGroundDependencySnapshotSteps(
                                build.model,
                                RAIL_CIVIL_GROUND_SNAPSHOT_PADDING_M,
                            );
                    }
                    let snapshotOutcome;
                    try { snapshotOutcome = build.civilGroundSnapshotIterator.next(); }
                    catch (error) { failRailFormationBuild(build, error); throw error; }
                    recordLayerFrameMs(
                        `rails:${build.reason === 'streamed'
                            ? 'streamedFormation'
                            : 'terrainFormation'}:civilGroundSnapshot:${
                            snapshotOutcome.value?.phase || 'finalize'}`,
                        railStreamNowMs() - stepStarted,
                    );
                    if (!snapshotOutcome.done) return;
                    build.civilGroundSnapshot = snapshotOutcome.value;
                    build.civilGroundSnapshotIterator = null;
                }
                pendingRailFormationBuild = null;
                discardPendingRailVisualRefresh();
                discardPendingRailStructuresRefresh();
                const formationPublication = prepareRailFormationPublication(build.model, build.features, {
                    recordBuildTimings: false, revisionPrepared: build.revisionPrepared,
                    civilGroundSnapshot: build.civilGroundSnapshot,
                });
                pendingRailVisualRefresh = {
                    centerX: build.centerX, centerZ: build.centerZ,
                    features: build.features, formationPublication,
                    resampleSegments: build.canResampleSolvedChords ? lastSampledTrackbedSegments : null,
                    reason: build.reason === 'streamed' ? 'streamed' : 'terrain',
                    streamedSignature: build.signature || null,
                    streamedInputRevision: build.inputRevision ?? null,
                };
                recordLayerFrameMs(
                    build.reason === 'streamed'
                        ? 'rails:streamedFormation:finalize'
                        : 'rails:terrainFormation:finalize',
                    railStreamNowMs() - stepStarted,
                );
                return;
            }
        }
        // Bootstrap or externally supplied formations can lack a prepared
        // dependency fingerprint. Build it cooperatively; ordinary crossing
        // successors supply theirs in the same boundary as their geometry.
        if (stepPublishedRailCivilGroundSnapshot()) return;
        if (pendingRailVisualRefresh) {
            // Only a terrain revision discards the staged visual; a newer
            // streamed tile does not (core/rail-formation-build-policy.js).
            if (!pendingRailVisualRefresh.candidate?.committed
                && pendingRailVisualRefreshDisposition({ terrainRevisionDirty })
                === RAIL_VISUAL_REFRESH_DISPOSITION.DISCARD_TERRAIN) {
                // A newer formation will supersede this unpublished visual
                // generation; keep the old mesh instead of building it twice.
                discardPendingRailVisualRefresh();
            } else {
                const refresh = pendingRailVisualRefresh;
                if (!stepPendingRailVisualPreparation()) return;
                const refreshPhase = refresh.reason === 'movement' ? 'movementRefresh'
                    : refresh.reason === 'streamed' ? 'streamedRefresh' : 'terrainRefresh';
                const visualStarted = railStreamNowMs();
                const rebuilt = refresh.candidate?.committed === true;
                if (rebuilt) refresh.candidate = null;
                if (refresh.reason === 'streamed') {
                    const completedAtMs = railStreamNowMs();
                    const current = refresh.streamedInputRevision === streamedRailInputRevision;
                    if (rebuilt) {
                        // What is on screen is now this immutable set, whether
                        // or not a newer tile arrived while it was staged. The
                        // refresh policy must see rendered features, so a
                        // stationary observer's catch-up coalesces instead of
                        // chasing every tile of the corridor.
                        streamedRailAppliedSignature = refresh.streamedSignature || '';
                        streamedRailLastAppliedMs = completedAtMs;
                        streamedRailLastAppliedX = Number(refresh.centerX) || 0;
                        streamedRailLastAppliedZ = Number(refresh.centerZ) || 0;
                        streamedRailHasAppliedSet = true;
                    }
                    if (rebuilt && current) {
                        streamedRailDirty = false;
                        streamedRailDirtySinceMs = 0;
                        streamedRailRetryAfterMs = 0;
                        streamedRailChangedTileKeys.clear();
                    } else {
                        // Missing terrain or a superseding delivery leaves the
                        // prior complete render visible and schedules one
                        // bounded retry for the latest immutable input set.
                        streamedRailDirty = true;
                        if (!streamedRailDirtySinceMs) {
                            streamedRailDirtySinceMs = completedAtMs;
                        }
                        streamedRailLastChangeMs = completedAtMs;
                        streamedRailRetryAfterMs = completedAtMs
                            + DEFAULT_STREAMED_RAIL_REFRESH_POLICY.firstPreviewMs;
                    }
                }
                recordLayerFrameMs(
                    `rails:${refreshPhase}:visual`,
                    railStreamNowMs() - visualStarted,
                );
                if (!rebuilt) {
                    // Keep the previous complete generation and release every
                    // resource owned by the malformed/incomplete successor.
                    discardPendingRailVisualRefresh();
                } else {
                    refresh.publicationSteps?.return?.();
                    refresh.ground.release();
                    pendingRailVisualRefresh = null;
                }
                return;
            }
        }
        if (pendingRailStructuresRefresh) {
            if (stepPendingRailStructuresRefresh()) return;
        }
        if (nextBridgeLocationId !== lastBridgeStyleLocationId
            || nextBridgeStyleCityId !== lastBridgeStyleCityId) {
            lastBridgeStyleLocationId = nextBridgeLocationId;
            lastBridgeStyleCityId = nextBridgeStyleCityId;
            const started = railStreamNowMs();
            rebuildVisibleRails(x, z);
            recordLayerFrameMs('rails:regionalStyle', railStreamNowMs() - started);
            return;
        }
        if (mappedSeaStructuresDirty) {
            mappedSeaStructuresDirty = false;
            const started = railStreamNowMs();
            scheduleRailStructuresForMappedSea();
            recordLayerFrameMs('rails:mappedSea:queue', railStreamNowMs() - started);
            return;
        }
        if (streamedRailRefreshAllowed({ streamedRailDirty, terrainRevisionDirty })) {
            const sourceCounts = streamedRailSource?.getDebugCounts?.();
            const sourceSettled = !sourceCounts
                || Number(sourceCounts.pending) === 0;
            const changedNearObserver = streamedRailChangedNearObserver(
                streamedRailChangedTileKeys,
                x,
                z,
                { tileM: TILE_M, ring: CAB_RING },
            );
            const observerTilesSettled = streamedRailObserverTilesSettled(
                streamedRailDeliveredTileKeys,
                x,
                z,
                { tileM: TILE_M, ring: CAB_RING },
            );
            const observerTileDelivered = streamedRailObserverTilesSettled(
                streamedRailDeliveredTileKeys,
                x,
                z,
                { tileM: TILE_M, ring: 0 },
            );
            const observerMovedEnough = Math.hypot(
                x - streamedRailLastAppliedX,
                z - streamedRailLastAppliedZ,
            ) >= STREAMED_RAIL_PROGRESS_M;
            const streamNowMs = railStreamNowMs();
            const refreshDue = streamNowMs >= streamedRailRetryAfterMs
                && streamedRailRefreshDue({
                    nowMs: streamNowMs,
                    lastChangeMs: streamedRailLastChangeMs,
                    dirtySinceMs: streamedRailDirtySinceMs,
                    lastAppliedMs: streamedRailLastAppliedMs,
                    hasRenderedFeatures: streamedRailHasAppliedSet,
                    sourceSettled,
                    // Nearby rail changes wait only for the 3x3 support ring. Far
                    // corridor deliveries still coalesce until the shared source
                    // settles and can never hold the visible ring hostage.
                    settledForObserver: changedNearObserver
                        ? observerTilesSettled
                        : sourceSettled,
                    initialPreviewReady: changedNearObserver && observerTileDelivered,
                    observerMovedEnough,
                });
            // The first local set may be a centre-tile preview; the complete
            // support ring then replaces it without ever removing the old
            // rendered cells before their successors are ready.
            if (refreshDue) {
                if (replaceStreamedRailFeatures(x, z)) return;
            }
        }
        // As road tiles stream in, let structurally-tagged longitudinal trams
        // consume a newly solved bridge deck before processing wall-only
        // crossing ownership.
        if (refreshRoadCarriedTramGeometry()) {
            const tDeck0 = performance.now();
            rebuildRoadCarriedTramMeshes(x, z);
            recordLayerFrameMs('rails:roadDeck', performance.now() - tDeck0);
            return;
        }
        const embeddedTramRefresh = refreshEmbeddedTramRoadGeometry();
        if (embeddedTramRefresh) {
            if (embeddedTramRefresh === 'structures') {
                const tPillar0 = performance.now();
                scheduleRailStructuresForRoadSurface();
                recordLayerFrameMs('rails:pillarRoad:queue', performance.now() - tPillar0);
                return;
            }
            scheduleEmbeddedTramMeshRefresh(x, z, embeddedTramRefresh.changedBounds);
            return;
        }
        if (scheduleRailBoundaryRefresh(x, z)) return;
        if (pendingCrossingFormationRefresh) {
            if (terrainRevisionDirty) {
                // The terrain refresh will replace the complete dressing with
                // newer immutable terrain/OSM truth. Keep the currently
                // published meshes visible and drop this stale replacement.
                discardPendingCrossingFormationRefresh();
            } else {
                stepCrossingSuppressedFormationMeshes();
                return;
            }
        }
        if (lastPhotoTrackFrame && isPhotorealRevealed()) {
            const revision = getPhotorealStationStructureRevision();
            if (revision !== photoStationStructureRevision) {
                photoStationStructureRevision = revision;
                rebuildVisibleRails(x, z);
                return;
            }
        }
        if (terrainRevisionDirty) {
            const fullRefresh = terrainDirtyFullRefresh;
            const changeBounds = terrainDirtyBounds;
            terrainDirtyBounds = [];
            terrainDirtyFullRefresh = false;
            const impact = fullRefresh
                ? { any: true, structures: true }
                : railTerrainChangeImpact(changeBounds);
            if (!impact.any) {
                // The revision touched no rail geometry: consume the flag
                // without resolving, re-solving or rebuilding anything.
                terrainRevisionDirty = false;
                return;
            }
            const started = railStreamNowMs();
            if (streamedRailSessionContext) {
                // OSM mode's prepared LineStrings are terrain-independent. Keep
                // their object identity so the new formation and existing
                // solved chords share the same feature-station keys. Solved
                // mode still re-resolves because terrain clearance can change
                // its clipped/context geometry.
                const retainOsmTopology = streamedRailProfileMode === 'osm';
                const resolveStarted = performance.now();
                if (!retainOsmTopology) {
                    lastFeatures = streamedRailTileFeatures
                        ? resolveCurrentStreamedRailFeatures()
                        : resolveStandaloneRailFeatures(streamedRailBaseFeatures, lastTerrain);
                }
                activeRailTrafficRevision += 1;
                streamedRailSessionContext.otherTracks = lastFeatures;
                recordLayerFrameMs('rails:refresh:resolve', performance.now() - resolveStarted);
            }
            const canResampleSolvedChords = streamedRailProfileMode === 'osm'
                && lastSampledTrackbedSegments.length > 0
                && lastSampledTrackbedSegments.terrainEvidenceIncomplete !== true;
            createPendingRailFormationBuild(lastFeatures, {
                fullRefresh,
                changeBounds,
                centerX: canResampleSolvedChords ? lastRenderCenterX : x,
                centerZ: canResampleSolvedChords ? lastRenderCenterZ : z,
                canResampleSolvedChords,
            });
            // Pier and portal ground changed — the structures key cannot see
            // terrain, so force the eventual visual rebuild explicitly.
            if (impact.structures) railStructuresKey = null;
            terrainRevisionDirty = false;
            recordLayerFrameMs(
                'rails:terrainRefresh:queueFormation',
                railStreamNowMs() - started,
            );
            return;
        }
        if (Math.hypot(x - lastRenderCenterX, z - lastRenderCenterZ) < RAILS_REBUILD_M) return;
        // OSM topology and terrain are immutable here; only the moving render
        // window changed. Prepare its expensive dressing off-scene over two
        // frames, then compute/swap the remaining visual in a third frame.
        discardPendingRailStructuresRefresh();
        pendingRailVisualRefresh = {
            centerX: x,
            centerZ: z,
            precomputedSegments: null,
            reason: 'movement',
        };
    },
    endSession() {
        groundManaged = false; groundCoordinator = null;
        railGroundGenerationLease?.cancel();
        railSessionToken += 1;
        releaseCivilGroundAuthority?.();
        releaseCivilGroundAuthority = null;
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        mappedSeaChangeSubscription?.();
        mappedSeaChangeSubscription = null;
        mappedSeaStructuresDirty = false;
        mappedSeaStructuresRevision = 0;
        terrainRevisionDirty = false;
        streamedRailSubscription?.();
        streamedRailSource = null;
        streamedRailSubscription = null;
        streamedRailTileFeatures?.clear?.();
        streamedRailTileFeatures = null;
        streamedRailDeliveredTileKeys.clear();
        streamedRailChangedTileKeys.clear();
        streamedRailBaseFeatures = [];
        streamedRailAppliedSignature = '';
        streamedRailInputRevision = 0;
        resolvedStreamedRailSource = null;
        streamedRailDirty = false;
        streamedRailLastChangeMs = 0;
        streamedRailDirtySinceMs = 0;
        streamedRailRetryAfterMs = 0;
        streamedRailLastAppliedMs = Number.NaN;
        streamedRailLastAppliedX = 0;
        streamedRailLastAppliedZ = 0;
        streamedRailHasAppliedSet = false;
        streamedRailSessionContext = null;
        streamedRailProfileMode = 'osm';
        activeRailTrafficRevision += 1;
        for (const [cellKey, cellGroup] of railCellGroupsState) {
            surfacePublications?.retire?.(railCellPublicationKey(cellKey), {
                root: cellGroup,
                reason: 'rail-layer-ended',
            });
        }
        if (group) {
            if (railCellsRoot) group.remove(railCellsRoot);
            if (railStructuresGroup) group.remove(railStructuresGroup);
            disposeGroup(group);
            group = null;
        }
        if (railCellsRoot) {
            disposeGroup(railCellsRoot);
            railCellsRoot = null;
        }
        if (railStructuresGroup) {
            disposeGroup(railStructuresGroup);
            railStructuresGroup = null;
        }
        railStructuresKey = null;
        railCellGroupsState = new Map();
        railCellSignaturesState = new Map();
        railCellSurfaceRegionsState = new Map();
        renderedRailSurfaceRevision = 0;
        renderedRailTerrainCutoutRevision = 0;
        renderedRailTerrainCutoutPublishedSignature = '';
        viaductTerrainCutoutRevision = 0;
        viaductTerrainCutoutPublishedSignature = '';
        viaductTerrainCutoutCache = null;
        railCellContextKey = '';
        lastCellRenderedSegments = [];
        railCellQueue?.clear?.();
        railCellBuildToken += 1;
        surfacePublications = null;
        groundPublications = null; getGroundPhysics = null;
        terrainDirtyBounds = [];
        terrainDirtyFullRefresh = false;
        discardPendingRailFormationBuild();
        resetRailCivilGroundSnapshot();
        discardPendingRailVisualRefresh();
        discardPendingRailStructuresRefresh();
        discardPendingCrossingFormationRefresh();
        railDressingQueue?.dispose?.();
        railDressingQueue = null;
        railGpuUploadQueue?.dispose?.();
        railGpuUploadQueue = null;
        railRetirementQueue?.dispose?.();
        railRetirementQueue = null;
        lastSampledTrackbedSegments = [];
        lastTrackSpacingStationFlares = [];
        lastStationFlares = [];
        sampledTrackbedRevision += 1;
        railTrackbedSupportIndex = createStructuralTramTrackbedSupportIndex([]);
        lastFeatures = null;
        lastSwitchRules = null;
        lastDriverGraph = null;
        lastRoutedSegments = null;
        uncoveredSwitchCoverageCache = null;
        lastRampOpenCutVolumes = [];
        lastStops = [];
        lastRenderCenterX = 0;
        lastRenderCenterZ = 0;
        if (lastTerrain && typeof lastTerrain.setRailFormation === 'function') {
            lastTerrain.setRailFormation(null);
        }
        lastTerrain?.setRenderedRailSurface?.(null);
        lastRailFormation?.dispose?.();
        lastRailFormation = null;
        lastRoadFormation = null;
        lastRoadVerticalAlignments = null;
        lastRoadCarriedTramRevision = -1;
        pendingRoadCarriedTramRevision = -1;
        pendingRoadCarriedTramSinceMs = 0;
        lastRoadCarriedTramDeckSignature = '';
        lastEmbeddedTramRoadRevision = -1;
        pendingEmbeddedTramRoadRevision = -1;
        pendingEmbeddedTramRoadSinceMs = 0;
        discardPendingEmbeddedTramMeshRefresh();
        lastRailPillarRoadSignature = '';
        lastRailsHeadingDeg = null;
        lastRailsHeadingChangeMs = 0;
        publishedRailBoundaryInputs = pendingRailBoundaryInputs = null;
        pendingRailBoundarySinceMs = 0;
        levelCrossingAccum = new Map();
        levelCrossingAccumRevision = 0;
        roadUnderRailOpeningAccum = new Map();
        lastPillarClearance = null;
        pillarClearanceReady = false;
        pillarClearanceLoading = false;
        lastTerrain = null;
        lastTerrainSource = null;
        lastPhotoTrackFrame = null;
        lastBridgeStyleLocationId = null;
        lastBridgeStyleCityId = null;
        photoStationStructureRevision = 0;
    },
};

export function getActiveRailTrafficSource() {
    return {
        revision: activeRailTrafficRevision,
        features: Array.isArray(lastFeatures) ? lastFeatures : [],
        // Solved: only reconstructed spans are drivable, so only they carry trains.
        mode: streamedRailProfileMode,
    };
}

export function rebuildRailsForProposalMask() {
    return rebuildVisibleRails();
}
