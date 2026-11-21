// Verifies teardown disposes aliased tree/extras resources exactly once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { disposeGroup, disposeGroupCooperatively } from '../core/dispose.js';

function disposable() {
    return {
        calls: 0,
        dispose() { this.calls += 1; },
    };
}

test('group resources repeated in disposables are released exactly once', () => {
    const geometry = disposable();
    const texture = disposable();
    const material = { ...disposable(), map: texture };
    const extra = disposable();
    const mesh = { geometry, material };
    const parent = {
        calls: 0,
        remove(value) {
            assert.equal(value, root);
            this.calls += 1;
        },
    };
    const root = {
        parent,
        userData: { disposables: [geometry, material, texture, extra, extra] },
        traverse(visitor) { visitor(mesh); },
    };

    disposeGroup(root);

    assert.equal(geometry.calls, 1);
    assert.equal(material.calls, 1);
    assert.equal(texture.calls, 1);
    assert.equal(extra.calls, 1);
    assert.equal(parent.calls, 1);
    assert.equal(root.userData.disposables, null);
});

test('cooperative group disposal detaches first and releases aliases exactly once', () => {
    const geometry = disposable();
    const texture = disposable();
    const material = { ...disposable(), map: texture };
    const extra = disposable();
    const childA = { children: [], geometry, material };
    const childB = { children: [], geometry, material };
    const parent = {
        calls: 0,
        remove(value) {
            assert.equal(value, root);
            this.calls += 1;
            root.parent = null;
        },
    };
    const root = {
        parent,
        children: [childA, childB],
        userData: { disposables: [geometry, material, texture, extra, extra] },
    };

    const iterator = disposeGroupCooperatively(root);
    assert.equal(parent.calls, 0, 'a generator does not begin before its first step');
    assert.equal(iterator.next().done, false);
    assert.equal(parent.calls, 1, 'the retired root leaves the scene on the first step');
    assert.equal(iterator.next().done, false);
    assert.equal(iterator.next().done, false);
    assert.equal(iterator.next().done, false);
    assert.equal(iterator.next().done, true);

    assert.equal(geometry.calls, 1);
    assert.equal(material.calls, 1);
    assert.equal(texture.calls, 1);
    assert.equal(extra.calls, 1);
    assert.equal(root.userData.disposables, null);
});
