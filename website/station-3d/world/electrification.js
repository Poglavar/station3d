// Streams non-interactive overhead equipment in atomic 600 m cells over rendered rails.

import * as THREE from 'three';
import { getThinFeatureDistanceM, scene } from '../scene/setup.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import {
    createFrameChunkQueue,
    FRAME_CHUNK_REPEAT_ITEM,
} from '../core/frame-chunk-queue.js';
import { disposeGroup, registerShared, unregisterShared } from '../core/dispose.js';
import {
    cellKeyAt,
    createChangedElectrificationCellKeysTask,
    createElectrificationSpanStagingTask,
    createOwnedElectrificationSpansTask,
    electrificationCellKeysTouchingBounds,
    electrificationCellSignature,
    electrificationNeighborhoodSignature,
    groupParallelSupports,
    selectStreamingCells,
} from '../core/electrification-cells.js';
import { createPillarClearanceEvaluatorSteps } from '../core/pillar-clearance.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { ensureRoadIndex } from '../core/road-index.js';
import {
    createSettleGate,
    markSettleGateApplied,
    shouldRunOnSettle,
} from '../core/settle-gate.js';
import { getSampledRailTrackbedSegments } from './rails.js';

const CATENARY_ROAD_CENTER_CLEARANCE_M = 4.75;
// Wider than the largest rendered single-track bed (standard gauge + 0.5 m
// shoulders) plus the 9 cm mast half-width.
const CATENARY_TRACK_CENTER_CLEARANCE_M = 1.4;
// A road tile burst can publish several complete formation generations. Each
// catenary invalidation cancels every affected cell job, so wait for a genuine
// quiet spell and apply the union of those bounded changes once. Sixty frames
// is 0.5 s at the laptop's native 120 Hz and 1 s at the 60 Hz product target;
// the cap preserves eventual progress during continuous streaming.
const ROAD_FORMATION_QUIET_FRAMES = 60;
const ROAD_FORMATION_MAX_DEFERRED_FRAMES = 240;

const buildQueue = createFrameChunkQueue({
    label: 'electrification',
    frameBudgetMs: 2,
    pauseDuringMovement: false,
    preferAnimationFrame: true,
    trackWorldReady: false,
    workClass: 'near',
});

let enabled = false;
let rootGroup = null;
let generation = 0;
let sampledRevision = -1;
let pendingSampledRevision = -1;
let sampledAlignmentJob = null;
let spansByCell = new Map();
let cellSignatures = new Map();
let observer = { x: 0, z: 0 };
let streamingObserver = { x: 0, z: 0 };
const cellGroups = new Map();
const cellJobs = new Map();
const pendingCellRebuilds = new Set();
let mastGeometry = null;
let crossarmGeometry = null;
let equipmentMaterial = null;
let wireMaterial = null;
let supportClearance = null;
let supportRoadbedAt = null;
let supportRoadbedReady = false;
let supportLocationId = 'zagreb';
let supportRoadFormation = null;
let supportRoadRevision = -1;
let supportSessionToken = 0;
let supportClearanceJob = null;
let supportRoadSettleGate = createSettleGate({
    quietFrames: ROAD_FORMATION_QUIET_FRAMES,
    maxDeferredFrames: ROAD_FORMATION_MAX_DEFERRED_FRAMES,
});

// A RoadFormationModel revision becomes readable only after its complete
// spatial indexes have been published. Keep the previous observed revision
// while a replacement is building so its bounded invalidation is applied once
// publication finishes.
function publishedRoadRevision(model, fallback = -1) {
    if (model?.hasPendingBuild?.() === true) return fallback;
    const revision = Number(model?.revision);
    return Number.isInteger(revision) ? revision : fallback;
}

const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0);

function selectQualityBoundedStreamingCells(cells) {
    const activeM = getThinFeatureDistanceM();
    return selectStreamingCells(cells, observer, {
        preloadM: activeM,
        activeM,
        evictM: activeM + 600,
    });
}

function killSwitchIsOff() {
    if (typeof location === 'undefined') return false;
    return new URLSearchParams(location.search).get('electrification') === '0';
}

