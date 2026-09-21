import test from 'node:test';
import assert from 'node:assert/strict';

import { station3dAssetUrl } from '../core/asset-url.js';

test('static assets resolve from the stable Station3D root in a split production chunk', () => {
    const previousWindow = globalThis.window;
    globalThis.window = {
        __station3DAssetConfig: { rootUrl: 'https://example.test/station-3d/' },
    };
    try {
        assert.equal(
            station3dAssetUrl('/audio/sfx/test.wav'),
            'https://example.test/station-3d/audio/sfx/test.wav',
        );
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});
