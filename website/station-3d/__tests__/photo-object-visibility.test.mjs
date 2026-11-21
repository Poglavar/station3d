// Verifies photo mode keeps the ridden vehicle without admitting ambient
// simulation traffic into the streamed world.

import test from 'node:test';
import assert from 'node:assert/strict';
import { keepObjectNameInPhoto } from '../core/photo-object-visibility.js';

test('photo mode keeps the player vehicle used by the outside camera', () => {
    assert.equal(keepObjectNameInPhoto('PlayerVehicle'), true);
    assert.equal(keepObjectNameInPhoto('PlayerWalker'), true);
});

test('photo mode keeps both light-rail and heavy-rail track dressing', () => {
    assert.equal(keepObjectNameInPhoto('TramTrackbed'), true);
    assert.equal(keepObjectNameInPhoto('TramRailBars:0:0'), true);
    assert.equal(keepObjectNameInPhoto('HeavyRailBallast:0:0'), true);
    assert.equal(keepObjectNameInPhoto('HeavyRailSleepers:0:0'), true);
});

test('photo mode still rejects ambient trains and unnamed groups', () => {
    assert.equal(keepObjectNameInPhoto('AmbientTrains'), false);
    assert.equal(keepObjectNameInPhoto(''), false);
});
