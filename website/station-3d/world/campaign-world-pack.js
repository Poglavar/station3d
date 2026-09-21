// Runtime authority for an immutable authored campaign level. The adapter has
// already downloaded and integrity-checked every chunk before a Station3D
// session opens; this blocking layer only creates GPU resources and installs
// the support index derived from those exact same triangles.

import * as THREE from 'three';

import { createCampaignPackBuildingCollisionIndex } from '../core/campaign-pack-building-collision.js';
import { createCampaignPackMaterial } from '../core/campaign-pack-material.js';
import { createCampaignPackTerrainReference, sampleCampaignPackRailSurface } from '../core/campaign-pack-ground.js';
import {
    campaignPackCutoutPlaneSpecs,
    resolveCampaignPackCutout,
} from '../core/campaign-pack-cutout.js';
import {
    campaignPackSpawnSupportY,
    createCampaignPackSupportIndex,
} from '../core/campaign-pack-support.js';
import { finiteOrNull, geoToLocal } from '../core/math.js';
import { uploadCampaignPackPackets } from '../core/campaign-pack-upload.js';
import { noteWorldBuildRequirementActive, noteWorldBuildRequirementIdle } from '../core/world-ready.js';
import { createRenderPacketUploadTask } from '../core/render-packet-three.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { renderer, scene } from '../scene/setup.js';
import { applySurfacePublicationDrawContracts } from './surface-material-authority.js';

let uploadGeneration = 0;

let active = null;
let pendingCutout = null;
let pendingVisibility = true;
const _cutoutBounds = new THREE.Box3();
const _meshBounds = new THREE.Box3();

function disposeRoot(root, materials) {
    const geometries = new Set();
    root?.traverse?.((object) => {
        if (object.geometry && !geometries.has(object.geometry)) {
            geometries.add(object.geometry);
            object.geometry.dispose?.();
        }
    });
    root?.parent?.remove?.(root);
    for (const material of materials?.values?.() || []) {
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap']) {
            material[key]?.dispose?.();
        }
        material.dispose?.();
    }
}

function clearActiveCutout() {
    for (const entry of active?.cutoutEntries || []) {
        entry.mesh.material = entry.originalMaterial;
        for (const material of entry.clippedMaterials) material.dispose?.();
    }
    if (active) {
        active.cutoutEntries = [];
        active.cutout = null;
    }
}

function clippedMaterial(material, planes) {
    const clone = material.clone();
    clone.clippingPlanes = planes;
    clone.clipIntersection = true;
    clone.clipShadows = false;
    clone.needsUpdate = true;
    return clone;
}

function applyActiveCutout(inputCutout) {
    if (!active) return;
    clearActiveCutout();
    const cutout = resolveCampaignPackCutout(inputCutout);
    if (!cutout) return;
    const planes = campaignPackCutoutPlaneSpecs(cutout).map(spec => new THREE.Plane(
        new THREE.Vector3(...spec.normal),
        spec.constant,
    ));
    _cutoutBounds.min.set(cutout.minX, -1e6, cutout.minZ);
    _cutoutBounds.max.set(cutout.maxX, 1e6, cutout.maxZ);
    active.root.updateMatrixWorld(true);
    const cutoutEntries = [];
    active.root.traverse((mesh) => {
        if (!mesh?.isMesh || !mesh.geometry?.boundingBox || !mesh.material) return;
        _meshBounds.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
        if (!_meshBounds.intersectsBox(_cutoutBounds)) return;
        const originalMaterial = mesh.material;
        const originals = Array.isArray(originalMaterial)
            ? originalMaterial
            : [originalMaterial];
        const clippedMaterials = originals.map(material => clippedMaterial(material, planes));
        mesh.material = Array.isArray(originalMaterial) ? clippedMaterials : clippedMaterials[0];
        cutoutEntries.push({ mesh, originalMaterial, clippedMaterials });
    });
    // Enabling the renderer feature is cheap when no material carries planes;
    // only the few packet primitives intersecting this authored opening are
    // cloned and recompiled above.
    renderer.localClippingEnabled = true;
    active.cutout = cutout;
    active.cutoutEntries = cutoutEntries;
}

function createStaticRoadFormation(support) {
    return Object.freeze({
        sceneYAtLocal: (x, z, options = {}) => support.supportYAt(x, z, {
            maxY: options.maxY ?? Infinity,
            drivableOnly: true,
        }),
    });
}

export function getCampaignWorldPackGroup() {
    return active?.root || null;
}

export function getCampaignWorldPackSupport() {
    return active?.support || null;
}

export function campaignWorldPackSupportYAtLocal(x, z, options = {}) {
    return active?.support?.supportYAt(x, z, options) ?? null;
}

export function campaignWorldPackRailSurfaceAtLocal(x, z, options = {}) {
    return sampleCampaignPackRailSurface(active?.support, x, z, options);
}

export function campaignWorldPackSpawnYAtLocal(x, z) {
    return campaignPackSpawnSupportY(active?.support, x, z);
}

export function setCampaignWorldPackCutout(cutout) {
    pendingCutout = resolveCampaignPackCutout(cutout);
    applyActiveCutout(pendingCutout);
    return pendingCutout;
}

export function setCampaignWorldPackVisible(visible) {
    pendingVisibility = visible !== false;
    if (active?.root) active.root.visible = pendingVisibility;
    return pendingVisibility;
}

