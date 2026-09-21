// Which windows are lit after dark, as a pure deterministic pattern. The wall
// texture is a tiled atlas of cells (one cell ≈ one window bay), so a night
// scatter only needs a stable answer per cell: is this window lit, and how
// warmly. Keeping it pure means the look can be tuned and tested without a
// canvas, and two buildings sharing a cell always agree.

// Roughly the share of windows showing a light in a Croatian city at 23:00.
export const WALL_WINDOW_LIT_FRACTION = 0.34;
// Lit windows differ: a reading lamp, a television, a hallway bulb.
export const WALL_WINDOW_MIN_BRIGHTNESS = 0.55;
export const WALL_WINDOW_MAX_BRIGHTNESS = 1;

function hash(col, row, seed) {
    let h = (Math.trunc(col) * 0x27d4eb2d) ^ (Math.trunc(row) * 0x165667b1) ^ (Math.trunc(seed) * 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// `lit` decides the window, `brightness` its lamp. Two independent draws, so a
// building does not get all its bright windows in one column.
export function wallWindowLightAt(col, row, seed = 0, litFraction = WALL_WINDOW_LIT_FRACTION) {
    const fraction = Math.max(0, Math.min(1, Number(litFraction)));
    const lit = hash(col, row, seed) < fraction;
    if (!lit) return { lit: false, brightness: 0 };
    const span = WALL_WINDOW_MAX_BRIGHTNESS - WALL_WINDOW_MIN_BRIGHTNESS;
    return {
        lit: true,
        brightness: WALL_WINDOW_MIN_BRIGHTNESS + hash(row, col, seed + 977) * span,
    };
}
