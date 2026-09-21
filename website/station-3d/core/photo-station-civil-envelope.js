// Pure photo-mode station ownership: resolve each planner stop on the canonical
// rendered route, using one OBB for rigid stations or sampled route slices for
// compact covered fallbacks that cannot accept the rigid hall.

import {
    resolvePlannerStationTrackAnchor,
    samplePreparedStationTrackRoute,
    stationTrackRouteMatches,
} from './planner-station-track-anchor.js';
import {
    buildPhotoCoveredStationMaskData,
    buildPhotoCoveredStationSweep,
    PHOTO_COVERED_STATION_SECTION,
    photoCoveredStationOwnershipAt,
} from './photo-covered-station-shell.js';
import {
    ELEVATED_PLATFORM_LENGTH_M,
    getElevatedAccessLayout,
    getPlannerPlatformSideOffsetM,
    METRO_ENTRANCE_END_ALONG_M,
    METRO_ENTRANCE_START_ALONG_M,
    PLATFORM_WIDTH_M,
    SURFACE_PLATFORM_LENGTH_M,
    UNDERGROUND_ENTRANCE_CUT_WIDTH_M,
    UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M,
    UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M,
    UNDERGROUND_PLATFORM_LENGTH_M,
    UNDERGROUND_STATION_HALL_HALF_WIDTH_M,
    UNDERGROUND_STATION_HALL_HEIGHT_M,
    UNDERGROUND_STATION_LENGTH_M,
    UNDERGROUND_STATION_TOTAL_LENGTH_M,
} from '../world/planner-station-layout.js';
import {
    classifyStationVerticalForm,
    describeStation,
    STATION_VERTICAL_FORM,
    UNDERGROUND_STATION_TYPE_ID,
} from './station-contract.js';

const EPS = 1e-7;
const STATION_PAD_M = 0.75;
const DECK_EDGE_MARGIN_M = 0.35;
// Match the editor's rigid underground-station contract. A surface stop may
// become a tunnel stop only after Google terrain is known; that late change
// must not bypass the 170 m box's straight-and-level requirement.
const TUNNEL_STATION_STRAIGHT_TOLERANCE_M = 0.5;
const TUNNEL_STATION_LEVEL_TOLERANCE_M = 0.25;
const TUNNEL_STATION_TANGENT_TOLERANCE_DEG = 1;
const TUNNEL_STATION_COVERAGE_TOLERANCE_M = 0.5;
const ALIGNMENT_SAMPLE_STEP_M = 2;
const UNDERGROUND_STATION_CONTRACT = describeStation(
    UNDERGROUND_STATION_TYPE_ID,
    { runningTrackSpacingM: 4 },
);
const RIGID_STATION_EARTH_COVER_M = Math.max(
    0,
    Number(UNDERGROUND_STATION_CONTRACT?.requirements?.minDepthBelowGroundM || 0)
        - Number(UNDERGROUND_STATION_CONTRACT?.envelope?.heightAboveRailM || 0),
);
const RIGID_STATION_SOURCE_ROOF_OFFSET_M = UNDERGROUND_STATION_HALL_HEIGHT_M + 0.5;
// Compatibility exports for consumers that only need the compact core size.
export const PHOTO_COVERED_STATION_ROOF_OFFSET_M =
    PHOTO_COVERED_STATION_SECTION.roofTopOffsetM;
export const PHOTO_COVERED_STATION_HALF_WIDTH_M =
    PHOTO_COVERED_STATION_SECTION.wallCenterM;

