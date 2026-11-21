// A dialogue line is revealed at the pace it is heard: whole words only, never
// going backwards, complete by the time the voice ends — and instantly
// complete for an empty or unclocked line, so no card can stall half-read.
import assert from 'node:assert/strict';
import test from 'node:test';

import { dialogueRevealDurationMs, revealedDialogueText } from '../core/campaign-dialogue-reveal.js';
import { speakingSeconds } from '../core/campaign-speaking.js';

const LINE = 'Pola je otoka gledalo kako ti avion pada u uvalu. Do jutra će milicija doći pogledati olupinu.';

test('a recorded clip sets the pace, and the reading estimate stands in for one', () => {
    assert.ok(dialogueRevealDurationMs({ clipSeconds: 12.5 }) > 11_000);
    assert.ok(dialogueRevealDurationMs({ clipSeconds: 12.5 }) < 12_500, 'the text lands before the last syllable');
    const estimated = dialogueRevealDurationMs({ text: LINE });
    assert.ok(estimated > 1000 && estimated < speakingSeconds(LINE) * 1000);
    // A missing or absurd clip length never yields a zero-length reveal.
    for (const clipSeconds of [null, 0, -3, Number.NaN, 'soon']) {
        assert.ok(dialogueRevealDurationMs({ clipSeconds, text: '' }) >= 400, `clip ${clipSeconds}`);
    }
});

test('the reveal grows whole words and finishes with the line', () => {
    const total = dialogueRevealDurationMs({ text: LINE });
    let previous = '';
    for (let elapsed = 0; elapsed <= total; elapsed += total / 40) {
        const { text, fraction, done } = revealedDialogueText(LINE, elapsed, total);
        assert.ok(LINE.startsWith(text), 'always a prefix of the line');
        assert.ok(text.length >= previous.length, 'never goes backwards');
        assert.ok(text.length === 0 || text.length === LINE.length || /\S$/.test(text), 'ends on a whole word');
        assert.ok(fraction >= 0 && fraction <= 1);
        assert.equal(done, text === LINE);
        previous = text;
    }
    assert.equal(revealedDialogueText(LINE, total, total).text, LINE);
    assert.equal(revealedDialogueText(LINE, total * 5, total).done, true);
});

test('a line without a clock, or with none to show, is complete at once', () => {
    assert.deepEqual(revealedDialogueText('', 0, 5000), { text: '', fraction: 1, done: true });
    assert.deepEqual(revealedDialogueText(null, 0, 5000), { text: '', fraction: 1, done: true });
    const unclocked = revealedDialogueText(LINE, Number.NaN, Number.NaN);
    assert.equal(unclocked.text, '', 'an unclocked line starts empty rather than jumping ahead');
    assert.equal(revealedDialogueText(LINE, 10_000, Number.NaN).done, true, 'and completes on the floor duration');
});
