// Normalizes a Consensus Builder rail proposal (goal road-track with
// metadata.isTrack) into the GeoJSON contract Station 3D's rail machinery
// already speaks: features tagged source 'cb-proposal', which
// isEngineeredRailFeature() classifies as an engineered alignment and
// planner-elevation reads for viaduct/tunnel structures.
//
// This module existed once (website/proposal-track.js, UMD) for the
// ?st3d=cab&track= deeplink and was deleted with its only user when the legacy
// rail audit moved into a transit project (10a5d1e). Resurrected as a core ES
// module for the WALK deeplink — a named plan carries its rail (the Šibenik
// plan's krak V, imported from prijevoz project 141), and its bay bridge has
// to render at the imported alignment's height, not wherever a fresh
// grade solve puts it.
//
// Three elevation shapes, best first:
//   elevationM per point + metadata.elevationDatum 'EVRF2000'
//       → [lon, lat, absolute m], elevationMode 'absolute' — the rail
//         formation seats the rail exactly on the authored profile.
//   level per point (the prijevoz→CB import: the SOLVED profile expressed as
//   ground-relative metres ÷ 10, full precision — level -0.854 is -8.54 m)
//       → [lon, lat, level × 10 m], elevationMode 'ground-relative' — the
//         formation seats terrain + offset, and the planner level machinery
//         (±10 m regimes) draws the decks and tunnel tubes it always drew.
//   neither → bare [lon, lat], terrainFormation 'smooth-grade' — the sim
//         designs a grade-limited profile over the terrain itself.

import { haversineMeters } from './math.js';
import { DEFAULT_VIADUCT_FILL_THRESHOLD_M } from './rail-formation.js';

const SUPPORTED_ELEVATION_DATUM = 'EVRF2000';
// The planner's level unit (PLANNER_LEVEL_HEIGHT_M in world/planner-station-
// layout.js — named here rather than imported so this module stays pure).
const LEVEL_HEIGHT_M = 10;
const RAIL_MODES = new Set(['train', 'tram']);
const GAUGE_TYPES = new Set(['g1000', 'g1435', 'monorail']);
const AUTHORED_PLANNER_RAIL_SOURCES = new Set(['cb-proposal', 'user', 'user-line']);

// These sources carry an explicit authored alignment and, when applicable, an
// explicit tunnel/viaduct profile. A flat proposal footprint can overlap them
// in XZ without sharing their elevation, so the generic proposal land-use mask
// is never evidence that the railway may be removed. Ordinary OSM background
// rails retain the legacy mask behaviour.
export function isAuthoredPlannerRailFeature(feature) {
    const properties = feature?.feature?.properties || feature?.properties || {};
    return AUTHORED_PLANNER_RAIL_SOURCES.has(
        String(properties.source || '').trim().toLowerCase(),
    );
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function transitProjectTrackPhysicalId(projectId, trackId) {
    const resolvedProjectId = finiteNumber(projectId);
    const resolvedTrackId = finiteNumber(trackId);
    if (!Number.isInteger(resolvedProjectId) || resolvedProjectId <= 0
        || !Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0) return null;
    return `transit-project-${resolvedProjectId}-track-${resolvedTrackId}`;
}

// Consensus imports name their source project/track explicitly. Trust that
// identity only when the record's provenance agrees with the name: a generic
// proposal must never be folded into an unrelated live planner track merely
// because its geometry happens to overlap.
export function transitProposalTrackPhysicalId(record) {
    const proposalId = String(record?.proposalId || '').trim();
    const match = /^transit-project-(\d+)-track-(\d+)$/.exec(proposalId);
    if (!match) return null;
    const sourceProjectId = finiteNumber(record?.source?.transitProjectId);
    if (sourceProjectId !== Number(match[1])) return null;
    return transitProjectTrackPhysicalId(match[1], match[2]);
}

// A plan deeplink can carry the imported snapshot of the project already open
// in the planner. They are two data records but one physical railway. Replace
// that one project feature with the proposal's structural geometry/properties,
// while retaining the project's operational identity and timetable metadata.
// Ambiguous multi-part identities are left separate instead of guessing.
export function mergeProposalTrackFeatures(existingFeatures, proposalFeatures) {
    const existing = Array.isArray(existingFeatures) ? existingFeatures : [];
    const proposals = Array.isArray(proposalFeatures) ? proposalFeatures : [];
    const result = existing.slice();
    const existingIndices = new Map();
    const proposalCounts = new Map();
    const physicalIdFor = feature => {
        const id = String(feature?.properties?.railPhysicalId || '').trim();
        return id || null;
    };
    const geometryHashFor = feature => {
        const hash = String(feature?.properties?.railSourceGeometryHash || '').trim();
        return hash || null;
    };
    for (let index = 0; index < existing.length; index += 1) {
        const physicalId = physicalIdFor(existing[index]);
        if (!physicalId) continue;
        const indices = existingIndices.get(physicalId) || [];
        indices.push(index);
        existingIndices.set(physicalId, indices);
    }
    for (const feature of proposals) {
        const physicalId = physicalIdFor(feature);
        if (physicalId) proposalCounts.set(
            physicalId,
            (proposalCounts.get(physicalId) || 0) + 1,
        );
    }
    for (const feature of proposals) {
        const physicalId = physicalIdFor(feature);
        const matches = physicalId ? existingIndices.get(physicalId) : null;
        const existingFeature = matches?.length === 1 ? result[matches[0]] : null;
        const geometryHash = geometryHashFor(feature);
        if (!physicalId || matches?.length !== 1 || proposalCounts.get(physicalId) !== 1
            || !geometryHash || geometryHash !== geometryHashFor(existingFeature)) {
            result.push(feature);
            continue;
        }
        result[matches[0]] = {
            ...feature,
            properties: {
                ...(existingFeature?.properties || {}),
                ...(feature?.properties || {}),
                source: existingFeature?.properties?.source
                    || feature?.properties?.source,
                railPhysicalId: physicalId,
            },
        };
    }
    return result;
}

export function normalizeRailMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return RAIL_MODES.has(normalized) ? normalized : 'train';
}