function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function measurePhotoStationRouteAlignment(anchor, {
    halfLengthM = UNDERGROUND_STATION_TOTAL_LENGTH_M * 0.5,
    sampleStepM = ALIGNMENT_SAMPLE_STEP_M,
} = {}) {
    const route = anchor?.route;
    if (!route || !Number.isFinite(Number(anchor?.chainageM))) return null;
    const startM = Math.max(0, anchor.chainageM - Math.max(0, halfLengthM));
    const endM = Math.min(route.lengthM, anchor.chainageM + Math.max(0, halfLengthM));
    const chainages = new Set([startM, endM, anchor.chainageM]);
    for (const chainageM of route.chainagesM || []) {
        if (chainageM > startM + EPS && chainageM < endM - EPS) chainages.add(chainageM);
    }
    const stepM = Math.max(0.5, finite(sampleStepM, ALIGNMENT_SAMPLE_STEP_M));
    for (let chainageM = startM; chainageM < endM; chainageM += stepM) {
        chainages.add(Math.min(chainageM, endM));
    }
    const samples = [];
    let driftM = 0;
    let levelErrorM = 0;
    for (const chainageM of [...chainages].sort((left, right) => left - right)) {
        const point = samplePreparedStationTrackRoute(route, chainageM);
        if (!point) continue;
        samples.push({ ...point, chainageM });
        const dx = point.x - anchor.x;
        const dz = point.z - anchor.z;
        driftM = Math.max(driftM, Math.abs(dx * anchor.rightX + dz * anchor.rightZ));
        levelErrorM = Math.max(levelErrorM, Math.abs(point.y - anchor.y));
    }
    let tangentErrorDeg = 0;
    for (let index = 1; index < samples.length; index++) {
        const dx = samples[index].x - samples[index - 1].x;
        const dz = samples[index].z - samples[index - 1].z;
        const lengthM = Math.hypot(dx, dz);
        if (lengthM <= EPS) continue;
        const dot = Math.max(-1, Math.min(1,
            (dx * anchor.alongX + dz * anchor.alongZ) / lengthM,
        ));
        tangentErrorDeg = Math.max(tangentErrorDeg, Math.acos(dot) * 180 / Math.PI);
    }
    const sampledBeforeM = anchor.chainageM - startM;
    const sampledAfterM = endM - anchor.chainageM;
    const coverageOk = sampledBeforeM >= halfLengthM - TUNNEL_STATION_COVERAGE_TOLERANCE_M
        && sampledAfterM >= halfLengthM - TUNNEL_STATION_COVERAGE_TOLERANCE_M;
    return {
        driftM,
        levelErrorM,
        tangentErrorDeg,
        sampledBeforeM,
        sampledAfterM,
        coverageOk,
        samples,
        ok: coverageOk
            && driftM <= TUNNEL_STATION_STRAIGHT_TOLERANCE_M
            && tangentErrorDeg <= TUNNEL_STATION_TANGENT_TOLERANCE_DEG
            && levelErrorM <= TUNNEL_STATION_LEVEL_TOLERANCE_M,
    };
}

export function photoStationSupportsRigidStructure(envelope, structure) {
    return structure !== 'tunnel'
        || (
            envelope?.openCutFallback !== true
            && envelope?.tunnelAlignment?.ok === true
        );
}

export function photoStationHasRigidCover(envelope, groundY) {
    const trackY = finite(envelope?.trackY);
    const ground = finite(groundY);
    if (trackY == null || ground == null) return false;
    return ground - trackY >= (
        RIGID_STATION_SOURCE_ROOF_OFFSET_M + RIGID_STATION_EARTH_COVER_M - EPS
    );
}

// Classification still uses `formation` internally so the rigid hall is never
// selected for this fallback. Presentation consumers need the original buried
// regime, however: tunnel + non-rigid suppresses both the surface canopy and the
// rigid underground hall while the compact swept shell remains authoritative.
export function photoStationRuntimeStructure(envelope, storedStructure) {
    return envelope?.compactCovered ? 'tunnel' : storedStructure;
}

export function photoStationKey(stop) {
    const id = stop?.stopId ?? stop?.id;
    if (id != null) return `id:${String(id)}`;
    const lon = finite(stop?.lng ?? stop?.lon);
    const lat = finite(stop?.lat);
    return lon == null || lat == null
        ? null
        : `geo:${lat.toFixed(7)},${lon.toFixed(7)}:${String(stop?.trackId ?? '')}`;
}

