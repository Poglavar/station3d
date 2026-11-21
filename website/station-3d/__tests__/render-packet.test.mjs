import test from 'node:test';
import assert from 'node:assert/strict';

import {
    renderPacketFingerprint,
    renderPacketTransferables,
    RenderPacketValidationError,
    validateRenderPacket,
    createRenderPacketValidationTask,
    RENDER_PACKET_VALIDATION_CHECKS_PER_STEP,
} from '../core/render-packet.js';
import {
    compileTerrainRenderPacket,
    TERRAIN_PACKET_COMPILER_ID,
    TERRAIN_PACKET_COMPILER_VERSION,
} from '../core/compilers/terrain-render-packet.js';
import {
    compileFarBuildingRenderPacket,
    FAR_BUILDING_PACKET_COMPILER_ID,
    FAR_BUILDING_PACKET_COMPILER_VERSION,
} from '../core/compilers/far-building-render-packet.js';
import { TerrainGrid, TerrainReference } from '../core/terrain-grid.js';
import {
    deserializeTerrainReference,
    serializeTerrainReference,
    terrainSnapshotTransferables,
} from '../core/terrain-snapshot.js';

function terrainMetadata(width, height) {
    return {
        grid: {
            width,
            height,
            bounds: { west: 15.99, east: 16.01, south: 45.79, north: 45.81 },
        },
        encoding: { scaleM: 0.1, offsetM: 100, noDataValue: 65535 },
    };
}

function terrainFixture({ noData = false } = {}) {
    const values = new Uint16Array([
        0, 10, 20,
        20, noData ? 65535 : 30, 40,
        40, 50, 60,
    ]);
    const grid = new TerrainGrid(terrainMetadata(3, 3), values.buffer);
    return new TerrainReference(grid, 16, 45.8, { surfaceStepM: 20 });
}

function terrainRequest(reference, generation = 7, { tileX = 0, tileZ = 0 } = {}) {
    const tileM = 40;
    const origin = reference.lonLatAtLocal(tileX * tileM, tileZ * tileM);
    return {
        compilerId: TERRAIN_PACKET_COMPILER_ID,
        compilerVersion: TERRAIN_PACKET_COMPILER_VERSION,
        sourceRevision: `terrain:${reference.revision}:0`,
        generation,
        tile: {
            matrix: 'session-enu-v1',
            z: 0,
            x: tileX,
            y: tileZ,
            originLon: origin.lon,
            originLat: origin.lat,
            sizeM: tileM,
        },
        inputs: {
            snapshotRevision: reference.revision,
            tileX,
            tileZ,
            tileM,
            segments: 2,
            uvPerM: 1 / 16,
            renderOrder: 2,
        },
    };
}

test('terrain snapshots preserve flat/sloped and NoData sampling', () => {
    for (const noData of [false, true]) {
        const original = terrainFixture({ noData });
        const snapshot = serializeTerrainReference(original);
        const restored = deserializeTerrainReference(snapshot);
        for (const [x, z] of [[0, 0], [5, 5], [-30, 20], [100, -100]]) {
            assert.ok(
                Math.abs(original.sceneYAtLocal(x, z) - restored.sceneYAtLocal(x, z)) < 1e-9,
                `terrain parity at ${x},${z}`,
            );
        }
        assert.equal(terrainSnapshotTransferables(snapshot).length, 1);
    }
});

test('terrain snapshots preserve the fixed session datum after a grid replacement', () => {
    const original = terrainFixture();
    original.anchorHeightM += 1.9808;
    original.revision = 4;
    const snapshot = serializeTerrainReference(original);
    const restored = deserializeTerrainReference(snapshot);

    assert.equal(snapshot.anchorHeightM, original.anchorHeightM);
    assert.equal(restored.anchorHeightM, original.anchorHeightM);
    assert.equal(restored.revision, 4);
    for (const [x, z] of [[0, 0], [25.655, 8.848], [40, 40]]) {
        assert.ok(
            Math.abs(original.sceneYAtLocal(x, z) - restored.sceneYAtLocal(x, z)) < 1e-9,
            `fixed-datum terrain parity at ${x},${z}`,
        );
    }
});

test('terrain packet is deterministic and localized within one centimetre', () => {
    const reference = terrainFixture();
    const request = terrainRequest(reference);
    const first = compileTerrainRenderPacket(request, reference);
    const second = compileTerrainRenderPacket(request, reference);
    assert.equal(renderPacketFingerprint(first), renderPacketFingerprint(second));
    assert.equal(first.primitives.length, 1);
    const primitive = first.primitives[0];
    assert.ok(primitive.bounds.minX >= -0.01);
    assert.ok(primitive.bounds.minZ >= -0.01);
    assert.ok(Math.abs(primitive.bounds.maxX - 40) <= 0.01);
    assert.ok(Math.abs(primitive.bounds.maxZ - 40) <= 0.01);
    assert.equal(renderPacketTransferables(first).length, 4);
});

