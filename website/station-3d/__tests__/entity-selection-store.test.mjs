// Covers transient hover ownership and persistent selection semantics.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntitySelectionStore } from '../core/entity-selection-store.js';

test('late leave from one pane cannot clear hover established by the other', () => {
    const store = createEntitySelectionStore();
    store.setHover('map', 'osm:way:10');
    store.setHover('3d', 'gdi:building:20');
    store.clearHover('map');
    assert.equal(store.getState().hoveredKey, 'gdi:building:20');
    assert.equal(store.getState().hoverOwner, '3d');
});

test('selection remains sticky when hover leaves and metadata stays cached', () => {
    const store = createEntitySelectionStore();
    store.select('overture:building:x1', { name: 'Hall' });
    store.setHover('map', 'osm:way:10');
    store.clearHover('map');
    assert.equal(store.getState().selectedKey, 'overture:building:x1');
    assert.equal(store.getState().selectedMetadata.name, 'Hall');
});

test('empty selection explicitly clears the sticky key', () => {
    const store = createEntitySelectionStore();
    store.select('gdi:building:2');
    store.clearSelection();
    assert.equal(store.getState().selectedKey, null);
});
