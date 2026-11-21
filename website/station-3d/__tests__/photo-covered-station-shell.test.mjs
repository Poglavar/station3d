// Verifies the pure compact-station sweep stays sealed through bends and meets
// the running photo tunnel at the exact same endpoint cross-section.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPhotoCoveredStationMaskData,
    buildPhotoCoveredStationOwnershipTriangles,
    buildPhotoCoveredStationSweep,
    PHOTO_COVERED_STATION_SECTION,
    PHOTO_RUNNING_TUNNEL_SECTION,
    photoCoveredStationOwnershipAt,
} from '../core/photo-covered-station-shell.js';
import {
    resetWalkColliders,
    resolveWalkMove,
    setWalkColliderSource,
} from '../world/walk-collision.js';

function componentVertexY(sweep, componentName, ringIndex, cornerIndex) {
    const component = sweep.shell.components.find(item => item.name === componentName);
    const vertex = component.vertexStart + ringIndex * component.verticesPerRing + cornerIndex;
    return sweep.shell.positions[vertex * 3 + 1];
}

function geometryVertex(geometry, componentName, ringIndex, cornerIndex) {
    const component = geometry.components.find(item => item.name === componentName);
    const vertex = component.vertexStart + ringIndex * component.verticesPerRing + cornerIndex;
    return geometry.positions.slice(vertex * 3, vertex * 3 + 3);
}

function triangleWeights(px, pz, positions, vertexOffset = 0) {
    const point = index => [
        positions[(vertexOffset + index) * 3],
        positions[(vertexOffset + index) * 3 + 2],
    ];
    const [a, b, c] = [point(0), point(1), point(2)];
    const denominator = (b[1] - c[1]) * (a[0] - c[0])
        + (c[0] - b[0]) * (a[1] - c[1]);
    const wa = ((b[1] - c[1]) * (px - c[0])
        + (c[0] - b[0]) * (pz - c[1])) / denominator;
    const wb = ((c[1] - a[1]) * (px - c[0])
        + (a[0] - c[0]) * (pz - c[1])) / denominator;
    return [wa, wb, 1 - wa - wb];
}

function hasTriangle(indices, a, b, c) {
    const wanted = new Set([a, b, c]);
    for (let index = 0; index < indices.length; index += 3) {
        if (wanted.has(indices[index])
            && wanted.has(indices[index + 1])
            && wanted.has(indices[index + 2])) return true;
    }
    return false;
}

function triangleContainsXZ(positions, vertexIndices, x, z) {
    const triangle = [];
    for (const vertex of vertexIndices) {
        triangle.push(
            positions[vertex * 3],
            0,
            positions[vertex * 3 + 2],
        );
    }
    return triangleWeights(x, z, triangle).every(weight => weight >= -1e-9);
}

function maskContainsXZ(mask, x, z) {
    for (let vertex = 0; vertex < mask.positions.length / 3; vertex += 6) {
        if (triangleContainsXZ(mask.positions, [vertex, vertex + 1, vertex + 2], x, z)
            || triangleContainsXZ(mask.positions, [vertex + 3, vertex + 4, vertex + 5], x, z)) {
            return true;
        }
    }
    return false;
}

function lastMaskPayloadAt(mask, x, z) {
    let payload = null;
    for (let vertex = 0; vertex < mask.positions.length / 3; vertex += 3) {
        const weights = triangleWeights(x, z, mask.positions, vertex);
        if (!weights.every(weight => weight >= -1e-9)) continue;
        payload = weights.reduce((sum, weight, index) => (
            sum + weight * mask.colors[(vertex + index) * 3 + 2]
        ), 0);
    }
    return payload;
}

function spanTopContainsXZ(sweep, componentName, ringIndex, x, z) {
    const component = sweep.shell.components.find(item => item.name === componentName);
    const start = component.vertexStart + ringIndex * component.verticesPerRing;
    const next = start + component.verticesPerRing;
    const startTopMax = start + 2;
    const startTopMin = start + 3;
    const nextTopMax = next + 2;
    const nextTopMin = next + 3;
    return triangleContainsXZ(
        sweep.shell.positions,
        [startTopMax, nextTopMax, nextTopMin],
        x,
        z,
    ) || triangleContainsXZ(
        sweep.shell.positions,
        [startTopMax, nextTopMin, startTopMin],
        x,
        z,
    );
}

