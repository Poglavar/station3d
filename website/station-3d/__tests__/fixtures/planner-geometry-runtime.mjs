import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import * as math from '../../core/math.js';
import * as layout from '../../world/planner-station-layout.js';
import * as corridor from '../../world/track-corridors.js';
import * as dimensions from '../../world/tram-trackbed-dimensions.js';
import * as station from '../../core/station-contract.js';
import * as opening from '../../core/planner-opening-boundaries.js';
import { capturePlannerTrackSegments as collectSegments, capturePlannerTrackSegmentsSteps } from '../../core/planner-track-segments.js';
import { buildEnclosedSpanIndex } from '../../core/tunnel-occlusion.js';
import { planTunnelDistanceMarkers } from '../../core/tunnel-distance-markers.js';
import { disposeGroup } from '../../core/dispose.js';
import { createPlannerGeometryBudget } from '../../core/planner-geometry-budget.js';
import { prepareIndexedSurfaceGeometrySteps } from '../../core/indexed-surface-geometry.js';
import * as groundState from '../../core/planner-ground-state.js';
import { captureBackedOpeningTrianglesSteps } from '../../core/backed-opening-triangles.js';
import * as publication from '../../core/planner-elevation-publication.js';
import * as hierarchy from '../../core/surface-hierarchy.js';
import { markSurfaceClaim } from '../../core/surface-claim.js';
import { markInspectionLayer } from '../../core/scene-inspection.js';
import { captureReceiverMeshReadSteps } from '../../core/receiver-mesh-read.js';
import { EMPTY_RECEIVER_SUPPORT_READ } from '../../core/receiver-support-read.js';
import { createSurfaceOpeningReadSteps } from '../../core/surface-opening-read.js';
import { GROUND_GENERATION_LIMITS } from '../../core/ground-generation-limits.js';
import * as maskState from '../../world/planner-surface-cutout.js';
import { preparePlannerCutoutMaskSteps } from '../../world/planner-cutout-mask.js';
import { createPillarClearanceEvaluatorSteps } from '../../core/pillar-clearance.js';
const hash = data => createHash('sha256').update(data).digest('hex');
export function createPlannerGeometryRuntime({ trackResources = false,
    sourceFile = new URL('../../world/planner-elevation.js', import.meta.url) } = {}) {
    const markers = [], resources = new Map(), three = { ...THREE };
    if (trackResources) for (const name of ['BufferGeometry', 'BoxGeometry', 'InstancedMesh',
        'MeshStandardMaterial', 'MeshLambertMaterial', 'MeshBasicMaterial']) {
        three[name] = class extends THREE[name] {
            constructor(...args) { super(...args); resources.set(this, 0);
                this.addEventListener('dispose', () => resources.set(this, resources.get(this) + 1)); }
        };
    }
    const context = vm.createContext({ THREE: three, mergeVertices, performance,
        ...math, ...layout, ...corridor, ...dimensions, ...station, ...opening, ...groundState,
        segmentWalkHalfWidthM: groundState.plannerSegmentWalkHalfWidthM,
        walkIndexKey: groundState.plannerWalkIndexKey, WALK_INDEX_CELL_M: groundState.PLANNER_WALK_INDEX_CELL_M,
        makeStructureJoinVector: opening.plannerStructureJoinVector, collectSegments, capturePlannerTrackSegmentsSteps,
        createPlannerGeometryBudget, prepareIndexedSurfaceGeometrySteps, buildEnclosedSpanIndex, planTunnelDistanceMarkers, disposeGroup,
        captureBackedOpeningTrianglesSteps, ...publication, ...hierarchy, markSurfaceClaim, markInspectionLayer,
        captureReceiverMeshReadSteps, EMPTY_RECEIVER_SUPPORT_READ, createSurfaceOpeningReadSteps, GROUND_GENERATION_LIMITS,
        ...maskState, createPillarClearanceEvaluatorSteps,
        scene: new THREE.Scene(), renderer: null, camera: new THREE.PerspectiveCamera(),
        // Geometry/state tests stub only GPU upload and canvas pixel drawing.
        // Real Three textures, masks, claims, topology and publication remain.
        prewarmDetachedObject: function* () {},
        preparePlannerCutoutMaskSteps: (regions, options) => preparePlannerCutoutMaskSteps(regions, { ...options,
            createCanvas: () => ({ getContext: () => ({ fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {} }) }) }),
        buildTunnelMarkerPlates(rows) { markers.push(...rows); return []; } });
    const source = readFileSync(sourceFile, 'utf8');
    vm.runInContext(source.replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, ''), context);
    vm.runInContext('getConcreteTexture = () => null;', context);
    return { context, markers, resources };
}
export function plannerGeometrySignature(root, markers) {
    const meshes = [];
    root.traverse(mesh => {
        if (!mesh.isMesh) return;
        const arrays = {};
        for (const [key, value] of Object.entries({ index: mesh.geometry.index, ...mesh.geometry.attributes,
            instanceMatrix: mesh.instanceMatrix, instanceColor: mesh.instanceColor })) if (value) {
            const a = value.array;
            arrays[key] = { type: a.constructor.name, length: a.length,
                sha256: hash(Buffer.from(a.buffer, a.byteOffset, a.byteLength)) };
        }
        meshes.push({ name: mesh.name, type: mesh.type, count: mesh.count ?? null, arrays });
    });
    return JSON.parse(JSON.stringify({ meshes, enclosedSpans: root.userData.enclosedTunnelSpans, markers }));
}
export function plannerFixtureSegments(features) {
    return collectSegments(features, 45, 16, { absoluteToSceneY: y => y - 100, groundSceneYAtLocal: () => 3 });
}
