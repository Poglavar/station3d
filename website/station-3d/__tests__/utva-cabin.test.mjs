// Exercise the exported cabin, including real sight lines through its windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createModelImporter } from '../viewers/model-import.js';
import { disposePreview, modelBounds } from '../viewers/model-viewer-core.js';

// Regression coverage for the exported UTVA cabin: pilot/cargo placement and windshield openings.
const file = fileURLToPath(new URL('../models/vehicles/utva-liaison.glb', import.meta.url));

function localBounds(object) {
    const box = new THREE.Box3();
    object.updateWorldMatrix(true, true);
    object.traverse(part => {
        if (!part.isMesh) return;
        const position = part.geometry.getAttribute('position');
        for (let i = 0; i < position.count; i++) box.expandByPoint(object.worldToLocal(part.localToWorld(new THREE.Vector3().fromBufferAttribute(position, i))));
    });
    return box;
}

function opaqueFuselageHits(root, from, to) {
    const fuselage = root.getObjectByName('Fuselage');
    const meshes = [];
    fuselage?.traverse(part => { if (part.isMesh) { part.material.side = THREE.DoubleSide; meshes.push(part); } });
    root.updateWorldMatrix(true, true);
    const a = root.localToWorld(new THREE.Vector3(...from));
    const b = root.localToWorld(new THREE.Vector3(...to));
    const delta = b.clone().sub(a);
    const distance = delta.length();
    return new THREE.Raycaster(a, delta.normalize(), .001, distance).intersectObjects(meshes, false);
}

function meshVertices(root, mesh) {
    root.updateWorldMatrix(true, true);
    const matrix = root.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const position = mesh.geometry.getAttribute('position'), normal = mesh.geometry.getAttribute('normal');
    return Array.from({ length: position.count }, (_, i) => ({
        point: new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix),
        normal: normal && new THREE.Vector3().fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize(),
    }));
}

