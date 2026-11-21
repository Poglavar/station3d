// Guards the dog companion's two-draw-call structure and leash animation.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    animateLeashedDog,
    createLeashedDog,
    disposeDogMeshSessionCaches,
    setDogHappyPose,
} from '../world/dog-mesh.js';

test('leashed dog is one batched dog mesh plus one leash mesh', () => {
    const companion = createLeashedDog({ random: () => 0.4 });
    assert.equal(companion.children.length, 3);
    const dog = companion.getObjectByName('AmbientDog');
    const leash = companion.getObjectByName('AmbientDogLeash');
    assert.ok(dog?.isMesh);
    assert.ok(leash?.isMesh);
    assert.equal(dog.geometry.groups.length, 2);
    const head = companion.userData.head;
    assert.ok(head?.getObjectByName('AmbientDogTongue'));
    assert.ok(head.children.filter((child) => child.isMesh).length <= 4);
    assert.ok(head.getObjectByName('AmbientDogEyes')?.geometry?.attributes?.position,
        'eye whites are modeled in a bounded head mesh');
    setDogHappyPose(companion, { amount: 1, lookYaw: 0.4, lookPitch: 0.2, timeS: 1 });
    assert.notEqual(head.rotation.y, 0);
    assert.equal(dog.rotation.y, 0);
    setDogHappyPose(companion);
    assert.equal(head.rotation.y, 0);
    assert.equal(head.rotation.x, 0);
    assert.equal(companion.userData.tongue.visible, false);
    const second = createLeashedDog({ random: () => 0.4 });
    for (const name of ['AmbientDogHeadCoat', 'AmbientDogEyes', 'AmbientDogPupils']) {
        assert.equal(head.getObjectByName(name).geometry, second.userData.head.getObjectByName(name).geometry);
    }
    assert.equal(head.getObjectByName('AmbientDogHeadCoat').material, dog.material[0]);
    const initialY = dog.position.y;
    const initialLength = leash.scale.y;
    animateLeashedDog(companion, Math.PI / 4, 1);
    assert.ok(dog.position.y > initialY);
    assert.notEqual(leash.scale.y, initialLength);
});

test('dog and leash caches are disposed exactly once per session', () => {
    const companion = createLeashedDog({ random: () => 0.2 });
    const resources = new Set();
    companion.traverse((object) => {
        if (object.geometry) resources.add(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) if (material) resources.add(material);
    });
    const counts = new Map([...resources].map(resource => [resource, 0]));
    for (const resource of resources) {
        resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1));
    }
    disposeDogMeshSessionCaches();
    disposeDogMeshSessionCaches();
    for (const count of counts.values()) assert.equal(count, 1);
});