function endpointFanTopContainsXZ(sweep, componentName, atStart, x, z) {
    return sweep.shell.endpointFanFaces.some(face => (
        face.component === componentName
        && face.atStart === atStart
        && face.topTriangles.some(vertices => (
            triangleContainsXZ(sweep.shell.positions, vertices, x, z)
        ))
    ));
}

function signedArea(points) {
    const [a, b, c] = points;
    return (b[0] - a[0]) * (c[1] - a[1])
        - (b[1] - a[1]) * (c[0] - a[0]);
}

function ownershipTriangleContains(triangle, x, z, epsilon = 1e-9) {
    const positions = triangle.points.flatMap(point => [point[0], 0, point[1]]);
    return triangleWeights(x, z, positions).every(weight => weight >= -epsilon);
}

function ownershipTriangleWeights(triangle, x, z) {
    const positions = triangle.points.flatMap(point => [point[0], 0, point[1]]);
    return triangleWeights(x, z, positions);
}

test('curved station uses shared indexed rings and exact tunnel endpoint sections', () => {
    const sweep = buildPhotoCoveredStationSweep([
        { x: -20, y: 10, z: 0 },
        { x: 0, y: 12, z: 0 },
        { x: 0, y: 14, z: 20 },
    ], {
        maxStepM: 100,
        transitionLengthM: 8,
    });

    assert.equal(sweep.rings.length, 3);
    assert.deepEqual(sweep.rings[0].section, PHOTO_RUNNING_TUNNEL_SECTION);
    assert.deepEqual(sweep.rings[2].section, PHOTO_RUNNING_TUNNEL_SECTION);
    assert.deepEqual(sweep.rings[1].section, PHOTO_COVERED_STATION_SECTION);
    assert.ok(Math.abs(sweep.rings[1].miterScale - Math.SQRT2) < 1e-9);

    assert.equal(sweep.shell.components.length, 4);
    assert.equal(sweep.shell.positions.length / 3, 4 * 3 * 4);
    assert.equal(sweep.shell.indices.length, 4 * (2 * 4 * 6 + 12));
    for (const component of sweep.shell.components) {
        assert.equal(component.ringCount, 3);
        // One middle-ring vertex set is referenced by both adjacent spans. A
        // box-per-span implementation would need two disconnected copies here.
        const middle = new Set([
            component.vertexStart + 4,
            component.vertexStart + 5,
            component.vertexStart + 6,
            component.vertexStart + 7,
        ]);
        const referenced = sweep.shell.indices.filter(index => middle.has(index));
        assert.ok(referenced.length >= 16);
    }

    assert.equal(
        componentVertexY(sweep, 'roof', 0, 2),
        10 + PHOTO_RUNNING_TUNNEL_SECTION.roofTopOffsetM,
    );
    assert.equal(
        componentVertexY(sweep, 'roof', 1, 2),
        12 + PHOTO_COVERED_STATION_SECTION.roofTopOffsetM,
    );
    assert.equal(
        componentVertexY(sweep, 'roof', 2, 2),
        14 + PHOTO_RUNNING_TUNNEL_SECTION.roofTopOffsetM,
    );
});

test('CPU source ownership interpolates the exact GPU mask triangle on a graded miter', () => {
    const tunnelRoofOffsetM = PHOTO_RUNNING_TUNNEL_SECTION.sourceRoofOffsetM;
    const sweep = buildPhotoCoveredStationSweep([
        { x: -30, y: 0, z: 0 },
        { x: 0, y: 10, z: 0 },
        { x: 0, y: 30, z: 30 },
    ], { maxStepM: 100 });
    const mask = buildPhotoCoveredStationMaskData(sweep, {
        encodeFloor: value => value,
        tunnelSourceRoofOffsetM: tunnelRoofOffsetM,
    });
    const query = { x: -15, z: 0 };
    const weights = triangleWeights(query.x, query.z, mask.positions);
    assert.ok(weights.every(weight => weight >= -1e-9));
    const gpuPayload = weights.reduce((sum, weight, index) => (
        sum + weight * mask.colors[index * 3 + 2]
    ), 0);
    const cpu = photoCoveredStationOwnershipAt(sweep, query.x, query.z);
    assert.ok(cpu);
    assert.ok(Math.abs(cpu.roofY - (gpuPayload + tunnelRoofOffsetM)) < 1e-9);

    const oldProjectedTrackY = 5;
    assert.ok(Math.abs(cpu.trackY - oldProjectedTrackY) > 1,
        'the regression point distinguishes triangle interpolation from centreline projection');
});

