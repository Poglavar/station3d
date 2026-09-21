// Pure geometry helpers for the far LOD1 building layer — no three.js, no DOM —
// so the projection and height rules are unit-testable headless. The far layer
// turns these into extruded prisms; it MUST project identically to the detailed
// layer (both go through geoToLocal) or a building would visibly shift the moment
// it swaps between LOD1 and its detailed mesh.
import { geoToLocal } from '../core/math.js';
import { signedArea, triangulate } from '../core/polygon-triangulation.js';
import { compileLod1BuildingPrisms } from '../core/lod1-prism-geometry.js';
import {
    estimateOvertureBuildingHeight,
    GREENHOUSE_RIDGE_HEIGHT_M,
    isGreenhouseBuilding,
} from '../core/overture-building-shape.js';

export { signedArea, triangulate } from '../core/polygon-triangulation.js';

export const FAR_MIN_HEIGHT_M = 2;       // never a zero-height sliver
export const FAR_FALLBACK_HEIGHT_M = 6;  // ~mean GDI eave, used when height is unknown

// Wall height for a far box: the surveyed eave height, clamped to a floor; a sane
// default when GDI gave no height (the handful of meshes with no gdi_building row).
export function pickFarHeight(eaveHeightM) {
    const h = Number(eaveHeightM);
    if (!Number.isFinite(h) || h <= 0) return FAR_FALLBACK_HEIGHT_M;
    return Math.max(h, FAR_MIN_HEIGHT_M);
}

// Far height for one fetched feature. Must match what the DETAILED layer builds
// at the swap, or the building visibly grows/shrinks when the hand-off happens:
//  - a real eave height wins (always present on GDI; on Overture it is the same
//    COALESCE(height, floors × 3) the detailed endpoint sends);
//  - an Overture feature WITHOUT one (Split is ~95% height-poor) gets the same
//    area+seed estimate the detailed layer runs — a flat fallback would make
//    nearly every building pop at the ~300 m hand-off;
//  - anything else takes the flat default.
export function pickFarHeightForFeature(properties, geometry, anchorLat) {
    if (isGreenhouseBuilding(properties)) return GREENHOUSE_RIDGE_HEIGHT_M;
    const eave = Number(properties?.eave_height_m);
    if (Number.isFinite(eave) && eave > 0) return pickFarHeight(eave);
    // No measured height, so mirror whatever the detailed layer will invent.
    // Two ways to be in that position, and both must estimate:
    //  - an Overture feature (the old all-or-nothing fill);
    //  - a /buildings-render feature the resolver put at tier 3, which says so
    //    with height_source 'none'. Without this branch those took the flat
    //    default here while the detailed layer estimated, so every one of them
    //    popped at the ~300 m hand-off.
    const unmeasured = properties?.source === 'overture' || properties?.height_source === 'none';
    if (unmeasured) {
        return pickFarHeight(
            estimateOvertureBuildingHeight(geometry, properties?.object_id, anchorLat));
    }
    return pickFarHeight(null);
}

// Frame budget for the far-building build queue.
//
// The horizon ring exists to give context EARLY — it is the cheapest geometry in
// the world (a flat-topped prism) and the whole point of it is to be there
// before the detailed buildings are. Running it at the steady trickle from a
// cold start inverts that: the first ring is ~9 tiles x 600 prisms, and at 2 ms
// a frame that is tens of seconds during which the distance is empty.
//
// So: a real slice until the first full ring is built, the trickle thereafter.
// It still yields to near work by workClass — this changes how much far gets
// when it does run, not whether near comes first.
export const FAR_PRIME_BUDGET_MS = 8;
export const FAR_STEADY_BUDGET_MS = 2;

export function farFrameBudgetMs(tilesBuilt, {
    primeTiles,
    primeMs = FAR_PRIME_BUDGET_MS,
    steadyMs = FAR_STEADY_BUDGET_MS,
} = {}) {
    const built = Number(tilesBuilt);
    const target = Number(primeTiles);
    if (!Number.isFinite(built) || !Number.isFinite(target) || target <= 0) return steadyMs;
    return built >= target ? steadyMs : primeMs;
}

// Project a GeoJSON ring ([[lon,lat], …]) to local metres around the anchor, as
// flat {x, z} pairs in the same basis the detailed meshes use.
export function projectRing(ring, anchorLon, anchorLat) {
    const out = [];
    for (let i = 0; i < ring.length; i++) {
        const { x, z } = geoToLocal(ring[i][0], ring[i][1], anchorLon, anchorLat);
        out.push({ x, z });
    }
    return out;
}

