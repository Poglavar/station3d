// Turns a new-build roof layout (core/new-build-roof-decor.js) into one opaque
// vertex-coloured mesh plus, when present, one translucent pool-water sibling.
// The opaque parts share the courtyard material; all water siblings share one
// second material. The buildings batcher therefore folds a proposal region to
// at most two decor draws rather than one draw per roof. Built once at building
// build time; nothing here runs per frame.

import * as THREE from 'three';
import {
    ROOF_POOL_WALL_THICKNESS_M,
    newBuildRoofLayout,
} from '../core/new-build-roof-decor.js';
import {
    createDecorArrays,
    pushBench,
    pushBlob,
    pushBox,
    pushCafeChair,
    pushFlatPatch,
    pushRingBand,
    pushRingRibbon,
    pushSunshade,
    pushTree,
} from '../core/vertex-color-geometry.js';
import { getNewBuildDecorMaterial } from './new-build-decor-material.js';
import { getNewBuildRoofPoolWaterMaterial } from './new-build-roof-pool-material.js';

const COLORS = {
    railing: 0xf4f6f7,
    track: 0xb0523a,
    lawn: 0x6f9e58,
    bush: [0x4e7d46, 0x5d8a4e, 0x6c9a58],
    foliage: 0x557d43,
    trunk: 0x6b4f37,
    chairSlat: 0xd9c3a0,
    chairFrame: 0xaeb4b3,
    bench: 0x8a5a33,
    pole: 0xb9bdc0,
    barbecue: 0x3d4042,
    poolWall: 0xd9ddd8,
    poolCoping: 0xf0eee7,
    poolFloor: 0x8bcfd5,
    poolStep: 0xb2e1df,
};

// Parasols are the roof's spot of colour, so each one is a two-tone stripe drawn
// from its own pair — a terrace of identical cream umbrellas read as institutional.
// Segments alternate between the pair, which costs nothing: same geometry, and
// the colour rides the vertex attribute the merged material already reads.
const CANOPY_PAIRS = [
    [0xd8503f, 0xf2ede2],   // red / cream
    [0x2f7fb5, 0xf2ede2],   // blue / cream
    [0xe8a33d, 0xf6efdd],   // amber / ivory
    [0x3f9070, 0xf2ede2],   // green / cream
    [0xd8603f, 0xe9c37a],   // terracotta / straw
    [0x7a5ea8, 0xf1ecf5],   // violet / pale lilac
];

const RAIL_THICKNESS_M = 0.05;
const POST_SIZE_M = 0.05;
const TRACK_LIFT_M = 0.02;       // above the roof cap, below every railing base
const LAWN_LIFT_M = 0.015;
const POOL_BOTTOM_BASE_M = 0.02;
const POOL_BOTTOM_THICKNESS_M = 0.06;
const POOL_COPING_HEIGHT_M = 0.07;

function colorOf(hex) {
    return new THREE.Color(hex);
}

function pushBarbecue(arrays, spot, color) {
    pushBox(arrays, spot.x, 0, spot.z, 0.9, 0.85, 0.55, spot.angle, color, true);
    const cx = spot.x + Math.cos(spot.angle) * 0.25;
    const cz = spot.z + Math.sin(spot.angle) * 0.25;
    pushBox(arrays, cx, 0.85, cz, 0.2, 0.6, 0.2, spot.angle, color, true);
}

function poolOffset(pool, alongM, acrossM) {
    const cos = Math.cos(pool.angle);
    const sin = Math.sin(pool.angle);
    return {
        x: pool.x + alongM * cos - acrossM * sin,
        z: pool.z + alongM * sin + acrossM * cos,
    };
}

function pushPoolBasin(arrays, pool) {
    const wall = ROOF_POOL_WALL_THICKNESS_M;
    const wallColor = colorOf(COLORS.poolWall);
    const copingColor = colorOf(COLORS.poolCoping);
    const floorColor = colorOf(COLORS.poolFloor);
    const stepColor = colorOf(COLORS.poolStep);
    pushBox(
        arrays,
        pool.x,
        POOL_BOTTOM_BASE_M,
        pool.z,
        pool.lengthM,
        POOL_BOTTOM_THICKNESS_M,
        pool.widthM,
        pool.angle,
        floorColor,
        true,
    );

    const longSideOffset = pool.widthM / 2 + wall / 2;
    const shortSideOffset = pool.lengthM / 2 + wall / 2;
    for (const side of [-1, 1]) {
        const longSide = poolOffset(pool, 0, side * longSideOffset);
        pushBox(
            arrays,
            longSide.x,
            0,
            longSide.z,
            pool.outerLengthM,
            pool.wallHeightM,
            wall,
            pool.angle,
            wallColor,
            true,
        );
        pushBox(
            arrays,
            longSide.x,
            pool.wallHeightM,
            longSide.z,
            pool.outerLengthM,
            POOL_COPING_HEIGHT_M,
            wall,
            pool.angle,
            copingColor,
            true,
        );

        const shortSide = poolOffset(pool, side * shortSideOffset, 0);
        pushBox(
            arrays,
            shortSide.x,
            0,
            shortSide.z,
            wall,
            pool.wallHeightM,
            pool.widthM,
            pool.angle,
            wallColor,
            true,
        );
        pushBox(
            arrays,
            shortSide.x,
            pool.wallHeightM,
            shortSide.z,
            wall,
            POOL_COPING_HEIGHT_M,
            pool.widthM,
            pool.angle,
            copingColor,
            true,
        );
    }

    // Three broad submerged entry steps make the basin depth legible through
    // the water without turning a small recreational pool into a lane pool.
    const stepHeights = [0.44, 0.30, 0.16];
    for (let index = 0; index < stepHeights.length; index++) {
        const step = poolOffset(pool, -pool.lengthM / 2 + 0.28 + index * 0.46, 0);
        pushBox(
            arrays,
            step.x,
            POOL_BOTTOM_BASE_M + POOL_BOTTOM_THICKNESS_M,
            step.z,
            0.56,
            stepHeights[index],
            Math.min(2.7, pool.widthM - 0.5),
            pool.angle,
            stepColor,
            true,
        );
    }
}

