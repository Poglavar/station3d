import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8');

test('the render Worker graph stays Three.js, DOM, UI, scene, and world-layer free', async () => {
    const sources = await Promise.all([
        read('../workers/render-compiler-worker.js'),
        read('../core/compilers/terrain-render-packet.js'),
        read('../core/compilers/far-building-render-packet.js'),
        read('../core/indexed-geometry.js'),
        read('../core/lod1-prism-geometry.js'),
        read('../core/render-packet.js'),
        read('../core/terrain-snapshot.js'),
        read('../core/terrain-grid.js'),
        read('../core/terrain-tile-geometry.js'),
    ]);
    const graph = sources.join('\n');
    const executable = graph
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(graph, /from\s+['"]three['"]/);
    assert.doesNotMatch(graph, /from\s+['"][^'"]*\/(?:ui|scene|world)\//);
    assert.doesNotMatch(executable, /\b(?:window|document)\s*[.[]|\bHTMLElement\b/);
});

test('terrain and far-building layers have no synchronous production compiler fallback', async () => {
    const [terrain, farBuildings, cab] = await Promise.all([
        read('../world/terrain.js'),
        read('../world/buildings-far.js'),
        read('../modes/cab.js'),
    ]);
    assert.match(terrain, /renderCompiler\.compile\(request\)/);
    assert.match(terrain, /createRenderPacketUploadTask\(packet/);
    assert.doesNotMatch(terrain, /createTerrainTileGeometryTask/);
    assert.match(farBuildings, /renderCompiler\.compile\(request\)/);
    assert.match(farBuildings, /createFarBuildingPacketUploadTask\(packet/);
    assert.doesNotMatch(farBuildings, /compileLod1BuildingPrisms|buildBuildingPrisms/);
    assert.match(cab, /createRenderCompilerClient\(/);
    assert.match(cab, /renderCompiler\?\.dispose\?\.\('cab-session-ended'\)/);
});