// The definition's cross-section (profile.strips) is the corridor's living description —
// consensus-builder's cross-section editor works on it — so its rail lanes outrank the
// import-time metadata snapshot for both track count and gauge.
function profileRailStrips(roadPlan) {
    const strips = roadPlan?.profile?.strips;
    return Array.isArray(strips)
        ? strips.filter((strip) => strip && strip.type === 'rail')
        : [];
}

// One gauge for the alignment: the lanes' shared millimetre figure, or null when
// they disagree (a mixed tram/rail corridor names no single gauge).
function railStripsGaugeMm(railStrips) {
    const gauges = railStrips
        .map((strip) => finiteNumber(strip.gauge))
        .filter((gauge) => gauge != null);
    if (gauges.length === 0) return null;
    return gauges.every((gauge) => gauge === gauges[0]) ? gauges[0] : null;
}

function gaugeTypeForMillimetres(gaugeMm) {
    if (gaugeMm != null && Math.abs(gaugeMm - 1000) <= 5) return 'g1000';
    if (gaugeMm != null && Math.abs(gaugeMm - 1435) <= 5) return 'g1435';
    return null;
}

function normalizeGaugeType(metadata, railMode, railStrips = []) {
    const stripType = gaugeTypeForMillimetres(railStripsGaugeMm(railStrips));
    if (stripType) return stripType;
    const declared = String(
        metadata.trackGauge ?? metadata.gauge ?? metadata.trackType ?? '',
    ).trim().toLowerCase();
    if (GAUGE_TYPES.has(declared)) return declared;
    const metadataType = gaugeTypeForMillimetres(
        finiteNumber(metadata.gaugeMm ?? metadata.trackGaugeMm),
    );
    if (metadataType) return metadataType;
    return railMode === 'tram' ? 'g1000' : 'g1435';
}

export function gaugeMillimetresForType(trackType) {
    if (trackType === 'g1000') return 1000;
    if (trackType === 'g1435') return 1435;
    return null;
}

function isPoint(value) {
    if (Array.isArray(value)) {
        return finiteNumber(value[0]) != null && finiteNumber(value[1]) != null;
    }
    return value && typeof value === 'object'
        && finiteNumber(value.lng ?? value.lon) != null
        && finiteNumber(value.lat) != null;
}

function normalizeSegments(points) {
    if (!Array.isArray(points) || points.length === 0) return [];
    return isPoint(points[0]) ? [points] : points;
}