function ensureResources() {
    if (rootGroup) return;
    rootGroup = new THREE.Group();
    rootGroup.name = 'TrackElectrification';
    rootGroup.userData.nonInteractive = true;
    markInspectionLayer(rootGroup, {
        id: 'rail-electrification',
        label: 'Rail electrification',
        category: 'Transport',
        source: 'world/electrification.js · catenary masts, equipment, and wires',
        order: 158,
    });
    scene.add(rootGroup);
    mastGeometry = new THREE.BoxGeometry(0.18, 1, 0.18);
    crossarmGeometry = new THREE.BoxGeometry(1, 0.12, 0.12);
    equipmentMaterial = new THREE.MeshStandardMaterial({
        color: 0x59636f,
        roughness: 0.78,
        metalness: 0.35,
    });
    wireMaterial = new THREE.LineBasicMaterial({
        color: 0x3b434b,
        transparent: true,
        opacity: 0.92,
    });
    registerShared(mastGeometry, crossarmGeometry, equipmentMaterial, wireMaterial);
}

function disablePicking(object) {
    object.raycast = () => {};
    object.castShadow = false;
    object.receiveShadow = false;
    object.frustumCulled = true;
}

function composeMesh(geometry, material, transforms, name) {
    if (!transforms.length) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
    mesh.name = name;
    transforms.forEach((transform, index) => {
        position.set(transform.x, transform.y, transform.z);
        quaternion.setFromAxisAngle(yAxis, transform.rotationY || 0);
        scale.set(transform.scaleX, transform.scaleY, transform.scaleZ);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    disablePicking(mesh);
    return mesh;
}

function publishCell(key, staging, active) {
    if (!rootGroup) return null;
    const group = new THREE.Group();
    group.name = `ElectrificationCell:${key}`;
    group.visible = active;
    group.userData.nonInteractive = true;

    if (staging.linePositions.length) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(staging.linePositions, 3),
        );
        geometry.computeBoundingSphere();
        const wires = new THREE.LineSegments(geometry, wireMaterial);
        wires.name = 'ContactMessengerDroppers';
        disablePicking(wires);
        group.add(wires);
    }

    const mastTransforms = [];
    const crossarmTransforms = [];
    for (const support of staging.supports) {
        // Preserve the staged foundation exactly. Zagreb tram supports always
        // carry one foot: a centre T on road-free double track, or a side L.
        // Heavy-rail grouping may still provide more than one mast point.
        const mastPoints = Array.isArray(support.mastPoints)
            && support.mastPoints.length > 0
            ? support.mastPoints
            : [{ x: support.x, y: support.y, z: support.z }];
        for (const mastPoint of mastPoints) {
            mastTransforms.push({
                x: mastPoint.x,
                y: mastPoint.y + 3.3,
                z: mastPoint.z,
                rotationY: 0,
                scaleX: 1,
                scaleY: 6.6,
                scaleZ: 1,
            });
        }
        const crossarmCenter = support.crossarmCenter || support;
        crossarmTransforms.push({
            x: crossarmCenter.x,
            y: crossarmCenter.y + 6.35,
            z: crossarmCenter.z,
            rotationY: Number.isFinite(support.crossarmRotationY)
                ? support.crossarmRotationY
                : -support.heading,
            scaleX: support.crossarmWidthM,
            scaleY: 1,
            scaleZ: 1,
        });
    }
    const masts = composeMesh(
        mastGeometry,
        equipmentMaterial,
        mastTransforms,
        'CatenaryMasts',
    );
    const crossarms = composeMesh(
        crossarmGeometry,
        equipmentMaterial,
        crossarmTransforms,
        'CatenaryCrossarmsAndGantries',
    );
    if (masts) group.add(masts);
    if (crossarms) group.add(crossarms);
    const previous = cellGroups.get(key) || null;
    // Publish first, then retire the previous cell. The wires therefore never
    // disappear while an equivalent or updated rail cell stages off-scene.
    rootGroup.add(group);
    cellGroups.set(key, group);
    pendingCellRebuilds.delete(key);
    if (previous && previous !== group) disposeGroup(previous);
    return group;
}

