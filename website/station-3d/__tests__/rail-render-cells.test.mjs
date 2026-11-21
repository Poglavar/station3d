// Correctness story for the rail render-cell partition: chords land in exactly
// one cell by midpoint, a junction node's cell sees the node's COMPLETE fan
// even when its arms' chords live in neighbouring cells, signatures ignore
// object identity and input order but change for every field a mesh builder
// consumes, and selection never drops geometry that lies inside the active
// radius just because its cell centre sits outside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RAIL_RENDER_CELL_M,
    railSegmentMidpointCellKey,
    railSegmentOwnedCellKeys,
    junctionIncidentsFromSegments,
    partitionRailSegmentsIntoCells,
    railRenderCellSignature,
    railRenderCellSignatures,
    changedRailRenderCellKeys,
    changedRailSegmentRenderCellKeys,
    railRenderCellKeysIntersectingBounds,
    selectRailRenderCells,
    boundsIntersectAnyRailSegment,
    railSegmentsIntersectingBounds,
    partitionRailSegmentsIntoCellsSteps,
    railRenderSegmentBatchesSteps,
    railRenderSegmentBatches,
} from '../core/rail-render-cells.js';

const CELL_M = 100;

function segment(overrides = {}) {
    return {
        x1: 10, z1: 10, x2: 20, z2: 10,
        yStart: 0.5, yEnd: 0.6,
        startJoinX: 0, startJoinZ: 1, endJoinX: 0, endJoinZ: 1,
        gaugeM: 1,
        uStart: 0, len: 10,
        startTrackCenterOffsetsM: [0], endTrackCenterOffsetsM: [0],
        startTrackbedHalfWidthM: 1.5, endTrackbedHalfWidthM: 1.5,
        startTrackbedInnerEdgeM: 0, endTrackbedInnerEdgeM: 0,
        startKey: 'n:10,10', endKey: 'n:20,10',
        ...overrides,
    };
}

test('chords are assigned to exactly one cell, by midpoint', () => {
    const inside = segment();                                          // midpoint (15,10) → 0:0
    const straddling = segment({
        x1: 95, z1: 10, x2: 125, z2: 10,                               // midpoint (110,10) → 1:0
        startKey: 'n:95,10', endKey: 'n:125,10',
    });
    assert.equal(railSegmentMidpointCellKey(inside, CELL_M), '0:0');
    assert.equal(railSegmentMidpointCellKey(straddling, CELL_M), '1:0');
    const cells = partitionRailSegmentsIntoCells([inside, straddling], CELL_M);
    assert.deepEqual(cells.get('0:0').segments, [inside]);
    assert.deepEqual(cells.get('1:0').segments, [straddling]);
});

test('an unready chord protects its strip cell and both junction-owner cells', () => {
    const crossing = segment({
        x1: 95,
        z1: 10,
        x2: 205,
        z2: 10,
    });
    assert.deepEqual(
        [...railSegmentOwnedCellKeys(crossing, CELL_M)].sort(),
        ['0:0', '1:0', '2:0'],
    );
});

test('a junction node cell owns the complete fan across cell boundaries', () => {
    // Three arms meet at (100, 50): the node sits in cell 1:0, but two arms'
    // midpoints land in cell 0:0. The fan must be built once, in 1:0, from all
    // three incidents — never from a partial arm list per cell.
    const node = { x: 100, z: 50, key: 'n:100,50' };
    const west = segment({
        x1: 40, z1: 50, x2: node.x, z2: node.z,
        startKey: 'n:40,50', endKey: node.key,
        endTrackbedHalfWidthM: 2.0,
        ownsCivilGround: true,
    });
    const southWest = segment({
        x1: 60, z1: 20, x2: node.x, z2: node.z,
        startKey: 'n:60,20', endKey: node.key,
    });
    const east = segment({
        x1: node.x, z1: node.z, x2: 160, z2: 50,
        startKey: node.key, endKey: 'n:160,50',
    });
    const cells = partitionRailSegmentsIntoCells([west, southWest, east], CELL_M);
    const owner = cells.get('1:0');
    assert.equal(owner.junctionIncidents.get(node.key).length, 3);
    // The neighbouring cell holds the two arm chords but no incidents for a
    // node it does not contain.
    assert.equal(cells.get('0:0').segments.length, 2);
    assert.equal(cells.get('0:0').junctionIncidents.has(node.key), false);
    // Incident order preserves input order: the fan centre (first incident)
    // stays what the pre-partition build used.
    const [first] = owner.junctionIncidents.get(node.key);
    assert.equal(first.halfWidth, west.endTrackbedHalfWidthM);
    assert.equal(first.ownsCivilGround, true);
});

