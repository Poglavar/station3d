// Landscaping layout for the COURTYARDS of new-build (proposal) blocks — pure,
// no THREE, no DOM. A perimeter-block footprint carries its courtyard as a hole
// ring; nothing was drawn inside it, so the block enclosed bare ground.
//
// Given the hole ring and a stable per-building hash this lays out, in local
// scene metres: the lawn (the hole itself), a paved perimeter path with a
// crossing leg, and the planting and benches placed off the paving.
//
// Sibling of core/new-build-roof-decor.js and deliberately the same shape: the
// world layer turns this into ONE merged vertex-coloured mesh per courtyard.

import { geoToLocal } from './math.js';
import { offsetRingOutward } from './ring-offset.js';

export const COURTYARD_PATH_INSET_M = 2.2;      // wall → outer edge of the path
export const COURTYARD_PATH_WIDTH_M = 1.4;
// Below this a "courtyard" is a light well or an air shaft, not a garden.
const MIN_COURTYARD_AREA_M2 = 45;
const MIN_PATH_AREA_M2 = 140;
// Planting keeps off the paving and off the walls.
const PLANT_EDGE_MARGIN_M = 0.9;
const ITEM_SPACING_M = 1.7;
const MAX_SAMPLE_ATTEMPTS_PER_ITEM = 8;

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
        const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
        if (d < best) best = d;
    }
    return best;
}

// A courtyard hole ring is wound OPPOSITE to its outer ring, so "into the
// courtyard" is the outward side of the hole as a standalone ring. Both
// candidates are generated and the one that shrinks the enclosed area is the
// inward one — winding-agnostic, so a differently wound source cannot invert it.
function insetHoleRing(holeLonLat, insetM, anchorLat, anchorLon, areaAbs) {
    for (const metres of [-insetM, insetM]) {
        const candidate = localRing(
            offsetRingOutward(holeLonLat, metres), anchorLat, anchorLon,
        );
        if (!candidate) continue;
        const area = Math.abs(localRingArea(candidate));
        if (area > 1 && area < areaAbs) return candidate;
    }
    return null;
}

function sampleInterior(rand, ring, count, edgeMargin, taken, keepOut = []) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of ring) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const points = [];
    let attempts = count * MAX_SAMPLE_ATTEMPTS_PER_ITEM;
    while (points.length < count && attempts-- > 0) {
        const x = minX + rand() * (maxX - minX);
        const z = minZ + rand() * (maxZ - minZ);
        if (!pointInRing(x, z, ring)) continue;
        if (distanceToRing(x, z, ring) < edgeMargin) continue;
        // Off the paving: a bench or bush standing in the path reads as a fault.
        if (keepOut.some(band => distanceToRing(x, z, band) < 0.8)) continue;
        if (taken.some(other => (
            (other.x - x) ** 2 + (other.z - z) ** 2 < ITEM_SPACING_M * ITEM_SPACING_M
        ))) continue;
        const point = { x, z };
        points.push(point);
        taken.push(point);
    }
    return points;
}

function ringCentroid(points) {
    let x = 0, z = 0;
    const n = points.length - 1;
    for (let i = 0; i < n; i++) { x += points[i].x; z += points[i].z; }
    return { x: x / n, z: z / n };
}

/**
 * Landscaping for ONE courtyard, or null when the hole is too small to plant.
 *
 * @param holeLonLat  the footprint's hole ring (closed, lon/lat)
 * @param anchorLat/anchorLon scene anchor — same frame the building is built in
 * @param hash        stable per-building hash (drives placement)
 */
export function newBuildCourtyardLayout(holeLonLat, anchorLat, anchorLon, hash) {
    const lawn = localRing(holeLonLat, anchorLat, anchorLon);
    if (!lawn) return null;
    const areaAbs = Math.abs(localRingArea(lawn));
    if (!(areaAbs >= MIN_COURTYARD_AREA_M2)) return null;

    const rand = seededRandom((Number(hash) >>> 0) ^ 0x7f4a7c15);
    const layout = {
        lawn,
        areaM2: areaAbs,
        path: null,
        pathLegs: [],
        bushes: [],
        trees: [],
        benches: [],
    };

    // Perimeter path, and a straight leg across it so the courtyard reads as
    // circulation rather than decoration. Skipped on small courts, where a ring
    // path would eat the whole garden.
    const keepOut = [];
    if (areaAbs >= MIN_PATH_AREA_M2) {
        const outer = insetHoleRing(holeLonLat, COURTYARD_PATH_INSET_M, anchorLat, anchorLon, areaAbs);
        const inner = insetHoleRing(
            holeLonLat, COURTYARD_PATH_INSET_M + COURTYARD_PATH_WIDTH_M, anchorLat, anchorLon, areaAbs,
        );
        if (outer && inner && outer.length === inner.length) {
            layout.path = { outer, inner };
            keepOut.push(outer, inner);
            // One crossing leg between opposite points of the inner ring.
            const centre = ringCentroid(inner);
            const start = inner[0];
            const opposite = inner[Math.floor((inner.length - 1) / 2)];
            layout.pathLegs.push({
                a: { x: start.x, z: start.z },
                b: { x: opposite.x, z: opposite.z },
                widthM: COURTYARD_PATH_WIDTH_M,
                centre,
            });
        }
    }

    const taken = [];
    const scale = Math.min(4, Math.max(1, areaAbs / 160));
    for (const spot of sampleInterior(rand, lawn, Math.round(2 * scale), PLANT_EDGE_MARGIN_M + 1.1, taken, keepOut)) {
        layout.trees.push({ ...spot, h: 3.2 + rand() * 2.4 });
    }
    for (const spot of sampleInterior(rand, lawn, Math.round(5 * scale), PLANT_EDGE_MARGIN_M, taken, keepOut)) {
        layout.bushes.push({ ...spot, r: 0.45 + rand() * 0.5 });
    }
    // Benches face the courtyard's middle, which is where a real one points.
    const centre = ringCentroid(lawn);
    for (const spot of sampleInterior(rand, lawn, Math.max(1, Math.round(1.2 * scale)), PLANT_EDGE_MARGIN_M + 0.4, taken, keepOut)) {
        layout.benches.push({
            ...spot,
            angle: Math.atan2(centre.z - spot.z, centre.x - spot.x) + Math.PI / 2,
        });
    }
    return layout;
}

/** Explicit courtyard rings, laid out independently of parcel-clipped building pieces. */
export function newBuildCourtyardLayoutsFromRings(courtyardRings, anchorLat, anchorLon, hash) {
    const rings = Array.isArray(courtyardRings) ? courtyardRings : [];
    const layouts = [];
    for (let index = 0; index < rings.length; index++) {
        const layout = newBuildCourtyardLayout(
            rings[index], anchorLat, anchorLon, (Number(hash) >>> 0) + (index + 1) * 7919,
        );
        if (layout) layouts.push(layout);
    }
    return layouts;
}

/** Every courtyard hole of a footprint, laid out. Outer ring is not a court. */
export function newBuildCourtyardLayouts(polygonCoords, anchorLat, anchorLon, hash) {
    const rings = Array.isArray(polygonCoords) ? polygonCoords : [];
    return newBuildCourtyardLayoutsFromRings(rings.slice(1), anchorLat, anchorLon, hash);
}
