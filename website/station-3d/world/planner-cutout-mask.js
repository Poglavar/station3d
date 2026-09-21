// Rasterize captured physical opening polygons for remaining shader consumers.
// World boundaries come from the civil contract; no minimum-pixel stroke may
// enlarge a trench. Each canvas operation draws only one bounded polygon.
import * as THREE from 'three';

export function* preparePlannerCutoutMaskSteps(regions, { budget,
    createCanvas = () => document.createElement('canvas'), maxSizePx = 2048, metresPerPixel = .65 } = {}) {
    if (!Array.isArray(regions) || !budget?.step || !Number.isSafeInteger(maxSizePx)
        || maxSizePx < 256 || maxSizePx > 2048 || (maxSizePx & (maxSizePx - 1))
        || !Number.isFinite(metresPerPixel) || metresPerPixel <= 0) throw new TypeError('Invalid planner mask preparation');
    budget.check();
    if (regions.length > budget.limits.maxCuts) throw Object.assign(new Error('Planner mask capacity exceeded'), { code: 'ground-generation-capacity' });
    if (!regions.length) return null;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const kinds = [];
    for (const region of regions) {
        yield* budget.step('planner-mask-bounds');
        if (!Array.isArray(region.ring) || region.ring.length < 3 || region.ring.length > 64) throw new TypeError('Planner mask requires bounded convex regions');
        for (const point of region.ring) {
            if (![point.x, point.z].every(Number.isFinite)) throw new TypeError('Planner mask coordinates must be finite');
            minX = Math.min(minX, point.x); minZ = Math.min(minZ, point.z);
            maxX = Math.max(maxX, point.x); maxZ = Math.max(maxZ, point.z);
        }
        kinds.push(region.kind);
    }
    const centerX = (minX + maxX) * .5, centerZ = (minZ + maxZ) * .5;
    const halfSizeM = Math.max(16, Math.ceil(Math.max(maxX - minX, maxZ - minZ) * .5 + 4));
    if (![centerX, centerZ, halfSizeM].every(Number.isFinite)) throw new TypeError('Planner mask bounds are not finite');
    const sizePx = Math.min(maxSizePx, Math.max(256, 2 ** Math.ceil(Math.log2(halfSizeM * 2 / metresPerPixel))));
    const canvas = createCanvas();
    let texture = null, handedOff = false;
    try {
        canvas.width = canvas.height = sizePx;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Planner mask canvas is unavailable');
        context.fillStyle = '#000'; context.fillRect(0, 0, sizePx, sizePx);
        context.fillStyle = '#fff';
        const pixelX = x => (x - centerX + halfSizeM) / (2 * halfSizeM) * sizePx;
        const pixelZ = z => (z - centerZ + halfSizeM) / (2 * halfSizeM) * sizePx;
        for (const region of regions) {
            yield* budget.step('planner-mask-polygon');
            context.beginPath();
            context.moveTo(pixelX(region.ring[0].x), pixelZ(region.ring[0].z));
            for (let i = 1; i < region.ring.length; i++) context.lineTo(pixelX(region.ring[i].x), pixelZ(region.ring[i].z));
            context.closePath(); context.fill();
        }
        budget.check();
        texture = new THREE.CanvasTexture(canvas);
        texture.name = 'PlannerSurfaceCutoutMask';
        texture.flipY = false;
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.userData.cutoutCount = regions.length;
        texture.userData.cutoutKinds = kinds;
        handedOff = true;
        return { texture, centerX, centerZ, halfSizeM };
    } finally {
        if (!handedOff) { texture?.dispose(); canvas.width = canvas.height = 0; }
    }
}
