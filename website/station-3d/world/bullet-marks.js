// Generic "ray-cast against this group, stamp a small dark disc on
// whatever was hit" helper. Used by trams (other-trams group) and
// facades (buildings group). Cars keep their own pathway in cars.js
// for historical reasons; the visual is identical.
//
// The hole is added as a child of the actual mesh that was hit, so it
// inherits that mesh's transform automatically — moves with trams,
// disappears when buildings evict with their tile.
//
// A FIFO cap (`opts.fifoCap`) is provided for facades, where the player
// could otherwise spray indefinitely without anything ever cleaning up.
// Once the cap is exceeded, the oldest hole in the queue is removed.

import * as THREE from 'three';
import { registerShared } from '../core/dispose.js';
import { getBuildingsGroup, isPointInsideBuildingPassageVolume } from './buildings.js';

let _holeGeo = null;
let _holeMat = null;
function getHoleGeo() {
    if (!_holeGeo) {
        _holeGeo = new THREE.CircleGeometry(0.07, 10);
        registerShared(_holeGeo);
    }
    return _holeGeo;
}
function getHoleMat() {
    if (!_holeMat) {
        _holeMat = new THREE.MeshStandardMaterial({
            color: 0x080808,
            roughness: 1.0,
            metalness: 0.0,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
        });
        registerShared(_holeMat);
    }
    return _holeMat;
}

const _ray = new THREE.Raycaster();
const _start = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hitPointLocal = new THREE.Vector3();

// Hard cap on simultaneous facade holes — FIFO eviction once exceeded.
// Trams + cars don't need a cap (they evict with their owners).
const MAX_FIFO_HOLES = 400;
const fifoQueue = [];
let perfStatsEnabled = false;
const perfStats = {
    cachedLineOfSightHits: 0,
    cachedLineOfSightMisses: 0,
    lineOfSightCalls: 0,
    lineOfSightMs: 0,
    impactCalls: 0,
    impactMs: 0,
    stampCalls: 0,
    stampMs: 0,
    raycastCalls: 0,
    raycastMs: 0,
};

function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function beginPerfCall(kind) {
    if (!perfStatsEnabled) return null;
    if (kind === 'lineOfSight') perfStats.lineOfSightCalls += 1;
    else if (kind === 'impact') perfStats.impactCalls += 1;
    else if (kind === 'stamp') perfStats.stampCalls += 1;
    return nowMs();
}

function endPerfCall(kind, startedAt) {
    if (!perfStatsEnabled || startedAt == null) return;
    const elapsedMs = nowMs() - startedAt;
    if (kind === 'lineOfSight') perfStats.lineOfSightMs += elapsedMs;
    else if (kind === 'impact') perfStats.impactMs += elapsedMs;
    else if (kind === 'stamp') perfStats.stampMs += elapsedMs;
}

function intersectFirstRelevantHit(group) {
    const startedAt = perfStatsEnabled ? nowMs() : null;
    const hit = firstRelevantHit(group, _ray.intersectObject(group, true));
    if (perfStatsEnabled && startedAt != null) {
        perfStats.raycastCalls += 1;
        perfStats.raycastMs += nowMs() - startedAt;
    }
    return hit;
}

function projectileSurfaceHit(group, worldX, worldY, worldZ, vx, vy, vz) {
    if (!group) return null;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (speed < 1e-3) return null;
    const ux = vx / speed, uy = vy / speed, uz = vz / speed;

    // Start the ray well behind the impact point along the bullet's
    // path — same trick cars.js uses — so we always intersect the
    // entry-side surface even when the bullet's own position is slightly
    // past the wall.
    const back = 5;
    _start.set(worldX - ux * back, worldY - uy * back, worldZ - uz * back);
    _dir.set(ux, uy, uz);
    _ray.set(_start, _dir);
    _ray.far = 12;
    return intersectFirstRelevantHit(group);
}

