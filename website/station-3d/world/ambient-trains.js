import * as THREE from 'three';
import { geoToLocal } from '../core/math.js';
import { station3dAssetUrl } from '../core/asset-url.js';
import { disposeGroup } from '../core/dispose.js';
import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';
import {
    PROJECT_TRACK_SOURCES,
    ROAMING_TRACK_SOURCES,
    legacyTrainRailPoint,
    nearestPointOnAmbientTrainPath,
    offsetAmbientTrainPoseRight,
    prepareAmbientTrainPath,
    projectTrackRailPoint,
    sampleAmbientTrainPathPose,
    selectAmbientTrainTrackFeatures,
} from '../core/ambient-train-path.js';
import {
    ambientTrainDoorRatio,
    createAmbientTrainServiceState,
    stepAmbientTrainServiceState,
} from '../core/ambient-train-service.js';
import {
    createHz7022Mesh,
    getHz7022AppearanceDebug,
    HZ_7022_CAR_COUNT,
    HZ_7022_CAR_LENGTH_M,
    HZ_7022_CAR_SPACING_M,
    HZ_7022_TOTAL_LENGTH_M,
} from '../models/vehicles/hz-7022.js';
import { scene } from '../scene/setup.js';
import { terrainEvidenceSceneYAt } from './terrain.js';
import { ridingTrackCenterOffsetM } from '../core/planner-station-flare.js';
import { getStationTrackSpacingFlares } from './rails.js';

const TRAIN_CAR_COUNT = HZ_7022_CAR_COUNT;
// Vehicle meshes use a stable local rail datum. Project/reference paths shift
// this datum to their resolved railY; it is not a static network elevation.
const DECK_TOP_Y = 7.5;
const TRAIN_CAR_LENGTH_M = HZ_7022_CAR_LENGTH_M;
const TRAIN_CAR_SPACING_M = HZ_7022_CAR_SPACING_M;
const TRAIN_TOTAL_LENGTH_M = HZ_7022_TOTAL_LENGTH_M;
const TRAIN_SPEED_MIN_MPS = 23;
const TRAIN_SPEED_MAX_MPS = 31;
const TRAIN_SPAWN_MIN_S = 45;
const TRAIN_SPAWN_MAX_S = 75;
const TRAIN_INITIAL_DELAY_MIN_S = 12;
const TRAIN_INITIAL_DELAY_MAX_S = 24;
const TRAIN_RETRY_MIN_S = 12;
const TRAIN_RETRY_MAX_S = 20;
const TRAIN_PLAYER_RADIUS_M = 380;
const TRAIN_MIN_APPROACH_M = 110;
const TRAIN_SPAWN_DISTANCE_MIN_M = 180;
const TRAIN_SPAWN_DISTANCE_MAX_M = 320;
const TRAIN_LOOP_URL = station3dAssetUrl('audio/sfx/train/train-loop.mp3');
const TRAIN_HORN_URL = station3dAssetUrl('audio/sfx/train/train-horn.mp3');
const TRAIN_AUDIO_AUDIBLE_M = 420;
const TRAIN_AUDIO_REF_M = 18;
const TRAIN_LOOP_MAX_GAIN = 0.22;
const TRAIN_HORN_MAX_GAIN = 0.92;
const TRAIN_HORN_CHECK_INTERVAL_S = 30;
const TRAIN_HORN_CHANCE = 0.5;
const PROJECT_TRAIN_RENDER_RADIUS_M = 1100;
const PROJECT_TRAIN_INITIAL_POSITION_RATIOS = [0.18, 0.82];

let sessionGroup = null;
let preparedPaths = [];
let activeTrain = null;
let preparedProjectPaths = [];
let preparedProjectServices = [];
let activeProjectTrains = [];
let anchorLat = 0;
let anchorLon = 0;
let enabled = false;
let lastFrameS = 0;
let nextSpawnAtS = 0;
let trainAudioCtx = null;
let trainAudioLoadStarted = false;
let trainAudioUnlockCancel = null;
let servicePreparationDebug = {
    definitionCount: 0,
    projectPathCount: 0,
    servicePathCount: 0,
};
const trainAudioBuffers = {
    loop: null,
    horn: null,
};

function randRange(min, max) {
    return min + Math.random() * (max - min);
}

function nowSeconds() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function ensureTrainAudioCtx() {
    if (trainAudioCtx) return trainAudioCtx;
    trainAudioCtx = createUnlockedAudioContext();
    return trainAudioCtx;
}

