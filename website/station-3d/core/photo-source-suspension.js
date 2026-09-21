// Pure visibility decision for suspending the exterior reality mesh while an
// observer is inside a fully authored tunnel. Kept separate from THREE so walk
// versus cab height semantics stay unit-testable.

export function shouldSuspendPhotoSource({
    insideTunnelCore = false,
    tunnelFloorY = null,
    observerY = null,
    sourceRoofOffsetM = null,
} = {}) {
    return !!insideTunnelCore
        && Number.isFinite(tunnelFloorY)
        && Number.isFinite(observerY)
        && Number.isFinite(sourceRoofOffsetM)
        && observerY < tunnelFloorY + sourceRoofOffsetM;
}