function firstRelevantHit(group, hits) {
    if (!Array.isArray(hits) || hits.length === 0) return null;
    if (group !== getBuildingsGroup()) return hits[0];
    for (const hit of hits) {
        if (!hit || !hit.point) continue;
        if (isPointInsideBuildingPassageVolume(hit.point.x, hit.point.y, hit.point.z)) continue;
        return hit;
    }
    return null;
}

// Returns the world-space hit point if a hole was stamped, else null.
// `group` is any Object3D whose descendants we want to ray-test against.
// `opts.fifoCap` enrolls the hole in the global FIFO queue (use for
// facades; skip for trams which clean up with their parent).
export function tryStampHole(group, worldX, worldY, worldZ, vx, vy, vz, opts) {
    const startedAt = beginPerfCall('stamp');
    const hit = projectileSurfaceHit(group, worldX, worldY, worldZ, vx, vy, vz);
    if (!hit || !hit.face) {
        endPerfCall('stamp', startedAt);
        return null;
    }
    const instanceAnchor = hit.object?.isInstancedMesh
        && Number.isInteger(hit.instanceId)
        ? hit.object.userData?.instanceAnchors?.[hit.instanceId]
        : null;
    // Animated tram doors render as one InstancedMesh, but each instance has
    // a transform-only anchor that follows its door leaf. Attach the mark to
    // that anchor so local coordinates and later door motion remain exact.
    const parentMesh = instanceAnchor || hit.object;

    parentMesh.updateMatrixWorld();
    // Convert hit.point (world) → parent-local. hit.face.normal is
    // already in parentMesh's local coordinate system, so we pass it
    // directly to lookAt below.
    _hitPointLocal.copy(hit.point);
    parentMesh.worldToLocal(_hitPointLocal);

    const hole = new THREE.Mesh(getHoleGeo(), getHoleMat());
    hole.position.copy(_hitPointLocal);
    // lookAt is called BEFORE parenting: with no parent, world-space
    // and local-space coincide, so passing local-frame coordinates here
    // produces a rotation that lands correctly once we parent the hole.
    hole.lookAt(
        _hitPointLocal.x + hit.face.normal.x,
        _hitPointLocal.y + hit.face.normal.y,
        _hitPointLocal.z + hit.face.normal.z,
    );
    parentMesh.add(hole);

    if (opts && opts.fifoCap) {
        fifoQueue.push(hole);
        if (fifoQueue.length > MAX_FIFO_HOLES) {
            const old = fifoQueue.shift();
            if (old && old.parent) old.parent.remove(old);
        }
    }
    endPerfCall('stamp', startedAt);
    return hit.point;
}

export function findImpactPoint(group, worldX, worldY, worldZ, vx, vy, vz) {
    const startedAt = beginPerfCall('impact');
    const hit = projectileSurfaceHit(group, worldX, worldY, worldZ, vx, vy, vz);
    endPerfCall('impact', startedAt);
    return hit && hit.point ? hit.point : null;
}

// Straight visibility check against an Object3D hierarchy. Returns true when
// no triangle in `group` lies between start and end. Used by enemy shooters so
// they don't open fire through building facades.
export function hasLineOfSight(group, startX, startY, startZ, endX, endY, endZ, opts) {
    const startedAt = beginPerfCall('lineOfSight');
    if (!group) {
        endPerfCall('lineOfSight', startedAt);
        return true;
    }
    const dx = endX - startX;
    const dy = endY - startY;
    const dz = endZ - startZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-3) {
        endPerfCall('lineOfSight', startedAt);
        return true;
    }

    const targetPad = Math.max(0, Number(opts && opts.targetPad) || 0);
    const far = Math.max(0, dist - targetPad);
    if (far < 1e-3) {
        endPerfCall('lineOfSight', startedAt);
        return true;
    }

    _start.set(startX, startY, startZ);
    _dir.set(dx / dist, dy / dist, dz / dist);
    _ray.set(_start, _dir);
    _ray.far = far;

    const hit = intersectFirstRelevantHit(group);
    endPerfCall('lineOfSight', startedAt);
    return hit == null;
}

