import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createFeatureCollectionJsonParseTask,
} from '../core/cooperative-feature-collection-json.js';

function finish(task) {
    let outcome;
    let steps = 0;
    do {
        outcome = task.step();
        steps += 1;
        assert.ok(steps < 10_000, 'decoder did not finish');
    } while (!outcome.done);
    return { ...outcome, steps };
}

test('cooperatively decodes a FeatureCollection without changing its shape', () => {
    const expected = {
        type: 'FeatureCollection',
        bbox: [15.97, 45.80, 15.99, 45.82],
        source: { survey: 'GDI', note: 'braces {[]} and a quote: "' },
        features: [
            {
                type: 'Feature',
                properties: { object_id: 1, label: 'A ] } , [ building' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[[15.98, 45.81], [15.981, 45.81], [15.98, 45.81]]],
                },
            },
            {
                type: 'Feature',
                properties: { object_id: 2 },
                geometry: null,
            },
        ],
    };
    const task = createFeatureCollectionJsonParseTask(JSON.stringify(expected), {
        scanCharactersPerStep: 19,
        featuresPerStep: 1,
    });
    const outcome = finish(task);

    assert.ok(outcome.steps > 4, 'small scan slices should require multiple resumptions');
    assert.deepEqual(outcome.result, expected);
});

test('only selects a top-level features key', () => {
    const expected = {
        type: 'FeatureCollection',
        metadata: { features: ['not', 'the', 'collection'] },
        features: [{ type: 'Feature', properties: { id: 7 }, geometry: null }],
    };
    const outcome = finish(createFeatureCollectionJsonParseTask(JSON.stringify(expected), {
        scanCharactersPerStep: 11,
    }));
    assert.deepEqual(outcome.result, expected);
});

test('rejects invalid feature-array grammar and malformed collection envelopes', () => {
    assert.throws(
        () => finish(createFeatureCollectionJsonParseTask('{"type":"FeatureCollection"}')),
        /no top-level features array/,
    );
    assert.throws(
        () => finish(createFeatureCollectionJsonParseTask('{"features":[null]}')),
        /entries must be objects/,
    );
    assert.throws(
        () => finish(createFeatureCollectionJsonParseTask('{"features":[{},]}')),
        /Trailing comma/,
    );
    assert.throws(
        () => finish(createFeatureCollectionJsonParseTask('{"features":[] garbage}')),
        SyntaxError,
    );
});
