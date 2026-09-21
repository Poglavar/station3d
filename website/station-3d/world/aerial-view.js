// Far terrain, far sea and the authored sky for scenes flown over open country
// (the Vis arrival). The streamed world ends about 1.4 km from its focus, so a
// shot from the air saw its edge; films hid it in 600 m of fog, which also hid
// the sea, the island and every forest on it. This layer fills the view to the
// horizon with one coarse DEM mesh tinted by land cover and one sea plane,
// computes the height-dependent haze those need, and draws the authored sky
// (scene/sky-dome.js). A far window is fetched once per 2.5 km of travel,
// built a few rows per frame and swapped in whole.

import * as THREE from 'three';
import { getApiBase } from '../core/api.js';
import {
    aerialFogAtHeight,
    createFarTerrainGeometryBuilder,
    createLandCoverRaster,
    farTerrainCoverageMask,
    farTerrainLattice,
    farTerrainNeedsRecenter,
    farTerrainWindow,
    resolveAerialViewConfig,
} from '../core/aerial-view.js';
import { FRAME_CHUNK_REPEAT_ITEM, createFrameChunkQueue } from '../core/frame-chunk-queue.js';
import { finiteOrNull, localToGeo } from '../core/math.js';
import { bindRenderOriginShader } from '../core/render-origin.js';
import { resolveSkyConfig } from '../core/sky-clouds.js';
import { fetchTerrainGridApi } from '../core/terrain-api-grid.js';
import { TerrainGrid } from '../core/terrain-grid.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
} from '../core/surface-hierarchy.js';
import { applyGroundHoleMask, camera, scene } from '../scene/setup.js';
import { getSunDirection } from '../scene/sky.js';
import { createSkyDome } from '../scene/sky-dome.js';
import { WATER_UV_PER_M, createWaterMaterial } from './water-material.js';
import { TERRAIN_TILE_M, getTerrainReference, isTerrainTilePublishedAtLocal } from './terrain.js';
import { mappedSeaPlaneExtent, mappedSeaSurfaceSceneY } from './water.js';

// The national 20 m DTM: a far window needs neither LiDAR nor the composite.
const FAR_TERRAIN_SOURCE = 'dgu-dtm-20m';
// Lattice rows per queue item: under three thousand vertices, a millisecond or two.
const ROWS_PER_ITEM = 12;
const COVERAGE_REFRESH_MS = 500;
const FAILURE_BACKOFF_MS = 10_000;
// Wider than the far haze at any height, centred on the camera every frame.
const FAR_SEA_SIZE_M = 30_000;
// Under the recessed near sea plane, so the two never fight where they meet.
const FAR_SEA_BELOW_SEA_M = 0.35;
// The far terrain is terrain for the coastline mask: it takes the same cut.
const FAR_TERRAIN_CLAIM = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.TERRAIN,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    verticalBand: 'ground',
    ownerId: 'aerial-far-terrain',
    sourceId: 'world/aerial-view.js',
    supportReady: true,
});

let session = null;
let farTerrainQueue = null;

function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function buildQueue() {
    farTerrainQueue ||= createFrameChunkQueue({
        label: 'aerial-far-terrain',
        frameBudgetMs: 3,
        // A flight never stops moving; the window has to build while it does.
        pauseDuringMovement: false,
        preferAnimationFrame: true,
        workClass: 'near',
    });
    return farTerrainQueue;
}

