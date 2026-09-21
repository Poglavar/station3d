// Production Station3D bundle: stable public entries, hashed split chunks, and
// self-hosted decoder assets. Source remains native ESM for Node tests/local QA.

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stationRoot = resolve(repoRoot, 'website/station-3d');
const outdir = resolve(stationRoot, 'dist');
rmSync(outdir, { recursive: true, force: true });

const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: {
        index: 'website/station-3d/lazy-entry.js',
        debug: 'website/station-3d/debug.js',
        host: 'website/station-3d/host.js',
        inspection: 'website/station-3d/inspection.js',
        planning: 'website/station-3d/planning.js',
        'terrain-tools': 'website/station-3d/terrain-tools.js',
        'voice-tools': 'website/station-3d/voice-tools.js',
        'render-compiler-worker': 'website/station-3d/workers/render-compiler-worker.js',
        'baked-world-shadow-worker': 'website/station-3d/core/baked-world-shadow-worker.js',
    },
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    sourcemap: false,
    metafile: true,
    legalComments: 'none',
    treeShaking: true,
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    define: {
        'process.env.NODE_ENV': '"production"',
    },
});

const dracoSource = resolve(
    repoRoot,
    'node_modules/three/examples/jsm/libs/draco/gltf',
);
const dracoTarget = resolve(outdir, 'draco');
mkdirSync(dracoTarget, { recursive: true });
cpSync(dracoSource, dracoTarget, { recursive: true });

// A production loader and shell stylesheet travel with the bundle. The loader
// owns CSS installation so hosts cannot accidentally depend on Zagreb styles.
// Campaign hosts may keep their authored font and logo in their downstream
// stylesheet; the reusable package substitutes self-contained generic styling.
const publicShellCss = readFileSync(resolve(stationRoot, 'ui/shell.css'), 'utf8')
    .replace(/@font-face\s*\{\s*font-family:\s*'Bebas Neue';[\s\S]*?\}\s*/u, '')
    .replace("'Bebas Neue', 'Arial Narrow', Impact, sans-serif", "'Arial Narrow', Impact, sans-serif")
    .replace(
        "url('../assets/logo/vagabond-croatia.webp') center / contain no-repeat",
        'radial-gradient(circle at 50% 50%, rgba(242, 183, 77, 0.9), rgba(119, 7, 11, 0) 68%)',
    );
writeFileSync(resolve(outdir, 'station3d.css'), publicShellCss);
writeFileSync(resolve(outdir, 'loader.js'), `// Loads the versioned Station3D browser bundle and installs its shell stylesheet.\n(function loadStation3D() {\n    const script = document.currentScript;\n    const baseUrl = new URL('./', script && script.src ? script.src : document.baseURI);\n    const styleUrl = new URL('station3d.css', baseUrl).href;\n    if (!document.querySelector('link[data-station3d-shell]')) {\n        const link = document.createElement('link');\n        link.rel = 'stylesheet';\n        link.href = styleUrl;\n        link.dataset.station3dShell = '';\n        document.head.appendChild(link);\n    }\n    // Vendoring intentionally changes the directory name, so production mode\n    // is a loader contract rather than a brittle pathname convention.\n    window.__station3DProductionBundle = true;\n    window.__station3DReady = import(new URL('index.js', baseUrl).href).then(() => window.Station3D);\n    window.dispatchEvent(new Event('station3d:loader-ready'));\n}());\n`);

const assetManifest = JSON.parse(readFileSync(resolve(repoRoot, 'assets.manifest.json'), 'utf8'));
const copiedAssetRoots = [];
for (const group of assetManifest.groups || []) {
    if (group.includeInCandidate !== true) continue;
    for (const relativePath of group.paths || []) {
        const sourcePath = resolve(stationRoot, relativePath);
        const targetPath = resolve(outdir, relativePath);
        mkdirSync(dirname(targetPath), { recursive: true });
        cpSync(sourcePath, targetPath, { recursive: true });
        copiedAssetRoots.push(relativePath);
    }
}

function filesBelow(path, relativeBase = '') {
    if (!statSync(path).isDirectory()) return [relativeBase];
    return readdirSync(path).flatMap(name => filesBelow(
        resolve(path, name),
        relativeBase ? `${relativeBase}/${name}` : name,
    ));
}

const runtimeAssets = copiedAssetRoots.flatMap(relativePath => {
    const sourcePath = resolve(stationRoot, relativePath);
    return filesBelow(sourcePath, relativePath).map(file => ({
        file,
        bytes: statSync(resolve(stationRoot, file)).size,
        sha256: createHash('sha256').update(readFileSync(resolve(stationRoot, file))).digest('hex'),
    }));
}).sort((a, b) => a.file.localeCompare(b.file));

const outputs = Object.entries(result.metafile.outputs).map(([file, meta]) => ({
    file: file.replace(`${repoRoot}/`, ''),
    bytes: meta.bytes,
    entryPoint: meta.entryPoint || null,
    imports: meta.imports.map(entry => ({ path: entry.path, kind: entry.kind })),
})).sort((a, b) => a.file.localeCompare(b.file));
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const inputs = Object.keys(result.metafile.inputs).sort();
const reviewRequiredInputs = inputs.filter(file => (
    /campaigns\/(?!bootstrap\.js)/i.test(file)
    || /models\/structures\//i.test(file)
    || /models\/vehicles\/adriatic/i.test(file)
    || /world\/(?:campaign-(?:construction-site|fireworks|foot-pursuers|music|tower)|gric-tunnel-landmark)\.js$/i.test(file)
    || /(?:croati|zagreb|toranj|gric|lika|viktorija|sloboda)/i.test(file)
)).sort();
writeFileSync(resolve(outdir, 'build-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    threeVersion: packageJson.devDependencies?.three || null,
    rapierVersion: packageJson.devDependencies?.['@dimforge/rapier3d-compat'] || null,
    tilesRendererVersion: packageJson.devDependencies?.['3d-tiles-renderer'] || null,
    inputs,
    outputs,
    runtimeAssets,
    reviewRequiredInputs,
}, null, 2)}\n`);

const jsOutputs = outputs.filter(output => output.file.endsWith('.js'));
const totalBytes = jsOutputs.reduce((sum, output) => sum + output.bytes, 0);
console.log(`Station3D bundle: ${jsOutputs.length} JS files, ${totalBytes} bytes`);
console.log(`Stable entry: ${resolve(outdir, 'index.js')}`);
console.log(`Runtime assets: ${runtimeAssets.length} files from ${copiedAssetRoots.length} audited roots`);
console.log(`Review-required bundle inputs: ${reviewRequiredInputs.length}`);
