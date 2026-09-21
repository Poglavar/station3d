// Pure broad-phase rejection for terrain-draped parking surfaces. A parking
// vertex can select an engineered road only inside a road surface profile, so
// disjoint polygon/profile bounds prove that every exact formation query would
// fall back to bare terrain.

export function localRingBounds(ring) {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const point of ring || []) {
        const x = Number(point?.x);
        const z = Number(point?.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        minX = Math.min(minX, x);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxZ = Math.max(maxZ, z);
    }
    return Number.isFinite(minX) ? { minX, minZ, maxX, maxZ } : null;
}

export function localBoundsOverlap(left, right) {
    return !!left && !!right
        && left.minX <= right.maxX
        && left.maxX >= right.minX
        && left.minZ <= right.maxZ
        && left.maxZ >= right.minZ;
}

export function parkingMayOverlapRoadFormation(outerRing, surfaceProfiles) {
    const parkingBounds = localRingBounds(outerRing);
    if (!parkingBounds) return false;
    return (surfaceProfiles || []).some((profile) => (
        localBoundsOverlap(parkingBounds, profile?.bounds)
    ));
}
