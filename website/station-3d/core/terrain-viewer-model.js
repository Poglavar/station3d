// Pure crop, sampling, and mesh generation for the standalone DGU terrain
// inspector. It deliberately has no THREE, DOM, fetch, or module state.

import { DEG_TO_RAD, EARTH_RADIUS_M } from './math.js';

const HYPSOMETRIC_STOPS = [
    [-20, [0.31, 0.38, 0.34]],
    [0, [0.47, 0.54, 0.29]],
    [50, [0.36, 0.52, 0.19]],
    [150, [0.68, 0.59, 0.28]],
    [300, [0.60, 0.39, 0.19]],
    [550, [0.46, 0.29, 0.23]],
    [800, [0.66, 0.62, 0.58]],
    [1100, [0.94, 0.95, 0.95]],
];

const SOURCE_COLORS = [
    [0.12, 0.72, 0.95],
    [0.96, 0.58, 0.16],
    [0.40, 0.82, 0.35],
    [0.74, 0.45, 0.92],
];

function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function sampleAxis(minimum, maximum, stride) {
    const values = [];
    for (let value = minimum; value <= maximum; value += stride) values.push(value);
    if (values[values.length - 1] !== maximum) values.push(maximum);
    return values;
}

function srgbChannelToLinear(channel) {
    const value = clamp(channel, 0, 1);
    return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
}

export function parseTerrainViewerSettings(search, presetSpans, defaults = {}) {
    const spans = presetSpans || {};
    const defaultArea = Object.hasOwn(spans, defaults.area) ? defaults.area : Object.keys(spans)[0];
    const params = new URLSearchParams(search || '');
    const requestedArea = params.get('area');
    const area = Object.hasOwn(spans, requestedArea) ? requestedArea : defaultArea;
    const numberParam = (name, fallback) => {
        const rawValue = params.get(name);
        if (rawValue == null || rawValue.trim() === '') return fallback;
        const value = Number(rawValue);
        return Number.isFinite(value) ? value : fallback;
    };
    const defaultStride = [1, 2, 4, 8].includes(defaults.stride) ? defaults.stride : 1;
    const requestedStride = numberParam('stride', defaultStride);
    return {
        area,
        spanKm: clamp(numberParam('span', spans[area]), 1, 35),
        verticalScale: clamp(numberParam('vertical', defaults.verticalScale ?? 1.5), 1, 5),
        stride: [1, 2, 4, 8].includes(requestedStride) ? requestedStride : defaultStride,
        seaVisible: params.get('sea') !== '0',
        wireframe: params.get('wire') === '1',
        basemap: params.get('basemap') === 'osm' ? 'osm' : 'relief',
    };
}

// Bounds/value for the "show only above" elevation slider: whole-metre
// bounds spanning the rendered relief, a coarser step across big ranges, and
// the previous choice clamped so an area switch keeps the intent without
// escaping the new range. At the minimum the slider filters nothing.
export function terrainThresholdSliderModel(minimumHeightM, maximumHeightM, previousValueM = null) {
    const min = Math.floor(finiteNumber(minimumHeightM, 0));
    const max = Math.ceil(finiteNumber(maximumHeightM, 0));
    if (!(max > min)) return { min: 0, max: 1, step: 1, value: 0, enabled: false };
    const step = max - min > 500 ? 5 : 1;
    // typeof guard: Number(null) is 0, which would fake a previous choice.
    const value = typeof previousValueM === 'number' && Number.isFinite(previousValueM)
        ? clamp(previousValueM, min, max)
        : min;
    return { min, max, step, value, enabled: true };
}

export function terrainColorAtHeight(heightM) {
    const height = finiteNumber(heightM, 0);
    let upperIndex = 1;
    while (upperIndex < HYPSOMETRIC_STOPS.length && height > HYPSOMETRIC_STOPS[upperIndex][0]) {
        upperIndex += 1;
    }
    if (upperIndex >= HYPSOMETRIC_STOPS.length) {
        return HYPSOMETRIC_STOPS[HYPSOMETRIC_STOPS.length - 1][1]
            .map(srgbChannelToLinear);
    }
    const [lowerHeight, lowerColor] = HYPSOMETRIC_STOPS[upperIndex - 1];
    const [upperHeight, upperColor] = HYPSOMETRIC_STOPS[upperIndex];
    const t = clamp((height - lowerHeight) / Math.max(1e-9, upperHeight - lowerHeight), 0, 1);
    // Buffer vertex colours are linear in Three.js. These authored stops are
    // sRGB display colours, so convert after interpolation; treating them as
    // linear was the reason the default relief looked pale and overexposed.
    return lowerColor
        .map((channel, index) => channel + (upperColor[index] - channel) * t)
        .map(srgbChannelToLinear);
}

export function terrainColorAtSource(sourceIndex) {
    const index = Number.isInteger(sourceIndex) && sourceIndex >= 0
        ? sourceIndex % SOURCE_COLORS.length
        : 0;
    return SOURCE_COLORS[index].map(srgbChannelToLinear);
}

export function terrainViewerLocationAtLocal(grid, view, localX, localZ) {
    if (!grid || typeof grid.sampleHeight !== 'function' || !view) {
        throw new Error('terrain viewer location requires a grid and active view');
    }
    const x = finiteNumber(localX, 0);
    const z = finiteNumber(localZ, 0);
    const lon = view.centerLon + x / view.metresPerDegreeLon;
    const lat = view.centerLat - z / view.metresPerDegreeLat;
    return {
        lon,
        lat,
        elevationM: grid.sampleHeight(lon, lat),
        sourceIndex: typeof grid.sourceIndexAtLocation === 'function'
            ? grid.sourceIndexAtLocation(lon, lat)
            : null,
    };
}

