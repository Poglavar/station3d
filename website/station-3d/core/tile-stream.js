// Tile grid shared by every streamed world layer (buildings, roads, curbs,
// courtyard passages, …). The scheduler itself lives in shared-tile-session.js:
// layers subscribe to one fetcher per endpoint so a tile is fetched once and
// replayed to late subscribers.
//
// (This module used to also export a per-layer `TileStream` class. Nothing
// constructed it — every layer went through the shared session instead — so it
// was removed rather than left to rot with a second, quietly divergent copy of
// the fetch/retry rules.)

import { DEG_TO_RAD } from './math.js';
import { createFeatureCollectionJsonParseTask } from './cooperative-feature-collection-json.js';

export const TILE_M = 200;
export const CAB_RING = 1;
// Road surfaces, formation centrelines, curbs, and lane paint all open a long
// fog-horizon corridor. Bound each source so its four observer-touching tiles
// complete before that corridor consumes network and main-thread build slots.
export const NEAR_ROAD_MAX_CONCURRENT_REQUESTS = 4;
export const NEAR_ROAD_STREAM_OPTIONS = Object.freeze({
    maxConcurrentRequests: NEAR_ROAD_MAX_CONCURRENT_REQUESTS,
    // During the opaque startup hold, road payloads also carry streamed rail
    // topology and feed the first coherent ground publication. Give them one
    // shared scheduler tier above scenery without creating a second loader.
    startupPriority: 2,
    // Support/visible tiles outrank the long road corridor. This option is
    // shared by asphalt, formation, curbs, markings, and streamed rails so no
    // layer can quietly fall back to distance-only scheduling.
    prioritizeByView: true,
});
// Fog is opaque at 1200 m. A view corridor shorter than that stops streaming
// while you can still see, so the layer visibly builds itself in front of you.
export const FOG_OPAQUE_M = 1200;
// Curbs must reach as far as the roads they edge (ROAD_AHEAD_PREFETCH_M, 1400 m
// in world/roads.js) — a curb is a thin ribbon along a road, not an independent
// payload, and a shorter corridor makes kerbs end in mid-street 800 m out while
// the asphalt carries on. This was briefly 600 m: the value moved here from
// curbs.js in "Improve adaptive near-world streaming" and lost 800 m on the way,
// with no note saying why, which is what the curb-prefetch test now guards.
export const CURB_AHEAD = Object.freeze({
    distanceM: 1400,
    halfWidthM: 120,
});
// Detailed buildings are the heaviest streamed payload in the model world.
// A smaller grid lets the four tiles touching a stationary observer arrive and
// build before farther blocks, instead of making one 200 m tile an indivisible
// multi-megabyte unit. The ring preserves roughly the old near-field reach.
export const DETAILED_BUILDING_TILE_M = 100;
export const DETAILED_BUILDING_RING = 2;
export const DETAILED_BUILDING_KEEP_RING = 3;
export const DETAILED_BUILDING_MAX_CONCURRENT_REQUESTS = 4;
export const DETAILED_BUILDING_STREAM_OPTIONS = Object.freeze({
    tileM: DETAILED_BUILDING_TILE_M,
    ring: DETAILED_BUILDING_RING,
    keepRing: DETAILED_BUILDING_KEEP_RING,
    maxConcurrentRequests: DETAILED_BUILDING_MAX_CONCURRENT_REQUESTS,
    // Four observer-touching tiles are the startup contract. A small successor
    // buffer keeps the socket busy, but prevents a long view corridor from
    // occupying decoded-payload slots while roads/ground still need them.
    startupPendingTileLimit: 8,
    startupPriority: -1,
    prioritizeByView: true,
    // Detailed building payloads are large nested GeoJSON. Decode them one
    // bounded feature batch at a time instead of freezing the driving frame in
    // one atomic JSON.parse (160 ms on the Zagreb chase corridor).
    createTextDecodeTask: createFeatureCollectionJsonParseTask,
});

