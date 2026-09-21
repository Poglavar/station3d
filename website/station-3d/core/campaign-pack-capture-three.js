// Offline-only scene capture for authored Station3D levels. It runs inside the
// existing, fully-settled model world and serializes only stable inspection
// layers. Geometry is transformed into a fixed campaign-anchor frame; dynamic
// traffic, actors and encounter objects never enter the artifact.

import * as THREE from 'three';
import { carveTerrainPrimitive } from './campaign-pack-terrain-carve.js';

import {
    CAMPAIGN_PACK_CHUNK_CONTRACT,
    encodeCampaignPackChunk,
} from './campaign-pack-binary.js';
import {
    CAMPAIGN_PACK_MANIFEST_CONTRACT,
    CAMPAIGN_PACK_MANIFEST_VERSION,
} from './campaign-pack.js';
import { compressCampaignPackPayload } from './campaign-pack-compression.js';
import { inspectionLayerForObject, isEffectivelyVisible, isInspectionOverlay } from './scene-inspection.js';
import { surfaceClaimForObject } from './surface-claim.js';
import { asSurfaceClaim, compileSurfaceClaim, SURFACE_CLASS } from './surface-hierarchy.js';

export const CAMPAIGN_PACK_CAPTURE_COMPILER_VERSION = 'station3d-scene-capture-v1';

const DEFAULT_CHUNK_SIZE_M = 250;
const DEFAULT_MAX_CHUNK_BYTES = 12 * 1024 * 1024;

const CAPTURE_LAYER_GROUPS = Object.freeze({
    terrain: 'ground',
    'road-asphalt': 'ground',
    'sidewalks-paths': 'ground',
    'bike-surfaces': 'ground',
    curbs: 'ground',
    'lane-markings': 'ground',
    'road-earthworks': 'ground',
    'road-retaining-walls': 'ground',
    'road-structure-earthworks': 'ground',
    'road-underpasses': 'ground',
    'road-structures-other': 'ground',
    'rail-trackbed': 'ground',
    'rail-formation': 'ground',
    'rail-structures': 'ground',
    'rail-electrification': 'decor',
    'level-crossing-dressing': 'ground',
    buildings: 'buildings',
    'far-buildings': 'far-buildings',
    'courtyard-passages': 'buildings',
    platforms: 'ground',
    flags: 'decor',
    decor: 'decor',
    water: 'ground',
    'street-lamps': 'decor',
    'street-names': 'decor',
    'campaign-tower': 'buildings',
});

const LAYER_SURFACE_CLASSES = Object.freeze({
    terrain: SURFACE_CLASS.TERRAIN,
    'road-asphalt': SURFACE_CLASS.ROAD_CARRIAGEWAY,
    'sidewalks-paths': SURFACE_CLASS.SIDEWALK,
    'bike-surfaces': SURFACE_CLASS.CYCLEWAY,
    curbs: SURFACE_CLASS.ROAD_DRESSING,
    'lane-markings': SURFACE_CLASS.ROAD_MARKING,
    'road-earthworks': SURFACE_CLASS.ROAD_EARTHWORK,
    'road-retaining-walls': SURFACE_CLASS.STRUCTURE,
    'road-structure-earthworks': SURFACE_CLASS.STRUCTURE,
    'road-underpasses': SURFACE_CLASS.STRUCTURE,
    'road-structures-other': SURFACE_CLASS.STRUCTURE,
    'rail-trackbed': SURFACE_CLASS.RAIL_TRACKBED,
    'rail-formation': SURFACE_CLASS.RAIL_TRACKBED,
    'rail-structures': SURFACE_CLASS.STRUCTURE,
    'level-crossing-dressing': SURFACE_CLASS.LEVEL_CROSSING_DRESSING,
    buildings: SURFACE_CLASS.BUILDING,
    'far-buildings': SURFACE_CLASS.BUILDING,
    platforms: SURFACE_CLASS.STRUCTURE,
    water: SURFACE_CLASS.WATER,
});

