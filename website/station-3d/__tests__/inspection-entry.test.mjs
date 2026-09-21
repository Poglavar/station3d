import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('inspection helpers have a separately bundled public entry', async () => {
    const [entry, build, packageJson, verifier] = await Promise.all([
        readFile(new URL('../inspection.js', import.meta.url), 'utf8'),
        readFile(new URL('../../../tools/build-station3d.mjs', import.meta.url), 'utf8'),
        readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
        readFile(new URL('../../../tools/verify-package.mjs', import.meta.url), 'utf8'),
    ]);
    assert.match(entry, /entityKeyForFeature/);
    assert.match(entry, /createEntitySelectionStore/);
    assert.match(entry, /normalizeTrackCollection/);
    assert.match(build, /inspection:\s*'website\/station-3d\/inspection\.js'/);
    assert.equal(JSON.parse(packageJson).exports['./inspection'], './website/station-3d/dist/inspection.js');
    assert.match(verifier, /dist\/inspection\.js/);
});