function paneTopology(root, pane) {
    const vertices = [], weld = new Map();
    const original = meshVertices(root, pane).map(vertex => {
        const key = vertex.point.toArray().map(n => Math.round(n * 1e5)).join(',');
        if (!weld.has(key)) { weld.set(key, vertices.length); vertices.push(vertex); }
        return weld.get(key);
    });
    const index = pane.geometry.index.array, edges = new Map();
    for (let i = 0; i < index.length; i += 3) {
        const face = [original[index[i]], original[index[i + 1]], original[index[i + 2]]];
        assert.equal(new Set(face).size, 3, `${pane.name} has no collapsed triangles`);
        for (const [a, b] of [[face[0], face[1]], [face[1], face[2]], [face[2], face[0]]]) {
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            edges.set(key, (edges.get(key) || 0) + 1);
        }
    }
    const neighbours = new Map();
    for (const [key, count] of edges) {
        assert.ok(count <= 2, `${pane.name} has manifold edges`);
        if (count !== 1) continue;
        const [a, b] = key.split(':').map(Number);
        if (!neighbours.has(a)) neighbours.set(a, []);
        if (!neighbours.has(b)) neighbours.set(b, []);
        neighbours.get(a).push(b); neighbours.get(b).push(a);
    }
    assert.ok(neighbours.size > 16, `${pane.name} has a tessellated outer boundary`);
    assert.ok([...neighbours.values()].every(adjacent => adjacent.length === 2), `${pane.name} boundary has no cracks or branches`);
    const first = neighbours.keys().next().value, loop = [first];
    let previous = -1, current = first;
    do {
        const next = neighbours.get(current).find(id => id !== previous);
        previous = current; current = next;
        if (current !== first) loop.push(current);
        assert.ok(loop.length <= neighbours.size, `${pane.name} boundary closes`);
    } while (current !== first);
    assert.equal(loop.length, neighbours.size, `${pane.name} has one boundary, without extra holes`);
    assert.equal(vertices.length - edges.size + index.length / 3, 1, `${pane.name} is a connected disk`);
    return { vertices, boundary: loop.map(id => vertices[id].point) };
}
test('UTVA exported cabin contains durable pilot, seat, cargo and instrument geometry', async () => {
    const importer = await createModelImporter(null);
    const bytes = fs.readFileSync(file);
    const preview = await importer.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'glb');
    try {
        for (const name of ['Pilot', 'Seats', 'InstrumentPanel', 'CabinFloor', 'CabinRearBulkhead', 'Cargo']) {
            assert.ok(preview.object.getObjectByName(name), name);
        }
        assert.equal(preview.object.getObjectByName('Ground'), undefined);
        const pilot = preview.object.getObjectByName('Pilot');
        const cargo = preview.object.getObjectByName('Cargo');
        const root = preview.object.getObjectByName('UTVA_Liaison');
        const pb = localBounds(pilot), cb = localBounds(cargo);
        assert.ok(pb.max.y <= 1.643 + .01 && pb.min.y >= .52 - .01, 'pilot fits the cabin height');
        assert.ok(cb.min.z >= -1.0 - .01, 'cargo stays behind the seatback');
        assert.ok(Math.abs(cb.min.y - .52) <= .01, 'cargo rests on the cabin floor');
        assert.ok(Math.abs(localBounds(preview.object.getObjectByName('Seats')).min.y - .52) <= .01, 'seats rest on the floor');
        const leftLeg = localBounds(root.getObjectByName('Pilot_11_PersonLegLeft'));
        assert.ok(leftLeg.min.z < -1.49 && leftLeg.min.y > .69, 'the seated knee projects forward, with the shin bent down');
        assert.equal(opaqueFuselageHits(root, [-.24, 1.555, -1.37], [-.24, 1.63, -2.66]).length, 0, 'front windshield is clear');
        for (const side of [-1, 1]) assert.equal(opaqueFuselageHits(root, [0, 1.48, -1.32], [side * .8, 1.48, -1.32]).length, 0, `side windshield ${side} is clear`);
        for (const name of ['Windscreen', 'SideFront-1', 'SideFront1', 'SideRear-1', 'SideRear1', 'Quarter-1', 'Quarter1']) {
            const pane = root.getObjectByName(name);
            assert.ok(pane.material.transparent && pane.material.opacity > .1 && pane.material.opacity < .4, `${name} retains visible clear glazing`);
            const { vertices, boundary } = paneTopology(root, pane);
            const frame = root.getObjectByName(`${name}Frame`); assert.ok(frame, `${name} has a matching frame`);
            const framePoints = [], bodyPoints = [];
            frame.traverse(part => { if (part.isMesh) framePoints.push(...meshVertices(root, part).map(v => v.point)); });
            root.getObjectByName('Fuselage').traverse(part => { if (part.isMesh) bodyPoints.push(...meshVertices(root, part).map(v => v.point)); });
            const coincides = (point, others) => others.some(other => point.distanceToSquared(other) <= 3e-5 ** 2);
            assert.ok(boundary.every(point => coincides(point, framePoints)), `${name} glass and seal share every edge vertex`);
            const uniqueFrame = [...new Map(framePoints.map(p => [p.toArray().map(n => Math.round(n * 1e5)).join(','), p])).values()];
            assert.ok(uniqueFrame.filter(point => coincides(point, bodyPoints)).length >= boundary.length * .9, `${name} seal meets the body along its outer edge`);
            const a = boundary[0], b = boundary[Math.floor(boundary.length / 3)], c = boundary[Math.floor(boundary.length * 2 / 3)];
            const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
            assert.ok(vertices.some(v => Math.abs(v.point.clone().sub(a).dot(normal)) > .007), `${name} curves with the fuselage`);
            // Curved windows need their own local normals. Sampling a flat
            // normal at the gasket edge would hit the adjacent body by design.
            const interior = vertices.filter(v => boundary.every(p => p.distanceTo(v.point) > .06));
            assert.ok(interior.length >= 12, `${name} has enough interior samples`);
            for (let i = 0; i < 12; i++) {
                const { point, normal } = interior[Math.floor(i * interior.length / 12)];
                const from = point.clone().addScaledVector(normal, -.055), to = point.clone().addScaledVector(normal, .055);
                assert.equal(opaqueFuselageHits(root, from.toArray(), to.toArray()).length, 0, `${name} has no body underneath its glass at ${point.toArray()}`);
            }
        }
        assert.ok(opaqueFuselageHits(root, [0, .96, -1.32], [.8, .96, -1.32]).length > 0, 'body wall remains below the side window');
        assert.ok(opaqueFuselageHits(root, [-.24, 1.65, -1.28], [-.24, 2.1, -1.28]).length > 0, 'the cabin has an opaque ceiling above the pilot');
        const ceilingFrom = root.localToWorld(new THREE.Vector3(-.24, 1.65, -1.28));
        const ceilingTo = root.localToWorld(new THREE.Vector3(-.24, 2.1, -1.28));
        const ceilingDirection = ceilingTo.sub(ceilingFrom);
        const ceiling = new THREE.Raycaster(ceilingFrom, ceilingDirection.normalize(), .001, .45).intersectObject(root, true)[0];
        assert.equal(ceiling.object.material.name, 'CabinLining', 'wing paint must remain outside the interior ceiling');
        for (const side of [-1, 1]) {
            const outer = opaqueFuselageHits(root, [side, 1.55, -1.64], [0, 1.55, -1.64])[0];
            assert.ok(outer, 'the solid pillar separates the front and side windows');
            assert.equal(outer.object.material.name, 'Airframe', 'the windscreen pillar has airframe paint outside and lining inside');
        }
        for (const name of ['Wheel', 'Wheel001', 'TailWheel']) {
            const wheel = root.getObjectByName(name);
            assert.ok(wheel, name);
            const vertices = wheel.geometry.getAttribute('position');
            let groundY = Infinity;
            for (let index = 0; index < vertices.count; index++) groundY = Math.min(groundY, wheel.localToWorld(new THREE.Vector3().fromBufferAttribute(vertices, index)).y);
            assert.ok(groundY >= -.001 && groundY < .02, `${name} supports the parked airplane on the ground (${groundY})`);
        }
        assert.ok(Math.abs(modelBounds(preview.object).min.y) < .001, 'viewer framing uses the real ground contact, not an empty AABB corner');
    } finally { disposePreview(preview); importer.dispose(); }
});

