// Pure moorings along loaded shorelines: where a boat lies tied to the bank of
// the sea, a lake or a river near the player. Every candidate is derived from
// the shoreline rings the world already holds, sits on the water side of its
// bank, lies parallel to it, and carries a stable id, lettering and hull
// scale hashed from its spot, so the same cove keeps the same boats between
// visits and across retire/respawn.

// Bounded lettering variety: each distinct lettering costs one ~45 ms leut
// geometry build per session (models/vehicles/boat-airplane.js caches it).
export const MOORED_BOAT_LETTERINGS = Object.freeze([
    Object.freeze({ name: 'SV. NIKOLA', registration: 'VS 118' }),
    Object.freeze({ name: 'GALEB', registration: 'ST 3402' }),
    Object.freeze({ name: 'MARIJA', registration: 'ZD 771' }),
    Object.freeze({ name: 'SLOBODA', registration: 'RI 2245' }),
]);
export const MOORED_BOAT_HULL_SCALES = Object.freeze([0.78, 0.88, 1]);

export const MOORING_DEFAULTS = Object.freeze({
    // Shoreline is sampled this often; a mooring exists at about this share of samples.
    stepM: 45,
    share: 0.35,
    // Beam clearance from the bank to the hull centreline.
    offsetM: 2.4,
    // The water-side test looks a little beyond the hull to skip spits and steps.
    probeM: 4.5,
    quantiseM: 5,
});

// Deterministic 32-bit hash of a quantised spot.
export function mooringHash(qx, qz) {
    let h = (Math.imul(qx | 0, 73856093) ^ Math.imul(qz | 0, 19349663)) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x45d9f3b) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
}

const pointXZ = point => (Array.isArray(point)
    ? { x: Number(point[0]), z: Number(point[1]) }
    : { x: Number(point?.x), z: Number(point?.z) });

const finitePoint = point => Number.isFinite(point.x) && Number.isFinite(point.z);

// Shoreline rings as [x, z] or {x, z} sequences, open or closed.
export function shorelineMoorings({
    rings, x, z, isWaterAt, radiusM = 350,
    stepM = MOORING_DEFAULTS.stepM, share = MOORING_DEFAULTS.share,
    offsetM = MOORING_DEFAULTS.offsetM, probeM = MOORING_DEFAULTS.probeM,
    quantiseM = MOORING_DEFAULTS.quantiseM,
} = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || typeof isWaterAt !== 'function') return [];
    const moorings = [];
    const seen = new Set();
    for (const ring of rings || []) {
        const points = (ring || []).map(pointXZ).filter(finitePoint);
        if (points.length < 2) continue;
        let carry = 0;
        for (let index = 0; index < points.length - 1; index += 1) {
            const from = points[index];
            const to = points[index + 1];
            const lengthM = Math.hypot(to.x - from.x, to.z - from.z);
            if (lengthM < 1e-6) continue;
            const tx = (to.x - from.x) / lengthM;
            const tz = (to.z - from.z) / lengthM;
            for (let along = carry; along <= lengthM; along += stepM) {
                const px = from.x + tx * along;
                const pz = from.z + tz * along;
                const distanceM = Math.hypot(px - x, pz - z);
                if (distanceM > radiusM) continue;
                const qx = Math.round(px / quantiseM);
                const qz = Math.round(pz / quantiseM);
                const id = `moor:${qx}:${qz}`;
                if (seen.has(id)) continue;
                const hash = mooringHash(qx, qz);
                if ((hash % 1000) / 1000 >= share) continue;
                // The water side is the one that is water a hull's width out
                // and still water a little beyond; land on both sides or water
                // on both (a spit, a step, a mismatch) yields no mooring.
                const sides = [{ nx: -tz, nz: tx }, { nx: tz, nz: -tx }].map(side => (
                    isWaterAt(px + side.nx * offsetM, pz + side.nz * offsetM)
                    && isWaterAt(px + side.nx * probeM, pz + side.nz * probeM)
                ));
                if (sides[0] === sides[1]) continue;
                const normal = sides[0] ? { nx: -tz, nz: tx } : { nx: tz, nz: -tx };
                if (isWaterAt(px - normal.nx * 1.5, pz - normal.nz * 1.5)) continue;
                seen.add(id);
                const bowForward = (hash >>> 8) & 1;
                moorings.push({
                    id,
                    x: px + normal.nx * offsetM,
                    z: pz + normal.nz * offsetM,
                    heading: Math.atan2(bowForward ? tx : -tx, bowForward ? tz : -tz),
                    distanceM,
                    rope: { x: px, z: pz },
                    lettering: MOORED_BOAT_LETTERINGS[(hash >>> 10) % MOORED_BOAT_LETTERINGS.length],
                    hullScale: MOORED_BOAT_HULL_SCALES[(hash >>> 14) % MOORED_BOAT_HULL_SCALES.length],
                });
            }
            carry = ((lengthM - carry) % stepM);
            carry = carry === 0 ? 0 : stepM - carry;
        }
    }
    return moorings.sort((left, right) => left.distanceM - right.distanceM);
}
