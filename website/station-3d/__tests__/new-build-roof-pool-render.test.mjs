// Rooftop pools render as a modeled opaque basin plus one shared translucent
// water surface, and both meshes retain the translation-only batching contract.

import assert from 'node:assert/strict';
import test from 'node:test';

import { EARTH_RADIUS_M } from '../core/math.js';
import {
    ROOF_POOL_LENGTH_M,
    ROOF_POOL_WIDTH_M,
} from '../core/new-build-roof-decor.js';
import { buildNewBuildRoofDecorMeshes } from '../world/new-build-roof-decor.js';
import {
    NEW_BUILD_ROOF_POOL_WATER_MATERIAL_NAME,
} from '../world/new-build-roof-pool-material.js';

const ANCHOR_LAT = 43.75;
const ANCHOR_LON = 15.87;
const M_PER_DEG_LAT = EARTH_RADIUS_M * Math.PI / 180;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(ANCHOR_LAT * Math.PI / 180);

function rectRing(w, d) {
    const toLonLat = (x, z) => [
        ANCHOR_LON + x / M_PER_DEG_LON,
        ANCHOR_LAT - z / M_PER_DEG_LAT,
    ];
    return [
        toLonLat(-w / 2, -d / 2),
        toLonLat(w / 2, -d / 2),
        toLonLat(w / 2, d / 2),
        toLonLat(-w / 2, d / 2),
        toLonLat(-w / 2, -d / 2),
    ];
}

function disposeBuild(build) {
    for (const mesh of build?.meshes || []) mesh.geometry.dispose();
}

test('a pool roof emits a deep basin and a transparent batchable water sibling', () => {
    const build = buildNewBuildRoofDecorMeshes(
        [rectRing(40, 24)],
        ANCHOR_LAT,
        ANCHOR_LON,
        1,
    );
    try {
        assert.ok(build?.layout.pool);
        assert.equal(build.meshes.length, 2);
        assert.equal(build.opaqueMesh.name, 'NewBuildRoofDecor');
        assert.equal(build.waterMesh.name, 'NewBuildRoofPoolWater');
        assert.equal(build.waterMesh.material.name, NEW_BUILD_ROOF_POOL_WATER_MATERIAL_NAME);
        assert.equal(build.waterMesh.material.transparent, true);
        assert.ok(build.waterMesh.material.opacity > 0.3
            && build.waterMesh.material.opacity < 0.6);
        assert.equal(build.waterMesh.material.depthWrite, false);
        assert.equal(build.waterMesh.material.userData.walkSupport, false);
        assert.equal(build.waterMesh.children.length, 0);
        assert.deepEqual(build.waterMesh.scale.toArray(), [1, 1, 1]);
        assert.deepEqual(build.waterMesh.quaternion.toArray(), [0, 0, 0, 1]);

        const positions = build.waterMesh.geometry.getAttribute('position');
        assert.equal(positions.count, 6);
        const xs = [];
        const ys = [];
        const zs = [];
        for (let index = 0; index < positions.count; index++) {
            xs.push(positions.getX(index));
            ys.push(positions.getY(index));
            zs.push(positions.getZ(index));
        }
        assert.ok(Math.max(...xs) - Math.min(...xs) > ROOF_POOL_LENGTH_M - 0.1);
        assert.ok(Math.max(...zs) - Math.min(...zs) > ROOF_POOL_WIDTH_M - 0.1);
        assert.ok(Math.max(...ys) - Math.min(...ys) < 1e-6, 'water stays level');

        const opaquePositions = build.opaqueMesh.geometry.getAttribute('position');
        let hasBottomBelowWater = false;
        let hasRimAboveWater = false;
        const waterY = ys[0];
        const pool = build.layout.pool;
        const cos = Math.cos(pool.angle);
        const sin = Math.sin(pool.angle);
        for (let index = 0; index < opaquePositions.count; index++) {
            const dx = opaquePositions.getX(index) - pool.x;
            const dz = opaquePositions.getZ(index) - pool.z;
            const localX = dx * cos + dz * sin;
            const localZ = -dx * sin + dz * cos;
            const y = opaquePositions.getY(index);
            if (Math.abs(localX) < pool.lengthM / 2
                && Math.abs(localZ) < pool.widthM / 2
                && y < waterY - 0.45) hasBottomBelowWater = true;
            if (Math.abs(localX) <= pool.outerLengthM / 2 + 0.01
                && Math.abs(localZ) <= pool.outerWidthM / 2 + 0.01
                && y > waterY + 0.08) hasRimAboveWater = true;
        }
        assert.equal(hasBottomBelowWater, true, 'transparent water reveals a recessed bottom');
        assert.equal(hasRimAboveWater, true, 'the pool has a visibly raised coping rim');
    } finally {
        disposeBuild(build);
    }
});

test('a non-pool roof stays in the existing single opaque decor batch', () => {
    const build = buildNewBuildRoofDecorMeshes(
        [rectRing(40, 24)],
        ANCHOR_LAT,
        ANCHOR_LON,
        0,
    );
    try {
        assert.ok(build);
        assert.equal(build.layout.pool, null);
        assert.equal(build.waterMesh, null);
        assert.deepEqual(build.meshes, [build.opaqueMesh]);
    } finally {
        disposeBuild(build);
    }
});
