// The audition page's play button follows the chosen voice, and its hover
// highlight follows the conversation graph; both rules are pure and locked here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { activeTake, conversationFlow, playableVoiceIds, takeForVoice } from '../core/campaign-voice-preview-flow.js';

test('a line plays only a current take recorded by the chosen voice', () => {
    const line = { id: 'x', takes: [
        { id: 't1', voiceId: 'a', file: 'a1.mp3', active: false },
        { id: 't2', voiceId: 'b', file: 'b-old.mp3', active: true, stale: true },
        { id: 't3', voiceId: 'b', file: 'b-new.mp3', active: false },
        { id: 't4', voiceId: 'c', file: null },
    ] };
    assert.equal(takeForVoice(line, 'a').file, 'a1.mp3');
    assert.equal(takeForVoice(line, 'b').file, 'b-new.mp3', 'a stale take is never played as the line');
    assert.equal(takeForVoice(line, 'c'), null, 'no file, no take');
    assert.equal(takeForVoice(line, 'd'), null, 'a voice that never recorded this line');
    assert.equal(takeForVoice(line, null), null, 'no voice chosen');
    assert.deepEqual([...playableVoiceIds(line)].sort(), ['a', 'b']);
    const active = { takes: [{ voiceId: 'a', file: 'one.mp3' }, { voiceId: 'a', file: 'two.mp3', active: true }] };
    assert.equal(takeForVoice(active, 'a').file, 'two.mp3', 'the campaign\'s active take wins');
});

test('a line with no cast voice starts from the voice of the take it plays today', () => {
    const crewToast = { takes: [
        { voiceId: 'first', file: 'first.mp3' },
        { voiceId: 'chosen', file: 'chosen.mp3', active: true },
        { voiceId: 'later', file: 'later.mp3' },
    ] };
    assert.equal(activeTake(crewToast).voiceId, 'chosen');
    assert.equal(activeTake({ takes: [{ voiceId: 'old', file: 'old.mp3', stale: true }] }), null, 'a stale take is not a voice to start from');
    assert.equal(activeTake({ takes: [{ voiceId: 'a', file: 'a.mp3' }, { voiceId: 'b', file: 'b.mp3' }] }).voiceId, 'b', 'without an active take, the newest');
    assert.equal(activeTake({}), null);
});

test('the flow map links beats, responses, variants and film captions', () => {
    const flow = conversationFlow({
        conversations: [{
            id: 'c',
            beats: [
                { id: 'open', incoming: [{ kind: 'start' }], nextBeatId: null,
                    line: { id: 'conversation.c.open' },
                    variants: [{ id: 'conversation.c.open.variant.0' }],
                    responses: [
                        { id: 'yes', nextBeatId: 'later', line: { id: 'conversation.c.open.yes' } },
                        { id: 'no', nextBeatId: null, line: { id: 'conversation.c.open.no' } },
                    ] },
                { id: 'later', incoming: [{ kind: 'response', beatId: 'open', responseId: 'yes' }], nextBeatId: 'end',
                    line: { id: 'conversation.c.later' }, responses: [] },
                { id: 'end', incoming: [{ kind: 'beat', beatId: 'later' }], nextBeatId: null,
                    line: { id: 'conversation.c.end' }, responses: [] },
            ],
        }],
        cinematics: [{ id: 'film', captions: [{ id: 'cinematic.film.0' }, { id: 'cinematic.film.1' }] }],
    });
    const of = id => ({ prev: [...flow.get(id).prev].sort(), next: [...flow.get(id).next].sort(), alternatives: [...flow.get(id).alternatives] });
    assert.deepEqual(of('conversation.c.open'), { prev: [], next: ['conversation.c.open.no', 'conversation.c.open.yes'], alternatives: ['conversation.c.open.variant.0'] });
    assert.deepEqual(of('conversation.c.open.yes'), { prev: ['conversation.c.open'], next: ['conversation.c.later'], alternatives: [] });
    assert.deepEqual(of('conversation.c.open.no'), { prev: ['conversation.c.open'], next: [], alternatives: [] });
    assert.deepEqual(of('conversation.c.later'), { prev: ['conversation.c.open.yes'], next: ['conversation.c.end'], alternatives: [] });
    assert.deepEqual(of('conversation.c.end'), { prev: ['conversation.c.later'], next: [], alternatives: [] });
    assert.deepEqual(of('conversation.c.open.variant.0'), { prev: [], next: ['conversation.c.open.no', 'conversation.c.open.yes'], alternatives: ['conversation.c.open'] });
    assert.deepEqual(of('cinematic.film.1'), { prev: ['cinematic.film.0'], next: [], alternatives: [] });
});
