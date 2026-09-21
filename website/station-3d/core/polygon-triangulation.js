// Shared pure ear-clipping helpers for simple metric polygons. Both the far
// building prisms and procedural Split roofs use this one triangulation path.

export function signedArea(pts) {
    let area = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
        const point = pts[i];
        const next = pts[(i + 1) % n];
        area += point.x * next.z - next.x * point.z;
    }
    return area / 2;
}

function pointInTriangle(px, pz, ax, az, bx, bz, cx, cz) {
    const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
    const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
    const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
    const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNegative && hasPositive);
}

export function triangulate(pts) {
    const count = pts.length;
    if (count < 3) return [];
    const indices = Array.from({ length: count }, (_, index) => index);
    if (signedArea(pts) < 0) indices.reverse();

    const triangles = [];
    let remaining = indices.length;
    let guard = remaining * remaining + 1;
    while (remaining > 3 && guard-- > 0) {
        let clipped = false;
        for (let i = 0; i < remaining; i++) {
            const a = indices[(i + remaining - 1) % remaining];
            const b = indices[i];
            const c = indices[(i + 1) % remaining];
            const pa = pts[a];
            const pb = pts[b];
            const pc = pts[c];
            const orientation = (pb.x - pa.x) * (pc.z - pa.z) - (pc.x - pa.x) * (pb.z - pa.z);
            if (orientation <= 0) continue;
            let empty = true;
            for (let j = 0; j < remaining; j++) {
                const candidate = indices[j];
                if (candidate === a || candidate === b || candidate === c) continue;
                const point = pts[candidate];
                if (pointInTriangle(point.x, point.z, pa.x, pa.z, pb.x, pb.z, pc.x, pc.z)) {
                    empty = false;
                    break;
                }
            }
            if (!empty) continue;
            triangles.push([a, b, c]);
            indices.splice(i, 1);
            remaining--;
            clipped = true;
            break;
        }
        if (!clipped) break;
    }
    if (remaining === 3) triangles.push([indices[0], indices[1], indices[2]]);
    return triangles;
}
