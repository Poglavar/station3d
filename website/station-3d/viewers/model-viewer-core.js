// Viewer state and geometry inspection, independent of the DOM and renderer.
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { disposeGroup, isShared } from '../core/dispose.js';

export const MODEL_FORMATS = Object.freeze(['glb', 'gltf', 'blend', 'json', 'js', 'mjs', 'obj', 'fbx', 'stl', 'ply', 'dae']);

export function modelFormat(name) {
    const extension = String(name).split(/[?#]/)[0].split('.').pop().toLowerCase();
    if (!MODEL_FORMATS.includes(extension)) throw new Error(`Unsupported model format: ${extension}. Choose ${MODEL_FORMATS.join(', ')}.`);
    return extension;
}

export function normalizePreview(value) {
    if (value?.isBufferGeometry) value = new THREE.Mesh(value, new THREE.MeshStandardMaterial({ color: 0xb5c6bd, side: THREE.DoubleSide }));
    const preview = value?.isObject3D ? { object: value } : { ...value };
    preview.object ??= preview.scene ?? preview.root ?? preview.group;
    if (!preview.object?.isObject3D) throw new Error('The model must return a Three.js Object3D, Mesh, Group, Scene, BufferGeometry, or a preview with an object property.');
    preview.controls ??= [];
    preview.cameraViews ??= {};
    preview.animations ??= preview.object.animations ?? [];
    return preview;
}

export function controlDefaults(controls = []) {
    return Object.fromEntries(controls.map(control => [control.id, control.value]));
}

// Keep caller-owned meshes reusable across selection and comparison. Geometry,
// materials and texture objects belong to the preview; image data stays borrowed.
export function copyModelPreview(value) {
    const source = normalizePreview(value);
    if (source.update || source.seek || source.dispose) throw new Error('Pass a factory function for an animated preview adapter so each view has its own state.');
    const object = cloneSkeleton(source.object);
    const geometries = new Map(), materials = new Map(), textures = new Map();
    const copyMaterial = material => {
        if (!materials.has(material)) {
            const copy = material.clone();
            for (const [key, texture] of Object.entries(copy)) {
                if (!texture?.isTexture) continue;
                if (!textures.has(texture)) textures.set(texture, texture.clone());
                copy[key] = textures.get(texture);
            }
            materials.set(material, copy);
        }
        return materials.get(material);
    };
    object.traverse(part => {
        if (part.geometry) {
            if (!geometries.has(part.geometry)) geometries.set(part.geometry, part.geometry.clone());
            part.geometry = geometries.get(part.geometry);
        }
        if (part.material) part.material = Array.isArray(part.material) ? part.material.map(copyMaterial) : copyMaterial(part.material);
    });
    return { ...source, object, borrowedImages: true };
}

export function modelBounds(object) {
    object.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3();
    const vertex = new THREE.Vector3();
    object.traverseVisible(part => {
        if (!part.geometry) return;
        if (part.isInstancedMesh) {
            part.computeBoundingBox();
            if (part.boundingBox) bounds.union(part.boundingBox.clone().applyMatrix4(part.matrixWorld));
        } else {
            // Bounds are inspected on selection/reframing. Measure the actual
            // posed surface: rotated AABB corners can sit below every vertex,
            // making a pitched airplane float when the viewer grounds it.
            const positions = part.geometry.getAttribute('position');
            for (let index = 0; index < (positions?.count || 0); index++) {
                if (part.isMesh) part.getVertexPosition(index, vertex);
                else vertex.fromBufferAttribute(positions, index);
                bounds.expandByPoint(vertex.applyMatrix4(part.matrixWorld));
            }
        }
    });
    if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
        throw new Error('This model has no visible, finite geometry.');
    }
    return bounds;
}

export function inspectModel(object) {
    const bounds = modelBounds(object);
    let meshes = 0, triangles = 0, vertices = 0;
    object.traverseVisible(part => {
        if (!part.isMesh) return;
        meshes++;
        const instances = part.isInstancedMesh ? part.count : 1;
        const count = part.geometry?.attributes?.position?.count || 0;
        vertices += count * instances;
        triangles += (part.geometry?.index?.count ?? count) / 3 * instances;
    });
    return { bounds, dimensions: bounds.getSize(new THREE.Vector3()).toArray(), meshes, triangles: Math.round(triangles), vertices };
}

// A fixed millimetre near plane wastes depth precision when inspecting a
// full-size vehicle. Follow the orbit distance so flush paint remains stable,
// while close face/object inspection can still approach the surface.
export function cameraNearPlane(distance) {
    return Math.max(0.00001, distance / 100);
}

export function fitCamera(bounds, aspect, direction = [1, 0.65, 1.4], fov = 38) {
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.025);
    const angle = Math.min(THREE.MathUtils.degToRad(fov / 2), Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) * Math.max(aspect, 0.05)));
    const distance = radius / Math.sin(angle) * 1.12;
    const target = bounds.getCenter(new THREE.Vector3());
    const position = new THREE.Vector3(...direction).normalize().multiplyScalar(distance).add(target);
    return { target, position, near: cameraNearPlane(distance), far: Math.max(100, distance * 20), fov };
}

// Shared factory resources stay owned by their factories. Imported PBR textures
// can occupy any map slot, so also release maps beyond the engine's diffuse map.
export function disposePreview(preview) {
    if (!preview) return;
    preview.dispose?.();
    const textures = new Set();
    const images = new Set();
    const skeletons = new Set();
    preview.object.traverse(part => {
        if (part.skeleton && !skeletons.has(part.skeleton)) {
            skeletons.add(part.skeleton);
            part.skeleton.dispose();
        }
        for (const material of [].concat(part.material || [])) {
            if (isShared(material)) continue;
            for (const [key, texture] of Object.entries(material)) {
                if (!texture?.isTexture || isShared(texture) || textures.has(texture)) continue;
                textures.add(texture);
                if (key !== 'map') texture.dispose();
                for (const data of [].concat(texture.source?.data || [])) {
                    if (data && typeof data.close === 'function') images.add(data);
                }
            }
        }
    });
    disposeGroup(preview.object);
    if (!preview.borrowedImages) for (const data of images) data.close();
}

export { readViewerLink } from './model-viewer-links.js';
