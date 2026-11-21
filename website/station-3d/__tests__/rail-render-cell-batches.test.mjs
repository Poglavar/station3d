import test from 'node:test';
import assert from 'node:assert/strict';

import { planHeavyRailSleepers } from '../core/heavy-rail-dressing.js';
import {
    railRenderSegmentBatches,
    splitRailRenderSegment,
} from '../core/rail-render-cells.js';

function segment(overrides = {}) {
    return {
        x1: 0, z1: 0, x2: 240, z2: 0,
        cx: 120, cz: 0, len: 240,
        px: 0, pz: -1, angle: Math.PI / 2,
        uStart: 20,
        yStart: 3, yEnd: 9,
        relativeYStart: 1, relativeYEnd: 7,
        startJoinX: 0.2, startJoinZ: -0.98,
        endJoinX: -0.1, endJoinZ: -0.99,
        startTrackCenterOffsetsM: [-2, 2],
        endTrackCenterOffsetsM: [-3, 3],
        startTrackbedHalfWidthM: 4,
        endTrackbedHalfWidthM: 5,
        startTrackbedInnerEdgeM: 0.2,
        endTrackbedInnerEdgeM: 0.4,
        startKey: 'a', endKey: 'b', sortKey: 'a>b#0',
        heavyRail: true,
        properties: { railway_type: 'rail' },
        ...overrides,
    };
}

test('long rail render chords split continuously without changing sleeper placement', () => {
    const original = segment();
    const pieces = splitRailRenderSegment(original, 80);
    assert.equal(pieces.length, 3);
    assert.ok(pieces.every(piece => piece.len <= 80 + 1e-9));
    assert.equal(pieces[0].startJoinX, original.startJoinX);
    assert.equal(pieces.at(-1).endJoinX, original.endJoinX);
    for (let index = 1; index < pieces.length; index++) {
        assert.equal(pieces[index - 1].x2, pieces[index].x1);
        assert.equal(pieces[index - 1].yEnd, pieces[index].yStart);
        assert.equal(pieces[index - 1].endJoinX, pieces[index].startJoinX);
    }
    assert.deepEqual(
        planHeavyRailSleepers(pieces).map(item => [item.chainageM, item.trackIndex]),
        planHeavyRailSleepers([original]).map(item => [item.chainageM, item.trackIndex]),
    );
});

test('rail cell render batches have a hard segment-count bound', () => {
    const batches = railRenderSegmentBatches(
        Array.from({ length: 11 }, (_, index) => segment({
            x1: index * 20,
            x2: index * 20 + 20,
            cx: index * 20 + 10,
            len: 20,
            sortKey: `s${index}`,
        })),
        { maxSegments: 3, maxSegmentM: 80 },
    );
    assert.deepEqual(batches.map(batch => batch.length), [3, 3, 3, 2]);
    assert.ok(batches.every(batch => batch.length <= 3));
});