function structureLayout(envelope, structure) {
    if (structure === 'tunnel') {
        const sourceHalfWidthM = Math.max(
            envelope.genericCorridorHalfWidthM,
            UNDERGROUND_STATION_HALL_HALF_WIDTH_M + 0.5,
        );
        return {
            alongHalfM: UNDERGROUND_STATION_TOTAL_LENGTH_M * 0.5 + 0.5,
            captureHalfWidthM: sourceHalfWidthM,
            maskRightMinM: -sourceHalfWidthM,
            maskRightMaxM: sourceHalfWidthM,
            sourceRoofOffsetM: UNDERGROUND_STATION_HALL_HEIGHT_M + 0.5,
        };
    }
    if (structure === 'viaduct') {
        const access = getElevatedAccessLayout();
        return {
            alongHalfM: ELEVATED_PLATFORM_LENGTH_M * 0.5 + STATION_PAD_M,
            captureHalfWidthM: Math.max(4, envelope.trackbedHalfWidthM + 1),
            maskRightMinM: envelope.platformSideM - PLATFORM_WIDTH_M * 0.5 - STATION_PAD_M,
            maskRightMaxM: envelope.platformSideM + access.accessOuter + STATION_PAD_M,
            deckRightMinM: -envelope.genericDeckHalfWidthM,
            deckRightMaxM: envelope.platformSideM + PLATFORM_WIDTH_M * 0.5
                + DECK_EDGE_MARGIN_M,
        };
    }
    if (envelope.openCutFallback) {
        const alongHalfM = UNDERGROUND_STATION_LENGTH_M * 0.5 + STATION_PAD_M;
        // A curved route can leave the centre-tangent box even inside the
        // shorter hall footprint. Expand by its measured lateral drift so the
        // station owns/opens both route arms plus the full generic corridor.
        // Drift cannot exceed the sampled half-length, which gives this a
        // natural, deterministic upper bound instead of an unbounded cutout.
        const routeHalfWidthM = envelope.genericCorridorHalfWidthM
            + Math.min(alongHalfM, Math.max(0, envelope.openCutAlignment?.driftM || 0));
        const platformOuter = envelope.platformSideM + PLATFORM_WIDTH_M * 0.5 + STATION_PAD_M;
        return {
            // Do not pretend the curved alignment can carry the 55 m rigid
            // throats. Open at least the 60 m hall footprint, then let the
            // generic tunnel own a portal at each end of that excavation.
            alongHalfM,
            captureHalfWidthM: routeHalfWidthM,
            maskRightMinM: -routeHalfWidthM,
            maskRightMaxM: Math.max(routeHalfWidthM, platformOuter),
        };
    }
    return {
        alongHalfM: SURFACE_PLATFORM_LENGTH_M * 0.5 + STATION_PAD_M,
        captureHalfWidthM: Math.max(4, envelope.trackbedHalfWidthM + 1),
        maskRightMinM: envelope.platformSideM - PLATFORM_WIDTH_M * 0.5 - STATION_PAD_M,
        maskRightMaxM: envelope.platformSideM + PLATFORM_WIDTH_M * 0.5 + STATION_PAD_M,
    };
}

export function buildPhotoStationCivilEnvelopes({
    stops = [],
    routes = [],
    locateStop,
    genericDeckHalfWidthM = 4,
    genericCorridorHalfWidthM = 12,
} = {}) {
    if (typeof locateStop !== 'function') return [];
    const envelopes = [];
    const seen = new Set();
    for (const stop of stops || []) {
        if (stop?.trackId == null) continue;
        const key = photoStationKey(stop);
        if (!key || seen.has(key)) continue;
        const usePhotoFrame = routes.some(route => (
            route.usesPhotoFrame && stationTrackRouteMatches(route, stop.trackId)
        ));
        const query = locateStop(stop, usePhotoFrame);
        if (!query || !Number.isFinite(Number(query.x)) || !Number.isFinite(Number(query.z))) continue;
        const anchor = resolvePlannerStationTrackAnchor({
            stopX: Number(query.x),
            stopZ: Number(query.z),
            stopTrackId: stop.trackId,
            usePhotoFrame,
            routes,
            tangentHalfSpanM: 12,
            maxSnapDistanceM: Infinity,
        });
        if (!anchor) continue;
        const properties = anchor.route?.properties || {};
        const platformSideM = getPlannerPlatformSideOffsetM(properties);
        const trackbedHalfWidthM = Math.max(0, platformSideM - 0.55 - PLATFORM_WIDTH_M * 0.5);
        const tunnelAlignment = measurePhotoStationRouteAlignment(anchor);
        const openCutAlignment = measurePhotoStationRouteAlignment(anchor, {
            halfLengthM: UNDERGROUND_STATION_LENGTH_M * 0.5 + STATION_PAD_M,
        });
        envelopes.push({
            key,
            stopId: stop.stopId ?? stop.id ?? null,
            stationName: String(stop.name || 'Station').trim().slice(0, 28) || 'Station',
            trackId: stop.trackId,
            routeRunId: anchor.route?.routeRunId,
            centerX: anchor.x,
            centerZ: anchor.z,
            trackY: anchor.y,
            relativeHeightM: anchor.relativeHeightM,
            lon: anchor.lon,
            lat: anchor.lat,
            alongX: anchor.alongX,
            alongZ: anchor.alongZ,
            rightX: anchor.rightX,
            rightZ: anchor.rightZ,
            platformSideM,
            trackbedHalfWidthM,
            genericDeckHalfWidthM: Math.max(0, finite(genericDeckHalfWidthM, 4)),
            genericCorridorHalfWidthM: Math.max(
                0,
                finite(genericCorridorHalfWidthM, 12),
            ),
            tunnelAlignment,
            openCutAlignment,
            effectiveStructure: null,
            groundY: null,
        });
        seen.add(key);
    }
    return envelopes;
}