const _matrix = new THREE.Matrix4();
const _combinedMatrix = new THREE.Matrix4();
const _normalMatrix = new THREE.Matrix3();
const _position = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _instanceColor = new THREE.Color();
const _worldBounds = new THREE.Box3();

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function plainValue(value) {
    if (Array.isArray(value)) return value.map(plainValue);
    if (!value || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value)) return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (typeof child !== 'function' && child !== undefined) output[key] = plainValue(child);
    }
    return output;
}

function fnvByte(hash, byte) {
    return Math.imul((hash ^ byte) >>> 0, 16777619) >>> 0;
}

function hashValue(hash, value) {
    if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        for (const byte of bytes) hash = fnvByte(hash, byte);
        return hash;
    }
    if (Array.isArray(value)) {
        for (const child of value) hash = hashValue(hashValue(hash, '['), child);
        return hashValue(hash, ']');
    }
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value).sort()) {
            hash = hashValue(hash, key);
            hash = hashValue(hash, value[key]);
        }
        return hash;
    }
    const bytes = new TextEncoder().encode(String(value));
    for (const byte of bytes) hash = fnvByte(hash, byte);
    return hash;
}

function fingerprint(value) {
    return hashValue(2166136261, value).toString(16).padStart(8, '0');
}

async function encodedCanvasTexture(image) {
    let blob = null;
    if (typeof image.convertToBlob === 'function') {
        try {
            blob = await image.convertToBlob({ type: 'image/webp', quality: 0.84 });
        } catch (_error) { /* try PNG below */ }
        if (!blob) {
            try {
                blob = await image.convertToBlob({ type: 'image/png' });
            } catch (_error) { /* fall through */ }
        }
    } else if (typeof image.toBlob === 'function') {
        const toBlob = (type, quality) => new Promise(resolve => image.toBlob(resolve, type, quality));
        try {
            blob = await toBlob('image/webp', 0.84);
        } catch (_error) { /* try PNG below */ }
        if (!blob) {
            try {
                blob = await toBlob('image/png');
            } catch (_error) { /* fall through */ }
        }
    }
    if (!blob) return null;
    return {
        mimeType: blob.type || 'image/png',
        encodedData: new Uint8Array(await blob.arrayBuffer()),
    };
}

async function textureDescriptor(texture) {
    const image = texture?.image;
    if (!texture || !image) return null;
    const common = {
        colorSpace: texture.colorSpace === THREE.NoColorSpace ? 'linear' : 'srgb',
        repeat: [finite(texture.repeat?.x, 1), finite(texture.repeat?.y, 1)],
        offset: [finite(texture.offset?.x), finite(texture.offset?.y)],
        wrapS: texture.wrapS === THREE.ClampToEdgeWrapping ? 'clamp' : 'repeat',
        wrapT: texture.wrapT === THREE.ClampToEdgeWrapping ? 'clamp' : 'repeat',
        flipY: texture.flipY !== false,
    };
    if (ArrayBuffer.isView(image.data)
        && Number.isInteger(image.width) && Number.isInteger(image.height)) {
        return {
            ...common,
            width: image.width,
            height: image.height,
            data: image.data,
        };
    }
    let src = String(image.currentSrc || image.src || '').trim();
    if (src && !src.startsWith('blob:')) {
        try {
            const resolved = new URL(src, globalThis.location?.href);
            if (globalThis.location?.origin && resolved.origin === globalThis.location.origin) {
                src = `${resolved.pathname}${resolved.search}`;
            }
        } catch (_error) { /* retain the original source */ }
        return { ...common, url: src };
    }
    if (typeof image.getContext === 'function') {
        try {
            const encoded = await encodedCanvasTexture(image);
            if (encoded) {
                return {
                    ...common,
                    width: image.width,
                    height: image.height,
                    ...encoded,
                };
            }
        } catch (_error) {
            // A cross-origin decorative texture may be unreadable. Geometry is
            // still authoritative; retain its base material colour below.
        }
    }
    return null;
}

