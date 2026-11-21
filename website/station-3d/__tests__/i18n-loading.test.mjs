// Ensures internal world-build queue names never leak into the Croatian loading UI.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
    getItem: () => 'hr',
    setItem: () => {},
};
globalThis.document = { documentElement: { lang: '' } };
globalThis.window = {
    dispatchEvent: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
};
globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const { setLang, t } = await import('../core/i18n.js');

const loadingKeys = [
    'terrain-data', 'terrain-decode', 'terrain-mesh', 'base', 'layers',
    'roads', 'curbs', 'rail-cells', 'cars', 'buildings', 'far-buildings',
    'wreck-dressing', 'tile-delivery', 'orientation-delivery',
    'lane-markings.rebuild',
];

test('every production loading component has English and Croatian copy', () => {
    for (const language of ['hr', 'en']) {
        setLang(language);
        for (const component of loadingKeys) {
            const key = `loading.${component}`;
            assert.notEqual(t(key), key, `${language} is missing ${key}`);
        }
        assert.notEqual(t('hud.decoded'), 'hud.decoded');
        assert.notEqual(t('hud.decodedHint'), 'hud.decodedHint');
    }
});