test('a cell can own a junction without owning any strip chords', () => {
    // Both chords' midpoints stay in 0:0 but their shared node sits in 1:0.
    const nodeKey = 'n:100,10';
    const a = segment({ x1: 55, z1: 10, x2: 100, z2: 10, startKey: 'n:55,10', endKey: nodeKey });
    const b = segment({ x1: 100, z1: 10, x2: 58, z2: 14, startKey: nodeKey, endKey: 'n:58,14' });
    const cells = partitionRailSegmentsIntoCells([a, b], CELL_M);
    assert.equal(cells.get('1:0').segments.length, 0);
    assert.equal(cells.get('1:0').junctionIncidents.get(nodeKey).length, 2);
});

test('signatures ignore input order and object identity', () => {
    const a = segment();
    const b = segment({ x1: 30, z1: 30, x2: 40, z2: 30, startKey: 'n:30,30', endKey: 'n:40,30' });
    const forward = partitionRailSegmentsIntoCells([a, b], CELL_M);
    const reversed = partitionRailSegmentsIntoCells(
        [{ ...b }, { ...a }],
        CELL_M,
    );
    assert.equal(
        railRenderCellSignature(forward.get('0:0')),
        railRenderCellSignature(reversed.get('0:0')),
    );
});

test('every consumed field changes the signature', () => {
    const base = () => partitionRailSegmentsIntoCells([segment()], CELL_M).get('0:0');
    const reference = railRenderCellSignature(base());
    const changed = [
        { yEnd: 0.7 },
        { endTrackbedHalfWidthM: 2.2 },
        { startTrackCenterOffsetsM: [0, 3] },
        { endJoinX: 0.1 },
        { uStart: 4 },
        { startTrackbedInnerEdgeM: 0.4 },
        { gaugeM: 1.435 },
        { ownsCivilGround: true },
        { heavyRail: true },
    ];
    for (const override of changed) {
        const cells = partitionRailSegmentsIntoCells([segment(override)], CELL_M);
        assert.notEqual(
            railRenderCellSignature(cells.get('0:0')),
            reference,
            `expected ${Object.keys(override)[0]} to change the signature`,
        );
    }
});

test('cell signatures retain the six-decimal geometry precision contract', () => {
    const signatureAt = yEnd => railRenderCellSignature(
        partitionRailSegmentsIntoCells([segment({ yEnd })], CELL_M).get('0:0'),
    );
    const reference = signatureAt(0.6);
    assert.equal(signatureAt(0.6000004), reference, 'sub-precision noise stays ignored');
    assert.notEqual(signatureAt(0.6000011), reference, 'a rendered micrometre remains visible');
});

test('a neighbour-cell chord height change rebuilds the junction owner cell', () => {
    // The node lives in 1:0; the west arm's chord lives in 0:0. Raising the
    // arm's end height must dirty BOTH cells: 0:0 for its strip, 1:0 for the
    // fan whose average height it feeds.
    const nodeKey = 'n:100,50';
    const arm = (yEnd) => segment({
        x1: 40, z1: 50, x2: 100, z2: 50, yEnd,
        startKey: 'n:40,50', endKey: nodeKey,
    });
    const others = [
        segment({ x1: 60, z1: 20, x2: 100, z2: 50, startKey: 'n:60,20', endKey: nodeKey }),
        segment({ x1: 100, z1: 50, x2: 160, z2: 50, startKey: nodeKey, endKey: 'n:160,50' }),
    ];
    const before = railRenderCellSignatures(
        partitionRailSegmentsIntoCells([arm(0.6), ...others], CELL_M),
    );
    const after = railRenderCellSignatures(
        partitionRailSegmentsIntoCells([arm(1.6), ...others], CELL_M),
    );
    assert.deepEqual(
        changedRailRenderCellKeys(before, after).sort(),
        ['0:0', '1:0'],
    );
    assert.deepEqual(
        [...changedRailSegmentRenderCellKeys(
            [arm(0.6), ...others],
            [arm(1.6), ...others],
            CELL_M,
        )].sort(),
        ['0:0', '1:0'],
        'the scoped diff includes both strip and complete-fan owner cells',
    );
});