function pointElevationM(point) {
    return finiteNumber(Array.isArray(point) ? point[2] : point?.elevationM);
}

function pointLevel(point) {
    return Array.isArray(point) ? null : finiteNumber(point?.level);
}

function pointCoordinate(point, mode) {
    const lon = finiteNumber(Array.isArray(point) ? point[0] : point?.lng ?? point?.lon);
    const lat = finiteNumber(Array.isArray(point) ? point[1] : point?.lat);
    if (lon == null || lat == null) return null;
    if (mode === 'absolute') {
        const elevationM = pointElevationM(point);
        return elevationM == null ? null : [lon, lat, elevationM];
    }
    if (mode === 'ground-relative') {
        // A point the editor never lifted carries no level: that IS grade 0,
        // not missing data — the import writes levels only where the profile
        // leaves the ground.
        return [lon, lat, (pointLevel(point) ?? 0) * LEVEL_HEIGHT_M];
    }
    return [lon, lat];
}

function sourceChainagesForCoordinates(coordinates) {
    const chainages = [0];
    for (let index = 1; index < coordinates.length; index++) {
        const previous = coordinates[index - 1];
        const current = coordinates[index];
        chainages.push(chainages[index - 1] + haversineMeters(
            previous[1],
            previous[0],
            current[1],
            current[0],
        ));
    }
    return chainages;
}

// Imported planner levels are independent civil evidence, not a competing
// elevation source. Keep the precise EVRF2000 rail heights while publishing
// the tall-fill spans that the planner already designed as viaduct. This is
// essential over mapped sea, where a bare-earth DTM correctly has NoData and
// therefore cannot rediscover a bridge from rail-minus-ground at runtime.
function authoredViaductRuns(points, chainages, thresholdM) {
    const threshold = Math.max(
        0.5,
        finiteNumber(thresholdM) ?? DEFAULT_VIADUCT_FILL_THRESHOLD_M,
    );
    const flags = [];
    for (let index = 0; index < points.length - 1; index++) {
        const fromM = (pointLevel(points[index]) ?? 0) * LEVEL_HEIGHT_M;
        const toM = (pointLevel(points[index + 1]) ?? 0) * LEVEL_HEIGHT_M;
        flags.push(Math.max(fromM, toM) >= threshold);
    }
    const runs = [];
    let runStart = null;
    for (let index = 0; index <= flags.length; index++) {
        if (flags[index] && runStart === null) runStart = index;
        if (runStart === null || flags[index]) continue;
        runs.push({
            startM: chainages[runStart],
            endM: chainages[index],
            structure: 'viaduct',
        });
        runStart = null;
    }
    return runs;
}

/**
 * roadPlan → Feature[] (LineString per drawn segment), or throws with a
 * human-readable reason. `roadPlan` is proposal.geometry.roadPlan on newer
 * records and proposal.roadProposal.definition on older ones — both shapes
 * exist in the API today.
 */
