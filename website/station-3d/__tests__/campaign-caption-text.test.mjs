// A caption spoken by a character carries the name as a label and the line
// as a quote; the name and any stage cue are shown, never spoken.
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCaptionText } from '../core/campaign-cinematics.js';

const l = (en, hr) => ({ en, hr });

test('narration, a named speaker and a stage cue each read correctly on screen', () => {
    assert.equal(formatCaptionText({ text: l('Night fell.', 'Pala je noć.') }), 'Pala je noć.');
    assert.equal(formatCaptionText({ text: l('Night fell.', 'Pala je noć.') }, 'en'), 'Night fell.');
    const viki = { speakerId: 'resistance-leader', label: l('VIKI', 'VIKI'), text: l('Our city.', 'Naš grad.') };
    assert.equal(formatCaptionText(viki), 'VIKI: „Naš grad.“');
    assert.equal(formatCaptionText(viki, 'en'), 'VIKI: “Our city.”');
    const shout = { speakerId: 'lika-inspector', label: l('INSPECTOR — SHOUTING', 'KONTROLOR — VIČE'), text: l('Blow up the bridge!', 'Dignite most u zrak!') };
    assert.equal(formatCaptionText(shout), 'KONTROLOR — VIČE: „Dignite most u zrak!“');
    const cue = { cue: l('EXPLOSION', 'EKSPLOZIJA'), text: l('Fire and dust.', 'Vatra i prašina.') };
    assert.equal(formatCaptionText(cue), '[EKSPLOZIJA] Vatra i prašina.');
    assert.equal(formatCaptionText({ text: l('', '') }), '');
    assert.equal(formatCaptionText(null), '');
});
