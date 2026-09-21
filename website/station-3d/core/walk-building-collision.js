// Solid building walls for the walker: a circle slides along footprint edges
// instead of passing through a facade and dropping under the visible ground
// (Split and Zagreb, 2026-09-09 audit). Walls come from the live footprint
// index or the baked pack's facade index; both hand over footprints shaped
// `{ objectId, baseY?, topY?, segments: [{ ax, az, bx, bz, baseY?, topY?,
// normalX?, normalZ? }] }` in scene metres.
//
// A wall with a known outward normal (the live index derives one from the
// footprint ring's winding) blocks only from its OUTWARD side, so a walker who
// is already inside — a bad spawn, an old save, a courtyard reached through an
// archway — walks straight out again instead of being sealed in. Walls without
// a normal (the pack's facade index: DoubleSide meshes, so winding proves
// nothing, and one claim per chunk, so no per-building outline) block from
// whichever side the walker approaches; a walker already embedded in such a
// wall's band is let through it rather than wedged. Pure, so the sliding rule
// is unit-tested without a renderer.

export const WALK_WALL_BODY_RADIUS_M = 0.35;
const BODY_TOP_M = 1.7;
const FOOT_CLEARANCE_M = 0.25;
// Matches the walker's step-up: anything you could stand on top of is
// climbed, not collided with.
const STEP_UP_M = 1.75;
const MAX_SUBSTEP_M = 0.3;
// A live footprint may not know its height; a facade is tall until proven low.
const ASSUMED_WALL_HEIGHT_M = 24;

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// A wall with no surveyed base stands on the ground under the walker, never
// on the walker's own feet: anchored to the feet, an unknown facade followed a
// jetpack walker up and held them at every altitude (Zagreb, 2026-09-10).
// `groundY` is the terrain under the walker; without one the feet remain the
// only reference. A footprint may name its height (`heightM`) without knowing
// where it stands, so the top is taken from that before the assumed cornice.
function wallBlocksAtHeight(segment, footprint, feetY, groundY) {
    const baseY = finite(segment.baseY) ?? finite(footprint.baseY) ?? groundY ?? feetY;
    const topY = finite(segment.topY) ?? finite(footprint.topY)
        ?? (baseY + (finite(footprint.heightM) ?? ASSUMED_WALL_HEIGHT_M));
    if (topY <= feetY + FOOT_CLEARANCE_M) return false;
    if (baseY >= feetY + BODY_TOP_M) return false;
    if (topY <= feetY + STEP_UP_M) return false;
    return true;
}

// Flattens footprints into the walls that can block a walker standing at
// `feetY`, with the per-wall constants the substep loop needs. `groundY` is
// the terrain under the walker, the base for walls that do not know theirs.
export function walkerWallsFromFootprints(footprints, feetY, { groundY = null } = {}) {
    const walls = [];
    const groundReferenceY = finite(groundY);
    for (const footprint of footprints || []) {
        for (const segment of footprint?.segments || []) {
            const ax = finite(segment?.ax);
            const az = finite(segment?.az);
            const bx = finite(segment?.bx);
            const bz = finite(segment?.bz);
            if (ax === null || az === null || bx === null || bz === null) continue;
            const ex = bx - ax;
            const ez = bz - az;
            const lengthSq = ex * ex + ez * ez;
            if (lengthSq < 1e-6) continue;
            if (!wallBlocksAtHeight(segment, footprint, feetY, groundReferenceY)) continue;
            const nx = finite(segment.normalX);
            const nz = finite(segment.normalZ);
            // Which side of the directed edge is "outside": the sign of
            // cross(edge, outwardNormal). Zero means unknown.
            const outwardSide = nx !== null && nz !== null
                ? Math.sign(ex * nz - ez * nx)
                : 0;
            walls.push({ ax, az, bx, bz, ex, ez, lengthSq, outwardSide, objectId: String(footprint.objectId ?? '') });
        }
    }
    return walls;
}

// Distance from a point to a wall segment.
function distanceToWall(wall, x, z) {
    const tl = ((x - wall.ax) * wall.ex + (z - wall.az) * wall.ez) / wall.lengthSq;
    const t = Math.max(0, Math.min(1, tl));
    return Math.hypot(x - (wall.ax + t * wall.ex), z - (wall.az + t * wall.ez));
}

// A walker this far inside a wall's body band did not get there through this
// code; let them out instead of wedging them. A walker sliding along a wall
// sits at exactly the radius and is never treated as embedded.
const EMBEDDED_SLACK_M = 0.05;

