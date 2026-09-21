// Square cast-iron manhole covers set into the pavement. Croatian covers are
// square, not round.
//
// They ride the curb rings the curbs layer already fetches and already filtered
// (a "kept" curb piece means: a real street edge, not a pedestrian zone, not a
// tram bed, not a planner track), so they need no data of their own — just an
// offset onto the pavement and a spacing. One merged mesh per tile.

import { createManholeMaterial, createManholeMesh, pushCover } from '../models/objects/manhole.js';
import { registerShared } from '../core/dispose.js';
import { applyPlannerSurfaceCutout } from './planner-surface-cutout.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
} from '../core/surface-hierarchy.js';

export const MANHOLE_SPACING_M = 200;
const MANHOLE_INSET_M = 1.3;    // from the curb line, onto the pavement
// The cover is a shallow solid, not a decal: the ground-surface stack is a
// carefully ordered list of levels and a flush quad invites z-fighting with
// whichever paving happens to win. A lid sitting a centimetre or two proud of
// the pavement is both immune and physically true.
const MANHOLE_MIN_RUN_M = 8;

let _material = null;
const MANHOLE_CLAIM = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.ROAD_DRESSING,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.UNKNOWN,
    ownerId: 'manholes',
    sourceId: 'world/manholes.js',
});

export function getManholeMaterial() {
    if (_material) return _material;
    _material = applyPlannerSurfaceCutout(createManholeMaterial(), MANHOLE_CLAIM);
    registerShared(_material);
    return _material;
}

// Stable phase from the run's first point, so a cover never jumps or vanishes
// when its tile is evicted and rebuilt.
function runPhaseM(x, z) {
    const hash = Math.imul(Math.round(x * 8) ^ 0x9e3779b9, 2654435761)
        ^ Math.imul(Math.round(z * 8) ^ 0x85ebca6b, 1597334677);
    return ((hash >>> 0) % 1000) / 1000 * MANHOLE_SPACING_M;
}

// Walks one kept run of curb line and drops a cover onto the pavement beside it
// every MANHOLE_SPACING_M. `points` are local {x, z} in the ring's own order —
// the curbs layer has already normalised the winding so the raised (pavement)
// side is on the LEFT of travel.
export function pushManholesAlongRun(out, run) {
    const points = run && run.points;
    if (!points || points.length < 2) return;

    let travelled = 0;
    let next = runPhaseM(points[0].x, points[0].z);
    let runLength = 0;
    for (let i = 0; i + 1 < points.length; i++) {
        runLength += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
    }
    if (runLength < MANHOLE_MIN_RUN_M) return;

    for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 1e-6) continue;
        const ux = dx / length;
        const uz = dz / length;
        const nx = -uz;          // raised (pavement) side — same convention as curbs.js
        const nz = ux;
        while (next <= travelled + length) {
            const t = next - travelled;
            pushCover(out.positions, out.uvs, {
                x: a.x + ux * t + nx * MANHOLE_INSET_M,
                z: a.z + uz * t + nz * MANHOLE_INSET_M,
                ux, uz, nx, nz,
            });
            next += MANHOLE_SPACING_M;
        }
        travelled += length;
    }
}

export function buildManholeMesh(out) {
    if (!out || out.positions.length === 0) return null;
    return createManholeMesh(out, getManholeMaterial());
}
