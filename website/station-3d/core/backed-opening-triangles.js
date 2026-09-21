// Removal begins at the actual stored replacement face. A plan polygon or a
// non-empty civil root alone does not prove that the requested cut is backed.
export function* captureBackedOpeningTrianglesSteps({ positions, indices, faceOffsets,
    kind, replacementKey, maxY, maxYExclusive = true, budget, originX = 0, originZ = 0 }) {
    if (!ArrayBuffer.isView(positions) || positions.length % 3 || !ArrayBuffer.isView(indices)
        || !Array.isArray(faceOffsets) || !kind || !replacementKey || maxY !== null && !Number.isFinite(maxY)
        || ![originX, originZ].every(Number.isFinite)) {
        throw new TypeError('Backed openings require stored faces, an owner and an explicit ceiling');
    }
    const regions = [];
    for (const offset of faceOffsets) {
        yield* budget.step('planner-backed-opening');
        budget.take('maxCuts');
        if (!Number.isSafeInteger(offset) || offset < 0 || offset % 3 || offset + 3 > indices.length) {
            throw new TypeError('Invalid replacement face offset');
        }
        const face = [];
        for (let j = 0; j < 3; j++) {
            const index = indices[offset + j];
            if (!Number.isSafeInteger(index) || index < 0 || index * 3 + 2 >= positions.length) {
                throw new TypeError('Invalid replacement vertex index');
            }
            const p = { x: positions[index * 3] + originX, y: positions[index * 3 + 1], z: positions[index * 3 + 2] + originZ };
            if (![p.x, p.y, p.z].every(Number.isFinite)) throw new TypeError('Nonfinite replacement vertex');
            face.push(p);
        }
        const [a, b, c] = face;
        const ux = b.x-a.x, uy = b.y-a.y, uz = b.z-a.z;
        const vx = c.x-a.x, vy = c.y-a.y, vz = c.z-a.z;
        const up = uz*vx-ux*vz;
        if (!(up > 0)) throw new TypeError('An excavation requires an upward replacement face');
        const slopeX = -(uy*vz-uz*vy)/up, slopeZ = -(ux*vy-uy*vx)/up;
        if (![slopeX, slopeZ].every(Number.isFinite)) throw new TypeError('Invalid replacement floor plane');
        const ring = Object.freeze(face.map(({x,z}) => Object.freeze({x,z})));
        regions.push(Object.freeze({ kind, replacementKey, ring,
            bounds: Object.freeze({ minX: Math.min(a.x,b.x,c.x), minZ: Math.min(a.z,b.z,c.z),
                maxX: Math.max(a.x,b.x,c.x), maxZ: Math.max(a.z,b.z,c.z) }),
            minPlane: Object.freeze({ ...a, slopeX, slopeZ }), minY: null, maxY, maxYExclusive }));
    }
    budget.check(); return Object.freeze(regions);
}
