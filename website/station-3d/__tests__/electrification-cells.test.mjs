// Verifies catenary cell ownership, geometry budget, grouping, and lifecycle radii.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    changedElectrificationCellKeys,
    createChangedElectrificationCellKeysTask,
    createElectrificationSpanStagingTask,
    createOwnedElectrificationSpansTask,
    electrificationCellSignature,
    electrificationCellKeysTouchingBounds,
    electrificationNeighborhoodSignature,
    ownedElectrificationSpans,
    stageCellGeometry,
    groupParallelSupports,
    selectStreamingCells,
} from '../core/electrification-cells.js';

const WORLD_SOURCE = readFileSync(
    fileURLToPath(new URL('../world/electrification.js', import.meta.url)),
    'utf8',
);

const resolver = {
    trackModeFor: () => 'rail',
    resolveAtDistance: source => ({
        status: source.electrified === 'contact_line' ? 'overhead' : 'none',
    }),
};

const tramResolver = {
    trackModeFor: () => 'tram',
    resolveAtDistance: () => ({ status: 'overhead' }),
};

function segment(overrides = {}) {
    return {
        len: 80,
        uStart: 0,
        x1: 550,
        yStart: 0,
        z1: 0,
        x2: 630,
        yEnd: 0,
        z2: 0,
        startJoinX: 0,
        startJoinZ: -1,
        endJoinX: 0,
        endJoinZ: -1,
        angle: Math.PI / 2,
        startTrackCenterOffsetsM: [-1.5, 1.5],
        endTrackCenterOffsetsM: [-1.5, 1.5],
        startTrackbedHalfWidthM: 3,
        endTrackbedHalfWidthM: 3,
        properties: { electrified: 'contact_line', trackId: 7 },
        ...overrides,
    };
}

test('span midpoints own exactly one 600 m cell across a boundary', () => {
    const cells = ownedElectrificationSpans([segment()], resolver);
    const spans = [...cells.values()].flat();
    assert.equal(spans.length, 2);
    assert.equal(new Set(spans.map(span => span.ownerKey)).size, 2);
    assert.deepEqual([...cells.keys()].sort(), ['0:0', '1:0']);
});

test('streaming-cell selection never walks the whole distant electrification map', () => {
    const keys = new Set(['-1:-1', '-1:0', '0:-1', '0:0', '1:1', '2:2', '3:3']);
    for (let index = 100; index < 30_100; index++) keys.add(`${index}:0`);
    let visited = 0;
    const nativeHas = keys.has.bind(keys), nativeValues = keys.values.bind(keys);
    keys.has = key => { visited++; return nativeHas(key); };
    keys[Symbol.iterator] = function* () {
        for (const key of nativeValues()) { visited++; yield key; }
    };
    const selected = selectStreamingCells(keys, { x: 0, z: 0 });
    assert.deepEqual(selected.preload.map(entry => entry.key), ['-1:-1', '-1:0', '0:-1', '0:0', '1:1']);
    assert.ok(visited <= 81, `only the 9 × 9 local cell window is relevant, visited ${visited}`);
});

test('span ownership can resume and matches the synchronous result exactly', () => {
    const segments = [
        segment(),
        segment({ x1: 630, x2: 710, uStart: 80 }),
        segment({ x1: 710, x2: 790, uStart: 160 }),
    ];
    const task = createOwnedElectrificationSpansTask(
        segments,
        resolver,
        { segmentsPerStep: 1 },
    );
    let visits = 0;
    let outcome;
    do {
        outcome = task.step();
        visits += 1;
    } while (!outcome.done);
    assert.equal(visits, segments.length);
    assert.deepEqual(
        [...outcome.value].map(([key, spans]) => [
            key,
            spans.map(span => span.ownerKey),
        ]),
        [...ownedElectrificationSpans(segments, resolver)].map(([key, spans]) => [
            key,
            spans.map(span => span.ownerKey),
        ]),
    );
});

test('one staged cell uses one merged line list and grouped supports', () => {
    const spans = [...ownedElectrificationSpans([segment()], resolver).values()].flat();
    const staged = stageCellGeometry(spans);
    assert.ok(staged.linePositions.length > 0);
    assert.ok(staged.supports.length <= 2);
    assert.ok(staged.supports.every(support => support.crossarmWidthM >= 4.2));
});

