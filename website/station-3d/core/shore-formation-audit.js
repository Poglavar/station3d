// Pure shore-formation probe. The surface audit judges stacking (inversion,
// coplanar, floating, void, duplicate) and passes a flat sand apron that
// slides under the sea, which is how Split's Riva stayed wrong for a day
// (2026-09-16). This measures the rendered world along the mapped shoreline
// instead: where paved ground backs the shore, the ground just inland must
// stand on a face above the sea, not ramp down into it. Natural banks and
// beaches are expected to ramp and are reported, never counted.

import { finiteOrNull } from './math.js';

export const SHORE_FORMATION_CONTRACT = 'station3d-shore-formation-audit-v1';
export const SHORE_NEAR_M = 1;         // just inland of the mapped waterline
export const SHORE_INLAND_M = 8;       // where the promenade grade is unambiguous
export const SHORE_RAMP_MAX_M = 0.2;   // the near ground may sit at most this far below the inland grade
export const SHORE_GRADE_MIN_M = 0.28; // ...once the inland ground reaches the quay freeboard floor

export const SHORE_KIND = Object.freeze({
    UNSAMPLED: 'unsampled',            // no rendered ground at one of the two samples
    NATURAL: 'natural',                // nothing paved behind the shore: a bank may ramp
    LOW: 'low-paved-shore',            // paved, but too low above the sea for a quay to be expected
    RAMPED: 'ramped-paved-shore',      // paved ground that slides into the sea without a face
    CLEAN: 'clean',
});

function finitePoint(point) {
    return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function landwardUnit(shore, land) {
    if (!finitePoint(shore) || !finitePoint(land)) return null;
    const dx = land[0] - shore[0];
    const dz = land[1] - shore[1];
    const length = Math.hypot(dx, dz);
    return length > 1e-6 ? { x: dx / length, z: dz / length } : null;
}

// One collar quad (shoreA/shoreB on the waterline, landA/landB inland).
export function auditShoreQuad(quad, {
    seaY,
    topYAt,
    pavedAt,
    nearM = SHORE_NEAR_M,
    inlandM = SHORE_INLAND_M,
    rampMaxM = SHORE_RAMP_MAX_M,
    gradeMinM = SHORE_GRADE_MIN_M,
} = {}) {
    const sea = finiteOrNull(seaY);
    if (sea === null || typeof topYAt !== 'function') return null;
    const shoreA = quad?.shoreA;
    const shoreB = quad?.shoreB;
    if (!finitePoint(shoreA) || !finitePoint(shoreB)) return null;
    const mid = [(shoreA[0] + shoreB[0]) / 2, (shoreA[1] + shoreB[1]) / 2];
    const direction = landwardUnit(mid, quad?.landA && quad?.landB
        ? [(quad.landA[0] + quad.landB[0]) / 2, (quad.landA[1] + quad.landB[1]) / 2]
        : null);
    if (!direction) return null;
    const at = distance => [mid[0] + direction.x * distance, mid[1] + direction.z * distance];
    const near = at(nearM);
    const inland = at(inlandM);
    const nearY = finiteOrNull(topYAt(near[0], near[1]));
    const inlandY = finiteOrNull(topYAt(inland[0], inland[1]));
    const sample = {
        x: mid[0], z: mid[1], nearY, inlandY,
        nearFreeboardM: nearY === null ? null : nearY - sea,
        inlandFreeboardM: inlandY === null ? null : inlandY - sea,
        // A quay face puts the shore at the promenade grade; a ramp leaves it well below.
        dropM: nearY === null || inlandY === null ? null : inlandY - nearY,
        paved: typeof pavedAt === 'function' && pavedAt(inland[0], inland[1]) === true,
    };
    if (nearY === null || inlandY === null) return { ...sample, kind: SHORE_KIND.UNSAMPLED };
    if (!sample.paved) return { ...sample, kind: SHORE_KIND.NATURAL };
    if (sample.inlandFreeboardM < gradeMinM) return { ...sample, kind: SHORE_KIND.LOW };
    if (sample.dropM > rampMaxM) return { ...sample, kind: SHORE_KIND.RAMPED };
    return { ...sample, kind: SHORE_KIND.CLEAN };
}

export function auditShoreQuads(quads, options) {
    const byKind = {};
    const ramped = [];
    let quadCount = 0;
    for (const quad of quads || []) {
        const result = auditShoreQuad(quad, options);
        if (!result) continue;
        quadCount += 1;
        byKind[result.kind] = (byKind[result.kind] || 0) + 1;
        if (result.kind === SHORE_KIND.RAMPED) ramped.push(result);
    }
    return Object.freeze({
        contract: SHORE_FORMATION_CONTRACT,
        seaY: finiteOrNull(options?.seaY),
        quadCount,
        byKind: Object.freeze(byKind),
        ramped: Object.freeze(ramped),
    });
}