// Gives a standard material a discard by absolute world position. The render
// origin shifts the scene while it draws, so the absolute position is the
// world position plus uRenderOriginXZ, as in the ground and water masks.
// `vertexAfterUv` may override texture coordinates from that same position.
function installWorldDiscard(material, cacheKey, uniforms, declarations, discard, {
    vertexDeclarations = '',
    vertexAfterUv = '',
} = {}) {
    material.onBeforeCompile = shader => {
        bindRenderOriginShader(shader);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\nvarying vec3 vAerialWorldPosition;\n${vertexDeclarations}`)
            .replace('#include <uv_vertex>', `#include <uv_vertex>\n${vertexAfterUv}`)
            .replace('#include <project_vertex>', '#include <project_vertex>\nvAerialWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\nvarying vec3 vAerialWorldPosition;\n${declarations}`)
            .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${discard}`);
    };
    material.customProgramCacheKey = () => cacheKey;
}

// The open sea past the near sea's water mask, which it steps aside for. It is
// the near sea's own material (colour, texture and normal map, whose shared
// maps the water layer animates) with texture coordinates taken from the
// absolute world position, so both surfaces carry one continuous pattern.
function createFarSea() {
    const uniforms = {
        uNearSeaRect: { value: new THREE.Vector4() },
        uAerialWaterUvPerM: { value: WATER_UV_PER_M },
    };
    const material = createWaterMaterial({
        profile: 'sea',
        // Behind any coast it meets in depth.
        polygonOffset: true,
        polygonOffsetFactor: 4,
        polygonOffsetUnits: 4,
    });
    material.name = 'AerialFarSea';
    installWorldDiscard(material, 'aerial-far-sea', uniforms, 'uniform vec4 uNearSeaRect;', `
        vec2 aerialSeaXZ = vAerialWorldPosition.xz + uRenderOriginXZ;
        if (uNearSeaRect.z > 0.0
            && abs(aerialSeaXZ.x - uNearSeaRect.x) < uNearSeaRect.z
            && abs(aerialSeaXZ.y - uNearSeaRect.y) < uNearSeaRect.z) discard;
    `, {
        vertexDeclarations: 'uniform vec2 uRenderOriginXZ;\nuniform float uAerialWaterUvPerM;',
        vertexAfterUv: `
            vec2 aerialWaterUv = ((modelMatrix * vec4(position, 1.0)).xz + uRenderOriginXZ) * uAerialWaterUvPerM;
            #ifdef USE_MAP
            vMapUv = (mapTransform * vec3(aerialWaterUv, 1.0)).xy;
            #endif
            #ifdef USE_NORMALMAP
            vNormalMapUv = (normalMapTransform * vec3(aerialWaterUv, 1.0)).xy;
            #endif
        `,
    });
    const geometry = new THREE.PlaneGeometry(FAR_SEA_SIZE_M, FAR_SEA_SIZE_M);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'AerialFarSea';
    mesh.frustumCulled = false;
    return { mesh, uniforms };
}

function createCoverageTexture(size) {
    const data = new Uint8Array(size * size);
    const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat);
    texture.name = 'AerialTerrainCoverage';
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    // One byte per texel and an odd width: rows must not be padded to four.
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return { texture, data, size };
}

// The coarse island, tinted by land cover, discarded wherever a streamed
// terrain tile already stands.
function createFarTerrainMaterial(coverage) {
    const uniforms = {
        uTerrainCoverage: { value: coverage.texture },
        uTerrainCoverageOrigin: { value: new THREE.Vector2() },
        uTerrainCoverageSizeM: { value: 1 },
    };
    const material = new THREE.MeshStandardMaterial({
        name: 'AerialFarTerrain',
        vertexColors: true,
        roughness: 0.97,
        metalness: 0,
    });
    installWorldDiscard(material, 'aerial-far-terrain', uniforms,
        'uniform sampler2D uTerrainCoverage;\nuniform vec2 uTerrainCoverageOrigin;\nuniform float uTerrainCoverageSizeM;', `
        vec2 aerialCoverageUv = (vAerialWorldPosition.xz + uRenderOriginXZ - uTerrainCoverageOrigin) / uTerrainCoverageSizeM;
        if (all(greaterThanEqual(aerialCoverageUv, vec2(0.0)))
            && all(lessThan(aerialCoverageUv, vec2(1.0)))
            && texture2D(uTerrainCoverage, aerialCoverageUv).r > 0.5) discard;
    `);
    // Inside the water layer's coastline mask the coarse surface yields to the
    // sea exactly where the streamed terrain does; an 80 m lattice alone would
    // smear the hills across a narrow harbour.
    applyGroundHoleMask(material, FAR_TERRAIN_CLAIM);
    return { material, uniforms };
}

function refreshCoverage(current, force = false) {
    if (!current.lattice) return;
    const now = nowMs();
    if (!force && now - current.coverageCheckedAtMs < COVERAGE_REFRESH_MS) return;
    current.coverageCheckedAtMs = now;
    const mask = farTerrainCoverageMask({
        centerX: current.lattice.centerX,
        centerZ: current.lattice.centerZ,
        halfSizeM: current.config.farTerrainHalfSizeM,
        tileM: TERRAIN_TILE_M,
        isPublishedAt: isTerrainTilePublishedAtLocal,
    });
    if (!current.coverage || current.coverage.size !== mask.size) {
        current.coverage?.texture.dispose();
        current.coverage = createCoverageTexture(mask.size);
        if (current.farTerrainMaterial) {
            current.farTerrainMaterial.uniforms.uTerrainCoverage.value = current.coverage.texture;
        }
    }
    current.farTerrainMaterial ||= createFarTerrainMaterial(current.coverage);
    const { data, texture } = current.coverage;
    for (let index = 0; index < data.length; index++) {
        if (data[index] === mask.data[index]) continue;
        data.set(mask.data);
        texture.needsUpdate = true;
        break;
    }
    current.coveragePublishedTiles = mask.published;
    current.farTerrainMaterial.uniforms.uTerrainCoverageOrigin.value.set(mask.originX, mask.originZ);
    current.farTerrainMaterial.uniforms.uTerrainCoverageSizeM.value = mask.size * mask.tileM;
}

function publishFarTerrain(current, lattice, data) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    // The builder already walked every vertex; no whole-mesh pass in this frame.
    const { bounds } = data;
    geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(bounds.minX, bounds.minY, bounds.minZ),
        new THREE.Vector3(bounds.maxX, bounds.maxY, bounds.maxZ),
    );
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    current.lattice = lattice;
    refreshCoverage(current, true);
    const mesh = new THREE.Mesh(geometry, current.farTerrainMaterial.material);
    mesh.name = 'AerialFarTerrain';
    const previous = current.farTerrain;
    current.group.add(mesh);
    current.farTerrain = mesh;
    current.farTerrainTriangles = data.triangleCount;
    if (previous) {
        previous.removeFromParent();
        previous.geometry.dispose();
    }
}

function enqueueFarTerrainBuild(current, lattice, grid, features, reference) {
    const raster = createLandCoverRaster(lattice, { anchorLon: current.anchorLon, anchorLat: current.anchorLat });
    let builder = null;
    const items = [
        ...features.map(feature => ({ kind: 'land-cover', feature })),
        { kind: 'heights' },
        { kind: 'publish' },
    ];
    const settle = () => {
        if (session === current) current.buildJob = null;
    };
    current.buildJob = buildQueue().enqueue(items, item => {
        if (session !== current) return undefined;
        if (item.kind === 'land-cover') {
            raster.addFeature(item.feature);
            return undefined;
        }
        if (item.kind === 'heights') {
            builder ||= createFarTerrainGeometryBuilder({
                lattice,
                anchorLon: current.anchorLon,
                anchorLat: current.anchorLat,
                heightAt: (lon, lat) => grid.sampleHeight(lon, lat),
                toSceneY: heightM => reference.absoluteToSceneY(heightM),
                classes: raster.classes,
                seaLevelCutM: current.config.seaLevelCutM,
                dropM: current.config.farTerrainDropM,
            });
            return builder.stepRows(ROWS_PER_ITEM) ? undefined : FRAME_CHUNK_REPEAT_ITEM;
        }
        publishFarTerrain(current, lattice, builder.finish());
        return undefined;
    }, {
        onComplete: settle,
        onCancel: settle,
        onError: error => {
            console.warn(`[aerial-view] ${new Date().toISOString()} far terrain build failed`, error);
            if (session === current) current.failedAtMs = nowMs();
            settle();
        },
        describeItem: item => `aerial-far-terrain:${item.kind}`,
    });
}

async function startFarTerrainBuild(current, focus) {
    const { config, anchorLat, anchorLon } = current;
    const lattice = farTerrainLattice({
        centerX: focus.x,
        centerZ: focus.z,
        halfSizeM: config.farTerrainHalfSizeM,
        cellM: config.farTerrainCellM,
    });
    const centre = localToGeo(focus.x, focus.z, anchorLon, anchorLat);
    const window = farTerrainWindow({
        centerLat: centre.lat,
        centerLon: centre.lon,
        halfSizeM: config.farTerrainHalfSizeM,
        cellM: config.farTerrainCellM,
    });
    const controller = new AbortController();
    current.fetch = controller;
    const apiBase = getApiBase();
    const scheduler = current.ctx?.sharedTileSession;
    const schedule = (label, run) => (typeof scheduler?.scheduleNetworkRequest === 'function'
        ? scheduler.scheduleNetworkRequest({
            label,
            groupKey: 'aerial-view',
            groupLimit: 2,
            priority: { tier: 'support', score: 4e12 },
            signal: controller.signal,
            run,
        })
        : run());
    try {
        const [decoded, greenery] = await Promise.all([
            schedule('aerial-view:terrain', () => fetchTerrainGridApi(apiBase, {
                bbox: window.bbox,
                resolutionDeg: window.resolutionDeg,
                source: FAR_TERRAIN_SOURCE,
            }, { signal: controller.signal })),
            schedule('aerial-view:land-cover', async () => {
                const bbox = window.bbox.map(value => value.toFixed(6)).join(',');
                const response = await fetch(`${apiBase}/decor?kind=greenery&bbox=${bbox}`, { signal: controller.signal });
                if (!response.ok) throw new Error(`decor HTTP ${response.status}`);
                return response.json();
            }).catch(error => {
                if (error?.name === 'AbortError') throw error;
                // Land cover is a tint: the island still stands without it.
                console.warn(`[aerial-view] ${new Date().toISOString()} far land cover unavailable; the far terrain is drawn untinted`, error);
                return { features: [] };
            }),
        ]);
        if (session !== current || controller.signal.aborted) return;
        const reference = getTerrainReference();
        if (!reference) throw new Error('terrain reference went away before the far terrain was built');
        const grid = new TerrainGrid(decoded.metadata, decoded.arrayBuffer, {
            sourceArrayBuffer: decoded.sourceArrayBuffer || null,
        });
        enqueueFarTerrainBuild(current, lattice, grid, greenery?.features || [], reference);
    } catch (error) {
        if (error?.name === 'AbortError' || session !== current) return;
        current.failedAtMs = nowMs();
        console.warn(`[aerial-view] ${new Date().toISOString()} far terrain window failed; retrying in ${FAILURE_BACKOFF_MS / 1000} s`, error);
    } finally {
        if (current.fetch === controller) current.fetch = null;
    }
}

function disposeSession() {
    const current = session;
    if (!current) return;
    session = null;
    current.fetch?.abort();
    if (current.buildJob) buildQueue().cancel(current.buildJob);
    current.group.removeFromParent();
    current.farTerrain?.geometry.dispose();
    current.farTerrainMaterial?.material.dispose();
    current.coverage?.texture.dispose();
    if (current.farSea) {
        current.farSea.mesh.geometry.dispose();
        current.farSea.mesh.material.dispose();
    }
    current.sky?.dispose();
}

// What the layer holds right now, for probes and the console.
export function aerialViewSnapshot() {
    const current = session;
    if (!current) return null;
    return {
        aerialView: !!current.config,
        sky: !!current.sky,
        farTerrain: current.lattice ? {
            centerX: Math.round(current.lattice.centerX),
            centerZ: Math.round(current.lattice.centerZ),
            triangles: current.farTerrainTriangles,
            streamedTilesSteppedAside: current.coveragePublishedTiles,
        } : null,
        building: !!(current.fetch || current.buildJob),
        failedAtMs: Number.isFinite(current.failedAtMs) ? current.failedAtMs : null,
        fog: current.fog,
        seaMask: mappedSeaPlaneExtent(),
        sunDirection: { ...getSunDirection() },
        camera: {
            x: Math.round(camera.position.x),
            y: Math.round(camera.position.y),
            z: Math.round(camera.position.z),
            direction: camera.getWorldDirection(new THREE.Vector3()).toArray().map(value => Math.round(value * 1000) / 1000),
        },
    };
}

// The haze for the camera's current height, or null to keep the session fog.
// cab.js applies it through the same path as a film's authored fog.
export function getAerialViewFog() {
    return session?.fog || null;
}

export const aerialViewLayer = {
    beginSession(ctx) {
        disposeSession();
        const authored = ctx?.campaignScene?.authored;
        const config = resolveAerialViewConfig(authored?.aerialView);
        const skyConfig = resolveSkyConfig(authored?.sky);
        if (!config && !skyConfig) return;
        const group = new THREE.Group();
        group.name = 'AerialView';
        session = {
            ctx,
            config,
            anchorLat: Number(ctx.anchorLat),
            anchorLon: Number(ctx.anchorLon),
            group,
            startedAtMs: nowMs(),
            farSea: config ? createFarSea() : null,
            farTerrain: null,
            farTerrainTriangles: 0,
            farTerrainMaterial: null,
            lattice: null,
            coverage: null,
            coverageCheckedAtMs: -Infinity,
            coveragePublishedTiles: 0,
            fetch: null,
            buildJob: null,
            failedAtMs: -Infinity,
            sky: skyConfig ? createSkyDome(skyConfig) : null,
            fog: null,
        };
        if (session.farSea) group.add(session.farSea.mesh);
        scene.add(group);
        if (session.sky) scene.add(session.sky.object);
        if (typeof window !== 'undefined') window.__s3dAerialView = aerialViewSnapshot;
    },

    onFrame(_pose, local) {
        const current = session;
        if (!current) return;
        const reference = getTerrainReference();
        const seaY = finiteOrNull(mappedSeaSurfaceSceneY())
            ?? finiteOrNull(reference?.absoluteToSceneY?.(0))
            ?? 0;
        if (current.config) {
            current.farSea.mesh.position.set(camera.position.x, seaY - FAR_SEA_BELOW_SEA_M, camera.position.z);
            const extent = mappedSeaPlaneExtent();
            current.farSea.uniforms.uNearSeaRect.value.set(
                extent?.centerX ?? 0,
                extent?.centerZ ?? 0,
                extent?.halfSizeM ?? 0,
                0,
            );
            const focus = { x: finiteOrNull(local?.x), z: finiteOrNull(local?.z) };
            if (!current.fetch
                && !current.buildJob
                && reference
                && focus.x !== null
                && focus.z !== null
                && farTerrainNeedsRecenter(current.lattice, focus, current.config.recenterDistanceM)
                && nowMs() - current.failedAtMs >= FAILURE_BACKOFF_MS) {
                startFarTerrainBuild(current, focus);
            }
            refreshCoverage(current);
            current.fog = aerialFogAtHeight(camera.position.y - seaY, current.config);
        }
        current.sky?.update({
            camera,
            fogColor: scene.fog?.color || null,
            seaSceneY: seaY,
            elapsedS: (nowMs() - current.startedAtMs) / 1000,
        });
    },

    endSession() {
        disposeSession();
        if (typeof window !== 'undefined' && window.__s3dAerialView === aerialViewSnapshot) {
            delete window.__s3dAerialView;
        }
    },
};