export function buildProposalTrackFeatures(roadPlan, proposalId, {
    railPhysicalId = null,
} = {}) {
    if (roadPlan?.metadata?.isTrack !== true) {
        throw new Error(`Prijedlog ${proposalId} nije nacrtana tračnička trasa.`);
    }
    const metadata = roadPlan.metadata || {};
    const segments = normalizeSegments(roadPlan.points);
    const points = segments.flat().filter((point) => point && typeof point === 'object');
    const suppliedCount = points.filter((point) => pointElevationM(point) != null).length;
    const hasSuppliedElevations = suppliedCount > 0;
    if (hasSuppliedElevations && suppliedCount !== points.length) {
        throw new Error(
            `Prijedlog ${proposalId} ima samo djelomično zadane elevationM visine. `
            + 'Svaka točka mora imati apsolutnu visinu.',
        );
    }
    if (hasSuppliedElevations && metadata.elevationDatum !== SUPPORTED_ELEVATION_DATUM) {
        throw new Error(
            `Prijedlog ${proposalId} ima visine bez podržanog ${SUPPORTED_ELEVATION_DATUM} datuma.`,
        );
    }
    const hasLevels = !hasSuppliedElevations
        && points.some((point) => pointLevel(point) != null && pointLevel(point) !== 0);
    const mode = hasSuppliedElevations ? 'absolute' : hasLevels ? 'ground-relative' : 'bare';

    const railMode = normalizeRailMode(
        metadata.railMode ?? metadata.trackMode ?? metadata.trackType,
    );
    const railStrips = profileRailStrips(roadPlan);
    const trackType = normalizeGaugeType(metadata, railMode, railStrips);
    const properties = {
        source: 'cb-proposal',
        proposalId: String(proposalId),
        terrainFormation: mode === 'bare' ? 'smooth-grade' : 'authored-elevation',
        elevationMode: mode === 'absolute'
            ? 'absolute'
            : mode === 'ground-relative' ? 'ground-relative' : 'terrain-graded',
        railMode,
        // `trackType` is the pre-existing Station 3D GAUGE contract.
        // Keep service mode separate so "train" cannot accidentally
        // fall back to Zagreb's metre gauge.
        trackType,
        gaugeMm: gaugeMillimetresForType(trackType),
    };
    if (String(railPhysicalId || '').trim()) {
        properties.railPhysicalId = String(railPhysicalId).trim();
    }
    if (mode === 'absolute') properties.elevationDatum = SUPPORTED_ELEVATION_DATUM;
    const viaductFillThresholdM = finiteNumber(metadata.viaductFillThresholdM);
    if (viaductFillThresholdM != null && viaductFillThresholdM > 0) {
        properties.viaductFillThresholdM = viaductFillThresholdM;
    }
    const trackCount = railStrips.length > 0 ? railStrips.length : Number(metadata.trackCount);
    if (Number.isInteger(trackCount) && trackCount > 0) properties.trackCount = trackCount;

    const carriesPlannerLevels = points.some(point => pointLevel(point) != null)
        && (metadata.levels === true || metadata.source === 'transit-project');
    return segments
        .map((segment) => (Array.isArray(segment) ? segment : [])
            .map((point) => ({ point, coordinate: pointCoordinate(point, mode) }))
            .filter(entry => entry.coordinate))
        .filter((entries) => entries.length >= 2)
        .map((entries) => {
            const coordinates = entries.map(entry => entry.coordinate);
            const featureProperties = { ...properties };
            if (carriesPlannerLevels) {
                const chainages = sourceChainagesForCoordinates(coordinates);
                const civilRuns = authoredViaductRuns(
                    entries.map(entry => entry.point),
                    chainages,
                    properties.viaductFillThresholdM,
                );
                if (civilRuns.length > 0) {
                    featureProperties.railSourceChainagesM = chainages;
                    featureProperties.railCivilRuns = civilRuns;
                }
            }
            return {
                type: 'Feature',
                properties: featureProperties,
                geometry: { type: 'LineString', coordinates },
            };
        });
}

// Static endpoint pose (walk/cab spawn seeding). dir = -1 starts from the
// final endpoint so the same line can be inspected both ways.
export function startPoseForTrackFeatures(features, direction = 1) {
    const reverse = Number(direction) === -1;
    const candidates = reverse ? [...(features || [])].reverse() : (features || []);
    const feature = candidates.find(candidate => (
        candidate?.geometry?.type === 'LineString'
        && candidate.geometry.coordinates?.length >= 2
    ));
    if (!feature) return null;
    const coordinates = feature.geometry.coordinates;
    const startIndex = reverse ? coordinates.length - 1 : 0;
    const step = reverse ? -1 : 1;
    const start = coordinates[startIndex];
    let next = null;
    for (
        let index = startIndex + step;
        index >= 0 && index < coordinates.length;
        index += step
    ) {
        const candidate = coordinates[index];
        if (Math.abs(candidate[0] - start[0]) > 1e-9
            || Math.abs(candidate[1] - start[1]) > 1e-9) {
            next = candidate;
            break;
        }
    }
    if (!next) return null;
    const headingDeg = (Math.atan2(
        (next[0] - start[0]) * Math.cos((start[1] * Math.PI) / 180),
        next[1] - start[1],
    ) * 180) / Math.PI;
    return {
        lat: start[1],
        lon: start[0],
        headingDeg: (headingDeg + 360) % 360,
    };
}

export { SUPPORTED_ELEVATION_DATUM, LEVEL_HEIGHT_M };
