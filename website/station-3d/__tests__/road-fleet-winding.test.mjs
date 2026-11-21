// Every road-fleet model's parts face outward: each material group's signed volume is positive. A part exported
// inside out (negative volume) loses its outer faces to the one-sided materials, so a car seen from above showed no
// roof and its seats through it (nine models were, until their triangles were turned over).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fleet = new URL('../models/vehicles/fleet/', import.meta.url);
const models = JSON.parse(readFileSync(new URL('index.json', fleet), 'utf8')).map(entry => entry.id);

// Six times the volume a group's triangles enclose, positive when they are wound counter-clockwise seen from outside.
function signedVolume6({ positions: p, indices }) {
    let volume = 0;
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        volume += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
            - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
            + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return volume;
}

test('the fleet index lists the models', () => {
    assert.ok(models.length >= 16, `${models.length} models`);
});

for (const id of models) {
    test(`${id}: every part faces outward`, () => {
        const document = JSON.parse(readFileSync(new URL(`${id}.json`, fleet), 'utf8'));
        const inward = document.groups.filter(group => signedVolume6(group) < 0).map(group => group.material);
        assert.deepEqual(inward, [], `${id} has parts wound inside out: ${inward.join(', ')}`);
    });
}
