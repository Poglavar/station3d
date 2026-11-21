import assert from 'node:assert/strict';
import test from 'node:test';

import { ensurePersistentRenderRootAttached } from '../core/persistent-render-root.js';

test('a detached persistent render root is republished under the live generation', () => {
    const child = { parent: null };
    const parent = {
        add(value) {
            value.parent = this;
        },
    };

    assert.equal(ensurePersistentRenderRootAttached(parent, child), true);
    assert.equal(child.parent, parent);
    assert.equal(ensurePersistentRenderRootAttached(parent, child), false);
});

test('an unavailable generation does not mutate a persistent render root', () => {
    const child = { parent: null };
    assert.equal(ensurePersistentRenderRootAttached(null, child), false);
    assert.equal(child.parent, null);
});
