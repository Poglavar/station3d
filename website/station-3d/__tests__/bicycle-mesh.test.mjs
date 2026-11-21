// Verifies that each bicycle is a bounded, batched vehicle mesh rather than a
// collection of per-tube draw calls, and that cargo bikes retain a longer body.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createBicycleMesh,
    disposeBicycleSessionCaches,
} from '../models/vehicles/bicycle.js';

test('standard and cargo bicycles use one three-material mesh each', () => {
    const standard = createBicycleMesh({ variant: 'standard' }, 0xd23b32);
    const cargo = createBicycleMesh({ variant: 'cargo' }, 0xf4a322);
    assert.equal(standard.children.length, 1);
    assert.equal(cargo.children.length, 1);
    assert.equal(standard.children[0].geometry.groups.length, 3);
    assert.equal(cargo.children[0].geometry.groups.length, 3);
    assert.equal(standard.userData.vehicleKind, 'bicycle');
    assert.equal(cargo.userData.bicycleVariant, 'cargo');
    const standardLength = standard.children[0].geometry.boundingBox.max.z
        - standard.children[0].geometry.boundingBox.min.z;
    const cargoLength = cargo.children[0].geometry.boundingBox.max.z
        - cargo.children[0].geometry.boundingBox.min.z;
    assert.ok(cargoLength > standardLength + 0.35);
});

test('bicycle shared resources are disposed exactly once at session end', () => {
    const first = createBicycleMesh({ variant: 'standard' }, 0x224466);
    const geometry = first.children[0].geometry;
    const materials = first.children[0].material;
    const disposeCounts = new Map();
    for (const resource of [geometry, ...materials]) {
        disposeCounts.set(resource, 0);
        resource.addEventListener('dispose', () => {
            disposeCounts.set(resource, disposeCounts.get(resource) + 1);
        });
    }

    disposeBicycleSessionCaches();
    disposeBicycleSessionCaches();
    for (const count of disposeCounts.values()) assert.equal(count, 1);

    const replacement = createBicycleMesh({ variant: 'standard' }, 0x224466);
    assert.notEqual(replacement.children[0].geometry, geometry);
    for (let i = 0; i < materials.length; i++) {
        assert.notEqual(replacement.children[0].material[i], materials[i]);
    }
    disposeBicycleSessionCaches();
});
