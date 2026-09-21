import { finiteOrNull } from './math.js';

// Retain the failed obligation, but do not rebuild the same heavy trimeshes
// every held frame. New source revisions/owners or a moved bubble can retry
// immediately; the unchanged request uses the existing content-refresh rate
// for at most three attempts, then waits for new evidence or capacity.
export function fixedSurfaceRetryReady(previous, inputs, nowMs, retryAfterMs) {
    return !previous || inputs.length !== previous.inputs.length
        || inputs.some((value, index) => !Object.is(value, previous.inputs[index]))
        || ((previous.attempts ?? 1) < 3 && nowMs - previous.atMs >= retryAfterMs);
}

export function colliderBubbleNeedsRefresh(center, next, refreshMoveM) {
    if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.z)) return true;
    const dx = Number(next?.x) - center.x;
    const dz = Number(next?.z) - center.z;
    return Number.isFinite(dx) && Number.isFinite(dz)
        && dx * dx + dz * dz >= Math.max(0, Number(refreshMoveM) || 0) ** 2;
}

// A replacement may build privately while the vehicle uses the complete old
// bubble. Include its footprint and next-step travel before admitting motion.
export function colliderCoverageContains(coverage, pose, paddingM) {
    const values = [coverage?.centerX, coverage?.centerZ, coverage?.radiusM,
        pose?.x, pose?.z, paddingM].map(finiteOrNull);
    if (values.some(value => value === null)) return false;
    const [centerX, centerZ, radiusM, x, z, padding] = values;
    return padding >= 0 && radiusM >= padding
        && Math.hypot(x - centerX, z - centerZ) <= radiusM - padding;
}

// Streamed road/alignment sources publish one global revision even when the
// changed tile is kilometres from the player. Rebuilding the local Rapier
// bubble for every such publication can force unrelated model preparation and
// stall the frame. Change histories carry local AABBs, so only revisions whose
// bounds touch the active bubble need a collider refresh. Unknown/full changes
// deliberately fail safe and rebuild.
export function colliderBubbleTouchesChanges(changes, center, radiusM) {
    if (!changes || changes.full === true) return true;
    const x = finiteOrNull(center?.x);
    const z = finiteOrNull(center?.z);
    const radius = finiteOrNull(radiusM);
    if (x === null || z === null || radius === null || radius < 0) return true;
    const bounds = Array.isArray(changes.bounds) ? changes.bounds : [];
    for (const entry of bounds) {
        const minX = finiteOrNull(entry?.minX);
        const minZ = finiteOrNull(entry?.minZ);
        const maxX = finiteOrNull(entry?.maxX);
        const maxZ = finiteOrNull(entry?.maxZ);
        if ([minX, minZ, maxX, maxZ].some(value => value === null)
            || maxX < minX || maxZ < minZ) return true;
        const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
        const dz = z < minZ ? minZ - z : z > maxZ ? z - maxZ : 0;
        if (dx * dx + dz * dz <= radius * radius) return true;
    }
    return false;
}

export function resolvePhysicsRebase(origin, worldPoint, thresholdM = 2000) {
    const oldX = Number(origin?.x) || 0;
    const oldZ = Number(origin?.z) || 0;
    const x = Number(worldPoint?.x);
    const z = Number(worldPoint?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    if (Math.hypot(x - oldX, z - oldZ) < Math.max(1, Number(thresholdM) || 0)) return null;
    return { x, z, dx: x - oldX, dz: z - oldZ };
}

export function collisionInvolvesHandle(firstHandle, secondHandle, targetHandle) {
    if (targetHandle === null || targetHandle === undefined) return false;
    return firstHandle === targetHandle || secondHandle === targetHandle;
}

function boxAxes(yaw) {
    const angle = Number(yaw) || 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
        { x: cos, z: -sin },
        { x: sin, z: cos },
    ];
}

function projectedRadius(axes, halfX, halfZ, axis) {
    return Math.abs(axes[0].x * axis.x + axes[0].z * axis.z) * halfX
        + Math.abs(axes[1].x * axis.x + axes[1].z * axis.z) * halfZ;
}