function haloSpans(key) {
    const [cellX, cellZ] = key.split(':').map(Number);
    const spans = [];
    const centerX = (cellX + 0.5) * 600;
    const centerZ = (cellZ + 0.5) * 600;
    for (let z = cellZ - 1; z <= cellZ + 1; z++) {
        for (let x = cellX - 1; x <= cellX + 1; x++) {
            if (x === cellX && z === cellZ) continue;
            const neighbor = spansByCell.get(`${x}:${z}`) || [];
            let closest = null;
            let closestDistance = Infinity;
            for (const span of neighbor) {
                // midX/midZ come from ownedElectrificationSpans. This read
                // span.start.x/.end.x, which no span has ever carried, so it
                // threw on the first neighbouring cell that had any spans —
                // taking the whole layer down on every attempt, forever.
                if (!Number.isFinite(span?.midX) || !Number.isFinite(span?.midZ)) continue;
                const distance = Math.hypot(span.midX - centerX, span.midZ - centerZ);
                if (distance < closestDistance) {
                    closest = span;
                    closestDistance = distance;
                }
            }
            if (closest) spans.push(closest);
        }
    }
    return spans;
}

function buildSignatureForCell(key) {
    return electrificationNeighborhoodSignature(key, cellSignatures);
}

function queueCell(key, active, force = false) {
    if (cellGroups.has(key) && !force) {
        cellGroups.get(key).visible = active;
        return;
    }
    if (cellJobs.has(key)) return;
    const ownSpans = spansByCell.get(key) || [];
    const neighboringSpans = haloSpans(key);
    const staging = { linePositions: [], supports: [], haloSupports: [] };
    const myGeneration = generation;
    const myBuildSignature = buildSignatureForCell(key);
    const items = [
        ...ownSpans.map(span => ({ kind: 'own', span, task: null })),
        ...neighboringSpans.map(span => ({ kind: 'halo', span, task: null })),
    ];
    const job = buildQueue.enqueue(items, item => {
        if (!item.task) {
            item.task = createElectrificationSpanStagingTask(item.span, {
                supportClearance,
                roadbedAt: supportRoadbedAt,
            });
        }
        const outcome = item.task.step();
        if (!outcome.done) return FRAME_CHUNK_REPEAT_ITEM;
        const partial = outcome.value;
        if (item.kind === 'own') {
            staging.linePositions.push(...partial.linePositions);
            staging.supports.push(...partial.supports);
        } else {
            staging.haloSupports.push(...partial.supports);
        }
    }, {
        // Each resumable stage performs at most one clearance probe and the
        // queue checks its 2 ms deadline after every stage. An item-count cap
        // made throughput depend on display Hz: the same cheap work received
        // four times fewer slots at 30 Hz than at 120 Hz while leaving most of
        // the time budget unused.
        describeItem: item => item.task?.phaseLabel?.()
            || `${item.kind} span setup`,
        priority: () => {
            const [cellX, cellZ] = key.split(':').map(Number);
            const centerX = (cellX + 0.5) * 600;
            const centerZ = (cellZ + 0.5) * 600;
            return -Math.hypot(centerX - observer.x, centerZ - observer.z);
        },
        onComplete: () => {
            cellJobs.delete(key);
            if (myGeneration !== generation
                || !spansByCell.has(key)
                || myBuildSignature !== buildSignatureForCell(key)) return;
            const grouped = groupParallelSupports([
                ...staging.supports,
                ...staging.haloSupports,
            ], { roadbedAt: supportRoadbedAt })
                .filter(support => cellKeyAt(support.x, support.z) === key);
            staging.supports = grouped;
            staging.haloSupports = [];
            const selected = selectQualityBoundedStreamingCells(spansByCell);
            if (!selected.retain.has(key)) return;
            publishCell(key, staging, selected.active.has(key));
        },
        onCancel: () => {
            cellJobs.delete(key);
        },
    });
    cellJobs.set(key, job);
}

function removeCell(key) {
    const job = cellJobs.get(key);
    if (job) buildQueue.cancel(job);
    cellJobs.delete(key);
    const group = cellGroups.get(key);
    if (group) disposeGroup(group);
    cellGroups.delete(key);
    pendingCellRebuilds.delete(key);
}

