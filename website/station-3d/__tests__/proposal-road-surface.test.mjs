// Regression coverage for bounded, shared-station proposal-road surfaces.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildProposalRoadCoastalClosureGeometryData,
    buildProposalRoadCurbGeometryData,
    buildProposalRoadJunctionGeometryData,
    buildProposalRoadStationChunks,
    buildProposalRoadSurfaceGeometryData,
    proposalRoadFormationChangeTouchesBounds,
    proposalRoadStationChunksBounds,
    proposalRoadSurfaceOwnerNeedsRefresh,
} from '../core/proposal-road-surface.js';

test('junction apron is a bounded radial grade mesh with an explicit center sample', () => {
    const surface = buildProposalRoadJunctionGeometryData({
        centerX: 10,
        centerZ: -5,
        boundary: [
            { x: 14, z: -9 },
            { x: 6, z: -9 },
            { x: 6, z: -1 },
            { x: 14, z: -1 },
        ],
        surfaceOffsetY: 0.102,
        radialStepM: 2,
        boundaryStepM: 2,
        surfaceYAtLocal: (x, z) => 3 + x * 0.04 - z * 0.025,
    });
    assert.equal(surface.radialRingCount, 3);
    assert.equal(surface.boundaryVertexCount, 16);
    assert.equal(surface.positions.length / 3, 49);
    assert.equal(surface.indices.length / 3, 80);
    assert.ok(Math.abs(surface.positions[0] - 10) < 1e-6);
    assert.ok(Math.abs(surface.positions[1] - 3.627) < 1e-6,
        'vertex zero samples the shared topology-node grade instead of interpolating a perimeter');
    assert.ok(Math.abs(surface.positions[2] + 5) < 1e-6);

    for (let index = 0; index < surface.positions.length; index += 3) {
        const x = surface.positions[index];
        const y = surface.positions[index + 1];
        const z = surface.positions[index + 2];
        assert.ok(Math.abs(y - (3 + x * 0.04 - z * 0.025 + 0.102)) < 1e-6,
            'every radial vertex must sample the current designed grade');
    }
    const [aIndex, bIndex, cIndex] = surface.indices.slice(0, 3);
    const point = index => ({
        x: surface.positions[index * 3],
        z: surface.positions[index * 3 + 2],
    });
    const a = point(aIndex);
    const b = point(bIndex);
    const c = point(cIndex);
    const ab = { x: b.x - a.x, z: b.z - a.z };
    const ac = { x: c.x - a.x, z: c.z - a.z };
    assert.ok(ab.z * ac.x - ab.x * ac.z > 0,
        'junction triangles must face upward rather than exposing their underside');
});

test('junction tessellation stays bounded even for an oversized malformed apron', () => {
    const surface = buildProposalRoadJunctionGeometryData({
        centerX: 0,
        centerZ: 0,
        boundary: [
            { x: 100, z: -100 },
            { x: -100, z: -100 },
            { x: -100, z: 100 },
            { x: 100, z: 100 },
        ],
        radialStepM: 0.01,
        boundaryStepM: 0.01,
        surfaceYAtLocal: () => 0,
    });
    assert.equal(surface.radialRingCount, 16);
    assert.equal(surface.boundaryVertexCount, 128);
    assert.equal(surface.positions.length / 3, 2049);
    assert.equal(surface.indices.length / 3, 3968,
        'one junction remains a bounded cooperative item under hostile dimensions');
});

test('splits a kilometre-scale proposal road into bounded shared-end chunks', () => {
    const chunks = buildProposalRoadStationChunks([
        { x: 0, z: 0 },
        { x: 850, z: 80 },
        { x: 1700, z: -140 },
        { x: 2660, z: 120 },
    ]);

    assert.ok(chunks.length > 25, 'the 2.66 km corridor must not be one build item');
    for (const [index, chunk] of chunks.entries()) {
        assert.ok(chunk.lengthM <= 96 + 1e-9);
        assert.ok(chunk.stations.length <= 25,
            `chunk ${index} exceeded its bounded station count`);
        if (index === 0) continue;
        const previous = chunks[index - 1].stations.at(-1);
        const current = chunk.stations[0];
        assert.deepEqual(current, previous,
            'neighbouring chunks must share the exact seam station and frame');
    }
    const bounds = proposalRoadStationChunksBounds(chunks, 4);
    assert.ok(bounds.maxX - bounds.minX > 2600);
    assert.ok(bounds.maxZ - bounds.minZ > 250);
});

