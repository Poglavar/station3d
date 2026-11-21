import test from 'node:test';
import assert from 'node:assert/strict';

import { isStaticallyBlockedBuildingObjectId } from '../core/building-suppression.js';

test('known non-building GDI shells are suppressed for numeric and string IDs', () => {
    assert.equal(isStaticallyBlockedBuildingObjectId(61752), true);
    assert.equal(isStaticallyBlockedBuildingObjectId('61752'), true);
});

test('the Glavni kolodvor canopies are owned by their landmark, not blocked here', () => {
    // GDI 61764/61766 and Overture f7244894 are replaced through
    // buildings.landmark_replacement by the glavni-kolodvor-peroni landmark
    assert.equal(isStaticallyBlockedBuildingObjectId(61764), false);
    assert.equal(isStaticallyBlockedBuildingObjectId(61766), false);
    assert.equal(
        isStaticallyBlockedBuildingObjectId('f7244894-4c73-4f24-b4f6-47cd3042100b'),
        false,
    );
});

test('static building suppression normalizes UUID case and whitespace', () => {
    assert.equal(
        isStaticallyBlockedBuildingObjectId(' A03DE3EF-4086-49E3-A085-E3A6AFDE203C '),
        true,
    );
    assert.equal(isStaticallyBlockedBuildingObjectId('617520'), false);
    assert.equal(isStaticallyBlockedBuildingObjectId(null), false);
});