test('outside route context joins and caps both ownership-boundary adapters', () => {
    const sweep = buildPhotoCoveredStationSweep([
        { x: 0, y: 4, z: 0 },
        { x: 20, y: 5, z: 0 },
        { x: 20, y: 6, z: 20 },
    ], {
        maxStepM: 100,
        startContext: { x: 0, y: 3, z: -20 },
        endContext: { x: 40, y: 7, z: 20 },
    });

    assert.equal(sweep.rings.length, 3,
        'endpoint context adds no duplicate or zero-length cross-section');
    for (const ring of [sweep.rings[0], sweep.rings.at(-1)]) {
        assert.deepEqual(ring.section, PHOTO_RUNNING_TUNNEL_SECTION);
        assert.equal(ring.miterScale, 1);
        assert.equal(ring.ownedBoundaryFrame, true);
    }
    assert.deepEqual(
        [sweep.rings[0].rightX, sweep.rings[0].rightZ],
        [-0, 1],
        'start owner ring is perpendicular to its first station segment',
    );
    assert.deepEqual(
        [sweep.rings.at(-1).rightX, sweep.rings.at(-1).rightZ],
        [-1, 0],
        'end owner ring is perpendicular to its last station segment',
    );
    assert.equal(sweep.endpointFans.length, 2);
    for (const fan of sweep.endpointFans) {
        assert.ok(Math.abs(fan.miterRightX + 1) < 1e-9);
        assert.ok(Math.abs(fan.miterRightZ - 1) < 1e-9);
        assert.deepEqual(fan.outerSides, [1]);
    }
    assert.deepEqual(
        [sweep.endpointFans[0].outsideRightX, sweep.endpointFans[0].outsideRightZ],
        [-1, 0],
    );
    assert.deepEqual(
        [sweep.endpointFans[0].ownedRightX, sweep.endpointFans[0].ownedRightZ],
        [-0, 1],
    );
    assert.deepEqual(
        [sweep.endpointFans[1].outsideRightX, sweep.endpointFans[1].outsideRightZ],
        [-0, 1],
    );
    assert.deepEqual(
        [sweep.endpointFans[1].ownedRightX, sweep.endpointFans[1].ownedRightZ],
        [-1, 0],
    );
    assert.deepEqual(
        [sweep.rings[0].x, sweep.rings[0].y, sweep.rings[0].z],
        [0, 4, 0],
    );
    assert.deepEqual(
        [sweep.rings.at(-1).x, sweep.rings.at(-1).y, sweep.rings.at(-1).z],
        [20, 6, 20],
    );
    for (const component of sweep.shell.components) {
        const start = component.vertexStart;
        const end = start + (component.ringCount - 1) * component.verticesPerRing;
        assert.equal(component.capped, true);
        assert.ok(hasTriangle(sweep.shell.indices, start, start + 2, start + 3),
            `${component.name} start boundary is capped`);
        assert.ok(hasTriangle(sweep.shell.indices, end, end + 1, end + 2),
            `${component.name} end boundary is capped`);
    }
});

test('both boundary connectors fill the union wedge beside perpendicular tunnel faces', () => {
    const cases = [
        {
            label: 'start',
            sweep: buildPhotoCoveredStationSweep([
                { x: 0, y: 0, z: 0 },
                { x: 20, y: 0, z: 0 },
            ], {
                maxStepM: 2,
                startContext: { x: 0, y: 0, z: -20 },
            }),
            query: { x: -6, z: 3 },
            adjacentOwns: ({ x, z }) => Math.abs(x) <= 12 && z >= -20 && z <= 0,
            atStart: true,
        },
        {
            label: 'end',
            sweep: buildPhotoCoveredStationSweep([
                { x: -20, y: 0, z: 0 },
                { x: 0, y: 0, z: 0 },
            ], {
                maxStepM: 2,
                endContext: { x: 0, y: 0, z: 20 },
            }),
            query: { x: 6, z: -3 },
            adjacentOwns: ({ x, z }) => Math.abs(x) <= 12 && z >= 0 && z <= 20,
            atStart: false,
        },
    ];
    for (const item of cases) {
        const mask = buildPhotoCoveredStationMaskData(item.sweep, {
            encodeFloor: value => value,
        });
        assert.equal(item.adjacentOwns(item.query), false,
            `${item.label}: adjacent tunnel rectangle stops at its perpendicular face`);
        assert.equal(maskContainsXZ(mask, item.query.x, item.query.z), true,
            `${item.label}: station mask fills the bend union wedge above the base red join`);
        const cpu = photoCoveredStationOwnershipAt(
            item.sweep,
            item.query.x,
            item.query.z,
        );
        assert.ok(cpu, `${item.label}: CPU owns the same connector`);
        const gpuPayload = lastMaskPayloadAt(mask, item.query.x, item.query.z);
        assert.ok(Math.abs(cpu.roofY - (
            gpuPayload + PHOTO_RUNNING_TUNNEL_SECTION.sourceRoofOffsetM
        )) < 1e-9, `${item.label}: CPU follows the GPU's last overlapping triangle`);
        assert.equal(endpointFanTopContainsXZ(
            item.sweep,
            'roof',
            item.atStart,
            item.query.x,
            item.query.z,
        ), true, `${item.label}: physical roof seals the connector`);
        assert.equal(endpointFanTopContainsXZ(
            item.sweep,
            'floor',
            item.atStart,
            item.query.x,
            item.query.z,
        ), true, `${item.label}: physical floor seals the connector`);
    }
});

