// Aerial view for authored scenes flown over open country (the Vis arrival):
// how far the air lets the eye see from a given height, the coarse terrain
// window that carries land and sea out to the horizon beyond the streamed
// tiles, and the land-cover tint that lets forests and meadows read from the
// air. Pure: no DOM and no three.js, so every number here runs under node.

import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull, geoToLocal, localToGeo } from './math.js';

export const AERIAL_VIEW_DEFAULTS = Object.freeze({
    // ±9 km at an 80 m lattice: ~69k API cells and a 226 × 226 vertex mesh.
    farTerrainHalfSizeM: 9000,
    farTerrainCellM: 80,
    // Rebuilt once the focus has moved this far from the window centre, long
    // before the camera can see the window's edge.
    recenterDistanceM: 2500,
    // Sinks the coarse surface under the streamed tiles it borders.
    farTerrainDropM: 1.5,
    // DEM samples at or below this height are the sea.
    seaLevelCutM: 0.4,
    // Summer haze over the Adriatic: islands 9 km out are gone, Vis from the
    // channel is not.
    fog: Object.freeze({ nearM: 1400, farM: 9000, cameraFarM: 12000 }),
    // On the ground the session keeps its own fog; between these camera
    // heights above the sea the visible distance opens to the aerial one.
    fogStartHeightM: 20,
    fogFullHeightM: 140,
});

// scene/setup.js: the fog every model-world session starts with.
export const SESSION_FOG_DEFAULTS = Object.freeze({ nearM: 250, farM: 1200, cameraFarM: 2000 });

// The terrain grid API refuses more than 2.5 M cells and the decor API a bbox
// wider than 0.25°; a far window past either would come back empty.
export const FAR_TERRAIN_MAX_CELLS = 2_500_000;
export const LAND_COVER_MAX_SPAN_DEG = 0.25;

export function resolveAerialViewConfig(authored) {
    if (!authored) return null;
    const source = authored === true ? {} : authored;
    if (typeof source !== 'object') return null;
    const config = {
        ...AERIAL_VIEW_DEFAULTS,
        ...source,
        fog: Object.freeze({ ...AERIAL_VIEW_DEFAULTS.fog, ...(source.fog || {}) }),
    };
    for (const key of ['farTerrainHalfSizeM', 'farTerrainCellM', 'recenterDistanceM', 'fogFullHeightM']) {
        if (!(finiteOrNull(config[key]) > 0)) throw new Error(`aerial view: ${key} must be a positive number`);
    }
    if (!(finiteOrNull(config.fog.farM) > finiteOrNull(config.fog.nearM))) {
        throw new Error('aerial view: fog.farM must exceed fog.nearM');
    }
    if (!(finiteOrNull(config.fog.cameraFarM) > config.fog.farM)) {
        throw new Error('aerial view: fog.cameraFarM must exceed fog.farM');
    }
    if (!(config.fogFullHeightM > (finiteOrNull(config.fogStartHeightM) ?? Number.NaN))) {
        throw new Error('aerial view: fogFullHeightM must exceed fogStartHeightM');
    }
    return Object.freeze(config);
}

function smoothstep01(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
}

// Fog for a camera at this height above the sea, or null to keep the
// session's own. The camera's far plane always stays behind the fog's far
// edge, so nothing is clipped before it has faded into the sky.
export function aerialFogAtHeight(heightAboveSeaM, config, sessionFog = SESSION_FOG_DEFAULTS) {
    const height = finiteOrNull(heightAboveSeaM);
    if (!config || height === null) return null;
    const ratio = smoothstep01(
        (height - config.fogStartHeightM) / (config.fogFullHeightM - config.fogStartHeightM),
    );
    if (ratio <= 0) return null;
    const base = {
        nearM: finiteOrNull(sessionFog?.nearM) ?? SESSION_FOG_DEFAULTS.nearM,
        farM: finiteOrNull(sessionFog?.farM) ?? SESSION_FOG_DEFAULTS.farM,
        cameraFarM: finiteOrNull(sessionFog?.cameraFarM) ?? SESSION_FOG_DEFAULTS.cameraFarM,
    };
    const lerp = (from, to) => from + (to - from) * ratio;
    const nearM = lerp(base.nearM, config.fog.nearM);
    const farM = lerp(base.farM, config.fog.farM);
    return {
        nearM,
        farM,
        cameraFarM: Math.max(lerp(base.cameraFarM, config.fog.cameraFarM), farM + 200),
    };
}

