// Exact curb/trackbed overlap. Broad OSM tram buffers are routing proxies and
// may decide whether a curb union edge is synthetic, but only the immutable
// footprint published with visible rails may remove physical curb geometry.

import { finiteOrNull } from './math.js';

export const CURB_RENDERED_RAIL_MAX_SEPARATION_M = 0.5;

export function curbTouchesRenderedRailSurfaceAtLocal({
    x,
    z,
    normalX = 0,
    normalZ = 0,
    crossSectionOffsetsM = [0],
    curbSceneYAtLocal,
    renderedRailSurface,
    maximumSeparationM = CURB_RENDERED_RAIL_MAX_SEPARATION_M,
} = {}) {
    const baseX = finiteOrNull(x);
    const baseZ = finiteOrNull(z);
    if (baseX === null || baseZ === null
        || typeof curbSceneYAtLocal !== 'function'
        || typeof renderedRailSurface?.civilGroundSurfaceAtLocal !== 'function') {
        return false;
    }
    const nx = finiteOrNull(normalX) ?? 0;
    const nz = finiteOrNull(normalZ) ?? 0;
    const maximumSeparation = Math.max(
        0,
        finiteOrNull(maximumSeparationM) ?? CURB_RENDERED_RAIL_MAX_SEPARATION_M,
    );
    for (const rawOffset of crossSectionOffsetsM || [0]) {
        const offset = finiteOrNull(rawOffset) ?? 0;
        const sampleX = baseX + nx * offset;
        const sampleZ = baseZ + nz * offset;
        const railHit = renderedRailSurface.civilGroundSurfaceAtLocal(
            sampleX,
            sampleZ,
        );
        const railY = finiteOrNull(railHit?.sceneY);
        if (railY === null) continue;
        const curbY = finiteOrNull(curbSceneYAtLocal(sampleX, sampleZ));
        if (curbY !== null && Math.abs(curbY - railY) <= maximumSeparation) {
            return true;
        }
    }
    return false;
}
