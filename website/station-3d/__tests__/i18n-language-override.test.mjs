import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { parseLanguageOverride } from '../core/i18n.js';

test('campaign links can select a supported UI language deterministically', () => {
    assert.equal(parseLanguageOverride('?st3d=campaign&lang=hr'), 'hr');
    assert.equal(parseLanguageOverride('?lang=EN'), 'en');
    assert.equal(parseLanguageOverride('?lang=de'), null);
    assert.equal(parseLanguageOverride('?lang='), null);
    assert.equal(parseLanguageOverride(''), null);
});

test('the host and lazy bundle share a language change before translating their UI', async () => {
    const previousWindow = globalThis.window;
    globalThis.window = new EventTarget();
    window.location = { search: '?lang=hr' };
    try {
        const source = new URL('../core/i18n.js', import.meta.url);
        source.search = 'host-language-test';
        const host = await import(source.href);
        source.search = 'bundle-language-test';
        const bundle = await import(source.href);
        assert.equal(host.getLang(), 'hr');
        assert.equal(bundle.getLang(), 'hr');
        const seen = [];
        const off = bundle.onLangChange(() => seen.push(bundle.t('explorer.campaign')));
        host.setLang('en');
        assert.deepEqual(seen, ['Campaign']);
        assert.equal(bundle.getLang(), 'en');
        off();
    } finally {
        globalThis.window = previousWindow;
    }
});

// A Croatian site about Croatian cities defaults to Croatian. Only a browser
// that actually asks for English gets English.
test('a fresh profile falls back to Croatian, and an English browser still gets English', async () => {
    const source = await readFile(new URL('../core/i18n.js', import.meta.url), 'utf8');
    // The stored choice and the ?lang= override are read before this point;
    // what is left is the default for someone who has never chosen.
    const fallback = source.slice(source.indexOf('function detectLang'), source.indexOf('export function getLang'));
    assert.match(fallback, /return 'hr';/, 'a visitor who has never chosen gets Croatian');
    assert.doesNotMatch(fallback, /navigator\.language/, 'the browser language does not get a vote');
    assert.match(fallback, /parseLanguageOverride/, 'but a ?lang= link still wins');
    assert.match(fallback, /localStorage\.getItem\(STORAGE_KEY\)/, 'and so does a saved choice');
});
