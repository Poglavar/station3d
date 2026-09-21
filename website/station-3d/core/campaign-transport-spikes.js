// Pure transport checkpoint descriptors and geometry checks used by campaign
// scenes and the generic localhost scenario catalog.

import { bearingDeg, haversineMeters } from './math.js';
import { railFeatureEndpointFragment } from './rail-feature-fragment.js';

export const CAMPAIGN_BOAT_MAX_SPEED_MPS = 18;
export const CAMPAIGN_RAIL_RENDER_SEED_M = 1800;

export const ZAGREB_SPLIT_PROJECT_IDS = Object.freeze([
    152, // Split – Perković
    108, // Perković – Knin north approach
    107, // Knin north approach – Gračac
    99,  // Gračac – Gospić
    106, // Gospić – Oštarije
    97,  // Oštarije – Karlovac
    96,  // Karlovac – Zagreb Glavni kolodvor
]);

export const ZAGREB_SPLIT_SOURCE_IDS = Object.freeze([
    'legacy-rail-perkovic-split-v1',
    'legacy-rail-knin-perkovic-v1',
    'legacy-rail-gracac-knin-v1',
    'legacy-rail-gospic-gracac-v1',
    'legacy-rail-ostarije-gospic-v1',
    'legacy-rail-karlovac-ostarije-v1',
    'legacy-rail-zagreb-karlovac-v1',
]);

export const ZAGREB_SPLIT_ROUTE_SEGMENTS = Object.freeze([
    Object.freeze({ projectId: 152, sourceId: ZAGREB_SPLIT_SOURCE_IDS[0], bbox: Object.freeze([16.08, 43.48, 16.51, 43.70]) }),
    Object.freeze({ projectId: 108, sourceId: ZAGREB_SPLIT_SOURCE_IDS[1], bbox: Object.freeze([16.05, 43.63, 16.30, 44.10]) }),
    Object.freeze({ projectId: 107, sourceId: ZAGREB_SPLIT_SOURCE_IDS[2], bbox: Object.freeze([15.75, 43.95, 16.30, 44.40]) }),
    Object.freeze({ projectId: 99, sourceId: ZAGREB_SPLIT_SOURCE_IDS[3], bbox: Object.freeze([15.30, 44.25, 15.90, 44.60]) }),
    Object.freeze({ projectId: 106, sourceId: ZAGREB_SPLIT_SOURCE_IDS[4], bbox: Object.freeze([15.20, 44.45, 15.75, 45.30]) }),
    Object.freeze({ projectId: 97, sourceId: ZAGREB_SPLIT_SOURCE_IDS[5], bbox: Object.freeze([15.20, 45.15, 15.62, 45.53]) }),
    Object.freeze({ projectId: 96, sourceId: ZAGREB_SPLIT_SOURCE_IDS[6], bbox: Object.freeze([15.45, 45.42, 16.05, 45.85]) }),
]);

const SOURCE_ID_BY_LEGACY_PROJECT = new Map(
    ZAGREB_SPLIT_PROJECT_IDS.map((projectId, index) => [
        projectId,
        ZAGREB_SPLIT_SOURCE_IDS[index],
    ]),
);

const BOAT_CHECKPOINTS = Object.freeze({
    'vis-departure': Object.freeze({
        id: 'vis-departure',
        title: 'Campaign spike · Vis departure',
        player: Object.freeze({ lat: 43.061000, lon: 16.183950, headingDeg: 90 }),
        boat: Object.freeze({
            id: 'campaign-vis-courier',
            lat: 43.061000,
            lon: 16.184050,
            heading: Math.PI * 0.5,
        }),
    }),
    'split-arrival': Object.freeze({
        id: 'split-arrival',
        title: 'Campaign spike · Split arrival',
        player: Object.freeze({ lat: 43.505000, lon: 16.441450, headingDeg: 270 }),
        boat: Object.freeze({
            id: 'campaign-vis-courier',
            lat: 43.505000,
            lon: 16.441390,
            heading: -Math.PI * 0.5,
        }),
    }),
});