test('parallel support candidates group only within distance and heading limits', () => {
    const grouped = groupParallelSupports([
        { x: 0, y: 0, z: 0, heading: 0, crossarmWidthM: 5, supportKey: 'a' },
        { x: 6, y: 0, z: 0, heading: 10 * Math.PI / 180, crossarmWidthM: 5, supportKey: 'b' },
        { x: 20, y: 0, z: 0, heading: 0, crossarmWidthM: 5, supportKey: 'c' },
    ]);
    assert.equal(grouped.length, 2);
    assert.equal(grouped[0].members, 2);
    assert.deepEqual(grouped[0].mastPoints.map(point => point.x), [0, 6]);
});

test('forbidden catenary foundations are omitted without breaking the wires', () => {
    const spans = [...ownedElectrificationSpans([segment()], resolver).values()].flat();
    const staged = stageCellGeometry(spans, { supportClearance: () => -1 });
    assert.ok(staged.linePositions.length > 0);
    assert.deepEqual(staged.supports, []);
});

test('a catenary foundation may use the opposite side when only that side is clear', () => {
    const spans = [...ownedElectrificationSpans([segment()], resolver).values()].flat();
    const staged = stageCellGeometry(spans, {
        supportClearance: (_x, z) => z < 0 ? 1 : -1,
    });
    assert.ok(staged.supports.length > 0);
    assert.ok(staged.supports.every(support => (
        support.mastPoints.every(point => point.z < 0)
    )));
});

test('a dedicated Zagreb double track uses one centre mast with a T arm', () => {
    const spans = [...ownedElectrificationSpans([
        segment({
            x1: 0,
            x2: 80,
            properties: {
                electrified: 'contact_line',
                railway_type: 'tram',
                trackId: 7,
            },
        }),
    ], tramResolver).values()].flat();
    const staged = stageCellGeometry(spans, {
        supportClearance: () => 1,
        roadbedAt: () => false,
    });

    assert.ok(staged.supports.length > 0, 'fixture must stage physical supports');
    for (const support of staged.supports) {
        assert.equal(support.profile, 'tram-centre-t');
        assert.equal(support.mastPoints.length, 1, 'a Zagreb T has one mast');
        assert.ok(Math.abs(support.mastPoints[0].z) < 1e-6);
        assert.ok(Math.abs(support.crossarmCenter.z) < 1e-6);
    }
});

test('a road between double tram tracks forbids a centre mast', () => {
    const spans = [...ownedElectrificationSpans([
        segment({
            x1: 0,
            x2: 80,
            properties: {
                electrified: 'contact_line',
                railway_type: 'tram',
                trackId: 8,
            },
        }),
    ], tramResolver).values()].flat();
    const staged = stageCellGeometry(spans, {
        supportClearance: () => 1,
        roadbedAt: (_x, z) => Math.abs(z) < 0.6,
    });

    assert.ok(staged.supports.length > 0);
    assert.ok(staged.supports.every(support => support.profile === 'tram-side-l'));
    assert.ok(staged.supports.every(support => support.mastPoints.length === 1));
    assert.ok(staged.supports.every(support => (
        Math.abs(support.mastPoints[0].z) >= 0.6
    )));
});

test('parallel dedicated Zagreb tram ways collapse to one centre T, never a flat U', () => {
    const tramWay = (trackId, z) => segment({
        len: 80,
        x1: 0,
        x2: 80,
        z1: z,
        z2: z,
        startTrackCenterOffsetsM: [0],
        endTrackCenterOffsetsM: [0],
        startTrackbedHalfWidthM: 1.5,
        endTrackbedHalfWidthM: 1.5,
        properties: {
            electrified: 'contact_line',
            railway_type: 'tram',
            trackId,
        },
    });
    const spans = [...ownedElectrificationSpans([
        tramWay('west', -1.5),
        tramWay('east', 1.5),
    ], tramResolver).values()].flat();
    const staged = stageCellGeometry(spans, {
        supportClearance: () => 1,
        roadbedAt: () => false,
    });

    assert.ok(staged.supports.length > 0);
    for (const support of staged.supports) {
        assert.equal(support.profile, 'tram-centre-t');
        assert.equal(support.mastPoints.length, 1, 'two uprights would form the forbidden U');
        assert.ok(Math.abs(support.mastPoints[0].z) < 1e-6);
    }
});

