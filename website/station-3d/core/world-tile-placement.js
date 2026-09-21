// Global slippy identities with the engine's physical-metre local frame.
// EPSG:3857 is the index only; rendering still uses core/math.js, never Mercator metres.
import { DEG_TO_RAD, EARTH_RADIUS_M, geoToLocal } from './math.js';

export const WORLD_TILE_MATRIX = 'EPSG:3857';
export const WORLD_TILE_PROJECTION = 'station3d-equirectangular-v1';
export const WORLD_TILE_MAX_LATITUDE = Math.atan(Math.sinh(Math.PI)) / DEG_TO_RAD;
export const WORLD_TILE_EARTH_RADIUS_M = EARTH_RADIUS_M;

function finite(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
    return value;
}
function zoom(value) {
    if (!Number.isInteger(value) || value < 0 || value > 22) throw new RangeError('Tile zoom must be an integer from 0 to 22');
    return value;
}
function coordinates(lon, lat) {
    finite(lon, 'longitude'); finite(lat, 'latitude');
    if (lon < -180 || lon > 180 || Math.abs(lat) > WORLD_TILE_MAX_LATITUDE) {
        throw new RangeError('Coordinates are outside the slippy tile matrix');
    }
}

export function worldTileAt(lon, lat, z) {
    coordinates(lon, lat);
    const n = 2 ** zoom(z);
    return {
        matrix: WORLD_TILE_MATRIX, z,
        x: Math.max(0, Math.min(n - 1, Math.floor((lon + 180) / 360 * n))),
        y: Math.max(0, Math.min(n - 1, Math.floor((1 - Math.asinh(Math.tan(lat * DEG_TO_RAD)) / Math.PI) / 2 * n))),
    };
}

export function worldTileFrame(tile) {
    if (tile?.matrix !== WORLD_TILE_MATRIX) throw new TypeError('Expected global EPSG:3857 tile identity');
    const n = 2 ** zoom(tile.z);
    for (const axis of ['x', 'y']) {
        if (!Number.isInteger(tile[axis]) || tile[axis] < 0 || tile[axis] >= n) throw new RangeError(`Invalid tile ${axis}`);
    }
    return {
        matrix: WORLD_TILE_MATRIX, z: tile.z, x: tile.x, y: tile.y,
        originLon: tile.x / n * 360 - 180,
        originLat: Math.atan(Math.sinh(Math.PI * (1 - 2 * tile.y / n))) / DEG_TO_RAD,
    };
}

export function worldTileBounds(tile) {
    const frame = worldTileFrame(tile);
    const n = 2 ** frame.z;
    return {
        west: frame.originLon, north: frame.originLat,
        east: (frame.x + 1) / n * 360 - 180,
        south: Math.atan(Math.sinh(Math.PI * (1 - 2 * (frame.y + 1) / n))) / DEG_TO_RAD,
    };
}

export function validateWorldTileFrame(tile) {
    const expected = worldTileFrame(tile);
    for (const key of ['originLon', 'originLat']) {
        if (Math.abs(finite(tile[key], key) - expected[key]) > 1e-10) throw new RangeError(`Non-canonical tile ${key}`);
    }
    return tile;
}

export function validateWorldTileVertical(vertical) {
    if (!vertical || !['foundation-relative', 'absolute-datum'].includes(vertical.mode)) {
        throw new TypeError('Explicit tile vertical frame is required');
    }
    finite(vertical.originHeightM, 'vertical originHeightM');
    if (vertical.mode === 'foundation-relative') {
        if (vertical.datum !== null || vertical.originHeightM !== 0) throw new TypeError('Foundation-relative tiles must use zero local height and no baked datum');
    } else if (typeof vertical.datum !== 'string' || !vertical.datum.trim()) {
        throw new TypeError('Absolute tile height requires a named datum');
    }
    return vertical;
}

// Always returns absolute session-local placement. render-origin.js translates
// the scene root once; subtracting that origin here would double-rebase tiles.
export function worldTilePlacement(tile, {
    anchor,
    vertical = { mode: 'foundation-relative', datum: null, originHeightM: 0 }, sessionDatum = null,
} = {}) {
    validateWorldTileFrame(tile);
    coordinates(anchor?.lon, anchor?.lat);
    validateWorldTileVertical(vertical);
    let y = 0;
    if (vertical.mode === 'absolute-datum') {
        if (sessionDatum?.datum !== vertical.datum) throw new TypeError('Tile and session vertical datum mismatch');
        y = vertical.originHeightM - finite(sessionDatum.heightM, 'session datum heightM');
    }
    const origin = geoToLocal(tile.originLon, tile.originLat, anchor.lon, anchor.lat);
    return {
        position: { x: origin.x, y, z: origin.z },
        // Translation alone is insufficient when the latitude of the anchor changes.
        scale: { x: Math.cos(anchor.lat * DEG_TO_RAD) / Math.cos(tile.originLat * DEG_TO_RAD), y: 1, z: 1 },
    };
}

export function placeWorldTilePoint(point, placement) {
    return {
        x: finite(point.x, 'point.x') * placement.scale.x + placement.position.x,
        y: finite(point.y, 'point.y') + placement.position.y,
        z: finite(point.z, 'point.z') + placement.position.z,
    };
}
