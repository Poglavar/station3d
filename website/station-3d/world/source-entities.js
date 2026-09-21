// Builds invisible low-cost pick proxies for imported objects not owned by roads/buildings.

import * as THREE from 'three';
import { getApiBase } from '../core/api.js';
import { disposeGroup, registerShared } from '../core/dispose.js';
import {
    registerEntityObject,
    unregisterEntityTree,
} from '../core/entity-interaction.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, geoToLocal, haversineMeters } from '../core/math.js';
import {
    alignedDecorTiles,
    DECOR_KINDS,
    dedupeEntityRecords,
    normalizeDecorPayload,
    normalizeStops,
    normalizeTrackCollection,
    normalizeWaterCollection,
} from '../core/source-entity-data.js';
import { scene } from '../scene/setup.js';

const PICK_RADIUS_M = 260;
const REFRESH_DISTANCE_M = 140;
const POINT_PROXY_GEOMETRY = new THREE.SphereGeometry(1, 8, 6);
const PICK_MATERIAL = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
    side: THREE.DoubleSide,
});
registerShared(POINT_PROXY_GEOMETRY, PICK_MATERIAL);

let group = null;
let fetchController = null;
let sessionFetchController = null;
let networkRequestScheduler = null;
let requestId = 0;
let anchorLat = 0;
let anchorLon = 0;
let terrainReference = null;
let terrainUnsubscribe = null;
let inspectionEnabled = false;
let lastLat = null;
let lastLon = null;
let sessionTracks = [];
let sessionStops = [];

function radiusBounds(lat, lon, radiusM) {
    const dLat = radiusM / (DEG_TO_RAD * EARTH_RADIUS_M);
    const dLon = dLat / Math.max(0.01, Math.cos(lat * DEG_TO_RAD));
    return {
        west: lon - dLon,
        south: lat - dLat,
        east: lon + dLon,
        north: lat + dLat,
    };
}

function visitCoordinates(value, visitor) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
        visitor(Number(value[0]), Number(value[1]));
        return;
    }
    for (const child of value) visitCoordinates(child, visitor);
}

function geometryTouchesRadius(geometry, lat, lon, radiusM) {
    let closest = Infinity;
    visitCoordinates(geometry?.coordinates, (candidateLon, candidateLat) => {
        closest = Math.min(closest, haversineMeters(lat, lon, candidateLat, candidateLon));
    });
    return closest <= radiusM;
}

function sceneY(localX, localZ, offset = 0.08) {
    if (!terrainReference) return offset;
    const terrainY = terrainReference.evidenceSceneYAtLocal?.(localX, localZ);
    return typeof terrainY === 'number' && Number.isFinite(terrainY)
        ? terrainY + offset
        : null;
}

function pointProxy(record) {
    const coordinates = record.geometry?.coordinates;
    const lon = Number(coordinates?.[0]);
    const lat = Number(coordinates?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [];
    const local = geoToLocal(lon, lat, anchorLon, anchorLat);
    const height = record.metadata.entityType === 'tree'
        ? Math.max(5, Number(record.metadata.heightMeters) || 9)
        : record.metadata.entityType === 'fountain'
            ? Math.max(1.2, Number(record.metadata.radiusMeters) || 1.6)
            : 1.2;
    const radius = record.metadata.entityType === 'tree'
        ? Math.max(1.1, height * 0.18)
        : record.metadata.entityType === 'fountain'
            ? Math.max(0.9, Number(record.metadata.radiusMeters) || 1.6)
            : 0.85;
    const y = sceneY(local.x, local.z, height * 0.5);
    if (y === null) return [];
    const mesh = new THREE.Mesh(POINT_PROXY_GEOMETRY, PICK_MATERIAL);
    mesh.name = `SourceEntityPick:${record.metadata.entityType}`;
    mesh.position.set(local.x, y, local.z);
    mesh.scale.set(radius, height * 0.5, radius);
    return [mesh];
}

function lineProxy(record) {
    const coordinates = record.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
    const width = Math.max(
        0.7,
        Number(record.metadata.widthMeters)
            || (record.metadata.entityType === 'hedge' ? 0.9 : 1.5),
    );
    const positions = [];
    for (let index = 0; index + 1 < coordinates.length; index++) {
        const a = geoToLocal(
            Number(coordinates[index][0]),
            Number(coordinates[index][1]),
            anchorLon,
            anchorLat,
        );
        const b = geoToLocal(
            Number(coordinates[index + 1][0]),
            Number(coordinates[index + 1][1]),
            anchorLon,
            anchorLat,
        );
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (!(length > 0.05)) continue;
        const nx = -dz / length * width * 0.5;
        const nz = dx / length * width * 0.5;
        const ay = sceneY(a.x, a.z);
        const by = sceneY(b.x, b.z);
        if (ay === null || by === null) return [];
        positions.push(
            a.x + nx, ay, a.z + nz,
            b.x + nx, by, b.z + nz,
            b.x - nx, by, b.z - nz,
            a.x + nx, ay, a.z + nz,
            b.x - nx, by, b.z - nz,
            a.x - nx, ay, a.z - nz,
        );
    }
    if (positions.length === 0) return [];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, PICK_MATERIAL);
    mesh.name = `SourceEntityPick:${record.metadata.entityType}`;
    return [mesh];
}