function sameOwner(chunk, envelope) {
    if (envelope?.routeRunId != null && chunk?.routeRunId !== envelope.routeRunId) return false;
    if (envelope?.trackId == null || chunk?.trackId == null) return true;
    return String(envelope.trackId) === String(chunk.trackId);
}

function localCoordinates(envelope, x, z) {
    const dx = Number(x) - envelope.centerX;
    const dz = Number(z) - envelope.centerZ;
    return {
        along: dx * envelope.alongX + dz * envelope.alongZ,
        right: dx * envelope.rightX + dz * envelope.rightZ,
    };
}

function coveredStationAlignmentContains(envelope, x, z) {
    const samples = envelope?.openCutAlignment?.samples || [];
    const radiusSq = PHOTO_COVERED_STATION_SECTION.wallCenterM ** 2;
    for (let index = 1; index < samples.length; index++) {
        const from = samples[index - 1];
        const to = samples[index];
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq <= EPS) continue;
        const t = ((Number(x) - from.x) * dx + (Number(z) - from.z) * dz) / lengthSq;
        if (t < -EPS || t > 1 + EPS) continue;
        const qx = from.x + dx * t - Number(x);
        const qz = from.z + dz * t - Number(z);
        if (qx * qx + qz * qz <= radiusSq) return true;
    }
    return false;
}

function clipAxis(state, origin, delta, low, high) {
    if (Math.abs(delta) <= EPS) return origin >= low - EPS && origin <= high + EPS;
    let enter = (low - origin) / delta;
    let exit = (high - origin) / delta;
    if (enter > exit) [enter, exit] = [exit, enter];
    state.enter = Math.max(state.enter, enter);
    state.exit = Math.min(state.exit, exit);
    return state.enter <= state.exit + EPS;
}

function chunkEnvelopeInterval(chunk, envelope, layout) {
    if (!sameOwner(chunk, envelope)) return null;
    const start = localCoordinates(envelope, chunk.x0, chunk.z0);
    const end = localCoordinates(envelope, chunk.x1, chunk.z1);
    const state = { enter: 0, exit: 1 };
    if (!clipAxis(
        state,
        start.along,
        end.along - start.along,
        -layout.alongHalfM,
        layout.alongHalfM,
    )) return null;
    if (!clipAxis(
        state,
        start.right,
        end.right - start.right,
        -layout.captureHalfWidthM,
        layout.captureHalfWidthM,
    )) return null;
    return state.exit - state.enter > EPS ? state : null;
}

