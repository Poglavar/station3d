// The two package handovers are pure choreography: the parcel must start where
// the story rests it, travel by hand (never at constant speed), end where the
// next scene expects it, and be drawn exactly once — never on the quay after
// the courier has it, never anywhere while it is carried.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    campaignPackageRestPose,
    campaignPackageStage,
    PERMIT_HANDOVER_DURATION_S,
    samplePermitHandover,
    sampleVisHandover,
    VIS_HANDOVER_DURATION_S,
} from '../core/campaign-handover.js';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

test('the Vis parcel rises off the quay stones at the fisherman side and ends in the courier hands', () => {
    const start = sampleVisHandover(0).package;
    const end = sampleVisHandover(VIS_HANDOVER_DURATION_S).package;
    assert.ok(start.y < 0.12, 'starts lying on the stones');
    assert.ok(start.x < 0 && start.x > -0.6, 'at the landward side of the man, within reach');
    assert.ok(end.y > 0.9 && end.y < 1.1, 'ends held at chest height');
    assert.ok(end.x < -1.3, 'ends on the courier side, well clear of the fisherman');
    assert.ok(end.pitch > 0.5, 'tilted toward the camera so the seal reads');
    assert.equal(start.visible, true);
    assert.equal(end.visible, true);
});

test('the boat key appears only once the parcel is up and out of the net', () => {
    assert.equal(sampleVisHandover(0).keyVisible, false);
    assert.equal(sampleVisHandover(2).keyVisible, false);
    assert.equal(sampleVisHandover(3.4).keyVisible, true);
    assert.equal(sampleVisHandover(VIS_HANDOVER_DURATION_S).keyVisible, true);
    assert.equal(sampleVisHandover(0).open, 0, 'nobody opens it on Vis');
});

test('both handovers move by hand: eased legs, no jump between keys, clamped past the ends', () => {
    for (const [sample, duration] of [
        [sampleVisHandover, VIS_HANDOVER_DURATION_S],
        [samplePermitHandover, PERMIT_HANDOVER_DURATION_S],
    ]) {
        let previous = sample(0).package;
        let worstStep = 0;
        for (let t = 0.05; t <= duration + 1e-9; t += 0.05) {
            const current = sample(t).package;
            worstStep = Math.max(worstStep, distance(previous, current));
            previous = current;
        }
        assert.ok(worstStep < 0.16, `no 50 ms step longer than 16 cm (worst ${worstStep.toFixed(3)} m)`);
        assert.deepEqual(sample(duration + 5).package, sample(duration).package, 'holds the last pose past the end');
        assert.deepEqual(sample(-3).package, sample(0).package, 'negative time is the start');
        assert.deepEqual(sample(Number.NaN).package, sample(0).package, 'a bad clock is the start');
    }
});

test('the Grič parcel goes from the courier to Viktorija to the desk under the lamp, and is cut open on the desk', () => {
    const offered = samplePermitHandover(0).package;
    const taken = samplePermitHandover(1.7).package;
    const desk = samplePermitHandover(PERMIT_HANDOVER_DURATION_S).package;
    // The courier stands at x 24.3, Viktorija at 26.35, both on z 5.
    assert.ok(offered.x > 24.6 && offered.x < 25.4 && Math.abs(offered.z - 5) < 0.05, 'offered between them');
    assert.ok(taken.x > 25.6, 'in her hands');
    // The map desk top is at x 23.2, z 2.1, 1.0 m up.
    assert.ok(Math.abs(desk.x - 23.36) < 0.05 && Math.abs(desk.z - 2.34) < 0.05, 'set down on the desk');
    assert.ok(Math.abs(desk.y - 1.03) < 0.02, 'resting on the desk top, not floating');
    assert.equal(desk.pitch, 0, 'flat on the desk');
    assert.equal(samplePermitHandover(0).open, 0);
    assert.equal(samplePermitHandover(4.3).open, 0, 'still sealed while she carries it');
    assert.ok(samplePermitHandover(4.7).open > 0.3 && samplePermitHandover(4.7).open < 0.7, 'twine mid-cut');
    assert.equal(samplePermitHandover(PERMIT_HANDOVER_DURATION_S).open, 1, 'open by the time the blueprint fills the screen');
});

test('rest poses: sealed on the quay, delivered on the desk, nothing while carried or unknown', () => {
    assert.deepEqual(campaignPackageRestPose('sealed'), sampleVisHandover(0).package);
    assert.deepEqual(campaignPackageRestPose('delivered'), samplePermitHandover(PERMIT_HANDOVER_DURATION_S).package);
    assert.equal(campaignPackageRestPose('carried'), null);
    assert.equal(campaignPackageRestPose(undefined), null);
    assert.equal(campaignPackageRestPose('sealed-typo'), null);
});

test('the stage is read from the run world effects and only when it is a real stage', () => {
    assert.equal(campaignPackageStage({ 'toranj-package': 'carried' }), 'carried');
    assert.equal(campaignPackageStage({ 'toranj-package': 'delivered' }), 'delivered');
    assert.equal(campaignPackageStage({}), null);
    assert.equal(campaignPackageStage(null), null);
    assert.equal(campaignPackageStage({ 'toranj-package': true }), null, 'a bare apply carries no placement');
    assert.equal(campaignPackageStage({ 'toranj-package': '' }), null);
    assert.equal(campaignPackageStage({ other: 'sealed' }, 'other'), 'sealed');
});


test('the prop shows a boat key only for Vis and opens by hiding the twine and lifting the blueprint', () => {
    const prop = read('../models/objects/sealed-package.js');
    assert.match(prop, /key\.visible = false;/, 'the key is hidden until the Vis film lays it on top');
    assert.match(prop, /contents\.visible = false;/, 'the blueprint is hidden until Viktorija cuts the twine');
    assert.match(prop, /export function setSealedPackageOpen[\s\S]*parts\.twine\.visible = open < 0\.5;[\s\S]*parts\.contents\.visible = open > 0\.15;/);
    assert.match(prop, /export function setSealedPackageKeyVisible[\s\S]*parts\.key\.visible = visible === true;/);
});