// Signed-area and forgiving ear-clipping helpers are re-exported from the
// shared pure module above; detailed and far roofs now use the same logic.

// Build a flat-topped prism for one footprint ring: quad walls (no triangulation)
// plus a triangulated roof cap. Floor cap is omitted — it sits on the ground and
// is never seen. Base at y=0, top at y=height. Input `ring` is {x, z} points in
// local metres (a GeoJSON ring's repeated closing vertex is tolerated/stripped).
// Returns plain arrays; the caller wraps them in a BufferGeometry and computes
// normals. Pure and three.js-free so it is unit-tested headless.
export function buildPrism(ring, height, out = { positions: [], indices: [] }, baseY = 0) {
    let pts = ring;
    const n = ring.length;
    if (n >= 4 && ring[0].x === ring[n - 1].x && ring[0].z === ring[n - 1].z) {
        pts = ring.slice(0, -1);   // drop GeoJSON closing duplicate
    }
    // WINDING DECIDES WHICH WAY EVERY FACE POINTS, and the far material is
    // FrontSide, so a ring wound the wrong way is not a subtle shading issue —
    // the prism renders inside-out. The near walls are culled, you see the far
    // walls from behind (reads as "only 2 of the 4 sides are drawn") and the
    // roof cap faces the ground, so there is no roof at all.
    //
    // Every real footprint hits this: measured over a centre tile, 600 of 600
    // rings came back with POSITIVE signed area, which in this frame (+x east,
    // +y up, +z SOUTH — geoToLocal negates latitude, flipping the sense of the
    // usual GeoJSON right-hand rule) is the inward-facing one. So the whole
    // LOD1 horizon was inside-out, not just the odd building.
    //
    // Normalise here rather than at the callers: this is the function that
    // decides face order, and both consumers (the far ring and the terrain
    // drape) feed it straight from GeoJSON, which does not guarantee winding.
    if (signedArea(pts) > 0) pts = pts.slice().reverse();
    const m = pts.length;
    if (m < 3) return out;

    const { positions, indices } = out;
    const base = positions.length / 3;   // first new vertex index (for merging)

    // Walls: two stacked rings of vertices (bottom then top), quads per edge.
    // baseY lifts the whole prism onto the DGU terrain (0 in the flat world).
    for (let i = 0; i < m; i++) positions.push(pts[i].x, baseY, pts[i].z);            // bottom ring
    for (let i = 0; i < m; i++) positions.push(pts[i].x, baseY + height, pts[i].z);   // top ring
    for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        const b0 = base + i, b1 = base + j;          // bottom edge
        const t0 = base + m + i, t1 = base + m + j;  // top edge
        indices.push(b0, b1, t1, b0, t1, t0);        // two triangles of the wall quad
    }

    // Roof cap over the top ring.
    //
    // Orient each triangle ITSELF rather than trusting the ring: triangulate()
    // is deliberately winding-INDEPENDENT (it has to survive either input), so
    // it gives no guarantee about the order it emits, and normalising the ring
    // above does not propagate here. Measured: with the ring corrected, every
    // cap triangle still came out facing down.
    //
    // A triangle's upward normal is y = -2 * its 2D signed area, so a NEGATIVE
    // signed area faces up; swap the last two vertices when it does not.
    for (const [a, b, c] of triangulate(pts)) {
        const up = signedArea([pts[a], pts[b], pts[c]]) < 0;
        indices.push(
            base + m + a,
            base + m + (up ? b : c),
            base + m + (up ? c : b),
        );
    }
    return out;
}

// The polygon rings of a GeoJSON building geometry, outer ring per part only
// (holes are invisible at LOD1 range and dropped). Returns [] for anything that
// is not a Polygon/MultiPolygon or has no usable ring.
export function outerRings(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') {
        const outer = geometry.coordinates && geometry.coordinates[0];
        return outer && outer.length >= 4 ? [outer] : [];
    }
    if (geometry.type === 'MultiPolygon') {
        const rings = [];
        for (const part of geometry.coordinates || []) {
            const outer = part && part[0];
            if (outer && outer.length >= 4) rings.push(outer);
        }
        return rings;
    }
    return [];
}

// One GeoJSON building (Polygon/MultiPolygon) → a single merged prism mesh in
// anchor-local metres, as typed arrays ready for a BufferGeometry. Returns null
// when there is nothing to build. Pure; the caller adds normals + material.
export function buildBuildingPrisms(geometry, height, anchorLon, anchorLat, baseY = 0) {
    // Terrain draping and far render packets share source-space topology.
    return compileLod1BuildingPrisms(geometry, height, anchorLon, anchorLat, baseY);
}