test('street-running Zagreb tram poles are sparse single-mast L supports beyond the roadbed', () => {
    const spans = [...ownedElectrificationSpans([
        segment({
            len: 160,
            x1: 0,
            x2: 160,
            properties: {
                electrified: 'contact_line',
                railway_type: 'tram',
                trackId: 9,
            },
            _embeddedRoadSupport: {
                start: { osmId: 100 },
                end: { osmId: 100 },
            },
        }),
    ], tramResolver).values()].flat();
    const staged = stageCellGeometry(spans, {
        supportClearance: () => Infinity,
        roadbedAt: (_x, z) => Math.abs(z) <= 5.5,
    });

    assert.equal(staged.supports.length, 2, 'road-shared poles occur every third 40 m bay');
    for (const support of staged.supports) {
        assert.equal(support.profile, 'tram-side-l');
        assert.equal(support.mastPoints.length, 1);
        assert.ok(Math.abs(support.mastPoints[0].z) > 5.5, 'mast foot is past the carriageway');
        assert.notEqual(
            support.crossarmCenter.z,
            support.mastPoints[0].z,
            'an L arm cantilevers from the side instead of being centred like a T',
        );
    }
});

test('street-running mast search resumes with at most one clearance probe per visit', () => {
    const spans = [...ownedElectrificationSpans([
        segment({
            len: 80,
            x1: 0,
            x2: 80,
            properties: {
                electrified: 'contact_line',
                railway_type: 'tram',
                trackId: 10,
            },
            _embeddedRoadSupport: {
                start: { osmId: 101 },
                end: { osmId: 101 },
            },
        }),
    ], tramResolver).values()].flat();
    const span = spans.find(candidate => candidate.fromM === 0);
    assert.ok(span, 'fixture needs the support-bearing first bay');

    let callsThisStep = 0;
    let totalClearanceCalls = 0;
    const task = createElectrificationSpanStagingTask(span, {
        roadbedAt: (_x, z) => Math.abs(z) <= 5.5,
        supportClearance: (_x, z) => {
            callsThisStep += 1;
            totalClearanceCalls += 1;
            return Math.abs(z) > 8 ? 1 : -1;
        },
    });

    let outcome = null;
    let visits = 0;
    do {
        callsThisStep = 0;
        outcome = task.step();
        visits += 1;
        assert.ok(callsThisStep <= 1,
            `one cooperative visit performed ${callsThisStep} clearance probes`);
        assert.ok(visits < 100, 'resumable search must terminate');
    } while (!outcome.done);

    assert.ok(totalClearanceCalls > 1, 'fixture must exercise a genuinely resumed search');
    assert.ok(outcome.value.linePositions.length > 0, 'wire staging survives the split');
    assert.equal(outcome.value.supports.length, 1);
    assert.ok(Math.abs(outcome.value.supports[0].mastPoints[0].z) > 8);
});

