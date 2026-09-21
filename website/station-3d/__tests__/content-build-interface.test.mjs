import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('host, planning, debug, tooling and content-build entries are public package contracts', async () => {
    const [host, planning, debug, terrainTools, voiceTools, builder, packageJson] = await Promise.all([
        readFile(new URL('../host.js', import.meta.url), 'utf8'),
        readFile(new URL('../planning.js', import.meta.url), 'utf8'),
        readFile(new URL('../debug.js', import.meta.url), 'utf8'),
        readFile(new URL('../terrain-tools.js', import.meta.url), 'utf8'),
        readFile(new URL('../voice-tools.js', import.meta.url), 'utf8'),
        readFile(new URL('../../../bin/station3d-build.mjs', import.meta.url), 'utf8'),
        readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ]);
    const pkg = JSON.parse(packageJson);
    assert.equal(pkg.exports['./host'], './website/station-3d/dist/host.js');
    assert.equal(pkg.exports['./planning'], './website/station-3d/dist/planning.js');
    assert.equal(pkg.exports['./debug'], './website/station-3d/dist/debug.js');
    assert.equal(pkg.exports['./terrain-tools'], './website/station-3d/dist/terrain-tools.js');
    assert.equal(pkg.exports['./voice-tools'], './website/station-3d/dist/voice-tools.js');
    assert.equal(pkg.bin['station3d-build'], 'bin/station3d-build.mjs');
    assert.match(host, /createExplorerSessionController/);
    assert.match(host, /prepareFreeRoamOptions/);
    assert.match(host, /campaignCheckpointRequest/);
    assert.match(planning, /buildProposalTrackFeatures/);
    assert.match(planning, /mergeProposalIds/);
    assert.match(planning, /describeStation/);
    assert.match(debug, /openScenario/);
    assert.match(terrainTools, /buildTerrainViewerMeshData/);
    assert.match(terrainTools, /buildDrapedRibbon/);
    assert.match(voiceTools, /conversationFlow/);
    assert.match(builder, /station3d-content-overlay/);
    assert.match(builder, /contentOverlay/);
    assert.match(builder, /runtimeAssets/);
    assert.match(builder, /relative\(outdir, file\)/);
    assert.match(builder, /contentOverlay: \[\.\.\.overlays\.keys\(\)\]/);
});