const TRAIN_CHECKPOINTS = Object.freeze({
    'split-departure': Object.freeze({
        id: 'split-departure',
        title: 'Campaign spike · Split to Zagreb train',
        routeDirectionLabel: 'Split → Zagreb',
        projectId: 152,
        sourceId: 'legacy-rail-perkovic-split-v1',
        ref: 'M604',
        bbox: Object.freeze([16.395, 43.475, 16.470, 43.535]),
        initialEndpoint: 'last',
        // Keep only a short, immediately available solved section in the
        // world renderer. The complete 423 km chain remains the immutable
        // driver graph, while Croatia rail/terrain tiles stream around the
        // moving player. Feeding the whole Split–Perković reconstruction into
        // the formation layer made every terrain revision revisit tens of
        // thousands of far-away chords while the player was still on foot.
        renderSeedDistanceM: CAMPAIGN_RAIL_RENDER_SEED_M,
        // Keep one exact driver graph for the optional manual journey. The
        // renderer still windows these seven alignments around the observer;
        // terrain, buildings and Croatia rail tiles stream as the train moves.
        routeSegments: ZAGREB_SPLIT_ROUTE_SEGMENTS,
    }),
    'lika-inspection': Object.freeze({
        id: 'lika-inspection',
        title: 'Campaign · Lika inspection section',
        routeDirectionLabel: 'Split → Zagreb · Lika',
        projectId: 99,
        sourceId: 'legacy-rail-gospic-gracac-v1',
        ref: 'M604',
        // A bounded manual-driving window south-east of Gospić, including the
        // explicitly mapped 113 m bridge w132004805. The rest of the 422 km
        // journey remains a canonical cinematic transition.
        bbox: Object.freeze([15.405, 44.505, 15.445, 44.527]),
        initialEndpoint: 'last',
    }),
    'zagreb-platform-arrival': Object.freeze({
        id: 'zagreb-platform-arrival',
        title: 'Campaign spike · Zagreb platform arrival',
        routeDirectionLabel: 'Split → Zagreb Glavni kolodvor',
        // The repaired Zagreb–Karlovac source starts on M101 at the passenger
        // platforms and follows the shared throat onto M202.
        projectId: 96,
        sourceId: 'legacy-rail-zagreb-karlovac-v1',
        ref: 'M101',
        // Cover the authored western start and a short approach margin as well
        // as the platform. This remains a bounded local driving section.
        bbox: Object.freeze([15.968, 45.802, 15.985, 45.806]),
        initialEndpoint: 'last',
        // The reference-rail endpoint lands within metres of the OSM station
        // node; the explicit stop owns the true heavy-rail platform treatment.
        station: Object.freeze({
            stopId: 'osm-node-5627130425',
            name: 'Zagreb Glavni kolodvor',
            lat: 45.8044464,
            lng: 15.9788333,
            elevM: 120,
            level: 0,
            stationType: 'station',
        }),
    }),
});

export function campaignBoatCheckpoint(checkpointId) {
    return BOAT_CHECKPOINTS[String(checkpointId || '').trim().toLowerCase()] || null;
}

export function campaignTrainCheckpoint(checkpointId) {
    return TRAIN_CHECKPOINTS[String(checkpointId || '').trim().toLowerCase()] || null;
}

export function boatCheckpointBoardingDistanceM(checkpoint) {
    if (!checkpoint?.player || !checkpoint?.boat) return Infinity;
    return haversineMeters(
        checkpoint.player.lat,
        checkpoint.player.lon,
        checkpoint.boat.lat,
        checkpoint.boat.lon,
    );
}

export function visToSplitBoatEstimate() {
    const vis = BOAT_CHECKPOINTS['vis-departure'].boat;
    const split = BOAT_CHECKPOINTS['split-arrival'].boat;
    const distanceM = haversineMeters(vis.lat, vis.lon, split.lat, split.lon);
    return {
        distanceM,
        minutesAtMaxSpeed: distanceM / CAMPAIGN_BOAT_MAX_SPEED_MPS / 60,
    };
}

export function referenceGeometryUrl(apiBase, checkpoint) {
    const base = String(apiBase || '').replace(/\/+$/, '');
    if (!base || !Array.isArray(checkpoint?.bbox) || checkpoint.bbox.length !== 4) return null;
    const bbox = checkpoint.bbox.map(Number);
    if (!bbox.every(Number.isFinite)) return null;
    const query = new URLSearchParams({
        bbox: bbox.join(','),
        detail: 'exact',
    });
    return `${base}/transit/reference-project-geometry?${query.toString()}`;
}

function featureProjectId(feature) {
    return Number(
        feature?.properties?.referenceProjectId
        ?? feature?.properties?.projectId,
    );
}

function featureSourceId(feature) {
    return String(
        feature?.properties?.referenceSourceId
        || feature?.properties?.sourceId
        || SOURCE_ID_BY_LEGACY_PROJECT.get(featureProjectId(feature))
        || '',
    ).trim();
}

function featureCoordinates(feature) {
    return feature?.geometry?.type === 'LineString'
        && Array.isArray(feature.geometry.coordinates)
        ? feature.geometry.coordinates
        : [];
}

