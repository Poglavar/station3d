// Shared layout policy for the walk minimap and the optional performance HUD.
// Keeping the pixel arithmetic pure makes the responsive stacking testable.

export const MINIMAP_LAYOUT_EVENT = 'station3d:minimap-layout';

export const DEFAULT_STATS_TOP_PX = 109;
export const DEFAULT_PERF_TOP_PX = 170;
export const DEFAULT_STATS_HEIGHT_PX = 48;
export const PERFORMANCE_HUD_GAP_PX = 8;
export const PERF_OVERLAY_BOTTOM_PX = 16;
// Below this the fixed header rows consume the whole box and both diagnostic
// panes collapse to 0px. Copy still works because the report remains in the
// DOM, which makes the failure look like lost measurements instead of layout.
export const MIN_PERF_OVERLAY_HEIGHT_PX = 180;

export function resolvePerformanceHudLayout({
    expandedMinimapBottomPx = null,
    statsHeightPx = DEFAULT_STATS_HEIGHT_PX,
    gapPx = PERFORMANCE_HUD_GAP_PX,
    viewportHeightPx = null,
    perfOverlayBottomPx = PERF_OVERLAY_BOTTOM_PX,
    minPerfOverlayHeightPx = MIN_PERF_OVERLAY_HEIGHT_PX,
} = {}) {
    const minimapBottom = Number(expandedMinimapBottomPx);
    const safeGap = Math.max(0, Number(gapPx) || 0);
    const safeStatsHeight = Math.max(
        0,
        Number(statsHeightPx) || DEFAULT_STATS_HEIGHT_PX,
    );
    const hasMinimap = expandedMinimapBottomPx != null && Number.isFinite(minimapBottom);
    const statsTopPx = hasMinimap
        ? Math.round(minimapBottom + safeGap)
        : DEFAULT_STATS_TOP_PX;
    const requestedPerfTopPx = hasMinimap
        ? Math.round(statsTopPx + safeStatsHeight + safeGap)
        : DEFAULT_PERF_TOP_PX;

    const viewportHeight = Number(viewportHeightPx);
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
        return { statsTopPx, perfTopPx: requestedPerfTopPx };
    }
    const safeBottom = Math.max(0, Number(perfOverlayBottomPx) || 0);
    const safeMinHeight = Math.max(0, Number(minPerfOverlayHeightPx) || 0);
    // When the minimap leaves too little room, readability wins over stacking:
    // the perf panel may overlap the small, redundant Stats tile, but it keeps
    // both independently scrollable metric panes alive.
    const latestUsableTopPx = Math.max(
        0,
        Math.floor(viewportHeight - safeBottom - safeMinHeight),
    );
    return {
        statsTopPx,
        perfTopPx: Math.min(requestedPerfTopPx, latestUsableTopPx),
    };
}
