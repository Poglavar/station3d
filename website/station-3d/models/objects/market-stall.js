// A small riva market stall: a plank counter on four posts under a striped
// canvas awning, with a couple of crates on the counter. Cheap boxes only, so
// the walk collider harvest makes the counter and posts solid for free; the
// awning sits above head height and is skipped by the walker's height test.
// A consumer can place it as a set-piece; the group's local +Z is the
// customer's side.

import * as THREE from 'three';

const box = new THREE.BoxGeometry(1, 1, 1);
const materials = {};
function material(color) {
    if (!materials[color]) {
        materials[color] = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02 });
    }
    return materials[color];
}

function part(group, name, size, position, color, { castShadow = true } = {}) {
    const mesh = new THREE.Mesh(box, material(color));
    mesh.name = name;
    mesh.scale.set(size[0], size[1], size[2]);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
}

export const MARKET_STALL_FOOTPRINT = Object.freeze({ widthM: 2.4, depthM: 1.6, heightM: 2.35 });

export function createMarketStallMesh({
    awningColor = 0xb91c1c,
    awningStripeColor = 0xf5efe6,
    woodColor = 0x8b5a2b,
    crateColor = 0xa8763e,
} = {}) {
    const group = new THREE.Group();
    group.name = 'MarketStall';
    const { widthM, depthM, heightM } = MARKET_STALL_FOOTPRINT;
    // Counter: a plank top on a closed front, knee to hip height.
    part(group, 'MarketStallCounter', [widthM, 0.9, 0.8], [0, 0.45, 0.25], woodColor);
    part(group, 'MarketStallTop', [widthM + 0.1, 0.06, 0.9], [0, 0.93, 0.25], 0xc9a066);
    // Four posts carrying the awning.
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        part(group, 'MarketStallPost', [0.08, heightM, 0.08],
            [sx * (widthM / 2 - 0.05), heightM / 2, sz * (depthM / 2 - 0.05)], woodColor);
    }
    // Awning: alternating stripes across the width, pitched down toward the customer.
    const stripes = 6;
    const stripeW = (widthM + 0.3) / stripes;
    for (let i = 0; i < stripes; i++) {
        const stripe = part(group, 'MarketStallAwning', [stripeW, 0.04, depthM + 0.5],
            [-(widthM + 0.3) / 2 + stripeW * (i + 0.5), heightM + 0.02, 0.15],
            i % 2 === 0 ? awningColor : awningStripeColor);
        stripe.rotation.x = 0.12;
        // Not a wall: the walker passes under it.
        stripe.userData.walkColliderBoxes = [];
    }
    // Wares: two crates on the counter, one behind the other.
    part(group, 'MarketStallCrate', [0.5, 0.3, 0.36], [-0.55, 1.11, 0.2], crateColor);
    part(group, 'MarketStallCrate', [0.5, 0.3, 0.36], [0.45, 1.11, 0.15], crateColor);
    part(group, 'MarketStallCrate', [0.42, 0.26, 0.32], [0.05, 1.09, 0.42], 0x6b8e23);
    return group;
}