async function materialDescriptor(material, { semantic, vertexColors, blending = 'normal' }) {
    const polygonOffset = material?.polygonOffset ? {
        factor: finite(material.polygonOffsetFactor),
        units: finite(material.polygonOffsetUnits),
    } : null;
    return {
        type: ['MeshBasicMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial', 'MeshStandardMaterial']
            .includes(material?.type)
            ? material.type : 'MeshStandardMaterial',
        semantic,
        color: material?.color?.getHexString ? `#${material.color.getHexString()}` : '#b8b3aa',
        opacity: finite(material?.opacity, 1),
        transparent: material?.transparent === true,
        alphaTest: finite(material?.alphaTest),
        depthWrite: material?.depthWrite !== false,
        depthTest: material?.depthTest !== false,
        side: material?.side === THREE.DoubleSide ? 'double' : 'front',
        roughness: finite(material?.roughness, 0.86),
        metalness: finite(material?.metalness),
        shininess: finite(material?.shininess, 30),
        vertexColors: vertexColors === true,
        blending: blending === 'multiply' ? 'multiply' : 'normal',
        polygonOffset,
        map: await textureDescriptor(material?.map),
    };
}

function inheritedClaim(object, material, layerId) {
    const claim = surfaceClaimForObject(object) || material?.userData?.surfaceClaim || null;
    if (claim) return plainValue(asSurfaceClaim(claim));
    const surfaceClass = LAYER_SURFACE_CLASSES[layerId]
        || (layerId.startsWith('rail-') ? SURFACE_CLASS.RAIL_TRACKBED : null)
        || (layerId.startsWith('road-') ? SURFACE_CLASS.ROAD_CARRIAGEWAY : null);
    if (!surfaceClass) return null;
    return plainValue(compileSurfaceClaim({
        surfaceClass,
        coverageState: 'published',
        verticalRelation: surfaceClass === SURFACE_CLASS.BUILDING ? 'unknown' : 'same-level',
        verticalBand: surfaceClass === SURFACE_CLASS.BUILDING ? null : 'ground',
        supportReady: surfaceClass !== SURFACE_CLASS.WATER,
    }));
}

function entityId(object, instanceId = null) {
    if (instanceId != null) {
        const value = object.userData?.objectIdsByBatchId?.[instanceId]
            ?? object.userData?.entityIdsByInstanceId?.[instanceId];
        if (value != null) return String(value);
    }
    return String(
        object.userData?.entityKey
        || object.userData?.objectId
        || object.userData?.sourceId
        || object.name
        || object.uuid,
    );
}

function createPrimitiveBuilder({ material, layerId, object }) {
    return {
        positions: [],
        normals: [],
        uvs: [],
        colors: [],
        indices: [],
        entityRanges: [],
        material,
        layerId,
        surfaceClaim: inheritedClaim(object, material, layerId),
        renderOrder: finite(object?.renderOrder),
        hasColors: false,
        multiplyBlend: false,
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity,
    };
}

function attributeColor(attribute, index, instanceColor) {
    const r = attribute ? finite(attribute.getX(index), 1) : 1;
    const g = attribute ? finite(attribute.getY(index), 1) : 1;
    const b = attribute ? finite(attribute.getZ(index), 1) : 1;
    // Render packets carry RGB only. A four-component colour (the contact-AO
    // skirts: black with a per-vertex alpha that fades from the wall seam)
    // is converted to the darkening it applies — c' = 1 − a·(1 − c) — and its
    // material is marked for multiply blending, which reproduces
    // dst·(1 − a) exactly for black. Dropping the alpha instead drew every
    // facade base as an opaque black band in the baked Zagreb level.
    if (attribute && attribute.itemSize === 4) {
        const alpha = Math.max(0, Math.min(1, finite(attribute.getW(index), 1)));
        return [
            (1 - alpha * (1 - r)) * instanceColor.r,
            (1 - alpha * (1 - g)) * instanceColor.g,
            (1 - alpha * (1 - b)) * instanceColor.b,
        ];
    }
    return [r * instanceColor.r, g * instanceColor.g, b * instanceColor.b];
}

