// Assemble detached curb tiles in bounded triangle chunks. Render and support
// share the same position buffers; cancellation releases only private geometry.
import * as THREE from 'three';
import { clipReceiverOpeningsSteps } from './receiver-opening-geometry.js';

const MAX_CHUNK_VERTICES = 24000;

export function* prepareCurbTileGeometrySteps(state, {
    materials = {}, uvPerM = {}, claims = {}, renderOrders = {},
    buildManholeMesh = null, markSurfaceClaim = null, materialForGeometry = material => material,
    openingRead = state?.ground?.openings || null, openingClaim = null,
    maxVertices = MAX_CHUNK_VERTICES, now = () => performance.now(),
    isCurrent = () => true,
} = {}) {
    if (!isCurrent()) return null;
    if (!state?.curb?.positions?.length) return { root: null, collisionSurface: null };
    if (!Number.isSafeInteger(maxVertices) || maxVertices < 3) throw new TypeError('Invalid curb chunk size');
    const chunkValues = Math.min(MAX_CHUNK_VERTICES, maxVertices - maxVertices % 3) * 3;
    const openingMaxVertices = Math.min(MAX_CHUNK_VERTICES, maxVertices) * 4;
    const root = new THREE.Group();
    root.name = 'CurbTile'; root.userData.tileKey = state.tileKey;
    const owned = new Set(), support = [];
    let handedOff = false, started = now();
    function* add(data, material, name, uvScale, {
        profile = false, surfaceType = 'sidewalk', walkableSurface = false,
        claim = null, renderOrder = renderOrders.curbRamp,
    } = {}) {
        const source = data?.positions || [];
        if (source.length % 9 !== 0) throw new TypeError(`${name} requires complete triangles`);
        for (let start = 0; start < source.length; start += chunkValues) {
            if (!isCurrent()) return false;
            const count = Math.min(chunkValues, source.length - start);
            const positions = new Float32Array(count), uvs = new Float32Array(count / 3 * 2);
            const normals = profile ? null : new Float32Array(count);
            for (let offset = 0; offset < count; offset += 9) {
                if (now() - started >= 0.5) {
                    yield { phase: 'curb-mesh-attributes' }; started = now();
                }
                if (!isCurrent()) return false;
                const index = start + offset;
                const ax = source[index], az = source[index + 2];
                const bx = source[index + 3], bz = source[index + 5];
                const cx = source[index + 6], cz = source[index + 8];
                // Clamp-induced inverted ramp triangles are flipped in the
                // private output, never in a retained input generation.
                const flip = !profile && (bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0;
                for (let vertex = 0; vertex < 3; vertex++) {
                    const from = index + (flip && vertex ? 3 - vertex : vertex) * 3;
                    const to = offset + vertex * 3, uv = to / 3 * 2;
                    positions[to] = source[from]; positions[to + 1] = source[from + 1]; positions[to + 2] = source[from + 2];
                    if (profile) {
                        uvs[uv] = data.uvs[from / 3 * 2]; uvs[uv + 1] = data.uvs[from / 3 * 2 + 1];
                    } else {
                        uvs[uv] = positions[to] * uvScale; uvs[uv + 1] = positions[to + 2] * uvScale;
                        normals[to + 1] = 1;
                    }
                }
            }
            const clipped = openingRead
                ? yield* clipReceiverOpeningsSteps({ geometry: { positions, uvs, ...(normals ? { normals } : {}) }, openingRead,
                    claim: claim || openingClaim || material?.userData?.surfaceClaim, maxVertices: openingMaxVertices,
                    maxTriangles: Math.floor(openingMaxVertices / 3), now, isCurrent })
                : { positions, uvs };
            const outputPositions = clipped.positions || positions;
            const outputUvs = clipped.uvs || uvs;
            if (!outputPositions.length || clipped.indices?.length === 0) continue;
            const geometry = new THREE.BufferGeometry(); owned.add(geometry);
            geometry.setAttribute('position', new THREE.BufferAttribute(outputPositions, 3));
            geometry.setAttribute('uv', new THREE.BufferAttribute(outputUvs, 2));
            if (clipped.indices) geometry.setIndex(new THREE.BufferAttribute(clipped.indices, 1));
            if (profile) geometry.computeVertexNormals();
            else geometry.setAttribute('normal', new THREE.BufferAttribute(clipped.normals || normals, 3));
            geometry.computeBoundingSphere();
            const mesh = new THREE.Mesh(geometry, openingRead ? materialForGeometry(material) : material);
            mesh.name = name; mesh.receiveShadow = true;
            mesh.userData.walkableSurface = walkableSurface;
            if (!profile) { mesh.userData.surfaceType = surfaceType; mesh.renderOrder = renderOrder; }
            if (claim) markSurfaceClaim?.(mesh, claim);
            root.add(mesh);
            if (walkableSurface) support.push({ positions: outputPositions, indices: clipped.indices || null });
            yield { phase: 'curb-mesh-chunk' }; started = now();
        }
        return isCurrent();
    }
    try {
        if (!(yield* add(state.curb, materials.curb, 'CurbProfile', null,
            { profile: true, walkableSurface: true }))) return null;
        // The existing manhole factory is bounded by the same triangle chunk
        // size. It supplies only geometry/material metadata, no world rules.
        const manholes = state.manholes;
        if (buildManholeMesh && manholes?.positions?.length) {
            if (manholes.positions.length % 9 !== 0) throw new TypeError('Manholes require complete triangles');
            for (let start = 0; start < manholes.positions.length; start += chunkValues) {
                if (!isCurrent()) return null;
                const end = Math.min(manholes.positions.length, start + chunkValues);
                const mesh = buildManholeMesh({ positions: manholes.positions.slice(start, end),
                    uvs: manholes.uvs.slice(start / 3 * 2, end / 3 * 2) });
                if (mesh) {
                    // Take ownership before clipping can yield or throw.
                    mesh.traverse(object => { if (object.geometry) owned.add(object.geometry); });
                    if (openingRead && mesh.geometry?.getAttribute?.('position')) {
                        const sourceGeometry = mesh.geometry;
                        const position = sourceGeometry.getAttribute('position');
                        const uv = sourceGeometry.getAttribute('uv');
                        const normal = sourceGeometry.getAttribute('normal');
                        const clipped = yield* clipReceiverOpeningsSteps({
                            geometry: {
                                positions: position.array,
                                ...(uv ? { uvs: uv.array } : {}),
                                ...(normal ? { normals: normal.array } : {}),
                                ...(sourceGeometry.index ? { indices: sourceGeometry.index.array } : {}),
                            }, openingRead,
                            claim: mesh.material?.userData?.surfaceClaim || openingClaim,
                            maxVertices: openingMaxVertices,
                            maxTriangles: Math.floor(openingMaxVertices / 3), now, isCurrent,
                        });
                        if (!clipped.positions.length || clipped.indices?.length === 0) {
                            sourceGeometry.dispose(); owned.delete(sourceGeometry); continue;
                        }
                        if (clipped.positions !== position.array
                            || (clipped.indices && clipped.indices !== sourceGeometry.index?.array)) {
                            const replacement = new THREE.BufferGeometry();
                            replacement.setAttribute('position', new THREE.BufferAttribute(clipped.positions, 3));
                            if (clipped.uvs) replacement.setAttribute('uv', new THREE.BufferAttribute(clipped.uvs, 2));
                            if (clipped.normals) replacement.setAttribute('normal', new THREE.BufferAttribute(clipped.normals, 3));
                            if (clipped.indices) replacement.setIndex(new THREE.BufferAttribute(clipped.indices, 1));
                            replacement.computeBoundingSphere();
                            mesh.geometry = replacement;
                            owned.add(replacement);
                            sourceGeometry.dispose(); owned.delete(sourceGeometry);
                        }
                        mesh.material = materialForGeometry(mesh.material);
                    }
                    mesh.traverse(object => { if (object.geometry) owned.add(object.geometry); });
                    root.add(mesh);
                }
                yield { phase: 'curb-manhole-chunk' };
            }
        }
        if (!(yield* add(state.ramp, materials.ramp, 'CurbRamp', uvPerM.ramp))) return null;
        if (!(yield* add(state.greenRamp, materials.greenRamp, 'CurbGreenRamp', uvPerM.greenRamp,
            { surfaceType: 'green' }))) return null;
        if (!(yield* add(state.terrainSeam, materials.terrainSeam, 'CurbTerrainSeam', uvPerM.terrainSeam,
            { surfaceType: 'terrain', walkableSurface: true, claim: claims.terrainSeam,
                renderOrder: renderOrders.roadEarthwork }))) return null;
        if (!isCurrent()) return null;
        handedOff = true;
        if (!root.children.length) return { root: null, collisionSurface: null };
        return { root, collisionSurface: { tileKey: state.tileKey, bounds: { ...state.bounds },
            positions: support[0]?.positions, indices: support[0]?.indices,
            additionalPositions: support.slice(1).map(value => value.positions),
            additionalIndices: support.slice(1).map(value => value.indices) } };
    } finally {
        if (!handedOff) for (const geometry of owned) geometry.dispose();
    }
}
