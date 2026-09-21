// Select one origin-aligned subdivision for a bounded set of rendered terrain
// tiles. Choosing only the finest spacing is wrong when the spacings do not divide.
export function commonTerrainLatticeStep(steps) {
    const values = [...new Set(steps)];
    if (!values.length) return null;
    if (values.some(step => typeof step !== 'number' || !Number.isFinite(step) || step <= 0)) {
        throw new TypeError('Terrain lattice spacings must be finite positive numbers');
    }
    const tolerance = Math.max(...values) * 1e-10;
    let common = values[0];
    for (const step of values.slice(1)) {
        let a = Math.max(common, step), b = Math.min(common, step), iterations = 0;
        while (b > tolerance && iterations++ < 64) {
            const remainder = a % b;
            a = b;
            b = Math.min(remainder, b - remainder) <= tolerance ? 0 : remainder;
        }
        if (b > tolerance) throw new RangeError('Terrain lattice subdivision did not converge');
        common = a;
    }
    if (!(common > tolerance) || values.some(step => Math.abs(step - Math.round(step / common) * common) > tolerance)) {
        throw new RangeError('Terrain lattices have no supported common subdivision');
    }
    return common;
}

export function terrainLatticeStepForBounds(bounds, tileM, stepAtTile) {
    if (!bounds || !['minX', 'maxX', 'minZ', 'maxZ'].every(key => Number.isFinite(bounds[key]))
        || bounds.minX > bounds.maxX || bounds.minZ > bounds.maxZ || !(tileM > 0) || !Number.isFinite(tileM)) {
        throw new TypeError('Terrain lattice query requires finite bounds and tile size');
    }
    const minX = Math.floor(bounds.minX / tileM), maxX = Math.floor(bounds.maxX / tileM);
    const minZ = Math.floor(bounds.minZ / tileM), maxZ = Math.floor(bounds.maxZ / tileM);
    if (![minX, maxX, minZ, maxZ].every(Number.isSafeInteger)) {
        throw new RangeError('Terrain lattice tile coordinates exceed integer precision');
    }
    if ((maxX - minX + 1) * (maxZ - minZ + 1) > 256) {
        throw new RangeError('Terrain lattice query exceeds its 256-tile work limit');
    }
    const steps = new Set();
    for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
        const step = stepAtTile(x, z);
        // Absent bounded tiles supply no triangles. Their evidence is checked
        // separately; a missing spacing must not become a zero-height surface.
        if (step != null) steps.add(step);
    }
    return commonTerrainLatticeStep(steps);
}
