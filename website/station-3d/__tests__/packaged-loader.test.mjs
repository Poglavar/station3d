import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('vendored loader marks production independently of its directory name', async () => {
    const [build, facade, emptyWorld] = await Promise.all([
        readFile(new URL('../../../tools/build-station3d.mjs', import.meta.url), 'utf8'),
        readFile(new URL('../lazy-entry.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/public-empty-authored-world.js', import.meta.url), 'utf8'),
    ]);
    assert.match(build, /__station3DProductionBundle\s*=\s*true/);
    assert.match(build, /const publicShellCss/);
    assert.match(build, /vagabond-croatia\.webp/);
    assert.match(build, /radial-gradient/);
    assert.match(facade, /window\.__station3DProductionBundle\s*===\s*true/);
    assert.match(facade, /configuredAssetConfig\.rootUrl/);
    assert.match(facade, /'render-compiler-worker\.js'/);
    assert.match(emptyWorld, /groundReady\(\)\s*\{\s*return true/);
    assert.match(emptyWorld, /manageGroundPublications\(\)/);
});
