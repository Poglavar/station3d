// The grid only narrows candidates — it must never change an answer. These
// check it against the linear scan it replaced, including the cases that make
// naive grids wrong: items spanning many cells, negative coordinates, and items
// with no usable bounds at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundsGrid, createMutableBoundsGrid } from '../core/bounds-grid.js';

const box = (id, minX, minZ, maxX, maxZ) => ({ id, bounds: { minX, minZ, maxX, maxZ } });

const hits = (items, x, z) => items
    .filter(m => x >= m.bounds.minX && x <= m.bounds.maxX
        && z >= m.bounds.minZ && z <= m.bounds.maxZ)
    .map(m => m.id).sort();

test('a point query returns every item whose bounds contain it', () => {
    const items = [
        box('a', 0, 0, 10, 10),
        box('b', 5, 5, 15, 15),
        box('c', 100, 100, 110, 110),
    ];
    const grid = createBoundsGrid(items);
    for (const [x, z] of [[1, 1], [7, 7], [12, 12], [105, 105], [50, 50], [-5, -5]]) {
        const found = grid.candidatesAt(x, z)
            .filter(m => x >= m.bounds.minX && x <= m.bounds.maxX
                && z >= m.bounds.minZ && z <= m.bounds.maxZ)
            .map(m => m.id).sort();
        assert.deepEqual(found, hits(items, x, z), `at ${x},${z}`);
    }
});

test('the narrowed set matches a full scan across a realistic spread', () => {
    // Deterministic pseudo-random masks over a tile-sized area, including some
    // straddling the origin so negative cell indices are exercised.
    const rnd = (s => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(11);
    const items = [];
    for (let i = 0; i < 400; i++) {
        const x = rnd() * 400 - 200;
        const z = rnd() * 400 - 200;
        const w = 1 + rnd() * 30;
        const h = 1 + rnd() * 30;
        items.push(box(`m${i}`, x, z, x + w, z + h));
    }
    const grid = createBoundsGrid(items);
    let compared = 0;
    for (let i = 0; i < 3000; i++) {
        const x = rnd() * 440 - 220;
        const z = rnd() * 440 - 220;
        const narrowed = grid.candidatesAt(x, z)
            .filter(m => x >= m.bounds.minX && x <= m.bounds.maxX
                && z >= m.bounds.minZ && z <= m.bounds.maxZ)
            .map(m => m.id).sort();
        assert.deepEqual(narrowed, hits(items, x, z), `at ${x},${z}`);
        compared += 1;
    }
    assert.equal(compared, 3000);
    // And it must actually be narrowing, or it is pure overhead.
    assert.ok(grid.stats().cells > 50, `expected a populated grid, got ${JSON.stringify(grid.stats())}`);
});

test('a box query covers every cell it spans, without duplicates', () => {
    const items = [box('a', 0, 0, 5, 5), box('b', 90, 90, 95, 95), box('c', 40, 40, 45, 45)];
    const grid = createBoundsGrid(items, { cellM: 10 });
    const found = grid.candidatesInBox(0, 0, 100, 100).map(m => m.id).sort();
    assert.deepEqual(found, ['a', 'b', 'c']);
    // 'a' spans several cells of a 10 m grid at this size; it must appear once.
    const wide = createBoundsGrid([box('wide', 0, 0, 35, 35)], { cellM: 10 });
    assert.equal(wide.candidatesInBox(0, 0, 35, 35).length, 1);
});

test('reversed box corners are accepted', () => {
    const grid = createBoundsGrid([box('a', 10, 10, 20, 20)], { cellM: 10 });
    assert.equal(grid.candidatesInBox(30, 30, 5, 5).map(m => m.id).join(''), 'a');
});

test('an item too large to stamp is still always a candidate', () => {
    // A citywide polygon would otherwise be written into thousands of cells,
    // making the index cost more than the scan — and if it were simply dropped
    // the answers would go silently wrong.
    const items = [box('huge', -100000, -100000, 100000, 100000), box('small', 0, 0, 1, 1)];
    const grid = createBoundsGrid(items, { cellM: 10 });
    assert.equal(grid.stats().oversized, 1);
    assert.ok(grid.candidatesAt(50000, 50000).some(m => m.id === 'huge'));
    assert.ok(grid.candidatesAt(0.5, 0.5).some(m => m.id === 'huge'));
    assert.ok(grid.candidatesAt(0.5, 0.5).some(m => m.id === 'small'));
});

test('an item with unusable bounds is never silently dropped', () => {
    const items = [{ id: 'nobounds' }, { id: 'nan', bounds: { minX: NaN, minZ: 0, maxX: 1, maxZ: 1 } }];
    const grid = createBoundsGrid(items);
    assert.equal(grid.stats().oversized, 2);
    assert.equal(grid.candidatesAt(999, 999).length, 2);
});

test('an empty grid answers nothing rather than throwing', () => {
    const grid = createBoundsGrid([]);
    assert.deepEqual(grid.candidatesAt(0, 0), []);
    assert.deepEqual(grid.candidatesInBox(0, 0, 10, 10), []);
    assert.deepEqual(createBoundsGrid(null).candidatesAt(0, 0), []);
});

test('the returned array is scratch, and candidatesCopy is the way out', () => {
    // Documented, and pinned: a caller that holds a result across another query
    // reads the second answer thinking it is the first, silently. Better to have
    // the contract fail a test than to have it fail a build at 3am.
    const grid = createBoundsGrid([box('a', 0, 0, 1, 1), box('b', 100, 100, 101, 101)]);
    const first = grid.candidatesAt(0.5, 0.5);
    assert.deepEqual(first.map(m => m.id), ['a']);
    grid.candidatesAt(100.5, 100.5);
    assert.deepEqual(first.map(m => m.id), ['b'], 'held result is clobbered — hence candidatesCopy');

    const kept = grid.candidatesCopy(0.5, 0.5);
    grid.candidatesAt(100.5, 100.5);
    assert.deepEqual(kept.map(m => m.id), ['a'], 'a copy survives the next query');
});

test('the mutable grid replaces and removes streamed objects without stale hits', () => {
    const grid = createMutableBoundsGrid({ cellM: 10 });
    grid.set('a', box('a', 0, 0, 4, 4));
    grid.set('b', box('b', 20, 20, 24, 24));
    assert.deepEqual(grid.candidatesAt(2, 2).map(item => item.id), ['a']);

    grid.set('a', box('a-moved', 30, 30, 34, 34));
    assert.deepEqual(grid.candidatesAt(2, 2), []);
    assert.deepEqual(grid.candidatesAt(32, 32).map(item => item.id), ['a-moved']);
    assert.equal(grid.delete('a'), true);
    assert.equal(grid.delete('a'), false);
    assert.deepEqual(grid.candidatesAt(32, 32), []);
    assert.deepEqual(grid.stats(), { items: 1, cells: 1, oversized: 0 });
});

test('the mutable grid supports direct bounds and keeps oversized objects queryable', () => {
    const grid = createMutableBoundsGrid({
        cellM: 10,
        boundsOf: item => item,
    });
    const huge = { id: 'huge', minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 };
    const local = { id: 'local', minX: -2, minZ: -2, maxX: 2, maxZ: 2 };
    grid.set(huge.id, huge);
    grid.set(local.id, local);
    assert.equal(grid.stats().oversized, 1);
    assert.deepEqual(
        grid.candidatesInBox(-3, -3, 3, 3).map(item => item.id).sort(),
        ['huge', 'local'],
    );
    grid.clear();
    assert.deepEqual(grid.stats(), { items: 0, cells: 0, oversized: 0 });
});