test('adjacent terrain packets share an exact elevation and normal seam', () => {
    const reference = terrainFixture();
    const left = compileTerrainRenderPacket(
        terrainRequest(reference, 8, { tileX: 0, tileZ: 0 }),
        reference,
    ).primitives[0];
    const right = compileTerrainRenderPacket(
        terrainRequest(reference, 8, { tileX: 1, tileZ: 0 }),
        reference,
    ).primitives[0];
    const vertexSide = 3;
    for (let row = 0; row < vertexSide; row++) {
        const leftOffset = (row * vertexSide + vertexSide - 1) * 3;
        const rightOffset = row * vertexSide * 3;
        assert.ok(Math.abs(left.positions[leftOffset] - 40) <= 0.01);
        assert.ok(Math.abs(right.positions[rightOffset]) <= 0.01);
        assert.ok(Math.abs(left.positions[leftOffset + 1] - right.positions[rightOffset + 1]) < 1e-6);
        assert.ok(Math.abs(left.positions[leftOffset + 2] - right.positions[rightOffset + 2]) < 1e-6);
        assert.deepEqual(
            [...left.normals.slice(leftOffset, leftOffset + 3)],
            [...right.normals.slice(rightOffset, rightOffset + 3)],
        );
    }
});

test('malformed packets reject indices, tile identity, and stale generations', () => {
    const reference = terrainFixture();
    const packet = compileTerrainRenderPacket(terrainRequest(reference), reference);
    const badIndex = structuredClone(packet);
    badIndex.primitives[0].indices[0] = 9999;
    assert.throws(
        () => validateRenderPacket(badIndex),
        error => error instanceof RenderPacketValidationError
            && error.code === 'index-out-of-bounds',
    );
    assert.throws(
        () => validateRenderPacket(packet, { generation: 99 }),
        error => error.code === 'generation-mismatch',
    );
    assert.throws(
        () => validateRenderPacket(packet, {
            tile: { ...packet.tile, x: packet.tile.x + 1 },
        }),
        error => error.code === 'tile-mismatch',
    );
    const badNormal = structuredClone(packet);
    badNormal.primitives[0].normals[0] = Number.NaN;
    assert.throws(
        () => validateRenderPacket(badNormal),
        error => error.code === 'non-finite-attribute',
    );
    const badClaim = structuredClone(packet);
    badClaim.primitives[0].surfaceClaims = [null];
    assert.throws(
        () => validateRenderPacket(badClaim),
        error => error.code === 'invalid-surface-claim',
    );
    const unmarkedEmpty = structuredClone(packet);
    unmarkedEmpty.primitives[0].indices = new Uint32Array();
    assert.throws(() => validateRenderPacket(unmarkedEmpty), error => error.code === 'invalid-index-count');
    const contradictoryEmpty = structuredClone(packet);
    contradictoryEmpty.primitives[0].empty = true;
    assert.throws(() => validateRenderPacket(contradictoryEmpty), error => error.code === 'invalid-empty-primitive');
});

test('packet validation bounds work across buffers, primitives and nested metadata', () => {
    const reference = terrainFixture();
    const packet = compileTerrainRenderPacket(terrainRequest(reference), reference);
    const primitive = packet.primitives[0];
    primitive.colliderData = { nested: [Array(10_000).fill(1)] };
    packet.primitives = Array(500).fill(primitive);
    const task = createRenderPacketValidationTask(packet);
    assert.equal(task.progress().checkedRecords, 0, 'construction checks only the packet envelope');
    let previous = 0, steps = 0;
    while (!task.done) {
        task.step();
        const checked = task.progress().checkedRecords;
        assert.ok(checked - previous <= RENDER_PACKET_VALIDATION_CHECKS_PER_STEP);
        previous = checked;
        steps++;
    }
    assert.ok(steps > 500, 'metadata and many small primitives share the same work quota');
    assert.equal(task.result(), packet, 'no geometry/metadata transformation');
    task.dispose();
    assert.throws(() => task.result(), /disposed/);
});