export function buildTerrainViewerMeshData(grid, options = {}) {
    if (!grid || typeof grid.valueAt !== 'function') {
        throw new Error('terrain viewer requires a decoded TerrainGrid');
    }
    const centerLon = finiteNumber(options.centerLon, (grid.west + grid.east) * 0.5);
    const centerLat = finiteNumber(options.centerLat, (grid.south + grid.north) * 0.5);
    const spanM = clamp(finiteNumber(options.spanM, 30000), 500, 50000);
    const stride = clamp(Math.trunc(finiteNumber(options.stride, 2)), 1, 32);
    const metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(centerLat * DEG_TO_RAD);
    const halfSpan = spanM * 0.5;
    const viewWest = centerLon - halfSpan / metresPerDegreeLon;
    const viewEast = centerLon + halfSpan / metresPerDegreeLon;
    const viewSouth = centerLat - halfSpan / metresPerDegreeLat;
    const viewNorth = centerLat + halfSpan / metresPerDegreeLat;
    const columnAtLon = (lon) => ((lon - grid.west) / (grid.east - grid.west)) * grid.width - 0.5;
    const rowAtLat = (lat) => ((grid.north - lat) / (grid.north - grid.south)) * grid.height - 0.5;
    let minColumn = clamp(Math.ceil(columnAtLon(viewWest)), 0, grid.width - 1);
    let maxColumn = clamp(Math.floor(columnAtLon(viewEast)), 0, grid.width - 1);
    let minRow = clamp(Math.ceil(rowAtLat(viewNorth)), 0, grid.height - 1);
    let maxRow = clamp(Math.floor(rowAtLat(viewSouth)), 0, grid.height - 1);
    if (minColumn > maxColumn || minRow > maxRow) {
        throw new Error('selected terrain window is outside the DGU grid');
    }
    if (minColumn === maxColumn) {
        minColumn = Math.max(0, minColumn - 1);
        maxColumn = Math.min(grid.width - 1, maxColumn + 1);
    }
    if (minRow === maxRow) {
        minRow = Math.max(0, minRow - 1);
        maxRow = Math.min(grid.height - 1, maxRow + 1);
    }
    const columns = sampleAxis(minColumn, maxColumn, stride);
    const rows = sampleAxis(minRow, maxRow, stride);
    const vertexCount = columns.length * rows.length;
    const positions = new Float32Array(vertexCount * 3);
    const heights = new Float32Array(vertexCount);
    heights.fill(Number.NaN);
    const sourceIndices = new Uint8Array(vertexCount);
    sourceIndices.fill(255);
    let minimumHeightM = Infinity;
    let maximumHeightM = -Infinity;
    let validVertexCount = 0;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        const lat = grid.north - ((row + 0.5) / grid.height) * (grid.north - grid.south);
        const z = (centerLat - lat) * metresPerDegreeLat;
        for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
            const column = columns[columnIndex];
            const lon = grid.west + ((column + 0.5) / grid.width) * (grid.east - grid.west);
            const x = (lon - centerLon) * metresPerDegreeLon;
            const vertexIndex = rowIndex * columns.length + columnIndex;
            const height = grid.valueAt(column, row);
            const sourceIndex = typeof grid.sourceIndexAt === 'function'
                ? grid.sourceIndexAt(column, row)
                : null;
            positions[vertexIndex * 3] = x;
            positions[vertexIndex * 3 + 1] = Number.isFinite(height) ? height : 0;
            positions[vertexIndex * 3 + 2] = z;
            if (!Number.isFinite(height)) continue;
            heights[vertexIndex] = height;
            if (Number.isInteger(sourceIndex)) sourceIndices[vertexIndex] = sourceIndex;
            validVertexCount += 1;
            minimumHeightM = Math.min(minimumHeightM, height);
            maximumHeightM = Math.max(maximumHeightM, height);
        }
    }
    const indexValues = [];
    for (let row = 0; row < rows.length - 1; row++) {
        for (let column = 0; column < columns.length - 1; column++) {
            const a = row * columns.length + column;
            const b = a + 1;
            const c = a + columns.length;
            const d = c + 1;
            if (![a, b, c, d].every((index) => Number.isFinite(heights[index]))) continue;
            indexValues.push(a, c, b, b, c, d);
        }
    }
    const firstColumn = columns[0];
    const lastColumn = columns[columns.length - 1];
    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];
    const sampledWest = grid.west + ((firstColumn + 0.5) / grid.width) * (grid.east - grid.west);
    const sampledEast = grid.west + ((lastColumn + 0.5) / grid.width) * (grid.east - grid.west);
    const sampledNorth = grid.north - ((firstRow + 0.5) / grid.height) * (grid.north - grid.south);
    const sampledSouth = grid.north - ((lastRow + 0.5) / grid.height) * (grid.north - grid.south);
    return {
        positions,
        heights,
        sourceIndices,
        indices: new Uint32Array(indexValues),
        columns: columns.length,
        rows: rows.length,
        validVertexCount,
        triangleCount: indexValues.length / 3,
        minimumHeightM: Number.isFinite(minimumHeightM) ? minimumHeightM : null,
        maximumHeightM: Number.isFinite(maximumHeightM) ? maximumHeightM : null,
        centerLon,
        centerLat,
        spanM,
        stride,
        metresPerDegreeLon,
        metresPerDegreeLat,
        bounds: {
            west: sampledWest,
            east: sampledEast,
            south: sampledSouth,
            north: sampledNorth,
        },
    };
}
