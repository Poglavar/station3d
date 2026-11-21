// Exercise the shared detailed tram's geometry, doors, lighting and lifecycle.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { disposeGroup } from '../core/dispose.js';

// The line plate is deliberately part of the factory contract.  Keep this
// tiny DOM surface here instead of weakening the production factory for Node.
globalThis.document = {
    createElement(type) {
        assert.equal(type, 'canvas');
        return {
            width: 0, height: 0,
            getContext: () => ({ fillStyle: '', font: '', textAlign: '', textBaseline: '', lineWidth: 0, fillRect() {}, fillText() {}, clearRect() {}, strokeRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {} }),
        };
    },
};
globalThis.performance ||= { now: () => 0 };

const tram = await import('../models/vehicles/tram.js');
const { tramFleetSurface } = await import('../models/vehicles/tmk-2400-detail.js');
const { TMK_2400_FLEET_GEOMETRY: source } = await import('../models/vehicles/tmk-2400-fleet-geometry.js');

function pantographSteelComponents(data) {
    const group = data.groups.find(item => item.material === 'Steel');
    const points = [];
    const triangles = [];
    const byPosition = new Map();
    const neighbors = [];
    for (let i = 0; i < group.indices.length; i += 3) {
        const vertices = group.indices.slice(i, i + 3).map(index =>
            group.positions.slice(index * 3, index * 3 + 3));
        if (vertices.some(point => point[1] <= 3.45)) continue;
        const triangle = vertices.map(point => {
            const key = point.join(',');
            if (!byPosition.has(key)) {
                byPosition.set(key, points.length);
                points.push(new THREE.Vector3(...point));
                neighbors.push(new Set());
            }
            return byPosition.get(key);
        });
        triangles.push(triangle);
        for (const a of triangle) for (const b of triangle) neighbors[a].add(b);
    }
    // A solid bar is connected by its triangles even when its end vertices
    // are metres apart. Then join separate bars only at nearby real surfaces.
    const seen = new Uint8Array(points.length);
    const components = [];
    for (let start = 0; start < points.length; start++) {
        if (seen[start]) continue;
        const queue = [start];
        const component = new Set();
        seen[start] = 1;
        while (queue.length) {
            const index = queue.pop();
            component.add(index);
            for (const other of neighbors[index]) {
                if (!seen[other]) { seen[other] = 1; queue.push(other); }
            }
        }
        components.push(component);
    }
    const closest = new THREE.Vector3();
    const face = new THREE.Triangle();
    const touches = (a, b) => [...a].some(index => triangles.some(triangle => {
        if (!b.has(triangle[0])) return false;
        face.set(...triangle.map(vertex => points[vertex]));
        face.closestPointToPoint(points[index], closest);
        return closest.distanceTo(points[index]) <= 0.075;
    }));
    for (let a = 0; a < components.length; a++) {
        for (let b = a + 1; b < components.length; b++) {
            if (!touches(components[a], components[b]) && !touches(components[b], components[a])) continue;
            for (const index of components[b]) components[a].add(index);
            components.splice(b, 1);
            b = a; // An added bar may connect an earlier, previously separate part.
        }
    }
    return components.map(component => [...component].map(index => points[index].toArray()));
}

const make = (opts = {}) => {
    const group = tram.createTramMesh('#d71920', '17', opts);
    group.updateMatrixWorld(true);
    return group;
};
const meshes = group => {
    const out = [];
    group.traverse(o => { if (o.isMesh || o.isInstancedMesh) out.push(o); });
    return out;
};

test('default factory selects the TMK fleet study while legacy stays explicit', () => {
    const modern = make();
    const legacy = make({ legacy: true });
    assert.equal(modern.userData.fleetStudy, source.id);
    assert.equal(legacy.userData.fleetStudy, undefined);
    assert.ok(modern.getObjectByName('TramFleet_body'));
    assert.notEqual(legacy.userData.fleetStudy, modern.userData.fleetStudy);
});

