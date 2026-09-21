// Centralizes URL-mode decisions that affect which Station 3D world layers
// exist. `elevation` is the sole DGU-terrain query flag.

const DISABLED_FLAG_VALUES = new Set(['0', 'false', 'off', 'no']);
const PHOTO_WORLD_FLAGS = ['photo', 'rw', 'real', 'photoreal'];

export function isElevationMode(search = globalThis.location?.search || '') {
    const params = new URLSearchParams(search);
    if (!params.has('elevation')) return false;
    const value = (params.get('elevation') || '').trim().toLowerCase();
    return !DISABLED_FLAG_VALUES.has(value);
}

export function shouldRenderDguTerrain(search, location = {}) {
    const params = new URLSearchParams(search || '');
    if (PHOTO_WORLD_FLAGS.some(flag => params.has(flag))) return false;

    const elevationEnabled = isElevationMode(search);
    if (params.has('elevation') && !elevationEnabled) return false;
    if (location.terrain) {
        return location.terrainOptIn ? elevationEnabled : true;
    }
    return elevationEnabled;
}

// Benchmark and capture sessions may need the first pose to remain exact while
// asynchronous world construction continues. Resolve this before the first cab
// frame so a frame-delayed synthetic keypress cannot move the world anchor.
export function shouldStartCabPaused(options = {}, search = globalThis.location?.search || '') {
    if (options?.startPaused === true) return true;
    return new URLSearchParams(search).get('st3dStartPaused') === '1';
}
