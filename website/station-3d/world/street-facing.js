// Shared street-facing facade data: GET /street-facing/facades?bbox=… serves one LineString per
// LOGICAL FACADE of a GDI building (cadastre-data, public.facade_street — see db/street_facing.sql),
// keyed on the same object_id as /buildings-3d. It answers the two questions the facade painter used
// to guess at from local geometry: how street-facing is this wall, and how much of its AREA does a
// neighbour cover. Values are continuous; the thresholds live here, at the call site.

import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { getApiBase } from '../core/api.js';

// "window painting wants > ~0.3" (db/street_facing.sql). Below it a facade is not a frontage:
// it gets plain windows if it is free-standing (a courtyard wall), and nothing if it is buried.
export const STREET_FACING_MIN = 0.3;
// Below this share of the ground line the facade touches no neighbour at all.
const PARTY_WALL_LENGTH_EPS = 0.05;
// A wall covered to within one storey of its cornice has nowhere left to put a window.
const MIN_EXPOSED_BAND_M = 1.5;
// Matching a local wall surface to an API facade line.
const MATCH_NORMAL_DOT = 0.82;        // ≈35° of outward-normal disagreement
const MATCH_MAX_OFFSET_M = 2.0;       // bay windows and recesses sit slightly off their parent line
const MATCH_MIN_OVERLAP_FRAC = 0.5;   // of the local surface's own ground line
const GEOMETRY_EPSILON_M = 1e-6;

function finiteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function objectKey(value) {
    return value == null ? null : String(value);
}

function clamp01(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(1, numeric));
}

/**
 * Fetches the facades of one bbox. The table is still being built, so an empty
 * collection is a normal answer — callers fall back to local geometry per building.
 * Never throws: a failed fetch degrades to "no shared data for this bbox".
 */