export function campaignWorldPackBuildingFootprintsNear(x, z, radiusM, verticalRange = null) {
    return active?.buildingCollision?.footprintsNear(x, z, radiusM, verticalRange) || [];
}

export function campaignWorldPackBuildingColliderSpecsNear(
    x,
    z,
    radiusM,
    maxColliders,
    options = {},
) {
    return active?.buildingCollision?.colliderSpecsNear(
        x,
        z,
        radiusM,
        maxColliders,
        options,
    ) || [];
}

export function campaignWorldPackDiagnostics() {
    if (!active) return null;
    return Object.freeze({
        contract: 'station3d-campaign-world-pack-runtime-v1',
        packId: active.pack.manifest.packId,
        releaseId: active.pack.manifest.releaseId,
        visible: active.root.visible,
        chunkCount: active.pack.chunks.length,
        materialCount: active.materials.size,
        support: active.support.snapshot(),
        buildingCollision: active.buildingCollision.snapshot(),
        cutout: active.cutout ? {
            ...active.cutout,
            meshCount: active.cutoutEntries.length,
        } : null,
    });
}

export const campaignWorldPackLayer = {
    async beginSession(ctx) {
        const pack = ctx.campaignWorldPack;
        if (!pack) return;
        if (active) disposeRoot(active.root, active.materials);
        const manifest = pack.manifest;
        const packAnchor = geoToLocal(
            Number(manifest.anchor.lon),
            Number(manifest.anchor.lat),
            Number(ctx.anchorLon),
            Number(ctx.anchorLat),
        );
        const root = new THREE.Group();
        root.name = `CampaignWorldPack:${manifest.packId}:${manifest.releaseId}`;
        markInspectionLayer(root, {
            id: 'campaign-world-pack',
            label: 'Baked campaign level',
            category: 'Authored world',
            source: `${manifest.packId} · ${manifest.releaseId}`,
        });
        const materialDescriptors = Object.assign(
            {},
            ...pack.chunks.map(entry => entry.chunk.materials || {}),
        );
        const loader = new THREE.TextureLoader();
        const materials = new Map();
        const materialForKey = (key) => {
            if (!materials.has(key)) {
                materials.set(key, createCampaignPackMaterial(materialDescriptors[key], key, loader));
            }
            return materials.get(key);
        };
        const entries = pack.chunks.flatMap(entry => entry.chunk.packets.map((packet, packetIndex) => ({
            packet, packetIndex, chunkKey: entry.chunk.key,
        })));
        const packets = entries.map(entry => entry.packet);
        const requirementKey = `campaign-pack:${++uploadGeneration}`;
        noteWorldBuildRequirementActive(requirementKey);
        try {
            await uploadCampaignPackPackets(entries, {
                signal: ctx.fetchController?.signal,
                // The curtain's bar continues from the download into the build.
                onProgress: ({ uploaded, total }) => window.dispatchEvent(new CustomEvent(
                    'station3d:campaign-pack-progress',
                    { detail: { phase: 'build', packId: manifest.packId, releaseId: manifest.releaseId, uploadedPackets: uploaded, totalPackets: total } },
                )),
                createTask: ({ packet, chunkKey, packetIndex }) => createRenderPacketUploadTask(packet, {
                    materialForKey,
                    replacementKey: `campaign-pack:${manifest.releaseId}:${chunkKey}:${packetIndex}`,
                    rootName: `CampaignPack:${chunkKey}:${packetIndex}`,
                    position: { x: packAnchor.x, y: 0, z: packAnchor.z },
                    configureMesh: mesh => {
                        mesh.castShadow = false;
                        mesh.receiveShadow = true;
                    },
                }),
                publish: packetRoot => {
                    applySurfacePublicationDrawContracts(packetRoot);
                    root.add(packetRoot);
                },
            });
            scene.add(root);
            const support = createCampaignPackSupportIndex(packets, {
                offsetX: packAnchor.x,
                offsetZ: packAnchor.z,
            });
            const buildingCollision = createCampaignPackBuildingCollisionIndex(packets, {
                offsetX: packAnchor.x,
                offsetZ: packAnchor.z,
            });
            active = {
                pack,
                root,
                materials,
                support,
                buildingCollision,
                cutout: null,
                cutoutEntries: [],
            };
            root.visible = pendingVisibility;
            applyActiveCutout(pendingCutout);
            ctx.campaignWorldSupport = support;
            ctx.terrain = createCampaignPackTerrainReference(support, {
                releaseId: manifest.releaseId,
                anchorLon: ctx.anchorLon,
                anchorLat: ctx.anchorLat,
                sceneDatumAslM: manifest.anchor.sceneDatumAslM,
            });
            ctx.roadFormation = createStaticRoadFormation(support);
            ctx.roadVerticalAlignments = null;
            ctx.railFormation = null;
        } catch (error) {
            disposeRoot(root, materials);
            if (active?.root === root) active = null;
            throw error;
        } finally {
            noteWorldBuildRequirementIdle(requirementKey);
        }
    },
    onFrame() {},
    endSession() {
        if (!active) return;
        clearActiveCutout();
        disposeRoot(active.root, active.materials);
        active = null;
        pendingCutout = null;
        pendingVisibility = true;
    },
};
