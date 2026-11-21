// Proves highlight precedence, multi-reference cleanup, and reload restoration.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EntityRegistry } from '../core/entity-registry.js';

test('selected styling overrides hover and restores on late registration', () => {
    const changes = [];
    const registry = new EntityRegistry({
        applyVisualState: (object, next) => changes.push([object.id, next]),
    });
    registry.setInteractionState({
        hoveredKey: 'gdi:building:1',
        selectedKey: 'gdi:building:1',
    });
    registry.register('gdi:building:1', { id: 'wall' });
    assert.deepEqual(changes.at(-1), ['wall', 'selected']);
});

test('multi-tile references unregister only after the final owner leaves', () => {
    const registry = new EntityRegistry();
    const object = { id: 'road' };
    const first = registry.register('osm:way:7', object);
    const second = registry.register('osm:way:7', object);
    first();
    assert.equal(registry.snapshot().objectCount, 1);
    second();
    assert.equal(registry.snapshot().objectCount, 0);
});

test('eviction and re-registration reapplies retained selection', () => {
    const states = [];
    const registry = new EntityRegistry({
        applyVisualState: (_object, next) => states.push(next),
    });
    registry.setInteractionState({ selectedKey: 'overture:building:a' });
    const unregister = registry.register('overture:building:a', {});
    unregister();
    registry.register('overture:building:a', {});
    assert.deepEqual(states, ['selected', null, 'selected']);
});
