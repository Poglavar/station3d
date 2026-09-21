// The opaque startup curtain hides the main scene, but construction queues
// still need every animation-frame turn. Skip only the expensive main render;
// the frame loop and all before-render hooks continue at display cadence.

export function shouldRenderWorldFrame({ worldBuilding, canvasWidth, canvasHeight } = {}) {
    return worldBuilding !== true
        && Number(canvasWidth) > 0
        && Number(canvasHeight) > 0;
}
