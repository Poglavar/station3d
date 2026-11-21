// Locks the ambient fish jumps: rare irregular timing, sites only on the sea
// near the viewer and mostly in view, sizes and arcs that start and end on the
// surface, and a splash that is heard only nearby, louder for a bigger fish.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    FISH_JUMP_DEFAULTS,
    fishJumpsAllowed,
    fishSplashCue,
    nextFishJumpDelayS,
    pickFishJumpSite,
    planFishJump,
    sampleFishJump,
} from '../core/fish-jumps.js';
import { createSeededRandom } from '../core/fireworks-show.js';

const seaEastOfZero = (x) => x > 0;

test('jumps are rare and irregular: never sooner than the floor, about the mean on average', () => {
    const random = createSeededRandom(3);
    const delays = Array.from({ length: 4000 }, () => nextFishJumpDelayS(random));
    assert.ok(delays.every(delay => delay >= FISH_JUMP_DEFAULTS.minIntervalS));
    const mean = delays.reduce((sum, delay) => sum + delay, 0) / delays.length;
    assert.ok(Math.abs(mean - FISH_JUMP_DEFAULTS.meanIntervalS) < FISH_JUMP_DEFAULTS.meanIntervalS * 0.1, `mean ${mean}`);
    assert.ok(Math.max(...delays) > FISH_JUMP_DEFAULTS.meanIntervalS * 2, 'some waits are long');
});

test('nothing jumps for a viewer high above the water or before the sea height is known', () => {
    assert.equal(fishJumpsAllowed({ viewerY: 1.7, seaY: 0 }), true);
    assert.equal(fishJumpsAllowed({ viewerY: 150, seaY: 0 }), false);
    assert.equal(fishJumpsAllowed({ viewerY: 1.7, seaY: null }), false);
});

test('a site is always on the sea, inside the ring around the viewer, and mostly in view', () => {
    const random = createSeededRandom(11);
    const viewer = { x: 0, z: 0 };
    const forward = { x: 1, z: 0 };
    let inCone = 0;
    let found = 0;
    for (let index = 0; index < 600; index++) {
        const site = pickFishJumpSite({ random, viewer, forward, isSea: seaEastOfZero });
        if (!site) continue;
        found += 1;
        assert.ok(site.x > 0, 'on the sea');
        const distance = Math.hypot(site.x, site.z);
        assert.ok(distance >= FISH_JUMP_DEFAULTS.minDistanceM - 1e-9 && distance <= FISH_JUMP_DEFAULTS.maxDistanceM + 1e-9);
        const offView = Math.abs(Math.atan2(site.z, site.x));
        if (offView <= FISH_JUMP_DEFAULTS.viewConeRad + 1e-9) inCone += 1;
    }
    assert.ok(found > 550, `found ${found}`);
    assert.ok(inCone / found > 0.75, `in view ${inCone}/${found}`);
    assert.equal(pickFishJumpSite({ random, viewer, forward, isSea: () => false }), null, 'no sea, no jump');
    assert.equal(pickFishJumpSite({ random, viewer: { x: NaN, z: 0 }, isSea: () => true }), null);
});

test('fish sizes stay in range, small ones common, and a jump is planned only with sea at both ends', () => {
    const random = createSeededRandom(5);
    const lengths = [];
    for (let index = 0; index < 500; index++) {
        const plan = planFishJump({ random, site: { x: 10, z: 10 }, seaY: -1.6 });
        assert.ok(plan.lengthM >= FISH_JUMP_DEFAULTS.minLengthM && plan.lengthM <= FISH_JUMP_DEFAULTS.maxLengthM);
        assert.ok(Math.abs(plan.durationS - 2 * Math.sqrt((2 * plan.heightM) / 9.81)) < 1e-9, 'a ballistic flight');
        assert.ok(plan.heightM > 0.15 && plan.heightM < 1.4 && plan.spanM > 0.4 && plan.spanM < 2.6);
        lengths.push(plan.lengthM);
    }
    lengths.sort((a, b) => a - b);
    const midpoint = (FISH_JUMP_DEFAULTS.minLengthM + FISH_JUMP_DEFAULTS.maxLengthM) / 2;
    assert.ok(lengths[Math.floor(lengths.length / 2)] < midpoint, 'the median fish is small');
    const onlyTheSite = (x, z) => Math.hypot(x - 10, z - 10) < 0.01;
    assert.equal(planFishJump({ random, site: { x: 10, z: 10 }, seaY: 0, isSea: onlyTheSite }), null);
    const asked = planFishJump({ random, site: { x: 10, z: 10 }, seaY: 0, forcedLengthM: 0.5 });
    assert.equal(asked.lengthM, 0.5, 'automation can ask for a size');
    assert.equal(planFishJump({ random, site: { x: 10, z: 10 }, seaY: 0, forcedLengthM: 9 }).lengthM, FISH_JUMP_DEFAULTS.maxLengthM);
});

test('the fish leaves and re-enters at the surface, peaks mid-flight and noses up then down', () => {
    const plan = planFishJump({ random: createSeededRandom(9), site: { x: 4, z: -3 }, seaY: -1.6 });
    const start = sampleFishJump(plan, 0);
    const middle = sampleFishJump(plan, plan.durationS / 2);
    const end = sampleFishJump(plan, plan.durationS);
    assert.ok(Math.abs(start.y - plan.seaY) < 1e-9 && Math.abs(end.y - plan.seaY) < 1e-9);
    assert.ok(Math.abs(middle.y - (plan.seaY + plan.heightM)) < 1e-9);
    assert.ok(Math.abs(Math.hypot(end.x - start.x, end.z - start.z) - plan.spanM) < 1e-9);
    assert.ok(start.pitchRad > 0.2 && end.pitchRad < -0.2 && Math.abs(middle.pitchRad) < 1e-9);
    assert.equal(sampleFishJump(plan, plan.durationS + 0.01), null);
    assert.equal(sampleFishJump(plan, -0.01), null);
});

test('a splash is heard only nearby, louder close and for a bigger fish, deeper for a bigger fish, panned to its side', () => {
    const small = { x: 0, z: 10, seaY: 0, headingRad: 0, lengthM: 0.18, heightM: 0.4, spanM: 0.9, durationS: 0.57 };
    const big = { ...small, lengthM: 0.6, heightM: 1, spanM: 2 };
    const listener = { x: 0, y: 1.7, z: 0, right: { x: 1, z: 0 } };
    const near = fishSplashCue({ plan: small, listener });
    const far = fishSplashCue({ plan: { ...small, z: 40 }, listener });
    assert.ok(near.gain > far.gain);
    assert.equal(fishSplashCue({ plan: { ...small, z: 80 }, listener }), null, 'too far to hear');
    const bigCue = fishSplashCue({ plan: big, listener });
    assert.ok(bigCue.gain > near.gain && bigCue.playbackRate < near.playbackRate);
    assert.ok(fishSplashCue({ plan: small, listener, where: 'out' }).gain < near.gain, 'breaking out is softer');
    const toTheRight = fishSplashCue({ plan: { ...small, x: 8 }, listener });
    assert.ok(toTheRight.pan > 0.3);
    assert.ok(near.delayS > 0 && near.delayS < 0.05);
});