test('foundation and cycleway share vertices, triangles, and an exact vertical separation', () => {
    const [chunk] = buildProposalRoadStationChunks([
        { x: 0, z: 0 },
        { x: 45, z: 8 },
        { x: 90, z: -3 },
    ], { chunkLengthM: 200, stationSpacingM: 4 });
    const baseYs = chunk.stations.map(station => (
        Math.sin(station.chainageM / 17) * 1.2 + station.chainageM * 0.006
    ));
    const foundation = buildProposalRoadSurfaceGeometryData(
        chunk,
        [3.875, -1.125, -3.875],
        baseYs,
        0.1,
    );
    const cycleway = buildProposalRoadSurfaceGeometryData(
        chunk,
        [-1.125, -3.875],
        baseYs,
        0.108,
    );

    for (let station = 0; station < chunk.stations.length; station += 1) {
        for (let boundary = 0; boundary < 2; boundary += 1) {
            const foundationVertex = station * 3 + boundary + 1;
            const cyclewayVertex = station * 2 + boundary;
            assert.equal(
                foundation.positions[foundationVertex * 3],
                cycleway.positions[cyclewayVertex * 3],
            );
            assert.equal(
                foundation.positions[foundationVertex * 3 + 2],
                cycleway.positions[cyclewayVertex * 3 + 2],
            );
            assert.ok(Math.abs(
                cycleway.positions[cyclewayVertex * 3 + 1]
                    - foundation.positions[foundationVertex * 3 + 1]
                    - 0.008,
            ) < 2e-7, 'cycleway must remain exactly 8 mm above its foundation cell');
        }
    }

    // Foundation interval 1 and the cycleway both use the same diagonal.
    assert.deepEqual(Array.from(foundation.indices.slice(6, 12)), [1, 5, 4, 1, 2, 5]);
    assert.deepEqual(Array.from(cycleway.indices.slice(0, 6)), [0, 3, 2, 0, 1, 3]);
    const interpolateY = (geometry, indices, weights) => indices.reduce(
        (sum, vertex, index) => sum + geometry.positions[vertex * 3 + 1] * weights[index],
        0,
    );
    const weights = [0.23, 0.31, 0.46];
    const foundationInteriorY = interpolateY(foundation, [1, 5, 4], weights);
    const cyclewayInteriorY = interpolateY(cycleway, [0, 3, 2], weights);
    assert.ok(Math.abs(cyclewayInteriorY - foundationInteriorY - 0.008) < 2e-7,
        'matching triangle interiors must never reverse the material order');
});

test('curb chunks omit internal end walls and cap only the complete road ends', () => {
    const chunks = buildProposalRoadStationChunks([
        { x: 0, z: 0 },
        { x: 230, z: 0 },
    ], { chunkLengthM: 96, stationSpacingM: 4 });
    assert.equal(chunks.length, 3);
    for (const [index, chunk] of chunks.entries()) {
        const data = buildProposalRoadCurbGeometryData(
            chunk,
            3,
            1,
            chunk.stations.map(() => 2),
            0.108,
            0.25,
        );
        const lateralVertexCount = (chunk.stations.length - 1) * 12;
        const endCapVertexCount = (index === 0 ? 6 : 0) + (index === 2 ? 6 : 0);
        assert.equal(data.positions.length / 3, lateralVertexCount + endCapVertexCount,
            'an internal render seam must not become a curb across the road');
    }
});

test('a junction-trimmed road mouth has no full-width curb cap', () => {
    const [chunk] = buildProposalRoadStationChunks([
        { x: 0, z: 0 },
        { x: 30, z: 0 },
    ]);
    const baseYs = chunk.stations.map(() => 2);
    const closed = buildProposalRoadCurbGeometryData(
        chunk,
        3,
        1,
        baseYs,
        0.108,
        0.25,
    );
    const open = buildProposalRoadCurbGeometryData(
        chunk,
        3,
        1,
        baseYs,
        0.108,
        0.25,
        { capStart: false, capEnd: true },
    );
    assert.equal(closed.positions.length - open.positions.length, 18,
        'opening the junction mouth removes exactly one six-vertex curb face');
});