// The far window as a terrain-grid request. The API lattice is square in
// degrees, so a longitude cell is narrower in metres by cos(latitude).
export function farTerrainWindow({ centerLat, centerLon, halfSizeM, cellM }) {
    const lat = finiteOrNull(centerLat);
    const lon = finiteOrNull(centerLon);
    if (lat === null || lon === null) throw new Error('far terrain window: centre required');
    const metresPerDegLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const dLat = halfSizeM / metresPerDegLat;
    const dLon = dLat / Math.max(0.01, Math.cos(lat * DEG_TO_RAD));
    const resolutionDeg = cellM / metresPerDegLat;
    return {
        bbox: [lon - dLon, lat - dLat, lon + dLon, lat + dLat],
        resolutionDeg,
        spanLonDeg: 2 * dLon,
        spanLatDeg: 2 * dLat,
        approxCells: Math.ceil((2 * dLon) / resolutionDeg) * Math.ceil((2 * dLat) / resolutionDeg),
    };
}

// The mesh lattice in scene metres, centred on the window.
export function farTerrainLattice({ centerX, centerZ, halfSizeM, cellM }) {
    const cells = Math.max(2, Math.ceil((2 * halfSizeM) / cellM));
    return Object.freeze({
        centerX,
        centerZ,
        cellM,
        columns: cells + 1,
        rows: cells + 1,
        originX: centerX - (cells * cellM) / 2,
        originZ: centerZ - (cells * cellM) / 2,
    });
}

export function farTerrainNeedsRecenter(lattice, focus, recenterDistanceM) {
    if (!lattice) return true;
    const x = finiteOrNull(focus?.x);
    const z = finiteOrNull(focus?.z);
    if (x === null || z === null) return false;
    return Math.hypot(x - lattice.centerX, z - lattice.centerZ) > recenterDistanceM;
}

// Higher ids win where polygons overlap: a wood mapped inside a meadow stays
// a wood.
export const LAND_COVER = Object.freeze({ BARE: 0, SAND: 1, GRASS: 2, MEADOW: 3, FOREST: 4 });

const LAND_COVER_BY_TYPE = new Map([
    ['forest', LAND_COVER.FOREST],
    ['wood', LAND_COVER.FOREST],
    ['meadow', LAND_COVER.MEADOW],
    ['scrub', LAND_COVER.MEADOW],
    ['heath', LAND_COVER.MEADOW],
    ['grassland', LAND_COVER.MEADOW],
    ['grass', LAND_COVER.GRASS],
    ['park', LAND_COVER.GRASS],
    ['garden', LAND_COVER.GRASS],
    ['pitch', LAND_COVER.GRASS],
    ['cemetery', LAND_COVER.GRASS],
    ['village_green', LAND_COVER.GRASS],
    ['recreation_ground', LAND_COVER.GRASS],
    ['sand', LAND_COVER.SAND],
    ['beach', LAND_COVER.SAND],
]);

export function landCoverClassForType(type) {
    return LAND_COVER_BY_TYPE.get(String(type || '').toLowerCase()) ?? null;
}

// As the island reads from a few kilometres out through the haze (sRGB).
// Unmapped Dalmatian land is mostly maquis over stone, not bare rock.
export const LAND_COVER_COLORS_SRGB = Object.freeze({
    [LAND_COVER.BARE]: 0x7d7859,
    [LAND_COVER.SAND]: 0xc6b78f,
    [LAND_COVER.GRASS]: 0x67823f,
    [LAND_COVER.MEADOW]: 0x6c7446,
    [LAND_COVER.FOREST]: 0x3a5230,
});

function pointInRings(x, z, rings) {
    let inside = false;
    for (const ring of rings) {
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
            const pa = ring[a];
            const pb = ring[b];
            if ((pa.z > z) !== (pb.z > z)
                && x < ((pb.x - pa.x) * (z - pa.z)) / (pb.z - pa.z) + pa.x) {
                inside = !inside;
            }
        }
    }
    return inside;
}