test('UTVA nickname and callsign are readable paint on both sides and beneath the left wing', async () => {
    const importer = await createModelImporter(null);
    const bytes = fs.readFileSync(file);
    const preview = await importer.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'glb');
    try {
        const root = preview.object.getObjectByName('UTVA_Liaison');
        root.updateWorldMatrix(true, true);
        const markings = root.getObjectByName('Markings');
        assert.equal(markings.children.length, 5, 'two nicknames, two fuselage callsigns and one wing callsign');
        const bounds = new Map();
        for (const [name, text, bodyName] of [
            ['NicknamePort', 'Mister Ne', 'Fuselage'],
            ['NicknameStarboard', 'Mister Ne', 'Fuselage'],
            ['CallsignPort', 'KRJ-MČR', 'Fuselage'],
            ['CallsignStarboard', 'KRJ-MČR', 'Fuselage'],
            ['CallsignWingUnderside', 'KRJ-MČR', 'Wing'],
        ]) {
            const mesh = markings.getObjectByName(name);
            assert.ok(mesh?.isMesh, `${name} is durable geometry, independent of runtime fonts`);
            assert.equal(mesh.userData.marking_text, text);
            const vertices = meshVertices(root, mesh);
            const box = new THREE.Box3().setFromPoints(vertices.map(v => v.point));
            bounds.set(name, box);
            assert.ok(vertices.length > 50, `${name} contains real letter outlines`);
            const body = root.getObjectByName(bodyName);
            const triangles = mesh.geometry.index.array;
            for (let i = 0; i < 24; i++) {
                const face = Math.floor(i * (triangles.length / 3) / 24) * 3;
                const corners = [0, 1, 2].map(j => vertices[triangles[face + j]]);
                const center = corners.reduce((sum, v) => sum.add(v.point), new THREE.Vector3()).divideScalar(3);
                const normal = corners.reduce((sum, v) => sum.add(v.normal), new THREE.Vector3()).normalize();
                const origin = root.localToWorld(center.clone().addScaledVector(normal, .012));
                const direction = normal.clone().negate().transformDirection(root.matrixWorld);
                const hit = new THREE.Raycaster(origin, direction, 0, .030).intersectObject(body, true)[0];
                assert.ok(hit, `${name} stays on its supporting surface`);
                const gap = hit.distance - .012;
                assert.ok(gap > .00005 && gap < .003, `${name} paint stays just above the skin without clipping or floating (${gap} m)`);
            }
        }
        for (const prefix of ['Nickname', 'Callsign']) {
            const port = bounds.get(`${prefix}Port`), starboard = bounds.get(`${prefix}Starboard`);
            assert.ok(port.max.x < -.1 && starboard.min.x > .1, `${prefix} appears on both fuselage sides`);
            assert.ok(Math.abs(port.min.x + starboard.max.x) < .005, `${prefix} placement is symmetric`);
            assert.ok(Math.abs(port.min.z - starboard.min.z) < .005, `${prefix} shares the same longitudinal position`);
        }
        const nickname = bounds.get('NicknamePort').getSize(new THREE.Vector3());
        const callsign = bounds.get('CallsignPort').getSize(new THREE.Vector3());
        assert.ok(nickname.y < callsign.y * .4 && nickname.y < .07, 'the nickname is small beside the larger callsign');
        assert.ok(bounds.get('CallsignWingUnderside').max.x < -1, 'wing marking occupies the left wing');
    } finally { disposePreview(preview); importer.dispose(); }
});
