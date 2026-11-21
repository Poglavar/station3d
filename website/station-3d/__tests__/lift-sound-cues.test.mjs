import test from 'node:test';
import assert from 'node:assert/strict';
import { liftSoundCue } from '../core/lift-sound-cues.js';

test('lift phases map to exactly one cue', () => {
    assert.equal(liftSoundCue('opening'), 'door-slide');
    assert.equal(liftSoundCue('closing'), 'door-slide');
    assert.equal(liftSoundCue('arrival-opening'), 'arrival-chime');
    assert.equal(liftSoundCue('arrival'), null);
    assert.equal(liftSoundCue('idle'), null);
});