export function resolvePhotoStationStructures(chunks = [], envelopes = []) {
    const resolved = new Map();
    for (const envelope of envelopes || []) {
        let best = null;
        for (const chunk of chunks || []) {
            if (!sameOwner(chunk, envelope)) continue;
            const dx = Number(chunk.mx) - envelope.centerX;
            const dz = Number(chunk.mz) - envelope.centerZ;
            const distanceSq = dx * dx + dz * dz;
            if (!Number.isFinite(distanceSq) || (best && distanceSq >= best.distanceSq)) continue;
            const structure = chunk.structure;
            if (!['formation', 'viaduct', 'tunnel'].includes(structure)) continue;
            best = { chunk, structure, distanceSq };
        }
        if (!best) continue;
        // A station is rigid and canonical. Require classified evidence close to
        // its centre instead of borrowing a civil regime from a distant loaded tile.
        const maxDistanceM = Math.max(18, Number(best.chunk?.spanLen) * 2 || 0);
        if (best.distanceSq > maxDistanceM * maxDistanceM) continue;
        const terrainChunks = (chunks || []).filter(chunk => (
            sameOwner(chunk, envelope) && Number.isFinite(Number(chunk.dguGroundY))
        ));
        const fullTerrain = [];
        const compactTerrain = [];
        for (const chunk of terrainChunks) {
            const local = localCoordinates(envelope, chunk.mx, chunk.mz);
            if (Math.abs(local.along) <= UNDERGROUND_STATION_TOTAL_LENGTH_M * 0.5 + EPS) {
                fullTerrain.push(chunk.dguGroundY);
            }
            if (Math.abs(local.along) <= UNDERGROUND_STATION_LENGTH_M * 0.5 + EPS) {
                compactTerrain.push(chunk.dguGroundY);
            }
        }
        const vertical = classifyStationVerticalForm({
            railElevAslM: envelope.trackY,
            // Civil form follows DGU/bare earth. Google groundC is only a
            // streamed visible-surface observation and may hit a roof or tree.
            terrainSamplesAslM: fullTerrain,
            compactTerrainSamplesAslM: compactTerrain,
        });
        let stationForm = vertical?.form;
        if (stationForm === STATION_VERTICAL_FORM.UNKNOWN) {
            stationForm = photoStationHasRigidCover(envelope, best.chunk.groundC)
                ? STATION_VERTICAL_FORM.FULL
                : STATION_VERTICAL_FORM.COMPACT_COVERED;
        }
        if (stationForm === STATION_VERTICAL_FORM.FULL
            && !photoStationSupportsRigidStructure(envelope, 'tunnel')) {
            stationForm = STATION_VERTICAL_FORM.COMPACT_COVERED;
        }
        const openCutFallback = best.structure === 'tunnel'
            && stationForm !== STATION_VERTICAL_FORM.FULL;
        const compactCovered = stationForm === STATION_VERTICAL_FORM.COMPACT_COVERED;
        resolved.set(envelope.key, {
            structure: openCutFallback ? 'formation' : best.structure,
            terrainStructure: best.structure,
            openCutFallback,
            compactCovered,
            stationForm,
            groundY: finite(best.chunk.groundC),
        });
    }
    return resolved;
}

function seriesAt(start, middle, end, t) {
    const a = finite(start);
    const m = finite(middle);
    const b = finite(end);
    if (t <= 0.5) {
        if (a == null || m == null) return t <= EPS ? a : m;
        return a + (m - a) * (t * 2);
    }
    if (m == null || b == null) return t >= 1 - EPS ? b : m;
    return m + (b - m) * ((t - 0.5) * 2);
}

function splitChunk(chunk, t0, t1, pieceIndex) {
    const x0 = chunk.x0 + (chunk.x1 - chunk.x0) * t0;
    const z0 = chunk.z0 + (chunk.z1 - chunk.z0) * t0;
    const ty0 = chunk.ty0 + (chunk.ty1 - chunk.ty0) * t0;
    const x1 = chunk.x0 + (chunk.x1 - chunk.x0) * t1;
    const z1 = chunk.z0 + (chunk.z1 - chunk.z0) * t1;
    const ty1 = chunk.ty0 + (chunk.ty1 - chunk.ty0) * t1;
    const spanLen = Math.hypot(x1 - x0, z1 - z0);
    const tm = (t0 + t1) * 0.5;
    return {
        ...chunk,
        x0,
        z0,
        ty0,
        x1,
        z1,
        ty1,
        mx: (x0 + x1) * 0.5,
        mz: (z0 + z1) * 0.5,
        ty: (ty0 + ty1) * 0.5,
        spanLen,
        surfaceL0: seriesAt(chunk.surfaceL0, chunk.surfaceL, chunk.surfaceL1, t0),
        surfaceL: seriesAt(chunk.surfaceL0, chunk.surfaceL, chunk.surfaceL1, tm),
        surfaceL1: seriesAt(chunk.surfaceL0, chunk.surfaceL, chunk.surfaceL1, t1),
        surfaceR0: seriesAt(chunk.surfaceR0, chunk.surfaceR, chunk.surfaceR1, t0),
        surfaceR: seriesAt(chunk.surfaceR0, chunk.surfaceR, chunk.surfaceR1, tm),
        surfaceR1: seriesAt(chunk.surfaceR0, chunk.surfaceR, chunk.surfaceR1, t1),
        pier: !!chunk.pier && t0 <= 0.5 + EPS && t1 >= 0.5 - EPS,
        seed: Number(chunk.seed || 0) * 7 + pieceIndex,
        stationOwner: null,
    };
}