// A deterministic parked-car placement can sit a few centimetres inside an
// imperfect OSM wall, lamp or civil box. Adding that collider after the
// chassis exists produces an enormous depenetration impulse before the player
// has touched the throttle. This SAT test lets the entry transition reserve
// only the car's original footprint; ordinary collisions remain solid as soon
// as the car has driven clear of that small zone.
export function colliderSpecOverlapsVehicle(spec, vehicle, paddingM = 0) {
    const specX = Number(spec?.x);
    const specZ = Number(spec?.z);
    const vehicleX = Number(vehicle?.x);
    const vehicleZ = Number(vehicle?.z);
    const padding = Math.max(0, Number(paddingM) || 0);
    const specHalfX = Math.max(0, Number(spec?.halfX) || 0);
    const specHalfZ = Math.max(0, Number(spec?.halfZ) || 0);
    const vehicleHalfX = Math.max(0, Number(vehicle?.halfWidthM) || 0) + padding;
    const vehicleHalfZ = Math.max(0, Number(vehicle?.halfLengthM) || 0) + padding;
    if (![specX, specZ, vehicleX, vehicleZ].every(Number.isFinite)
        || specHalfX <= 0 || specHalfZ <= 0
        || vehicleHalfX <= 0 || vehicleHalfZ <= 0) return false;

    const specY = Number(spec?.y);
    const specHalfY = Math.max(0, Number(spec?.halfY) || 0);
    const vehicleY = Number(vehicle?.centerY);
    const vehicleHalfY = Math.max(0, Number(vehicle?.halfHeightM) || 0);
    if ([specY, vehicleY].every(Number.isFinite) && specHalfY > 0 && vehicleHalfY > 0
        && Math.abs(specY - vehicleY) > specHalfY + vehicleHalfY + padding) return false;

    const specAxes = boxAxes(spec?.yaw);
    const vehicleAxes = boxAxes(vehicle?.heading);
    const delta = { x: vehicleX - specX, z: vehicleZ - specZ };
    for (const axis of [...specAxes, ...vehicleAxes]) {
        const centerDistance = Math.abs(delta.x * axis.x + delta.z * axis.z);
        const specRadius = projectedRadius(specAxes, specHalfX, specHalfZ, axis);
        const vehicleRadius = projectedRadius(
            vehicleAxes,
            vehicleHalfX,
            vehicleHalfZ,
            axis,
        );
        if (centerDistance > specRadius + vehicleRadius) return false;
    }
    return true;
}

// A streamed fixed collider is allowed to appear only after every live dynamic
// chassis has cleared it. Existing colliders remain fully solid; this guard is
// solely for new/rebuilt geometry that would otherwise begin in penetration.
export function shouldDeferColliderBuild(spec, vehicles = [], paddingM = 0) {
    const candidates = Array.isArray(vehicles) ? vehicles : [vehicles];
    return candidates.some(vehicle => (
        vehicle && colliderSpecOverlapsVehicle(spec, vehicle, paddingM)
    ));
}

export function isVehicleExitSupportHeightSafe(
    vehicleY,
    supportY,
    maximumDeltaM = 1.25,
) {
    const vehicleHeight = finiteOrNull(vehicleY);
    const supportHeight = finiteOrNull(supportY);
    if (vehicleHeight === null || supportHeight === null) return false;
    return Math.abs(supportHeight - vehicleHeight)
        <= Math.max(0, finiteOrNull(maximumDeltaM) ?? 0);
}

function pointInsideFootprint(x, z, footprint) {
    let inside = false;
    for (const segment of footprint?.segments || []) {
        const ax = Number(segment?.ax);
        const az = Number(segment?.az);
        const bx = Number(segment?.bx);
        const bz = Number(segment?.bz);
        if (![ax, az, bx, bz].every(Number.isFinite)) continue;
        if ((az > z) === (bz > z)) continue;
        const crossingX = ax + ((z - az) * (bx - ax)) / (bz - az);
        if (crossingX > x) inside = !inside;
    }
    return inside;
}

