// Verifies the performance HUD stacks below an expanded minimap. Applies to
// BOTH modes: the walk and cab minimaps occupy the same top-left corner, and
// gating this on walk mode left the cab's FPS panel drawn over its map.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_PERF_TOP_PX,
    DEFAULT_STATS_TOP_PX,
    MIN_PERF_OVERLAY_HEIGHT_PX,
    PERF_OVERLAY_BOTTOM_PX,
    resolvePerformanceHudLayout,
} from '../core/hud-overlay-layout.js';

test('keeps the established HUD positions without an expanded minimap', () => {
    assert.deepEqual(resolvePerformanceHudLayout(), {
        statsTopPx: DEFAULT_STATS_TOP_PX,
        perfTopPx: DEFAULT_PERF_TOP_PX,
    });
});

test('stacks FPS and diagnostics below the expanded minimap', () => {
    assert.deepEqual(resolvePerformanceHudLayout({
        expandedMinimapBottomPx: 210,
        statsHeightPx: 48,
    }), {
        statsTopPx: 218,
        perfTopPx: 274,
    });
});

test('invalid minimap geometry falls back to the default layout', () => {
    assert.deepEqual(resolvePerformanceHudLayout({
        expandedMinimapBottomPx: Number.NaN,
    }), {
        statsTopPx: DEFAULT_STATS_TOP_PX,
        perfTopPx: DEFAULT_PERF_TOP_PX,
    });
});

test('keeps both perf panes alive when the minimap consumes the viewport', () => {
    const viewportHeightPx = 350;
    const layout = resolvePerformanceHudLayout({
        expandedMinimapBottomPx: 216,
        statsHeightPx: 48,
        viewportHeightPx,
    });

    assert.equal(layout.statsTopPx, 224);
    assert.equal(
        layout.perfTopPx,
        viewportHeightPx - PERF_OVERLAY_BOTTOM_PX - MIN_PERF_OVERLAY_HEIGHT_PX,
    );
});

test('does not move the perf panel when the requested stack already fits', () => {
    assert.deepEqual(resolvePerformanceHudLayout({
        expandedMinimapBottomPx: 216,
        statsHeightPx: 48,
        viewportHeightPx: 633,
    }), {
        statsTopPx: 224,
        perfTopPx: 280,
    });
});
