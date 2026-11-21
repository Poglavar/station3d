// Suspending the surface world inside a tunnel is only safe if it comes BACK
// before the portal. These cover the two ways that goes wrong — resuming too late
// at speed (you exit into an unbuilt city) and flapping on and off near the
// threshold — plus the case where a tunnel is too short to bother with.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildEnclosedSpanIndex,
    buildRailTunnelSpanIndex,
    findEnclosingSpan,
    shouldSuspendOutsideWorld,
    minimumSuspendableSpanM,
    TUNNEL_RESUME_DEFAULTS,
} from '../core/tunnel-occlusion.js';

test('rendered rail tunnel runs join the shared enclosure index', () => {
    const samples = [0, 15, 30, 45].map(station => ({ x: station, z: 5, station }));
    const spans = buildRailTunnelSpanIndex([{
        boreSamples: samples,
        portalStartMouthIndex: 0,
        portalEndMouthIndex: 3,
    }]);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].chunks.length, 3);
    assert.ok(findEnclosingSpan(spans, 22, 5));
    assert.equal(findEnclosingSpan(spans, 22, 40), null);
});

// A straight tunnel along +x: chunks every 15 m from chainage 0 to lengthM.
function straightTunnel(lengthM, { startChainageM = 0, z = 0 } = {}) {
    const records = [];
    for (let m = 0; m < lengthM; m += 15) {
        records.push({ x: m + 7.5, z, chainageM: startChainageM + m + 7.5, lengthM: 15 });
    }
    return records;
}

test('contiguous chunks make one span; a gap starts another', () => {
    const one = buildEnclosedSpanIndex(straightTunnel(300));
    assert.equal(one.length, 1);
    assert.ok(one[0].endM - one[0].startM >= 300 - 1);

    // Two tubes with a 200 m surfaced stretch between them.
    const two = buildEnclosedSpanIndex([
        ...straightTunnel(150),
        ...straightTunnel(150, { startChainageM: 350 }),
    ]);
    assert.equal(two.length, 2);
});

test('locates the observer inside the tube and reports distance to the portal', () => {
    const spans = buildEnclosedSpanIndex(straightTunnel(1200));
    const near = findEnclosingSpan(spans, 300, 0);
    assert.ok(near, 'expected to be inside');
    assert.ok(Math.abs(near.metresToExit - 900) < 20, `exit ${near.metresToExit}m`);
    assert.ok(Math.abs(near.metresFromEntry - 300) < 20, `entry ${near.metresFromEntry}m`);
});

test('a point off to the side of the tube is outside it', () => {
    const spans = buildEnclosedSpanIndex(straightTunnel(600));
    assert.equal(findEnclosingSpan(spans, 300, 60), null, '60 m off-axis must not count as inside');
    assert.ok(findEnclosingSpan(spans, 300, 5), '5 m off the centreline is still inside');
});

test('resumes earlier the faster you are going', () => {
    const slow = 10;   // 36 km/h → lead is the 450 m floor
    const fast = 55;   // ~200 km/h → lead is 55 × 12 s = 660 m
    // 550 m from the portal falls between the two leads: still deep enough when
    // slow, already too close when fast.
    const at = (speedMps) =>
        shouldSuspendOutsideWorld({ inside: true, metresToExit: 550, speedMps, wasSuspended: true });
    assert.equal(at(slow), true, 'slow train resumed far too early');
    assert.equal(at(fast), false, 'fast train left it too late');
    // And the lead really is velocity-scaled, not just a step.
    assert.ok(minimumSuspendableSpanM(fast) > minimumSuspendableSpanM(slow));
});

test('never suspends outside a tunnel, or without a known exit', () => {
    assert.equal(shouldSuspendOutsideWorld({ inside: false, metresToExit: 5000, wasSuspended: true }), false);
    assert.equal(shouldSuspendOutsideWorld({ inside: true, metresToExit: null, wasSuspended: true }), false);
    assert.equal(shouldSuspendOutsideWorld({ inside: true, metresToExit: NaN }), false);
});

test('does not flap: engaging needs more tunnel than holding does', () => {
    const at = (metresToExit, wasSuspended) =>
        shouldSuspendOutsideWorld({ inside: true, metresToExit, speedMps: 0, wasSuspended });
    const lead = TUNNEL_RESUME_DEFAULTS.leadM;
    // Just past the resume line: holds if already suspended, refuses to re-engage.
    const justPast = lead * 1.1;
    assert.equal(at(justPast, true), true, 'should hold while already suspended');
    assert.equal(at(justPast, false), false, 'should not re-engage this close to the exit');
    // Deep in the tube both agree.
    assert.equal(at(lead * 3, false), true);
    assert.equal(at(lead * 3, true), true);
});

test('a short tube is ridden through without ever dropping the surface', () => {
    const spans = buildEnclosedSpanIndex(straightTunnel(300));
    let everSuspended = false;
    let suspended = false;
    for (let m = 7.5; m < 300; m += 15) {
        const here = findEnclosingSpan(spans, m, 0);
        suspended = shouldSuspendOutsideWorld({
            inside: !!here,
            metresToExit: here?.metresToExit ?? null,
            speedMps: 20,
            wasSuspended: suspended,
        });
        everSuspended = everSuspended || suspended;
    }
    assert.equal(everSuspended, false, '300 m tunnel should never suspend the world');
    assert.ok(minimumSuspendableSpanM(20) > 300, 'and the threshold should say so');
});

test('a long tube suspends in the middle and is back before the portal', () => {
    const spans = buildEnclosedSpanIndex(straightTunnel(4000));
    const speedMps = 25;
    let suspended = false;
    const log = [];
    for (let m = 7.5; m < 4000; m += 15) {
        const here = findEnclosingSpan(spans, m, 0);
        suspended = shouldSuspendOutsideWorld({
            inside: !!here,
            metresToExit: here?.metresToExit ?? null,
            speedMps,
            wasSuspended: suspended,
        });
        log.push({ m, suspended, toExit: here?.metresToExit ?? null });
    }
    assert.ok(log.some((e) => e.suspended), 'never suspended in a 4 km tunnel');
    const resumed = log.filter((e) => !e.suspended && e.m > 1000);
    assert.ok(resumed.length > 0, 'never resumed');
    // The surface must be back on with at least the plain lead distance to spare.
    const firstResume = resumed[0];
    assert.ok(
        firstResume.toExit >= TUNNEL_RESUME_DEFAULTS.leadM - 20,
        `resumed only ${firstResume.toExit}m before the portal`,
    );
    // And it must not toggle repeatedly on one pass.
    const flips = log.reduce((n, e, i) => n + (i > 0 && e.suspended !== log[i - 1].suspended ? 1 : 0), 0);
    assert.ok(flips <= 2, `world toggled ${flips} times in one tunnel`);
});
