// Pins Zagreb's steel railway-bridge palette independently of Three.js render code.

import test from 'node:test';
import assert from 'node:assert/strict';

import { railBridgeStyleForLocation } from '../core/rail-bridge-style.js';

test('Zagreb uses green steel decks with concrete supports', () => {
    const style = railBridgeStyleForLocation({
        locationId: 'croatia',
        styleCityId: 'zagreb',
    });
    assert.equal(style.kind, 'steel-girder');
    assert.equal(style.deck.color, 0x2f6847);
    assert.ok(style.deck.roughness > 0.8, 'paint is worn rather than mirror-smooth');
    assert.ok(style.deck.metalness > 0.1);
    assert.equal(style.details.color, 0x28583d);
    assert.ok(style.fasteners.metalness > style.deck.metalness);
    assert.equal(style.piers.color, 0xa7a49a);
    assert.equal(style.piers.metalness, 0);
});

test('other locations retain the neutral civil-structure fallback', () => {
    const style = railBridgeStyleForLocation({ locationId: 'split' });
    assert.equal(style.kind, 'concrete');
    assert.equal(style.deck.color, 0xa7a49a);
    assert.equal(style.deck.metalness, 0);
});