function queueTrainAudioInit() {
    bindGlobalAudioUnlock();
    if (trainAudioUnlockCancel) return;
    trainAudioUnlockCancel = whenAudioUnlocked(() => {
        trainAudioUnlockCancel = null;
        startLoadingTrainAudio();
    });
}

function startLoadingTrainAudio() {
    if (trainAudioLoadStarted) return;
    const ctx = ensureTrainAudioCtx();
    if (!ctx) {
        queueTrainAudioInit();
        return;
    }
    trainAudioLoadStarted = true;
    [
        ['loop', TRAIN_LOOP_URL],
        ['horn', TRAIN_HORN_URL],
    ].forEach(([kind, url]) => {
        fetch(url)
            .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`train audio fetch ${r.status}`)))
            .then(ab => ctx.decodeAudioData(ab))
            .then(buffer => {
                trainAudioBuffers[kind] = buffer;
            })
            .catch(err => console.warn('[ambient-trains] train audio load failed:', url, err.message));
    });
}

function distanceAttenuation(distanceM) {
    if (!(distanceM >= 0) || distanceM >= TRAIN_AUDIO_AUDIBLE_M) return 0;
    const d = Math.max(TRAIN_AUDIO_REF_M, distanceM);
    const inv = (TRAIN_AUDIO_REF_M / d) * (TRAIN_AUDIO_REF_M / d);
    const fade = Math.max(0, 1 - distanceM / TRAIN_AUDIO_AUDIBLE_M);
    return inv * fade;
}

function ensureActiveTrainAudio(train, nowS) {
    if (!train) return;
    if (!train.audio) {
        train.audio = {
            loopSource: null,
            loopGain: null,
            hornSource: null,
            hornGain: null,
            nextHornCheckAtS: nowS + TRAIN_HORN_CHECK_INTERVAL_S,
            nextParamUpdateAtS: 0,
            loopGainTarget: null,
            loopRateTarget: null,
            hornGainTarget: null,
        };
    }
    const ctx = ensureTrainAudioCtx();
    if (!ctx) {
        queueTrainAudioInit();
        return;
    }
    startLoadingTrainAudio();
    resumeUnlockedAudioContext(ctx);
    if (!train.audio.loopSource && trainAudioBuffers.loop) {
        const src = ctx.createBufferSource();
        src.buffer = trainAudioBuffers.loop;
        src.loop = true;
        src.playbackRate.value = clamp(train.speedMps / 27, 0.9, 1.12);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain).connect(getAudioDestination(ctx));
        src.onended = () => {
            if (train.audio && train.audio.loopSource === src) train.audio.loopSource = null;
        };
        src.start(0, Math.random() * Math.max(0.01, src.buffer.duration));
        train.audio.loopSource = src;
        train.audio.loopGain = gain;
    }
}

function maybePlayTrainHorn(train) {
    if (!train || !train.audio || train.audio.hornSource || Math.random() >= TRAIN_HORN_CHANCE) return;
    const ctx = ensureTrainAudioCtx();
    if (!ctx || !trainAudioBuffers.horn) return;
    resumeUnlockedAudioContext(ctx);
    const src = ctx.createBufferSource();
    src.buffer = trainAudioBuffers.horn;
    src.playbackRate.value = clamp(0.97 + Math.random() * 0.06, 0.97, 1.03);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(getAudioDestination(ctx));
    src.onended = () => {
        if (train.audio && train.audio.hornSource === src) {
            train.audio.hornSource = null;
            if (train.audio.hornGain) {
                try { train.audio.hornGain.disconnect(); } catch (_) {}
                train.audio.hornGain = null;
            }
        }
    };
    src.start();
    train.audio.hornSource = src;
    train.audio.hornGain = gain;
}

function stopTrainAudio(train) {
    if (!train || !train.audio) return;
    if (train.audio.loopSource) {
        try { train.audio.loopSource.stop(); } catch (_) {}
        try { train.audio.loopSource.disconnect(); } catch (_) {}
        train.audio.loopSource = null;
    }
    if (train.audio.loopGain) {
        try { train.audio.loopGain.disconnect(); } catch (_) {}
        train.audio.loopGain = null;
    }
    if (train.audio.hornSource) {
        try { train.audio.hornSource.stop(); } catch (_) {}
        try { train.audio.hornSource.disconnect(); } catch (_) {}
        train.audio.hornSource = null;
    }
    if (train.audio.hornGain) {
        try { train.audio.hornGain.disconnect(); } catch (_) {}
        train.audio.hornGain = null;
    }
    train.audio.nextParamUpdateAtS = 0;
    train.audio.loopGainTarget = null;
    train.audio.loopRateTarget = null;
    train.audio.hornGainTarget = null;
}

