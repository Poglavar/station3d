// Shared static geometry for the Blender TMK. Doors and gameplay handles stay
// in tram.js; the generator fits this body to that factory's physical contract.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { registerShared, unregisterShared } from '../../core/dispose.js';
import { TMK_2400_FLEET_GEOMETRY as source } from './tmk-2400-fleet-geometry.js';

let prepared = null;
let probeMaterial = null;
const farCache = new Map();

function materialRole(name) {
    if (name === 'Paint_zet') return 'body';
    if (name === 'Glass') return 'glass';
    if (name === 'Lamp') return 'headlight';
    if (name === 'TailLamp') return 'taillight';
    return 'details';
}

function geometries() {
    if (prepared) return prepared;
    const buckets = new Map();
    for (const group of source.groups) {
        const role = materialRole(group.material);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
        geometry.setIndex(group.indices);
        geometry.computeVertexNormals();
        if (role === 'details') {
            const color = source.materials[group.material].color;
            const colors = new Float32Array(group.positions.length);
            for (let index = 0; index < colors.length; index += 3) colors.set(color, index);
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }
        if (!buckets.has(role)) buckets.set(role, []);
        buckets.get(role).push(geometry);
    }
    prepared = new Map();
    for (const [role, parts] of buckets) {
        const geometry = mergeGeometries(parts, false);
        for (const part of parts) part.dispose();
        if (!geometry) throw new Error(`Cannot batch TMK ${role}`);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        registerShared(geometry);
        prepared.set(role, geometry);
    }
    return prepared;
}

export function addTramFleetBody(group, materials) {
    for (const [role, geometry] of geometries()) {
        const mesh = new THREE.Mesh(geometry, materials[role]);
        mesh.name = `TramFleet_${role}`;
        mesh.castShadow = role === 'body' || role === 'details';
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
    }
    group.userData.fleetStudy = source.id;
}

// Mount the destination plate and enemy markings on the actual new shell.
// These few factory-time probes never read terrain or session state.
export function tramFleetSurface(origin, direction) {
    probeMaterial ||= new THREE.MeshBasicMaterial();
    const ray = new THREE.Raycaster(origin, direction);
    let closest = null;
    for (const role of ['body', 'glass']) {
        const mesh = new THREE.Mesh(geometries().get(role), probeMaterial);
        const hit = ray.intersectObject(mesh, false)[0];
        if (hit && (!closest || hit.distance < closest.distance)) closest = hit;
    }
    if (!closest) throw new Error('No TMK mounting surface');
    return { point: closest.point, normal: closest.face.normal.clone() };
}

export function tramFleetFarGeometry(bodyColor) {
    const key = bodyColor.getHex();
    if (farCache.has(key)) return farCache.get(key);
    const parts = [];
    const add = (geometry, color) => {
        if (geometry.index) {
            const original = geometry;
            geometry = original.toNonIndexed();
            original.dispose();
        }
        geometry.deleteAttribute('uv');
        const colors = new Float32Array(geometry.attributes.position.count * 3);
        const rgb = color.toArray();
        for (let index = 0; index < colors.length; index += 3) colors.set(rgb, index);
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        parts.push(geometry);
    };
    const dark = new THREE.Color(0x222c35);
    const shape = new THREE.Shape();
    const outline = [[-.75,-10.4],[.75,-10.4],[1.2,-8.05],[1.2,8.05],
        [.75,10.4],[-.75,10.4],[-1.2,8.05],[-1.2,-8.05]];
    outline.forEach(([x, z], index) => index ? shape.lineTo(x, -z) : shape.moveTo(x, -z));
    shape.closePath();
    const body = new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false, curveSegments: 1 });
    body.rotateX(-Math.PI / 2);
    body.translate(0, .4, 0);
    add(body, bodyColor);
    const box = (w, h, l, x, y, z, color = dark) => {
        add(new THREE.BoxGeometry(w, h, l).translate(x, y, z), color);
    };
    box(2.25, .28, 16.1, 0, 3.54, 0);
    box(1.95, .4, 19.8, 0, .2, 0);
    for (const side of [-1, 1]) {
        box(.015, 1.1, 16, side * 1.202, 2.3, 0);
        box(1.2, .8, .015, 0, 2.25, side * 10.405);
    }
    box(.08, 2.0, .08, 0, 4.72, 0);
    box(1.8, .06, .18, 0, 5.72, 0);
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!geometry) throw new Error('Cannot batch distant TMK');
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    registerShared(geometry);
    farCache.set(key, geometry);
    return geometry;
}

export function disposeTramFleetGeometry() {
    for (const geometry of [...(prepared?.values() || []), ...farCache.values()]) {
        unregisterShared(geometry);
        geometry.dispose();
    }
    prepared = null;
    farCache.clear();
    probeMaterial?.dispose();
    probeMaterial = null;
}
