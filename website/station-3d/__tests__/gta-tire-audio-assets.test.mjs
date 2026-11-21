// Guards the recorded skid loop and its attribution trail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const audioDirectory = new URL('../audio/sfx/tire-skid/', import.meta.url);

test('recorded tire loop is a real WAV with source and license metadata', async () => {
    const sample = await readFile(new URL('skid-loop.wav', audioDirectory));
    assert.equal(sample.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(sample.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.ok(sample.length > 100_000, `sample bytes=${sample.length}`);

    const attribution = await readFile(new URL('ATTRIBUTION.md', audioDirectory), 'utf8');
    assert.match(attribution, /opengameart\.org\/content\/car-tire-skid-squealing/);
    assert.match(attribution, /creativecommons\.org\/licenses\/by\/3\.0/);
    assert.match(attribution, /Mike Koenig/);
});
