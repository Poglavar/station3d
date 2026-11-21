// Rebuilding on every change is what made lane-markings the most frequent
// stutter in a 217-entry window. These pin the rule that replaced it.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createSettleGate,
    markSettleGateApplied,
    shouldRunOnSettle,
} from '../core/settle-gate.js';

test('a burst of changes causes ONE run, after it stops', () => {
    const gate = createSettleGate({ maxDeferredFrames: 1000 });
    let revision = 0;
    let runs = 0;
    // Ten tiles arriving on ten consecutive frames.
    for (let i = 0; i < 10; i++) {
        revision += 1;
        if (shouldRunOnSettle(gate, revision)) runs += 1;
    }
    assert.equal(runs, 0, 'nothing runs while the burst is still arriving');
    // The first quiet frame is what triggers it.
    assert.equal(shouldRunOnSettle(gate, revision), true);
    // And it does not run again while nothing changes.
    for (let i = 0; i < 5; i++) {
        assert.equal(shouldRunOnSettle(gate, revision), false);
    }
});

test('a stream that never goes quiet still gets painted', () => {
    // Unbounded deferral would leave the road permanently unmarked during a long
    // stream — trading a stutter for a missing feature, which is worse.
    const gate = createSettleGate({ maxDeferredFrames: 4 });
    let revision = 0;
    const runFrames = [];
    for (let frame = 0; frame < 20; frame++) {
        revision += 1;                       // something new EVERY frame
        if (shouldRunOnSettle(gate, revision)) runFrames.push(frame);
    }
    assert.ok(runFrames.length >= 3, `expected periodic forced runs, got ${runFrames.length}`);
    // Forced at the cap, not on every frame — that is the whole point.
    assert.ok(runFrames.length <= 20 / 4 + 1, `ran too often: ${runFrames.join(',')}`);
});

test('a source that delivers WITH GAPS is still coalesced', () => {
    // This is the case a one-frame settle misses entirely, and it is how tile
    // streams actually behave: something arrives every few frames, so almost
    // every arrival gets its own quiet frame and its own full rebuild. Measured
    // on a Split ride, lane markings rebuilt ~4x a second this way.
    const oneFrame = createSettleGate({ quietFrames: 1, maxDeferredFrames: 1000 });
    const patient = createSettleGate({ quietFrames: 12, maxDeferredFrames: 1000 });
    let revision = 0;
    let oneFrameRuns = 0;
    let patientRuns = 0;
    // 20 arrivals, each followed by three quiet frames.
    for (let i = 0; i < 20; i++) {
        revision += 1;
        for (let quiet = 0; quiet < 4; quiet++) {
            if (shouldRunOnSettle(oneFrame, revision)) oneFrameRuns += 1;
            if (shouldRunOnSettle(patient, revision)) patientRuns += 1;
        }
    }
    assert.equal(oneFrameRuns, 20, 'a one-frame settle rebuilds on every arrival');
    assert.equal(patientRuns, 0, 'a longer settle rides through the gaps');
    // ...and runs once the stream really does stop.
    for (let quiet = 0; quiet < 12; quiet++) shouldRunOnSettle(patient, revision);
    assert.equal(patient.applied, revision, 'it does run once the burst truly ends');
});

test('nothing runs when nothing has changed', () => {
    const gate = createSettleGate();
    for (let i = 0; i < 10; i++) assert.equal(shouldRunOnSettle(gate, 0), false);
});

test('work done out of band is recorded, so it is not repeated', () => {
    // The proposal mask rebuilds everything immediately; the gate must not then
    // schedule a second identical rebuild on the next quiet frame.
    const gate = createSettleGate();
    shouldRunOnSettle(gate, 5);
    markSettleGateApplied(gate, 7);
    assert.equal(shouldRunOnSettle(gate, 7), false, 'already covered');
    assert.equal(shouldRunOnSettle(gate, 8), false, 'new change waits to settle');
    assert.equal(shouldRunOnSettle(gate, 8), true, 'then runs once');
});
