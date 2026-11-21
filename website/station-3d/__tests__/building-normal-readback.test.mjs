// Exercise the production wall-atlas/normal-map generators with canvas I/O
// replaced. A canvas's first context request, not a later request, owns its mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';

const source = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');
const heightAt = (x, y) => (x * 17 + y * 31) % 256;

function fixture() {
    const canvases = [], paints = [], seeds = [];
    const context = vm.createContext({
        THREE, WALL_ATLAS_GRID: 4, WALL_ATLAS_TILE_SIZE: 128, WALL_TEX_CELL_M: 6,
        document: { createElement(tag) {
            assert.equal(tag, 'canvas');
            const canvas = { width: 0, height: 0, requests: [], draws: [], reads: [], pixels: null };
            canvas.getContext = (kind, options) => {
                assert.equal(kind, '2d');
                canvas.requests.push({ ...options });
                if (!canvas.context) {
                    canvas.attributes = { willReadFrequently: false, ...options };
                    canvas.context = {
                        canvas,
                        drawImage(tile, x, y) { canvas.draws.push({ tile, x, y }); },
                        getImageData(x, y, width, height) {
                            canvas.reads.push({ x, y, width, height });
                            const data = new Uint8ClampedArray(width * height * 4);
                            for (let yy = 0; yy < height; yy++) for (let xx = 0; xx < width; xx++) {
                                data[(yy * width + xx) * 4] = heightAt(xx, yy);
                            }
                            return { data };
                        },
                        createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
                        putImageData(image, x, y) {
                            assert.equal(x, 0); assert.equal(y, 0);
                            canvas.pixels = image.data;
                        },
                    };
                }
                return canvas.context;
            };
            canvases.push(canvas);
            return canvas;
        } },
        createSeededRandom(seed) { seeds.push(seed); return () => seed; },
        paintHeightVariantCooperative: function* (idx, ctx, size, rand) {
            paints.push({ kind: 'height', idx, canvas: ctx.canvas, size, seed: rand() });
            yield { phase: 'height-paint' };
        },
        paintVariantCooperative: function* (idx, ctx, size, rand) {
            paints.push({ kind: 'color', idx, canvas: ctx.canvas, size, seed: rand() });
            yield { phase: 'color-paint' };
        },
        makeRepeatingTexture: (canvas, repeatX, repeatY, colorSpace) => ({ canvas, repeatX, repeatY, colorSpace }),
        makeWallTexture: canvas => ({ canvas }),
    });
    for (const name of ['buildWallAtlasCooperative', 'heightCanvasToNormalCanvasCooperative',
        'buildWallNormalVariant', 'buildWallTextureVariant']) {
        const start = source.indexOf(`function* ${name}(`);
        assert.ok(start >= 0, `Missing production generator ${name}`);
        vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
    }
    function build(name, idx) {
        const phases = [], iterator = context[name](idx);
        let next;
        while (!(next = iterator.next()).done) phases.push(next.value.phase);
        return { texture: next.value, phases };
    }
    return { canvases, paints, seeds, build };
}

for (let variant = 0; variant < 4; variant++) {
    test(`wall normal variant ${variant} creates its height atlas readback-friendly`, () => {
        const w = fixture();
        w.build('buildWallNormalVariant', variant);
        const atlas = w.canvases[0];
        assert.equal(atlas.requests[0].willReadFrequently, true,
            'a hint on the later getImageData context request cannot change the original context');
        assert.equal(atlas.attributes.willReadFrequently, true);
        assert.equal(atlas.reads.length, 1);
    });
}

test('normal-map construction preserves tiles, cooperative phases, wrapped pixels and texture settings', () => {
    const w = fixture(), { texture, phases } = w.build('buildWallNormalVariant', 2);
    const atlas = w.canvases[0], normal = texture.canvas;
    assert.equal(atlas.width, 512); assert.equal(atlas.height, 512);
    assert.equal(normal.width, 512); assert.equal(normal.height, 512);
    assert.equal(w.paints.length, 16); assert.equal(atlas.draws.length, 16);
    for (let tile = 0; tile < 16; tile++) {
        const row = Math.floor(tile / 4), col = tile % 4, paint = w.paints[tile];
        assert.equal(paint.kind, 'height'); assert.equal(paint.idx, 2); assert.equal(paint.size, 128);
        assert.equal(paint.seed, (3 * 1009) ^ (row * 9176) ^ (col * 6113));
        assert.equal(atlas.draws[tile].tile, paint.canvas);
        assert.equal(atlas.draws[tile].x, col * 128); assert.equal(atlas.draws[tile].y, row * 128);
        assert.equal(paint.canvas.attributes.willReadFrequently, true);
        assert.deepEqual(phases.slice(tile * 2, tile * 2 + 2), ['height-paint', 'wall-height-atlas-tile']);
    }
    assert.deepEqual(phases.slice(32), ['normal-map-readback', ...Array(64).fill('normal-map-rows'), 'normal-map-upload']);
    assert.deepEqual(atlas.reads, [{ x: 0, y: 0, width: 512, height: 512 }]);
    assert.equal(texture.repeatX, 1 / 6); assert.equal(texture.repeatY, 1 / 6);
    assert.equal(texture.colorSpace, THREE.LinearSRGBColorSpace);
    assert.equal(normal.pixels.length, 512 * 512 * 4);
    for (const [x, y] of [[0, 0], [511, 0], [0, 511], [511, 511], [127, 128], [255, 400]]) {
        const sample = (xx, yy) => heightAt((xx + 512) % 512, (yy + 512) % 512) / 255;
        const dx = (sample(x + 1, y) - sample(x - 1, y)) * 2.4;
        const dy = (sample(x, y + 1) - sample(x, y - 1)) * 2.4;
        const length = Math.sqrt(dx * dx + dy * dy + 1);
        const expected = [-dx, -dy, 1].map(n => Math.round((n / length * 0.5 + 0.5) * 255));
        assert.deepEqual([...normal.pixels.slice((y * 512 + x) * 4, (y * 512 + x) * 4 + 4)], [...expected, 255]);
    }
});

test('color wall atlases keep their original context mode and cooperative tile painting', () => {
    const w = fixture(), { texture, phases } = w.build('buildWallTextureVariant', 1);
    assert.equal(texture.canvas, w.canvases[0]);
    assert.equal(texture.canvas.attributes.willReadFrequently, false);
    assert.equal(texture.canvas.reads.length, 0);
    assert.equal(texture.canvas.draws.length, 16);
    assert.equal(phases.length, 32);
    assert.ok(w.paints.every(p => p.kind === 'color' && p.idx === 1));
});