function orientation(ax, az, bx, bz, cx, cz) {
    return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function liesOnSegment(ax, az, bx, bz, x, z, epsilon = 1e-7) {
    return x >= Math.min(ax, bx) - epsilon && x <= Math.max(ax, bx) + epsilon
        && z >= Math.min(az, bz) - epsilon && z <= Math.max(az, bz) + epsilon
        && Math.abs(orientation(ax, az, bx, bz, x, z)) <= epsilon;
}

function segmentsIntersect(a, b, c, d) {
    const o1 = orientation(a.x, a.z, b.x, b.z, c.x, c.z);
    const o2 = orientation(a.x, a.z, b.x, b.z, d.x, d.z);
    const o3 = orientation(c.x, c.z, d.x, d.z, a.x, a.z);
    const o4 = orientation(c.x, c.z, d.x, d.z, b.x, b.z);
    if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) return true;
    return (Math.abs(o1) <= 1e-7 && liesOnSegment(a.x, a.z, b.x, b.z, c.x, c.z))
        || (Math.abs(o2) <= 1e-7 && liesOnSegment(a.x, a.z, b.x, b.z, d.x, d.z))
        || (Math.abs(o3) <= 1e-7 && liesOnSegment(c.x, c.z, d.x, d.z, a.x, a.z))
        || (Math.abs(o4) <= 1e-7 && liesOnSegment(c.x, c.z, d.x, d.z, b.x, b.z));
}

function pointToSegmentDistanceSq(px, pz, ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 1e-9
        ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq))
        : 0;
    const nearestX = ax + dx * t;
    const nearestZ = az + dz * t;
    return (nearestX - px) ** 2 + (nearestZ - pz) ** 2;
}

function segmentToSegmentDistanceSq(a, b, c, d) {
    if (segmentsIntersect(a, b, c, d)) return 0;
    return Math.min(
        pointToSegmentDistanceSq(a.x, a.z, c.x, c.z, d.x, d.z),
        pointToSegmentDistanceSq(b.x, b.z, c.x, c.z, d.x, d.z),
        pointToSegmentDistanceSq(c.x, c.z, a.x, a.z, b.x, b.z),
        pointToSegmentDistanceSq(d.x, d.z, a.x, a.z, b.x, b.z),
    );
}

export function entryPathCrossesFootprints(from, to, footprints, clearanceM = 0.35) {
    const start = { x: Number(from?.x), z: Number(from?.z) };
    const end = { x: Number(to?.x), z: Number(to?.z) };
    if (![start.x, start.z, end.x, end.z].every(Number.isFinite)) return true;
    const clearanceSq = Math.max(0, Number(clearanceM) || 0) ** 2;
    for (const footprint of footprints || []) {
        if (pointInsideFootprint(start.x, start.z, footprint)
            || pointInsideFootprint(end.x, end.z, footprint)) return true;
        for (const segment of footprint?.segments || []) {
            const wallStart = { x: Number(segment?.ax), z: Number(segment?.az) };
            const wallEnd = { x: Number(segment?.bx), z: Number(segment?.bz) };
            if (![wallStart.x, wallStart.z, wallEnd.x, wallEnd.z].every(Number.isFinite)) continue;
            if (segmentToSegmentDistanceSq(start, end, wallStart, wallEnd) <= clearanceSq) return true;
        }
    }
    return false;
}

export function entryPathCrossesObstacles(from, to, obstacles, clearanceM = 0.45) {
    const ax = Number(from?.x);
    const az = Number(from?.z);
    const bx = Number(to?.x);
    const bz = Number(to?.z);
    if (![ax, az, bx, bz].every(Number.isFinite)) return true;
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    for (const obstacle of obstacles || []) {
        const x = Number(obstacle?.x);
        const z = Number(obstacle?.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const t = lengthSq > 1e-9
            ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq))
            : 0;
        const nearestX = ax + dx * t;
        const nearestZ = az + dz * t;
        const radius = Math.max(
            0.05,
            Number(obstacle.radiusM) || 0,
            Number(obstacle.widthM) * 0.5 || 0,
        ) + Math.max(0, Number(clearanceM) || 0);
        if ((x - nearestX) ** 2 + (z - nearestZ) ** 2 <= radius * radius) return true;
    }
    return false;
}