function appendGeometryRange(builder, geometry, matrixWorld, {
    vertexStart = 0,
    vertexCount = geometry.getAttribute('position')?.count || 0,
    indexStart = 0,
    indexCount = geometry.getIndex()?.count || vertexCount,
    instanceColor = null,
    entity = null,
} = {}) {
    const positionAttribute = geometry.getAttribute('position');
    if (!positionAttribute || vertexCount <= 0 || indexCount <= 0) return;
    const normalAttribute = geometry.getAttribute('normal');
    const uvAttribute = geometry.getAttribute('uv');
    const colorAttribute = geometry.getAttribute('color');
    const color = instanceColor || new THREE.Color(1, 1, 1);
    const usesColors = !!colorAttribute || color.r !== 1 || color.g !== 1 || color.b !== 1;
    if (colorAttribute?.itemSize === 4) builder.multiplyBlend = true;
    const baseVertex = builder.positions.length / 3;
    _normalMatrix.getNormalMatrix(matrixWorld);
    for (let localIndex = 0; localIndex < vertexCount; localIndex++) {
        const sourceIndex = vertexStart + localIndex;
        _position.set(
            positionAttribute.getX(sourceIndex),
            positionAttribute.getY(sourceIndex),
            positionAttribute.getZ(sourceIndex),
        ).applyMatrix4(matrixWorld);
        builder.positions.push(_position.x, _position.y, _position.z);
        builder.minX = Math.min(builder.minX, _position.x);
        builder.minY = Math.min(builder.minY, _position.y);
        builder.minZ = Math.min(builder.minZ, _position.z);
        builder.maxX = Math.max(builder.maxX, _position.x);
        builder.maxY = Math.max(builder.maxY, _position.y);
        builder.maxZ = Math.max(builder.maxZ, _position.z);
        if (normalAttribute) {
            _normal.set(
                normalAttribute.getX(sourceIndex),
                normalAttribute.getY(sourceIndex),
                normalAttribute.getZ(sourceIndex),
            ).applyMatrix3(_normalMatrix).normalize();
        } else {
            _normal.set(0, 1, 0);
        }
        builder.normals.push(_normal.x, _normal.y, _normal.z);
        builder.uvs.push(
            uvAttribute ? finite(uvAttribute.getX(sourceIndex)) : 0,
            uvAttribute ? finite(uvAttribute.getY(sourceIndex)) : 0,
        );
        builder.colors.push(...attributeColor(colorAttribute, sourceIndex, color));
    }
    const indices = geometry.getIndex();
    const rangeStart = builder.indices.length;
    if (indices) {
        for (let index = 0; index < indexCount; index++) {
            const sourceIndex = Number(indices.getX(indexStart + index));
            builder.indices.push(baseVertex + sourceIndex - vertexStart);
        }
    } else {
        for (let index = 0; index < indexCount; index++) builder.indices.push(baseVertex + index);
    }
    const appended = builder.indices.length - rangeStart;
    if (appended > 0) {
        builder.entityRanges.push({
            entityId: entity || 'anonymous',
            startIndex: rangeStart,
            indexCount: appended,
        });
    }
    builder.hasColors ||= usesColors;
}

function materialAt(object, index = 0) {
    return Array.isArray(object.material) ? object.material[index] : object.material;
}

function regularMeshBuilders(object, layerId) {
    const geometry = object.geometry;
    const indexCount = geometry.getIndex()?.count || geometry.getAttribute('position')?.count || 0;
    const groups = geometry.groups?.length
        ? geometry.groups
        : [{ start: geometry.drawRange?.start || 0, count: Math.min(indexCount, geometry.drawRange?.count || indexCount), materialIndex: 0 }];
    return groups.filter(group => group.count >= 3).map((group) => {
        const material = materialAt(object, group.materialIndex || 0);
        const builder = createPrimitiveBuilder({ material, layerId, object });
        const indexed = !!geometry.getIndex();
        appendGeometryRange(builder, geometry, object.matrixWorld, {
            vertexStart: indexed ? 0 : group.start,
            vertexCount: indexed
                ? geometry.getAttribute('position').count
                : Math.min(group.count, geometry.getAttribute('position').count - group.start),
            indexStart: indexed ? group.start : 0,
            indexCount: Math.min(group.count, indexCount - group.start),
            entity: entityId(object),
        });
        return builder;
    });
}