// The ring alone puts the LOD1 hand-off 200–300 m out in EVERY direction, which
// is close enough to read as a wall of boxes ahead of you. Buildings therefore
// also stream a corridor along the view, exactly as the road/curb/lane sources
// already do — the ring stays the near-field guarantee and the corridor extends
// reach only where you are looking.
//
// This costs nothing in priority order: the detailed source ranks tiles in the
// current camera view before peripheral/hidden tiles, then fills each tier from
// the observer outward. Corridor tiles are also exempt from ring eviction while
// they stay in the corridor, so they are not fetched and immediately discarded
// for sitting outside keepRing.
//
//  - distanceM 800: fog is opaque at 1200 m, so detail past ~800 m is paid for
//    and never seen. Shorter than the roads' 1400 m for the same reason plus
//    weight — detailed buildings are the heaviest streamed payload.
//  - stepM 50: half a tile. A step larger than tileM would sample past whole
//    tile columns and punch holes in the corridor.
export const DETAILED_BUILDING_AHEAD = Object.freeze({
    distanceM: 800,
    halfWidthM: 100,
    stepM: DETAILED_BUILDING_TILE_M / 2,
});

// GTA is the continuously moving world, so its detailed runway must be longer
// and wider than the inspection/cab corridor. The initial corridor builds
// behind the loading curtain; view priority gives the observer-adjacent tiles
// the first request slots. Once play starts, the same finite window advances
// with the car under the interactive construction budget.
export const GTA_DETAILED_BUILDING_AHEAD = Object.freeze({
    distanceM: 900,
    halfWidthM: 125,
    stepM: DETAILED_BUILDING_TILE_M / 2,
});

// tileIndex/tileBbox take an optional tileM so a source can run a coarser grid
// (e.g. the far LOD1 building layer at 800 m) alongside the default 200 m one.
// Every existing caller omits it and keeps the historical 200 m behaviour.
export function tileIndex(localM, tileM = TILE_M) {
    return Math.floor(localM / tileM);
}

// Squared distance from a local point to a tile's nearest edge. Unlike
// centre-to-centre or tile-index distance, this correctly gives all four tiles
// that meet at the observer's position the same highest priority.
export function tileDistanceSqToPoint(tx, tz, localX, localZ, tileM = TILE_M) {
    const xMin = tx * tileM;
    const xMax = (tx + 1) * tileM;
    const zMin = tz * tileM;
    const zMax = (tz + 1) * tileM;
    const dx = localX < xMin ? xMin - localX : localX > xMax ? localX - xMax : 0;
    const dz = localZ < zMin ? zMin - localZ : localZ > zMax ? localZ - zMax : 0;
    return dx * dx + dz * dz;
}

export function boundsIntersectWithPadding(a, b, paddingM = 0) {
    if (!a || !b) return false;
    const padding = Math.max(0, Number(paddingM) || 0);
    return Number(a.maxX) >= Number(b.minX) - padding
        && Number(a.minX) <= Number(b.maxX) + padding
        && Number(a.maxZ) >= Number(b.minZ) - padding
        && Number(a.minZ) <= Number(b.maxZ) + padding;
}

export function tileBbox(tx, tz, anchorLat, anchorLon, tileM = TILE_M) {
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    // M_PER_DEG: this historically used 111320 (WGS84 metre-per-degree at the
    // equator) rather than the 111194.9 used elsewhere; kept unchanged so the
    // API receives the exact bboxes it returned features for.
    const M_PER_DEG = 111320;
    const xMin = tx * tileM, xMax = (tx + 1) * tileM;
    const zMin = tz * tileM, zMax = (tz + 1) * tileM;
    const north = anchorLat - zMin / M_PER_DEG;
    const south = anchorLat - zMax / M_PER_DEG;
    const west  = anchorLon + xMin / (cosLat * M_PER_DEG);
    const east  = anchorLon + xMax / (cosLat * M_PER_DEG);
    return { west, south, east, north };
}