// One land-cover class per lattice vertex from the decor API's greenery
// features (GeoJSON, lon/lat rings), one feature at a time so a frame queue
// can spread the work. Each polygon only visits the lattice points inside its
// own bounding box; holes are even-odd.
export function createLandCoverRaster(lattice, { anchorLon, anchorLat }) {
    const { columns, rows, originX, originZ, cellM } = lattice;
    const classes = new Uint8Array(columns * rows);
    function addFeature(feature) {
        const landCover = landCoverClassForType(feature?.properties?.t);
        if (landCover === null) return;
        const geometry = feature?.geometry;
        const polygons = geometry?.type === 'Polygon'
            ? [geometry.coordinates]
            : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
        for (const polygon of polygons) {
            const rings = (polygon || [])
                .filter(ring => Array.isArray(ring) && ring.length >= 3)
                .map(ring => ring.map(([lon, lat]) => geoToLocal(lon, lat, anchorLon, anchorLat)));
            if (!rings.length) continue;
            let minX = Infinity;
            let maxX = -Infinity;
            let minZ = Infinity;
            let maxZ = -Infinity;
            for (const point of rings[0]) {
                minX = Math.min(minX, point.x);
                maxX = Math.max(maxX, point.x);
                minZ = Math.min(minZ, point.z);
                maxZ = Math.max(maxZ, point.z);
            }
            const i0 = Math.max(0, Math.ceil((minX - originX) / cellM));
            const i1 = Math.min(columns - 1, Math.floor((maxX - originX) / cellM));
            const j0 = Math.max(0, Math.ceil((minZ - originZ) / cellM));
            const j1 = Math.min(rows - 1, Math.floor((maxZ - originZ) / cellM));
            for (let j = j0; j <= j1; j++) {
                const z = originZ + j * cellM;
                for (let i = i0; i <= i1; i++) {
                    const index = j * columns + i;
                    if (classes[index] >= landCover) continue;
                    if (pointInRings(originX + i * cellM, z, rings)) classes[index] = landCover;
                }
            }
        }
    }
    return { classes, addFeature };
}

export function rasterizeLandCover(features, lattice, anchor) {
    const raster = createLandCoverRaster(lattice, anchor);
    for (const feature of features || []) raster.addFeature(feature);
    return raster.classes;
}