test('late packet validation errors remain terminal and preserve every rejection check', () => {
    for (const [mutate, code] of [
        [p => { p.normals[p.normals.length - 1] = NaN; }, 'non-finite-attribute'],
        [p => { p.uvs[p.uvs.length - 1] = Infinity; }, 'non-finite-attribute'],
        [p => { p.indices[p.indices.length - 1] = p.positions.length; }, 'index-out-of-bounds'],
        [p => { p.positions[p.positions.length - 1] = 1e8; }, 'position-outside-bounds'],
        [p => { p.colliderData = { nested: Array(5000).fill(1).concat(Infinity) }; }, 'non-finite-collider-field'],
        [p => { const cycle = {}; cycle.self = cycle; p.colliderData = { cycle }; }, 'cyclic-collider-data'],
        [p => { p.entityRanges[0].indexCount = p.indices.length + 1; }, 'entity-range-out-of-bounds'],
        [p => { p.surfaceClaims = [null]; }, 'invalid-surface-claim'],
    ]) {
        const reference = terrainFixture();
        const packet = compileTerrainRenderPacket(terrainRequest(reference), reference);
        mutate(packet.primitives[0]);
        const task = createRenderPacketValidationTask(packet);
        assert.throws(() => { while (!task.step()) {} }, error => error.code === code);
        assert.throws(() => task.step(), /disposed/, 'catching corruption cannot resume to success');
        assert.throws(() => task.result(), /disposed/);
        assert.throws(() => validateRenderPacket(packet), error => error.code === code);
    }
});

test('stale packet identity is rejected before looking at any primitive', () => {
    const reference = terrainFixture();
    const packet = compileTerrainRenderPacket(terrainRequest(reference), reference);
    Object.defineProperty(packet.primitives, 0, { get() { throw Error('geometry visited'); } });
    assert.throws(() => createRenderPacketValidationTask(packet, { generation: 99 }),
        error => error.code === 'generation-mismatch');
});

test('far-building packets preserve Polygon/MultiPolygon entity ownership deterministically', () => {
    const anchorLon = 16;
    const anchorLat = 45.8;
    const request = {
        compilerId: FAR_BUILDING_PACKET_COMPILER_ID,
        compilerVersion: FAR_BUILDING_PACKET_COMPILER_VERSION,
        sourceRevision: 'terrain:4',
        generation: 11,
        tile: {
            matrix: 'session-enu-v1', z: 0, x: 0, y: 0,
            originLon: anchorLon, originLat: anchorLat, sizeM: 800,
        },
        inputs: {
            anchorLon,
            anchorLat,
            tileOriginX: 0,
            tileOriginZ: 0,
            features: [
                {
                    entityId: 'polygon',
                    nearKey: '0_0',
                    color: 0xaa8844,
                    heightM: 8,
                    baseY: 2,
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[[16, 45.8], [16.0001, 45.8], [16.0001, 45.7999], [16, 45.7999], [16, 45.8]]],
                    },
                },
                {
                    entityId: 'multipolygon',
                    nearKey: '1_0',
                    color: 0x4488aa,
                    heightM: 12,
                    baseY: 3,
                    geometry: {
                        type: 'MultiPolygon',
                        coordinates: [
                            [[[16.0002, 45.8], [16.0003, 45.8], [16.0003, 45.7999], [16.0002, 45.7999], [16.0002, 45.8]]],
                            [[[16.0004, 45.8], [16.0005, 45.8], [16.0005, 45.7999], [16.0004, 45.7999], [16.0004, 45.8]]],
                        ],
                    },
                },
            ],
        },
    };
    const first = compileFarBuildingRenderPacket(request);
    const second = compileFarBuildingRenderPacket(request);
    assert.equal(first.primitives.length, 2);
    assert.equal(renderPacketFingerprint(first), renderPacketFingerprint(second));
    assert.deepEqual(
        first.primitives.map(primitive => primitive.entityRanges[0].entityId),
        ['polygon', 'multipolygon'],
    );
    assert.deepEqual(
        first.primitives.map(primitive => primitive.entityRanges[0].metadata.nearKey),
        ['0_0', '1_0'],
    );
});

test('proposal-filtered empty far input produces an explicit empty generation', () => {
    const packet = compileFarBuildingRenderPacket({
        compilerId: FAR_BUILDING_PACKET_COMPILER_ID,
        compilerVersion: FAR_BUILDING_PACKET_COMPILER_VERSION,
        sourceRevision: 'terrain:1',
        generation: 2,
        tile: {
            matrix: 'session-enu-v1', z: 0, x: 1, y: 2,
            originLon: 16, originLat: 45.8, sizeM: 800,
        },
        inputs: {
            anchorLon: 16,
            anchorLat: 45.8,
            tileOriginX: 800,
            tileOriginZ: 1600,
            features: [],
        },
    });
    assert.deepEqual(packet.primitives, []);
});