test('coastal closure shares the road edge and chunk seam, then seals below mapped sea', () => {
    const chunks = buildProposalRoadStationChunks([
        { x: 0, z: 0 },
        { x: 230, z: 0 },
    ], { chunkLengthM: 96, stationSpacingM: 4 });
    const build = chunk => buildProposalRoadCoastalClosureGeometryData(
        chunk,
        4,
        1,
        chunk.stations.map(station => station.chainageM * 0.01),
        0.1,
        {
            // Eastbound has left normal -Z; mapped sea starts immediately
            // outside the +4 m cross-section edge.
            isMappedSeaAtLocal: (_x, z) => z < -4,
            seaSceneY: -3.4,
        },
    );
    const first = build(chunks[0]);
    const second = build(chunks[1]);
    assert.ok(first?.positions.length > 0);
    assert.ok(second?.positions.length > 0);

    const firstSeamEdge = Array.from(first.edgeTopPoints.slice(-3));
    const secondSeamEdge = Array.from(second.edgeTopPoints.slice(0, 3));
    assert.deepEqual(firstSeamEdge, secondSeamEdge,
        'closure top consumes the exact same shared road-edge station at a chunk seam');

    const surface = buildProposalRoadSurfaceGeometryData(
        chunks[0],
        [4, -4],
        chunks[0].stations.map(station => station.chainageM * 0.01),
        0.1,
    );
    assert.deepEqual(
        Array.from(first.positions.slice(0, 3)),
        Array.from(surface.positions.slice(0, 3)),
        'the concrete apron starts on the exact outer proposal-road vertex');
    assert.ok(first.positions.some((value, index) => index % 3 === 1 && value < -3.84),
        'the retaining face must overlap below the -3.4 m sea surface');
});

test('coastal closure stays absent beside mapped land', () => {
    const [chunk] = buildProposalRoadStationChunks([
        { x: 0, z: 0 },
        { x: 30, z: 0 },
    ]);
    assert.equal(buildProposalRoadCoastalClosureGeometryData(
        chunk,
        4,
        1,
        chunk.stations.map(() => 1),
        0.1,
        { isMappedSeaAtLocal: () => false, seaSceneY: -3.4 },
    ), null, 'ordinary land must not acquire a concrete coastal apron');
});

test('formation refreshes stay bounded to proposal roads touched by the revision', () => {
    const roadBounds = { minX: 100, minZ: 200, maxX: 300, maxZ: 240 };
    assert.equal(proposalRoadFormationChangeTouchesBounds({
        full: false,
        bounds: [{ minX: -50, minZ: -50, maxX: 50, maxZ: 50 }],
    }, roadBounds), false, 'an unrelated streamed road tile must not rebuild this proposal');
    assert.equal(proposalRoadFormationChangeTouchesBounds({
        full: false,
        bounds: [{ minX: 290, minZ: 230, maxX: 330, maxZ: 260 }],
    }, roadBounds), true);
    assert.equal(proposalRoadFormationChangeTouchesBounds({ full: true, bounds: [] }, roadBounds), true,
        'a lost revision history must conservatively refresh the visible road');
});

test('road branches and junction aprons share the bounded formation-refresh contract', () => {
    const change = {
        revision: 12,
        full: false,
        bounds: [{ minX: 90, minZ: 190, maxX: 110, maxZ: 210 }],
    };
    const branch = {
        renderedFormationRevision: 11,
        surfaceBounds: { minX: 100, minZ: 200, maxX: 300, maxZ: 240 },
    };
    const junction = {
        renderedFormationRevision: 11,
        surfaceBounds: { minX: 96, minZ: 196, maxX: 104, maxZ: 204 },
    };
    assert.equal(proposalRoadSurfaceOwnerNeedsRefresh(branch, change), true);
    assert.equal(proposalRoadSurfaceOwnerNeedsRefresh(junction, change), true);
    assert.equal(proposalRoadSurfaceOwnerNeedsRefresh({
        ...junction,
        renderedFormationRevision: 12,
    }, change), false, 'an apron already built from this generation is not rebuilt');
    assert.equal(proposalRoadSurfaceOwnerNeedsRefresh({
        renderedFormationRevision: 11,
        surfaceBounds: { minX: 500, minZ: 500, maxX: 510, maxZ: 510 },
    }, change), false, 'an unrelated formation tile cannot fan out to every junction');
});