test('the scene queue reads published roads without wedging and repeats partial span staging', () => {
    const queueCellSource = WORLD_SOURCE.slice(
        WORLD_SOURCE.indexOf('function queueCell'),
        WORLD_SOURCE.indexOf('function removeCell'),
    );
    assert.match(
        WORLD_SOURCE,
        /supportRoadFormation\?\.publishedSurfaceAtLocal\?\.\(x, z\)/,
        'roadbed-backed support work must read the last atomically published roads',
    );
    assert.doesNotMatch(
        WORLD_SOURCE,
        /FRAME_CHUNK_DEFER_ITEM/,
        'a dirty road generation must not make every queued catenary item defer',
    );
    assert.match(
        WORLD_SOURCE,
        /function publishedRoadRevision\([\s\S]{0,180}hasPendingBuild\?\.\(\) === true\) return fallback/,
        'road-driven cell invalidation must wait for complete publication',
    );
    assert.match(
        WORLD_SOURCE,
        /shouldRunOnSettle\(supportRoadSettleGate, revision\)/,
        'successive road publications must coalesce before cancelling catenary cells',
    );
    assert.doesNotMatch(
        queueCellSource,
        /maxItemsPerFrame/,
        'bounded span stages must consume the time budget independent of display cadence',
    );
    assert.match(
        WORLD_SOURCE,
        /createElectrificationSpanStagingTask\(item\.span[\s\S]{0,500}if \(!outcome\.done\) return FRAME_CHUNK_REPEAT_ITEM/,
        'one span must retain and resume its cooperative staging task',
    );
});

test('streaming selection respects preload, active, eviction, and 36-cell cap', () => {
    const keys = new Set(Array.from({ length: 60 }, (_, index) => `${index}:0`));
    const selected = selectStreamingCells(keys, { x: 0, z: 0 });
    assert.ok(selected.preload.length <= 36);
    assert.ok(selected.active.has('0:0'));
    assert.ok(!selected.retain.has('10:0'));
});

test('indexed cell selection exactly preserves distance gates, cap and tie ordering', () => {
    const keys = [];
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) keys.push(`${x}:${z}`);
    const cells = new Map(keys.map(key => [key, []]));
    for (const observer of [{ x: 0, z: 0 }, { x: -601.3, z: -0.01 }, { x: 3300, z: -3400 }]) {
        for (const maxCells of [0, 1, 36, 80]) {
            const options = { preloadM: 2000, activeM: 1200, evictM: 2400, maxCells };
            const ranked = keys.map(key => {
                const [x, z] = key.split(':').map(Number);
                return { key, distanceM: Math.hypot((x + 0.5) * 600 - observer.x, (z + 0.5) * 600 - observer.z) };
            }).sort((a, b) => a.distanceM - b.distanceM || a.key.localeCompare(b.key));
            const expected = {
                preload: ranked.filter(item => item.distanceM <= options.preloadM).slice(0, maxCells),
                active: new Set(ranked.filter(item => item.distanceM <= options.activeM).slice(0, maxCells).map(item => item.key)),
                retain: new Set(ranked.filter(item => item.distanceM <= options.evictM).slice(0, maxCells).map(item => item.key)),
            };
            assert.deepEqual(selectStreamingCells(cells, observer, options), expected);
        }
    }
    assert.throws(() => selectStreamingCells(cells.keys(), { x: 0, z: 0 }), /indexed cell/,
        'the hot caller must not discard the index and reintroduce a global scan');
});

test('road-surface changes invalidate only nearby catenary cells', () => {
    assert.deepEqual(
        electrificationCellKeysTouchingBounds(
            ['-1:0', '0:0', '1:0', '2:0'],
            [{ minX: 605, maxX: 620, minZ: 20, maxZ: 40 }],
            { paddingM: 16 },
        ),
        ['0:0', '1:0'],
    );
});

test('equivalent streamed rail objects keep the same catenary cell signature', () => {
    const firstCells = ownedElectrificationSpans([segment()], resolver);
    const [key, first] = [...firstCells][0];
    const equivalent = structuredClone(first);
    assert.equal(
        electrificationCellSignature(first),
        electrificationCellSignature(equivalent),
    );
    const firstSignatures = new Map([[key, electrificationCellSignature(first)]]);
    const equivalentSignatures = new Map([[
        key,
        electrificationCellSignature(equivalent),
    ]]);
    assert.deepEqual(
        changedElectrificationCellKeys(firstSignatures, equivalentSignatures),
        [],
        'an object-only rail revision must schedule no visible cell replacement',
    );
});

test('cell signature diff resumes and matches the synchronous result exactly', () => {
    const previous = new Map(Array.from(
        { length: 40 },
        (_, index) => [`${index}:0`, `old-${index}`],
    ));
    const next = new Map(Array.from(
        { length: 40 },
        (_, index) => [`${index}:0`, index % 7 === 0 ? `new-${index}` : `old-${index}`],
    ));
    const expected = changedElectrificationCellKeys(previous, next);
    const task = createChangedElectrificationCellKeysTask(
        previous,
        next,
        { keysPerStep: 1 },
    );
    let visits = 0;
    let outcome;
    do {
        outcome = task.step();
        visits += 1;
    } while (!outcome.done);
    assert.ok(visits > previous.size);
    assert.deepEqual(outcome.value, expected);
    assert.match(WORLD_SOURCE, /if \(this\.phase === 'diff'\)/);
    assert.match(WORLD_SOURCE, /this\.diffTask\.step\(\)/);
});

