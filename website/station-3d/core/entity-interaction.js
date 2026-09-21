// Station3D entity registry, overlay highlighter, and pointer-event bridge.

import * as THREE from 'three';
import { DEG_TO_RAD, EARTH_RADIUS_M } from './math.js';
import { EntityRegistry } from './entity-registry.js';
import { ownerRangeForFace } from './geometry-batch.js';

const highlightMaterials = {
    hovered: new THREE.MeshBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        side: THREE.DoubleSide,
    }),
    selected: new THREE.MeshBasicMaterial({
        color: 0xfb923c,
        transparent: true,
        opacity: 0.52,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
        side: THREE.DoubleSide,
    }),
};
for (const [state, material] of Object.entries(highlightMaterials)) {
    material.name = `Station3DEntityHighlight:${state}`;
}

function removeOverlay(object) {
    const overlay = object?.userData?.station3dEntityHighlight;
    if (!overlay) return;
    object.remove(overlay);
    delete object.userData.station3dEntityHighlight;
}

// A registry "object" is either a real mesh (one entity = one mesh, the
// original contract) or a RANGE TARGET — one entity's slice of a merged
// aggregate mesh. Aggregates exist because per-object cost is the render
// floor: 4,267 road meshes became a handful, so a highlight can no longer be
// "clone the picked mesh's geometry" — the picked mesh is the whole road
// network. A range target carries the aggregate and the entity's index range
// instead, and its overlay SHARES the aggregate's attribute and index buffers,
// drawing only its slice via setDrawRange — no geometry is copied to light a
// road up.
function rangeOverlayGeometry(target) {
    const source = target.aggregate.geometry;
    const geometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(source.attributes)) {
        geometry.setAttribute(name, attribute);
    }
    if (source.index) geometry.setIndex(source.index);
    geometry.setDrawRange(target.start, target.count);
    // Shared attribute objects: dispose() on this overlay geometry would tear
    // down the aggregate's GPU buffers, so overlays are removed, never disposed.
    return geometry;
}

function removeRangeOverlay(target) {
    if (!target.overlay) return;
    target.aggregate.remove(target.overlay);
    target.overlay = null;
}

function applyVisualState(object, nextState) {
    if (object?.isEntityRangeTarget) {
        removeRangeOverlay(object);
        if (!nextState || !object.aggregate?.geometry) return;
        const overlay = new THREE.Mesh(rangeOverlayGeometry(object), highlightMaterials[nextState]);
        overlay.name = `EntityHighlight:${nextState}`;
        overlay.renderOrder = (Number(object.aggregate.renderOrder) || 0) + 1000;
        overlay.frustumCulled = false;
        overlay.userData.entityHighlightOverlay = true;
        overlay.raycast = () => {};
        object.aggregate.add(overlay);
        object.overlay = overlay;
        return;
    }
    removeOverlay(object);
    if (!nextState || !object?.isMesh || !object.geometry) return;
    const overlay = new THREE.Mesh(object.geometry, highlightMaterials[nextState]);
    overlay.name = `EntityHighlight:${nextState}`;
    overlay.renderOrder = (Number(object.renderOrder) || 0) + 1000;
    overlay.frustumCulled = object.frustumCulled;
    overlay.userData.entityHighlightOverlay = true;
    overlay.raycast = () => {};
    object.add(overlay);
    object.userData.station3dEntityHighlight = overlay;
}

const registry = new EntityRegistry({ applyVisualState });

// Aggregate meshes that participate in picking. Raycasting goes against these
// plus the legacy per-mesh registrations; a hit on one resolves through its
// face index to the owning entity's range.
const aggregatePickMeshes = new Map();   // aggregateMesh -> refcount

// One call per assembled aggregate: registers every ranged entity and marks
// the aggregate raycastable. Re-assembly re-registers (ranges move when owners
// come and go); the registry's hover/select state re-applies to the new ranges
// by itself, so a selected road stays lit across a rebuild.
export function registerAggregateEntityRanges(aggregate, ranges) {
    if (!aggregate?.isMesh || !Array.isArray(ranges)) return () => {};
    const pickRanges = [];
    const unregisters = [];
    for (const range of ranges) {
        const key = range?.entity?.key;
        if (!key) continue;
        const target = {
            isEntityRangeTarget: true,
            aggregate,
            start: range.start,
            count: range.count,
            overlay: null,
        };
        pickRanges.push({
            start: range.start,
            count: range.count,
            key,
            metadata: range.entity.metadata || null,
        });
        unregisters.push(registry.register(key, target, range.entity.metadata || null));
    }
    if (pickRanges.length === 0) return () => {};
    aggregate.userData.entityRanges = pickRanges;
    aggregatePickMeshes.set(aggregate, (aggregatePickMeshes.get(aggregate) || 0) + 1);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        for (const unregister of unregisters) unregister();
        const refs = (aggregatePickMeshes.get(aggregate) || 1) - 1;
        if (refs <= 0) {
            aggregatePickMeshes.delete(aggregate);
            delete aggregate.userData.entityRanges;
        } else {
            aggregatePickMeshes.set(aggregate, refs);
        }
    };
}

