// Locks how a film mixes its aircraft's engine: authored segments by film
// time, a flyby that is louder close and higher-pitched on the approach, and a
// fixed share under narration.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    NEUTRAL_ENGINE_MIX,
    filmEngineAudioSegment,
    filmEngineMix,
    flybyEngineMix,
} from '../core/film-engine-audio.js';

const track = {
    engineAudio: [
        { fromMs: 0, toMs: 13000, follow: 'stand-in' },
        { fromMs: 13000, gain: 0.3 },
    ],
};

test('segments resolve by film time, and a film without them leaves the engine alone', () => {
    assert.equal(filmEngineAudioSegment(track, 0).follow, 'stand-in');
    assert.equal(filmEngineAudioSegment(track, 12999).follow, 'stand-in');
    assert.equal(filmEngineAudioSegment(track, 13000).gain, 0.3);
    assert.equal(filmEngineAudioSegment(track, 28000).gain, 0.3);
    assert.equal(filmEngineAudioSegment({}, 1000), null);
    assert.equal(filmEngineAudioSegment(track, NaN), null);
    assert.deepEqual(filmEngineMix({ segment: null }), NEUTRAL_ENGINE_MIX);
});

test('a passing engine is louder close, clamped far, and higher on the approach than going away', () => {
    const listener = { x: 0, y: 2, z: 0 };
    const near = flybyEngineMix({ listener, source: { x: 0, y: 12, z: 15 } });
    const reference = flybyEngineMix({ listener, source: { x: 0, y: 2, z: 60 } });
    const far = flybyEngineMix({ listener, source: { x: 0, y: 2, z: 2000 } });
    assert.ok(near.gainScale > 2 && Math.abs(reference.gainScale - 1) < 1e-9 && far.gainScale === 0.25);
    const approaching = flybyEngineMix({ listener, source: { x: 0, y: 2, z: 100 }, velocity: { x: 0, y: 0, z: -62 } });
    const receding = flybyEngineMix({ listener, source: { x: 0, y: 2, z: 100 }, velocity: { x: 0, y: 0, z: 62 } });
    const crossing = flybyEngineMix({ listener, source: { x: 0, y: 2, z: 100 }, velocity: { x: 62, y: 0, z: 0 } });
    assert.ok(approaching.rateScale > 1.15 && receding.rateScale < 0.9);
    assert.ok(Math.abs(crossing.rateScale - 1) < 1e-9);
});

test('narration holds the engine at its authored share; a stand-in segment without a stand-in is neutral', () => {
    assert.deepEqual(filmEngineMix({ segment: { gain: 0.3 } }), { gainScale: 0.3, rateScale: 1 });
    assert.deepEqual(filmEngineMix({ segment: { follow: 'stand-in' }, listener: { x: 0, y: 0, z: 0 } }), NEUTRAL_ENGINE_MIX);
    const mix = filmEngineMix({
        segment: { follow: 'stand-in' },
        listener: { x: 0, y: 0, z: 0 },
        standIn: { position: { x: 0, y: 10, z: 20 }, velocity: { x: 0, y: 0, z: -60 } },
    });
    assert.ok(mix.gainScale > 1 && mix.rateScale > 1);
});
