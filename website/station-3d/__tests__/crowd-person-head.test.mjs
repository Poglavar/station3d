import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
    personFaceSeed, personHeadProfile, crowdFaceFeatures,
    crowdFaceDetailAtDistance, CROWD_FACE_COUNT,
} from '../core/person-appearance.js';
import { createCrowdFaceAtlas } from '../core/crowd-face-atlas.js';
import {
    createPersonMesh, createRandomPersonMesh, animatePersonWalk,
    disposePersonMeshSessionCaches,
} from '../world/person-mesh.js';
import {
    getPersonHeadGeometry, getPersonHeadMaterial, createInstancedPersonHeadGeometry,
} from '../world/person-head.js';
import { disposeGroup } from '../core/dispose.js';

test('one identity keeps its face through creation, movement and a boarding-style copy', () => {
    const origin = { kind: 'female', faceSeed: personFaceSeed('tram-stop|person|3'), skinColor: 0xc68642 };
    const waiting = personHeadProfile(origin.faceSeed, origin.kind);
    const first = createPersonMesh(origin);
    const boarded = createPersonMesh({ ...origin, x: 32, y: 15, z: -74 });
    const head = first.getObjectByName('PersonHead');
    assert.equal(head.geometry, boarded.getObjectByName('PersonHead').geometry);
    assert.deepEqual(head.scale.toArray(), boarded.getObjectByName('PersonHead').scale.toArray());
    assert.equal(head.geometry.attributes.headVariant.getX(0), waiting.variant);
    const geometry = head.geometry;
    for (let step = 0; step < 20; step++) animatePersonWalk(first, step * 0.2, 1);
    assert.equal(head.geometry, geometry);
    assert.equal(first.userData.faceSeed, origin.faceSeed);
});

test('crowd variation is bounded and covers the palette without facial hair on children', () => {
    const variants = new Set();
    const shapes = new Set();
    for (let seed = 0; seed < 500; seed++) {
        for (const kind of ['male', 'female', 'kid']) {
            const profile = personHeadProfile(seed, kind);
            variants.add(profile.variant);
            shapes.add(profile.width);
            assert.ok(profile.width >= 0.93 && profile.width <= 1.08);
            assert.ok(profile.height >= 0.95 && profile.height <= 1.09);
            if (kind !== 'male') {
                assert.equal(crowdFaceFeatures(profile.variant).beard, false);
                assert.equal(crowdFaceFeatures(profile.variant).moustache, false);
            }
        }
    }
    assert.equal(variants.size, CROWD_FACE_COUNT);
    assert.ok(shapes.size > 450);
});

test('ambient faces retain six body-part meshes, two shadow casters and bounded geometry', () => {
    const person = createRandomPersonMesh(() => 0.42);
    let meshCount = 0, shadows = 0;
    person.traverse(object => {
        if (!object.isMesh) return;
        meshCount++;
        shadows += Number(object.castShadow);
    });
    assert.equal(meshCount, 6);
    assert.equal(shadows, 2);
    const head = person.getObjectByName('PersonHead');
    assert.ok(head.geometry.attributes.position.count / 3 <= 200);
    assert.equal(head.material.transparent, false);
    assert.equal(head.material.alphaTest, 0);
    for (const attribute of Object.values(head.geometry.attributes)) {
        assert.ok(Array.from(attribute.array).every(Number.isFinite));
    }
});

test('different face variants share materials and use one per-instance attribute for crowds', () => {
    const instances = [1, 19, 33, 47, 61];
    const geometry = createInstancedPersonHeadGeometry(instances);
    assert.equal(geometry.attributes.headVariant.isInstancedBufferAttribute, true);
    assert.deepEqual(Array.from(geometry.attributes.headVariant.array), instances);
    const first = createPersonMesh({ faceSeed: 1, skinColor: 0xc68642 });
    const second = createPersonMesh({ faceSeed: 2, skinColor: 0xc68642 });
    assert.equal(first.getObjectByName('PersonHead').material, second.getObjectByName('PersonHead').material);
    assert.equal(getPersonHeadGeometry(33), getPersonHeadGeometry(33));
    geometry.dispose();
});

test('face detail fades smoothly inside the agreed close-range window', () => {
    assert.equal(crowdFaceDetailAtDistance(0), 1);
    assert.equal(crowdFaceDetailAtDistance(15), 1);
    assert.equal(crowdFaceDetailAtDistance(22.5), 0.5);
    assert.equal(crowdFaceDetailAtDistance(30), 0);
    assert.equal(crowdFaceDetailAtDistance(265), 0);
});

test('the atlas includes skin-preserving transparency and coloured markings in every tile', () => {
    const tileSize = 128;
    const { data, width } = createCrowdFaceAtlas(tileSize);
    for (let variant = 0; variant < CROWD_FACE_COUNT; variant++) {
        let transparent = 0, marked = 0;
        for (let y = 0; y < tileSize; y++) for (let x = 0; x < tileSize; x++) {
            const index = ((Math.floor(variant / 8) * tileSize + y) * width + variant % 8 * tileSize + x) * 4;
            if (data[index + 3] === 0) transparent++;
            if (data[index + 3] > 180) marked++;
        }
        assert.ok(transparent > 100, 'skin remains visible in variant ' + variant);
        assert.ok(marked > 4, 'features exist in variant ' + variant);
    }
    const png = readFileSync(new URL('../assets/people/crowd-faces.png', import.meta.url));
    assert.equal(png.readUInt32BE(16), 1024);
    assert.equal(png.readUInt32BE(20), 1024);
    assert.ok(png.length < 200_000, 'the shared atlas stays small on the wire');
});

test('platform disposal releases its instance buffer and keeps shared head resources until session teardown', () => {
    const geometry = createInstancedPersonHeadGeometry([1, 33]);
    const material = getPersonHeadMaterial(0xffffff, { unlit: true });
    const atlas = material.map;
    const counts = { geometry: 0, material: 0, atlas: 0 };
    for (const [key, resource] of Object.entries({ geometry, material, atlas })) {
        resource.addEventListener('dispose', () => counts[key]++);
    }
    const group = new THREE.Group();
    group.add(new THREE.InstancedMesh(geometry, material, 2));
    disposeGroup(group);
    assert.deepEqual(counts, { geometry: 1, material: 0, atlas: 0 });
    disposePersonMeshSessionCaches();
    assert.deepEqual(counts, { geometry: 1, material: 1, atlas: 1 });
});
