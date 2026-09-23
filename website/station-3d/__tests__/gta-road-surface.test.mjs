// Verifies that visible road-formation polygons become continuous, raised
// Rapier support instead of relying only on the coarse terrain height mesh.

import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';

import {
    buildRoadFormationDressingTrimeshData,
    buildRenderedRoadSurfaceTrimeshData,
    buildRenderedRoadSurfaceTrimeshDataSteps,
    buildRoadSurfaceTrimeshData,
    mergeRoadSurfaceMeshes,
    roadFormationDressingSupportYAtPoint,
} from '../core/gta-road-surface.js';
import { physicsSurfaceSupportY } from '../core/gta-surface-recovery.js';

await RAPIER.init();

test('cooperative rendered collider work counts rejected triangles and matches the immediate compiler', () => {
    const positions = new Float32Array(300 * 9);
    for (let i = 0; i < 300; i++) {
        const x = i === 299 ? 0 : 1000;
        positions.set([x, 2, 0, x+1, 2, 0, x, 2, 1], i*9);
    }
    const options = { parts: [{ positions, bounds: { minX: 0, maxX: 1001, minZ: 0, maxZ: 1 } }],
        centerX: 0, centerZ: 0, radiusM: 10, trianglesPerStep: 16 };
    const steps = buildRenderedRoadSurfaceTrimeshDataSteps(options);
    const yields = []; let result;
    for (let n = 0; n < 100; n++) {
        const next = steps.next();
        if (next.done) { result = next.value; break; }
        yields.push(next.value.scannedTriangles);
    }
    assert.equal(yields.length, 18, 'far triangles cannot hide an unbounded scan inside one item');
    assert.deepEqual(yields, Array.from({ length: 18 }, (_, i) => (i+1)*16));
    assert.equal(result.triangleCount, 1);
    assert.deepEqual(result, buildRenderedRoadSurfaceTrimeshData(options));
});

test('rendered support is truncated only when another eligible triangle exceeds its capacity', () => {
    const near = [0, 2, 0, 1, 2, 0, 0, 2, 1];
    const far = [1000, 2, 0, 1001, 2, 0, 1000, 2, 1];
    const invalid = [0, NaN, 0, 1, 2, 0, 0, 2, 1];
    const part = positions => ({ positions: new Float32Array(positions),
        bounds: { minX: 0, maxX: 1001, minZ: 0, maxZ: 1 } });
    const options = { centerX: 0, centerZ: 0, radiusM: 10, maxTriangles: 1 };
    const exact = buildRenderedRoadSurfaceTrimeshData({ ...options,
        parts: [part([...near, ...far, ...invalid]), part(far)] });
    assert.equal(exact.triangleCount, 1);
    assert.equal(exact.truncated, false, 'rejected trailing geometry does not require more capacity');
    const overflow = buildRenderedRoadSurfaceTrimeshData({ ...options,
        parts: [part([...near, ...far, ...invalid]), part(near)] });
    assert.equal(overflow.triangleCount, 1);
    assert.equal(overflow.truncated, true, 'a second eligible surface cannot be silently omitted');
});

function createFlatCollider(world, y = 0) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const collider = world.createCollider(RAPIER.ColliderDesc.trimesh(
        new Float32Array([
            -50, y, -50,
            50, y, -50,
            -50, y, 50,
            50, y, 50,
        ]),
        new Uint32Array([0, 2, 1, 1, 2, 3]),
    ), body);
    return collider;
}

test('the complete road polygon is firm above lower terrain', () => {
    const roadY = 0.2;
    const data = buildRoadSurfaceTrimeshData({
        profiles: [{
            osmId: 'road-1',
            bounds: { minX: -3, maxX: 3, minZ: -20, maxZ: 20 },
            innerRing: [
                { x: -3, z: -20 },
                { x: 3, z: -20 },
                { x: 3, z: 20 },
                { x: -3, z: 20 },
            ],
        }],
        centerX: 0,
        centerZ: 0,
        radiusM: 30,
        heightAt: () => roadY,
        maxEdgeM: 4,
        surfaceOffsetM: 0.025,
    });
    assert.equal(data.profileCount, 1);
    assert.equal(data.surfaces.length, 1);
    assert.ok(data.triangleCount > 2, 'long road triangles are refined before height sampling');
    assert.equal(data.truncated, false);

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const terrainCollider = createFlatCollider(world, 0);
    const roadBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const roadCollider = world.createCollider(
        RAPIER.ColliderDesc.trimesh(data.vertices, data.indices).setFriction(1.3),
        roadBody,
    );
    for (const z of [-18, -9, 0, 9, 18]) {
        const support = physicsSurfaceSupportY({
            RAPIER,
            surfaceColliders: [roadCollider, terrainCollider],
            physicsX: 0,
            physicsZ: z,
            supportProbeY: 0,
        });
        assert.ok(Math.abs(support - 0.225) < 1e-5, `road support at z=${z} was ${support}`);
    }
    const outsideSupport = physicsSurfaceSupportY({
        RAPIER,
        surfaceColliders: [roadCollider, terrainCollider],
        physicsX: 6,
        physicsZ: 0,
        supportProbeY: 0,
    });
    assert.ok(Math.abs(outsideSupport) < 1e-5, `off-road support was ${outsideSupport}`);
    world.free();
});