function refreshStreaming() {
    const selected = selectQualityBoundedStreamingCells(spansByCell);
    for (const key of [...cellGroups.keys(), ...cellJobs.keys()]) {
        if (!selected.retain.has(key)) removeCell(key);
    }
    for (const item of selected.preload) {
        queueCell(
            item.key,
            selected.active.has(item.key),
            pendingCellRebuilds.has(item.key),
        );
    }
    for (const [key, group] of cellGroups) group.visible = selected.active.has(key);
    streamingObserver = { ...observer };
}

function applySampledAlignmentRefresh(refresh) {
    if (refresh.revision !== pendingSampledRevision) return false;
    sampledRevision = refresh.revision;
    pendingSampledRevision = -1;
    spansByCell = refresh.nextSpansByCell;
    cellSignatures = refresh.nextSignatures;
    for (const key of refresh.changedKeys) {
        const job = cellJobs.get(key);
        if (job) buildQueue.cancel(job);
        if (!spansByCell.has(key)) {
            removeCell(key);
            continue;
        }
        pendingCellRebuilds.add(key);
    }
    refreshStreaming();
    return refresh.changedKeys.length > 0;
}

function createSampledAlignmentRefresh(snapshot) {
    const ownershipTask = createOwnedElectrificationSpansTask(
        snapshot.segments,
        globalThis.__trackElectrification,
        // One chord per visit lets the existing queue check its time budget
        // between source chords rather than after a fixed batch of 32.
        { locationId: supportLocationId, segmentsPerStep: 1 },
    );
    const refresh = {
        revision: snapshot.revision,
        ownershipTask,
        nextSpansByCell: null,
        nextSignatures: new Map(),
        signatureEntries: null,
        signatureIndex: 0,
        diffTask: null,
        changedKeys: [],
        phase: 'ownership',
        phaseLabel() {
            if (this.phase === 'ownership') return ownershipTask.phaseLabel();
            if (this.phase === 'signatures') {
                return `cell signatures ${this.signatureIndex}/${this.signatureEntries.length}`;
            }
            if (this.phase === 'diff') return this.diffTask.phaseLabel();
            return this.phase;
        },
        step() {
            if (this.phase === 'ownership') {
                const outcome = ownershipTask.step();
                if (!outcome.done) return false;
                this.nextSpansByCell = outcome.value;
                this.signatureEntries = [...this.nextSpansByCell.entries()];
                this.phase = 'signatures';
                return false;
            }
            if (this.phase === 'signatures') {
                if (this.signatureIndex < this.signatureEntries.length) {
                    const [key, spans] = this.signatureEntries[this.signatureIndex];
                    this.nextSignatures.set(key, electrificationCellSignature(spans));
                    this.signatureIndex += 1;
                    return false;
                }
                this.diffTask = createChangedElectrificationCellKeysTask(
                    cellSignatures,
                    this.nextSignatures,
                );
                this.phase = 'diff';
                return false;
            }
            if (this.phase === 'diff') {
                const outcome = this.diffTask.step();
                if (!outcome.done) return false;
                this.changedKeys = outcome.value;
                this.diffTask = null;
                this.phase = 'publish';
                return false;
            }
            applySampledAlignmentRefresh(this);
            this.phase = 'done';
            return true;
        },
    };
    return refresh;
}

function refreshSampledAlignment() {
    const snapshot = getSampledRailTrackbedSegments();
    if (snapshot.revision === sampledRevision
        || snapshot.revision === pendingSampledRevision) return false;
    if (sampledAlignmentJob) buildQueue.cancel(sampledAlignmentJob);
    const refresh = createSampledAlignmentRefresh(snapshot);
    pendingSampledRevision = snapshot.revision;
    sampledAlignmentJob = buildQueue.enqueue([refresh], item => {
        if (!item.step()) return FRAME_CHUNK_REPEAT_ITEM;
        return undefined;
    }, {
        // Repeated ownership stages consume the queue's bounded time slice.
        // One stage per display frame starved every cell job behind this
        // high-priority refresh when streamed rail revisions kept restarting it.
        priority: 1000,
        describeItem: item => item.phaseLabel(),
        onComplete: () => {
            sampledAlignmentJob = null;
        },
        onCancel: () => {
            if (pendingSampledRevision === refresh.revision) {
                pendingSampledRevision = -1;
            }
            sampledAlignmentJob = null;
        },
        onError: () => {
            if (pendingSampledRevision === refresh.revision) {
                pendingSampledRevision = -1;
            }
            sampledAlignmentJob = null;
        },
    });
    return true;
}

