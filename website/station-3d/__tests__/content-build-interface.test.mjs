import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    assert.match(builder, /contentOverlay: \[\.\.\.overlays\.keys\(\)\]/);
});

test('content build manifest resolves output paths from the installed package, not the caller', async (t) => {
    // Canonical paths expose the same relative esbuild keys on macOS and Linux.
    const consumer = await realpath(await mkdtemp(resolve(tmpdir(), 'station3d-build-paths-')));
    t.after(() => rm(consumer, { recursive: true, force: true }));
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const installedRoot = resolve(consumer, 'node_modules/station3d');
    const stationRoot = resolve(installedRoot, 'website/station-3d');
    const distribution = resolve(stationRoot, 'dist');
    await mkdir(resolve(installedRoot, 'bin'), { recursive: true });
    await mkdir(resolve(installedRoot, 'node_modules'), { recursive: true });
    await symlink(resolve(repoRoot, 'node_modules/esbuild'), resolve(installedRoot, 'node_modules/esbuild'), 'dir');
    await copyFile(resolve(repoRoot, 'bin/station3d-build.mjs'), resolve(installedRoot, 'bin/station3d-build.mjs'));
    await writeFile(resolve(installedRoot, 'package.json'), '{"version":"0.0.0"}\n');
    for (const entry of [
        'lazy-entry.js', 'debug.js', 'host.js', 'inspection.js', 'planning.js',
        'workers/render-compiler-worker.js', 'core/baked-world-shadow-worker.js',
    ]) {
        await mkdir(dirname(resolve(stationRoot, entry)), { recursive: true });
        await writeFile(resolve(stationRoot, entry), 'export const fixture = true;\n');
    }
    await mkdir(resolve(distribution, 'draco'), { recursive: true });
    await writeFile(resolve(distribution, 'loader.js'), '// Fixture loader.\n');
    await writeFile(resolve(distribution, 'station3d.css'), '/* Fixture stylesheet. */\n');
    await writeFile(resolve(distribution, 'build-manifest.json'), '{"runtimeAssets":[]}\n');
    const overlayManifest = resolve(consumer, 'content.json');
    await writeFile(overlayManifest, '{"schemaVersion":1,"overlays":{}}\n');
    const outdir = resolve(consumer, 'public/station3d-content');
    execFileSync(process.execPath, [
        resolve(installedRoot, 'bin/station3d-build.mjs'),
        '--overlay-manifest', overlayManifest,
        '--out-dir', outdir,
    ], { cwd: consumer, stdio: 'pipe' });
    const manifest = JSON.parse(await readFile(resolve(outdir, 'build-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.outputs.map(output => output.file).sort(), [
        'baked-world-shadow-worker.js', 'debug.js', 'host.js', 'index.js', 'inspection.js',
        'planning.js', 'render-compiler-worker.js',
    ]);
    for (const output of manifest.outputs) {
        assert.match(await readFile(resolve(outdir, output.file), 'utf8'), /fixture/);
    }
});