test('real catenary geometry changes invalidate the cell and its halo token', () => {
    const cells = ownedElectrificationSpans([segment()], resolver);
    const [key, spans] = [...cells][0];
    const changed = structuredClone(spans);
    changed[0].segment.yStart += 0.25;
    assert.notEqual(
        electrificationCellSignature(spans),
        electrificationCellSignature(changed),
    );

    const signatures = new Map([
        [key, electrificationCellSignature(spans)],
    ]);
    const nextSignatures = new Map([
        [key, electrificationCellSignature(changed)],
    ]);
    const [cellX, cellZ] = key.split(':').map(Number);
    const neighborKey = `${cellX + 1}:${cellZ}`;
    signatures.set(neighborKey, 'unchanged-neighbor');
    nextSignatures.set(neighborKey, 'unchanged-neighbor');
    assert.notEqual(
        electrificationNeighborhoodSignature(neighborKey, signatures),
        electrificationNeighborhoodSignature(neighborKey, nextSignatures),
        'a neighbor stages supports from this cell and must swap atomically too',
    );
    assert.deepEqual(
        new Set(changedElectrificationCellKeys(signatures, nextSignatures)),
        new Set([key, neighborKey]),
    );
});

// ── The halo contract ────────────────────────────────────────────────────────
//
// The 3D layer's haloSpans() picks, for each neighbouring cell, the span whose
// midpoint is nearest this cell's centre. It used to read span.start.x and
// span.end.x — fields no span has ever carried — so it threw on the first
// neighbouring cell containing any spans, and the whole electrification layer
// failed and retried forever ("[cab] layer 'electrification' failed ...
// TypeError: Cannot read properties of undefined (reading 'x')").
//
// Nothing caught it because every test here checked ownership and geometry, and
// none checked the shape the CONSUMER reads. These pin that shape.

test('every span carries a usable midpoint for the halo pass', () => {
    const cells = ownedElectrificationSpans(
        [segment({ electrified: 'contact_line' })],
        resolver,
    );
    const spans = [...cells.values()].flat();
    assert.ok(spans.length > 0, 'fixture must produce spans or this proves nothing');
    for (const span of spans) {
        assert.equal(typeof span.midX, 'number', 'midX is present');
        assert.equal(typeof span.midZ, 'number', 'midZ is present');
        assert.ok(Number.isFinite(span.midX) && Number.isFinite(span.midZ),
            'a non-finite midpoint would make every distance NaN and select nothing');
    }
});

test('the midpoint lies on the span it belongs to', () => {
    // A midpoint that is merely finite but wrong would silently pick the wrong
    // neighbouring span, and the halo supports would be built in the wrong place.
    const seg = segment({ electrified: 'contact_line' });
    const cells = ownedElectrificationSpans([seg], resolver);
    for (const span of [...cells.values()].flat()) {
        const t = (span.fromT + span.toT) * 0.5;
        const expectedX = seg.x1 + (seg.x2 - seg.x1) * t;
        const expectedZ = seg.z1 + (seg.z2 - seg.z1) * t;
        assert.ok(Math.abs(span.midX - expectedX) < 1e-6, `midX ${span.midX} vs ${expectedX}`);
        assert.ok(Math.abs(span.midZ - expectedZ) < 1e-6, `midZ ${span.midZ} vs ${expectedZ}`);
    }
});

test('no span carries the start/end shape the old halo code assumed', () => {
    // Guards the actual defect: if someone reintroduces span.start/.end here,
    // there are now two sources of truth for one midpoint and they will drift.
    const cells = ownedElectrificationSpans([segment({ electrified: 'contact_line' })], resolver);
    for (const span of [...cells.values()].flat()) {
        assert.equal(span.start, undefined, 'spans are (segment, fromT, toT), not (start, end)');
        assert.equal(span.end, undefined);
    }
});