export async function fetchStreetFacingFacades(bbox, signal, {
    requestScheduler = null,
    priority = null,
} = {}) {
    if (!bbox) return [];
    const url = `${getApiBase()}/street-facing/facades` +
        `?bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
    try {
        const run = async () => {
            const response = await fetch(url, signal ? { signal } : undefined);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        };
        const data = typeof requestScheduler?.scheduleNetworkRequest === 'function'
            ? await requestScheduler.scheduleNetworkRequest({
                label: 'street-facing:facades',
                groupKey: 'street-facing',
                groupLimit: 2,
                // Detailed-building tile publication awaits this response.
                // Those parent tile requests themselves occupy the ordinary
                // network slots, so the facade dependency needs the scheduler's
                // single bounded support lane or a busy six-connection stream
                // can leave every visible tile waiting behind its own parents.
                supportLane: true,
                priority,
                signal,
                run,
            })
            : await run();
        if (data && data.error) throw new Error(`API error: ${data.error}`);
        return (data && data.features) || [];
    } catch (err) {
        if (err && err.name === 'AbortError') return [];
        console.warn('[street-facing] facade fetch failed:', err);
        return [];
    }
}

// Outward normal from the API azimuth (0=N, 90=E) in scene axes (+X east, -Z north).
function normalFromAzimuth(azimuthDeg) {
    const azimuth = finiteNumber(azimuthDeg);
    if (azimuth == null) return null;
    const radians = azimuth * DEG_TO_RAD;
    return { nx: Math.sin(radians), nz: -Math.cos(radians) };
}

function facadeFromFeature(feature, aLat, aLon) {
    const properties = (feature && feature.properties) || {};
    const geometry = feature && feature.geometry;
    if (!geometry || geometry.type !== 'LineString') return null;
    const coordinates = geometry.coordinates || [];
    if (coordinates.length < 2) return null;
    const key = objectKey(properties.object_id);
    if (key == null) return null;

    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(aLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    const ax = (first[0] - aLon) * scaleLon;
    const az = -(first[1] - aLat) * scaleLat;
    const bx = (last[0] - aLon) * scaleLon;
    const bz = -(last[1] - aLat) * scaleLat;
    // The chord of a run of near-collinear edges is its axis; the API's own azimuth
    // carries the only thing the chord cannot: which side is outside.
    const chord = Math.hypot(bx - ax, bz - az);
    if (chord < GEOMETRY_EPSILON_M) return null;

    return {
        objectKey: key,
        facadeIdx: finiteNumber(properties.facade_idx),
        ax,
        az,
        bx,
        bz,
        tx: (bx - ax) / chord,
        tz: (bz - az) / chord,
        chordM: chord,
        lengthM: finiteNumber(properties.length_m),
        normal: normalFromAzimuth(properties.facade_azimuth_deg),
        streetFacingFraction: finiteNumber(properties.street_facing_fraction) ?? 0,
        partyWallLengthFrac: clamp01(properties.party_wall_length_frac),
        partyWallAreaFrac: clamp01(properties.party_wall_area_frac),
        partyWallAreaSource: properties.party_wall_area_source || null,
        streetName: properties.street_name || null,
    };
}

/**
 * Groups a fetched FeatureCollection by object_id, in the local scene frame of
 * (aLat, aLon) — the same anchor and projection the building meshes use.
 */
export function buildStreetFacingIndex(features, aLat, aLon) {
    const byObject = new Map();
    let facadeCount = 0;
    for (const feature of features || []) {
        const facade = facadeFromFeature(feature, aLat, aLon);
        if (!facade) continue;
        const entries = byObject.get(facade.objectKey) || [];
        entries.push(facade);
        byObject.set(facade.objectKey, entries);
        facadeCount++;
    }
    return { byObject, facadeCount, objectCount: byObject.size };
}

// A canonicalised wall plane has no inherent orientation — its normal was flipped into a
// half-space, and the interiorSide flag that records the flip is only ever meaningful
// RELATIVELY (two solids on opposite sides of one line share a wall). Which way is OUT is
// resolved against the building's own centre, exactly as the contact-AO skirts do.
// Returns null without a centre, and the caller then matches on an undirected normal.
function surfaceOutwardNormal(surface, center) {
    if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.z)) return null;
    const segment = surfaceGroundSegment(surface);
    if (!segment) return null;
    const midX = (segment.ax + segment.bx) / 2;
    const midZ = (segment.az + segment.bz) / 2;
    const sign = (midX - center.x) * surface.nx + (midZ - center.z) * surface.nz >= 0 ? 1 : -1;
    return { nx: sign * surface.nx, nz: sign * surface.nz };
}

function surfaceGroundSegment(surface) {
    const nx = finiteNumber(surface.nx);
    const nz = finiteNumber(surface.nz);
    const d = finiteNumber(surface.d);
    const minU = finiteNumber(surface.minU);
    const maxU = finiteNumber(surface.maxU);
    if (nx == null || nz == null || d == null || minU == null || maxU == null) return null;
    const tx = finiteNumber(surface.tx) ?? nz;
    const tz = finiteNumber(surface.tz) ?? -nx;
    const length = Math.abs(maxU - minU);
    if (length < GEOMETRY_EPSILON_M) return null;
    return {
        ax: d * nx + minU * tx,
        az: d * nz + minU * tz,
        bx: d * nx + maxU * tx,
        bz: d * nz + maxU * tz,
        length,
    };
}

/**
 * Matches one local logical wall surface to the API facade it belongs to: the normals must
 * be parallel (and, when the building's centre says which way the surface faces, point the
 * same way), the surface's ground line must run along the facade's line, and it must not
 * stand off it by more than a bay window's depth. Returns null when the building has no
 * rows or nothing lines up — the caller then falls back to local geometry.
 *
 * center: the building's footprint centre {x, z} in the same local frame. Optional; without
 * it the far wall of a building thinner than MATCH_MAX_OFFSET_M could match.
 */
export function matchStreetFacingFacade(index, objectId, surface, center = null) {
    if (!index || !index.byObject || !surface) return null;
    const facades = index.byObject.get(objectKey(objectId));
    if (!facades || facades.length === 0) return null;
    const segment = surfaceGroundSegment(surface);
    if (!segment) return null;
    const outward = surfaceOutwardNormal(surface, center);

    let best = null;
    let bestOverlap = 0;
    let bestOffset = Infinity;
    for (const facade of facades) {
        if (facade.normal) {
            const alignment = outward
                ? outward.nx * facade.normal.nx + outward.nz * facade.normal.nz
                : Math.abs(surface.nx * facade.normal.nx + surface.nz * facade.normal.nz);
            if (alignment < MATCH_NORMAL_DOT) continue;
        }
        const startU = (segment.ax - facade.ax) * facade.tx + (segment.az - facade.az) * facade.tz;
        const endU = (segment.bx - facade.ax) * facade.tx + (segment.bz - facade.az) * facade.tz;
        const overlap = Math.max(0,
            Math.min(facade.chordM, Math.max(startU, endU)) - Math.max(0, Math.min(startU, endU)));
        if (overlap < MATCH_MIN_OVERLAP_FRAC * segment.length) continue;
        const midX = (segment.ax + segment.bx) / 2 - facade.ax;
        const midZ = (segment.az + segment.bz) / 2 - facade.az;
        const offset = Math.abs(midX * -facade.tz + midZ * facade.tx);
        if (offset > MATCH_MAX_OFFSET_M) continue;
        if (overlap > bestOverlap + GEOMETRY_EPSILON_M ||
            (overlap > bestOverlap - GEOMETRY_EPSILON_M && offset < bestOffset)) {
            best = facade;
            bestOverlap = overlap;
            bestOffset = offset;
        }
    }
    return best;
}

/**
 * The opening rules for one logical wall surface, from the shared data.
 *
 *   openings        — paint the procedural window grid at all
 *   storefronts     — seed the ground floor with an entrance and shopfronts. A courtyard wall
 *                     has windows; it does not have a shop.
 *   coveredHeightM  — height up to which a neighbour buries this wall; no openings below it.
 *
 * party_wall_area_frac is the share of the wall AREA a neighbour covers and is ASYMMETRIC:
 * a 4-storey wall against a 1-storey neighbour reads ~0.25 while the neighbour's own wall
 * reads ~1.0. Dividing it by the share of the GROUND LINE they share recovers the contact
 * HEIGHT, so only the buried storeys lose their windows and the exposed band above the
 * neighbour's roof keeps them. Returns null when the API has nothing for this surface.
 */
export function classifyStreetFacingSurface(index, objectId, surface, center = null) {
    const facade = matchStreetFacingFacade(index, objectId, surface, center);
    if (!facade) return null;

    const heightM = Math.max(0, Number(surface.maxV) || 0);
    const lengthFrac = facade.partyWallLengthFrac;
    const areaFrac = facade.partyWallAreaFrac;
    const coveredFrac = lengthFrac > PARTY_WALL_LENGTH_EPS
        ? Math.min(1, areaFrac / lengthFrac)
        // No shared ground line means nothing is standing against this wall; an area
        // fraction without one can only be trusted as a plain share of the wall.
        : Math.min(1, areaFrac);
    const coveredHeightM = coveredFrac * heightM;
    const streetFacing = facade.streetFacingFraction >= STREET_FACING_MIN;

    return {
        source: 'street-facing',
        facade,
        streetFacing,
        coveredHeightM,
        openings: coveredHeightM < heightM - MIN_EXPOSED_BAND_M,
        storefronts: streetFacing,
    };
}
