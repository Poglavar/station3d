// Pins the recorded GTA engine bank and its license trail so a missing or
// accidentally replaced binary asset fails in the fast headless suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const audioDirectory = new URL('../audio/sfx/car-engine/', import.meta.url);

test('all six loopable PCM recordings and their CC0 source record are present', async () => {
    for (let index = 0; index < 6; index += 1) {
        const bytes = await readFile(new URL(`loop-${index}.wav`, audioDirectory));
        assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
        assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
        assert.ok(bytes.length > 50_000, `loop-${index}.wav is unexpectedly short`);
    }
    const attribution = await readFile(new URL('ATTRIBUTION.md', audioDirectory), 'utf8');
    assert.match(attribution, /opengameart\.org\/content\/racing-car-engine-sound-loops/);
    assert.match(attribution, /CC0 1\.0/);
});
