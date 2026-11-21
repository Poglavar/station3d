// `outside-loop` used to absorb every piece of our own work that did not run
// inside the render loop's hooks: frame-chunk queue flushes (their own
// animation frame), payload decoding, async builders resuming in a callback of
// their own. A 1.3 s freeze therefore read as something the browser did to us.
//
// These pin the rule that replaced it: named work wins the headline wherever it
// ran, and what is left over is stated as a number rather than implied.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    describeStutter,
    formatStutterLogText,
    unclaimedStallMs,
} from '../core/perf-overlay-model.js';
import {
    measureOutOfLoopWork,
    reportOutOfLoopWork,
    setOutOfLoopWorkSink,
} from '../core/out-of-loop-work.js';

test('unclaimed stall is what no reporter accounted for', () => {
    assert.equal(unclaimedStallMs(100, new Map([['q:curbs', 60], ['q:roads', 30]])), 10);
    assert.equal(unclaimedStallMs(100, { 'q:curbs': 100 }), 0);
    assert.equal(unclaimedStallMs(100, new Map()), 100, 'nothing reported means all of it');
    // Reporters may nest and overlap, so a claim can exceed the stall. A
    // negative figure would read as a bug in the world rather than the maths.
    assert.equal(unclaimedStallMs(50, { 'q:curbs': 90 }), 0);
    assert.equal(unclaimedStallMs(undefined, {}), 0);
});

test('a frame filled by a queue flush is headlined by the queue, not outside-loop', () => {
    const row = describeStutter({
        frameMs: 1364, hooksMs: 1, renderMs: 5, stallMs: 1350,
        outside: 'q:curbs:900 q:roads:300', unclaimedStallMs: 150, longTaskMs: 1300,
    });
    assert.equal(row.cause, 'q:curbs:900');
    assert.ok(row.alsoLayers.includes('q:roads:300'));
    assert.match(row.breakdown, /unclaimed 150, task 1300/);
});

test('the biggest named contributor wins, whichever side of the loop it ran on', () => {
    // A layer using 2 ms of hooks must not headline a frame that a queue spent
    // 900 ms filling — which is exactly what picking layers first produced.
    const queueWon = describeStutter({
        frameMs: 950, hooksMs: 2, renderMs: 5, stallMs: 940,
        layers: 'cars:2', outside: 'q:curbs:900',
    });
    assert.equal(queueWon.cause, 'q:curbs:900');

    const layerWon = describeStutter({
        frameMs: 950, hooksMs: 900, renderMs: 5, stallMs: 40,
        layers: 'rails:900', outside: 'q:curbs:30',
    });
    assert.equal(layerWon.cause, 'rails:900');
    assert.ok(layerWon.alsoLayers.includes('q:curbs:30'));
});

test('outside-loop now means nobody claimed it, which is a real finding', () => {
    const row = describeStutter({
        frameMs: 1200, hooksMs: 1, renderMs: 4, stallMs: 1195,
        outside: '', unclaimedStallMs: 1195, longTaskMs: 0,
    });
    assert.equal(row.cause, 'outside-loop');
    // task 0 beside a 1.2 s unclaimed gap is the useful half: the page was not
    // running code, so this is time it never got rather than code to instrument.
    assert.match(row.breakdown, /unclaimed 1195, task 0/);
});

test('an ordinary frame carries no unclaimed noise', () => {
    const row = describeStutter({
        frameMs: 60, hooksMs: 50, renderMs: 9, stallMs: 0.4, layers: 'rails:50',
    });
    assert.equal(row.cause, 'rails:50');
    assert.doesNotMatch(row.breakdown, /unclaimed/);
});

test('reporting is a no-op until a sink is installed', () => {
    setOutOfLoopWorkSink(null);
    // Must not throw, and must not require a render loop to exist — every core
    // module can report unconditionally.
    reportOutOfLoopWork('q:curbs', 900);
    assert.equal(measureOutOfLoopWork('q:curbs', () => 'value'), 'value');
});

test('a sink receives named spans, and sub-tenth-millisecond noise is dropped', () => {
    const seen = [];
    setOutOfLoopWorkSink((name, ms) => seen.push([name, ms]));
    try {
        reportOutOfLoopWork('q:curbs', 98);
        reportOutOfLoopWork('q:roads', 0.05);      // noise
        reportOutOfLoopWork('q:roads', Number.NaN); // garbage
        assert.deepEqual(seen, [['q:curbs', 98]]);
    } finally {
        setOutOfLoopWorkSink(null);
    }
});

test('measured work is reported even when it throws', () => {
    const seen = [];
    setOutOfLoopWorkSink((name, ms) => seen.push([name, ms]));
    let clock = 0;
    const now = () => clock;
    try {
        assert.throws(() => measureOutOfLoopWork('parse:roads', () => {
            clock = 900;
            throw new Error('bad payload');
        }, now));
        // A payload that blows up after 900 ms of parsing cost those 900 ms.
        assert.deepEqual(seen, [['parse:roads', 900]]);
    } finally {
        setOutOfLoopWorkSink(null);
    }
});

test('a burst while the observer is stopped is marked as catch-up', () => {
    // Stationary mode deliberately hands out a much larger work budget so the
    // world fills in while nobody is moving through it. Those frames are long
    // ON PURPOSE, and a log that renders them identically to a hitch during a
    // ride makes the reader re-derive which was which from memory every time.
    const stopped = describeStutter({
        frameMs: 90, hooksMs: 80, renderMs: 8, stallMs: 2,
        layers: 'curbs:80', stationary: true,
    });
    assert.equal(stopped.stationary, true);

    const moving = describeStutter({
        frameMs: 90, hooksMs: 80, renderMs: 8, stallMs: 2, layers: 'curbs:80',
    });
    assert.equal(moving.stationary, false);
});

test('the copied log text marks stopped and host-busy rows', () => {
    const text = formatStutterLogText([
        { atMs: 1, frameMs: 90, hooksMs: 80, layers: 'curbs:80', stationary: true },
        { atMs: 2, frameMs: 90, hooksMs: 80, layers: 'curbs:80', hostBusy: true },
        { atMs: 3, frameMs: 90, hooksMs: 80, layers: 'curbs:80' },
    ]);
    const lines = text.split('\n').filter(line => line.includes('curbs:80'));
    assert.match(lines[0], /\[stopped\]/);
    assert.match(lines[1], /\[host busy\]/);
    assert.doesNotMatch(lines[2], /\[stopped\]|\[host busy\]/);
});
