// Pure diagnostic twin of the terrain material's generic urban-ground blend
// policy. Explicit land-use paint is reported by the ground-paint inspector;
// this module describes only the base terrain material and generic urban mask.

function smoothstep(edge0, edge1, value) {
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

export function groundSurfaceMaterialClassifications({
    urbanPixel = null,
    urbanUv = null,
    baseStyle = null,
} = {}) {
    const classifications = [];
    if (urbanPixel && urbanUv) {
        const u = Number(urbanUv.u);
        const v = Number(urbanUv.v);
        const edgeDistance = Math.min(u, 1 - u, v, 1 - v);
        const masked = (Number(urbanPixel[0]) / 255) * smoothstep(0, 0.06, edgeDistance);
        const blend = smoothstep(0.06, 0.84, masked);
        if (blend > 0.001) classifications.push({
            id: 'generic-urban-ground',
            label: `Generic urban ground / sidewalk cover (${Math.round(blend * 100)}% blend)`,
            source: 'world/ground-cover.js + world/urban-ground-surface.js · building/road proximity mask',
            kind: 'material-mask',
            blend: Number(blend.toFixed(3)),
        });
    }
    const style = String(baseStyle || '').trim();
    if (style) classifications.push({
        id: 'terrain-base-material',
        label: `Terrain base material: ${style}`,
        source: 'world/terrain.js · location terrain surface style',
        kind: 'material',
    });
    return classifications;
}
