// Which local-metre bounds lie inside the base terrain evidence the terrain layer
// has loaded or requested. A ground generation may only require evidence inside
// this scope: a road that reaches beyond it would wait on a tile nobody fetches,
// and while the loading hold freezes the observer that wait never ends.

import { TERRAIN_GRID_TILE_SPAN_DEG, terrainGridTileIndex } from './terrain-grid-tiles.js';

const METRES_PER_DEGREE_LAT = 111320;
// Road bounds use a spherical metre projection; terrain tiles use this one.
// They differ by ~0.1 %, a few metres at the edge of the base ring, so bounds
// are grown by this margin and a sliver near the edge counts as outside.
const PROJECTION_MARGIN_M = 5;

export function createTerrainEvidenceScope({ anchorLon, anchorLat, tileKeys,
    spanDeg = TERRAIN_GRID_TILE_SPAN_DEG } = {}) {
    const lon0 = Number(anchorLon), lat0 = Number(anchorLat), span = Number(spanDeg);
    if (!Number.isFinite(lon0) || !Number.isFinite(lat0) || !(span > 0)) {
        throw new TypeError('Terrain evidence scope requires an anchor and tile span');
    }
    const keys = new Set([...(tileKeys || [])].map(String));
    const metresPerDegreeLon = METRES_PER_DEGREE_LAT * Math.max(0.2, Math.cos(lat0 * Math.PI / 180));
    const toGeo = (x, z) => ({ lon: lon0 + x / metresPerDegreeLon, lat: lat0 - z / METRES_PER_DEGREE_LAT });
    return Object.freeze({
        tileCount: keys.size,
        // True only when every base tile the bounds touch is loaded or requested.
        contains(bounds) {
            const values = [bounds?.minX, bounds?.minZ, bounds?.maxX, bounds?.maxZ].map(Number);
            if (!values.every(Number.isFinite)) return false;
            const [minX, minZ, maxX, maxZ] = values;
            const a = toGeo(minX - PROJECTION_MARGIN_M, maxZ + PROJECTION_MARGIN_M);
            const b = toGeo(maxX + PROJECTION_MARGIN_M, minZ - PROJECTION_MARGIN_M);
            const low = terrainGridTileIndex(a.lon, a.lat, span), high = terrainGridTileIndex(b.lon, b.lat, span);
            for (let ty = low.ty; ty <= high.ty; ty++) {
                for (let tx = low.tx; tx <= high.tx; tx++) if (!keys.has(`${tx}_${ty}`)) return false;
            }
            return true;
        },
    });
}
