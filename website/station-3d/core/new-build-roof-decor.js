// Roof-life layout for NEW-BUILD (proposal) flat roofs — pure, no THREE, no
// DOM. Given a footprint polygon and a stable per-building hash, decides which
// roof "program" the building gets and lays every element out in local scene
// metres, so the whole thing is provable headless:
//
//   terrace — perimeter railing + sunshades with chairs + a barbecue corner
//   garden  — perimeter railing + lawns, bushes, short trees and benches
//   track   — perimeter railing + a jogging loop and an infield bench
//   null    — a plain roof (variation needs absences too)
//
// Some terrace/garden draws also receive one fixed 8 x 4 m recreational pool.
// Its complete basin + safety footprint is reserved before any other item is
// sampled, and track roofs never receive one, so roof programs cannot overlap.
//
// The world layer (world/new-build-roof-decor.js) turns this layout into one
// merged opaque mesh plus an optional shared-material water mesh; nothing here
// runs per frame.

import { geoToLocal } from './math.js';
import { offsetRingOutward } from './ring-offset.js';

// Element sizing — one place, shared with the mesh builder.
export const ROOF_RAILING_INSET_M = 0.35;
export const ROOF_RAILING_HEIGHT_M = 1.1;
export const ROOF_RAILING_POST_SPACING_M = 2.0;
export const ROOF_RAILING_RAIL_HEIGHTS_M = Object.freeze([0.55, 1.1]);
export const ROOF_TRACK_INSET_M = 0.7;
export const ROOF_TRACK_WIDTH_M = 1.5;
export const ROOF_POOL_LENGTH_M = 8;
export const ROOF_POOL_WIDTH_M = 4;
export const ROOF_POOL_WALL_THICKNESS_M = 0.28;
export const ROOF_POOL_OUTER_LENGTH_M = ROOF_POOL_LENGTH_M + ROOF_POOL_WALL_THICKNESS_M * 2;
export const ROOF_POOL_OUTER_WIDTH_M = ROOF_POOL_WIDTH_M + ROOF_POOL_WALL_THICKNESS_M * 2;
export const ROOF_POOL_CLEARANCE_M = 0.8;
export const ROOF_POOL_WALL_HEIGHT_M = 0.72;
export const ROOF_POOL_WATER_DEPTH_M = 0.54;
// Furniture/greenery stay clear of the railing (and the track when present).
const ITEM_EDGE_MARGIN_M = 1.6;
const ITEM_SPACING_M = 1.6;
// Program gates: below MIN_AREA a roof is plant-room sized and stays plain; a
// jogging loop needs a genuinely large block or its inner ring degenerates.
const MIN_DECOR_AREA_M2 = 60;
const MIN_TRACK_AREA_M2 = 350;
const MIN_TRACK_PERIMETER_M = 80;
const MAX_SAMPLE_ATTEMPTS_PER_ITEM = 8;
const MAX_POOL_PLACEMENT_ATTEMPTS = 48;

function seededRandom(seed) {
    let state = (seed >>> 0) || 1;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function localRing(ringLonLat, anchorLat, anchorLon) {
    if (!Array.isArray(ringLonLat) || ringLonLat.length < 4) return null;
    const out = [];
    for (const pt of ringLonLat) {
        const lon = Number(pt && pt[0]);
        const lat = Number(pt && pt[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        out.push(geoToLocal(lon, lat, anchorLon, anchorLat));
    }
    return out;
}

function localRingArea(points) {
    let sum = 0;
    for (let i = 0, n = points.length - 1; i < n; i++) {
        sum += points[i].x * points[i + 1].z - points[i + 1].x * points[i].z;
    }
    return sum / 2;
}

function ringPerimeter(points) {
    let total = 0;
    for (let i = 0, n = points.length - 1; i < n; i++) {
        total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
    }
    return total;
}

function pointInRing(x, z, points) {
    let inside = false;
    for (let i = 0, n = points.length - 1; i < n; i++) {
        const a = points[i];
        const b = points[i + 1];
        if ((a.z > z) !== (b.z > z)
            && x < a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x)) {
            inside = !inside;
        }
    }
    return inside;
}

function distanceToRing(x, z, points) {
    let best = Infinity;
    for (let i = 0, n = points.length - 1; i < n; i++) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lenSq = dx * dx + dz * dz;
        const t = lenSq > 0
            ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lenSq))
            : 0;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < best) best = d;
    }
    return best;
}

