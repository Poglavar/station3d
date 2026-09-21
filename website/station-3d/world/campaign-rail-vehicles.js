// Renders bounded, stationary campaign rolling stock on the exact solved rail
// feature already owned by the session's rail formation.

import * as THREE from 'three';

import {
    campaignRailVehicleCenterStation,
    campaignRailVehicleCarStations,
    findCampaignRailVehicleFeature,
} from '../core/campaign-rail-vehicle.js';
import {
    offsetRailLineStringFeature,
    selectPhysicalTrackOffsetM,
} from '../core/rail-driving-track.js';
import {
    prepareAmbientTrainPath,
    sampleAmbientTrainPathPose,
} from '../core/ambient-train-path.js';
import { disposeGroup } from '../core/dispose.js';
import { registerEntityObject, unregisterEntityTree } from '../core/entity-interaction.js';
import { geoToLocal, localToGeo } from '../core/math.js';
import { scene } from '../scene/setup.js';
import {
    createHz7022Mesh,
    HZ_7022_CAR_COUNT,
    HZ_7022_CAR_SPACING_M,
    HZ_7022_HALF_LENGTH_M,
    HZ_7022_TOTAL_LENGTH_M,
} from '../models/vehicles/hz-7022.js';
import { getActiveRailTrafficSource } from './rails.js';
import { getTrackCenterOffsetsMeters } from './tram-trackbed-dimensions.js';

const MAX_CAMPAIGN_RAIL_VEHICLES = 4;
const OPEN_DOOR_SLIDE_M = 0.78;

let root = null;
const waitingVehicles = new Map();

