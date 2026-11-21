// Locks campaign speech profiles to the intended language and voice identity.

import assert from 'node:assert/strict';
import test from 'node:test';

import { campaignSpeechPlan } from '../core/campaign-voice.js';

const voices = [
    { name: 'Daniel', lang: 'en-GB', localService: true },
    { name: 'Serena', lang: 'en-GB', localService: true },
    { name: 'Lana', lang: 'hr-HR', localService: true },
];

test('young-woman campaign speech selects a matching female voice per language', () => {
    const english = campaignSpeechPlan({
        profile: 'young-woman',
        language: 'en',
        voices,
    });
    const croatian = campaignSpeechPlan({
        profile: 'young-woman',
        language: 'hr',
        voices,
    });

    assert.equal(english.lang, 'en-GB');
    assert.equal(english.voice.name, 'Serena');
    assert.equal(croatian.lang, 'hr-HR');
    assert.equal(croatian.voice.name, 'Lana');
    assert.ok(english.pitch > 1);
    assert.ok(english.rate > 0.94);
});

test('young-woman delivery remains distinct when the platform has no named match', () => {
    const plan = campaignSpeechPlan({
        profile: 'young-woman',
        language: 'en',
        voices: [{ name: 'Daniel', lang: 'en-GB' }],
    });

    // An in-language voice beats the browser default, whatever its name.
    assert.equal(plan.voice.name, 'Daniel');
    assert.equal(plan.pitch, 1.06);
    assert.equal(plan.rate, 0.98);
});

test('a Croatian line never gets an English voice, even one with a matching name', () => {
    const englishOnly = [
        { name: 'Samantha', lang: 'en-US', localService: true },
        { name: 'Daniel', lang: 'en-GB', localService: true },
    ];
    const plan = campaignSpeechPlan({ profile: 'young-woman', language: 'hr', voices: englishOnly });
    assert.equal(plan.lang, 'hr-HR');
    assert.equal(plan.voice, null, 'no Croatian voice installed: leave the pick to the browser by lang');
});

test('Croatian voices win over name matches, and Android-style language tags count', () => {
    const voices = [
        { name: 'Samantha', lang: 'en-US', localService: true },
        { name: 'Microsoft Matej', lang: 'hr_HR', localService: true },
        { name: 'Google hrvatski', lang: 'hr-HR', localService: false },
    ];
    const woman = campaignSpeechPlan({ profile: 'young-woman', language: 'hr', voices });
    assert.equal(woman.voice.lang.replace('_', '-').split('-')[0], 'hr');
    const man = campaignSpeechPlan({ profile: 'middle-aged-man', language: 'hr', voices });
    assert.equal(man.voice.name, 'Microsoft Matej');
    assert.ok(man.pitch < 1 && man.rate < woman.rate, 'a man profile is lower and slower');
    const unprofiled = campaignSpeechPlan({ language: 'hr', voices });
    assert.equal(unprofiled.voice.name, 'Microsoft Matej', 'even an unprofiled line picks a Croatian voice');
});