function ringBounds(points) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const point of points) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
    }
    return { minX, maxX, minZ, maxZ };
}

function orientedRectLocal(x, z, rect) {
    const dx = x - rect.x;
    const dz = z - rect.z;
    const cos = Math.cos(rect.angle);
    const sin = Math.sin(rect.angle);
    return {
        x: dx * cos + dz * sin,
        z: -dx * sin + dz * cos,
    };
}

function orientedRectSize(rect) {
    return {
        lengthM: Number(rect.outerLengthM ?? rect.lengthM ?? rect.w),
        widthM: Number(rect.outerWidthM ?? rect.widthM ?? rect.d),
    };
}

function pointInOrientedRect(x, z, rect, extraM = 0) {
    const local = orientedRectLocal(x, z, rect);
    const { lengthM, widthM } = orientedRectSize(rect);
    const extra = Math.max(0, Number(extraM) || 0);
    return Math.abs(local.x) <= lengthM / 2 + extra
        && Math.abs(local.z) <= widthM / 2 + extra;
}

function orientedRectCorners(rect, extraM = 0) {
    const { lengthM, widthM } = orientedRectSize(rect);
    const halfLength = lengthM / 2 + Math.max(0, Number(extraM) || 0);
    const halfWidth = widthM / 2 + Math.max(0, Number(extraM) || 0);
    const cos = Math.cos(rect.angle);
    const sin = Math.sin(rect.angle);
    return [
        [-halfLength, -halfWidth],
        [halfLength, -halfWidth],
        [halfLength, halfWidth],
        [-halfLength, halfWidth],
    ].map(([x, z]) => ({
        x: rect.x + x * cos - z * sin,
        z: rect.z + x * sin + z * cos,
    }));
}

function orientation(a, b, c) {
    return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function pointOnSegment(point, a, b, epsilon = 1e-7) {
    return Math.abs(orientation(a, b, point)) <= epsilon
        && point.x >= Math.min(a.x, b.x) - epsilon
        && point.x <= Math.max(a.x, b.x) + epsilon
        && point.z >= Math.min(a.z, b.z) - epsilon
        && point.z <= Math.max(a.z, b.z) + epsilon;
}

function segmentsIntersect(a, b, c, d) {
    const abC = orientation(a, b, c);
    const abD = orientation(a, b, d);
    const cdA = orientation(c, d, a);
    const cdB = orientation(c, d, b);
    if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
        && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
    return pointOnSegment(c, a, b)
        || pointOnSegment(d, a, b)
        || pointOnSegment(a, c, d)
        || pointOnSegment(b, c, d);
}

function rectIntersectsRing(corners, ring) {
    for (let side = 0; side < corners.length; side++) {
        const a = corners[side];
        const b = corners[(side + 1) % corners.length];
        for (let edge = 0, n = ring.length - 1; edge < n; edge++) {
            if (segmentsIntersect(a, b, ring[edge], ring[edge + 1])) return true;
        }
    }
    return false;
}

// Full-rectangle containment, not a centre-point approximation: this rejects
// concave roof notches and courtyard holes even when all the obvious samples
// happen to land on roof. `clearanceM` expands the basin before the test, so a
// successful placement has a usable dry band around all four sides.
function poolFitsRoof(pool, outer, holes) {
    const corners = orientedRectCorners(pool, pool.clearanceM);
    for (const corner of corners) {
        if (!pointInRing(corner.x, corner.z, outer)) return false;
        if (distanceToRing(corner.x, corner.z, outer) < 0.02) return false;
    }
    if (rectIntersectsRing(corners, outer)) return false;
    for (const hole of holes) {
        if (corners.some(corner => pointInRing(corner.x, corner.z, hole))) return false;
        if (hole.slice(0, -1).some(point => pointInOrientedRect(
            point.x,
            point.z,
            pool,
            pool.clearanceM,
        ))) return false;
        if (rectIntersectsRing(corners, hole)) return false;
    }
    return true;
}

function dominantRingAngle(points) {
    let bestLengthSq = -Infinity;
    let bestAngle = 0;
    for (let index = 0, n = points.length - 1; index < n; index++) {
        const dx = points[index + 1].x - points[index].x;
        const dz = points[index + 1].z - points[index].z;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq > bestLengthSq) {
            bestLengthSq = lengthSq;
            bestAngle = Math.atan2(dz, dx);
        }
    }
    return bestAngle;
}