function segmentCrossesExpandedBox(start, end, halfX, halfZ) {
    let minimumT = 0;
    let maximumT = 1;
    for (const axis of ['x', 'z']) {
        const startValue = start[axis];
        const delta = end[axis] - startValue;
        const half = axis === 'x' ? halfX : halfZ;
        if (Math.abs(delta) < 1e-9) {
            if (startValue < -half || startValue > half) return false;
            continue;
        }
        let first = (-half - startValue) / delta;
        let second = (half - startValue) / delta;
        if (first > second) [first, second] = [second, first];
        minimumT = Math.max(minimumT, first);
        maximumT = Math.min(maximumT, second);
        if (minimumT > maximumT) return false;
    }
    return true;
}

// Entry reachability uses the same oriented civil boxes as walk collision.
// Expand the plan footprint by body clearance and intersect in box-local space;
// this catches tunnel/cut walls and supports without inventing another geometry
// authority in GTA mode.
export function entryPathCrossesColliderBoxes(from, to, boxes, clearanceM = 0.35) {
    const startX = Number(from?.x);
    const startZ = Number(from?.z);
    const endX = Number(to?.x);
    const endZ = Number(to?.z);
    if (![startX, startZ, endX, endZ].every(Number.isFinite)) return true;
    const clearance = Math.max(0, Number(clearanceM) || 0);
    for (const box of boxes || []) {
        const centerX = Number(box?.cx);
        const centerZ = Number(box?.cz);
        const halfX = Math.max(0, Number(box?.hx) || 0) + clearance;
        const halfZ = Math.max(0, Number(box?.hz) || 0) + clearance;
        const sin = Number(box?.sin) || 0;
        const cos = finiteOrNull(box?.cos) ?? 1;
        if (![centerX, centerZ].every(Number.isFinite) || halfX <= 0 || halfZ <= 0) continue;
        const project = (x, z) => {
            const dx = x - centerX;
            const dz = z - centerZ;
            return { x: dx * cos - dz * sin, z: dx * sin + dz * cos };
        };
        if (segmentCrossesExpandedBox(
            project(startX, startZ),
            project(endX, endZ),
            halfX,
            halfZ,
        )) return true;
    }
    return false;
}