function solvedFeaturePath(feature, specification, ctx) {
    const centerOffsetM = selectPhysicalTrackOffsetM(
        getTrackCenterOffsetsMeters(feature?.properties || {}),
        {
            initialEndpoint: specification.endpoint,
            runningSide: specification.runningSide || 'right',
        },
    );
    const physicalFeature = offsetRailLineStringFeature(feature, centerOffsetM);
    const coordinates = physicalFeature?.geometry?.coordinates || [];
    const points = [];
    let stationM = 0;
    let previous = null;
    for (const coordinate of coordinates) {
        const lon = Number(coordinate?.[0]);
        const lat = Number(coordinate?.[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const local = geoToLocal(lon, lat, ctx.anchorLon, ctx.anchorLat);
        if (previous) stationM += Math.hypot(local.x - previous.x, local.z - previous.z);
        previous = local;
        const formation = ctx.railFormation?.formationAtFeatureStation?.(feature, stationM);
        if (!Number.isFinite(formation?.railY)) continue;
        points.push({ x: local.x, z: local.z, railY: formation.railY });
    }
    return prepareAmbientTrainPath(points, {
        feature: physicalFeature,
        kind: 'campaign',
        minimumLengthM: HZ_7022_TOTAL_LENGTH_M + 2,
    });
}

function openTrainDoors(train) {
    for (const car of train.userData?.cars || []) {
        for (const part of car.userData?.doorParts || []) {
            part.mesh.position.z = part.closedZ + part.direction * OPEN_DOOR_SLIDE_M;
        }
    }
}

function createWaitingTrain(specification, path, ctx) {
    if (specification.model !== 'hz-7022') return null;
    const train = createHz7022Mesh({
        railY: 0,
        articulated: true,
        animatedDoors: specification.doorsOpen === true,
    });
    train.name = `CampaignRailVehicle:${specification.id}`;
    const direction = Number(specification.direction) < 0 ? -1 : 1;
    const stations = campaignRailVehicleCarStations({
        totalLengthM: path.totalLength,
        specification,
        carCount: HZ_7022_CAR_COUNT,
        carSpacingM: HZ_7022_CAR_SPACING_M,
        halfLengthM: HZ_7022_HALF_LENGTH_M,
    });
    for (let index = 0; index < train.userData.cars.length; index++) {
        const car = train.userData.cars[index];
        const pose = sampleAmbientTrainPathPose(path, stations[index], direction);
        if (!pose || !Number.isFinite(pose.railY)) {
            car.visible = false;
            continue;
        }
        car.position.set(pose.x, pose.railY, pose.z);
        car.rotation.order = 'YXZ';
        car.rotation.y = -pose.heading;
        car.rotation.x = pose.pitch;
    }
    if (specification.doorsOpen === true) openTrainDoors(train);
    train.traverse((part) => {
        if (!part?.isMesh) return;
        registerEntityObject(part, `campaign-rail-vehicle:${specification.id}`, {
            kind: 'campaign-rail-vehicle',
            railVehicleId: specification.id,
            label: specification.label || null,
        });
    });
    const centerStation = campaignRailVehicleCenterStation(
        path.totalLength,
        specification,
        HZ_7022_HALF_LENGTH_M,
    );
    const centerPose = sampleAmbientTrainPathPose(path, centerStation, direction);
    if (!centerPose) {
        unregisterEntityTree(train);
        disposeGroup(train);
        return null;
    }
    const centerGeo = localToGeo(
        centerPose.x,
        centerPose.z,
        ctx.anchorLon,
        ctx.anchorLat,
    );
    return {
        id: String(specification.id),
        mesh: train,
        pose: {
            lat: centerGeo.lat,
            lon: centerGeo.lon,
            headingDeg: ((centerPose.heading * 180 / Math.PI) % 360 + 360) % 360,
            y: Number(centerPose.railY) || 0,
            pitchDeg: Number(centerPose.pitch) * 180 / Math.PI || 0,
            status: { speedKmh: 0, doorsOpen: specification.doorsOpen === true },
        },
        doorRatio: specification.doorsOpen === true ? 1 : 0,
    };
}

// Transfers a parked authored train out of the scenery layer and into cab mode.
// No geometry or source data is rebuilt: the same mesh the player approached is
// normalized around its centre and becomes the third-person player vehicle.
export function campaignRailVehiclePose(vehicleId) {
    const record = waitingVehicles.get(String(vehicleId || '').trim());
    return record?.pose ? { ...record.pose, status: { ...record.pose.status } } : null;
}

export function claimCampaignRailVehicle(vehicleId) {
    const id = String(vehicleId || '').trim();
    const record = waitingVehicles.get(id);
    if (!record) return null;
    waitingVehicles.delete(id);
    unregisterEntityTree(record.mesh);
    record.mesh.removeFromParent();
    const cars = record.mesh.userData?.cars || [];
    for (let index = 0; index < cars.length; index++) {
        const car = cars[index];
        car.visible = true;
        car.position.set(0, 0, (index - (cars.length - 1) * 0.5) * HZ_7022_CAR_SPACING_M);
        car.rotation.order = 'YXZ';
        car.rotation.set(0, 0, 0);
    }
    record.mesh.userData.doorParts = cars.flatMap(car => (
        (car.userData?.doorParts || []).map(part => ({
            mesh: part.mesh,
            closedZ: part.closedZ,
            dir: part.direction,
        }))
    ));
    record.mesh.name = 'PlayerVehicle';
    record.mesh.position.set(0, 0, 0);
    record.mesh.rotation.set(0, 0, 0);
    record.mesh.visible = false;
    scene.add(record.mesh);
    return record;
}

export const campaignRailVehiclesLayer = {
    beginSession(ctx) {
        const specifications = ctx.campaignScene?.authored?.railVehicles || [];
        if (!ctx.railFormation || specifications.length === 0) return;
        waitingVehicles.clear();
        root = new THREE.Group();
        root.name = 'CampaignRailVehicles';
        // Rails may clone a solved authority while tagging its local context.
        // Use the renderer-owned collection so formationAtFeatureStation sees
        // the same feature identity stored in its WeakMap.
        const railFeatures = getActiveRailTrafficSource().features;
        for (const specification of specifications.slice(0, MAX_CAMPAIGN_RAIL_VEHICLES)) {
            const feature = findCampaignRailVehicleFeature(railFeatures, specification);
            const path = feature ? solvedFeaturePath(feature, specification, ctx) : null;
            const record = path ? createWaitingTrain(specification, path, ctx) : null;
            if (record) {
                waitingVehicles.set(record.id, record);
                root.add(record.mesh);
            }
        }
        if (root.children.length > 0) {
            scene.add(root);
            for (const record of waitingVehicles.values()) {
                ctx.onCampaignRailVehicleReady?.(record.id);
            }
        }
    },

    endSession() {
        if (root) {
            unregisterEntityTree(root);
            disposeGroup(root);
        }
        waitingVehicles.clear();
        root = null;
    },
};