test('an exact rendered shared street becomes firm without a formation profile', () => {
    const data = buildRenderedRoadSurfaceTrimeshData({
        parts: [{
            id: 'teslina-pedestrian-surface',
            osmId: '123',
            surfaceType: 'pedestrian',
            drivable: true,
            bounds: { minX: -4, minZ: -12, maxX: 4, maxZ: 12 },
            positions: new Float32Array([
                -4, 1.2, -12,
                4, 1.2, -12,
                4, 1.2, 12,
                -4, 1.2, 12,
            ]),
            indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        }],
        centerX: 0,
        centerZ: 0,
        radiusM: 20,
    });
    assert.equal(data.profileCount, 1);
    assert.equal(data.triangleCount, 2);
    assert.equal(data.surfaces[0].osmId, '123');

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const roadBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const roadCollider = world.createCollider(
        RAPIER.ColliderDesc.trimesh(data.vertices, data.indices),
        roadBody,
    );
    const support = physicsSurfaceSupportY({
        RAPIER,
        surfaceColliders: [roadCollider],
        physicsX: 0,
        physicsZ: 0,
        supportProbeY: 1,
    });
    assert.ok(Math.abs(support - 1.2) < 1e-5, `shared-street support was ${support}`);
    world.free();
});

test('individual profile meshes can be regrouped without changing topology', () => {
    const data = buildRoadSurfaceTrimeshData({
        profiles: [
            {
                osmId: 'lower',
                bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 },
                innerRing: squareRing(-5, -5, 5, 5),
            },
            {
                osmId: 'upper',
                bounds: { minX: -3, maxX: 3, minZ: -8, maxZ: 8 },
                innerRing: squareRing(-3, -8, 3, 8),
            },
        ],
        centerX: 0,
        centerZ: 0,
        radiusM: 20,
        heightAt: (_x, _z, profile) => profile.osmId === 'upper' ? 5 : 0,
        maxEdgeM: 20,
    });
    const merged = mergeRoadSurfaceMeshes(data.surfaces);
    assert.equal(data.surfaces.length, 2);
    assert.equal(merged.triangleCount, data.triangleCount);
    assert.equal(merged.vertices.length, data.vertices.length);
    assert.ok(Math.abs(merged.minY - 0.025) < 1e-6);
    assert.ok(Math.abs(merged.maxY - 5.025) < 1e-6);
});

function squareRing(minX, minZ, maxX, maxZ) {
    return [
        { x: minX, z: minZ },
        { x: maxX, z: minZ },
        { x: maxX, z: maxZ },
        { x: minX, z: maxZ },
    ];
}

function formationProfile() {
    const corners = [
        [-1, -1, -2, -2, -2.5, -2.5, -3, -3],
        [1, -1, 2, -2, 2.5, -2.5, 3, -3],
        [1, 1, 2, 2, 2.5, 2.5, 3, 3],
        [-1, 1, -2, 2, -2.5, 2.5, -3, 3],
    ];
    return {
        osmId: 'formation-road',
        bounds: { minX: -1, minZ: -1, maxX: 1, maxZ: 1 },
        outerBounds: { minX: -2, minZ: -2, maxX: 2, maxZ: 2 },
        terrainCutoutBounds: { minX: -2.5, minZ: -2.5, maxX: 2.5, maxZ: 2.5 },
        overlapBounds: { minX: -3, minZ: -3, maxX: 3, maxZ: 3 },
        internalSegments: [false, false, false, false],
        collarInternalSegments: [false, false, false, false],
        roadOpeningSegmentRanges: [[], [], [], []],
        formationDressingDisabled: false,
        points: corners.map(([
            innerX, innerZ,
            outerX, outerZ,
            cutoutX, cutoutZ,
            overlapX, overlapZ,
        ]) => ({
            innerX,
            innerZ,
            roadY: 0,
            outerX,
            outerZ,
            terrainY: 0.2,
            wallTerrainY: -0.2,
            cutoutX,
            cutoutZ,
            cutoutTerrainY: 0.2,
            overlapX,
            overlapZ,
            overlapTerrainY: 0.2,
        })),
    };
}

test('rendered road formation walls and collars become exact physics support', () => {
    const profile = formationProfile();
    const wallY = roadFormationDressingSupportYAtPoint({
        profiles: [profile],
        x: 1.5,
        z: 0,
    });
    const collarY = roadFormationDressingSupportYAtPoint({
        profiles: [profile],
        x: 2.25,
        z: 0,
    });
    assert.ok(wallY > 0 && wallY < 0.2, `wall support was ${wallY}`);
    assert.ok(Math.abs(collarY - 0.2) < 1e-6, `collar support was ${collarY}`);

    const data = buildRoadFormationDressingTrimeshData({
        profiles: [profile],
        centerX: 0,
        centerZ: 0,
        radiusM: 10,
    });
    assert.equal(data.profileCount, 1);
    assert.ok(data.triangleCount > 0);
    assert.equal(data.truncated, false);

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const collider = world.createCollider(
        RAPIER.ColliderDesc.trimesh(data.vertices, data.indices),
        body,
    );
    for (const [physicsX, expectedY] of [[1.5, wallY], [2.25, collarY]]) {
        const support = physicsSurfaceSupportY({
            RAPIER,
            surfaceColliders: [collider],
            physicsX,
            physicsZ: 0,
            supportProbeY: expectedY,
        });
        assert.ok(
            Math.abs(support - expectedY) < 1e-5,
            `formation support at x=${physicsX} was ${support}`,
        );
    }
    world.free();
});
