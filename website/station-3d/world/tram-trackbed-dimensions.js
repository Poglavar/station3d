// Canonical dimensions for Station3D rail cross-sections. Street tram/light
// rail keeps its flush paved bed and narrow rail bars; heavy rail gets the
// wider ballast shoulder, taller rail and sleepers of a mainline formation.
// Wider dynamic clearances, viaduct decks, platforms, and emergency walkways
// remain separate structures and must never be painted as extra trackbed.

import { describeStation, UNDERGROUND_STATION_TYPE_ID } from '../core/station-contract.js';

export const TRAM_GAUGE_M = 1.0;
export const TRAM_RAIL_WIDTH_M = 0.10;
export const TRAM_RAIL_HEIGHT_M = 0.10;
export const TRAM_RAIL_CENTER_ABOVE_DATUM_M = 0.12;
export const TRAM_TRACKBED_SHOULDER_M = 0.5;
export const TRAM_TRACKBED_HALF_WIDTH_M =
    TRAM_GAUGE_M * 0.5 + TRAM_RAIL_WIDTH_M * 0.5 + TRAM_TRACKBED_SHOULDER_M;
export const TRAM_TRACKBED_WIDTH_M = TRAM_TRACKBED_HALF_WIDTH_M * 2;
export const TRAM_TRACKBED_FLAT_CURB_WIDTH_M = 0.16;
export const HEAVY_RAIL_RAIL_WIDTH_M = 0.14;
export const HEAVY_RAIL_RAIL_HEIGHT_M = 0.16;
export const HEAVY_RAIL_RAIL_CENTER_ABOVE_DATUM_M = 0.20;
// From the outside face of the outer rail to the ballast edge. This includes
// the sleeper overhang plus roughly 0.34 m of visible ballast beyond a 2.6 m
// sleeper, so the terrain cutout ends on a broad, legible shoulder rather than
// on the former 16 cm tram curb strip.
export const HEAVY_RAIL_TRACKBED_SHOULDER_M = 0.85;

const TRAM_VISUAL_PROFILE = Object.freeze({
    kind: 'light-rail',
    railWidthM: TRAM_RAIL_WIDTH_M,
    railHeightM: TRAM_RAIL_HEIGHT_M,
    railCenterAboveDatumM: TRAM_RAIL_CENTER_ABOVE_DATUM_M,
    trackbedShoulderM: TRAM_TRACKBED_SHOULDER_M,
    hasFlatCurbs: true,
    hasSleepers: false,
});

const HEAVY_RAIL_VISUAL_PROFILE = Object.freeze({
    kind: 'heavy-rail',
    railWidthM: HEAVY_RAIL_RAIL_WIDTH_M,
    railHeightM: HEAVY_RAIL_RAIL_HEIGHT_M,
    railCenterAboveDatumM: HEAVY_RAIL_RAIL_CENTER_ABOVE_DATUM_M,
    trackbedShoulderM: HEAVY_RAIL_TRACKBED_SHOULDER_M,
    hasFlatCurbs: false,
    hasSleepers: true,
});
// Existing heavy rail needs a level formation beyond the visible ballast bed:
// drainage/cess space and a stable shoulder before the cut or fill batter
// begins. Without it the DGU hillside rose immediately beside the rail heads.
// The 1.25 m apron plus the visible ballast makes a roughly 5.8 m single-track
// formation, broad enough for drainage/cess space without painting it all.
export const RECONSTRUCTED_HEAVY_RAIL_FORMATION_APRON_M = 1.25;
// A station yard is one ballast field shared by several single-track OSM
// centrelines. A wider per-track apron makes neighbouring strips overlap into
// that field, while the solved route itself remains the only driveable track.
export const STATION_YARD_HEAVY_RAIL_FORMATION_APRON_M = 2.0;