test('selected partition rebuilds complete incidents only for affected cells', () => {
    const nodeKey = 'n:100,50';
    const segments = [
        segment({ x1: 40, z1: 50, x2: 100, z2: 50, endKey: nodeKey }),
        segment({
            x1: 100, z1: 50, x2: 160, z2: 50,
            startKey: nodeKey,
            endKey: 'n:160,50',
        }),
        segment({
            x1: 450, z1: 450, x2: 470, z2: 450,
            startKey: 'far-a',
            endKey: 'far-b',
        }),
    ];
    const selected = partitionRailSegmentsIntoCells(
        segments,
        CELL_M,
        new Set(['1:0']),
    );
    assert.deepEqual([...selected.keys()], ['1:0']);
    assert.equal(selected.get('1:0').junctionIncidents.get(nodeKey).length, 2,
        'fan keeps the neighbour-cell arm that it consumes');
    assert.equal(selected.has('4:4'), false);
});

test('changed keys cover added, removed and modified cells only', () => {
    const previous = new Map([['0:0', 'a'], ['1:0', 'b'], ['2:0', 'c']]);
    const next = new Map([['0:0', 'a'], ['1:0', 'B'], ['3:0', 'd']]);
    assert.deepEqual(
        changedRailRenderCellKeys(previous, next).sort(),
        ['1:0', '2:0', '3:0'],
    );
    assert.deepEqual(changedRailRenderCellKeys(previous, new Map(previous)), []);
});

test('bounds intersection selects only known cells touching a rect', () => {
    const known = ['0:0', '1:0', '2:0', '5:5'];
    const hit = railRenderCellKeysIntersectingBounds(
        known,
        [{ minX: 90, maxX: 110, minZ: 10, maxZ: 20 }],
        { cellM: CELL_M },
    );
    assert.deepEqual([...hit].sort(), ['0:0', '1:0']);
    const padded = railRenderCellKeysIntersectingBounds(
        known,
        [{ minX: 210, maxX: 220, minZ: 10, maxZ: 20 }],
        { cellM: CELL_M, padM: 15 },
    );
    assert.ok(padded.has('1:0'), 'padding widens the rect into the neighbour');
    assert.deepEqual(
        [...railRenderCellKeysIntersectingBounds(known, [], { cellM: CELL_M })],
        [],
    );
    assert.deepEqual(
        [...railRenderCellKeysIntersectingBounds(known, [
            { minX: 50, maxX: 40, minZ: 0, maxZ: 10 },        // degenerate
            { minX: Number.NaN, maxX: 10, minZ: 0, maxZ: 10 }, // invalid
        ], { cellM: CELL_M })],
        [],
    );
});

test('bounded immutable-data changes select only intersecting rail chords', () => {
    const west = segment({ x1: 0, z1: 0, x2: 20, z2: 0, sortKey: 'west' });
    const near = segment({ x1: 90, z1: 0, x2: 110, z2: 0, sortKey: 'near' });
    const east = segment({ x1: 300, z1: 0, x2: 320, z2: 0, sortKey: 'east' });
    const changes = [{ minX: 120, maxX: 130, minZ: -2, maxZ: 2 }];

    assert.deepEqual(
        railSegmentsIntersectingBounds([west, near, east], changes, 12)
            .map(entry => entry.sortKey),
        ['near'],
        'the ownership radius reaches a nearby chord without selecting the network',
    );
    assert.deepEqual(railSegmentsIntersectingBounds([west], [], 12), []);
});