export function resolveCachedLineOfSight(group, cache, nowS, startX, startY, startZ, endX, endY, endZ, opts) {
    const maxAgeS = Math.max(0, Number(opts && opts.cacheMaxAgeS) || 0);
    const startMoveM = Math.max(0, Number(opts && opts.cacheStartMoveM) || 0);
    const endMoveM = Math.max(0, Number(opts && opts.cacheEndMoveM) || 0);
    const canReuse = cache && Number.isFinite(nowS) && maxAgeS > 0;
    if (canReuse && Number.isFinite(cache.checkedAtS)) {
        const ageS = nowS - cache.checkedAtS;
        const startDx = startX - cache.startX;
        const startDy = startY - cache.startY;
        const startDz = startZ - cache.startZ;
        const endDx = endX - cache.endX;
        const endDy = endY - cache.endY;
        const endDz = endZ - cache.endZ;
        if (
            ageS >= 0 &&
            ageS <= maxAgeS &&
            (startDx * startDx + startDy * startDy + startDz * startDz) <= startMoveM * startMoveM &&
            (endDx * endDx + endDy * endDy + endDz * endDz) <= endMoveM * endMoveM
        ) {
            if (perfStatsEnabled) perfStats.cachedLineOfSightHits += 1;
            return !!cache.visible;
        }
    }

    if (perfStatsEnabled && canReuse) perfStats.cachedLineOfSightMisses += 1;
    const visible = hasLineOfSight(group, startX, startY, startZ, endX, endY, endZ, opts);
    if (cache) {
        cache.checkedAtS = nowS;
        cache.startX = startX;
        cache.startY = startY;
        cache.startZ = startZ;
        cache.endX = endX;
        cache.endY = endY;
        cache.endZ = endZ;
        cache.visible = visible;
    }
    return visible;
}

// Drop every FIFO-tracked hole. Called on cab session end.
export function clearFifoHoles() {
    for (const hole of fifoQueue) {
        if (hole && hole.parent) hole.parent.remove(hole);
    }
    fifoQueue.length = 0;
}

export function setBulletMarkPerfStatsEnabled(enabled) {
    perfStatsEnabled = !!enabled;
}

export function resetBulletMarkPerfStats() {
    perfStats.cachedLineOfSightHits = 0;
    perfStats.cachedLineOfSightMisses = 0;
    perfStats.lineOfSightCalls = 0;
    perfStats.lineOfSightMs = 0;
    perfStats.impactCalls = 0;
    perfStats.impactMs = 0;
    perfStats.stampCalls = 0;
    perfStats.stampMs = 0;
    perfStats.raycastCalls = 0;
    perfStats.raycastMs = 0;
}

export function getBulletMarkPerfStats() {
    const cachedLineOfSightHits = perfStats.cachedLineOfSightHits;
    const cachedLineOfSightMisses = perfStats.cachedLineOfSightMisses;
    const lineOfSightCalls = perfStats.lineOfSightCalls;
    const impactCalls = perfStats.impactCalls;
    const stampCalls = perfStats.stampCalls;
    const raycastCalls = perfStats.raycastCalls;
    return {
        enabled: perfStatsEnabled,
        cachedLineOfSightHits,
        cachedLineOfSightMisses,
        lineOfSightCalls,
        lineOfSightMs: perfStats.lineOfSightMs,
        lineOfSightAvgMs: lineOfSightCalls > 0 ? perfStats.lineOfSightMs / lineOfSightCalls : 0,
        impactCalls,
        impactMs: perfStats.impactMs,
        impactAvgMs: impactCalls > 0 ? perfStats.impactMs / impactCalls : 0,
        stampCalls,
        stampMs: perfStats.stampMs,
        stampAvgMs: stampCalls > 0 ? perfStats.stampMs / stampCalls : 0,
        raycastCalls,
        raycastMs: perfStats.raycastMs,
        raycastAvgMs: raycastCalls > 0 ? perfStats.raycastMs / raycastCalls : 0,
    };
}