test('endpoint corner fans have positive non-crossing ownership and physical triangles', () => {
    const cases = [
        {
            label: 'start clockwise',
            samples: [{ x: 0, y: 4, z: 0 }, { x: 20, y: 8, z: 0 }],
            options: { startContext: { x: 0, y: 2, z: -20 } },
        },
        {
            label: 'start counter-clockwise',
            samples: [{ x: 0, y: 4, z: 0 }, { x: 20, y: 8, z: 0 }],
            options: { startContext: { x: 0, y: 2, z: 20 } },
        },
        {
            label: 'end counter-clockwise',
            samples: [{ x: -20, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }],
            options: { endContext: { x: 0, y: 6, z: 20 } },
        },
        {
            label: 'end clockwise',
            samples: [{ x: -20, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }],
            options: { endContext: { x: 0, y: 6, z: -20 } },
        },
    ];
    for (const item of cases) {
        const sweep = buildPhotoCoveredStationSweep(item.samples, {
            maxStepM: 100,
            ...item.options,
        });
        const fanTriangles = buildPhotoCoveredStationOwnershipTriangles(sweep)
            .filter(triangle => triangle.kind === 'endpoint-fan');
        assert.equal(fanTriangles.length, 2, `${item.label}: two-triangle wedge`);
        for (const triangle of fanTriangles) {
            assert.ok(signedArea(triangle.points) > 1e-7,
                `${item.label}: ownership triangle is consistently wound and non-degenerate`);
        }
        for (let x = -11.63; x <= 11.63; x += 0.91) {
            for (let z = -11.27; z <= 11.27; z += 0.83) {
                const strictHits = fanTriangles.filter(triangle => (
                    ownershipTriangleWeights(triangle, x, z).every(weight => weight > 1e-7)
                )).length;
                assert.ok(strictHits <= 1,
                    `${item.label}: fan has no crossed or multiply-owned interior at ${x},${z}`);
            }
        }
        for (const component of ['floor', 'roof']) {
            const faces = sweep.shell.endpointFanFaces.filter(face => (
                face.component === component
            ));
            assert.equal(faces.length, 1, `${item.label}: one physical ${component} wedge`);
            for (const vertices of faces[0].topTriangles) {
                const points = vertices.map(vertex => [
                    sweep.shell.positions[vertex * 3],
                    sweep.shell.positions[vertex * 3 + 2],
                ]);
                assert.ok(signedArea(points) > 1e-7,
                    `${item.label}: physical ${component} fan is non-degenerate`);
            }
        }
        const lightFaces = sweep.light.endpointFanFaces;
        assert.equal(lightFaces.length, 1, `${item.label}: light owns the same corner fan`);
        for (const vertices of lightFaces[0].topTriangles) {
            const points = vertices.map(vertex => [
                sweep.light.positions[vertex * 3],
                sweep.light.positions[vertex * 3 + 2],
            ]);
            assert.ok(signedArea(points) > 1e-7,
                `${item.label}: physical light fan is non-degenerate`);
        }
        const wall = sweep.shell.components.find(component => component.endpointFan);
        assert.ok(wall, `${item.label}: exterior wall uses a route-corner band`);
        const wallTopAreas = [];
        for (let ringIndex = 1; ringIndex < wall.ringCount; ringIndex++) {
            const before = wall.vertexStart + (ringIndex - 1) * wall.verticesPerRing;
            const after = before + wall.verticesPerRing;
            for (const vertices of [
                [before + 2, after + 2, after + 3],
                [before + 2, after + 3, before + 3],
            ]) {
                const points = vertices.map(vertex => [
                    sweep.shell.positions[vertex * 3],
                    sweep.shell.positions[vertex * 3 + 2],
                ]);
                wallTopAreas.push(signedArea(points));
            }
        }
        assert.ok(wallTopAreas.every(area => Math.abs(area) > 1e-7));
        assert.ok(wallTopAreas.every(area => Math.sign(area) === Math.sign(wallTopAreas[0])),
            `${item.label}: exterior wall band does not cross or reverse`);
        assert.equal(sweep.wallColliders.length, 4,
            `${item.label}: two running wall owners plus two exterior corner colliders`);
    }
});