test('selection keeps a cell active when its centre is outside the radius but its area is not', () => {
    // Observer at origin, active radius 100: cell 1:0 (centre 150,50 for
    // cellM=100 → distance ~158) exceeds the raw radius but not radius +
    // half-diagonal (100 + 70.7): the near edge of that cell is at ~87 m.
    const { active, retain, ranked } = selectRailRenderCells(
        ['0:0', '1:0', '4:0'],
        { x: 0, z: 0 },
        { activeM: 100, evictM: 200, cellM: CELL_M },
    );
    assert.ok(active.has('0:0'));
    assert.ok(active.has('1:0'), 'half-diagonal must keep the boundary cell active');
    assert.equal(active.has('4:0'), false);
    assert.equal(retain.has('4:0'), false, 'beyond evict radius is dropped');
    assert.deepEqual(ranked.map((item) => item.key), ['0:0', '1:0', '4:0']);
});

test('junction incidents mirror the whole-batch fan input', () => {
    const nodeKey = 'n:20,10';
    const a = segment({ endKey: nodeKey, endTrackbedHalfWidthM: 2.5 });
    const b = segment({
        x1: 20, z1: 10, x2: 30, z2: 20,
        startKey: nodeKey, endKey: 'n:30,20',
        yStart: 0.9,
    });
    const incidents = junctionIncidentsFromSegments([a, b]);
    assert.deepEqual(incidents.get(nodeKey), [
        { x: 20, z: 10, ySeg: 0.6, halfWidth: 2.5, ownsCivilGround: false, heavyRail: false },
        { x: 20, z: 10, ySeg: 0.9, halfWidth: 1.5, ownsCivilGround: false, heavyRail: false },
    ]);
    assert.equal(incidents.get('n:10,10').length, 1);
});

test('the terrain-refresh gate sees padded chord boxes, not just endpoints', () => {
    const chord = segment({ x1: 0, z1: 0, x2: 100, z2: 0 });
    const nearMiss = [{ minX: 40, maxX: 60, minZ: 8, maxZ: 20 }];
    assert.equal(boundsIntersectAnyRailSegment([chord], nearMiss, 0), false);
    assert.equal(boundsIntersectAnyRailSegment([chord], nearMiss, 10), true);
    assert.equal(boundsIntersectAnyRailSegment([chord], [], 50), false);
    assert.equal(boundsIntersectAnyRailSegment([], nearMiss, 50), false);
    assert.equal(
        boundsIntersectAnyRailSegment([chord], [{ minX: 500, maxX: 600, minZ: 0, maxZ: 10 }], 40),
        false,
    );
    assert.equal(
        boundsIntersectAnyRailSegment([chord], [{ minX: Number.NaN, maxX: 600, minZ: 0, maxZ: 1 }]),
        false,
        'an invalid rect must select nothing rather than everything',
    );
});

test('default cell size stays aligned with the electrification grid', () => {
    assert.equal(RAIL_RENDER_CELL_M, 600);
});

test('cooperative partition preserves complete junction ownership', () => {
    const a = segment({ x1: 40, z1: 50, x2: 100, z2: 50, endKey: 'junction' });
    const b = segment({ x1: 100, z1: 50, x2: 160, z2: 50, startKey: 'junction' });
    let clock = 0;
    const it = partitionRailSegmentsIntoCellsSteps([a, b], CELL_M, null, { now: () => (clock += 0.6) });
    const yielded = []; let step; do { step = it.next(); if (!step.done) yielded.push(step.value); } while (!step.done);
    assert.equal(step.value.get('1:0').junctionIncidents.get('junction').length, 2);
    assert.ok(yielded.length > 0);
});

test('cooperative batches cancel on a fake clock and sync wrapper drains same compiler', () => {
    const long = segment({ x1: 0, x2: 1000, len: 1000 });
    let clock = 0; let current = true;
    const it = railRenderSegmentBatchesSteps([long], { maxSegments: 1, maxSegmentM: 10, now: () => (clock += 0.6), isCurrent: () => current });
    const first = it.next(); assert.equal(first.done, false); current = false;
    let step; do step = it.next(); while (!step.done);
    assert.equal(step.value, null);
    current = true;
    const sync = railRenderSegmentBatches([long], { maxSegments: 2, maxSegmentM: 10 });
    assert.equal(sync.length, 50);
    assert.equal(sync[0].length, 2);
});