function placeRoofPool(rand, outer, holes) {
    const bounds = ringBounds(outer);
    const baseAngle = dominantRingAngle(outer);
    const center = {
        x: (bounds.minX + bounds.maxX) / 2,
        z: (bounds.minZ + bounds.maxZ) / 2,
    };
    for (let attempt = 0; attempt < MAX_POOL_PLACEMENT_ATTEMPTS; attempt++) {
        const candidate = attempt < 2
            ? center
            : {
                x: bounds.minX + rand() * (bounds.maxX - bounds.minX),
                z: bounds.minZ + rand() * (bounds.maxZ - bounds.minZ),
            };
        const pool = {
            ...candidate,
            angle: baseAngle + (attempt % 2) * Math.PI / 2,
            lengthM: ROOF_POOL_LENGTH_M,
            widthM: ROOF_POOL_WIDTH_M,
            outerLengthM: ROOF_POOL_OUTER_LENGTH_M,
            outerWidthM: ROOF_POOL_OUTER_WIDTH_M,
            clearanceM: ROOF_POOL_CLEARANCE_M,
            wallHeightM: ROOF_POOL_WALL_HEIGHT_M,
            waterDepthM: ROOF_POOL_WATER_DEPTH_M,
        };
        if (poolFitsRoof(pool, outer, holes)) return pool;
    }
    return null;
}

// Inward inset via the shared lon/lat miter offset (negative metres), then
// localized. Returns null when the inset collapses the ring (skinny wings).
function insetLocalRing(ringLonLat, insetM, anchorLat, anchorLon, outerAreaAbs) {
    const inset = offsetRingOutward(ringLonLat, -insetM);
    const points = localRing(inset, anchorLat, anchorLon);
    if (!points) return null;
    const area = localRingArea(points);
    const outerSign = Math.sign(localRingArea(localRing(ringLonLat, anchorLat, anchorLon)));
    // A collapsed inset flips winding or eats most of the roof.
    if (Math.sign(area) !== outerSign) return null;
    if (Math.abs(area) < 1 || Math.abs(area) >= outerAreaAbs) return null;
    return points;
}

// March a closed ring placing a post every `spacing` metres, remainder carried
// across segments so corners never double up.
function marchRingPosts(points, spacing) {
    const posts = [];
    let sinceLast = 0;
    for (let i = 0, n = points.length - 1; i < n; i++) {
        const a = points[i];
        const b = points[i + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 1e-6) continue;
        let pos = 0;
        while (sinceLast + (len - pos) >= spacing) {
            pos += spacing - sinceLast;
            const t = pos / len;
            posts.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
            sinceLast = 0;
        }
        sinceLast += len - pos;
    }
    return posts;
}