function instancedMeshBuilders(object, layerId) {
    const material = materialAt(object, 0);
    const builder = createPrimitiveBuilder({ material, layerId, object });
    for (let index = 0; index < object.count; index++) {
        object.getMatrixAt(index, _matrix);
        _combinedMatrix.multiplyMatrices(object.matrixWorld, _matrix);
        const color = object.instanceColor
            ? _instanceColor.fromBufferAttribute(object.instanceColor, index)
            : _instanceColor.setRGB(1, 1, 1);
        appendGeometryRange(builder, object.geometry, _combinedMatrix, {
            instanceColor: color,
            entity: entityId(object, index),
        });
    }
    return [builder];
}

function batchedMeshBuilders(object, layerId) {
    const material = materialAt(object, 0);
    const builder = createPrimitiveBuilder({ material, layerId, object });
    const instanceInfo = object._instanceInfo || [];
    for (let index = 0; index < instanceInfo.length; index++) {
        if (instanceInfo[index]?.active === false || object.getVisibleAt(index) === false) continue;
        const range = object.getGeometryRangeAt(object.getGeometryIdAt(index), {});
        object.getMatrixAt(index, _matrix);
        _combinedMatrix.multiplyMatrices(object.matrixWorld, _matrix);
        object.getColorAt(index, _instanceColor);
        appendGeometryRange(builder, object.geometry, _combinedMatrix, {
            vertexStart: range.vertexStart,
            vertexCount: range.vertexCount,
            indexStart: range.indexStart < 0 ? range.start : range.indexStart,
            indexCount: range.indexCount < 0 ? range.count : range.indexCount,
            instanceColor: _instanceColor,
            entity: entityId(object, index),
        });
    }
    return [builder];
}

function intersectsBounds(builder, bounds) {
    if (!bounds) return true;
    return builder.maxX >= bounds.minX && builder.minX <= bounds.maxX
        && builder.maxZ >= bounds.minZ && builder.minZ <= bounds.maxZ;
}

async function finalizeBuilder(builder, {
    packAnchorX,
    packAnchorZ,
    materialCache,
    terrainCutoutAt = null,
    terrainCarve = null,
}) {
    if (builder.indices.length < 3 || builder.positions.length < 9) return null;
    if (terrainCutoutAt && LAYER_SURFACE_CLASSES[builder.layerId] === SURFACE_CLASS.TERRAIN) {
        // Positions are still absolute scene metres here, the frame the cutout
        // query speaks; the pack anchor is subtracted below.
        const carved = carveTerrainPrimitive({
            positions: builder.positions,
            normals: builder.normals,
            uvs: builder.uvs,
            colors: builder.hasColors ? builder.colors : null,
            indices: builder.indices,
        }, terrainCutoutAt);
        if (carved.carve) {
            builder.positions = carved.positions;
            builder.normals = carved.normals;
            builder.uvs = carved.uvs;
            if (builder.hasColors) builder.colors = carved.colors;
            builder.indices = carved.indices;
            if (terrainCarve) {
                terrainCarve.primitives += 1;
                terrainCarve.dropped += carved.carve.dropped;
                terrainCarve.split += carved.carve.split;
            }
            if (builder.indices.length < 3) return null;
        }
    }
    const positions = new Float32Array(builder.positions);
    for (let index = 0; index < positions.length; index += 3) {
        positions[index] -= packAnchorX;
        positions[index + 2] -= packAnchorZ;
    }
    const vertexCount = positions.length / 3;
    const indices = vertexCount <= 65535
        ? new Uint16Array(builder.indices)
        : new Uint32Array(builder.indices);
    const semantic = LAYER_SURFACE_CLASSES[builder.layerId] || builder.layerId;
    const descriptorCacheKey = `${semantic}:${builder.hasColors ? 'colors' : 'plain'}:${builder.multiplyBlend ? 'multiply' : 'normal'}`;
    let descriptors = materialCache.get(builder.material);
    if (!descriptors) materialCache.set(builder.material, descriptors = new Map());
    let cachedDescriptor = descriptors.get(descriptorCacheKey);
    if (!cachedDescriptor) {
        cachedDescriptor = materialDescriptor(builder.material, {
            semantic,
            vertexColors: builder.hasColors,
            blending: builder.multiplyBlend ? 'multiply' : 'normal',
        }).then(descriptor => ({
            descriptor,
            materialKey: `${descriptor.semantic}:${fingerprint(descriptor)}`,
        }));
        descriptors.set(descriptorCacheKey, cachedDescriptor);
    }
    const { descriptor, materialKey } = await cachedDescriptor;
    const claim = builder.surfaceClaim;
    return {
        primitive: {
            positions,
            normals: new Float32Array(builder.normals),
            uvs: new Float32Array(builder.uvs),
            ...(builder.hasColors ? { colors: new Float32Array(builder.colors) } : {}),
            indices,
            materialKey,
            renderOrder: builder.renderOrder,
            bounds: {
                minX: builder.minX - packAnchorX,
                minY: builder.minY,
                minZ: builder.minZ - packAnchorZ,
                maxX: builder.maxX - packAnchorX,
                maxY: builder.maxY,
                maxZ: builder.maxZ - packAnchorZ,
            },
            entityRanges: builder.entityRanges,
            surfaceClaims: claim ? [claim] : [],
            colliderData: { inspectionLayerId: builder.layerId },
        },
        materialKey,
        materialDescriptor: descriptor,
    };
}

