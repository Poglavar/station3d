// Live UVs stay immutable while completely unowned pages can be recycled.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createFacadeAtlasLayout,
    remapFacadeAtlasUvs,
} from '../core/facade-atlas-layout.js';

test('facade atlas allocations are cached, bounded, and deterministic', () => {
    const first = createFacadeAtlasLayout({ pageSize: 64, padding: 2, maxEntrySize: 20 });
    const second = createFacadeAtlasLayout({ pageSize: 64, padding: 2, maxEntrySize: 20 });
    const inputs = [
        ['wide', 80, 20],
        ['tall', 10, 50],
        ['small', 8, 8],
        ['next', 30, 30],
    ];
    const a = inputs.map(args => first.allocate(...args));
    const b = inputs.map(args => second.allocate(...args));
    assert.deepEqual(a, b);
    assert.strictEqual(first.allocate('wide', 999, 999), a[0], 'a key keeps its first slot');
    for (const slot of a) {
        assert.ok(slot.x >= slot.padding);
        assert.ok(slot.y >= slot.padding);
        assert.ok(slot.x + slot.width + slot.padding <= slot.pageSize);
        assert.ok(slot.y + slot.height + slot.padding <= slot.pageSize);
        assert.ok(slot.width <= 20 && slot.height <= 20);
    }
});

test('facade atlas opens another page instead of overlapping shelves', () => {
    const layout = createFacadeAtlasLayout({ pageSize: 16, padding: 1, maxEntrySize: 6 });
    const slots = Array.from({ length: 9 }, (_, index) => layout.allocate(index, 6, 6));
    assert.equal(layout.stats().pages, 3);
    const occupied = new Set();
    for (const slot of slots) {
        for (let y = slot.y - 1; y < slot.y + slot.height + 1; y++) {
            for (let x = slot.x - 1; x < slot.x + slot.width + 1; x++) {
                const pixel = `${slot.pageIndex}:${x}:${y}`;
                assert.ok(!occupied.has(pixel), `overlapping atlas pixel ${pixel}`);
                occupied.add(pixel);
            }
        }
    }
});

test('UV remapping preserves corners and CanvasTexture vertical orientation', () => {
    const slot = {
        pageSize: 100,
        x: 20,
        y: 30,
        width: 40,
        height: 10,
    };
    const result = remapFacadeAtlasUvs(
        new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
        slot,
    );
    assert.deepEqual(
        Array.from(result, value => +value.toFixed(6)),
        [0.2, 0.6, 0.6, 0.6, 0.2, 0.7, 0.6, 0.7],
    );
});

test('malformed UV arrays fail explicitly', () => {
    assert.throws(
        () => remapFacadeAtlasUvs([0, 1, 2], { pageSize: 64 }),
        /complete pairs/,
    );
});

test('retiring one page forgets only its entries and preserves every live UV', () => {
    const layout = createFacadeAtlasLayout({ pageSize: 16, padding: 1, maxEntrySize: 14 });
    const retired = layout.allocate('old', 14, 14);
    const live = layout.allocate('live', 14, 14);
    const uvs = remapFacadeAtlasUvs(new Float32Array([0, 0, 1, 1]), live);
    assert.equal(layout.releasePage(retired.pageIndex), 1);
    assert.equal(layout.get('old'), null);
    assert.equal(layout.get('live'), live);
    assert.deepEqual(remapFacadeAtlasUvs(new Float32Array([0, 0, 1, 1]), live), uvs);
    const next = layout.allocate('next', 14, 14);
    assert.equal(next.pageIndex, retired.pageIndex);
    assert.equal(layout.get('live'), live);
    assert.equal(layout.stats().pages, 2);
    assert.equal(layout.stats().pageSlots, 2);
});

test('repeated page churn cannot grow the layout behind a still-live neighbour', () => {
    const layout = createFacadeAtlasLayout({ pageSize: 16, padding: 1, maxEntrySize: 14 });
    const pinned = layout.allocate('pinned', 14, 14);
    for (let visit = 0; visit < 100; visit++) {
        const slot = layout.allocate(`visit-${visit}`, 14, 14);
        assert.equal(slot.pageIndex, 1);
        assert.equal(layout.releasePage(1), 1);
        assert.equal(layout.releasePage(1), 0, 'repeated retirement is harmless');
        assert.equal(layout.get(`visit-${visit}`), null);
        assert.equal(layout.get('pinned'), pinned);
        assert.equal(layout.stats().entries, 1);
        assert.equal(layout.stats().pages, 1);
        assert.equal(layout.stats().pageSlots, 2);
    }
    assert.throws(() => layout.releasePage(-1), /Invalid atlas page/);
});

test('occupancy separates content, gutters and shelf holes and retires exactly one page', () => {
    const layout = createFacadeAtlasLayout({ pageSize: 16, padding: 1, maxEntrySize: 14 });
    layout.allocate('tall', 2, 6);
    layout.allocate('wide', 8, 2);
    layout.allocate('small', 2, 2);
    const first = layout.pageStats(0);
    assert.equal(first.entries, 3);
    assert.equal(first.capacityTexels, 256);
    assert.equal(first.allocatedContentTexels, 32);
    assert.equal(first.reservedTexels, 88);
    assert.equal(first.gutterTexels, 56);
    assert.equal(first.unallocatedTexels, 168);
    assert.equal(first.shelfWasteTexels, 40);
    layout.allocate('wide', 999, 999);
    assert.deepEqual(layout.pageStats(0), first, 'a hit must not count its rectangle twice');
    const live = layout.allocate('full-page', 14, 14);
    assert.equal(live.pageIndex, 1);
    const stats = layout.stats({ includePages: true });
    assert.equal(stats.pages, 2);
    assert.equal(stats.allocatedContentTexels, 228);
    assert.equal(stats.reservedTexels, 344);
    assert.equal(stats.unallocatedTexels, 168);
    assert.equal(stats.sourceTexels, 228);
    assert.equal(stats.pageDetails.length, 2);
    layout.releasePage(0);
    assert.equal(layout.pageStats(0), null);
    assert.equal(layout.stats().allocatedContentTexels, 196);
    assert.equal(layout.stats().reservedTexels, 256);
    assert.equal(layout.stats().shelfWasteTexels, 0);
    layout.releasePage(1);
    assert.equal(layout.stats().capacityTexels, 0);
    assert.equal(layout.stats().contentFillRatio, 0);
    assert.equal(layout.stats().sourceTexels, 0);
    assert.equal(layout.allocate('revisit', 2, 2).pageIndex, 0);
    assert.equal(layout.stats().reservedTexels, 16, 'recycled page counters start empty');
});
