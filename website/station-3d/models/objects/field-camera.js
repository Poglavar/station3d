// A bulky mid-century press camera with a flash gun: leatherette box body,
// a stubby lens barrel, a top viewfinder hump and a polished reflector dish
// on a stalk beside it. Built once as one vertex-coloured geometry so a whole
// plaza of them draws as a single instanced mesh; the group factory is the
// same prop for the model viewer and for anyone holding it by hand. The
// camera faces local +Z, like the people who carry it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const FIELD_CAMERA_SIZE_M = Object.freeze({ widthM: 0.15, heightM: 0.10, depthM: 0.085 });

// Where the bulb sits, in camera space: the reflector's open face.
export const FIELD_CAMERA_FLASH_ORIGIN = Object.freeze({ x: 0.115, y: 0.085, z: 0.03 });

const LEATHERETTE = 0x2a2724;
const BLACK_METAL = 0x121212;
const CHROME = 0xd6d9dc;

function colouredPart(geometry, hex, position, rotation = null) {
    const colour = new THREE.Color(hex);
    const count = geometry.getAttribute('position').count;
    const colours = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
        colours[index * 3] = colour.r;
        colours[index * 3 + 1] = colour.g;
        colours[index * 3 + 2] = colour.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    if (rotation) {
        geometry.rotateX(rotation[0]);
        geometry.rotateY(rotation[1]);
        geometry.rotateZ(rotation[2]);
    }
    geometry.translate(position[0], position[1], position[2]);
    return geometry;
}

function buildParts() {
    const { widthM, heightM, depthM } = FIELD_CAMERA_SIZE_M;
    const half = Math.PI / 2;
    return [
        colouredPart(new THREE.BoxGeometry(widthM, heightM, depthM), LEATHERETTE, [0, 0, 0]),
        // Lens barrel and its chrome trim ring on the front face.
        colouredPart(new THREE.CylinderGeometry(0.026, 0.026, 0.04, 12), BLACK_METAL, [0, -0.004, depthM / 2 + 0.02], [half, 0, 0]),
        colouredPart(new THREE.CylinderGeometry(0.031, 0.031, 0.008, 12), CHROME, [0, -0.004, depthM / 2 + 0.006], [half, 0, 0]),
        // Viewfinder hump on the top-left corner.
        colouredPart(new THREE.BoxGeometry(0.034, 0.024, 0.03), BLACK_METAL, [-0.045, heightM / 2 + 0.012, -0.012]),
        // Flash gun: a stalk up the right side carrying the reflector dish,
        // which opens forward and outshines the body when the bulb fires.
        colouredPart(new THREE.CylinderGeometry(0.007, 0.007, 0.11, 8), BLACK_METAL, [0.09, 0.03, -0.01]),
        colouredPart(new THREE.CylinderGeometry(0.06, 0.016, 0.04, 14), CHROME, [0.115, 0.085, 0.01], [half, 0, 0]),
    ];
}

// One merged, vertex-coloured geometry for instancing. Pair it with a
// `vertexColors: true` material; the caller owns and disposes it.
export function createFieldCameraGeometry() {
    const parts = buildParts();
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

export function createFieldCameraMaterial() {
    return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 });
}

export function createFieldCameraMesh() {
    const group = new THREE.Group();
    group.name = 'FieldCamera';
    const mesh = new THREE.Mesh(createFieldCameraGeometry(), createFieldCameraMaterial());
    mesh.name = 'FieldCameraBody';
    mesh.castShadow = true;
    group.add(mesh);
    return group;
}
