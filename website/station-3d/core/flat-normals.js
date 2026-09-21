// Face normals for a NON-INDEXED position buffer, computable a slice at a time.
//
// three.js's computeVertexNormals() is one uninterruptible call over the whole
// buffer. Decor merges every green/paved surface within its radius into a single
// geometry per surface type and then calls it once: measured at 71 ms inside a
// 171 ms step that no frame budget can interrupt, because a budget decides
// whether to yield BETWEEN steps and cannot split one.
//
// For a non-indexed buffer every triangle owns its three vertices outright, so
// no vertex is shared and no accumulation crosses a triangle boundary. Computing
// a range of triangles is therefore EXACTLY equivalent to computing all of them
// — which is what makes this splittable at all, and why it would be wrong for an
// indexed geometry, where neighbouring faces sum into a shared vertex.
//
// The formula is three.js's, deliberately: cb = (C - B) × (A - B), written to
// all three vertices, normalised at the end. Any other winding or cross order
// flips the lighting.

// Triangles [startTriangle, endTriangle) — one triangle is 3 vertices, 9 floats.
export function computeFlatNormalsRange(positions, normals, startTriangle, endTriangle) {
    for (let triangle = startTriangle; triangle < endTriangle; triangle++) {
        const a = triangle * 9;
        const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
        const bx = positions[a + 3], by = positions[a + 4], bz = positions[a + 5];
        const cx = positions[a + 6], cy = positions[a + 7], cz = positions[a + 8];
        // cb = C - B, ab = A - B, n = cb × ab
        const cbx = cx - bx, cby = cy - by, cbz = cz - bz;
        const abx = ax - bx, aby = ay - by, abz = az - bz;
        const nx = cby * abz - cbz * aby;
        const ny = cbz * abx - cbx * abz;
        const nz = cbx * aby - cby * abx;
        normals[a] = nx; normals[a + 1] = ny; normals[a + 2] = nz;
        normals[a + 3] = nx; normals[a + 4] = ny; normals[a + 5] = nz;
        normals[a + 6] = nx; normals[a + 7] = ny; normals[a + 8] = nz;
    }
}

// Unit-length, in place. Separate from the range pass so a chunked caller
// normalises once at the end rather than re-walking each slice.
//
// A degenerate triangle keeps a zero-length normal, matching three.js's
// zero-vector normalization and avoiding non-finite lighting inputs.
export function normalizeNormals(normals) {
    for (let index = 0; index < normals.length; index += 3) {
        const x = normals[index], y = normals[index + 1], z = normals[index + 2];
        const length = Math.sqrt(x * x + y * y + z * z);
        if (length === 0) continue;
        normals[index] = x / length;
        normals[index + 1] = y / length;
        normals[index + 2] = z / length;
    }
}

export function triangleCount(positions) {
    return Math.floor(positions.length / 9);
}

// Non-indexed surface buffers, prepared without a whole-buffer conversion or
// normal pass between cooperative checkpoints. The consumer can attach the
// returned typed arrays directly with BufferAttribute, which avoids a copy.
export function* prepareFlatSurfaceBuffersSteps(values, chunkTriangles = 2000) {
    if (!Number.isSafeInteger(chunkTriangles) || chunkTriangles < 1
        || !Number.isSafeInteger(values?.length) || values.length % 9 !== 0) {
        throw new TypeError('Flat surface preparation requires complete triangles and a positive chunk size');
    }
    const positions = new Float32Array(values.length);
    const normals = new Float32Array(values.length);
    const count = triangleCount(positions);
    for (let start = 0; start < count; start += chunkTriangles) {
        const end = Math.min(count, start + chunkTriangles);
        for (let i = start * 9; i < end * 9; i++) positions[i] = values[i];
        computeFlatNormalsRange(positions, normals, start, end);
        normalizeNormals(normals.subarray(start * 9, end * 9));
        yield { preparedTriangles: end };
    }
    return { positions, normals };
}