function updateTrainAudio(train, observerX, observerZ, nowS) {
    if (!train || !Number.isFinite(observerX) || !Number.isFinite(observerZ)) return;
    const centerS = train.serviceState
        ? train.serviceState.positionM
        : train.headS - train.dir * (TRAIN_TOTAL_LENGTH_M * 0.5);
    const pose = trainPathPose(train, centerS);
    if (!pose) return;
    const distanceM = Math.hypot(observerX - pose.x, observerZ - pose.z);
    const attenuation = distanceAttenuation(distanceM);
    if (attenuation <= 0) {
        if (train.audio?.loopSource || train.audio?.hornSource) stopTrainAudio(train);
        return;
    }
    ensureActiveTrainAudio(train, nowS);
    if (!train.audio || nowS < train.audio.nextParamUpdateAtS) return;
    train.audio.nextParamUpdateAtS = nowS + 1 / 20;
    const loopGainTarget = attenuation * TRAIN_LOOP_MAX_GAIN;
    const loopRateTarget = clamp(train.speedMps / 27, 0.9, 1.12);
    if (train.audio.loopSource && train.audio.loopGain && trainAudioCtx) {
        if (train.audio.loopGainTarget == null
            || Math.abs(loopGainTarget - train.audio.loopGainTarget) >= 0.0001) {
            train.audio.loopGainTarget = loopGainTarget;
            train.audio.loopGain.gain.setTargetAtTime(loopGainTarget, trainAudioCtx.currentTime, 0.12);
        }
        if (train.audio.loopRateTarget == null
            || Math.abs(loopRateTarget - train.audio.loopRateTarget) >= 0.002) {
            train.audio.loopRateTarget = loopRateTarget;
            train.audio.loopSource.playbackRate.setTargetAtTime(loopRateTarget, trainAudioCtx.currentTime, 0.4);
        }
    }
    if (train.audio.hornGain && trainAudioCtx) {
        const hornGainTarget = attenuation * TRAIN_HORN_MAX_GAIN;
        if (train.audio.hornGainTarget == null
            || Math.abs(hornGainTarget - train.audio.hornGainTarget) >= 0.0001) {
            train.audio.hornGainTarget = hornGainTarget;
            train.audio.hornGain.gain.setTargetAtTime(hornGainTarget, trainAudioCtx.currentTime, 0.08);
        }
    }
    while (nowS >= train.audio.nextHornCheckAtS) {
        maybePlayTrainHorn(train);
        train.audio.nextHornCheckAtS += TRAIN_HORN_CHECK_INTERVAL_S;
    }
}

function buildTrainMesh() {
    return createHz7022Mesh({
        railY: DECK_TOP_Y,
        articulated: true,
        animatedDoors: true,
    });
}

function prepareLegacyPath(points) {
    const profiledPoints = points.map((point) => {
        // Legacy trains belong to THIS sampled legacy path. A global nearest
        // formation lookup is horizontally ambiguous at a grade-separated
        // crossing and can borrow the project viaduct above, making the train
        // jump onto it. yOff + DGU terrain is the visible legacy rail datum.
        if (Number.isFinite(point?.railY)) return point;
        const terrainY = terrainEvidenceSceneYAt(point.x, point.z);
        return terrainY === null
            ? null
            : legacyTrainRailPoint(point, terrainY, DECK_TOP_Y);
    });
    if (profiledPoints.some(point => point === null)) return null;
    return prepareAmbientTrainPath(profiledPoints, {
        kind: 'legacy',
        minimumLengthM: TRAIN_TOTAL_LENGTH_M + 120,
    });
}

