// Pure geometry for draping OSM raster tiles over the terrain-viewer mesh:
// slippy-map mercator math, zoom/tile-cover planning against texture and
// tile-count budgets, and per-vertex UVs into the stitched canvas. DOM-free
// so the plan and the projection are locked by node tests; the viewer only
// adds Image loading and canvas drawing on top.

const TILE_SIZE_PX = 256;

export function mercatorNormX(lonDeg) {
    return (lonDeg + 180) / 360;
}

export function mercatorNormY(latDeg) {
    const lat = Math.max(-85.05112878, Math.min(85.05112878, latDeg));
    const phi = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
}

// Bounds of the rendered crop in degrees, scanned from the mesh positions so
// grid-edge clamping is respected (the crop is not always centred on the preset).
export function drapeBoundsFromMesh(view) {
    const positions = view.positions;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < positions.length; index += 3) {
        const x = positions[index];
        const z = positions[index + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }
    return {
        west: view.centerLon + minX / view.metresPerDegreeLon,
        east: view.centerLon + maxX / view.metresPerDegreeLon,
        south: view.centerLat - maxZ / view.metresPerDegreeLat,
        north: view.centerLat - minZ / view.metresPerDegreeLat,
    };
}

// Chooses the deepest zoom whose stitched canvas stays inside the texture
// budget and the tile-count budget (politeness towards the OSM tile servers),
// then lists the covering tiles with their canvas draw offsets. The canvas
// region is tile-aligned, so `norm` is what UV projection must map into.
export function osmDrapePlan(bounds, {
    maxTextureSizePx = 4096,
    maxTiles = 150,
    minZoom = 3,
    maxZoom = 17,
} = {}) {
    const x0 = mercatorNormX(bounds.west);
    const x1 = mercatorNormX(bounds.east);
    const y0 = mercatorNormY(bounds.north); // north has the SMALLER mercator y
    const y1 = mercatorNormY(bounds.south);
    if (!(x1 > x0) || !(y1 > y0)) throw new Error('osm drape requires ordered bounds');
    for (let zoom = maxZoom; zoom >= minZoom; zoom--) {
        const tileCount = 2 ** zoom;
        const tileXMin = Math.floor(x0 * tileCount);
        const tileXMax = Math.min(tileCount - 1, Math.floor(x1 * tileCount));
        const tileYMin = Math.floor(y0 * tileCount);
        const tileYMax = Math.min(tileCount - 1, Math.floor(y1 * tileCount));
        const columns = tileXMax - tileXMin + 1;
        const rows = tileYMax - tileYMin + 1;
        if (zoom > minZoom && (columns * rows > maxTiles
            || columns * TILE_SIZE_PX > maxTextureSizePx
            || rows * TILE_SIZE_PX > maxTextureSizePx)) continue;
        const tiles = [];
        for (let tileY = tileYMin; tileY <= tileYMax; tileY++) {
            for (let tileX = tileXMin; tileX <= tileXMax; tileX++) {
                tiles.push({
                    x: tileX,
                    y: tileY,
                    dxPx: (tileX - tileXMin) * TILE_SIZE_PX,
                    dyPx: (tileY - tileYMin) * TILE_SIZE_PX,
                });
            }
        }
        return {
            zoom,
            tiles,
            canvasWidthPx: columns * TILE_SIZE_PX,
            canvasHeightPx: rows * TILE_SIZE_PX,
            norm: {
                x0: tileXMin / tileCount,
                x1: (tileXMax + 1) / tileCount,
                y0: tileYMin / tileCount,
                y1: (tileYMax + 1) / tileCount,
            },
            key: `${zoom}/${tileXMin}/${tileYMin}/${columns}x${rows}`,
        };
    }
    throw new Error('osm drape: no zoom fits the budgets');
}

export function osmTileUrl(zoom, x, y) {
    return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
}

// Per-vertex UVs into the stitched canvas. Each vertex is projected to
// mercator exactly, so the drape has no equirectangular-vs-mercator smear
// anywhere in the window. v is flipped because CanvasTexture keeps flipY
// (canvas row 0 = north = v 1).
export function buildDrapeUvs(view, norm) {
    const positions = view.positions;
    const uvs = new Float32Array((positions.length / 3) * 2);
    const spanX = norm.x1 - norm.x0;
    const spanY = norm.y1 - norm.y0;
    for (let index = 0, uvIndex = 0; index < positions.length; index += 3, uvIndex += 2) {
        const lon = view.centerLon + positions[index] / view.metresPerDegreeLon;
        const lat = view.centerLat - positions[index + 2] / view.metresPerDegreeLat;
        uvs[uvIndex] = (mercatorNormX(lon) - norm.x0) / spanX;
        uvs[uvIndex + 1] = 1 - (mercatorNormY(lat) - norm.y0) / spanY;
    }
    return uvs;
}
