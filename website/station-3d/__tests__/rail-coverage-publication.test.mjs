// Exercise the actual rail coverage adapter with independent old/new heights,
// active openings and a viaduct slab, including complete rollback of revisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { SURFACE_COVERAGE_STATE } from '../core/surface-hierarchy.js';
import { buildRenderedRailSurfaceRegions, createRenderedRailSurfaceMaskModelFromRegions,
    createRenderedRailSurfaceMaskModelFromRegionsSteps, buildViaductTerrainCutoutRegionsSteps,
    activateRenderedRailTerrainCutoutRegions, activateViaductTerrainCutoutRegions,
    renderedRailTerrainCutoutRegionsSignatureSteps } from '../core/rendered-rail-surface.js';
const source = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function* prepareRenderedRailSurfaceCoverageSteps('), source.indexOf('function railCellPublicationKey('));
const regions = (y, x = 0, railway = 'tram') => buildRenderedRailSurfaceRegions([{
    x1: x, z1: 0, x2: x + 10, z2: 0, yStart: y, yEnd: y, startJoinX: 0, startJoinZ: -1,
    endJoinX: 0, endJoinZ: -1, startTrackbedHalfWidthM: 2, endTrackbedHalfWidthM: 2,
    startTrackbedInnerEdgeM: .6, endTrackbedInnerEdgeM: .6, properties: { railway },
}], { coverageState: SURFACE_COVERAGE_STATE.PUBLISHED });
function fixture() {
    const old = createRenderedRailSurfaceMaskModelFromRegions(regions(1), { revision: 10 });
    const c = vm.createContext({ renderedRailSurfaceRevision: 10, renderedRailTerrainCutoutRevision: 3,
        renderedRailTerrainCutoutPublishedSignature: 'old-terrain', viaductTerrainCutoutRevision: 4,
        viaductTerrainCutoutPublishedSignature: 'old-viaduct', viaductTerrainCutoutCache: null,
        railSessionToken: 1, lastRailFormation: { getViaductRuns() { throw new Error('live rail query'); } },
        lastTerrain: { revision: 500, renderedRailSurface: old,
            evidenceSceneYAtLocal() { throw new Error('live terrain query'); },
            setRenderedRailSurface(value) { this.renderedRailSurface = value; } },
        TRACKBED_Y: .02, SURFACE_COVERAGE_STATE, activateRenderedRailTerrainCutoutRegions,
        activateViaductTerrainCutoutRegions, buildViaductTerrainCutoutRegionsSteps,
        renderedRailTerrainCutoutRegionsSignatureSteps, createRenderedRailSurfaceMaskModelFromRegionsSteps,
    });
    vm.runInContext(code, c);
    const runs = [{ samples: [{ x: 60, z: 0, railY: 6, station: 0 }, { x: 70, z: 0, railY: 6, station: 10 }],
        alignment: { halfWidthM: 2 } }];
    const ground = { terrain: Object.freeze({ revision: 9, evidenceSceneYAtLocal: () => 10 }),
        railFormation: Object.freeze({ getViaductRuns: () => runs }) };
    const cells = new Map([['ordinary', regions(2)], ['heavy', regions(4, 30, 'rail')]]);
    let ticks = 0;
    const prepare = () => c.prepareRenderedRailSurfaceCoverageSteps(cells, { ground, now: () => ticks++ });
    function drain(steps) {
        let next, count = 0;
        do {
            next = steps.next(); if (!next.done) count++;
            assert.equal(c.lastTerrain.renderedRailSurface, old);
            assert.equal(c.renderedRailSurfaceRevision, 10);
            assert.equal(c.renderedRailTerrainCutoutRevision, 3); assert.equal(c.viaductTerrainCutoutRevision, 4);
            assert.equal(c.viaductTerrainCutoutCache, null);
        } while (!next.done);
        assert.ok(count > 20, 'coordinate/index/activation work yields before publication');
        return next.value;
    }
    return { c, old, ground, cells, prepare, drain };
}

test('rail coverage prepares from explicit ground and restores every index/revision after a later failure', () => {
    const f = fixture(), c = f.c, registry = createSurfacePublicationRegistry(), candidate = f.drain(f.prepare());
    assert.equal(candidate.read.civilGroundSurfaceAtLocal(5, 1).sceneY, 2);
    assert.equal(candidate.read.terrainCutoutAtLocal(35, 1).sceneY, 4);
    assert.ok(Math.abs(candidate.read.viaductTerrainCutoutAtLocal(65, 3).sceneY - 6.005) < 1e-9);
    assert.equal(candidate.read.civilGroundSurfaceAtLocal(65, 1), null, 'the slab cannot claim same-level road paint');
    assert.equal(candidate.finalize(), false);
    const batch = registry.prepareBatch([{ ...candidate.entry,
        ticket: registry.begin({ key: 'rail:coverage', generation: 1 }) }], { commit() {
        assert.equal(c.lastTerrain.renderedRailSurface, candidate.read); throw new Error('physics member failed');
    } });
    assert.throws(() => batch.publish(), /physics member failed/);
    assert.equal(c.lastTerrain.renderedRailSurface, f.old); assert.equal(c.renderedRailSurfaceRevision, 10);
    assert.equal(c.renderedRailTerrainCutoutRevision, 3); assert.equal(c.viaductTerrainCutoutRevision, 4);
    assert.equal(c.renderedRailTerrainCutoutPublishedSignature, 'old-terrain');
    assert.equal(c.viaductTerrainCutoutPublishedSignature, 'old-viaduct'); assert.equal(c.viaductTerrainCutoutCache, null);
    assert.equal(candidate.finalize(), false); assert.equal(f.old.civilGroundSurfaceAtLocal(5, 1).sceneY, 1);
    registry.close();
});

test('rail coverage commits all prepared footprint families and revision acknowledgements together', () => {
    const f = fixture(), c = f.c, registry = createSurfacePublicationRegistry(), candidate = f.drain(f.prepare());
    assert.equal(registry.prepareBatch([{ ...candidate.entry,
        ticket: registry.begin({ key: 'rail:coverage', generation: 1 }) }]).publish().status, 'published');
    assert.equal(candidate.finalize(), true); assert.equal(candidate.finalize(), false);
    assert.equal(c.lastTerrain.renderedRailSurface, candidate.read); assert.equal(c.renderedRailSurfaceRevision, 11);
    assert.equal(c.renderedRailTerrainCutoutRevision, 4); assert.equal(c.viaductTerrainCutoutRevision, 5);
    assert.equal(c.viaductTerrainCutoutCache.revision, 5);
    assert.equal(c.lastTerrain.renderedRailSurface.civilGroundSurfaceAtLocal(5, 1).sceneY, 2);
    assert.equal(c.lastTerrain.renderedRailSurface.terrainCutoutAtLocal(35, 1).sceneY, 4);
    registry.close();
});

test('a superseding coverage publication cancels unfinished preparation without touching the active model', () => {
    const f = fixture(), steps = f.prepare(); assert.equal(steps.next().done, false);
    f.c.renderedRailSurfaceRevision++;
    assert.equal(steps.next().value, null); assert.equal(f.c.lastTerrain.renderedRailSurface, f.old);
    assert.equal(f.c.renderedRailTerrainCutoutRevision, 3); assert.equal(f.c.viaductTerrainCutoutCache, null);
});
