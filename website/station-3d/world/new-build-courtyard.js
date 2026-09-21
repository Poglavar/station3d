// Turns a courtyard layout (core/new-build-courtyard.js) into ONE merged
// vertex-coloured mesh per courtyard: lawn, paved perimeter path with a crossing
// leg, bushes, trees and wooden benches. Shares the new-build decor material
// with the roof decor, so every landscaped court and lived-on roof in a tile
// folds into the same aggregate draw call. Built once, at build time.

import * as THREE from 'three';
import {
    newBuildCourtyardLayouts,
    newBuildCourtyardLayoutsFromRings,
} from '../core/new-build-courtyard.js';
import {
    createDecorArrays,
    pushBench,
    pushBlob,
    pushFlatStrip,
    pushRingBand,
    pushTree,
} from '../core/vertex-color-geometry.js';
import { getNewBuildDecorMaterial } from './new-build-decor-material.js';

const COLORS = {
    grass: 0x5f8f4a,
    path: 0xc2bcb0,
    bush: [0x4e7d46, 0x5d8a4e, 0x6c9a58],
    foliage: 0x4f7a3f,
    trunk: 0x6b4f37,
    bench: 0x8a5a33,
};

// Above the building's foundation plane, so the lawn cannot z-fight the ground
// surface it sits on; the paving sits a further hair above the lawn.
const LAWN_LIFT_M = 0.03;
const PATH_LIFT_M = 0.05;

function colorOf(hex) {
    return new THREE.Color(hex);
}

// The lawn is an arbitrary (often non-convex) polygon, so it is triangulated by
// THREE.Shape — the same conversion the flat roof cap uses — and its triangles
// are then appended to the shared arrays like every other decor part.
function pushLawn(arrays, ring, y, color) {
    if (!Array.isArray(ring) || ring.length < 4) return;
    const shape = new THREE.Shape();
    ring.forEach((point, index) => {
        if (index === 0) shape.moveTo(point.x, -point.z);
        else shape.lineTo(point.x, -point.z);
    });
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const emit = (i) => {
        arrays.positions.push(position.getX(i), y, position.getZ(i));
        arrays.colors.push(color.r, color.g, color.b);
    };
    if (index) {
        for (let i = 0; i < index.count; i++) emit(index.getX(i));
    } else {
        for (let i = 0; i < position.count; i++) emit(i);
    }
    geometry.dispose();
}

/**
 * One merged mesh for every courtyard of a proposal footprint, or null when the
 * footprint has no courtyard big enough to plant. The caller positions it at the
 * building's foundation height and adds it, so tile tagging and batching apply.
 */
export function buildNewBuildCourtyardMesh(
    polygonCoords,
    anchorLat,
    anchorLon,
    hash,
    explicitCourtyardRings = null,
) {
    const layouts = Array.isArray(explicitCourtyardRings) && explicitCourtyardRings.length
        ? newBuildCourtyardLayoutsFromRings(explicitCourtyardRings, anchorLat, anchorLon, hash)
        : newBuildCourtyardLayouts(polygonCoords, anchorLat, anchorLon, hash);
    if (layouts.length === 0) return null;
    const arrays = createDecorArrays();
    const grass = colorOf(COLORS.grass);
    const path = colorOf(COLORS.path);
    const trunk = colorOf(COLORS.trunk);
    const foliage = colorOf(COLORS.foliage);
    const bench = colorOf(COLORS.bench);
    const bushColors = COLORS.bush.map(colorOf);

    for (const layout of layouts) {
        pushLawn(arrays, layout.lawn, LAWN_LIFT_M, grass);
        if (layout.path) {
            pushRingBand(arrays, layout.path.outer, layout.path.inner, PATH_LIFT_M, path);
        }
        for (const leg of layout.pathLegs) {
            pushFlatStrip(arrays, leg.a, leg.b, leg.widthM, PATH_LIFT_M, path);
        }
        layout.bushes.forEach((bush, i) => {
            pushBlob(arrays, bush.x, LAWN_LIFT_M + bush.r * 0.75, bush.z, bush.r, 0.75,
                bushColors[i % bushColors.length]);
        });
        for (const tree of layout.trees) {
            pushTree(arrays, tree.x, tree.z, tree.h, trunk, foliage, LAWN_LIFT_M);
        }
        for (const seat of layout.benches) {
            pushBench(arrays, seat.x, seat.z, seat.angle, bench, LAWN_LIFT_M);
        }
    }

    if (arrays.positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(arrays.colors, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, getNewBuildDecorMaterial());
    mesh.name = 'NewBuildCourtyard';
    mesh.castShadow = false;      // thin planting; shadows cost more than they add
    mesh.receiveShadow = true;
    return mesh;
}
