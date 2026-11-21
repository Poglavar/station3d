// Verifies cab-facing headings and compass labels without a browser or DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cabViewHeadingDeg,
    compassPointForHeading,
    compassReading,
    normalizeHeadingDeg,
} from '../core/compass.js';

test('normalizes headings and labels all sides of north correctly', () => {
    assert.equal(normalizeHeadingDeg(-10), 350);
    assert.equal(normalizeHeadingDeg(725), 5);
    assert.equal(compassPointForHeading(0), 'N');
    assert.equal(compassPointForHeading(44), 'NE');
    assert.equal(compassPointForHeading(270), 'W');
    assert.deepEqual(compassReading(359.7), {
        heading: 359.7,
        degrees: 0,
        point: 'N',
        degreeText: '000°',
    });
});

test('reports the direction the front and rear cab cameras are looking', () => {
    assert.equal(cabViewHeadingDeg(0, Math.PI / 2, 'front'), 90);
    assert.equal(cabViewHeadingDeg(Math.PI / 4, 0, 'rear'), 225);
    assert.equal(cabViewHeadingDeg(7 * Math.PI / 4, Math.PI / 2, 'front'), 45);
});

test('outside view follows its fixed chase-camera target, not cab drag-look', () => {
    assert.equal(cabViewHeadingDeg(Math.PI / 4, Math.PI / 2, 'third'), 45);
});
