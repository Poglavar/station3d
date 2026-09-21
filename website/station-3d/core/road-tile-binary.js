// Decoder for binary road surface tiles (format RTL1). Pure — ArrayBuffer in,
// GeoJSON-shaped features out — so it is unit-testable headlessly.
//
// Why this exists: a cab road tile is ~4,100 buffered polygons and ~181,000
// coordinate pairs. As GeoJSON that is 4.45 MB of geometry, and the browser
// spends 30-66 ms in JSON.parse per tile ON THE ANIMATION THREAD — the
// `tile-delivery 64ms×1>50` fat item in the perf overlay. Coordinates are just
// numbers; quantised to 1e-7 degrees (~1.1 cm) each ordinate is an int32.
//
// Measured on a real Zagreb tile: 4.45 MB -> 1.45 MB on the wire, and 30 ms ->
// 2.2 ms to decode. Crucially the 2.2 ms is for rebuilding the SAME nested
// [lon, lat] arrays GeoJSON would have produced, so nothing downstream has to
// change — a zero-copy shape would be faster still (0.3 ms) but would mean
// rewriting every consumer, and that is where geometry bugs come from.
//
// Format is documented in the encoder: cadastre-data/api/src/domains/roads/
// road-tile-binary.js. Keep the two in step.

export const ROAD_TILE_MAGIC = 0x52544c31;   // 'RTL1'
export const ROAD_TILE_VERSION = 1;
const SCALE = 1e7;
const HEADER_BYTES = 28;
const TYPE_POLYGON = 1;
const TYPE_MULTIPOLYGON = 2;

export function isRoadTileBinary(buffer) {
    if (!buffer || buffer.byteLength < HEADER_BYTES) return false;
    return new DataView(buffer).getUint32(0, true) === ROAD_TILE_MAGIC;
}

export function decodeRoadTile(buffer) {
    if (!buffer || buffer.byteLength < HEADER_BYTES) {
        throw new Error('road tile buffer too small to hold a header');
    }
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== ROAD_TILE_MAGIC) {
        throw new Error(`not a road tile buffer (magic 0x${magic.toString(16)})`);
    }
    const version = view.getUint32(4, true);
    if (version !== ROAD_TILE_VERSION) {
        // Refuse rather than guess: a format change that decodes to plausible
        // garbage would draw a wrong city rather than fail.
        throw new Error(`road tile version ${version} is not supported (expected ${ROAD_TILE_VERSION})`);
    }
    const featureCount = view.getUint32(8, true);
    const polygonCount = view.getUint32(12, true);
    const ringCount = view.getUint32(16, true);
    const pointCount = view.getUint32(20, true);
    const propsBytes = view.getUint32(24, true);

    // Validate the declared size BEFORE building any view. Constructing a typed
    // array past the end throws "Invalid typed array length", which says nothing
    // about which tile was short or by how much.
    const expected = HEADER_BYTES
        + featureCount * 8          // type + polygons-per-feature
        + polygonCount * 4
        + ringCount * 4
        + pointCount * 8
        + propsBytes;
    if (expected !== buffer.byteLength) {
        throw new Error(`road tile is ${buffer.byteLength} bytes, header describes ${expected}`);
    }

    let offset = HEADER_BYTES;
    const types = new Uint32Array(buffer, offset, featureCount);
    offset += featureCount * 4;
    const polygonsPerFeature = new Uint32Array(buffer, offset, featureCount);
    offset += featureCount * 4;
    const ringsPerPolygon = new Uint32Array(buffer, offset, polygonCount);
    offset += polygonCount * 4;
    const pointsPerRing = new Uint32Array(buffer, offset, ringCount);
    offset += ringCount * 4;
    const coords = new Int32Array(buffer, offset, pointCount * 2);
    offset += pointCount * 8;

    const properties = propsBytes > 0
        ? JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset, propsBytes)))
        : [];

    const features = new Array(featureCount);
    let polygonIndex = 0;
    let ringIndex = 0;
    let coordIndex = 0;
    for (let f = 0; f < featureCount; f += 1) {
        const polygons = new Array(polygonsPerFeature[f]);
        for (let g = 0; g < polygons.length; g += 1) {
            const rings = new Array(ringsPerPolygon[polygonIndex++]);
            for (let r = 0; r < rings.length; r += 1) {
                const n = pointsPerRing[ringIndex++];
                const ring = new Array(n);
                for (let i = 0; i < n; i += 1) {
                    ring[i] = [coords[coordIndex] / SCALE, coords[coordIndex + 1] / SCALE];
                    coordIndex += 2;
                }
                rings[r] = ring;
            }
            polygons[g] = rings;
        }
        // The original type is carried, not inferred. A MultiPolygon rebuilt as
        // a Polygon loses every ring after the first, because the road builder
        // reads coordinates[0] — roads silently vanishing with no error.
        let geometry = null;
        if (types[f] === TYPE_POLYGON && polygons.length > 0) {
            geometry = { type: 'Polygon', coordinates: polygons[0] };
        } else if (types[f] === TYPE_MULTIPOLYGON && polygons.length > 0) {
            geometry = { type: 'MultiPolygon', coordinates: polygons };
        }
        features[f] = {
            type: 'Feature',
            geometry,
            properties: properties[f] ?? {},
        };
    }
    return { type: 'FeatureCollection', features };
}