function polygonProxyMeshes(record) {
    const geometry = record.geometry;
    const polygons = geometry?.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon'
            ? geometry.coordinates
            : [];
    const meshes = [];
    for (const rings of polygons) {
        if (!Array.isArray(rings) || rings[0]?.length < 3) continue;
        const localRings = rings.map((ring) => ring.map(([lon, lat]) =>
            geoToLocal(Number(lon), Number(lat), anchorLon, anchorLat)));
        const shape = new THREE.Shape();
        localRings[0].forEach((point, index) => {
            if (index === 0) shape.moveTo(point.x, point.z);
            else shape.lineTo(point.x, point.z);
        });
        for (const ring of localRings.slice(1)) {
            const hole = new THREE.Path();
            ring.forEach((point, index) => {
                if (index === 0) hole.moveTo(point.x, point.z);
                else hole.lineTo(point.x, point.z);
            });
            shape.holes.push(hole);
        }
        const proxyGeometry = new THREE.ShapeGeometry(shape);
        const positions = proxyGeometry.getAttribute('position');
        let terrainReady = true;
        for (let index = 0; index < positions.count; index++) {
            const x = positions.getX(index);
            const z = positions.getY(index);
            const y = sceneY(x, z, 0.006);
            if (y === null) {
                terrainReady = false;
                break;
            }
            positions.setXYZ(index, x, y, z);
        }
        if (!terrainReady) {
            proxyGeometry.dispose();
            continue;
        }
        positions.needsUpdate = true;
        proxyGeometry.computeVertexNormals();
        proxyGeometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(proxyGeometry, PICK_MATERIAL);
        mesh.name = `SourceEntityPick:${record.metadata.entityType}`;
        meshes.push(mesh);
    }
    return meshes;
}

function proxyMeshes(record) {
    const type = record.geometry?.type;
    if (type === 'Point') return pointProxy(record);
    if (type === 'LineString') return lineProxy(record);
    if (type === 'Polygon' || type === 'MultiPolygon') return polygonProxyMeshes(record);
    return [];
}

function clearGroup() {
    if (!group) return;
    unregisterEntityTree(group);
    disposeGroup(group);
    group = null;
}

function publishRecords(records, currentRequestId) {
    if (currentRequestId !== requestId || !inspectionEnabled) return;
    const nextGroup = new THREE.Group();
    nextGroup.name = 'SourceEntityPickProxies';
    for (const record of records) {
        for (const mesh of proxyMeshes(record)) {
            registerEntityObject(mesh, record.key, record.metadata);
            nextGroup.add(mesh);
        }
    }
    if (currentRequestId !== requestId || !inspectionEnabled) {
        unregisterEntityTree(nextGroup);
        disposeGroup(nextGroup);
        return;
    }
    clearGroup();
    group = nextGroup;
    scene.add(group);
}

async function fetchJson(url, signal) {
    const run = async () => {
        // Default cache mode: the API stamps world data with a day of
        // Cache-Control, so a repeat visit revalidates instead of re-querying.
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`${response.status} ${url}`);
        return response.json();
    };
    return typeof networkRequestScheduler?.scheduleNetworkRequest === 'function'
        ? await networkRequestScheduler.scheduleNetworkRequest({
            label: `source-entities:${new URL(url, 'http://station3d.local').pathname}`,
            groupKey: 'source-entities',
            groupLimit: 2,
            priority: { tier: 'support', score: 4e12 },
            signal,
            run,
        })
        : await run();
}