test('fleet geometry is finite and within the TMK physical envelope', () => {
    const group = make();
    const box = new THREE.Box3().setFromObject(group);
    assert.ok([box.min, box.max].every(p => p.toArray().every(Number.isFinite)));
    assert.ok(box.max.x - box.min.x <= 2.6);
    assert.ok(box.max.z - box.min.z <= 21);
    assert.ok(box.max.y <= 5.75 + 1e-6);
    assert.ok(box.min.y >= -1e-6);
    assert.ok(group.userData.tramHalfWidthM <= 1.3);
});

test('pantograph steel is one connected assembly from roof support to contact shoe', () => {
    const assembly = pantographSteelComponents(source).find(component =>
        Math.min(...component.map(point => point[1])) < 3.55
        && Math.max(...component.map(point => point[1])) >= 5.75);
    assert.ok(assembly, 'pantograph arms/support/shoe must connect within 7.5cm');
});

test('right-side open doors clear the body at all four door centres', () => {
    const group = make();
    tram.setTramDoorsOpen(group, 1);
    group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    for (const z of [-7.072, -2.392, 2.392, 7.072]) {
        ray.set(new THREE.Vector3(2, 1.75, z), new THREE.Vector3(-1, 0, 0));
        const hits = ray.intersectObjects([group.getObjectByName('TramFleet_body'), group.getObjectByName('TramFleet_glass')], false);
        assert.ok(!hits.some(hit => hit.distance < 1.25), `open doorway at z=${z} still has an own-side shell hit`);
        assert.ok(hits.some(hit => hit.distance > 3 && hit.distance < 3.3),
            `open doorway at z=${z} must reveal the inside of the opposite window`);
    }
    tram.setTramDoorsOpen(group, 0);
    group.updateMatrixWorld(true);
    for (const z of [-7.072, -2.392, 2.392, 7.072]) {
        ray.set(new THREE.Vector3(2, 1.75, z), new THREE.Vector3(-1, 0, 0));
        const hits = ray.intersectObjects([group.getObjectByName('TramDoorLeaves'), group.getObjectByName('TramDoorWindows')], false);
        assert.ok(hits.some(hit => hit.distance < 1.25 && hit.object.name.startsWith('TramDoor')), `closed doorway at z=${z} misses its leaf/window`);
        for (const dz of [-0.2, 0.2]) {
            ray.set(new THREE.Vector3(2, 1.75, z + dz), new THREE.Vector3(-1, 0, 0));
            const leafHits = ray.intersectObject(group.getObjectByName('TramDoorLeaves'), false);
            assert.ok(leafHits.some(hit => hit.distance < 1.25), `closed leaf coverage misses z=${z + dz}`);
        }
    }
    for (const z of [-7.072, -2.392, 2.392, 7.072]) {
        ray.set(new THREE.Vector3(-2, 1.75, z), new THREE.Vector3(1, 0, 0));
        const hits = ray.intersectObjects([group.getObjectByName('TramFleet_body'), group.getObjectByName('TramFleet_glass')], false);
        assert.ok(hits.some(hit => hit.distance < 1.25), `left solid exterior misses z=${z}`);
    }
    for (const z of [-5, 0, 5]) {
        ray.set(new THREE.Vector3(2, 2.0, z), new THREE.Vector3(-1, 0, 0));
        const hits = ray.intersectObjects([group.getObjectByName('TramFleet_body'), group.getObjectByName('TramFleet_glass')], false);
        assert.ok(hits.some(hit => hit.distance < 1.25), `between-door ray at z=${z} should reach the right exterior`);
    }
});

test('door leaves and windows are instanced and their matrices move', () => {
    const group = make();
    const leaves = group.getObjectByName('TramDoorLeaves');
    const glass = group.getObjectByName('TramDoorWindows');
    assert.ok(leaves?.isInstancedMesh && glass?.isInstancedMesh);
    const closed = leaves.instanceMatrix.array.slice();
    tram.setTramDoorsOpen(group, 1);
    assert.notDeepEqual(leaves.instanceMatrix.array, closed);
    assert.equal(leaves.geometry, group.userData.doorParts[0].mesh.geometry);
    assert.equal(glass.count, leaves.count);
});