export function buildingWallColliderSpecs(footprints, {
    centerX,
    centerZ,
    radiusM,
    maxColliders,
    heightAt = () => 0,
    wallThicknessM = 0.45,
    wallHeightM = 24,
} = {}) {
    const radius = Math.max(0, Number(radiusM) || 0);
    const radiusSq = radius * radius;
    const candidates = [];
    const seenWalls = new Set();
    let footprintIndex = 0;
    for (const footprint of footprints || []) {
        for (let index = 0; index < (footprint?.segments || []).length; index += 1) {
            const segment = footprint.segments[index];
            const ax = Number(segment?.ax);
            const az = Number(segment?.az);
            const bx = Number(segment?.bx);
            const bz = Number(segment?.bz);
            if (![ax, az, bx, bz].every(Number.isFinite)) continue;
            const x = (ax + bx) * 0.5;
            const z = (az + bz) * 0.5;
            const dx = bx - ax;
            const dz = bz - az;
            const lengthM = Math.hypot(dx, dz);
            if (lengthM < 0.15) continue;
            // The building layer may expose both its detailed rendered wall and
            // the authoritative closed outline for the same object. Collapse
            // coincident segments so the physics bubble neither doubles its
            // collider budget nor leaves an overwritten rigid body untracked.
            const endpointA = `${Math.round(ax * 10)}:${Math.round(az * 10)}`;
            const endpointB = `${Math.round(bx * 10)}:${Math.round(bz * 10)}`;
            const wallKey = endpointA < endpointB
                ? `${endpointA}|${endpointB}`
                : `${endpointB}|${endpointA}`;
            if (seenWalls.has(wallKey)) continue;
            seenWalls.add(wallKey);
            const segmentBaseY = finiteOrNull(segment?.baseY)
                ?? finiteOrNull(footprint?.baseY);
            const segmentTopY = finiteOrNull(segment?.topY)
                ?? finiteOrNull(footprint?.topY);
            const measuredHeightM = segmentBaseY !== null
                && segmentTopY !== null
                && segmentTopY > segmentBaseY + 0.25
                ? segmentTopY - segmentBaseY
                : wallHeightM;
            // Radius admission belongs to the nearest point on the wall, not
            // its midpoint. A long warehouse or retaining wall can cross the
            // physics bubble while its centre lies hundreds of metres away.
            const distanceSq = pointToSegmentDistanceSq(
                centerX,
                centerZ,
                ax,
                az,
                bx,
                bz,
            );
            if (distanceSq > radiusSq) continue;
            candidates.push({
                // Include the quantized endpoints, not only the per-ring segment
                // ordinal: one MultiPolygon building can expose several rings
                // with the same object ID and each ring starts again at index 0.
                id: `building:${footprint.source ?? 'outline'}:${footprint.objectId ?? footprint.tileKey ?? footprintIndex}:${wallKey}`,
                kind: 'building',
                x,
                z,
                halfX: lengthM * 0.5,
                halfY: measuredHeightM * 0.5,
                halfZ: wallThicknessM * 0.5,
                yaw: -Math.atan2(dz, dx),
                distanceSq,
                destructive: false,
                // Detailed GDI walls already know the surveyed base used by
                // their rendered mesh. Reusing it makes collision coplanar and
                // avoids hundreds of road/terrain support queries per bubble.
                baseY: segmentBaseY,
                colliderHeightM: measuredHeightM,
            });
        }
        footprintIndex += 1;
    }
    candidates.sort((a, b) => a.distanceSq - b.distanceSq || a.id.localeCompare(b.id));
    const limit = Math.max(0, Math.trunc(Number(maxColliders) || 0));
    const specs = [];
    // Resolve fallback ground only for the nearest walls that can actually be
    // published. Previously every candidate paid this cost before the cap,
    // which turned one ordinary city-block refresh into a long frame.
    for (const candidate of candidates) {
        if (specs.length >= limit) break;
        const baseY = candidate.baseY ?? finiteOrNull(heightAt(candidate.x, candidate.z));
        if (baseY === null) continue;
        const { baseY: _baseY, colliderHeightM, ...spec } = candidate;
        spec.y = baseY + colliderHeightM * 0.5;
        specs.push(spec);
    }
    return specs;
}

export function vehicleExitCandidates({
    x,
    z,
    heading,
    halfWidthM,
    halfLengthM,
    expanded = false,
} = {}) {
    const yaw = Number(heading) || 0;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const side = Math.max(1.8, Number(halfWidthM) || 0) + 1.15;
    const rear = Math.max(2.4, Number(halfLengthM) || 0) + 1.2;
    const candidates = [
        { side: 'left', x: x - rightX * side, z: z - rightZ * side },
        { side: 'right', x: x + rightX * side, z: z + rightZ * side },
        { side: 'rear', x: x - forwardX * rear, z: z - forwardZ * rear },
    ];
    if (!expanded) return candidates;
    // A rolled vehicle can put all three ordinary door/rear points inside its
    // physical footprint, a wall or street furniture. Sample the complete
    // perimeter before relocating it to the last valid road surface.
    candidates.push(
        { side: 'front', x: x + forwardX * rear, z: z + forwardZ * rear },
        {
            side: 'rear-left',
            x: x - forwardX * rear - rightX * side,
            z: z - forwardZ * rear - rightZ * side,
        },
        {
            side: 'rear-right',
            x: x - forwardX * rear + rightX * side,
            z: z - forwardZ * rear + rightZ * side,
        },
        {
            side: 'front-left',
            x: x + forwardX * rear - rightX * side,
            z: z + forwardZ * rear - rightZ * side,
        },
        {
            side: 'front-right',
            x: x + forwardX * rear + rightX * side,
            z: z + forwardZ * rear + rightZ * side,
        },
    );
    return candidates;
}