function rebuildCellsForSupportClearance() {
    generation += 1;
    buildQueue.clear();
    cellJobs.clear();
    for (const key of spansByCell.keys()) pendingCellRebuilds.add(key);
    refreshStreaming();
}

function invalidateCellsForRoadFormationChanges() {
    const revision = publishedRoadRevision(
        supportRoadFormation,
        supportRoadRevision,
    );
    if (!Number.isInteger(revision) || revision === supportRoadRevision) return false;
    if (!shouldRunOnSettle(supportRoadSettleGate, revision)) return false;
    const changes = typeof supportRoadFormation?.getChangesSince === 'function'
        ? supportRoadFormation.getChangesSince(supportRoadRevision)
        : { revision, full: true, bounds: [] };
    supportRoadRevision = revision;
    const affectedKeys = changes.full
        ? [...spansByCell.keys()]
        : electrificationCellKeysTouchingBounds(
            spansByCell.keys(),
            changes.bounds,
            // A side mast may search beyond a broad carriageway before it
            // reaches pavement or verge; include that reach across cell edges.
            { paddingM: 20 },
        );
    for (const key of affectedKeys) {
        const job = cellJobs.get(key);
        if (job) buildQueue.cancel(job);
        cellJobs.delete(key);
        pendingCellRebuilds.add(key);
    }
    return affectedKeys.length > 0;
}

function disposeResources() {
    if (rootGroup) {
        disposeGroup(rootGroup);
        rootGroup = null;
    }
    unregisterShared(mastGeometry, crossarmGeometry, equipmentMaterial, wireMaterial);
    mastGeometry?.dispose();
    crossarmGeometry?.dispose();
    equipmentMaterial?.dispose();
    wireMaterial?.dispose();
    mastGeometry = null;
    crossarmGeometry = null;
    equipmentMaterial = null;
    wireMaterial = null;
}

function queueSupportClearance(anchorLat, anchorLon, trackFeatures, token) {
    if (supportClearanceJob) buildQueue.cancel(supportClearanceJob);
    const current = () => enabled && token === supportSessionToken;
    const steps = createPillarClearanceEvaluatorSteps(anchorLat, anchorLon, trackFeatures, {
        roadClearanceM: CATENARY_ROAD_CENTER_CLEARANCE_M,
        trackClearanceM: CATENARY_TRACK_CENTER_CLEARANCE_M,
        // A gap between car carriageways does not authorize a tram pole.
        // The dedicated-track exception uses exact road-surface evidence.
        allowDividedRoadMedian: false,
        isCurrent: current,
    });
    let prepared = null;
    const job = buildQueue.enqueue([steps], () => {
        const next = steps.next();
        if (!next.done) return FRAME_CHUNK_REPEAT_ITEM;
        prepared = next.value;
    }, {
        priority: 1e12,
        describeItem: () => 'catenary support clearance',
        onComplete() {
            if (supportClearanceJob === job) supportClearanceJob = null;
            if (!current()) return;
            supportClearance = prepared;
            supportRoadbedAt = (x, z) => !!supportRoadFormation?.publishedSurfaceAtLocal?.(x, z);
            supportRoadbedReady = true;
            supportRoadRevision = publishedRoadRevision(supportRoadFormation, supportRoadRevision);
            markSettleGateApplied(supportRoadSettleGate, supportRoadRevision);
            rebuildCellsForSupportClearance();
        },
        onCancel() {
            steps.return();
            if (supportClearanceJob === job) supportClearanceJob = null;
        },
        onError() {
            steps.return();
            if (supportClearanceJob === job) supportClearanceJob = null;
        },
    });
    supportClearanceJob = job;
}

