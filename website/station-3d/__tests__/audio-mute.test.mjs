// Verifies that the persisted simulator mute controls every managed audio output.

import test from 'node:test';
import assert from 'node:assert/strict';

const stored = new Map([['station3dAudioMuted', 'false']]);
globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
};
globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
};

const {
    getAudioDestination,
    isAudioDucked,
    isAudioMuted,
    onAudioMuteChange,
    registerAudioContext,
    registerAudioElement,
    setAudioDucked,
    setAudioMuted,
} = await import('../core/audio-unlock.js');

function fakeContext() {
    const nativeDestination = { name: 'native' };
    const gain = {
        value: 1,
        cancelScheduledValues: () => {},
        setValueAtTime(value) { this.value = value; },
        setTargetAtTime(value) { this.value = value; },
    };
    const output = {
        gain,
        connectedTo: null,
        connect(destination) { this.connectedTo = destination; },
    };
    return {
        currentTime: 4,
        destination: nativeDestination,
        createGain: () => output,
        output,
    };
}

test('one persisted mute controls managed Web Audio and media-element outputs', () => {
    const ctx = fakeContext();
    const media = { muted: false, addEventListener: () => {} };
    registerAudioContext(ctx);
    registerAudioElement(media);

    assert.equal(getAudioDestination(ctx), ctx.output);
    assert.equal(ctx.output.connectedTo, ctx.destination);
    assert.equal(isAudioMuted(), false);

    const changes = [];
    const unsubscribe = onAudioMuteChange((muted) => changes.push(muted));
    setAudioMuted(true);
    assert.equal(ctx.output.gain.value, 0);
    assert.equal(media.muted, true);
    assert.equal(stored.get('station3dAudioMuted'), 'true');

    setAudioMuted(false);
    assert.equal(ctx.output.gain.value, 1);
    assert.equal(media.muted, false);
    assert.deepEqual(changes, [false, true, false]);

    setAudioDucked(true);
    assert.equal(isAudioDucked(), true);
    assert.equal(ctx.output.gain.value, 0.28);
    assert.equal(media.muted, false, 'dialogue voice media stays at full level');
    setAudioDucked(false);
    assert.equal(ctx.output.gain.value, 1);
    unsubscribe();
});
