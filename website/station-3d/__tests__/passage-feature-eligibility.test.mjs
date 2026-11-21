// Regression tests for deciding which streamed building meshes the generic
// courtyard-passage layer may reinterpret as a solid building mass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportsGeneratedCourtyardPassages } from '../world/passage-geometry.js';

test('Split Airport authored roof bucket cannot spawn passages on the pedestrian bridge', () => {
    const roofSilverBucket = {
        properties: {
            object_id: '2661',
            source: 'landmark',
            z_min: 21.967,
            material: {
                kind: 'solid',
                color: 'c6c8c6',
                metalness: 0.22,
                roughness: 0.78,
            },
        },
    };

    assert.equal(supportsGeneratedCourtyardPassages(roofSilverBucket), false);
});

test('every stated-material mesh owns its openings even outside the landmark source', () => {
    assert.equal(supportsGeneratedCourtyardPassages({
        properties: {
            source: 'lidar',
            material: { kind: 'solid', color: 'ffffff' },
        },
    }), false);
});

test('the source label alone never changes passage eligibility', () => {
    assert.equal(supportsGeneratedCourtyardPassages({
        properties: { source: 'landmark', material: null },
    }), true);
});

test('ordinary survey buildings remain eligible for real courtyard passages', () => {
    assert.equal(supportsGeneratedCourtyardPassages({
        properties: { source: 'lidar', material: null },
    }), true);
    assert.equal(supportsGeneratedCourtyardPassages({
        properties: { source: 'gdi' },
    }), true);
});

test('an invalid feature is never promoted into a passage building', () => {
    assert.equal(supportsGeneratedCourtyardPassages(null), false);
    assert.equal(supportsGeneratedCourtyardPassages({}), false);
});
