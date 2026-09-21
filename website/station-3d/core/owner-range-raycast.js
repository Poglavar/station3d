import { Box3, Matrix4, Mesh, Ray } from 'three';

// Material batching joins disjoint buildings into one large bounding box.
// Keep their assembly-time bounds for picking/support queries too. The actual
// triangle, material-side, near/far, UV and face-index rules remain Three's.
export function createOwnerRangeRaycast(ranges) {
    if (!Array.isArray(ranges) || ranges.some(range =>
        !Number.isSafeInteger(range.start) || range.start < 0 || range.start % 3
        || !Number.isSafeInteger(range.count) || range.count <= 0 || range.count % 3)) {
        throw new TypeError('Raycast ranges require complete owner triangles');
    }
    const inverse = new Matrix4(), localRay = new Ray(), box = new Box3();
    return function raycastOwners(raycaster, hits) {
        const geometry = this.geometry;
        if (this.material === undefined) return;
        inverse.copy(this.matrixWorld).invert();
        localRay.copy(raycaster.ray).applyMatrix4(inverse);
        if (geometry.boundingBox && !localRay.intersectsBox(geometry.boundingBox)) return;
        const { start, count } = geometry.drawRange;
        try {
            for (const range of ranges) {
                const from = Math.max(start, range.start);
                const to = Math.min(start + count, range.start + range.count);
                if (from >= to) continue;
                const bounds = range.bounds;
                if (bounds) {
                    box.min.set(bounds.minX, bounds.minY, bounds.minZ);
                    box.max.set(bounds.maxX, bounds.maxY, bounds.maxZ);
                    // A transformed ray may round just past an owner's edge
                    // while Three's triangle test still accepts that edge.
                    // Expand only this rejection box; support geometry is exact.
                    box.expandByScalar(1e-7 * Math.max(1,
                        Math.abs(bounds.minX), Math.abs(bounds.minY), Math.abs(bounds.minZ),
                        Math.abs(bounds.maxX), Math.abs(bounds.maxY), Math.abs(bounds.maxZ)));
                    if (!localRay.intersectsBox(box)) continue;
                }
                // Raycasting is synchronous. Narrow the native triangle loop,
                // then restore the render range even if an intersection throws.
                geometry.drawRange.start = from;
                geometry.drawRange.count = to - from;
                Mesh.prototype.raycast.call(this, raycaster, hits);
            }
        } finally {
            geometry.drawRange.start = start;
            geometry.drawRange.count = count;
        }
    };
}