function pathDistanceSq(samples, x, z) {
    let best = Infinity;
    for (let index = 1; index < samples.length; index++) {
        const from = samples[index - 1];
        const to = samples[index];
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const lengthSq = dx * dx + dz * dz;
        const t = lengthSq > EPS
            ? Math.max(0, Math.min(1, ((x - from.x) * dx + (z - from.z) * dz) / lengthSq))
            : 0;
        const qx = from.x + dx * t - x;
        const qz = from.z + dz * t - z;
        best = Math.min(best, qx * qx + qz * qz);
    }
    return best;
}

function adjacentRunContext(result, run, envelope, atStart) {
    const boundary = atStart ? run.samples[0] : run.samples[run.samples.length - 1];
    const step = atStart ? -1 : 1;
    let cursor = (atStart ? run.startIndex : run.endIndex) + step;
    let join = boundary;
    while (cursor >= 0 && cursor < result.length) {
        const piece = result[cursor];
        if (!sameOwner(piece, envelope)) return null;
        const adjacent = atStart
            ? { x: piece.x1, y: piece.ty1, z: piece.z1 }
            : { x: piece.x0, y: piece.ty0, z: piece.z0 };
        if (Math.hypot(adjacent.x - join.x, adjacent.z - join.z) > 1.5) return null;
        const context = atStart
            ? { x: piece.x0, y: piece.ty0, z: piece.z0 }
            : { x: piece.x1, y: piece.ty1, z: piece.z1 };
        if (Math.hypot(context.x - boundary.x, context.z - boundary.z) > EPS) {
            return context;
        }
        join = context;
        cursor += step;
    }
    return null;
}

function assignCoveredStationSweeps(result, active) {
    const runsByKey = new Map();
    for (let resultIndex = 0; resultIndex < result.length; resultIndex++) {
        const piece = result[resultIndex];
        if (piece.structure !== 'station-covered') continue;
        const key = piece.stationOwner?.key;
        if (!key) continue;
        let runs = runsByKey.get(key);
        if (!runs) {
            runs = [];
            runsByKey.set(key, runs);
        }
        let run = runs[runs.length - 1];
        const tail = run?.samples?.[run.samples.length - 1];
        if (!tail || Math.hypot(tail.x - piece.x0, tail.z - piece.z0) > 1.5) {
            run = {
                samples: [{ x: piece.x0, y: piece.ty0, z: piece.z0 }],
                startIndex: resultIndex,
                endIndex: resultIndex,
            };
            runs.push(run);
        }
        run.samples.push({ x: piece.x1, y: piece.ty1, z: piece.z1 });
        run.endIndex = resultIndex;
    }
    for (const { envelope } of active) {
        if (!envelope.compactCovered) continue;
        envelope.coveredStationSweep = null;
        const runs = runsByKey.get(envelope.key) || [];
        const run = [...runs].sort((left, right) => (
            pathDistanceSq(left.samples, envelope.centerX, envelope.centerZ)
            - pathDistanceSq(right.samples, envelope.centerX, envelope.centerZ)
        ))[0];
        if (run?.samples?.length >= 2) {
            envelope.coveredStationSweep = buildPhotoCoveredStationSweep(run.samples, {
                startContext: adjacentRunContext(result, run, envelope, true),
                endContext: adjacentRunContext(result, run, envelope, false),
                platform: {
                    sideM: envelope.platformSideM,
                    widthM: PLATFORM_WIDTH_M,
                    heightM: UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M,
                    lengthM: UNDERGROUND_PLATFORM_LENGTH_M,
                    center: { x: envelope.centerX, z: envelope.centerZ },
                    label: envelope.stationName,
                },
            });
        }
    }
}