test('graded CPU ownership matches every emitted GPU primitive through endpoint fan', () => {
    const sweep = buildPhotoCoveredStationSweep([
        { x: 0, y: 4, z: 0 },
        { x: 20, y: 12, z: 0 },
    ], {
        maxStepM: 100,
        startContext: { x: 0, y: 1, z: -20 },
    });
    const triangles = buildPhotoCoveredStationOwnershipTriangles(sweep);
    const mask = buildPhotoCoveredStationMaskData(sweep, {
        encodeFloor: value => value,
    });
    const queries = [
        { x: -8.4, z: 2.7 },
        { x: -2.2, z: 9.1 },
        { x: 1.7, z: -8.3 },
        { x: 6.4, z: 3.1 },
        { x: 14.6, z: -1.9 },
    ];
    for (const query of queries) {
        const matches = triangles.filter(triangle => (
            ownershipTriangleContains(triangle, query.x, query.z)
        ));
        assert.ok(matches.length >= 1, `query ${query.x},${query.z} is owned`);
        const triangle = matches.at(-1);
        const weights = ownershipTriangleWeights(triangle, query.x, query.z);
        const expectedTrackY = weights.reduce((sum, weight, index) => (
            sum + weight * triangle.trackYs[index]
        ), 0);
        const expectedRoofY = weights.reduce((sum, weight, index) => (
            sum + weight * triangle.roofYs[index]
        ), 0);
        const cpu = photoCoveredStationOwnershipAt(sweep, query.x, query.z);
        assert.ok(Math.abs(cpu.trackY - expectedTrackY) < 1e-9);
        assert.ok(Math.abs(cpu.roofY - expectedRoofY) < 1e-9);
        assert.ok(Math.abs(lastMaskPayloadAt(mask, query.x, query.z)
            + PHOTO_RUNNING_TUNNEL_SECTION.sourceRoofOffsetM - expectedRoofY) < 1e-9);
    }
});

test('exact reversal is split through an orthogonal four-triangle fan', () => {
    const sweep = buildPhotoCoveredStationSweep([
        { x: 0, y: 0, z: 0 },
        { x: 20, y: 0, z: 0 },
    ], {
        maxStepM: 100,
        startContext: { x: 20, y: 0, z: 0 },
    });
    assert.deepEqual(sweep.endpointFans[0].outerSides, [-1, 1]);
    const triangles = buildPhotoCoveredStationOwnershipTriangles(sweep)
        .filter(triangle => triangle.kind === 'endpoint-fan');
    assert.equal(triangles.length, 4);
    assert.ok(triangles.every(triangle => signedArea(triangle.points) > 1e-7));
    for (let x = -11.43; x <= 11.43; x += 0.87) {
        for (let z = -11.19; z <= 11.19; z += 0.79) {
            const strictHits = triangles.filter(triangle => (
                ownershipTriangleWeights(triangle, x, z).every(weight => weight > 1e-7)
            )).length;
            assert.ok(strictHits <= 1, `reversal fan does not cross at ${x},${z}`);
        }
    }
});

