// Pure fixed-lattice planning for dynamically streamed terrain height grids.
// Stable bboxes make the existing /terrain/grid payload reusable and cacheable.

const METRES_PER_DEGREE_LAT = 111320;

export const TERRAIN_GRID_TILE_SPAN_DEG = 0.02;
export const TERRAIN_GRID_TILE_PADDING_CELLS = 2;
export const TERRAIN_GRID_FETCH_RING = 1;
export const TERRAIN_GRID_KEEP_RING = 2;

function finiteCoordinate(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`terrain grid tile requires ${label}`);
    return number;
}

export function terrainGridResolutionForSource(source) {
    return String(source || 'dgu-dtm-20m') === 'dgu-dtm-20m'
        ? 0.0002
        : 0.000008;
}

export function terrainGridTileIndex(lon, lat, spanDeg = TERRAIN_GRID_TILE_SPAN_DEG) {
    const longitude = finiteCoordinate(lon, 'longitude');
    const latitude = finiteCoordinate(lat, 'latitude');
    const span = finiteCoordinate(spanDeg, 'positive tile span');
    if (!(span > 0)) throw new Error('terrain grid tile requires positive tile span');
    return {
        tx: Math.floor(longitude / span),
        ty: Math.floor(latitude / span),
    };
}

export function terrainGridTileDescriptor(tx, ty, {
    source = 'dgu-dtm-20m',
    spanDeg = TERRAIN_GRID_TILE_SPAN_DEG,
    resolutionDeg = terrainGridResolutionForSource(source),
    paddingCells = TERRAIN_GRID_TILE_PADDING_CELLS,
} = {}) {
    const tileX = Math.trunc(finiteCoordinate(tx, 'tile x'));
    const tileY = Math.trunc(finiteCoordinate(ty, 'tile y'));
    const span = finiteCoordinate(spanDeg, 'positive tile span');
    const resolution = finiteCoordinate(resolutionDeg, 'positive resolution');
    if (!(span > 0) || !(resolution > 0)) {
        throw new Error('terrain grid tile span and resolution must be positive');
    }
    const padding = Math.max(0, Math.floor(Number(paddingCells) || 0)) * resolution;
    const coreBounds = {
        west: tileX * span,
        south: tileY * span,
        east: (tileX + 1) * span,
        north: (tileY + 1) * span,
    };
    const bbox = [
        coreBounds.west - padding,
        coreBounds.south - padding,
        coreBounds.east + padding,
        coreBounds.north + padding,
    ];
    return {
        key: `${tileX}_${tileY}`,
        tx: tileX,
        ty: tileY,
        coreBounds,
        bbox,
        resolutionDeg: resolution,
        estimatedCells: Math.ceil((bbox[2] - bbox[0]) / resolution)
            * Math.ceil((bbox[3] - bbox[1]) / resolution),
        source: String(source || 'dgu-dtm-20m'),
        scope: 'fixed-terrain-tile',
        cacheTile: true,
    };
}

export function terrainGridTilesAround(lon, lat, {
    ring = TERRAIN_GRID_FETCH_RING,
    ...descriptorOptions
} = {}) {
    const center = terrainGridTileIndex(
        lon,
        lat,
        descriptorOptions.spanDeg,
    );
    const safeRing = Math.max(0, Math.floor(Number(ring) || 0));
    const tiles = [];
    for (let dy = -safeRing; dy <= safeRing; dy++) {
        for (let dx = -safeRing; dx <= safeRing; dx++) {
            tiles.push(terrainGridTileDescriptor(
                center.tx + dx,
                center.ty + dy,
                descriptorOptions,
            ));
        }
    }
    tiles.sort((a, b) => {
        const aRing = Math.max(Math.abs(a.tx - center.tx), Math.abs(a.ty - center.ty));
        const bRing = Math.max(Math.abs(b.tx - center.tx), Math.abs(b.ty - center.ty));
        if (aRing !== bRing) return aRing - bRing;
        const aDistance = (a.tx - center.tx) ** 2 + (a.ty - center.ty) ** 2;
        const bDistance = (b.tx - center.tx) ** 2 + (b.ty - center.ty) ** 2;
        return aDistance - bDistance || a.key.localeCompare(b.key);
    });
    return tiles;
}

export function terrainGridTileLocalBounds(tile, anchorLon, anchorLat) {
    const bounds = tile?.coreBounds;
    if (!bounds) return null;
    const latitude = finiteCoordinate(anchorLat, 'anchor latitude');
    const longitude = finiteCoordinate(anchorLon, 'anchor longitude');
    const metresPerDegreeLon = METRES_PER_DEGREE_LAT
        * Math.max(0.2, Math.cos(latitude * Math.PI / 180));
    return {
        minX: (bounds.west - longitude) * metresPerDegreeLon,
        maxX: (bounds.east - longitude) * metresPerDegreeLon,
        minZ: -(bounds.north - latitude) * METRES_PER_DEGREE_LAT,
        maxZ: -(bounds.south - latitude) * METRES_PER_DEGREE_LAT,
    };
}

export function terrainGridTileRingDistance(tile, center) {
    return Math.max(
        Math.abs(Number(tile?.tx) - Number(center?.tx)),
        Math.abs(Number(tile?.ty) - Number(center?.ty)),
    );
}