// A long-distance driver route is gameplay topology, not a request to build
// its complete visual formation at the spawn. Retain a short exact section
// from the checkpoint endpoint so rails are present before the first streamed
// Croatia tile arrives; the main engine then owns the moving world window.
export function railCheckpointRenderSeed(feature, checkpoint, maxDistanceM = null) {
    const distanceLimitM = Number(
        maxDistanceM ?? checkpoint?.renderSeedDistanceM ?? CAMPAIGN_RAIL_RENDER_SEED_M,
    );
    const fragment = railFeatureEndpointFragment(feature, {
        endpoint: checkpoint?.initialEndpoint === 'last' ? 'last' : 'first',
        maxDistanceM: distanceLimitM,
        preserveCivilRegimes: ['tunnel'],
    });
    if (!fragment) return null;
    return {
        ...fragment,
        properties: {
            ...(fragment.properties || {}),
            railProfileFragment: `${featureSourceId(feature) || 'rail'}:checkpoint-seed`,
            renderSeedDistanceM: distanceLimitM,
        },
    };
}

export function trainCheckpointGeometry(collection, checkpoint) {
    const sourceId = String(checkpoint?.sourceId || '').trim();
    const candidates = (collection?.features || [])
        .filter(feature => sourceId
            ? featureSourceId(feature) === sourceId
            : featureProjectId(feature) === Number(checkpoint?.projectId))
        .filter(feature => featureCoordinates(feature).length >= 2)
        // Reference projects are immutable revisions. Prefer the newest ID for
        // a stable reconstruction source, then the least-clipped geometry.
        .sort((left, right) => featureProjectId(right) - featureProjectId(left)
            || featureCoordinates(right).length - featureCoordinates(left).length);
    const feature = candidates[0] || null;
    if (!feature) return null;
    const coordinates = featureCoordinates(feature);
    const fromLast = checkpoint?.initialEndpoint === 'last';
    const start = coordinates[fromLast ? coordinates.length - 1 : 0];
    const next = coordinates[fromLast ? coordinates.length - 2 : 1];
    const startLon = Number(start?.[0]);
    const startLat = Number(start?.[1]);
    const nextLon = Number(next?.[0]);
    const nextLat = Number(next?.[1]);
    if (![startLon, startLat, nextLon, nextLat].every(Number.isFinite)) return null;
    return {
        feature,
        nodeCount: coordinates.length,
        initialPose: {
            lat: startLat,
            lon: startLon,
            headingDeg: bearingDeg(startLat, startLon, nextLat, nextLon),
            status: { speedKmh: 0 },
        },
    };
}

export function mergeZagrebSplitDriverFeatures(features) {
    const bySourceId = new Map();
    for (const feature of features || []) {
        const sourceId = featureSourceId(feature);
        if (!ZAGREB_SPLIT_SOURCE_IDS.includes(sourceId)) continue;
        const previous = bySourceId.get(sourceId);
        if (!previous
            || featureProjectId(feature) > featureProjectId(previous)
            || (featureProjectId(feature) === featureProjectId(previous)
                && featureCoordinates(feature).length > featureCoordinates(previous).length)) {
            bySourceId.set(sourceId, feature);
        }
    }
    if (ZAGREB_SPLIT_SOURCE_IDS.some(sourceId => !bySourceId.has(sourceId))) return null;

    const ordered = [...ZAGREB_SPLIT_SOURCE_IDS]
        .reverse()
        .map(sourceId => bySourceId.get(sourceId));
    const coordinates = [];
    for (const feature of ordered) {
        const next = featureCoordinates(feature);
        if (next.length < 2) return null;
        if (coordinates.length === 0) {
            coordinates.push(...next.map(point => [...point]));
            continue;
        }
        const previousEnd = coordinates.at(-1);
        const nextStart = next[0];
        const sameStart = previousEnd.length === nextStart.length
            && previousEnd.every((value, index) => Number(value) === Number(nextStart[index]));
        coordinates.push(...next.slice(sameStart ? 1 : 0).map(point => [...point]));
    }
    const template = ordered[0];
    return {
        ...template,
        properties: {
            ...(template.properties || {}),
            referenceProjectId: null,
            projectId: null,
            referenceSourceId: 'campaign-zagreb-split-manual-driver',
            sourceId: 'campaign-zagreb-split-manual-driver',
            trackCount: 1,
            trackArrangement: 'single',
            driverTrackOnly: true,
            elevationMode: 'absolute',
            elevationDatum: 'asl',
        },
        geometry: {
            type: 'LineString',
            coordinates,
        },
    };
}

function endpointForSplitToZagreb(feature, endpoint) {
    const coordinates = featureCoordinates(feature);
    if (coordinates.length < 2) return null;
    // Every prepared Zagreb–Split reconstruction is authored Zagreb → Split.
    // The campaign travels it in reverse, so its start is the raw last node.
    return endpoint === 'start' ? coordinates.at(-1) : coordinates[0];
}