function buildPoolWaterMesh(pool) {
    const halfLength = pool.lengthM / 2 - 0.03;
    const halfWidth = pool.widthM / 2 - 0.03;
    const waterY = POOL_BOTTOM_BASE_M + POOL_BOTTOM_THICKNESS_M + pool.waterDepthM;
    const point = (alongM, acrossM) => {
        const offset = poolOffset(pool, alongM, acrossM);
        return [offset.x, waterY, offset.z];
    };
    const a = point(-halfLength, -halfWidth);
    const b = point(-halfLength, halfWidth);
    const c = point(halfLength, halfWidth);
    const d = point(halfLength, -halfWidth);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        ...a, ...b, ...c,
        ...a, ...c, ...d,
    ], 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, getNewBuildRoofPoolWaterMaterial());
    mesh.name = 'NewBuildRoofPoolWater';
    mesh.renderOrder = 2;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
}

/**
 * Batcher-ready decor meshes for a flat proposal roof, or null (plain roof /
 * no layout). Caller positions each sibling at roof-cap height and adds it to
 * the buildings group so normal tile tagging/batching applies.
 */
export function buildNewBuildRoofDecorMeshes(polygonCoords, anchorLat, anchorLon, hash) {
    const layout = newBuildRoofLayout(polygonCoords, anchorLat, anchorLon, hash);
    if (!layout) return null;
    const arrays = createDecorArrays();

    const railingColor = colorOf(COLORS.railing);
    const railTop = layout.railing.railHeights[layout.railing.railHeights.length - 1];
    for (const post of layout.railing.posts) {
        pushBox(arrays, post.x, 0, post.z, POST_SIZE_M, railTop, POST_SIZE_M, 0, railingColor, false);
    }
    for (const h of layout.railing.railHeights) {
        pushRingRibbon(arrays, layout.railing.ring, h - RAIL_THICKNESS_M, h, railingColor);
    }

    if (layout.track) {
        pushRingBand(arrays, layout.track.outer, layout.track.inner, TRACK_LIFT_M, colorOf(COLORS.track));
    }
    const lawnColor = colorOf(COLORS.lawn);
    for (const lawn of layout.lawns) {
        pushFlatPatch(arrays, lawn.x, lawn.z, lawn.w, lawn.d, lawn.angle, LAWN_LIFT_M, lawnColor);
    }
    layout.bushes.forEach((bush, i) => {
        pushBlob(arrays, bush.x, bush.r * 0.75, bush.z, bush.r, 0.75, colorOf(COLORS.bush[i % COLORS.bush.length]));
    });
    const trunkColor = colorOf(COLORS.trunk);
    const foliageColor = colorOf(COLORS.foliage);
    for (const tree of layout.trees) {
        pushTree(arrays, tree.x, tree.z, tree.h, trunkColor, foliageColor);
    }
    const chairSlatColor = colorOf(COLORS.chairSlat);
    const chairFrameColor = colorOf(COLORS.chairFrame);
    for (const chair of layout.chairs) {
        pushCafeChair(
            arrays,
            chair.x,
            chair.z,
            chair.angle,
            chairSlatColor,
            chairFrameColor,
        );
    }
    const benchColor = colorOf(COLORS.bench);
    for (const bench of layout.benches) {
        pushBench(arrays, bench.x, bench.z, bench.angle, benchColor);
    }
    const poleColor = colorOf(COLORS.pole);
    // Each parasol takes the next pair, so neighbouring umbrellas differ; the
    // offset comes from the layout's own hash-seeded order.
    layout.sunshades.forEach((shade, i) => {
        const pair = CANOPY_PAIRS[i % CANOPY_PAIRS.length].map(colorOf);
        pushSunshade(arrays, shade.x, shade.z, pair, poleColor);
    });
    const barbecueColor = colorOf(COLORS.barbecue);
    for (const spot of layout.barbecues) pushBarbecue(arrays, spot, barbecueColor);
    if (layout.pool) pushPoolBasin(arrays, layout.pool);

    if (arrays.positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(arrays.colors, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, getNewBuildDecorMaterial());
    mesh.name = 'NewBuildRoofDecor';
    mesh.castShadow = false;    // thin members; shadows would cost far more than they add
    mesh.receiveShadow = true;
    const waterMesh = layout.pool ? buildPoolWaterMesh(layout.pool) : null;
    return {
        layout,
        meshes: waterMesh ? [mesh, waterMesh] : [mesh],
        opaqueMesh: mesh,
        waterMesh,
    };
}
