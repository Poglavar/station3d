import test from 'node:test';
import assert from 'node:assert/strict';
import { readViewerLink } from '../viewers/model-viewer-links.js';

test('old rolling stock links keep their model or comparison selection', () => {
    assert.deepEqual(readViewerLink(new URLSearchParams(), '/rolling-stock-viewer.html'), { model: 'tmk-2400-new', compare: 'hz-7022', seed: 'city-people-1', camera: 'auto' });
    assert.equal(readViewerLink(new URLSearchParams('view=train'), '/rolling-stock-viewer.html').model, 'hz-7022');
    assert.equal(readViewerLink(new URLSearchParams('view=person'), '/rolling-stock-viewer.html').model, 'person-male');
});

test('crowd seeds, generic models and airplane camera links survive viewer consolidation', () => {
    const crowd = readViewerLink(new URLSearchParams('seed=734&view=waiting'), '/people-viewer.html');
    assert.equal(crowd.model, 'crowd-waiting'); assert.equal(crowd.seed, '734');
    const person = readViewerLink(new URLSearchParams('model=person-female&cam=side'), '/model-viewer.html');
    assert.equal(person.model, 'person-female'); assert.equal(person.camera, 'side');
    assert.equal(person.compare, '');
    const airplane = readViewerLink(new URLSearchParams('shot=inside'), '/tmp/airplane-cabin/');
    assert.equal(airplane.model, 'airplane-smuggler'); assert.equal(airplane.camera, 'inside');
});
