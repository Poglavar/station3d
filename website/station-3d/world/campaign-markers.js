// Small reusable geographic markers for authored campaign zones. They are a
// presentation layer only: adapters remain the sole authority for completion.

import * as THREE from 'three';

import { disposeGroup } from '../core/dispose.js';
import { geoToLocal } from '../core/math.js';
import { evidencePlacementBaseSceneY } from '../core/terrain-placement.js';
import { scene } from '../scene/setup.js';
import { mappedSeaSurfaceSceneY } from './water.js';

const COLORS = [0x38bdf8, 0xfbbf24, 0x4ade80, 0xfb7185];

let root = null;
let markers = [];
let elapsedSeconds = 0;
let sessionContext = null;
let terrainUnsubscribe = null;
let terrainRefreshPending = false;

function makeMarker(zone, index, context) {
    const lat = Number(zone?.center?.lat);
    const lon = Number(zone?.center?.lon);
    const radiusM = Math.max(2, Math.min(80, Number(zone?.radiusM) || 5));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const local = geoToLocal(lon, lat, context.anchorLon, context.anchorLat);
    // Harbor objectives live on the rendered water datum, not on the seabed.
    // Requiring terrain evidence there made one unresolved waterfront zone
    // abort the entire marker group, leaving the player with an invisible
    // departure trigger. Water placement is explicit in authored content so
    // shoreline rings do not depend on the exact coastline polygon boundary.
    const surfaceY = zone?.surface === 'water'
        ? mappedSeaSurfaceSceneY()
        : evidencePlacementBaseSceneY(context.terrain, local.x, local.z);
    if (!Number.isFinite(surfaceY)) return false;
    const baseY = surfaceY + 0.08;
    const waterMarker = zone?.surface === 'water';
    const authoredColor = Number(zone?.markerColor);
    const color = Number.isFinite(authoredColor) ? authoredColor : COLORS[index % COLORS.length];
    // The ring carries the read; the post is a waist-high pulse, not a
    // translucent column that cuts through dialogue shots and the skyline.
    const beaconHeightM = waterMarker ? 1.8 : 1.2;
    const beaconRadiusM = waterMarker ? 0.14 : 0.09;
    const marker = new THREE.Group();
    marker.name = `CampaignZone:${zone.id}`;
    marker.position.set(local.x, baseY, local.z);
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(0.7, radiusM - 0.6), radiusM, 48),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.72,
            side: THREE.DoubleSide,
            depthWrite: false,
        }),
    );
    ring.rotation.x = -Math.PI * 0.5;
    ring.userData.walkableSurface = true;
    marker.add(ring);
    const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(beaconRadiusM, beaconRadiusM, beaconHeightM, 8),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: waterMarker ? 0.62 : 0.38,
            depthWrite: false,
        }),
    );
    beacon.position.y = beaconHeightM * 0.5;
    beacon.userData.walkableSurface = true;
    marker.add(beacon);
    if (waterMarker) {
        const diamond = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.85, 0),
            new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.92,
                depthWrite: false,
            }),
        );
        diamond.position.y = beaconHeightM + 0.7;
        marker.add(diamond);
        marker.userData.diamond = diamond;
        marker.userData.diamondBaseY = diamond.position.y;
    }
    marker.userData.beacon = beacon;
    marker.userData.beaconOpacityScale = waterMarker ? 0.68 : 0.42;
    marker.userData.phase = index * 0.9;
    return marker;
}

export function getCampaignMarkersGroup() {
    return root;
}

// A framed shot (dialogue or film) is composed without the guidance props.
let hiddenByShot = false;
export function setCampaignMarkersHidden(hidden) {
    hiddenByShot = hidden === true;
    if (root) root.visible = !hiddenByShot;
}

function clearMarkers() {
    if (root) disposeGroup(root);
    root = null;
    markers = [];
    elapsedSeconds = 0;
}

export function replaceCampaignMarkersScene(context = {}) {
    sessionContext = context;
    const zones = context.campaignScene?.authored?.zones || [];
    if (zones.length === 0) {
        clearMarkers();
        return true;
    }
    const nextRoot = new THREE.Group();
    nextRoot.name = 'CampaignMarkers';
    const nextMarkers = [];
    const visibleZones = zones.filter(zone => zone.visible !== false).slice(0, 12);
    for (let index = 0; index < visibleZones.length; index++) {
        const marker = makeMarker(visibleZones[index], index, context);
        // Publish markers whose supporting surface is already authoritative.
        // One distant land trigger must not hold back an immediately placeable
        // water marker; terrain changes will rebuild this group and add it.
        if (marker === false) continue;
        if (marker) {
            nextMarkers.push(marker);
            nextRoot.add(marker);
        }
    }
    const previous = root;
    root = nextRoot;
    markers = nextMarkers;
    scene.add(root);
    if (previous) disposeGroup(previous);
    return true;
}

export const campaignMarkersLayer = {
    beginSession(context) {
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        terrainRefreshPending = false;
        sessionContext = context;
        terrainUnsubscribe = context.terrain?.onChange?.(() => {
            terrainRefreshPending = true;
        }) || null;
        return replaceCampaignMarkersScene(context);
    },

    onFrame(_pose, _local, dt) {
        if (terrainRefreshPending && sessionContext) {
            terrainRefreshPending = false;
            replaceCampaignMarkersScene(sessionContext);
        }
        elapsedSeconds += Math.max(0, Number(dt) || 0);
        for (const marker of markers) {
            const pulse = 0.72 + Math.sin(elapsedSeconds * 2.2 + marker.userData.phase) * 0.2;
            marker.userData.beacon.material.opacity = pulse * marker.userData.beaconOpacityScale;
            if (marker.userData.diamond) {
                marker.userData.diamond.rotation.y = elapsedSeconds * 0.75;
                marker.userData.diamond.position.y = marker.userData.diamondBaseY
                    + Math.sin(elapsedSeconds * 1.7 + marker.userData.phase) * 0.28;
            }
        }
    },

    endSession() {
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        terrainRefreshPending = false;
        sessionContext = null;
        clearMarkers();
        hiddenByShot = false;
    },
};
