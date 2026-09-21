// Opens a catalogued localhost development scenario through the production
// Station3D entry points, publishing a small inspection snapshot for devtools.

import {
    boatCheckpointBoardingDistanceM,
    referenceGeometryUrl,
    trainCheckpointGeometry,
} from '../core/campaign-transport-spikes.js';
import {
    offsetRailLineStringFeature,
    selectPhysicalTrackOffsetM,
} from '../core/rail-driving-track.js';
import { scenarioRequest } from '../core/scenario-catalog.js';
import { smoothRailTrackFeatures } from '../world/rail-track-smoothing.js';
import { getTrackCenterOffsetsMeters } from '../world/tram-trackbed-dimensions.js';

function publishState(next) {
    window.__station3DScenario = Object.freeze({
        updatedAt: new Date().toISOString(),
        ...next,
    });
    return window.__station3DScenario;
}

function collectionForFeature(feature) {
    return { type: 'FeatureCollection', features: [feature] };
}

function solvedWorldFeatures(collection, station3D) {
    const referenceApi = window.__railReferenceProjects;
    if (typeof referenceApi?.referenceFeatures !== 'function') {
        throw new Error('Reference-rail transformer is unavailable.');
    }
    if (station3D.isModelTerrainActive?.() !== true) {
        throw new Error('The heavy-rail scenario requires the model terrain world.');
    }
    return referenceApi.referenceFeatures(collection, {
        modelTerrainActive: true,
        solvedOnly: true,
    });
}

function elevationRange(feature) {
    const elevations = (feature?.geometry?.coordinates || [])
        .map(coordinate => Number(coordinate?.[2]))
        .filter(Number.isFinite);
    if (elevations.length === 0) return null;
    let minM = Infinity;
    let maxM = -Infinity;
    for (const elevation of elevations) {
        if (elevation < minM) minM = elevation;
        if (elevation > maxM) maxM = elevation;
    }
    return { minM, maxM };
}

function openBoatScenario(station3D, request) {
    const checkpoint = request.checkpoint;
    const opened = station3D.openGta(checkpoint.player.lat, checkpoint.player.lon, {
        initialHeadingDeg: checkpoint.player.headingDeg,
        titleOverride: checkpoint.title,
        boatSpawnAnchors: [checkpoint.boat],
    });
    if (!opened) throw new Error('Station3D rejected the boat scenario.');
    return publishState({
        status: 'ready',
        scenarioId: request.scenarioId,
        checkpointId: checkpoint.id,
        kind: request.kind,
        vehicleId: `gta-boat:${checkpoint.boat.id}`,
        boardingDistanceM: boatCheckpointBoardingDistanceM(checkpoint),
        player: checkpoint.player,
        boat: checkpoint.boat,
    });
}

async function openTrainScenario(station3D, apiBase, request, fetchImpl) {
    const checkpoint = request.checkpoint;
    const url = referenceGeometryUrl(apiBase, checkpoint);
    if (!url) throw new Error('The reference-rail URL could not be built.');
    publishState({
        status: 'fetching',
        scenarioId: request.scenarioId,
        checkpointId: checkpoint.id,
        kind: request.kind,
        projectId: checkpoint.projectId,
        url,
    });
    const response = await fetchImpl(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Reference rail request failed (${response.status}).`);
    const collection = await response.json();
    const geometry = trainCheckpointGeometry(collection, checkpoint);
    if (!geometry) {
        throw new Error(`Project ${checkpoint.projectId} is absent from the bounded response.`);
    }
    const renderTracks = smoothRailTrackFeatures(
        solvedWorldFeatures(
            collectionForFeature(geometry.feature),
            station3D,
        ),
    );
    if (renderTracks.length !== 1) {
        throw new Error('The exact rail feature did not survive solved-profile conversion.');
    }
    const centerOffsetM = selectPhysicalTrackOffsetM(
        getTrackCenterOffsetsMeters(renderTracks[0].properties || {}),
        {
            initialEndpoint: checkpoint.initialEndpoint,
            runningSide: checkpoint.runningSide || 'right',
        },
    );
    const driverTrack = offsetRailLineStringFeature(renderTracks[0], centerOffsetM);
    if (!driverTrack) throw new Error('The physical rail driving track is unavailable.');
    const physicalGeometry = trainCheckpointGeometry(
        collectionForFeature(driverTrack),
        checkpoint,
    );
    if (!physicalGeometry) throw new Error('The physical rail start pose is unavailable.');
    const driverTracks = [driverTrack];
    const staticPose = { ...physicalGeometry.initialPose };
    const opened = station3D.openCab(
        null,
        { id: checkpoint.ref, number: checkpoint.ref },
        () => ({ ...staticPose, status: { ...staticPose.status } }),
        {
            titleOverride: checkpoint.title,
            routeDirectionLabel: checkpoint.routeDirectionLabel,
            isTrainSession: true,
            trackGaugeMm: 1435,
            trackBaseY: 0,
            suppressTrackClangs: true,
            railProfileMode: 'solved',
            driverTracks,
            otherTracks: renderTracks,
            allStops: checkpoint.station ? [checkpoint.station] : [],
            tracksAlreadySmoothed: true,
        },
    );
    if (!opened) throw new Error('Station3D rejected the heavy-rail scenario.');
    return publishState({
        status: 'ready',
        scenarioId: request.scenarioId,
        checkpointId: checkpoint.id,
        kind: request.kind,
        projectId: checkpoint.projectId,
        nodeCount: geometry.nodeCount,
        elevationRange: elevationRange(renderTracks[0]),
        initialPose: staticPose,
        station: checkpoint.station || null,
        tracksAlreadySmoothed: true,
    });
}

export async function openScenario({
    station3D = window.Station3D,
    apiBase = window.__ZAGREB_RUNTIME_CONFIG__?.zagrebApiBaseUrl,
    search = window.location.search,
    hostname = window.location.hostname,
    fetchImpl = globalThis.fetch,
    replaceSearch = (nextSearch) => {
        const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash || ''}`;
        window.history.replaceState(window.history.state, '', nextUrl);
    },
} = {}) {
    const request = scenarioRequest(search, hostname);
    if (!request.ok) {
        const error = new Error(`Station3D scenario refused: ${request.reason}.`);
        publishState({ status: 'error', reason: request.reason, message: error.message });
        throw error;
    }
    if (!station3D) throw new Error('Station3D is unavailable.');
    if (request.worldSearchChanged) replaceSearch(request.canonicalSearch);
    publishState({
        status: 'opening',
        scenarioId: request.scenarioId,
        checkpointId: request.checkpointId,
        kind: request.kind,
    });
    try {
        return request.kind === 'boat'
            ? openBoatScenario(station3D, request)
            : await openTrainScenario(station3D, apiBase, request, fetchImpl);
    } catch (error) {
        publishState({
            status: 'error',
            scenarioId: request.scenarioId,
            checkpointId: request.checkpointId,
            kind: request.kind,
            message: error?.message || String(error),
        });
        throw error;
    }
}