function projectFeaturePoint(feature, coordinate, ctx) {
    const lon = Number(coordinate?.[0]);
    const lat = Number(coordinate?.[1]);
    const elevationM = Number(coordinate?.[2]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

    const properties = feature?.properties || {};
    if (properties.elevationDatum === 'asl') {
        const point = ctx?.photoTrackFrame?.toScene?.(
            lon,
            lat,
            Number.isFinite(elevationM) ? elevationM : 0,
        );
        return point
            && Number.isFinite(point.x)
            && Number.isFinite(point.y)
            && Number.isFinite(point.z)
            ? { x: point.x, z: point.z, railY: point.y }
            : null;
    }

    const local = geoToLocal(lon, lat, anchorLon, anchorLat);
    const formation = ctx?.railFormation?.formationAtLocal?.(local.x, local.z, {
        feature,
        maxDistanceM: Infinity,
    });
    const formationRailY = Number.isFinite(formation?.railY) ? formation.railY : null;
    return projectTrackRailPoint({
        x: local.x,
        z: local.z,
        elevationM,
        elevationMode: properties.elevationMode,
        formationRailY,
        terrainY: formationRailY === null
            ? terrainEvidenceSceneYAt(local.x, local.z)
            : null,
    });
}

function prepareProjectPaths(ctx, sources = PROJECT_TRACK_SOURCES) {
    const paths = [];
    for (const feature of selectAmbientTrainTrackFeatures(ctx?.otherTracks, sources)) {
        const properties = feature.properties || {};
        const points = (feature.geometry.coordinates || [])
            .map(coordinate => projectFeaturePoint(feature, coordinate, ctx));
        if (points.some(point => point === null)) continue;
        const path = prepareAmbientTrainPath(points, {
            kind: 'project',
            feature,
            // The cross-section the lateral offset is measured in. Read from the
            // feature, never assumed: a single-track route has ONE centre, and
            // hardcoding two would push its trains 1.7 m into the grass.
            trackProperties: properties,
            minimumLengthM: TRAIN_TOTAL_LENGTH_M + 120,
        });
        if (path) paths.push(path);
    }
    return paths;
}

function projectServiceFeature(definition) {
    const elevationDatum = definition?.elevationDatum;
    return {
        properties: {
            source: 'user-line',
            lineId: definition?.lineId,
            trackIds: definition?.trackIds || [],
            trackType: definition?.gauge || 'g1435',
            trackCount: 2,
            trackArrangement: 'side-by-side',
            ...(elevationDatum === 'asl'
                ? { elevationDatum: 'asl' }
                : elevationDatum === 'EVRF2000'
                    ? { elevationMode: 'absolute', elevationDatum: 'EVRF2000' }
                    : {}),
        },
    };
}

function copySamplePoint(pose) {
    if (!pose) return null;
    const point = { x: pose.x, z: pose.z };
    if (Number.isFinite(pose.railY)) point.railY = pose.railY;
    if (Number.isFinite(pose.yOff)) point.yOff = pose.yOff;
    return point;
}

function slicePreparedProjectPath(sourcePath, startS, endS, definition) {
    if (!sourcePath || !Number.isFinite(startS) || !Number.isFinite(endS)) return null;
    const ascending = endS >= startS;
    const lowS = Math.min(startS, endS);
    const highS = Math.max(startS, endS);
    const points = [copySamplePoint(sampleAmbientTrainPathPose(sourcePath, lowS, 1))];
    for (let index = 1; index < sourcePath.points.length - 1; index++) {
        const s = sourcePath.cumulative[index];
        if (s > lowS + 0.01 && s < highS - 0.01) points.push(sourcePath.points[index]);
    }
    points.push(copySamplePoint(sampleAmbientTrainPathPose(sourcePath, highS, 1)));
    const orderedPoints = ascending ? points : points.reverse();
    if (orderedPoints.some(point => point === null)) return null;
    return prepareAmbientTrainPath(orderedPoints, {
        kind: 'project',
        service: definition,
        trackProperties: sourcePath.trackProperties,
        minimumLengthM: TRAIN_TOTAL_LENGTH_M + 20,
    });
}

function projectServiceCoordinateXZ(coordinate, ctx) {
    const lon = Number(coordinate?.[0]);
    const lat = Number(coordinate?.[1]);
    const elevationM = Number(coordinate?.[2]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const photoPoint = ctx?.photoTrackFrame?.toScene?.(
        lon,
        lat,
        Number.isFinite(elevationM) ? elevationM : 0,
    );
    if (photoPoint && Number.isFinite(photoPoint.x) && Number.isFinite(photoPoint.z)) {
        return { x: photoPoint.x, z: photoPoint.z };
    }
    return geoToLocal(lon, lat, anchorLon, anchorLat);
}

function prepareProjectServicePath(definition, projectPaths, ctx) {
    const routeCoordinates = Array.isArray(definition?.routeCoordinates)
        ? definition.routeCoordinates
        : [];
    if (routeCoordinates.length < 2) return null;
    const feature = projectServiceFeature(definition);
    const trackIds = Array.isArray(definition.trackIds)
        ? definition.trackIds.map(String)
        : [];

    // The common case (including project 70) is one service on one physical
    // track. Reuse the already-projected rail path and crop it to the service
    // endpoints: no second formation query per route vertex and no duplicate
    // startup geometry work.
    if (trackIds.length === 1) {
        const sourcePath = projectPaths.find(path => (
            String(path.feature?.properties?.trackId) === trackIds[0]
        ));
        if (sourcePath) {
            const first = projectServiceCoordinateXZ(routeCoordinates[0], ctx);
            const last = projectServiceCoordinateXZ(
                routeCoordinates[routeCoordinates.length - 1],
                ctx,
            );
            const start = first
                ? nearestPointOnAmbientTrainPath(sourcePath, first.x, first.z)
                : null;
            const end = last
                ? nearestPointOnAmbientTrainPath(sourcePath, last.x, last.z)
                : null;
            const sliced = slicePreparedProjectPath(sourcePath, start?.s, end?.s, definition);
            if (sliced) return sliced;
        }
    }

    // Multi-track services already carry the planner's exact stitched route.
    // Project that route once; unlike the old random trains this path persists
    // for the full walk session and is not rebuilt around the observer.
    const points = routeCoordinates
        .map(coordinate => projectFeaturePoint(feature, coordinate, ctx));
    if (points.some(point => point === null)) return null;
    return prepareAmbientTrainPath(points, {
        kind: 'project',
        service: definition,
        trackProperties: feature.properties,
        minimumLengthM: TRAIN_TOTAL_LENGTH_M + 20,
    });
}

function prepareProjectServices(ctx, projectPaths) {
    const definitions = Array.isArray(ctx?.ambientTrainServices)
        ? ctx.ambientTrainServices
        : [];
    const services = [];
    for (const definition of definitions) {
        const path = prepareProjectServicePath(definition, projectPaths, ctx);
        if (!path) continue;
        path.serviceStops = (definition.stationStops || [])
            .map(stop => ({
                ...stop,
                positionM: clamp(Number(stop.positionRatio) || 0, 0, 1) * path.totalLength,
            }))
            .sort((a, b) => a.positionM - b.positionM);
        services.push(path);
    }
    return services;
}

function trainPathPose(train, s) {
    const pose = sampleAmbientTrainPathPose(train.path, s, train.dir);
    if (train.kind !== 'project') return pose;
    if (!pose) return pose;
    // Take the lateral offset from the SAME policy, and the same station list,
    // that placed the rails (rails.js publishes what it actually splayed). This
    // used to be re-derived here from the service's own stops, which cannot know
    // whether a station got a rigid island hall — and got it wrong by 4.9 m at
    // every surface platform, and again at every route-following covered one.
    // The route's OWN cross-section, so a single-track line keeps its one centre.
    const properties = train.path.trackProperties;
    if (!properties) return pose;
    return offsetAmbientTrainPoseRight(pose, ridingTrackCenterOffsetM(
        properties,
        pose.x,
        pose.z,
        getStationTrackSpacingFlares(),
    ));
}

function setNextSpawn(delayMin, delayMax) {
    nextSpawnAtS = nowSeconds() + randRange(delayMin, delayMax);
}

function removeTrain(train) {
    if (!train) return;
    stopTrainAudio(train);
    if (train.mesh && train.mesh.parent) train.mesh.parent.remove(train.mesh);
    if (train.mesh) disposeGroup(train.mesh);
    train.mesh = null;
}

function removeActiveTrain() {
    removeTrain(activeTrain);
    activeTrain = null;
}

function removeProjectTrains() {
    for (const train of activeProjectTrains) removeTrain(train);
    activeProjectTrains = [];
}

function trainHasClearedPath(train) {
    const tailCenterS = train.headS - train.dir
        * ((TRAIN_CAR_COUNT - 1) * TRAIN_CAR_SPACING_M + TRAIN_CAR_LENGTH_M * 0.5);
    const tailMarginM = 80;
    return (train.dir > 0 && tailCenterS > train.path.totalLength + tailMarginM)
        || (train.dir < 0 && tailCenterS < -tailMarginM);
}

function updateTrain(train, dt) {
    if (!train) return false;
    const travelM = train.speedMps * dt;
    const nextHeadS = train.headS + train.dir * travelM;
    const cars = train.mesh.userData.cars || [];
    const nextCarPoses = [];
    for (let i = 0; i < cars.length; i++) {
        const centerS = nextHeadS - train.dir
            * (i * TRAIN_CAR_SPACING_M + TRAIN_CAR_LENGTH_M * 0.5);
        // Path sampling extrapolates beyond the path's [0, totalLength]
        // bounds along the first/last segment direction. That keeps the
        // train rigid as it crosses path-segment endpoints (rail junctions,
        // stations) instead of cars popping invisible one-by-one. The
        // whole train is removed below once the tail has fully cleared.
        const pose = trainPathPose(train, centerS);
        if (!pose) {
            for (const car of cars) car.visible = false;
            return true;
        }
        const hasProfiledRailY = Number.isFinite(pose.railY);
        const terrainY = hasProfiledRailY
            ? null
            : terrainEvidenceSceneYAt(pose.x, pose.z);
        if (!hasProfiledRailY && terrainY === null) {
            for (const car of cars) car.visible = false;
            return true;
        }
        const carY = hasProfiledRailY
            // The legacy mesh is authored around DECK_TOP_Y. Shift that datum
            // onto the actual authored rail surface (project or legacy).
            ? pose.railY - DECK_TOP_Y
            // yOff is the elevated-rail deck ramp; add DGU terrain (0 when flat)
            // so the train rides the viaduct wherever the deck sits on terrain.
            : (pose.yOff || 0) + terrainY;
        nextCarPoses.push({ pose, carY, hasProfiledRailY });
    }
    train.headS = nextHeadS;
    train.travelledM += travelM;
    for (let i = 0; i < cars.length; i++) {
        const { pose, carY, hasProfiledRailY } = nextCarPoses[i];
        cars[i].visible = true;
        cars[i].position.set(pose.x, carY, pose.z);
        cars[i].rotation.order = 'YXZ';
        cars[i].rotation.y = -pose.heading;
        cars[i].rotation.x = hasProfiledRailY ? pose.pitch : 0;
    }
    return !trainHasClearedPath(train);
}

function updateActiveTrain(dt) {
    if (activeTrain && !updateTrain(activeTrain, dt)) {
        removeActiveTrain();
    }
}

function updateProjectTrains(dt, observerLocal, nowS) {
    for (let index = activeProjectTrains.length - 1; index >= 0; index--) {
        const train = activeProjectTrains[index];
        if (!updateProjectServiceTrain(train, dt, observerLocal, nowS)) {
            removeTrain(train);
            activeProjectTrains.splice(index, 1);
        }
    }
}

function ensureProjectTrainMesh(train) {
    if (train.mesh || !sessionGroup) return train.mesh;
    train.mesh = buildTrainMesh();
    train.mesh.name = `ProjectServiceTrain:${train.path.service?.lineId ?? 'line'}:${train.serviceIndex}`;
    sessionGroup.add(train.mesh);
    return train.mesh;
}

function positionProjectServiceCars(train) {
    const cars = train.mesh?.userData?.cars || [];
    const service = train.serviceState;
    for (let index = 0; index < cars.length; index++) {
        const centerS = service.positionM + service.direction
            * ((TRAIN_CAR_COUNT - 1) * 0.5 - index)
            * TRAIN_CAR_SPACING_M;
        const pose = trainPathPose(train, centerS);
        if (!pose) {
            cars[index].visible = false;
            continue;
        }
        cars[index].visible = true;
        cars[index].position.set(pose.x, pose.railY - DECK_TOP_Y, pose.z);
        cars[index].rotation.order = 'YXZ';
        cars[index].rotation.y = -pose.heading;
        cars[index].rotation.x = pose.pitch;
    }
}

const AMBIENT_TRAIN_DOOR_SLIDE_M = 0.56;
function setProjectServiceDoors(train, ratio) {
    const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
    for (const car of train.mesh?.userData?.cars || []) {
        for (const part of car.userData?.doorParts || []) {
            part.mesh.position.z = part.closedZ
                + part.direction * AMBIENT_TRAIN_DOOR_SLIDE_M * clamped;
        }
    }
}

function updateProjectServiceTrain(train, dt, observerLocal, nowS) {
    if (!train?.serviceState) return false;
    stepAmbientTrainServiceState(train.serviceState, dt);
    train.dir = train.serviceState.direction;
    train.speedMps = train.serviceState.speedMps;
    const centerPose = trainPathPose(train, train.serviceState.positionM);
    if (!centerPose) return false;

    const observerDistanceM = observerLocal
        ? Math.hypot(observerLocal.x - centerPose.x, observerLocal.z - centerPose.z)
        : Infinity;
    if (observerDistanceM > PROJECT_TRAIN_RENDER_RADIUS_M) {
        if (train.mesh) train.mesh.visible = false;
        if (train.audio?.loopSource || train.audio?.hornSource) stopTrainAudio(train);
        return true;
    }

    const mesh = ensureProjectTrainMesh(train);
    if (!mesh) return true;
    mesh.visible = true;
    positionProjectServiceCars(train);
    setProjectServiceDoors(train, ambientTrainDoorRatio(train.serviceState));
    if (observerLocal) {
        updateTrainAudio(train, observerLocal.x, observerLocal.z, nowS);
    }
    return true;
}

function collectSpawnCandidates(paths, local) {
    if (!local) return [];
    const candidates = [];
    for (const path of paths) {
        const nearest = nearestPointOnAmbientTrainPath(path, local.x, local.z);
        if (!nearest || nearest.distanceM > TRAIN_PLAYER_RADIUS_M) continue;
        const before = nearest.s;
        const after = path.totalLength - nearest.s;
        const canForward = before >= TRAIN_MIN_APPROACH_M;
        const canBackward = after >= TRAIN_MIN_APPROACH_M;
        if (!canForward && !canBackward) continue;
        candidates.push({ path, nearest, before, after, canForward, canBackward });
    }
    candidates.sort((a, b) => a.nearest.distanceM - b.nearest.distanceM);
    return candidates.slice(0, Math.min(6, candidates.length));
}

function randomCandidate(candidates) {
    return candidates[(Math.random() * candidates.length) | 0];
}

function createTrain(path, dir, headS, speedMps, kind = path.kind) {
    const mesh = buildTrainMesh();
    sessionGroup.add(mesh);
    const train = {
        mesh,
        path,
        kind,
        dir,
        speedMps,
        headS,
        travelledM: 0,
        audio: null,
    };
    updateTrain(train, 0);
    return train;
}

function legacySpawnDistance(available) {
    return Math.min(
        TRAIN_SPAWN_DISTANCE_MAX_M,
        Math.max(TRAIN_SPAWN_DISTANCE_MIN_M, available * (0.55 + Math.random() * 0.15)),
    );
}

function trySpawnTrain(local) {
    if (!local || preparedPaths.length === 0 || !sessionGroup) return false;
    const candidates = collectSpawnCandidates(preparedPaths, local);
    if (candidates.length === 0) return false;
    const choice = randomCandidate(candidates);
    let dir = 1;
    if (choice.canForward && choice.canBackward) dir = Math.random() < 0.5 ? 1 : -1;
    else dir = choice.canForward ? 1 : -1;

    const available = dir > 0 ? choice.before : choice.after;
    const spawnDistance = legacySpawnDistance(available);
    if (spawnDistance < TRAIN_MIN_APPROACH_M) return false;

    activeTrain = createTrain(
        choice.path,
        dir,
        dir > 0 ? choice.nearest.s - spawnDistance : choice.nearest.s + spawnDistance,
        randRange(TRAIN_SPEED_MIN_MPS, TRAIN_SPEED_MAX_MPS),
    );
    return true;
}

function createProjectServiceTrains(path) {
    const definition = path.service || {};
    const cruiseSpeedMps = Number(definition.cruiseSpeedMps) || 70 / 3.6;
    return PROJECT_TRAIN_INITIAL_POSITION_RATIOS.map((positionRatio, serviceIndex) => {
        const direction = serviceIndex === 0 ? 1 : -1;
        const serviceState = createAmbientTrainServiceState({
            totalLengthM: path.totalLength,
            stops: path.serviceStops,
            direction,
            initialPositionM: positionRatio * path.totalLength,
            initialSpeedMps: cruiseSpeedMps * 0.8,
            cruiseSpeedMps,
            dwellSeconds: Number(definition.dwellSeconds) || 10,
        });
        return {
            mesh: null,
            path,
            kind: 'project',
            dir: direction,
            speedMps: serviceState.speedMps,
            serviceState,
            serviceIndex,
            audio: null,
        };
    });
}

export const ambientTrainsLayer = {
    beginSession(ctx) {
        enabled = !!(ctx && typeof ctx.isWalkMode === 'function' && ctx.isWalkMode());
        preparedPaths = [];
        activeTrain = null;
        preparedProjectPaths = [];
        preparedProjectServices = [];
        activeProjectTrains = [];
        lastFrameS = 0;
        anchorLat = ctx && ctx.anchorLat || 0;
        anchorLon = ctx && ctx.anchorLon || 0;
        if (!enabled) return;
        preparedProjectPaths = prepareProjectPaths(ctx);
        preparedProjectServices = prepareProjectServices(ctx, preparedProjectPaths);
        // Proposal alignments ride the roaming spawner: kind 'project' keeps the
        // formation-profiled railY (the bay bridge deck) and the per-direction
        // track-centre offset, so double track runs right-handed by itself.
        preparedPaths = prepareProjectPaths(ctx, ROAMING_TRACK_SOURCES);
        servicePreparationDebug = {
            definitionCount: Array.isArray(ctx?.ambientTrainServices)
                ? ctx.ambientTrainServices.length
                : 0,
            projectPathCount: preparedProjectPaths.length,
            servicePathCount: preparedProjectServices.length,
            definitions: (ctx?.ambientTrainServices || []).map(definition => ({
                lineId: definition?.lineId ?? null,
                trackIds: definition?.trackIds || [],
                routeCoordinateCount: definition?.routeCoordinates?.length || 0,
                elevationDatum: definition?.elevationDatum || null,
            })),
            projectPaths: preparedProjectPaths.map(path => ({
                trackId: path.feature?.properties?.trackId ?? null,
                pointCount: path.points.length,
                totalLengthM: path.totalLength,
            })),
            roamingPathCount: preparedPaths.length,
            roamingPaths: preparedPaths.map(path => ({
                proposalId: path.feature?.properties?.proposalId ?? null,
                trackCount: path.feature?.properties?.trackCount ?? null,
                pointCount: path.points.length,
                totalLengthM: path.totalLength,
            })),
        };
        activeProjectTrains = preparedProjectServices.flatMap(createProjectServiceTrains);
        sessionGroup = new THREE.Group();
        sessionGroup.name = 'AmbientTrains';
        scene.add(sessionGroup);
        setNextSpawn(TRAIN_INITIAL_DELAY_MIN_S, TRAIN_INITIAL_DELAY_MAX_S);
    },
    onFrame(pose, local) {
        if (!enabled || !sessionGroup) return;
        const nowS = nowSeconds();
        const dt = lastFrameS ? Math.min(0.1, nowS - lastFrameS) : 0;
        lastFrameS = nowS;
        const observerLocal = Number.isFinite(local?.x) && Number.isFinite(local?.z)
            ? local
            : pose
                ? geoToLocal(pose.lon, pose.lat, anchorLon, anchorLat)
                : null;
        if (activeTrain) {
            updateActiveTrain(dt);
            if (observerLocal) updateTrainAudio(activeTrain, observerLocal.x, observerLocal.z, nowS);
        } else if (preparedPaths.length > 0 && nowS >= nextSpawnAtS) {
            if (trySpawnTrain(observerLocal)) setNextSpawn(TRAIN_SPAWN_MIN_S, TRAIN_SPAWN_MAX_S);
            else setNextSpawn(TRAIN_RETRY_MIN_S, TRAIN_RETRY_MAX_S);
        }
        updateProjectTrains(dt, observerLocal, nowS);
    },
    endSession() {
        removeActiveTrain();
        removeProjectTrains();
        preparedPaths = [];
        preparedProjectPaths = [];
        preparedProjectServices = [];
        enabled = false;
        lastFrameS = 0;
        if (sessionGroup) {
            disposeGroup(sessionGroup);
            sessionGroup = null;
        }
    },
};

export function getAmbientTrainAppearanceDebug() {
    return getHz7022AppearanceDebug();
}

export function getAmbientTrainServiceDebug() {
    return activeProjectTrains.map(train => ({
        lineId: train.path?.service?.lineId ?? null,
        direction: train.serviceState?.direction ?? train.dir,
        positionM: train.serviceState?.positionM ?? null,
        speedMps: train.serviceState?.speedMps ?? train.speedMps,
        phase: train.serviceState?.phase ?? null,
        dwellRemainingS: train.serviceState?.dwellRemainingS ?? 0,
        meshVisible: !!train.mesh?.visible,
        totalLengthM: train.path?.totalLength ?? null,
        stops: (train.serviceState?.stops || []).map(stop => ({
            stopId: stop.stopId ?? null,
            name: stop.name || '',
            positionM: stop.positionM,
        })),
    }));
}

export function getAmbientTrainServicePreparationDebug() {
    return { ...servicePreparationDebug };
}
