// Covers clean npm output and the lifecycle stdout that broke the CI package check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNpmPackReport } from '../../../tools/lib/npm-pack-report.mjs';

const report = {
    filename: 'station3d-0.1.0-alpha.5.tgz',
    files: [{ path: 'website/station-3d/dist/index.js' }],
    size: 1024,
    unpackedSize: 4096,
};
const json = `${JSON.stringify([report], null, 2)}\n`;

test('reads the npm pack report without lifecycle output', () => {
    assert.deepEqual(parseNpmPackReport(json), report);
});

test('ignores npm lifecycle banners and build logs before the report', () => {
    const output = '\n> station3d@0.1.0-alpha.5 prepare\n> npm run build:station3d\n\n'
        + 'Station3D bundle: 59 JS files, 7083021 bytes\n'
        + 'Stable entry: /home/runner/work/station3d/station3d/website/station-3d/dist/index.js\n'
        + 'Runtime assets: 57 files from 20 audited roots\n'
        + 'Review-required bundle inputs: 0\n'
        + json;
    assert.deepEqual(parseNpmPackReport(output), report);
});

test('does not mistake bracketed log prefixes for the JSON array', () => {
    assert.deepEqual(parseNpmPackReport(`[prepare] build complete\n${json}`), report);
});

test('reports missing JSON with the original npm output', () => {
    const output = 'Station3D bundle: 59 JS files, 7083021 bytes\n';
    assert.throws(() => parseNpmPackReport(output), {
        message: `npm pack produced no JSON:\n${output}`,
    });
});

test('does not suppress malformed JSON reports', () => {
    assert.throws(() => parseNpmPackReport('build complete\n[{"filename":'), SyntaxError);
});

test('rejects an empty package report', () => {
    assert.throws(() => parseNpmPackReport('[]\n'), /npm pack produced no package report/);
});
