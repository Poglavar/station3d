// Detailed building facades must prepare their immutable coverage index through
// the shared cooperative queue before any synchronous opening-mask query.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
    fileURLToPath(new URL('../world/buildings.js', import.meta.url)),
    'utf8',
);

test('every non-glass GDI facade prepares its shared coverage index cooperatively', () => {
    const stage = SRC.slice(
        SRC.indexOf('function* stageBuildingFeatureGdi'),
        SRC.indexOf('function createGdiBuildingBuildTask'),
    );
    const prepareAt = stage.indexOf('prepareFacadeCoverageIndexCooperative(surface)');
    const maskAt = stage.indexOf('openingMask = getFacadeOpeningMask(');

    assert.ok(prepareAt >= 0, 'the common facade path must create the coverage iterator');
    assert.ok(maskAt > prepareAt, 'coverage preparation must finish before the mask query');
    assert.match(
        stage.slice(prepareAt, maskAt),
        /while \(!coverageStep\.done\) \{\s*yield \{ \.\.\.coverageStep\.value, objectId \};/,
        'coverage work must return to the shared frame queue between bounded stages',
    );
});
