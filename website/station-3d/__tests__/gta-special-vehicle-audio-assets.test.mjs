// Guards the three recorded CC0 loops and their retained source metadata.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const audioDirectory = new URL('../audio/sfx/special-vehicles/', import.meta.url);

function looksLikeMp3(bytes) {
    return bytes.subarray(0, 3).toString('ascii') === 'ID3'
        || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
}

test('special vehicle recordings are real MP3 assets with CC0 provenance', async () => {
    for (const filename of [
        'airplane-propeller-loop.mp3',
        'boat-engine-loop.mp3',
        'boat-wake-loop.mp3',
    ]) {
        const sample = await readFile(new URL(filename, audioDirectory));
        assert.ok(looksLikeMp3(sample), `${filename} is not MP3`);
        assert.ok(sample.length > 100_000, `${filename} bytes=${sample.length}`);
    }
    const attribution = await readFile(new URL('ATTRIBUTION.md', audioDirectory), 'utf8');
    assert.match(attribution, /freesound\.org\/people\/modusmogulus\/sounds\/789390/);
    assert.match(attribution, /freesound\.org\/people\/ivolipa\/sounds\/325301/);
    assert.match(attribution, /freesound\.org\/people\/Lydmakeren\/sounds\/510900/);
    assert.match(attribution, /publicdomain\/zero\/1\.0/);
});
