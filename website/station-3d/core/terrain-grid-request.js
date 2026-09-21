// Computes a bounded DGU height-grid request for a 3D session, expanding to
// cover authored corridors while keeping the backend raster cell count safe.
// A corridor that never comes within the anchor's walk neighbourhood is
// dropped from the request, and the neighbourhood itself is always covered.

const METRES_PER_DEGREE_LAT = 111320;

function finiteCoordinate(coordinate) {
    const lon = Number(coordinate?.[0]);
    const lat = Number(coordinate?.[1]);
    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

function featureCoordinates(feature) {
    const geometry = feature?.geometry;
    if (geometry?.type === 'LineString') return geometry.coordinates || [];
    if (geometry?.type === 'MultiLineString') return (geometry.coordinates || []).flat();
    return [];
}

// Nearest distance from the anchor to a corridor polyline, in metres, measured
// against SEGMENTS rather than vertices: a sparse two-point line whose midpoint
// passes the anchor must read as near, not as half its length away.
function nearestCorridorDistanceM(anchorLon, anchorLat, coordinates) {
    const metresPerDegreeLon = METRES_PER_DEGREE_LAT
        * Math.max(0.2, Math.cos(anchorLat * Math.PI / 180));
    let bestSq = Infinity;
    let previousX = null;
    let previousY = null;
    for (const [lon, lat] of coordinates) {
        const x = (lon - anchorLon) * metresPerDegreeLon;
        const y = (lat - anchorLat) * METRES_PER_DEGREE_LAT;
        if (previousX !== null) {
            const dx = x - previousX;
            const dy = y - previousY;
            const lengthSq = dx * dx + dy * dy;
            const t = lengthSq > 0
                ? Math.max(0, Math.min(1, -(previousX * dx + previousY * dy) / lengthSq))
                : 0;
            const nearestX = previousX + dx * t;
            const nearestY = previousY + dy * t;
            bestSq = Math.min(bestSq, nearestX * nearestX + nearestY * nearestY);
        } else {
            bestSq = Math.min(bestSq, x * x + y * y);
        }
        previousX = x;
        previousY = y;
    }
    return Math.sqrt(bestSq);
}

export function resolveDynamicTerrainGridRequest(ctx, {
    fallbackRadiusM = 8000,
    corridorMarginM = 2000,
    preferredResolutionDeg = null,
    maximumCells = 2_400_000,
    elevationSource = 'dgu-dtm-20m',
} = {}) {
    const anchorLon = Number(ctx?.anchorLon);
    const anchorLat = Number(ctx?.anchorLat);
    if (!Number.isFinite(anchorLon) || !Number.isFinite(anchorLat)) {
        throw new Error('terrain grid request requires a finite session anchor');
    }

    // A corridor shapes the request only if it comes within the anchor's walk
    // neighbourhood (fallbackRadiusM). A session spawned 40 km from the open
    // project's line used to inherit its whole bbox: the cell cap then backed
    // the grid off below source resolution (phantom viaducts on aliased karst)
    // and parked the grid edge — a sea-level escarpment — 2 km from the spawn
    // (Šibenik walk with the Gračac–Knin reconstruction open). Attachment is
    // per feature and all-or-nothing: a kept corridor is kept WHOLE, so cab
    // rides (anchored on the line) always cover their full alignment.
    const corridorFeatureCoordinates = (ctx?.customTrackCorridors || [])
        .map(feature => featureCoordinates(feature).map(finiteCoordinate).filter(Boolean))
        .filter(coordinates => coordinates.length >= 2);
    const attachedCorridors = [];
    let droppedCorridorCount = 0;
    for (const coordinates of corridorFeatureCoordinates) {
        if (nearestCorridorDistanceM(anchorLon, anchorLat, coordinates) <= fallbackRadiusM) {
            attachedCorridors.push(coordinates);
        } else {
            droppedCorridorCount += 1;
        }
    }
    const corridorCoordinates = attachedCorridors.flat();
    const points = [[anchorLon, anchorLat], ...corridorCoordinates];
    let west = Math.min(...points.map(point => point[0]));
    let east = Math.max(...points.map(point => point[0]));
    let south = Math.min(...points.map(point => point[1]));
    let north = Math.max(...points.map(point => point[1]));

    const hasCorridor = corridorCoordinates.length >= 2;
    const marginM = hasCorridor ? corridorMarginM : fallbackRadiusM;
    const midLat = (south + north) / 2;
    const latitudeMargin = marginM / METRES_PER_DEGREE_LAT;
    const longitudeMargin = marginM
        / (METRES_PER_DEGREE_LAT * Math.max(0.2, Math.cos(midLat * Math.PI / 180)));
    west -= longitudeMargin;
    east += longitudeMargin;
    south -= latitudeMargin;
    north += latitudeMargin;

    // The walk neighbourhood is covered even when a corridor set the box: a
    // player standing at the corridor's end must not meet the grid edge (and
    // its flat-0 world beyond) after two kilometres on foot.
    const anchorLatitudeRadius = fallbackRadiusM / METRES_PER_DEGREE_LAT;
    const anchorLongitudeRadius = fallbackRadiusM
        / (METRES_PER_DEGREE_LAT * Math.max(0.2, Math.cos(anchorLat * Math.PI / 180)));
    west = Math.min(west, anchorLon - anchorLongitudeRadius);
    east = Math.max(east, anchorLon + anchorLongitudeRadius);
    south = Math.min(south, anchorLat - anchorLatitudeRadius);
    north = Math.max(north, anchorLat + anchorLatitudeRadius);

    const source = String(elevationSource || 'dgu-dtm-20m');
    // The source's OWN cell size in degrees: 20 m for the DGU DTM, ~1 m for the
    // LiDAR-composed sources. This is both the floor and — since 2026-07-31 —
    // the default. Asking the DGU grid for 0.0005 deg (≈ 40 x 55 m at 45 N) used
    // to be the default, which sampled the 20 m DTM at half its resolution: at
    // Rijeka Brajdica that read the ground 1.6 m low, enough to push the fill
    // past DEFAULT_VIADUCT_FILL_THRESHOLD_M and put a phantom 164 m viaduct on a
    // stretch the planner's own profile calls an embankment. The world and the
    // 2D profile have to read ONE surface, so never ask for less than the source
    // has; only the maximumCells cap below may back that off, and it does so the
    // same way it always did for corridors too long to hold at full resolution.
    const sourceResolutionFloor = source === 'dgu-dtm-20m' ? 0.0002 : 0.000008;
    const requestedResolution = Number(preferredResolutionDeg);
    const preferred = Math.max(
        sourceResolutionFloor,
        Number.isFinite(requestedResolution) && requestedResolution > 0
            ? requestedResolution
            : sourceResolutionFloor,
    );
    const areaDeg2 = Math.max(1e-12, (east - west) * (north - south));
    const minimumSafeResolution = Math.sqrt(areaDeg2 / Math.max(1, maximumCells));
    let resolutionDeg = Math.max(preferred, minimumSafeResolution);
    const cellsAtResolution = (resolution) => (
        Math.ceil((east - west) / resolution)
        * Math.ceil((north - south) / resolution)
    );
    // The area-based estimate ignores ceil() on each axis. Nudge the
    // resolution until the actual integer grid respects the advertised cap.
    // The over-correction factor must exceed ceil()'s per-axis granularity
    // (~1/1500 on a large grid): with a smaller epsilon the loop converges
    // from below and stops a few dozen cells OVER the cap.
    for (let attempt = 0; attempt < 6; attempt++) {
        const cells = cellsAtResolution(resolutionDeg);
        if (cells <= maximumCells) break;
        resolutionDeg *= Math.sqrt(cells / maximumCells) * 1.001;
    }
    if (resolutionDeg > 0.002) {
        throw new Error('authored corridor is too large for one DGU terrain grid');
    }

    return {
        bbox: [west, south, east, north],
        resolutionDeg,
        estimatedCells: cellsAtResolution(resolutionDeg),
        source,
        scope: hasCorridor ? 'authored-corridor' : 'session-anchor',
        droppedCorridorCount,
    };
}

// The camera-centred DETAIL window: a small box around the session anchor at
// the source's native resolution (the 1 m LiDAR path). The base grid above
// covers the corridor; this window is what makes the ground near the walker
// read like the orthophoto — cuttings, portals, embankments. If the requested
// half-size would exceed the cell budget, the WINDOW SHRINKS rather than the
// resolution coarsening: a smaller true-resolution window beats a bigger
// aliased one (see docs/terrain-detail-window.md).
export function resolveDetailTerrainWindowRequest(ctx, {
    halfSizeM = 600,
    elevationSource,
    resolutionDeg = 0.000008,
    maximumCells = 2_400_000,
} = {}) {
    const anchorLon = Number(ctx?.anchorLon);
    const anchorLat = Number(ctx?.anchorLat);
    if (!Number.isFinite(anchorLon) || !Number.isFinite(anchorLat)) {
        throw new Error('terrain detail window requires a finite session anchor');
    }
    const resolution = Number(resolutionDeg);
    if (!(resolution > 0)) {
        throw new Error('terrain detail window requires a positive resolution');
    }
    let halfM = Math.max(50, Number(halfSizeM) || 0);
    const metresPerDegreeLon = METRES_PER_DEGREE_LAT
        * Math.max(0.2, Math.cos(anchorLat * Math.PI / 180));
    const cellsForHalf = (half) => {
        const lonHalfDeg = half / metresPerDegreeLon;
        const latHalfDeg = half / METRES_PER_DEGREE_LAT;
        return Math.ceil((2 * lonHalfDeg) / resolution)
            * Math.ceil((2 * latHalfDeg) / resolution);
    };
    if (cellsForHalf(halfM) > maximumCells) {
        halfM *= Math.sqrt(maximumCells / cellsForHalf(halfM)) * 0.999;
    }
    const lonHalfDeg = halfM / metresPerDegreeLon;
    const latHalfDeg = halfM / METRES_PER_DEGREE_LAT;
    return {
        bbox: [
            anchorLon - lonHalfDeg,
            anchorLat - latHalfDeg,
            anchorLon + lonHalfDeg,
            anchorLat + latHalfDeg,
        ],
        resolutionDeg: resolution,
        estimatedCells: cellsForHalf(halfM),
        source: String(elevationSource || 'best-available'),
        scope: 'detail-window',
        halfSizeM: halfM,
    };
}

// The ROUTE BAND: a chain of native-resolution windows along the authored
// corridors, fetched at the terrain gate so the rail formation (built once,
// whole-route, at session start) and everything streamed later compiles on
// 1 m ground — the cab-ride counterpart of the anchor window above. Corridors
// beyond the anchor's walk neighbourhood are dropped exactly like the base
// grid drops them. When the whole band would exceed the total budget the BAND
// NARROWS (sqrt-style) rather than the resolution coarsening; if it still
// cannot fit, trailing chunks are dropped and reported, never silently.
export function resolveRouteBandTerrainRequests(ctx, {
    bandHalfM = 100,
    elevationSource,
    resolutionDeg = 0.000008,
    chunkPathM = 1500,
    chunkPaddingM = 50,
    fallbackRadiusM = 8000,
    maximumCellsPerChunk = 2_400_000,
    maximumTotalCells = 12_000_000,
    maximumChunks = 32,
} = {}) {
    const anchorLon = Number(ctx?.anchorLon);
    const anchorLat = Number(ctx?.anchorLat);
    if (!Number.isFinite(anchorLon) || !Number.isFinite(anchorLat)) {
        throw new Error('terrain route band requires a finite session anchor');
    }
    const resolution = Number(resolutionDeg);
    if (!(resolution > 0)) {
        throw new Error('terrain route band requires a positive resolution');
    }
    const source = String(elevationSource || 'best-available');
    const corridors = (ctx?.customTrackCorridors || [])
        .map(feature => featureCoordinates(feature).map(finiteCoordinate).filter(Boolean))
        .filter(coordinates => coordinates.length >= 2)
        .filter(coordinates => (
            nearestCorridorDistanceM(anchorLon, anchorLat, coordinates) <= fallbackRadiusM
        ));
    if (corridors.length === 0) {
        return { requests: [], bandHalfM, totalCells: 0, droppedChunks: 0 };
    }

    const metresPerDegreeLon = METRES_PER_DEGREE_LAT
        * Math.max(0.2, Math.cos(anchorLat * Math.PI / 180));
    const segmentLengthM = (a, b) => Math.hypot(
        (b[0] - a[0]) * metresPerDegreeLon,
        (b[1] - a[1]) * METRES_PER_DEGREE_LAT,
    );

    // Cut every corridor into runs of ~chunkPathM path length, interpolating
    // the cut points so vertex spacing cannot starve or bloat a chunk.
    const chunkRuns = [];
    for (const coordinates of corridors) {
        let run = [coordinates[0]];
        let runLengthM = 0;
        for (let index = 1; index < coordinates.length; index++) {
            let from = coordinates[index - 1];
            const to = coordinates[index];
            let remaining = segmentLengthM(from, to);
            while (runLengthM + remaining >= chunkPathM) {
                const t = (chunkPathM - runLengthM) / remaining;
                const cut = [
                    from[0] + (to[0] - from[0]) * t,
                    from[1] + (to[1] - from[1]) * t,
                ];
                run.push(cut);
                chunkRuns.push(run);
                run = [cut];
                runLengthM = 0;
                remaining = segmentLengthM(cut, to);
                from = cut;
            }
            run.push(to);
            runLengthM += remaining;
        }
        if (run.length >= 2 && runLengthM > 1) chunkRuns.push(run);
    }

    // A run whose axis-aligned bbox overflows the per-request cap (a long
    // diagonal leg) is halved recursively, never silently dropped.
    const runPathM = (run) => {
        let length = 0;
        for (let index = 1; index < run.length; index++) {
            length += segmentLengthM(run[index - 1], run[index]);
        }
        return length;
    };
    const halveRun = (run) => {
        const targetM = runPathM(run) / 2;
        const head = [run[0]];
        let headLengthM = 0;
        for (let index = 1; index < run.length; index++) {
            const from = run[index - 1];
            const to = run[index];
            const remaining = segmentLengthM(from, to);
            if (headLengthM + remaining >= targetM) {
                const t = (targetM - headLengthM) / remaining;
                const cut = [
                    from[0] + (to[0] - from[0]) * t,
                    from[1] + (to[1] - from[1]) * t,
                ];
                head.push(cut);
                return [head, [cut, ...run.slice(index)]];
            }
            head.push(to);
            headLengthM += remaining;
        }
        return [run];
    };
    const buildRequests = (halfM) => {
        const lonPadding = (halfM + chunkPaddingM) / metresPerDegreeLon;
        const latPadding = (halfM + chunkPaddingM) / METRES_PER_DEGREE_LAT;
        const requestFor = (run) => {
            const west = Math.min(...run.map(point => point[0])) - lonPadding;
            const east = Math.max(...run.map(point => point[0])) + lonPadding;
            const south = Math.min(...run.map(point => point[1])) - latPadding;
            const north = Math.max(...run.map(point => point[1])) + latPadding;
            const cells = Math.ceil((east - west) / resolution)
                * Math.ceil((north - south) / resolution);
            return {
                bbox: [west, south, east, north],
                resolutionDeg: resolution,
                estimatedCells: cells,
                source,
                scope: 'route-band',
            };
        };
        const requests = [];
        const queue = [...chunkRuns];
        while (queue.length > 0) {
            const run = queue.shift();
            const request = requestFor(run);
            if (request.estimatedCells <= maximumCellsPerChunk) {
                requests.push(request);
                continue;
            }
            if (runPathM(run) < 150) continue;
            queue.unshift(...halveRun(run));
        }
        return requests;
    };

    let halfM = Math.max(25, Number(bandHalfM) || 0);
    let requests = buildRequests(halfM);
    let totalCells = requests.reduce((sum, request) => sum + request.estimatedCells, 0);
    if (totalCells > maximumTotalCells) {
        halfM = Math.max(25, halfM * Math.sqrt(maximumTotalCells / totalCells) * 0.98);
        requests = buildRequests(halfM);
        totalCells = requests.reduce((sum, request) => sum + request.estimatedCells, 0);
    }
    let droppedChunks = 0;
    while (requests.length > maximumChunks
        || (totalCells > maximumTotalCells && requests.length > 0)) {
        const dropped = requests.pop();
        totalCells -= dropped.estimatedCells;
        droppedChunks += 1;
    }
    return { requests, bandHalfM: halfM, totalCells, droppedChunks };
}
