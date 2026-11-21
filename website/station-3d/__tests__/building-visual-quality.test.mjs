// Exercise real building reset, atlas allocation and close-detail orchestration;
// only renderer/world I/O is stubbed so quality cannot silently become metadata-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { STATION3D_QUALITY_PROFILES } from '../core/quality-profile.js';
import { createFacadeAtlasLayout, remapFacadeAtlasUvs } from '../core/facade-atlas-layout.js';
import { selectCloseFacadeRecords } from '../core/facade-close-lod.js';

const source = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');
function world() {
    let requested = 'high';
    const events = [], records = new Map(Array.from({ length: 12 }, (_, i) => [String(i), {
        bounds: { minX: i, maxX: i + 1, minZ: 0, maxZ: 1 },
    }]));
    const noop = () => {};
    const context = vm.createContext({
        STATION3D_QUALITY_PROFILES, buildingQualityProfile: STATION3D_QUALITY_PROFILES.high,
        getRenderQualityContext: () => { events.push('capture'); return { profileId: requested }; },
        cancelStaticBuildJob: noop, cancelAllTileBuildJobs: noop, clearTileVisualReplacements: noop,
        resetOvertureAggregateState() { events.push('retire'); context.facadeAtlasGroups.clear(); },
        clearRoofActivitySurfaces: noop, buildingsGroup: { children: [] },
        terrainBuildingRebuildCheck: null,
        buildingGroundDependencies: { clear: noop },
        buildingEntranceIndex: new Map(), buildingFootprintIndex: new Map(),
        statedBuildingCollisions: new Map(), statedBuildingCollisionIndex: new Map(),
        resetBuildingBuildPhaseStats: noop, resetDetailed: noop,
        createFacadeAtlasLayout, remapFacadeAtlasUvs, facadeAtlasFamily: () => 'punched',
        facadeAtlasGroups: new Map(), FACADE_ATLAS_PAGE_SIZE: 512, FACADE_ATLAS_PADDING: 2,
        createFacadeAtlasPage(group, _base, _region, _family, index) {
            return group.pages[index] = { material: {} };
        },
        queueFacadeAtlasPaint: noop, facadeAtlasStats: { entries: 0, sourcePixels: 0, atlasEntryPixels: 0 },
        performance, buildingNowMs: () => 0, recordLayerFrameMs: noop,
        CLOSE_FACADE_UPDATE_INTERVAL_MS: 250, CLOSE_FACADE_UPDATE_MOVE_M: 2,
        CLOSE_FACADE_MAX_CREATES_PER_UPDATE: 1,
        closeFacadeLastUpdateMs: -Infinity, closeFacadeLastX: Infinity, closeFacadeLastZ: Infinity,
        closeFacadeDetails: new Map(),
        overlayOwnersByKey: { has: key => records.has(key),
            select: (active, x, z, options) => selectCloseFacadeRecords(records, active, x, z, options) },
        removeCloseFacadeDetail: key => context.closeFacadeDetails.delete(key),
        addCloseFacadeDetail(key) { context.closeFacadeDetails.set(key, {}); return true; },
    });
    for (const name of ['clearBuildings', 'facadeAtlasPart', 'updateCloseFacadeDetails']) {
        const start = source.indexOf(`function ${name}(`);
        assert.ok(start >= 0, `Missing production function ${name}`);
        vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
    }
    function allocate(region) {
        const base = { map: { uuid: 'same-pixels', image: { width: 1024, height: 512 } }, userData: {} };
        const original = new Float32Array([0, 0, 1, 1]);
        context.facadeAtlasPart({}, base, region, original);
        assert.deepEqual([...original], [0, 0, 1, 1], 'source/repair UVs remain exact');
        return context.facadeAtlasGroups.get(`${region}|punched`).layout.get('same-pixels');
    }
    return { context, events, allocate, setQuality(id) { requested = id; } };
}

test('world reset captures the next quality only after retiring old atlases', () => {
    const w = world();
    assert.equal(w.allocate('first').width, 192);
    w.setQuality('medium');
    assert.equal(w.allocate('still-live').width, 192, 'live renderer changes do not mix atlas budgets');
    w.context.clearBuildings();
    assert.deepEqual(w.events, ['retire', 'capture']);
    const medium = w.allocate('next-world');
    assert.equal(medium.width, 128);
    assert.equal(medium.height, 64);
    assert.equal(medium.pageSize, 512);
    w.setQuality('low');
    w.context.clearBuildings();
    assert.equal(w.allocate('low-world').width, 96);
});

test('real close-detail updates enforce 8/3/0 owners and remove old enhancements', () => {
    const w = world();
    for (const [id, expected] of [['high', 8], ['medium', 3], ['low', 0]]) {
        w.setQuality(id);
        w.context.clearBuildings();
        for (let i = 0; i < 12; i++) w.context.updateCloseFacadeDetails(0, 0, true);
        assert.equal(w.context.closeFacadeDetails.size, expected);
    }
});