export const electrificationLayer = {
    beginSession({
        anchorLat,
        anchorLon,
        otherTracks,
        roadFormation,
        locationId = 'zagreb',
    } = {}) {
        const mySupportSession = ++supportSessionToken;
        if (supportClearanceJob) buildQueue.cancel(supportClearanceJob);
        generation += 1;
        sampledRevision = -1;
        pendingSampledRevision = -1;
        sampledAlignmentJob = null;
        observer = { x: 0, z: 0 };
        streamingObserver = { x: 0, z: 0 };
        supportRoadbedReady = false;
        enabled = !killSwitchIsOff() && !!globalThis.__trackElectrification;
        if (!enabled) return;
        // No mast appears until the citywide road index is ready. Wires may
        // stream immediately; after clearance resolves the small cell batches
        // rebuild once with only legal foundations.
        supportClearance = () => -Infinity;
        supportRoadbedAt = () => true;
        supportLocationId = String(locationId || 'zagreb').toLowerCase();
        supportRoadFormation = roadFormation || null;
        supportRoadRevision = publishedRoadRevision(supportRoadFormation);
        supportRoadSettleGate = createSettleGate({
            quietFrames: ROAD_FORMATION_QUIET_FRAMES,
            maxDeferredFrames: ROAD_FORMATION_MAX_DEFERRED_FRAMES,
        });
        markSettleGateApplied(supportRoadSettleGate, supportRoadRevision);
        ensureResources();
        refreshSampledAlignment();
        refreshStreaming();
        void ensureRoadIndex().then(() => {
            if (!enabled || mySupportSession !== supportSessionToken) return;
            // Build from the last atomically published road snapshot. A dirty
            // road formation no longer wedges every catenary item; publication
            // later invalidates only cells touching the changed road bounds.
            queueSupportClearance(anchorLat, anchorLon, otherTracks || [], mySupportSession);
        });
    },
    onFrame(_pose, local) {
        if (!enabled || !local) return;
        const startedMs = performance.now();
        const x = Number(local.x);
        const z = Number(local.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return;
        // Priorities follow every frame; cell selection follows distance since
        // its last reconciliation, not a 20 m jump within one display frame.
        const moved = Math.hypot(x - streamingObserver.x, z - streamingObserver.z) >= 20;
        observer = { x, z };
        const roadChanged = invalidateCellsForRoadFormationChanges();
        const roadInvalidationFinishedMs = performance.now();
        const changed = refreshSampledAlignment();
        const alignmentFinishedMs = performance.now();
        if (changed || roadChanged || moved) refreshStreaming();
        const finishedMs = performance.now();
        recordLayerFrameMs(
            'electrification:roadInvalidation',
            roadInvalidationFinishedMs - startedMs,
        );
        recordLayerFrameMs(
            'electrification:alignment',
            alignmentFinishedMs - roadInvalidationFinishedMs,
        );
        recordLayerFrameMs(
            'electrification:streaming',
            finishedMs - alignmentFinishedMs,
        );
    },
    endSession() {
        supportSessionToken += 1;
        enabled = false;
        generation += 1;
        buildQueue.clear();
        supportClearanceJob = null;
        sampledAlignmentJob = null;
        for (const key of [...cellGroups.keys(), ...cellJobs.keys()]) removeCell(key);
        cellGroups.clear();
        cellJobs.clear();
        pendingCellRebuilds.clear();
        spansByCell = new Map();
        cellSignatures = new Map();
        sampledRevision = -1;
        pendingSampledRevision = -1;
        supportClearance = null;
        supportRoadbedAt = null;
        supportRoadbedReady = false;
        supportLocationId = 'zagreb';
        supportRoadFormation = null;
        supportRoadRevision = -1;
        supportRoadSettleGate = createSettleGate({
            quietFrames: ROAD_FORMATION_QUIET_FRAMES,
            maxDeferredFrames: ROAD_FORMATION_MAX_DEFERRED_FRAMES,
        });
        disposeResources();
    },
};