test('shared fleet resources survive instance teardown and rebuild cleanly', () => {
    const a = make();
    const b = make();
    const geometry = a.getObjectByName('TramFleet_body').geometry;
    assert.equal(geometry, b.getObjectByName('TramFleet_body').geometry);
    let geometryDisposed = 0;
    geometry.addEventListener('dispose', () => geometryDisposed++);
    const detailsMaterial = a.getObjectByName('TramFleet_details').material;
    let materialDisposed = 0;
    detailsMaterial.addEventListener('dispose', () => materialDisposed++);
    disposeGroup(a);
    assert.equal(geometryDisposed, 0);
    assert.equal(materialDisposed, 0);
    tram.disposeTramSessionCaches();
    assert.equal(geometryDisposed, 1);
    assert.equal(materialDisposed, 1);
    const c = make();
    assert.notEqual(c.getObjectByName('TramFleet_body').geometry, geometry);
    tram.disposeTramSessionCaches();
});

test('night mode changes shared headlights and taillights', () => {
    const group = make();
    const lamps = ['TramFleet_headlight', 'TramFleet_taillight'].map(name => group.getObjectByName(name));
    assert.ok(lamps.every(Boolean));
    const before = lamps.map(m => m.material.emissiveIntensity);
    tram.setTramNightMode(true);
    assert.ok(lamps.some((m, i) => m.material.emissiveIntensity !== before[i]));
    tram.setTramNightMode(false);
});

test('collision, health and enemy gun metadata remain on the fleet factory', () => {
    const group = make({ enemy: true });
    assert.equal(group.userData.tramHalfWidthM, tram.TRAM_COLLISION_HALF_WIDTH_M);
    assert.equal(group.userData.tramMaxHealth, tram.TRAM_MAX_HEALTH);
    assert.equal(group.userData.tramHealth, tram.TRAM_MAX_HEALTH);
    assert.equal(group.userData.enemyTram, true);
    assert.ok(group.userData.enemyTramWeapon?.muzzle);
});

test('line plate and enemy front decal are mounted against the fleet shell', () => {
    const group = make({ enemy: true });
    const plate = group.getObjectByName('TramLinePlate');
    assert.ok(plate, 'line plate is named for inspection');
    const front = tramFleetSurface(new THREE.Vector3(0, 2.75, -20), new THREE.Vector3(0, 0, 1));
    assert.ok(plate.position.distanceTo(front.point) < 0.05, 'line plate is within 5cm of shell sample');
    assert.ok(plate.getWorldDirection(new THREE.Vector3()).z < -0.5, 'line plate faces outward');
    const decals = meshes(group).filter(mesh => mesh.geometry?.type === 'PlaneGeometry' && mesh !== plate);
    assert.ok(decals.length >= 1, 'enemy front decal plane exists');
    const decalShell = tramFleetSurface(new THREE.Vector3(0, 1.82, -20), new THREE.Vector3(0, 0, 1));
    assert.ok(decals.some(mesh => mesh.position.distanceTo(decalShell.point) < 0.08), 'enemy front decal is near shell');
});

test('detail and far LOD keep bounded draw and triangle counts', () => {
    const group = make();
    const detailCalls = meshes(group).length;
    assert.ok(detailCalls <= 9, `detail pass has ${detailCalls} meshes`);
    tram.updateTramRenderLod(group, 1e9);
    assert.equal(group.userData.renderLod, 'far');
    const far = group.userData.farMesh;
    assert.ok(far);
    const triangles = far.geometry.index ? far.geometry.index.count / 3 : far.geometry.attributes.position.count / 3;
    assert.ok(triangles <= 200, `far LOD has ${triangles} triangles`);
});

after(() => tram.disposeTramSessionCaches());
