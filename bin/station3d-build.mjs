#!/usr/bin/env node
// Builds one Station3D browser distribution with an explicit authored-content
// overlay. Engine imports always resolve from this exact package; only logical
// paths named by the consumer manifest may resolve downstream.

import {
    cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stationRoot = resolve(packageRoot, 'website/station-3d');
const packageDist = resolve(stationRoot, 'dist');
const argv = process.argv.slice(2);

function argument(name) {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
}

const manifestPath = argument('--overlay-manifest');
const outputArgument = argument('--out-dir');
if (!manifestPath || !outputArgument) {
    console.error('Usage: station3d-build --overlay-manifest <file> --out-dir <directory> [--force]');
    process.exit(2);
}
if (!argv.includes('--force') && existsSync(resolve(outputArgument))) {
    throw new Error('Output directory exists; pass --force to replace it.');
}

const absoluteManifestPath = resolve(manifestPath);
const manifestRoot = dirname(absoluteManifestPath);
const manifest = JSON.parse(readFileSync(absoluteManifestPath, 'utf8'));
if (manifest.schemaVersion !== 1 || !manifest.overlays || typeof manifest.overlays !== 'object') {
    throw new Error('Overlay manifest must have schemaVersion 1 and an overlays object.');
}

function logicalPath(value) {
    const normalized = normalize(String(value || '')).split(sep).join('/');
    if (!normalized.endsWith('.js') || normalized.startsWith('../') || isAbsolute(normalized)) {
        throw new Error(`Invalid Station3D overlay path: ${value}`);
    }
    return normalized;
}

const overlays = new Map(Object.entries(manifest.overlays).map(([logical, source]) => {
    const target = resolve(manifestRoot, String(source));
    if (!existsSync(target)) throw new Error(`Overlay source does not exist: ${target}`);
    return [logicalPath(logical), target];
}));
function resolveLogical(importerLogical, request) {
    return logicalPath(resolve('/', dirname(importerLogical), request).slice(1));
}

const contentOverlayPlugin = {
    name: 'station3d-content-overlay',
    setup(buildApi) {
        buildApi.onResolve({ filter: /^\./ }, (args) => {
            let importerLogical = null;
            if (args.namespace === 'station3d-source') {
                importerLogical = args.pluginData.logical;
            } else if (args.importer.startsWith(`${stationRoot}${sep}`)) {
                importerLogical = relative(stationRoot, args.importer).split(sep).join('/');
            }
            if (!importerLogical) return null;
            const logical = resolveLogical(importerLogical, args.path);
            const packagePath = resolve(stationRoot, logical);
            const path = overlays.get(logical) || (existsSync(packagePath)
                ? packagePath
                : resolve(dirname(stationRoot), logical));
            if (!existsSync(path)) {
                throw new Error(`Station3D content overlay cannot resolve ${logical}`);
            }
            return { path, namespace: 'station3d-source', pluginData: { logical } };
        });
        buildApi.onResolve({ filter: /^[^./]/, namespace: 'station3d-source' }, (args) => (
            buildApi.resolve(args.path, {
                kind: args.kind,
                resolveDir: packageRoot,
            })
        ));
        buildApi.onLoad({ filter: /\.js$/, namespace: 'station3d-source' }, (args) => ({
            contents: readFileSync(args.path, 'utf8'),
            loader: 'js',
            resolveDir: dirname(args.path),
            pluginData: { logical: args.pluginData.logical },
        }));
    },
};

const outdir = resolve(outputArgument);
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
const result = await build({
    absWorkingDir: packageRoot,
    entryPoints: {
        index: resolve(stationRoot, 'lazy-entry.js'),
        debug: resolve(stationRoot, 'debug.js'),
        host: resolve(stationRoot, 'host.js'),
        inspection: resolve(stationRoot, 'inspection.js'),
        planning: resolve(stationRoot, 'planning.js'),
        'render-compiler-worker': resolve(stationRoot, 'workers/render-compiler-worker.js'),
        'baked-world-shadow-worker': resolve(stationRoot, 'core/baked-world-shadow-worker.js'),
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
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [contentOverlayPlugin],
});

cpSync(resolve(packageDist, 'draco'), resolve(outdir, 'draco'), { recursive: true });
for (const name of ['loader.js', 'station3d.css']) {
    cpSync(resolve(packageDist, name), resolve(outdir, name));
}
const packageBuild = JSON.parse(readFileSync(resolve(packageDist, 'build-manifest.json'), 'utf8'));
for (const asset of packageBuild.runtimeAssets || []) {
    const source = resolve(packageDist, asset.file);
    const target = resolve(outdir, asset.file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
}

const logicalBySource = new Map(
    [...overlays.entries()].map(([logical, source]) => [resolve(source), logical]),
);
function publicEntryPoint(value) {
    if (!value) return null;
    const source = resolve(
        value.startsWith('station3d-source:')
            ? value.slice('station3d-source:'.length)
            : resolve(packageRoot, value),
    );
    const overlayLogical = logicalBySource.get(source);
    if (overlayLogical) return `overlay:${overlayLogical}`;
    if (source.startsWith(`${stationRoot}${sep}`)) {
        return `station3d:${relative(stationRoot, source).split(sep).join('/')}`;
    }
    if (source.startsWith(`${packageRoot}${sep}`)) {
        return `package:${relative(packageRoot, source).split(sep).join('/')}`;
    }
    return null;
}
const outputs = Object.entries(result.metafile.outputs).map(([file, metadata]) => ({
    file: relative(outdir, file).split(sep).join('/'),
    bytes: metadata.bytes,
    entryPoint: publicEntryPoint(metadata.entryPoint),
})).sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(resolve(outdir, 'build-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    packageVersion: JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).version,
    contentOverlay: [...overlays.keys()],
    outputs,
    runtimeAssets: packageBuild.runtimeAssets || [],
}, null, 2)}\n`);

console.log(`[station3d-build] ${outputs.length} JS outputs with ${overlays.size} explicit content overlays`);
console.log(`[station3d-build] wrote ${outdir}`);