// Which walls can block a walker standing at (x, z): outward-normal walls when
// the walker is on their outside, and normal-less walls the walker is not
// already embedded in.
function wallsBlockingFrom(walls, fromX, fromZ, radius) {
    const blocking = [];
    for (const wall of walls) {
        if (wall.outwardSide !== 0) {
            const fromSign = Math.sign(sideOf(wall, fromX, fromZ));
            if (fromSign !== 0 && fromSign !== wall.outwardSide) continue;
            blocking.push(wall);
            continue;
        }
        if (distanceToWall(wall, fromX, fromZ) < radius - EMBEDDED_SLACK_M) continue;
        blocking.push(wall);
    }
    return blocking;
}

function sideOf(wall, x, z) {
    return wall.ex * (z - wall.az) - wall.ez * (x - wall.ax);
}

function resolvePoint(x, z, fromX, fromZ, walls, radius) {
    let outX = x;
    let outZ = z;
    for (let pass = 0; pass < 2; pass++) {
        let moved = false;
        for (const wall of walls) {
            const sideFrom = sideOf(wall, fromX, fromZ);
            const fromSign = Math.sign(sideFrom);
            const tl = ((outX - wall.ax) * wall.ex + (outZ - wall.az) * wall.ez) / wall.lengthSq;
            const t = Math.max(0, Math.min(1, tl));
            const qx = wall.ax + t * wall.ex;
            const qz = wall.az + t * wall.ez;
            const dx = outX - qx;
            const dz = outZ - qz;
            const distance = Math.hypot(dx, dz);
            const sideNow = Math.sign(sideOf(wall, outX, outZ));
            const crossed = fromSign !== 0 && sideNow !== 0 && sideNow !== fromSign && tl > 0 && tl < 1;
            if (!crossed && distance >= radius) continue;
            const invLength = 1 / Math.sqrt(wall.lengthSq);
            // Perpendicular on the positive side of the edge, flipped to the
            // side the walker came from.
            const keepSign = fromSign !== 0 ? fromSign : (sideNow !== 0 ? sideNow : 1);
            const nx = -wall.ez * invLength * keepSign;
            const nz = wall.ex * invLength * keepSign;
            if (crossed || (tl > 0 && tl < 1)) {
                // Slide: keep the position along the wall, sit `radius` off it.
                const lx = wall.ax + tl * wall.ex;
                const lz = wall.az + tl * wall.ez;
                outX = lx + nx * radius;
                outZ = lz + nz * radius;
            } else if (distance > 1e-6) {
                // Rounding a corner: circle against the endpoint.
                outX = qx + (dx / distance) * radius;
                outZ = qz + (dz / distance) * radius;
            } else {
                outX = qx + nx * radius;
                outZ = qz + nz * radius;
            }
            moved = true;
        }
        if (!moved) break;
    }
    return { x: outX, z: outZ };
}

// Walks the move in short substeps so a stride cannot tunnel through a thin
// facade, depenetrating at each one. `insidePassage(x, z)` names the points
// where a shader-cut archway or entrance lets the walker through the block.
export function resolveWalkAgainstBuildingWalls(fromX, fromZ, toX, toZ, feetY, footprints, {
    radiusM = WALK_WALL_BODY_RADIUS_M,
    insidePassage = null,
    groundY = null,
} = {}) {
    const walls = walkerWallsFromFootprints(footprints, feetY, { groundY });
    if (walls.length === 0) return { x: toX, z: toZ, blocked: false };
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-6) return { x: toX, z: toZ, blocked: false };
    const substeps = Math.max(1, Math.ceil(distance / MAX_SUBSTEP_M));
    const stepX = dx / substeps;
    const stepZ = dz / substeps;
    let x = fromX;
    let z = fromZ;
    let blocked = false;
    for (let i = 0; i < substeps; i++) {
        const targetX = x + stepX;
        const targetZ = z + stepZ;
        if (typeof insidePassage === 'function' && insidePassage(targetX, targetZ)) {
            x = targetX;
            z = targetZ;
            continue;
        }
        const resolved = resolvePoint(targetX, targetZ, x, z, wallsBlockingFrom(walls, x, z, radiusM), radiusM);
        if (Math.hypot(resolved.x - targetX, resolved.z - targetZ) > 1e-6) blocked = true;
        x = resolved.x;
        z = resolved.z;
    }
    return { x, z, blocked };
}
