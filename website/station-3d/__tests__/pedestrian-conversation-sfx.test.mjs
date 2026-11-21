import assert from 'node:assert/strict';
import test from 'node:test';
import { PEDESTRIAN_CONVERSATIONS, pedestrianConversationLine, setPedestrianConversationClips, STREET_VOICE_MANIFEST_URL } from '../core/pedestrian-conversations.js';
import { textHash } from '../core/campaign-voice-lines.js';

class AudioParam {
    value = 0;
    targets = [];
    cancelScheduledValues(time) { this.cancelledAt = time; }
    setTargetAtTime(value, time, constant) { this.targets.push({ value, time, constant }); }
}
class AudioNode {
    connections = [];
    connect(node) { this.connections.push(node); return node; }
    disconnect() { this.disconnected = true; }
}

test('live gain and pan reach the active Web Audio graph, and cancelled clips cannot advance dialogue', async () => {
    const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
    const requested = [];
    let context;
    class Context {
        currentTime = 4;
        state = 'running';
        destination = new AudioNode();
        sources = [];
        constructor() { context = this; }
        createGain() { const node = new AudioNode(); node.gain = new AudioParam(); return node; }
        createStereoPanner() { const node = new AudioNode(); node.pan = new AudioParam(); return node; }
        createBufferSource() {
            const node = new AudioNode();
            node.start = () => { node.started = true; };
            node.stop = time => { node.stopAt = time; };
            this.sources.push(node);
            return node;
        }
        async decodeAudioData() { return { duration: 4 }; }
    }
    globalThis.window = new EventTarget();
    window.AudioContext = Context;
    const recordedLine = PEDESTRIAN_CONVERSATIONS[0].lines[0];
    globalThis.fetch = async file => {
        requested.push(file);
        if (file === STREET_VOICE_MANIFEST_URL) {
            return { ok: true, json: async () => ({ clips: { [recordedLine.id]: { file: `${recordedLine.id}.take-test.mp3`, hash: textHash(recordedLine.text.hr) } } }) };
        }
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    try {
        const audio = await import('../ui/pedestrian-conversation-sfx.js');
        audio.preloadPedestrianConversations();
        assert.equal(requested.length, 0, 'audio waits for the usual user unlock');
        window.dispatchEvent(new Event('pointerdown'));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(requested[0], STREET_VOICE_MANIFEST_URL, 'the voice manifest decides the files first');
        const clips = new Set(requested.slice(1));
        const authoredClipCount = PEDESTRIAN_CONVERSATIONS
            .reduce((sum, script) => sum + script.lines.length, 0) * 2;
        assert.equal(clips.size, authoredClipCount, 'both languages are ready to play');
        assert.ok(clips.has(`station-3d/audio/conversations/voice/${recordedLine.id}.take-test.mp3`), 'a current recorded take is fetched');
        assert.ok(!clips.has(recordedLine.files.hr), 'instead of its generated clip');
        const line = pedestrianConversationLine(PEDESTRIAN_CONVERSATIONS[3].lines[0], 'en');
        let completions = 0;
        assert.equal(audio.playPedestrianConversationLine(line, { gain: 0.6, pan: 0.8 }, () => { completions++; }), true);
        const source = context.sources[0], gain = source.connections[0], panner = gain.connections[0];
        assert.ok(source.started);
        assert.equal(gain.gain.value, 0.6);
        assert.equal(panner.pan.value, 0.8);
        assert.equal(audio.playPedestrianConversationLine(line), false, 'one active voice at a time');
        context.currentTime = 5;
        audio.updatePedestrianConversationSpatial({ gain: 0.15, pan: -0.7 });
        assert.deepEqual(gain.gain.targets.at(-1), { value: 0.15, time: 5, constant: 0.055 });
        assert.equal(panner.pan.targets.at(-1).value, -0.7);
        assert.equal(source.stopAt, undefined, 'motion adjusts the current source without restarting it');
        audio.stopPedestrianConversations();
        assert.equal(gain.gain.targets.at(-1).value, 0);
        assert.ok(source.stopAt > context.currentTime, 'removal gives the source a short fade before stopping');
        assert.equal(audio.updatePedestrianConversationSpatial({ gain: 1 }), false);
        audio.playPedestrianConversationLine(line, {}, () => { completions++; });
        source.onended();
        assert.equal(completions, 0, 'a cancelled source cannot finish the next conversation');
        assert.ok(source.disconnected && gain.disconnected && panner.disconnected);
        context.sources[1].onended();
        assert.equal(completions, 1, 'natural playback completion advances exactly once');
    } finally {
        globalThis.window = originalWindow;
        globalThis.fetch = originalFetch;
        setPedestrianConversationClips(null);
    }
});