export function registerEntityObject(object, key, metadata = null) {
    if (!object?.isMesh || !object.geometry || object.userData?.entityHighlightOverlay) {
        return () => {};
    }
    object.userData.entityKey = key;
    object.userData.entityMetadata = { ...(metadata || {}), key };
    const unregister = registry.register(key, object, object.userData.entityMetadata);
    object.userData.unregisterEntity = unregister;
    return () => {
        if (object.userData.unregisterEntity === unregister) {
            delete object.userData.unregisterEntity;
        }
        unregister();
    };
}

export function unregisterEntityTree(root) {
    root?.traverse?.((object) => {
        const unregister = object?.userData?.unregisterEntity;
        if (typeof unregister === 'function') unregister();
    });
}

export function setEntityInteractionState(state) {
    registry.setInteractionState(state);
}

export function hasRegisteredEntity(key) {
    return registry.has(key);
}

export function getEntityRegistryDebugState() {
    return registry.snapshot();
}

function geographicHit(point, anchor) {
    const lat = Number(anchor?.lat);
    const lon = Number(anchor?.lon);
    if (!point || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const metersPerDegree = DEG_TO_RAD * EARTH_RADIUS_M;
    return {
        lat: lat - point.z / metersPerDegree,
        lon: lon + point.x / (metersPerDegree * Math.max(0.01, Math.cos(lat * DEG_TO_RAD))),
    };
}

function dispatchEntityEvent(type, record, intersection, anchor) {
    const hit = intersection ? geographicHit(intersection.point, anchor) : null;
    window.dispatchEvent(new CustomEvent(type, {
        detail: {
            key: record?.key || null,
            metadata: record?.metadata || null,
            hit,
        },
    }));
}

export function bindEntityPointerInteraction({
    camera,
    domElement,
    getAnchor,
}) {
    if (!camera || !domElement || domElement.dataset.entityInteractionBound === '1') {
        return () => {};
    }
    domElement.dataset.entityInteractionBound = '1';
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pendingMove = null;
    let moveFrame = null;
    let hoveredKey = null;
    let pointerDown = null;

    const hitAt = (event) => {
        const rect = domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { record: null, intersection: null };
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        // Legacy one-mesh entities raycast directly; range targets are plain
        // objects, so their AGGREGATE mesh stands in for all of them and the
        // face index says which entity the ray actually touched.
        const pickObjects = [
            ...registry.getPickObjects().filter(object => object?.isObject3D),
            ...aggregatePickMeshes.keys(),
        ];
        const intersections = raycaster.intersectObjects(pickObjects, false);
        for (const intersection of intersections) {
            const ranges = intersection.object?.userData?.entityRanges;
            if (ranges) {
                const range = ownerRangeForFace(ranges, intersection.faceIndex);
                if (range?.key) {
                    return {
                        record: { key: range.key, metadata: range.metadata },
                        intersection,
                    };
                }
                // A face no entity claims (an unkeyed road). Before merging,
                // such a mesh was never in the pick list at all, so rays
                // passed through it to whatever entity lay beyond — keep that:
                // skip the face, keep walking the intersections.
                continue;
            }
            const record = registry.resolveObject(intersection.object);
            if (record) return { record, intersection };
        }
        return { record: null, intersection: null };
    };

    const flushMove = () => {
        moveFrame = null;
        const event = pendingMove;
        pendingMove = null;
        if (!event) return;
        const hit = hitAt(event);
        const key = hit.record?.key || null;
        if (key === hoveredKey) return;
        hoveredKey = key;
        dispatchEntityEvent('station3d:entity-hover', hit.record, hit.intersection, getAnchor?.());
    };

    const onMove = (event) => {
        pendingMove = { clientX: event.clientX, clientY: event.clientY };
        if (moveFrame == null) moveFrame = requestAnimationFrame(flushMove);
    };
    const onLeave = () => {
        pendingMove = null;
        if (moveFrame != null) cancelAnimationFrame(moveFrame);
        moveFrame = null;
        if (hoveredKey == null) return;
        hoveredKey = null;
        dispatchEntityEvent('station3d:entity-hover', null, null, getAnchor?.());
    };
    const onDown = (event) => {
        pointerDown = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
        };
    };
    const onUp = (event) => {
        const down = pointerDown;
        pointerDown = null;
        if (!down || down.pointerId !== event.pointerId) return;
        if (event.shiftKey || event.altKey) return;
        if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
        const hit = hitAt(event);
        dispatchEntityEvent('station3d:entity-select', hit.record, hit.intersection, getAnchor?.());
    };

    domElement.addEventListener('pointermove', onMove);
    domElement.addEventListener('pointerleave', onLeave);
    domElement.addEventListener('pointerdown', onDown);
    domElement.addEventListener('pointerup', onUp);

    return () => {
        if (moveFrame != null) cancelAnimationFrame(moveFrame);
        domElement.removeEventListener('pointermove', onMove);
        domElement.removeEventListener('pointerleave', onLeave);
        domElement.removeEventListener('pointerdown', onDown);
        domElement.removeEventListener('pointerup', onUp);
        delete domElement.dataset.entityInteractionBound;
    };
}