export const PLANNER_TRACK_COUNT = 2;
export const PLANNER_TRACK_ARRANGEMENT = 'together';
// A 10 m island platform needs about 1.6 m from each platform edge to its
// adjacent track centre. The platform carries the stair core, the lift and a
// walkable mezzanine above it, none of which fit on a 6.4 m island. This is a
// station cross-section, not a tunnel-depth cross-section: ordinary running
// tunnels stay compact and widen only in the local approach to an underground
// island station, where the flare below absorbs the difference.
export const PLANNER_UNDERGROUND_TRACK_CENTER_SPACING_M = 13.2;
export const PLANNER_UNDERGROUND_STATION_CORE_HALF_LENGTH_M = 30;
export const PLANNER_UNDERGROUND_STATION_FLARE_LENGTH_M = 55;

const GAUGE_METERS_BY_TYPE = Object.freeze({
    monorail: 1.2,
    g1000: 1.0,
    g1435: 1.435,
});

const TRACK_CENTER_SPACING_BY_TYPE = Object.freeze({
    monorail: 3.4,
    g1000: 2.8,
    g1435: 3.4,
});

export function normalizeTrackType(trackType) {
    return Object.prototype.hasOwnProperty.call(GAUGE_METERS_BY_TYPE, trackType)
        ? trackType
        : null;
}

