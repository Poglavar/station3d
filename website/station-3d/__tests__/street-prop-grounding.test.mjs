// Guards the wiring that seats ambient actors and street defenses on the
// current rendered road/terrain surface after streamed ground refinements.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const nests = await readFile(
    new URL('../world/machine-gun-nests.js', import.meta.url),
    'utf8',
);
const pedestrians = await readFile(
    new URL('../world/pedestrians.js', import.meta.url),
    'utf8',
);
const decor = await readFile(
    new URL('../world/decor.js', import.meta.url),
    'utf8',
);

test('street machine-gun nests wait for terrain evidence and re-seat on refinement', () => {
    assert.doesNotMatch(nests, /kind: 'street',[\s\S]{0,160}y: 0\.08/);
    assert.match(nests, /evidencePlacementBaseSceneY/);
    assert.match(nests, /const supportY = streetNestSupportYAt\(nestX, nestZ\);/);
    assert.match(nests, /if \(supportY === null\) continue;/);
    assert.match(nests, /y: supportY/);
    assert.match(nests, /reseatStreetNestsForGroundRevision\(\)/);
    assert.match(nests, /terrainReference\?\.roadFormation\?\.revision/);
});

test('ambient feet and benches consume the exact rendered asphalt support', () => {
    assert.match(pedestrians, /evidencePlacementBaseSceneY\(activeTerrainReference\(\), x, z\)/);
    assert.match(pedestrians, /if \(placementY === null\) return null/);
    assert.match(pedestrians, /renderedGroundYAt\(x, z, placementY\)/);
    assert.match(pedestrians, /finiteOrNull\(renderedGroundYAt\(x, z, placementY\)\)/);
    assert.match(pedestrians, /renderedY \?\? placementY/);
    assert.match(decor, /evidencePlacementBaseSceneY/);
    assert.match(decor, /const groundY = terrainBaseY\(local\.x, local\.z, true\);/);
    assert.match(decor, /if \(groundY === null\) continue;/);
    assert.match(
        decor,
        /nearby\.push\(\{\s*id: entry\.id,[\s\S]{0,320}\s+groundY,\s*\}\);/,
    );
    assert.match(decor, /renderedGroundYAt\(localX, localZ, placementY\)/);
});
