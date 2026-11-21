// Source-level seams of the ambient fish jumps: a deferred model-world layer
// that only jumps on mapped (or authored open) sea near the camera, and a CC0
// splash recording with its provenance kept beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url));
const text = path => read(path).toString('utf8');

test('the fish jumps are a deferred model-world layer in every session', () => {
    const cab = text('../modes/cab.js');
    assert.match(cab, /import \{ fishJumpsLayer \} from '\.\.\/world\/fish-jumps\.js';/);
    assert.match(cab, /\{ name: 'fishJumps', layer: fishJumpsLayer, deferred: true, worlds: 'model', outside: true \}/);
});

test('a jump needs sea near the camera: the mapped coastline, or an authored open sea', () => {
    const layer = text('../world/fish-jumps.js');
    assert.match(layer, /if \(!current\.openSea && !hasMappedSeaCoverage\(\)\) return 'no-sea';/);
    assert.match(layer, /const isSea = current\.openSea \? \(\) => true : isPointInMappedSea;/);
    // The sea test is not cheap, so a search costs a couple of tries per frame.
    assert.match(layer, /config: \{ \.\.\.FISH_JUMP_DEFAULTS, siteAttempts: SITE_TRIES_PER_FRAME \},/);
    assert.match(layer, /planFishJump\(\{ random: Math\.random, site, seaY, isSea, headingAttempts: HEADING_TRIES_PER_FRAME \}\)/);
    assert.match(layer, /openSea: ctx\?\.campaignScene\?\.authored\?\.environment\?\.openSea === true,/);
    const sfx = text('../ui/fish-splash-sfx.js');
    assert.match(sfx, /tail\.connect\(getAudioDestination\(c\)\);/);
    assert.match(sfx, /station3dAssetUrl\('audio\/sfx\/fish\/fish-splash\.mp3'\)/);
});

test('the splash is a real MP3 with its CC0 source recorded', () => {
    const bytes = read('../audio/sfx/fish/fish-splash.mp3');
    assert.ok(bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
    assert.ok(bytes.length > 5000 && bytes.length < 60000, `fish-splash.mp3 bytes=${bytes.length}`);
    const sources = text('../audio/sfx/fish/SOURCES.md');
    assert.match(sources, /freesound\.org\/people\/dslrguide\/sounds\/321490/);
    assert.match(sources, /publicdomain\/zero\/1\.0/);
});