function estimatedPrimitiveBytes(primitive) {
    return primitive.positions.byteLength
        + primitive.normals.byteLength
        + primitive.uvs.byteLength
        + (primitive.colors?.byteLength || 0)
        + primitive.indices.byteLength;
}

function safeCell(value) {
    const integer = Math.trunc(value);
    return integer < 0 ? `n${Math.abs(integer)}` : `p${integer}`;
}

function chunkBucketKey(group, primitive, chunkSizeM) {
    const centerX = (primitive.bounds.minX + primitive.bounds.maxX) / 2;
    const centerZ = (primitive.bounds.minZ + primitive.bounds.maxZ) / 2;
    return `${group}-x${safeCell(Math.floor(centerX / chunkSizeM))}-z${safeCell(Math.floor(centerZ / chunkSizeM))}`;
}

function objectWorldBounds(object) {
    let bounds = null;
    if (object.isInstancedMesh || object.isBatchedMesh) {
        object.computeBoundingBox?.();
        bounds = object.boundingBox;
    }
    if (!bounds) {
        object.geometry.computeBoundingBox?.();
        bounds = object.geometry.boundingBox;
    }
    if (!bounds || bounds.isEmpty()) return null;
    _worldBounds.copy(bounds).applyMatrix4(object.matrixWorld);
    return {
        minX: _worldBounds.min.x,
        minY: _worldBounds.min.y,
        minZ: _worldBounds.min.z,
        maxX: _worldBounds.max.x,
        maxY: _worldBounds.max.y,
        maxZ: _worldBounds.max.z,
    };
}

function chunkBucketKeyForWorldBounds(group, bounds, chunkSizeM, packAnchorX, packAnchorZ) {
    const centerX = (bounds.minX + bounds.maxX) / 2 - packAnchorX;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2 - packAnchorZ;
    return `${group}-x${safeCell(Math.floor(centerX / chunkSizeM))}-z${safeCell(Math.floor(centerZ / chunkSizeM))}`;
}

function layerGroupForId(layerId) {
    if (CAPTURE_LAYER_GROUPS[layerId]) return CAPTURE_LAYER_GROUPS[layerId];
    if (layerId.startsWith('rail-')) return 'ground';
    if (layerId.startsWith('road-')) return 'ground';
    if (layerId.startsWith('decor')) return 'decor';
    return null;
}