// Rejection-sample `count` points on the roof interior: inside the outer ring,
// off every hole, clear of the edges, and spread out from each other.
function sampleInteriorPoints(
    rand,
    outer,
    holes,
    count,
    edgeMargin,
    taken,
    { blockedRects = [], itemRadiusM = 0 } = {},
) {
    const { minX, maxX, minZ, maxZ } = ringBounds(outer);
    const points = [];
    let attempts = count * MAX_SAMPLE_ATTEMPTS_PER_ITEM;
    while (points.length < count && attempts-- > 0) {
        const x = minX + rand() * (maxX - minX);
        const z = minZ + rand() * (maxZ - minZ);
        if (!pointInRing(x, z, outer)) continue;
        if (distanceToRing(x, z, outer) < edgeMargin) continue;
        let blocked = false;
        for (const hole of holes) {
            if (pointInRing(x, z, hole) || distanceToRing(x, z, hole) < edgeMargin) {
                blocked = true;
                break;
            }
        }
        if (blocked) continue;
        for (const other of taken) {
            const dx = other.x - x;
            const dz = other.z - z;
            if (dx * dx + dz * dz < ITEM_SPACING_M * ITEM_SPACING_M) { blocked = true; break; }
        }
        if (blocked) continue;
        for (const rect of blockedRects) {
            if (pointInOrientedRect(
                x,
                z,
                rect,
                Math.max(0, Number(rect.clearanceM) || 0)
                    + Math.max(0, Number(itemRadiusM) || 0),
            )) {
                blocked = true;
                break;
            }
        }
        if (blocked) continue;
        const point = { x, z };
        points.push(point);
        taken.push(point);
    }
    return points;
}

/**
 * Layout for one flat proposal roof, or null for a plain roof.
 *
 * @param polygonCoords GeoJSON Polygon coordinates ([outer, ...holes], lon/lat)
 * @param anchorLat/anchorLon scene anchor (same frame the roof cap is built in)
 * @param hash stable per-building hash (drives program choice + placement)
 */