function explicitGaugeMeters(properties = {}) {
    const rawGauge = properties.gauge ?? properties.tags?.gauge;
    if (rawGauge == null || rawGauge === '') return null;
    const parsed = Number.parseFloat(String(rawGauge).trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    // OSM stores rail gauge in millimetres; authored planner geometry may
    // already carry metres. Accept both without making every caller translate.
    return parsed >= 100 ? parsed / 1000 : parsed;
}

export function isHeavyRailProperties(properties = {}) {
    const railway = String(
        properties.railway_type ?? properties.railway ?? properties.tags?.railway ?? '',
    ).toLowerCase();
    const railMode = String(properties.railMode ?? properties.tags?.rail_mode ?? '').toLowerCase();
    const trackType = String(properties.trackType ?? '').toLowerCase();
    // Explicit light-rail identity wins over gauge: standard-gauge tramways
    // still need a paved street cross-section, not sleepers and ballast.
    if (railway === 'tram' || railway === 'light_rail'
        || railMode === 'tram' || railMode === 'light-rail'
        || trackType === 'g1000' || trackType === 'monorail') return false;
    if (railway === 'rail' || railMode === 'train' || trackType === 'g1435') return true;
    const gaugeM = explicitGaugeMeters(properties);
    return Number.isFinite(gaugeM) && gaugeM >= 1.4;
}

export function getRailVisualProfile(properties = {}) {
    return isHeavyRailProperties(properties)
        ? HEAVY_RAIL_VISUAL_PROFILE
        : TRAM_VISUAL_PROFILE;
}

function inferredTrackType(properties = {}) {
    const declared = normalizeTrackType(properties.trackType);
    if (declared) return declared;
    const gaugeM = explicitGaugeMeters(properties);
    if (Number.isFinite(gaugeM)) {
        if (Math.abs(gaugeM - GAUGE_METERS_BY_TYPE.g1000) <= 0.02) return 'g1000';
        if (Math.abs(gaugeM - GAUGE_METERS_BY_TYPE.g1435) <= 0.02) return 'g1435';
    }
    const railway = String(
        properties.railway_type ?? properties.railway ?? properties.tags?.railway ?? '',
    );
    if (railway === 'rail') return 'g1435';
    if (railway === 'monorail') return 'monorail';
    return 'g1000';
}

export function getTrackGaugeMeters(properties = {}) {
    const gaugeM = explicitGaugeMeters(properties);
    if (Number.isFinite(gaugeM)) return gaugeM;
    return GAUGE_METERS_BY_TYPE[inferredTrackType(properties)] ?? TRAM_GAUGE_M;
}

export function getTrackCenterSpacingMeters(properties = {}) {
    return TRACK_CENTER_SPACING_BY_TYPE[inferredTrackType(properties)]
        ?? TRACK_CENTER_SPACING_BY_TYPE.g1000;
}

// The flare also has to close as the track climbs out of the station level: a
// steep ramp can reach the surface well inside the 85 m flare envelope, and
// surface track must never be drawn at station spacing. This eases the flare
// out with depth instead of cutting it off at a fixed elevation, which snapped
// the rails together mid-flare and kinked them.
export const PLANNER_UNDERGROUND_FULL_FLARE_DEPTH_M = -8;
export const PLANNER_UNDERGROUND_NO_FLARE_DEPTH_M = -2;

export function getUndergroundDepthFlareFactor(elevationM) {
    const elevation = Number(elevationM);
    if (!Number.isFinite(elevation)) return 0;
    const span = PLANNER_UNDERGROUND_NO_FLARE_DEPTH_M - PLANNER_UNDERGROUND_FULL_FLARE_DEPTH_M;
    const t = Math.max(0, Math.min(
        1,
        (PLANNER_UNDERGROUND_NO_FLARE_DEPTH_M - elevation) / span,
    ));
    return t * t * (3 - 2 * t);
}

// The widening around an island platform belongs to the STATION, not to the
// tunnel that arrives at it. So this asks the station what its track spacing is
// at a given distance from its centre; beyond the station's own envelope the
// answer is the running spacing, which is how a tunnel stays a tunnel.
export function getTrackCenterSpacingAtStationDistanceMeters(
    properties = {},
    distanceFromStationM = Infinity,
    elevationM = null,
) {
    const runningSpacingM = getTrackCenterSpacingMeters(properties);
    if (getRenderedTrackCount(properties) === 1) return runningSpacingM;
    const station = describeStation(UNDERGROUND_STATION_TYPE_ID, {
        runningTrackSpacingM: runningSpacingM,
    });
    const stationSpacingM = station
        ? station.trackSpacingAtM(distanceFromStationM)
        : runningSpacingM;
    if (elevationM == null) return stationSpacingM;
    // Depth easing is applied OUTSIDE the station, and deliberately so: it only
    // exists because a ramp can climb out of station level inside the envelope,
    // which a station that actually enforced its level requirement would never
    // permit. It is a property of today's unowned geometry, not of a station —
    // so it stays here, to be deleted when the level requirement is enforced.
    const depthFactor = getUndergroundDepthFlareFactor(elevationM);
    return runningSpacingM + (stationSpacingM - runningSpacingM) * depthFactor;
}

export function getRenderedTrackCount(properties = {}) {
    const count = Number(properties.trackCount);
    return Number.isInteger(count) && count >= PLANNER_TRACK_COUNT
        ? PLANNER_TRACK_COUNT
        : 1;
}

export function getTrackCenterOffsetsMeters(properties = {}) {
    if (getRenderedTrackCount(properties) === 1) return [0];
    const halfSpacing = getTrackCenterSpacingMeters(properties) * 0.5;
    return [-halfSpacing, halfSpacing];
}

export function getTrackCenterOffsetsAtSpacingMeters(properties = {}, spacingM = null) {
    if (getRenderedTrackCount(properties) === 1) return [0];
    const resolvedSpacingM = Number.isFinite(Number(spacingM))
        ? Math.max(getTrackCenterSpacingMeters(properties), Number(spacingM))
        : getTrackCenterSpacingMeters(properties);
    return [-resolvedSpacingM * 0.5, resolvedSpacingM * 0.5];
}

export function getTrackbedHalfWidthMeters(properties = {}) {
    const gaugeM = getTrackGaugeMeters(properties);
    const profile = getRailVisualProfile(properties);
    const outsideTrackCenterM = Math.max(
        ...getTrackCenterOffsetsMeters(properties).map(offset => Math.abs(offset)),
    );
    return outsideTrackCenterM
        + gaugeM * 0.5
        + profile.railWidthM * 0.5
        + profile.trackbedShoulderM;
}

export function getRailFormationHalfWidthMeters(properties = {}) {
    const trackbedHalfWidthM = getTrackbedHalfWidthMeters(properties);
    if (properties?.railContextRole === 'station-yard'
        && getTrackGaugeMeters(properties) >= 1.4) {
        return trackbedHalfWidthM + STATION_YARD_HEAVY_RAIL_FORMATION_APRON_M;
    }
    const reconstructed = properties?.source === 'reference-project'
        || properties?.alignmentSource === 'reference-project';
    return reconstructed && getTrackGaugeMeters(properties) >= 1.4
        ? trackbedHalfWidthM + RECONSTRUCTED_HEAVY_RAIL_FORMATION_APRON_M
        : trackbedHalfWidthM;
}

// Most rail keeps the narrow visible ballast bed inside a wider civil
// formation. Curated yard context deliberately paints that formation as
// ballast so tracks 1–5 read as one station throat rather than isolated strips.
export function getRenderedRailTrackbedHalfWidthAtSpacingMeters(
    properties = {},
    spacingM = null,
) {
    return properties?.railContextRole === 'station-yard'
        ? getRailFormationHalfWidthMeters(properties)
        : getTrackbedHalfWidthAtSpacingMeters(properties, spacingM);
}

export function getTrackbedHalfWidthAtSpacingMeters(properties = {}, spacingM = null) {
    const gaugeM = getTrackGaugeMeters(properties);
    const profile = getRailVisualProfile(properties);
    const outsideTrackCenterM = Math.max(
        ...getTrackCenterOffsetsAtSpacingMeters(properties, spacingM)
            .map(offset => Math.abs(offset)),
    );
    return outsideTrackCenterM
        + gaugeM * 0.5
        + profile.railWidthM * 0.5
        + profile.trackbedShoulderM;
}

// The paved bed one single track carries: its gauge, rail heads and shoulders.
export function getSingleTrackBedHalfWidthMeters(properties = {}) {
    const profile = getRailVisualProfile(properties);
    return getTrackGaugeMeters(properties) * 0.5
        + profile.railWidthM * 0.5
        + profile.trackbedShoulderM;
}

// Two tracks running together share one paved bed — the strip between them is
// barely half a metre wide and is paved like the rest. As they flare apart at
// an underground station that strip becomes the station floor, with an island
// platform standing in it: paving straight across it drove the trackbed through
// the platform. Returns each track bed's inner edge, measured from the
// centreline; 0 means the two beds meet and read as one, exactly as before.
const BED_INNER_FILL_FULL_M = 0.8;
const BED_INNER_FILL_NONE_M = 1.6;

export function getTrackbedInnerEdgeAtSpacingMeters(properties = {}, spacingM = null) {
    if (getRenderedTrackCount(properties) === 1) return 0;
    const centerM = Math.max(
        ...getTrackCenterOffsetsAtSpacingMeters(properties, spacingM)
            .map(offset => Math.abs(offset)),
    );
    const gapM = Math.max(0, centerM - getSingleTrackBedHalfWidthMeters(properties));
    const t = Math.max(0, Math.min(
        1,
        (gapM - BED_INNER_FILL_FULL_M) / (BED_INNER_FILL_NONE_M - BED_INNER_FILL_FULL_M),
    ));
    return gapM * t * t * (3 - 2 * t);
}

export function getPlannerDoubleTrackProperties(trackType = 'g1000') {
    return {
        trackType: normalizeTrackType(trackType) || 'g1000',
        trackCount: PLANNER_TRACK_COUNT,
        trackArrangement: PLANNER_TRACK_ARRANGEMENT,
    };
}

export const PLANNER_DOUBLE_TRACKBED_MAX_HALF_WIDTH_M = getTrackbedHalfWidthMeters({
    trackType: 'g1435',
    trackCount: PLANNER_TRACK_COUNT,
});
export const PLANNER_DOUBLE_TRACKBED_MAX_WIDTH_M = PLANNER_DOUBLE_TRACKBED_MAX_HALF_WIDTH_M * 2;
