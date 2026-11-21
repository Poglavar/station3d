// Locks the mood-variant portrait choice for dialogue cards.

import assert from 'node:assert/strict';
import test from 'node:test';

import { actorPortraitSource } from '../core/campaign-portrait.js';

test('a beat mood picks its portrait variant and falls back to the base portrait', () => {
    const actor = {
        portrait: { src: 'p/neutral.webp', moods: { stern: 'p/stern.webp' } },
    };
    assert.equal(actorPortraitSource(actor, 'stern'), 'p/stern.webp');
    assert.equal(actorPortraitSource(actor, 'smile'), 'p/neutral.webp');
    assert.equal(actorPortraitSource(actor, null), 'p/neutral.webp');
    assert.equal(actorPortraitSource({ portrait: 'handler' }), null, 'a bare token is not a source');
    assert.equal(actorPortraitSource({ portraitSource: 'legacy.png' }, 'stern'), 'legacy.png');
    assert.equal(actorPortraitSource(null), null);
});