export function newBuildRoofLayout(polygonCoords, anchorLat, anchorLon, hash) {
    const outerLonLat = Array.isArray(polygonCoords) ? polygonCoords[0] : null;
    const outer = localRing(outerLonLat, anchorLat, anchorLon);
    if (!outer) return null;
    const areaAbs = Math.abs(localRingArea(outer));
    if (!(areaAbs >= MIN_DECOR_AREA_M2)) return null;
    const holes = [];
    for (let r = 1; r < polygonCoords.length; r++) {
        const hole = localRing(polygonCoords[r], anchorLat, anchorLon);
        if (hole) holes.push(hole);
    }

    const seed = (Number(hash) >>> 0) ^ 0x9e3779b9;
    const rand = seededRandom(seed);
    const draw = (Number(hash) >>> 0) % 10;
    let program = draw <= 2 ? 'terrace' : draw <= 5 ? 'garden' : draw <= 7 ? 'track' : null;
    if (program === null) return null;

    const railingRing = insetLocalRing(outerLonLat, ROOF_RAILING_INSET_M, anchorLat, anchorLon, areaAbs);
    if (!railingRing) return null;   // no safe edge line → leave the roof plain

    let track = null;
    if (program === 'track') {
        const perimeter = ringPerimeter(outer);
        const trackOuter = areaAbs >= MIN_TRACK_AREA_M2 && perimeter >= MIN_TRACK_PERIMETER_M
            ? insetLocalRing(outerLonLat, ROOF_TRACK_INSET_M, anchorLat, anchorLon, areaAbs)
            : null;
        const trackInner = trackOuter
            ? insetLocalRing(outerLonLat, ROOF_TRACK_INSET_M + ROOF_TRACK_WIDTH_M, anchorLat, anchorLon, areaAbs)
            : null;
        if (trackOuter && trackInner && trackOuter.length === trackInner.length) {
            track = { outer: trackOuter, inner: trackInner };
        } else {
            program = 'garden';       // roof too small/skinny for a loop
        }
    }

    const edgeMargin = track
        ? ROOF_TRACK_INSET_M + ROOF_TRACK_WIDTH_M + 0.6
        : ITEM_EDGE_MARGIN_M;
    const taken = [];
    const layout = {
        program,
        railing: {
            ring: railingRing,
            posts: marchRingPosts(railingRing, ROOF_RAILING_POST_SPACING_M),
            railHeights: ROOF_RAILING_RAIL_HEIGHTS_M,
        },
        track,
        pool: (program === 'terrace' && draw === 1) || (program === 'garden' && draw === 4)
            ? placeRoofPool(rand, outer, holes)
            : null,
        lawns: [],
        bushes: [],
        trees: [],
        chairs: [],
        benches: [],
        sunshades: [],
        barbecues: [],
    };
    const blockedRects = layout.pool ? [layout.pool] : [];

    const scale = Math.min(3, Math.max(1, areaAbs / 220));
    // A seated person approaches from 1.05 m in front of a bench. Give the
    // whole interaction extra edge clearance so both the seat and approach
    // remain inside the pedestrian-safe roof band, including around holes.
    for (const p of sampleInteriorPoints(
        rand,
        outer,
        holes,
        1,
        edgeMargin + 1.2,
        taken,
        { blockedRects, itemRadiusM: 1.2 },
    )) {
        layout.benches.push({ ...p, angle: rand() * Math.PI * 2 });
    }
    if (program === 'garden') {
        // Patch half-diagonal (≤ ~2.6 m) stays under the widened margin, so a
        // rotated lawn corner can never poke through the railing line.
        for (const p of sampleInteriorPoints(
            rand,
            outer,
            holes,
            Math.round(2 * scale),
            edgeMargin + 1.2,
            taken,
            { blockedRects, itemRadiusM: 2.7 },
        )) {
            layout.lawns.push({ ...p, w: 2.2 + rand() * 1.8, d: 1.8 + rand() * 1.6, angle: rand() * Math.PI });
        }
        for (const p of sampleInteriorPoints(
            rand,
            outer,
            holes,
            Math.round(5 * scale),
            edgeMargin,
            taken,
            { blockedRects, itemRadiusM: 0.9 },
        )) {
            layout.bushes.push({ ...p, r: 0.4 + rand() * 0.45 });
        }
        for (const p of sampleInteriorPoints(
            rand,
            outer,
            holes,
            Math.round(2 * scale),
            edgeMargin,
            taken,
            { blockedRects, itemRadiusM: 1.2 },
        )) {
            layout.trees.push({ ...p, h: 2 + rand() * 1.2 });
        }
    } else if (program === 'terrace') {
        for (const p of sampleInteriorPoints(
            rand,
            outer,
            holes,
            Math.round(2 * scale),
            edgeMargin,
            taken,
            { blockedRects, itemRadiusM: 1.5 },
        )) {
            layout.sunshades.push(p);
            const angle = rand() * Math.PI * 2;
            layout.chairs.push(
                { x: p.x + Math.cos(angle) * 1.0, z: p.z + Math.sin(angle) * 1.0, angle: angle + Math.PI },
                { x: p.x - Math.cos(angle) * 1.0, z: p.z - Math.sin(angle) * 1.0, angle },
            );
        }
        for (const p of sampleInteriorPoints(
            rand,
            outer,
            holes,
            Math.round(2 * scale),
            edgeMargin,
            taken,
            { blockedRects, itemRadiusM: 0.45 },
        )) {
            layout.chairs.push({ ...p, angle: rand() * Math.PI * 2 });
        }
        for (const p of sampleInteriorPoints(
            rand,
            outer,
            holes,
            areaAbs >= 120 ? 1 : 0,
            edgeMargin,
            taken,
            { blockedRects, itemRadiusM: 0.75 },
        )) {
            layout.barbecues.push({ ...p, angle: rand() * Math.PI * 2 });
        }
    } else {
        // Track roofs get a few bushes sprinkled on the infield.
        for (const p of sampleInteriorPoints(rand, outer, holes, Math.round(3 * scale), edgeMargin, taken)) {
            layout.bushes.push({ ...p, r: 0.4 + rand() * 0.4 });
        }
    }
    return layout;
}