export function applyPhotoStationCivilOwnership(chunks = [], envelopes = [], resolved = new Map()) {
    const active = [];
    for (const envelope of envelopes || []) {
        const decision = resolved.get(envelope.key);
        if (!decision) continue;
        envelope.effectiveStructure = decision.structure;
        envelope.groundY = decision.groundY;
        envelope.openCutFallback = !!decision.openCutFallback;
        envelope.compactCovered = !!decision.compactCovered;
        envelope.stationForm = decision.stationForm || null;
        if (!photoStationSupportsRigidStructure(envelope, decision.structure)) continue;
        active.push({ envelope, layout: structureLayout(envelope, decision.structure) });
    }
    const result = [];
    for (const chunk of chunks || []) {
        const intervals = [];
        const cuts = [0, 1];
        for (const item of active) {
            const interval = chunkEnvelopeInterval(chunk, item.envelope, item.layout);
            if (!interval) continue;
            intervals.push({ ...item, ...interval });
            if (interval.enter > EPS && interval.enter < 1 - EPS) cuts.push(interval.enter);
            if (interval.exit > EPS && interval.exit < 1 - EPS) cuts.push(interval.exit);
        }
        cuts.sort((a, b) => a - b);
        const uniqueCuts = cuts.filter((value, index) => index === 0 || value - cuts[index - 1] > EPS);
        for (let index = 1; index < uniqueCuts.length; index++) {
            const t0 = uniqueCuts[index - 1];
            const t1 = uniqueCuts[index];
            if (t1 - t0 <= EPS) continue;
            const middle = (t0 + t1) * 0.5;
            let owner = intervals
                .filter(interval => middle >= interval.enter - EPS && middle <= interval.exit + EPS)
                .sort((a, b) => a.layout.alongHalfM - b.layout.alongHalfM)[0];
            const piece = splitChunk(chunk, t0, t1, index - 1);
            if (owner?.envelope?.compactCovered
                && !coveredStationAlignmentContains(owner.envelope, piece.mx, piece.mz)) {
                owner = null;
            }
            piece.genericStructure = chunk.structure;
            if (owner) {
                piece.stationOwner = { ...owner.envelope, ...owner.layout };
                piece.structure = owner.envelope.compactCovered
                    ? 'station-covered'
                    : owner.envelope.effectiveStructure === 'tunnel'
                        ? 'station-underground'
                    : owner.envelope.effectiveStructure === 'viaduct'
                        ? 'station-viaduct'
                        : 'station-formation';
            }
            piece.tunnel = piece.structure === 'tunnel';
            piece.viaduct = piece.structure === 'viaduct' || piece.structure === 'station-viaduct';
            result.push(piece);
        }
    }
    assignCoveredStationSweeps(result, active);
    return result;
}

function pushQuad(target, envelope, rightMin, rightMax, alongMin, alongMax, green, floorY, encode) {
    const point = (right, along) => [
        envelope.centerX + envelope.rightX * right + envelope.alongX * along,
        0,
        envelope.centerZ + envelope.rightZ * right + envelope.alongZ * along,
    ];
    const a = point(rightMin, alongMin);
    const b = point(rightMax, alongMin);
    const c = point(rightMax, alongMax);
    const d = point(rightMin, alongMax);
    target.positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    const blue = encode(floorY);
    for (let index = 0; index < 6; index++) target.colors.push(1, green, blue);
}

function pushCoveredStationRouteMask(
    target,
    envelope,
    encode,
    tunnelSourceRoofOffsetM,
) {
    const data = buildPhotoCoveredStationMaskData(envelope?.coveredStationSweep, {
        encodeFloor: encode,
        tunnelSourceRoofOffsetM,
    });
    target.positions.push(...data.positions);
    target.colors.push(...data.colors);
}

function coveredStationSourceAt(envelope, x, z) {
    if (!envelope?.compactCovered) return null;
    return photoCoveredStationOwnershipAt(envelope.coveredStationSweep, x, z);
}

