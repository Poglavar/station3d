// Inspects the npm tarball file list and rejects host or campaign leakage.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
if (packageJson.scripts?.prepare !== 'npm run build:station3d') {
    throw new Error('Git installs must build the browser distribution through prepare');
}
const npmCache = mkdtempSync(resolve(tmpdir(), 'station3d-npm-cache-'));
const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station3d-consumer-'));
try {
    const output = execFileSync('npm', [
        'pack', '--ignore-scripts', '--json', '--pack-destination', npmCache,
    ], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, npm_config_cache: npmCache },
    });
    const report = JSON.parse(output)[0];
    const files = report.files.map(entry => entry.path);
    const required = [
        'README.md',
        'AGENTS.md',
        'assets.manifest.json',
        'bin/station3d-vendor.mjs',
        'bin/station3d-build.mjs',
        'demo/index.html',
        'docs/consumer-integration.md',
        'docs/provider-contract.md',
        'website/station-3d/dist/index.js',
        'website/station-3d/dist/debug.js',
        'website/station-3d/dist/host.js',
        'website/station-3d/dist/inspection.js',
        'website/station-3d/dist/loader.js',
        'website/station-3d/dist/planning.js',
        'website/station-3d/dist/terrain-tools.js',
        'website/station-3d/dist/voice-tools.js',
        'website/station-3d/dist/models/vehicles/utva-liaison.glb',
        'website/station-3d/dist/station3d.css',
        'website/station-3d/dist/build-manifest.json',
    ];
    for (const path of required) {
        if (!files.includes(path)) throw new Error(`npm package is missing ${path}`);
    }
    const forbidden = [
        'website/station-3d/assets/campaign/',
        'website/station-3d/audio/announcements/',
        'website/station-3d/audio/conversations/',
        'website/station-3d/models/characters/',
        'website/station-3d/models/structures/',
        'website/station-3d/models/vehicles/studies/',
    ];
    for (const prefix of forbidden) {
        if (files.some(path => path.startsWith(prefix))) {
            throw new Error(`npm package contains forbidden path ${prefix}`);
        }
    }
    const tarball = resolve(npmCache, report.filename);
    writeFileSync(resolve(fixtureRoot, 'package.json'), '{"private":true}\n');
    execFileSync('npm', [
        'install', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', tarball,
    ], {
        cwd: fixtureRoot,
        stdio: 'pipe',
        env: { ...process.env, npm_config_cache: npmCache },
    });
    const installedRoot = resolve(fixtureRoot, 'node_modules/station3d');
    const vendorTarget = resolve(fixtureRoot, 'public/station3d');
    execFileSync(process.execPath, [resolve(installedRoot, 'bin/station3d-vendor.mjs'), vendorTarget], {
        cwd: fixtureRoot,
        stdio: 'pipe',
    });
    if (!existsSync(resolve(vendorTarget, 'loader.js'))
        || !existsSync(resolve(vendorTarget, 'index.js'))
        || !existsSync(resolve(vendorTarget, 'debug.js'))
        || !existsSync(resolve(vendorTarget, 'inspection.js'))
        || !existsSync(resolve(vendorTarget, 'planning.js'))
        || !existsSync(resolve(vendorTarget, 'terrain-tools.js'))
        || !existsSync(resolve(vendorTarget, 'voice-tools.js'))
        || !existsSync(resolve(vendorTarget, 'draco/draco_decoder.wasm'))) {
        throw new Error('Installed package did not vendor a complete browser distribution');
    }
    const overlayManifest = resolve(fixtureRoot, 'empty-content.json');
    const contentTarget = resolve(fixtureRoot, 'public/station3d-content');
    writeFileSync(overlayManifest, '{"schemaVersion":1,"overlays":{}}\n');
    execFileSync(process.execPath, [
        resolve(installedRoot, 'bin/station3d-build.mjs'),
        '--overlay-manifest', overlayManifest,
        '--out-dir', contentTarget,
        '--force',
    ], { cwd: fixtureRoot, stdio: 'pipe' });
    if (!existsSync(resolve(contentTarget, 'loader.js'))
        || !existsSync(resolve(contentTarget, 'index.js'))
        || !existsSync(resolve(contentTarget, 'host.js'))
        || !existsSync(resolve(contentTarget, 'planning.js'))
        || !existsSync(resolve(contentTarget, 'build-manifest.json'))) {
        throw new Error('Installed package did not build a complete content distribution');
    }
    const contentManifestText = readFileSync(resolve(contentTarget, 'build-manifest.json'), 'utf8');
    if (contentManifestText.includes(fixtureRoot) || contentManifestText.includes(installedRoot)) {
        throw new Error('Content build manifest leaked local absolute paths');
    }
    const contentManifest = JSON.parse(contentManifestText);
    if (contentManifest.outputs.some(output => output.file.startsWith('../'))
        || contentManifest.outputs.some(output => output.entryPoint?.includes(fixtureRoot))) {
        throw new Error('Content build manifest paths are not distribution-relative');
    }
    const publicCss = readFileSync(resolve(vendorTarget, 'station3d.css'), 'utf8');
    if (/BebasNeue|vagabond-croatia/u.test(publicCss)) {
        throw new Error('Public stylesheet still references downstream campaign assets');
    }
    console.log(`[package] ${report.filename}: ${files.length} files, ${report.size} packed bytes, ${report.unpackedSize} unpacked bytes`);
    console.log('[package] tarball install and station3d-vendor consumer fixture passed');
} finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(npmCache, { recursive: true, force: true });
}