function primitiveBuildersForObject(object, layerId) {
    if (object.isBatchedMesh) return batchedMeshBuilders(object, layerId);
    if (object.isInstancedMesh) return instancedMeshBuilders(object, layerId);
    return regularMeshBuilders(object, layerId);
}

function chunkPriority(group) {
    if (group === 'ground') return 0;
    if (group === 'buildings') return 10;
    if (group === 'decor') return 20;
    return 30;
}

function splitBucket(bucket, maxBytes) {
    const parts = [];
    let current = { primitives: [], materials: {}, bytes: 0 };
    for (const captured of bucket.captured) {
        const bytes = estimatedPrimitiveBytes(captured.primitive);
        if (current.primitives.length && current.bytes + bytes > maxBytes) {
            parts.push(current);
            current = { primitives: [], materials: {}, bytes: 0 };
        }
        current.primitives.push(captured.primitive);
        current.materials[captured.materialKey] = captured.materialDescriptor;
        current.bytes += bytes;
    }
    if (current.primitives.length) parts.push(current);
    return parts;
}

async function sha256Hex(buffer, cryptoImpl) {
    const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', buffer));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function captureCampaignPackScene({
    scene,
    packId,
    releaseId,
    sourceRevision,
    anchor,
    packAnchorLocal = { x: 0, z: 0 },
    bounds = null,
    playArea,
    railFeatures = [],
    captureLocalBounds = null,
    chunkSizeM = DEFAULT_CHUNK_SIZE_M,
    maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
    cryptoImpl = globalThis.crypto,
    // `(localX, localZ) => boolean`: where the live terrain shader discards
    // its ground. Terrain primitives are carved along it at capture time
    // (core/campaign-pack-terrain-carve.js) because the pack cannot carry the
    // discard itself.
    terrainCutoutAt = null,
} = {}) {
    if (!scene?.traverse) throw new TypeError('Campaign pack capture requires a Three.js scene');
    if (!cryptoImpl?.subtle?.digest) throw new Error('Campaign pack capture requires SHA-256');
    for (const [value, label] of [[packId, 'packId'], [releaseId, 'releaseId'], [sourceRevision, 'sourceRevision']]) {
        if (!String(value || '').trim()) throw new Error(`Campaign pack capture requires ${label}`);
    }
    if (anchor?.verticalDatum !== 'EVRF2000'
        || ![anchor?.lat, anchor?.lon, anchor?.sceneDatumAslM].every(Number.isFinite)) {
        throw new Error('Campaign pack capture requires an EVRF2000 anchor');
    }
    scene.updateMatrixWorld(true);
    const buckets = new Map();
    const packAnchorX = finite(packAnchorLocal.x);
    const packAnchorZ = finite(packAnchorLocal.z);
    const resolvedChunkSizeM = Math.max(50, chunkSizeM);
    let sourceMeshCount = 0;
    let primitiveCount = 0;
    let triangleCount = 0;
    scene.traverse((object) => {
        if (!object?.isMesh || isInspectionOverlay(object) || !isEffectivelyVisible(object)) return;
        const layer = inspectionLayerForObject(object);
        const layerId = String(layer?.id || '');
        const group = layerGroupForId(layerId);
        if (!group || !object.geometry?.getAttribute?.('position')) return;
        const worldBounds = objectWorldBounds(object);
        if (!worldBounds || !intersectsBounds(worldBounds, captureLocalBounds)) return;
        sourceMeshCount += 1;
        const key = chunkBucketKeyForWorldBounds(
            group,
            worldBounds,
            resolvedChunkSizeM,
            packAnchorX,
            packAnchorZ,
        );
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, bucket = { key, group, objects: [] });
        bucket.objects.push({ object, layerId });
    });
    const chunks = [];
    const materialCache = new WeakMap();
    const terrainCarve = { primitives: 0, dropped: 0, split: 0 };
    for (const bucket of [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key))) {
        const capturedForBucket = [];
        for (const { object, layerId } of bucket.objects) {
            for (const builder of primitiveBuildersForObject(object, layerId)) {
                if (!intersectsBounds(builder, captureLocalBounds)) continue;
                const captured = await finalizeBuilder(builder, {
                    packAnchorX,
                    packAnchorZ,
                    terrainCutoutAt,
                    terrainCarve,
                    materialCache,
                });
                if (!captured) continue;
                capturedForBucket.push(captured);
                primitiveCount += 1;
                triangleCount += captured.primitive.indices.length / 3;
            }
        }
        const parts = splitBucket(
            { captured: capturedForBucket },
            Math.max(1024 * 1024, maxChunkBytes),
        );
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            const part = parts[partIndex];
            const key = parts.length === 1 ? bucket.key : `${bucket.key}-part${partIndex + 1}`;
            const packet = {
                schemaVersion: 1,
                compilerId: CAMPAIGN_PACK_CAPTURE_COMPILER_VERSION,
                compilerVersion: CAMPAIGN_PACK_CAPTURE_COMPILER_VERSION,
                sourceRevision,
                generation: 1,
                tile: {
                    matrix: 'campaign',
                    z: 0,
                    x: 0,
                    y: 0,
                    originLon: anchor.lon,
                    originLat: anchor.lat,
                    sizeM: resolvedChunkSizeM,
                },
                primitives: part.primitives,
            };
            const chunk = {
                contract: CAMPAIGN_PACK_CHUNK_CONTRACT,
                schemaVersion: 1,
                packId,
                key,
                layerGroup: bucket.group,
                materials: part.materials,
                packets: [packet],
            };
            const decodedPayload = encodeCampaignPackChunk(chunk);
            const compressedPayload = await compressCampaignPackPayload(decodedPayload);
            const useGzip = compressedPayload.byteLength < decodedPayload.byteLength;
            const payload = useGzip ? compressedPayload : decodedPayload;
            chunks.push({
                key,
                layerGroup: bucket.group,
                priority: chunkPriority(bucket.group),
                payload,
                encoding: useGzip ? 'gzip' : 'identity',
                decodedByteLength: decodedPayload.byteLength,
                sha256: await sha256Hex(payload, cryptoImpl),
            });
        }
        // Give the browser a collection point between spatial buckets. Only
        // encoded chunk buffers survive this turn; transient JS geometry does
        // not scale with the complete campaign corridor.
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (chunks.length === 0) throw new Error('Campaign pack capture found no stable world geometry');
    chunks.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
    const manifest = {
        contract: CAMPAIGN_PACK_MANIFEST_CONTRACT,
        schemaVersion: CAMPAIGN_PACK_MANIFEST_VERSION,
        packId,
        releaseId,
        compilerVersion: CAMPAIGN_PACK_CAPTURE_COMPILER_VERSION,
        sourceRevision,
        anchor: { ...anchor },
        bounds,
        playArea,
        buildParameters: {
            chunkSizeM: resolvedChunkSizeM,
            maxChunkBytes,
            // Keep navigation tied to the geometry captured in this release.
            // A later reference-project revision must not move its trains onto
            // a different track from the immutable mesh they are driving over.
            railFeatures: plainValue(railFeatures),
        },
        outputCounts: {
            sourceMeshes: sourceMeshCount,
            primitives: primitiveCount,
            triangles: triangleCount,
            chunks: chunks.length,
            terrainCarve: { ...terrainCarve },
        },
        byteTotals: {
            encoded: chunks.reduce((sum, chunk) => sum + chunk.payload.byteLength, 0),
            decoded: chunks.reduce((sum, chunk) => sum + chunk.decodedByteLength, 0),
        },
        chunks: chunks.map(chunk => ({
            key: chunk.key,
            layerGroup: chunk.layerGroup,
            priority: chunk.priority,
            byteLength: chunk.payload.byteLength,
            decodedByteLength: chunk.decodedByteLength,
            encoding: chunk.encoding,
            sha256: chunk.sha256,
            url: `chunks/${chunk.key}.bin`,
        })),
    };
    return Object.freeze({ manifest, chunks: Object.freeze(chunks) });
}