async function fetchRecords(lat, lon, signal) {
    const bounds = radiusBounds(lat, lon, PICK_RADIUS_M);
    const tiles = alignedDecorTiles(bounds);
    const requests = [];
    const bbox = [bounds.west, bounds.south, bounds.east, bounds.north].join(',');
    for (const kind of DECOR_KINDS.filter((value) => value !== 'greenery')) {
        const url = `${getApiBase()}/decor?kind=${encodeURIComponent(kind)}`
            + `&bbox=${encodeURIComponent(bbox)}`;
        requests.push(
            fetchJson(url, signal)
                .then((payload) => normalizeDecorPayload(kind, payload)),
        );
    }
    for (const tile of tiles) {
        const url = `${getApiBase()}/decor?kind=greenery`
            + `&bbox=${encodeURIComponent(tile.bbox)}`;
        requests.push(
            fetchJson(url, signal)
                .then((payload) => normalizeDecorPayload('greenery', payload, { tileKey: tile.key })),
        );
    }
    requests.push(
        fetchJson(`${getApiBase()}/water?bbox=${encodeURIComponent(bbox)}`, signal)
            .then(normalizeWaterCollection),
    );
    const settled = await Promise.allSettled(requests);
    const records = dedupeEntityRecords([
        ...settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []),
        ...normalizeTrackCollection({ type: 'FeatureCollection', features: sessionTracks }),
        ...normalizeStops(sessionStops),
    ]);
    for (const failure of settled.filter((result) => result.status === 'rejected')) {
        if (failure.reason?.name !== 'AbortError') {
            console.warn('[Station3D] source entity fetch failed:', failure.reason);
        }
    }
    return records.filter((item) =>
        geometryTouchesRadius(item.geometry, lat, lon, PICK_RADIUS_M));
}

async function refresh(lat, lon) {
    if (!inspectionEnabled || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    requestId += 1;
    const currentRequestId = requestId;
    lastLat = lat;
    lastLon = lon;
    fetchController?.abort();
    fetchController = new AbortController();
    const abortFromSession = () => fetchController?.abort();
    sessionFetchController?.signal?.addEventListener('abort', abortFromSession, { once: true });
    try {
        const records = await fetchRecords(lat, lon, fetchController.signal);
        publishRecords(records, currentRequestId);
    } catch (error) {
        if (error?.name !== 'AbortError') {
            console.warn('[Station3D] source entity refresh failed:', error);
        }
    } finally {
        sessionFetchController?.signal?.removeEventListener('abort', abortFromSession);
        if (currentRequestId === requestId) fetchController = null;
    }
}

export const sourceEntitiesLayer = {
    beginSession(ctx) {
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        inspectionEnabled = ctx?.entityInspection === true;
        if (!inspectionEnabled) return;
        anchorLat = Number(ctx.anchorLat);
        anchorLon = Number(ctx.anchorLon);
        terrainReference = ctx.terrain || null;
        terrainUnsubscribe = terrainReference?.onChange?.(() => {
            if (Number.isFinite(lastLat) && Number.isFinite(lastLon)) {
                refresh(lastLat, lastLon);
            }
        }) || null;
        sessionFetchController = ctx.fetchController || null;
        networkRequestScheduler = ctx.sharedTileSession || null;
        sessionTracks = Array.isArray(ctx.otherTracks) ? ctx.otherTracks : [];
        sessionStops = Array.isArray(ctx.allStops) ? ctx.allStops : [];
        const pose = ctx.initialPose;
        lastLat = null;
        lastLon = null;
        return refresh(Number(pose?.lat), Number(pose?.lon));
    },
    onFrame(pose) {
        if (!inspectionEnabled || !Number.isFinite(Number(pose?.lat))
            || !Number.isFinite(Number(pose?.lon))) return;
        if (lastLat == null || haversineMeters(
            Number(pose.lat),
            Number(pose.lon),
            lastLat,
            lastLon,
        ) >= REFRESH_DISTANCE_M) {
            refresh(Number(pose.lat), Number(pose.lon));
        }
    },
    endSession() {
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        inspectionEnabled = false;
        requestId += 1;
        fetchController?.abort();
        fetchController = null;
        sessionFetchController = null;
        networkRequestScheduler = null;
        sessionTracks = [];
        sessionStops = [];
        terrainReference = null;
        lastLat = null;
        lastLon = null;
        clearGroup();
    },
};