function seamClassification(horizontalGapM, verticalGapM) {
    if (horizontalGapM <= 0.25 && verticalGapM <= 0.05) return 'exact';
    if (horizontalGapM <= 5 && verticalGapM <= 1.5) return 'minor-repair';
    return 'blocked';
}

export function auditProjectConnection(collection, fromProjectId, toProjectId) {
    const candidates = (projectId) => (collection?.features || [])
        .filter(feature => featureProjectId(feature) === Number(projectId))
        .filter(feature => featureCoordinates(feature).length >= 2)
        .sort((left, right) => featureCoordinates(right).length - featureCoordinates(left).length);
    const fromFeature = candidates(fromProjectId)[0] || null;
    const toFeature = candidates(toProjectId)[0] || null;
    if (!fromFeature || !toFeature) {
        return {
            fromProjectId: Number(fromProjectId),
            toProjectId: Number(toProjectId),
            classification: 'missing',
        };
    }
    let best = null;
    for (const from of featureCoordinates(fromFeature)) {
        for (const to of featureCoordinates(toFeature)) {
            const horizontalGapM = haversineMeters(
                Number(from?.[1]), Number(from?.[0]), Number(to?.[1]), Number(to?.[0]),
            );
            if (best && horizontalGapM >= best.horizontalGapM) continue;
            const fromZ = Number(from?.[2]);
            const toZ = Number(to?.[2]);
            const verticalGapM = Number.isFinite(fromZ) && Number.isFinite(toZ)
                ? Math.abs(toZ - fromZ)
                : Infinity;
            best = { horizontalGapM, verticalGapM, from, to };
        }
    }
    return {
        fromProjectId: Number(fromProjectId),
        toProjectId: Number(toProjectId),
        ...best,
        classification: best
            ? seamClassification(best.horizontalGapM, best.verticalGapM)
            : 'missing',
    };
}

export function auditZagrebSplitContinuity(collection) {
    const bySourceId = new Map();
    for (const feature of collection?.features || []) {
        const sourceId = featureSourceId(feature);
        if (!ZAGREB_SPLIT_SOURCE_IDS.includes(sourceId)) continue;
        const previous = bySourceId.get(sourceId);
        if (!previous
            || featureProjectId(feature) > featureProjectId(previous)
            || (featureProjectId(feature) === featureProjectId(previous)
                && featureCoordinates(feature).length > featureCoordinates(previous).length)) {
            bySourceId.set(sourceId, feature);
        }
    }
    const missingSourceIds = ZAGREB_SPLIT_SOURCE_IDS
        .filter(sourceId => !bySourceId.has(sourceId));
    const missingProjectIds = missingSourceIds.map(sourceId => (
        ZAGREB_SPLIT_PROJECT_IDS[ZAGREB_SPLIT_SOURCE_IDS.indexOf(sourceId)]
    ));
    const seams = [];
    for (let index = 0; index < ZAGREB_SPLIT_SOURCE_IDS.length - 1; index += 1) {
        const fromSourceId = ZAGREB_SPLIT_SOURCE_IDS[index];
        const toSourceId = ZAGREB_SPLIT_SOURCE_IDS[index + 1];
        const fromFeature = bySourceId.get(fromSourceId);
        const toFeature = bySourceId.get(toSourceId);
        const fromProjectId = featureProjectId(fromFeature);
        const toProjectId = featureProjectId(toFeature);
        const from = endpointForSplitToZagreb(fromFeature, 'end');
        const to = endpointForSplitToZagreb(toFeature, 'start');
        if (!from || !to) {
            seams.push({
                fromSourceId,
                toSourceId,
                fromProjectId,
                toProjectId,
                classification: 'missing',
            });
            continue;
        }
        const horizontalGapM = haversineMeters(
            Number(from[1]), Number(from[0]), Number(to[1]), Number(to[0]),
        );
        const fromZ = Number(from[2]);
        const toZ = Number(to[2]);
        const verticalGapM = Number.isFinite(fromZ) && Number.isFinite(toZ)
            ? Math.abs(toZ - fromZ)
            : Infinity;
        seams.push({
            fromSourceId,
            toSourceId,
            fromProjectId,
            toProjectId,
            horizontalGapM,
            verticalGapM,
            classification: seamClassification(horizontalGapM, verticalGapM),
        });
    }
    const blockedSeams = seams.filter(seam => (
        seam.classification === 'blocked' || seam.classification === 'missing'
    ));
    return {
        sourceIds: [...ZAGREB_SPLIT_SOURCE_IDS],
        projectIds: ZAGREB_SPLIT_SOURCE_IDS.map(sourceId => (
            featureProjectId(bySourceId.get(sourceId))
        )),
        missingSourceIds,
        missingProjectIds,
        seams,
        blockedSeams,
        continuous: missingProjectIds.length === 0 && blockedSeams.length === 0,
    };
}