test('canonical side platform and tactile identity follow the same graded route sweep', () => {
    const sweep = buildPhotoCoveredStationSweep([
        { x: -30, y: 0, z: 0 },
        { x: 0, y: 3, z: 0 },
        { x: 0, y: 6, z: 30 },
    ], {
        maxStepM: 100,
        platform: {
            sideM: 3.2,
            widthM: 3,
            heightM: 0.9,
            lengthM: 20,
            center: { x: 0, z: 0 },
            label: 'Bend Station With A Deliberately Long Name',
        },
    });

    assert.deepEqual(sweep.platformLayout, {
        sideM: 3.2,
        widthM: 3,
        heightM: 0.9,
        lengthM: 20,
        startM: 20,
        endM: 40,
        centerM: 30,
        trackSideEdgeM: 1.7000000000000002,
    });
    assert.ok(sweep.platform);
    assert.ok(sweep.identity);
    assert.equal(sweep.platform.components[0].name, 'route-platform');
    assert.equal(sweep.platform.components[0].ringCount, 3);
    assert.equal(sweep.identity.components[0].name, 'tactile-station-edge');
    assert.equal(sweep.identity.components[0].ringCount, 3);
    assert.equal(sweep.nameBoard.label, 'Bend Station With A Delibera');
    assert.equal(sweep.nameBoard.ringCount, 3);
    assert.deepEqual(sweep.nameBoard.uvs.slice(0, 4), [0, 0, 0, 1]);
    assert.deepEqual(sweep.nameBoard.uvs.slice(-4), [1, 0, 1, 1]);

    const startTrackSide = geometryVertex(sweep.platform, 'route-platform', 0, 3);
    assert.ok(Math.abs(startTrackSide[0] - -10) < 1e-9);
    assert.ok(Math.abs(startTrackSide[1] - 2.9) < 1e-9);
    assert.ok(Math.abs(startTrackSide[2] - 1.7) < 1e-9);
    const bendTrackSide = geometryVertex(sweep.platform, 'route-platform', 1, 3);
    assert.ok(Math.abs(bendTrackSide[0] - -1.7) < 1e-9);
    assert.ok(Math.abs(bendTrackSide[1] - 3.9) < 1e-9);
    assert.ok(Math.abs(bendTrackSide[2] - 1.7) < 1e-9);
    const edgeTop = geometryVertex(sweep.identity, 'tactile-station-edge', 1, 3);
    assert.ok(edgeTop[1] > bendTrackSide[1], 'identity strip remains visible above platform');
    const boardBendBottom = sweep.nameBoard.positions.slice(6, 9);
    assert.ok(boardBendBottom[0] < -8 && boardBendBottom[2] > 8,
        'name board uses the same outside-bend miter as the station wall');
});

test('mitered mask and shell close the outside wedge of a ninety-degree bend', () => {
    const sweep = buildPhotoCoveredStationSweep([
        { x: -30, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 30 },
    ], { maxStepM: 100 });
    const mask = buildPhotoCoveredStationMaskData(sweep, {
        encodeFloor: value => value / 100,
    });

    assert.equal(mask.positions.length, 2 * 6 * 3);
    assert.ok(photoCoveredStationOwnershipAt(sweep, 6, -6));
    assert.equal(photoCoveredStationOwnershipAt(sweep, 13, -13), null);
    const bend = sweep.rings[1];
    assert.ok(Math.abs(bend.rightX + 1) < 1e-9);
    assert.ok(Math.abs(bend.rightZ - 1) < 1e-9);
});

test('densified graded sweep carries route elevation into every roof ring', () => {
    const sweep = buildPhotoCoveredStationSweep([
        { x: 0, y: 3, z: 0 },
        { x: 24, y: 6, z: 0 },
    ], {
        maxStepM: 2,
        transitionLengthM: 6,
    });
    assert.equal(sweep.rings.length, 13);
    assert.equal(sweep.rings[0].y, 3);
    assert.equal(sweep.rings[6].y, 4.5);
    assert.equal(sweep.rings[12].y, 6);
    assert.equal(
        componentVertexY(sweep, 'roof', 6, 2),
        sweep.rings[6].y + sweep.rings[6].section.roofTopOffsetM,
    );
    assert.equal(sweep.wallColliders.length, (sweep.rings.length - 1) * 2);
});

test('swept wall metadata remains solid to walk mode without visible box geometry', () => {
    const mesh = {
        isMesh: true,
        visible: true,
        userData: {
            walkColliderBoxes: [{
                cx: 1,
                cz: 0,
                hx: 0.1,
                hz: 2,
                sin: 0,
                cos: 1,
                minY: -4,
                maxY: 8,
                reach: 2.4,
            }],
        },
    };
    const group = {
        uuid: 'covered-station-collider-test',
        children: [mesh],
        updateWorldMatrix() {},
        traverse(visitor) { visitor(mesh); },
    };
    setWalkColliderSource(() => [group]);
    try {
        const moved = resolveWalkMove(0, 0, 2, 0, 0);
        assert.ok(moved.x < 1, 'the walker stops at the swept wall metadata');
    } finally {
        setWalkColliderSource(null);
        resetWalkColliders();
    }
});
