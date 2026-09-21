// Citywide road-centerline spatial index. Loads the location's baked street file
// (getLocation().roadIndexUrl, e.g. zagreb_roads.json) once — an array of polylines
// [[lon,lat], …] — and buckets every segment into a lon/lat grid so a caller can
// cheaply query the handful of road segments near a point. Mirrors the road-snap grid
// transit.js builds for the 2D planner, but kept self-contained so the 3D modules don't
// depend on it.
//
// Consumers: world/elevated-rail.js and world/planner-elevation.js (where a viaduct or a
// cutting meets the street grid). It no longer has anything to do with building facades —
// which walls face a street is answered by the shared street-facing data (public.facade_street,
// see world/street-facing.js), not by proximity to a centerline.

import { getLocation } from './locations.js';
import { logStamp } from './log-stamp.js';

// Grid cell size in degrees (~110 m N/S, ~78 m E/W at Zagreb's latitude).
// A 3×3 neighbourhood query therefore covers ~230×330 m — comfortably wider
// than the facade→road test radius — while keeping per-cell segment counts low.
const CELL_DEG = 0.0012;

let grid = null;            // "row,col" → Array<[aLon,aLat,bLon,bLat]>
let loadPromise = null;

function cellKey(row, col) {
    return row + ',' + col;
}

// Kicks off the one-time load + index build. Safe to call repeatedly; resolves
// to the grid (or an empty grid if the fetch fails, so callers degrade to
// "draw windows everywhere" rather than throwing).
export function ensureRoadIndex() {
    if (grid) return Promise.resolve(grid);
    if (loadPromise) return loadPromise;
    const url = getLocation().roadIndexUrl;
    if (!url) {
        // No pre-baked street index for this location: resolve to an empty
        // grid so facades take the windows-everywhere fallback.
        console.log(logStamp(), '[road-index] disabled for this location (no baked street index)');
        grid = {};
        return Promise.resolve(grid);
    }
    loadPromise = fetch(url)
        .then((r) => r.json())
        .then((roads) => {
            const g = {};
            for (const line of roads) {
                if (!Array.isArray(line) || line.length < 2) continue;
                for (let i = 0; i < line.length - 1; i++) {
                    const a = line[i], b = line[i + 1];
                    const minLon = Math.min(a[0], b[0]), maxLon = Math.max(a[0], b[0]);
                    const minLat = Math.min(a[1], b[1]), maxLat = Math.max(a[1], b[1]);
                    const c0 = Math.floor(minLon / CELL_DEG), c1 = Math.floor(maxLon / CELL_DEG);
                    const r0 = Math.floor(minLat / CELL_DEG), r1 = Math.floor(maxLat / CELL_DEG);
                    for (let r = r0; r <= r1; r++) {
                        for (let c = c0; c <= c1; c++) {
                            const key = cellKey(r, c);
                            (g[key] || (g[key] = [])).push([a[0], a[1], b[0], b[1]]);
                        }
                    }
                }
            }
            grid = g;
            return g;
        })
        .catch((err) => {
            console.warn(logStamp(), '[road-index] failed to load street index:', err);
            grid = {};   // ready-but-empty: facades fall back to "no nearby road"
            return grid;
        });
    return loadPromise;
}

// True once the index is built (success or empty fallback). Callers use this to
// decide whether to run the road test or keep the windows-everywhere default.
export function isRoadIndexReady() {
    return grid != null;
}

// Returns the road segments in the 3×3 grid cells around (lon, lat). Each
// segment is [aLon, aLat, bLon, bLat]. Empty array if the index isn't ready.
export function nearbyRoadSegments(lon, lat) {
    return segmentsInGrid(grid, lon, lat, Infinity);
}

// Once delivered, an index is immutable. A geometry candidate retains that
// specific input instead of consulting the module's live pointer on each pier.
export function captureRoadIndexRead({ maxCandidates = 4096 } = {}) {
    if (!grid || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1) {
        throw new TypeError('Road clearance requires a ready index and a finite query capacity');
    }
    const captured = grid;
    return (lon, lat) => segmentsInGrid(captured, lon, lat, maxCandidates);
}

function segmentsInGrid(source, lon, lat, maxCandidates) {
    if (!source) return [];
    const row = Math.floor(lat / CELL_DEG);
    const col = Math.floor(lon / CELL_DEG);
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
            const arr = source[cellKey(row + dr, col + dc)];
            if (arr) {
                if (out.length + arr.length > maxCandidates) throw Object.assign(
                    new RangeError('Road clearance query exceeds capacity'), { code: 'ground-generation-capacity' });
                out.push(...arr);
            }
        }
    }
    return out;
}
