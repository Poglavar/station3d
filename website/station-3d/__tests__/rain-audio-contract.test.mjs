import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

test('rain ambience uses documented CC0 recordings instead of generated noise', async () => {
    const [source, provenance, light, steady] = await Promise.all([
        readFile(new URL('ui/rain-audio.js', ROOT), 'utf8'),
        readFile(new URL('audio/sfx/rain/SOURCES.md', ROOT), 'utf8'),
        stat(new URL('audio/sfx/rain/rain-light.mp3', ROOT)),
        stat(new URL('audio/sfx/rain/rain-steady.mp3', ROOT)),
    ]);
    assert.match(source, /rain-light\.mp3/);
    assert.match(source, /rain-steady\.mp3/);
    assert.doesNotMatch(source, /createBuffer\(|pink-noise|Math\.random\(\) \* 2 - 1/);
    assert.match(provenance, /OpenGameArt/);
    assert.match(provenance, /CC0 1\.0/);
    assert.ok(light.size > 500_000);
    assert.ok(steady.size > 500_000);
});