export function buildPhotoStationMaskQuads(envelopes = [], {
    encodeFloor,
    tunnelSourceRoofOffsetM = 7.45,
} = {}) {
    const encode = typeof encodeFloor === 'function' ? encodeFloor : () => 0;
    const ownership = { positions: [], colors: [] };
    const openings = { positions: [], colors: [] };
    for (const envelope of envelopes || []) {
        const structure = envelope.effectiveStructure;
        if (!['formation', 'viaduct', 'tunnel'].includes(structure)) continue;
        if (!photoStationSupportsRigidStructure(envelope, structure)) continue;
        const layout = structureLayout(envelope, structure);
        if (envelope.compactCovered) {
            // The compact fallback follows the authored curve sample-by-sample.
            // Green ownership preserves Google above its fixed roof while
            // discarding fused source faces inside the hall volume.
            pushCoveredStationRouteMask(
                ownership,
                envelope,
                encode,
                Number(tunnelSourceRoofOffsetM || 0),
            );
            continue;
        }
        if (structure !== 'tunnel') {
            pushQuad(
                ownership,
                envelope,
                layout.maskRightMinM,
                layout.maskRightMaxM,
                -layout.alongHalfM,
                layout.alongHalfM,
                0,
                envelope.trackY,
                encode,
            );
            continue;
        }
        const maskTrackY = envelope.trackY + layout.sourceRoofOffsetM
            - Number(tunnelSourceRoofOffsetM || 0);
        pushQuad(
            ownership,
            envelope,
            layout.maskRightMinM,
            layout.maskRightMaxM,
            -layout.alongHalfM,
            layout.alongHalfM,
            1,
            maskTrackY,
            encode,
        );
        const openingHalfWidth = UNDERGROUND_ENTRANCE_CUT_WIDTH_M * 0.5;
        // Hollow the complete stair shaft down to the station track datum. The
        // opening is deliberately narrower than the stair flight, so authored
        // treads remain the only walk support and streamed tile skirts cannot
        // form invisible shelves half-way down.
        const openingFloorY = envelope.trackY;
        for (const direction of [-1, 1]) {
            const a = direction * METRO_ENTRANCE_START_ALONG_M;
            const b = direction * METRO_ENTRANCE_END_ALONG_M;
            const centerRight = direction * UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M;
            pushQuad(
                openings,
                envelope,
                centerRight - openingHalfWidth,
                centerRight + openingHalfWidth,
                Math.min(a, b),
                Math.max(a, b),
                0,
                openingFloorY,
                encode,
            );
        }
    }
    return { ownership, openings };
}

function pointInsideLayout(envelope, layout, x, z) {
    const local = localCoordinates(envelope, x, z);
    return Math.abs(local.along) <= layout.alongHalfM + EPS
        && local.right >= layout.maskRightMinM - EPS
        && local.right <= layout.maskRightMaxM + EPS;
}

export function photoStationSourceOwnershipAt(envelopes = [], x, z) {
    for (const envelope of envelopes || []) {
        const structure = envelope.effectiveStructure;
        if (!['formation', 'viaduct', 'tunnel'].includes(structure)) continue;
        if (!photoStationSupportsRigidStructure(envelope, structure)) continue;
        const layout = structureLayout(envelope, structure);
        if (envelope.compactCovered) {
            const covered = coveredStationSourceAt(envelope, x, z);
            if (covered) {
                return {
                    mode: 'station-core',
                    floorY: covered.trackY,
                    roofY: covered.roofY,
                    envelope,
                };
            }
            continue;
        }
        if (structure === 'tunnel') {
            const local = localCoordinates(envelope, x, z);
            const half = UNDERGROUND_ENTRANCE_CUT_WIDTH_M * 0.5;
            for (const direction of [-1, 1]) {
                const a = direction * METRO_ENTRANCE_START_ALONG_M;
                const b = direction * METRO_ENTRANCE_END_ALONG_M;
                if (local.along >= Math.min(a, b) - EPS
                    && local.along <= Math.max(a, b) + EPS
                    && Math.abs(local.right
                        - direction * UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M) <= half + EPS) {
                    return {
                        mode: 'open',
                        floorY: envelope.trackY,
                        envelope,
                    };
                }
            }
            if (pointInsideLayout(envelope, layout, x, z)) {
                return {
                    mode: 'station-core',
                    floorY: envelope.trackY,
                    roofY: envelope.trackY + layout.sourceRoofOffsetM,
                    envelope,
                };
            }
            continue;
        }
        if (pointInsideLayout(envelope, layout, x, z)) {
            return { mode: 'open', floorY: envelope.trackY, envelope };
        }
    }
    return null;
}