function srgbChannelToLinear(value) {
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearColor(hex) {
    return [
        srgbChannelToLinear(((hex >> 16) & 255) / 255),
        srgbChannelToLinear(((hex >> 8) & 255) / 255),
        srgbChannelToLinear((hex & 255) / 255),
    ];
}

// Builds the far terrain a few lattice rows at a time: positions in scene
// metres, linear vertex colours, heightfield normals and the triangles of every
// finished row strip, so publishing only wraps the buffers — no pass over the
// whole mesh in one frame. `heightAt(lon, lat)` is metres above the sea, or null
// where the DEM has no data, which over the Adriatic is the sea itself. A
// triangle whose corners are all sea is left out so the sea shows through;
// coastal triangles slope down under the water.
export function createFarTerrainGeometryBuilder({
    lattice,
    anchorLon,
    anchorLat,
    heightAt,
    toSceneY,
    classes = null,
    seaLevelCutM = AERIAL_VIEW_DEFAULTS.seaLevelCutM,
    dropM = AERIAL_VIEW_DEFAULTS.farTerrainDropM,
}) {
    const { columns, rows, originX, originZ, cellM } = lattice;
    const vertexCount = columns * rows;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array((rows - 1) * (columns - 1) * 6);
    const land = new Uint8Array(vertexCount);
    const palette = new Map(Object.entries(LAND_COVER_COLORS_SRGB)
        .map(([id, hex]) => [Number(id), linearColor(hex)]));
    const bare = palette.get(LAND_COVER.BARE);
    const seaY = finiteOrNull(toSceneY(0)) ?? 0;
    let landVertexCount = 0;
    let indexCount = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    let row = 0;

    // The strip between row j and the row below it, once both are sampled.
    function emitStrip(j) {
        for (let i = 0; i < columns - 1; i++) {
            const a = j * columns + i;
            const b = a + 1;
            const c = a + columns;
            const d = c + 1;
            // Wound counter-clockwise seen from above, so the faces look up.
            if (land[a] || land[c] || land[b]) {
                indices[indexCount++] = a;
                indices[indexCount++] = c;
                indices[indexCount++] = b;
            }
            if (land[b] || land[c] || land[d]) {
                indices[indexCount++] = b;
                indices[indexCount++] = c;
                indices[indexCount++] = d;
            }
        }
    }

    // Central differences over the neighbouring lattice heights, one-sided at
    // the window edge; needs the rows above and below j to be sampled.
    function writeNormals(j) {
        const up = Math.max(0, j - 1);
        const down = Math.min(rows - 1, j + 1);
        for (let i = 0; i < columns; i++) {
            const left = Math.max(0, i - 1);
            const right = Math.min(columns - 1, i + 1);
            const slopeX = (positions[(j * columns + right) * 3 + 1] - positions[(j * columns + left) * 3 + 1])
                / ((right - left) * cellM);
            const slopeZ = (positions[(down * columns + i) * 3 + 1] - positions[(up * columns + i) * 3 + 1])
                / ((down - up) * cellM);
            const inverseLength = 1 / Math.sqrt(slopeX * slopeX + 1 + slopeZ * slopeZ);
            const offset = (j * columns + i) * 3;
            normals[offset] = -slopeX * inverseLength;
            normals[offset + 1] = inverseLength;
            normals[offset + 2] = -slopeZ * inverseLength;
        }
    }

    return {
        // Returns true once every row is done.
        stepRows(count) {
            const end = Math.min(rows, row + Math.max(1, count));
            for (; row < end; row++) {
                const z = originZ + row * cellM;
                for (let i = 0; i < columns; i++) {
                    const x = originX + i * cellM;
                    const index = row * columns + i;
                    const { lon, lat } = localToGeo(x, z, anchorLon, anchorLat);
                    const height = finiteOrNull(heightAt(lon, lat));
                    const isLand = height !== null && height > seaLevelCutM;
                    land[index] = isLand ? 1 : 0;
                    if (isLand) landVertexCount += 1;
                    const sceneY = (isLand ? (finiteOrNull(toSceneY(height)) ?? seaY) : seaY) - dropM;
                    positions[index * 3] = x;
                    positions[index * 3 + 1] = sceneY;
                    positions[index * 3 + 2] = z;
                    // The stored float32 height, so the bounds are the rendered extent.
                    const storedY = positions[index * 3 + 1];
                    if (storedY < minY) minY = storedY;
                    if (storedY > maxY) maxY = storedY;
                    colors.set(palette.get(classes ? classes[index] : LAND_COVER.BARE) || bare, index * 3);
                }
                if (row > 0) {
                    emitStrip(row - 1);
                    writeNormals(row - 1);
                }
                if (row === rows - 1) writeNormals(row);
            }
            return row >= rows;
        },
        finish() {
            if (row < rows) throw new Error('far terrain: finish() before every row was built');
            return {
                positions,
                colors,
                normals,
                indices: indices.subarray(0, indexCount),
                vertexCount,
                triangleCount: indexCount / 3,
                landVertexCount,
                bounds: {
                    minX: originX,
                    maxX: originX + (columns - 1) * cellM,
                    minY,
                    maxY,
                    minZ: originZ,
                    maxZ: originZ + (rows - 1) * cellM,
                },
            };
        },
    };
}

export function buildFarTerrainGeometryData(options) {
    const builder = createFarTerrainGeometryBuilder(options);
    builder.stepRows(Infinity);
    return builder.finish();
}

// Which streamed terrain tiles already stand inside the far window, one byte
// per tile, so the coarse surface steps aside wherever a detailed one exists.
export function farTerrainCoverageMask({ centerX, centerZ, halfSizeM, tileM, isPublishedAt }) {
    const size = Math.ceil((2 * halfSizeM) / tileM) + 2;
    const originTileX = Math.floor((centerX - halfSizeM) / tileM) - 1;
    const originTileZ = Math.floor((centerZ - halfSizeM) / tileM) - 1;
    const data = new Uint8Array(size * size);
    let published = 0;
    for (let tz = 0; tz < size; tz++) {
        for (let tx = 0; tx < size; tx++) {
            const x = (originTileX + tx + 0.5) * tileM;
            const z = (originTileZ + tz + 0.5) * tileM;
            if (!isPublishedAt(x, z)) continue;
            data[tz * size + tx] = 255;
            published += 1;
        }
    }
    return { data, size, originX: originTileX * tileM, originZ: originTileZ * tileM, tileM, published };
}
