// Converts already-filtered visible curb triangles into one bounded Rapier
// trimesh, preserving their real 18 cm face and climbable stone top.

function finiteNumberOrNull(value, offset = 0) {
    const translated = typeof value === 'number' ? value + offset : NaN;
    return Number.isFinite(translated) ? translated : null;
}

export function* buildCurbSurfaceTrimeshDataSteps({
    surfaces = [],
    centerX,
    centerZ,
    radiusM,
    toPhysics = (x, z) => ({ x, z }),
    physicsOrigin = null,
    maxTriangles = 8000,
    now = () => performance.now(),
    isCurrent = () => true,
} = {}) {
    const clock = typeof now === 'function' ? now : (() => performance.now());
    const current = typeof isCurrent === 'function' ? isCurrent : (() => true);
    const x = finiteNumberOrNull(centerX);
    const z = finiteNumberOrNull(centerZ);
    const radius = finiteNumberOrNull(radiusM);
    if (x === null || z === null || radius === null || radius <= 0
        || typeof toPhysics !== 'function') {
        return {
            vertices: new Float32Array(),
            indices: new Uint32Array(),
            triangleCount: 0,
            truncated: false,
        };
    }
    if (!current()) return null;
    const radiusSquared = radius * radius;
    const limit = Math.max(0, Math.trunc(finiteNumberOrNull(maxTriangles) ?? 8000));
    // Allocate the bounded result
    // once rather than growing two generic JS arrays and then copying them into
    // typed arrays on every 30 m physics-bubble refresh.
    const vertices = new Float32Array(limit * 9);
    const indices = new Uint32Array(limit * 3);
    const originX = finiteNumberOrNull(physicsOrigin?.x);
    const originZ = finiteNumberOrNull(physicsOrigin?.z);
    const directOriginTransform = originX !== null && originZ !== null;
    let triangleCount = 0;
    let truncated = false;
    let budgetStarted = clock();
    outer: for (const surface of Array.isArray(surfaces) ? surfaces : []) {
        const surfaceOriginX = surface?.originX ?? 0, surfaceOriginZ = surface?.originZ ?? 0;
        if (![surfaceOriginX, surfaceOriginZ].every(Number.isFinite)) throw new TypeError('Physical receiver requires a finite origin');
        const positionSets = [
            { positions: surface?.positions, inputIndices: surface?.indices },
            ...(Array.isArray(surface?.additionalPositions)
                ? surface.additionalPositions.map((positions, index) => ({ positions,
                    inputIndices: surface?.additionalIndices?.[index] }))
                : []),
        ];
        for (const input of positionSets) {
            const positions = input.positions, inputIndices = input.inputIndices;
            if (!positions || positions.length < 9) continue;
            const triangleTotal = inputIndices ? Math.floor(inputIndices.length / 3) : Math.floor(positions.length / 9);
            for (let triangle = 0; triangle < triangleTotal; triangle++) {
                const offset = triangle * 9;
                // The same checkpoint covers every scanned triangle, including
                // invalid and distant input. A continue cannot skip the budget.
                if (clock() - budgetStarted >= 0.5) {
                    yield;
                    budgetStarted = clock();
                }
                if (!current()) return null;
                const ia = inputIndices ? inputIndices[triangle * 3] * 3 : offset;
                const ib = inputIndices ? inputIndices[triangle * 3 + 1] * 3 : offset + 3;
                const ic = inputIndices ? inputIndices[triangle * 3 + 2] * 3 : offset + 6;
                const ax = finiteNumberOrNull(positions[ia], surfaceOriginX);
                const ay = finiteNumberOrNull(positions[ia + 1]);
                const az = finiteNumberOrNull(positions[ia + 2], surfaceOriginZ);
                const bx = finiteNumberOrNull(positions[ib], surfaceOriginX);
                const by = finiteNumberOrNull(positions[ib + 1]);
                const bz = finiteNumberOrNull(positions[ib + 2], surfaceOriginZ);
                const cx = finiteNumberOrNull(positions[ic], surfaceOriginX);
                const cy = finiteNumberOrNull(positions[ic + 1]);
                const cz = finiteNumberOrNull(positions[ic + 2], surfaceOriginZ);
                if ([ax, ay, az, bx, by, bz, cx, cy, cz]
                    .some(value => value === null)) continue;
                const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
                const minZ = Math.min(az, bz, cz), maxZ = Math.max(az, bz, cz);
                const nearestX = x < minX ? minX : x > maxX ? maxX : x;
                const nearestZ = z < minZ ? minZ : z > maxZ ? maxZ : z;
                if ((nearestX - x) ** 2 + (nearestZ - z) ** 2 > radiusSquared) continue;
                if (triangleCount >= limit) {
                    truncated = true;
                    break outer;
                }
                let pax, paz, pbx, pbz, pcx, pcz;
                if (directOriginTransform) {
                    pax = ax - originX;
                    paz = az - originZ;
                    pbx = bx - originX;
                    pbz = bz - originZ;
                    pcx = cx - originX;
                    pcz = cz - originZ;
                } else {
                    const physicsA = toPhysics(ax, az);
                    const physicsB = toPhysics(bx, bz);
                    const physicsC = toPhysics(cx, cz);
                    pax = physicsA?.x;
                    paz = physicsA?.z;
                    pbx = physicsB?.x;
                    pbz = physicsB?.z;
                    pcx = physicsC?.x;
                    pcz = physicsC?.z;
                }
                if (![pax, paz, pbx, pbz, pcx, pcz].every(Number.isFinite)) continue;
                const vertexOffset = triangleCount * 9;
                vertices[vertexOffset] = pax;
                vertices[vertexOffset + 1] = ay;
                vertices[vertexOffset + 2] = paz;
                vertices[vertexOffset + 3] = pbx;
                vertices[vertexOffset + 4] = by;
                vertices[vertexOffset + 5] = pbz;
                vertices[vertexOffset + 6] = pcx;
                vertices[vertexOffset + 7] = cy;
                vertices[vertexOffset + 8] = pcz;
                const indexOffset = triangleCount * 3;
                const baseIndex = triangleCount * 3;
                indices[indexOffset] = baseIndex;
                indices[indexOffset + 1] = baseIndex + 1;
                indices[indexOffset + 2] = baseIndex + 2;
                triangleCount += 1;
            }
        }
    }
    if (!current()) return null;
    const usedVertexValues = triangleCount * 9;
    const usedIndexValues = triangleCount * 3;
    return {
        vertices: usedVertexValues === vertices.length
            ? vertices : vertices.subarray(0, usedVertexValues),
        indices: usedIndexValues === indices.length
            ? indices : indices.subarray(0, usedIndexValues),
        triangleCount,
        truncated,
    };
}

export function buildCurbSurfaceTrimeshData(options = {}) {
    const steps = buildCurbSurfaceTrimeshDataSteps(options);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}
