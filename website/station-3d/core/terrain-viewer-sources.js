// City/source presets and dynamic-grid request geometry for the standalone
// DGU terrain inspector. Kept DOM-free so URL and bbox behaviour is testable.

const METRES_PER_DEGREE_LAT = 111320;
const DEFAULT_MAXIMUM_CELLS = 2_200_000;

export const TERRAIN_VIEWER_ELEVATION_MODES = Object.freeze({
    'best-available': Object.freeze({
        titleKey: 'bestAvailable',
        sourceResolutionM: 1,
    }),
    'dgu-lidar-dmr-1m': Object.freeze({
        titleKey: 'lidarDmr',
        sourceResolutionM: 1,
    }),
    'dgu-lidar-dmp-1m': Object.freeze({
        titleKey: 'lidarDmp',
        sourceResolutionM: 1,
    }),
    'dgu-dtm-20m': Object.freeze({
        titleKey: 'baselineDtm',
        sourceResolutionM: 20,
        preferredResolutionDeg: 0.00025,
    }),
});

export const TERRAIN_VIEWER_SOURCES = Object.freeze({
    zagreb: Object.freeze({
        titleKey: 'zagrebTitle',
        defaultArea: 'railCorridor',
        defaultVerticalScale: 3,
        defaultElevationMode: 'best-available',
        elevationModes: Object.freeze([
            'best-available',
            'dgu-lidar-dmr-1m',
            'dgu-lidar-dmp-1m',
            'dgu-dtm-20m',
        ]),
        seaVisible: false,
        presets: Object.freeze({
            railCorridor: Object.freeze({ lon: 16.021, lat: 45.823, spanKm: 35 }),
            railWest: Object.freeze({ lon: 15.812509, lat: 45.843383, spanKm: 1 }),
            railCentral: Object.freeze({ lon: 15.975, lat: 45.807, spanKm: 1 }),
            railEast: Object.freeze({ lon: 16.229839, lat: 45.801942, spanKm: 1 }),
            savaWest: Object.freeze({ lon: 15.835, lat: 45.815, spanKm: 10 }),
            savaCity: Object.freeze({ lon: 15.985, lat: 45.785, spanKm: 18 }),
            zagrebCoverage: Object.freeze({ lon: 15.980, lat: 45.805, spanKm: 35 }),
            // The 2026-08 flood delivery (DGU project 1009) is ~55 km east-west
            // and ~49 km north-south, so none of the corridor presets above frame
            // it. This one does, for checking coverage against the request.
            savaOdraSava: Object.freeze({ lon: 16.015, lat: 45.802, spanKm: 58 }),
        }),
    }),
    split: Object.freeze({
        titleKey: 'splitTitle',
        defaultArea: 'corridor',
        defaultVerticalScale: 1.5,
        // The Trogir–Split basin delivery (2026-08) covers only part of this
        // corridor, so "best available" — 1 m DMR inside the delivery, 20 m DTM
        // outside it — is the honest default. Tick "Colour sources" to see the
        // boundary: blue is the 1 m LiDAR, orange the 20 m national fallback.
        defaultElevationMode: 'best-available',
        elevationModes: Object.freeze([
            'best-available',
            'dgu-lidar-dmr-1m',
            'dgu-lidar-dmp-1m',
            'dgu-dtm-20m',
        ]),
        seaVisible: true,
        presets: Object.freeze({
            corridor: Object.freeze({ lon: 16.355, lat: 43.535, spanKm: 30 }),
            split: Object.freeze({ lon: 16.420, lat: 43.535, spanKm: 10 }),
            trogir: Object.freeze({ lon: 16.260, lat: 43.515, spanKm: 8 }),
            splitCoverage: Object.freeze({ lon: 16.380, lat: 43.535, spanKm: 35 }),
        }),
    }),
    sibenik: Object.freeze({
        titleKey: 'sibenikTitle',
        defaultArea: 'sibenikVodice',
        defaultVerticalScale: 1.5,
        defaultElevationMode: 'dgu-dtm-20m',
        elevationModes: Object.freeze(['dgu-dtm-20m']),
        seaVisible: true,
        presets: Object.freeze({
            // Both towns plus the Krka mouth / St Anthony channel between them.
            sibenikVodice: Object.freeze({ lon: 15.840, lat: 43.750, spanKm: 18 }),
            sibenikTown: Object.freeze({ lon: 15.895, lat: 43.735, spanKm: 8 }),
            vodice: Object.freeze({ lon: 15.783, lat: 43.761, spanKm: 6 }),
        }),
    }),
});

export function parseTerrainViewerSource(search, fallback = 'split') {
    const requested = new URLSearchParams(search || '').get('city');
    if (Object.hasOwn(TERRAIN_VIEWER_SOURCES, requested)) return requested;
    return Object.hasOwn(TERRAIN_VIEWER_SOURCES, fallback) ? fallback : 'split';
}

export function parseTerrainViewerElevationMode(search, sourceKey = 'split') {
    const source = TERRAIN_VIEWER_SOURCES[sourceKey] || TERRAIN_VIEWER_SOURCES.split;
    const requested = new URLSearchParams(search || '').get('source');
    return source.elevationModes.includes(requested) ? requested : source.defaultElevationMode;
}

export function terrainViewerGridRequest(preset, spanKm, {
    paddingFraction = 0.08,
    source = 'dgu-dtm-20m',
    resolutionDeg,
    maximumCells = DEFAULT_MAXIMUM_CELLS,
} = {}) {
    const lon = Number(preset?.lon);
    const lat = Number(preset?.lat);
    const spanM = Number(spanKm) * 1000;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !(spanM > 0)) {
        throw new Error('dynamic terrain request requires a finite preset and span');
    }
    const paddedHalfSpanM = spanM * (0.5 + Math.max(0, Number(paddingFraction) || 0));
    const metresPerDegreeLon = METRES_PER_DEGREE_LAT
        * Math.max(0.2, Math.cos(lat * Math.PI / 180));
    const bbox = [
        lon - paddedHalfSpanM / metresPerDegreeLon,
        lat - paddedHalfSpanM / METRES_PER_DEGREE_LAT,
        lon + paddedHalfSpanM / metresPerDegreeLon,
        lat + paddedHalfSpanM / METRES_PER_DEGREE_LAT,
    ];
    const mode = TERRAIN_VIEWER_ELEVATION_MODES[source]
        || TERRAIN_VIEWER_ELEVATION_MODES['dgu-dtm-20m'];
    const numericResolutionDeg = resolutionDeg == null ? Number.NaN : Number(resolutionDeg);
    const preferredResolutionDeg = Number.isFinite(numericResolutionDeg)
        ? numericResolutionDeg
        : mode.preferredResolutionDeg || mode.sourceResolutionM / METRES_PER_DEGREE_LAT;
    const areaDeg2 = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
    const safeResolutionDeg = Math.sqrt(
        areaDeg2 / Math.max(1, Number(maximumCells) || DEFAULT_MAXIMUM_CELLS),
    );
    return {
        bbox,
        resolutionDeg: Math.max(preferredResolutionDeg, safeResolutionDeg),
        source,
    };
}
