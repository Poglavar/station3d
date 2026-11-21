import test from 'node:test';
import assert from 'node:assert/strict';
import { captureGroundPaintStyles, captureGroundPaintMaterialRows } from '../core/ground-paint-styles.js';
import { SURFACE_CLASS } from '../core/surface-hierarchy.js';

const recipe = (surfaceClass = SURFACE_CLASS.SIDEWALK) => ({
    id: 3, revision: 'r1', surfaceClass, roughness: .7, metalness: .1,
    normalInfluence: .2, linearColor: [.2, .4, .8],
});

test('capture is immutable and retains explicit physical style parameters', () => {
    const input = new Map([['sidewalk', recipe()]]);
    const captured = captureGroundPaintStyles(input);
    input.get('sidewalk').linearColor[0] = 1;
    input.get('sidewalk').roughness = 0;
    assert.deepEqual(captured.recipes[0].linearColor, [.2, .4, .8]);
    assert.equal(captured.recipes[0].roughness, .7);
    assert.notEqual(captured.copyBytes(), captured.copyBytes());
});

test('canonical ranks differ for sidewalk classes and duplicate IDs conflict', () => {
    const a = captureGroundPaintStyles(new Map([['a', recipe(SURFACE_CLASS.SIDEWALK)]]));
    const b = captureGroundPaintStyles(new Map([['a', recipe(SURFACE_CLASS.BUFFERED_SIDEWALK)]]));
    assert.notEqual(a.recipes[0].rank, b.recipes[0].rank);
    assert.throws(() => captureGroundPaintStyles(new Map([
        ['a', recipe()], ['b', { ...recipe(), id: 3 }],
    ])), /Conflicting/);
});

test('malformed explicit parameters are rejected', () => {
    for (const field of ['roughness', 'metalness', 'normalInfluence']) {
        assert.throws(() => captureGroundPaintStyles(new Map([['x', { ...recipe(), [field]: 2 }]])), /Invalid paint recipe/);
    }
    assert.throws(() => captureGroundPaintStyles(new Map([['x', { ...recipe(), surfaceClass: 'unknown' }]])), /Unknown surface class/);
});

test('changed captured table key detects incompatible copied pages', () => {
    const first = captureGroundPaintStyles(new Map([['x', recipe()]]));
    const changed = captureGroundPaintStyles(new Map([['x', { ...recipe(), roughness: .8 }]]));
    assert.notEqual(first.key, changed.key);
});

test('material rows preserve parameters, color, and page-relative UV phase', () => {
    const styles = captureGroundPaintStyles(new Map([['paving', { ...recipe(), albedoMap: {
        key: 'pavers', revision: 'p1', uvTransform: [1 / 3.6, 0, .25, 0, 1 / 3.6, .75],
    } }]]));
    const rows = captureGroundPaintMaterialRows(styles, { get: spec => {
        assert.equal(spec.key, 'pavers'); return { layer: 2, scaleU: 1, scaleV: 1 };
    } },
        { minX: 3.6, minZ: 7.2 });
    assert.deepEqual([...rows.slice(3 * 4, 3 * 4 + 4)], [.7, .1, .2, 65].map(Math.fround));
    assert.deepEqual([...rows.slice(1024 + 3 * 4, 1024 + 3 * 4 + 4)], [.2, .4, .8, 3].map(Math.fround));
    assert.equal(rows[2048 + 3 * 4 + 2], .25);
    assert.equal(rows[3072 + 3 * 4 + 2], .75);
});

test('material rows reject an unprepared pattern', () => {
    const styles = captureGroundPaintStyles(new Map([['paving', { ...recipe(), albedoMap: {
        key: 'pavers', revision: 'p1', uvTransform: [1, 0, 0, 0, 1, 0],
    } }]]));
    assert.throws(() => captureGroundPaintMaterialRows(styles, new Map(), { minX: 0, minZ: 0 }), /pattern/);
});

test('distant page phases retain source frequency independently of ownership texel size', () => {
    const uv = [.25,.5,.125, -.5,.25,.375];
    const styles = captureGroundPaintStyles(new Map([['paving', { ...recipe(), albedoMap: {
        key: 'pavers', revision: 'p1', uvTransform: uv,
    } }]]));
    const patterns = { get: () => ({ layer: 1, scaleU: .5, scaleV: 1 }) };
    const wrap = value => value - Math.floor(value);
    for (const [minX,minZ] of [[0,0],[100000.25,-200000.75]]) {
        const rows = captureGroundPaintMaterialRows(styles, patterns, {minX,minZ});
        const offset = recipe().id*4;
        for (const [x,z] of [[.125,.25],[19.75,-8.125]]) {
            const localU = rows[2048+offset]*x+rows[2048+offset+1]*z+rows[2048+offset+2];
            const localV = rows[3072+offset]*x+rows[3072+offset+1]*z+rows[3072+offset+2];
            assert.equal(wrap(localU/.5), wrap(uv[0]*(minX+x)+uv[1]*(minZ+z)+uv[2]));
            assert.equal(wrap(localV), wrap(uv[3]*(minX+x)+uv[4]*(minZ+z)+uv[5]));
        }
    }
});
