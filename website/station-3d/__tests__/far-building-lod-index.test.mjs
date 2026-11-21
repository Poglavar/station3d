import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFarBuildingLodIndex } from '../core/far-building-lod-index.js';

function fixture() {
    const detailed = new Set(), tiles = new Set(), refs = [];
    const index = createFarBuildingLodIndex({ isDetailed: id => detailed.has(id), isDetailedTile: key => tiles.has(key) });
    function ref(objectId = '62849', nearKey = '5_0') {
        const state = { visible: true, writes: 0 };
        const value = { objectId, nearKey, instanceId: 0, state,
            batch: { setVisibleAt(id, visible) { assert.equal(id, 0); state.visible = visible; state.writes++; } } };
        refs.push(value); return value;
    }
    return { index, detailed, tiles, ref, refs };
}

test('detail publication hides and restores every neighboring far copy', () => {
    const f = fixture(), a = f.ref(), b = f.ref();
    f.index.register(a); f.index.register(b);
    f.detailed.add('62849'); f.index.syncObject('62849');
    assert.deepEqual(f.refs.map(r => r.state.visible), [false, false]);
    f.detailed.clear(); f.index.syncObject('62849');
    assert.deepEqual(f.refs.map(r => r.state.visible), [true, true]);
});

test('retiring either neighbor or predecessor preserves all remaining refs', () => {
    for (const retiredIndex of [0, 1, 2]) {
        const f = fixture();
        for (let i = 0; i < 3; i++) f.index.register(f.ref());
        const retired = f.refs[retiredIndex], writes = retired.state.writes;
        f.index.unregister(retired); f.index.unregister(retired);
        f.detailed.add('62849'); f.index.syncObject('62849');
        assert.equal(retired.state.writes, writes);
        assert.ok(f.refs.filter(r => r !== retired).every(r => !r.state.visible));
        f.detailed.clear(); f.index.syncObject('62849');
        assert.ok(f.refs.filter(r => r !== retired).every(r => r.state.visible));
    }
});

test('registration refreshes staged visibility and is idempotent', () => {
    const f = fixture(), r = f.ref();
    f.detailed.add(r.objectId);
    f.index.register(r); f.index.register(r);
    assert.equal(r.state.visible, false);
    const writes = r.state.writes;
    f.index.syncObject(r.objectId);
    assert.equal(r.state.writes, writes + 1);
});

test('detailed tile and object ownership both suppress all copies', () => {
    const f = fixture(), a = f.ref(), b = f.ref(), c = f.ref('different');
    for (const r of f.refs) f.index.register(r);
    f.tiles.add(a.nearKey); f.index.syncTile(a.nearKey);
    assert.ok(f.refs.every(r => !r.state.visible));
    f.detailed.add(a.objectId);
    f.tiles.clear(); f.index.syncTile(a.nearKey);
    assert.deepEqual([a, b, c].map(r => r.state.visible), [false, false, true]);
    f.detailed.clear(); f.index.syncObject(a.objectId);
    assert.ok(f.refs.every(r => r.state.visible));
});

test('unregister and session clear release both reverse indexes', () => {
    const f = fixture(), a = f.ref(), b = f.ref(null, null);
    f.index.register(a); f.index.register(b);
    f.index.unregister(a); f.index.clear();
    const writes = f.refs.map(r => r.state.writes);
    f.index.syncObject(a.objectId); f.index.syncTile(a.nearKey);
    f.index.syncObject(null); f.index.syncTile(null);
    assert.deepEqual(f.refs.map(r => r.state.writes), writes);
});

test('the shared live layer uses the multi-copy index for publication and retirement', () => {
    const source = readFileSync(new URL('../world/buildings-far.js', import.meta.url), 'utf8');
    for (const call of ['register(ref)', 'unregister(ref)', 'syncObject(objectId)', 'syncTile(tileKey)', 'clear()']) {
        assert.ok(source.includes(`farLodIndex.${call}`));
    }
    assert.ok(source.includes('return farLodIndex.visible(ref)'));
    assert.doesNotMatch(source, /instanceByObjectId/);
});
