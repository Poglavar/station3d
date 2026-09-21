// Pure curb/rail-cut ownership. Ordinary curb tiles are derived from planar
// road unions, so they can span a deep railway excavation unless the final 3D
// formation clips them. A road structure publishes its own carried curbs; the
// ordinary tile may remain only when its resolved base is actually on the cut
// floor.

import { createBoundsGrid } from './bounds-grid.js';

export const CURB_RAIL_CUT_MIN_SEPARATION_M = 0.75;

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function profileBounds(profile) {
    const source = profile?.terrainCutoutBounds
        || profile?.overlapBounds
        || profile?.outerBounds
        || profile?.bounds;
    if (!source || [source.minX, source.minZ, source.maxX, source.maxZ]
        .some(value => finite(value) === null)) return null;
    return source;
}

// Conservative edge gate. Exact open-cut and height ownership is evaluated at
// subdivided piece midpoints; these profile boxes only decide which long curb
// edges need that subdivision, including edges whose endpoints are both
// outside a trench but whose middle crosses it.
export function createRailCutEdgeEvaluator(railFormation, paddingM = 0) {
    const padding = Math.max(0, finite(paddingM) || 0);
    const entries = (railFormation?.getSurfaceProfiles?.() || []).flatMap((profile) => {
        const bounds = profileBounds(profile);
        return bounds ? [{
            bounds: {
                minX: bounds.minX - padding,
                minZ: bounds.minZ - padding,
                maxX: bounds.maxX + padding,
                maxZ: bounds.maxZ + padding,
            },
        }] : [];
    });
    if (entries.length === 0) return () => false;
    const grid = createBoundsGrid(entries);
    return (a, b) => {
        const minX = Math.min(finite(a?.x) ?? Infinity, finite(b?.x) ?? Infinity);
        const minZ = Math.min(finite(a?.z) ?? Infinity, finite(b?.z) ?? Infinity);
        const maxX = Math.max(finite(a?.x) ?? -Infinity, finite(b?.x) ?? -Infinity);
        const maxZ = Math.max(finite(a?.z) ?? -Infinity, finite(b?.z) ?? -Infinity);
        if (![minX, minZ, maxX, maxZ].every(Number.isFinite)) return false;
        for (const entry of grid.candidatesInBox(minX, minZ, maxX, maxZ)) {
            const bounds = entry.bounds;
            if (maxX >= bounds.minX && minX <= bounds.maxX
                && maxZ >= bounds.minZ && minZ <= bounds.maxZ) return true;
        }
        return false;
    };
}

export function curbCrossesOpenRailCutAtLocal({
    x,
    z,
    normalX = 0,
    normalZ = 0,
    crossSectionOffsetsM = [0],
    curbSceneYAtLocal,
    railFormation,
    minimumSeparationM = CURB_RAIL_CUT_MIN_SEPARATION_M,
} = {}) {
    const baseX = finite(x);
    const baseZ = finite(z);
    if (baseX === null || baseZ === null
        || typeof curbSceneYAtLocal !== 'function'
        || typeof railFormation?.isOpenCutAtLocal !== 'function'
        || typeof railFormation?.civilGroundSceneYAtLocal !== 'function') return false;
    const nx = finite(normalX) || 0;
    const nz = finite(normalZ) || 0;
    const separation = Math.max(0, finite(minimumSeparationM) || 0);
    for (const rawOffset of crossSectionOffsetsM || [0]) {
        const offset = finite(rawOffset) || 0;
        const sampleX = baseX + nx * offset;
        const sampleZ = baseZ + nz * offset;
        if (railFormation.isOpenCutAtLocal(sampleX, sampleZ) !== true) continue;
        const cutGroundY = finite(railFormation.civilGroundSceneYAtLocal(
            sampleX,
            sampleZ,
            { surfaceOffsetY: 0 },
        ));
        if (cutGroundY === null) continue;
        const curbY = finite(curbSceneYAtLocal(sampleX, sampleZ));
        if (curbY !== null && curbY - cutGroundY >= separation) return true;
    }
    return false;
}
