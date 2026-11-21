import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareGroundConsumerSteps } from '../core/ground-consumer-preparation.js';
import { prepareTerrainCutoutTilesSteps } from '../core/terrain-cutout-tiles.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import {
    buildFormationTerrainCutoutQuerySteps,
    replaceTerrainCutoutLayerSources,
} from '../core/formation-terrain-cutout-query.js';

const source = readFileSync(new URL('../world/ground-generations.js', import.meta.url), 'utf8');
const extracted = source.slice(source.indexOf('export function* prepareWorldGroundGenerationSteps'),
    source.indexOf('const PHYSICS_FAMILIES')).replaceAll('export function', 'function');
const prepare = Function('prepareGroundConsumerSteps', 'prepareTerrainCutoutTilesSteps',
    'captureProposalMaskSnapshot', 'ownReadSnapshot', 'retainReadSnapshot',
    'buildFormationTerrainCutoutQuerySteps', 'replaceTerrainCutoutLayerSources', 'fail',
    `return (()=>{${extracted}; return prepareWorldGroundGenerationSteps;})()`)(
    prepareGroundConsumerSteps, prepareTerrainCutoutTilesSteps,
    () => Object.freeze({ isCurrent: () => true }), ownReadSnapshot, retainReadSnapshot,
    buildFormationTerrainCutoutQuerySteps, replaceTerrainCutoutLayerSources,
    (code, message) => { throw Object.assign(new Error(message), { code }); });
const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };

test('the production ground coordinator does not defer loaded physical changes while moving', () => {
    assert.doesNotMatch(source, /deferNonPriority\s*:/,
        'roads, rails and curbs must remain publishable while a routed vehicle is moving');
    assert.doesNotMatch(source, /preemptForPriority:\s*true/,
        'a 400 m moving-window request cannot repeatedly cancel a longer physical road generation');
    assert.match(source, /windowFamilies\s*=\s*new Set\(\['terrain-window', 'ground-window'\]\)/,
        'the lightweight terrain and ground windows retain priority between completed generations');
    assert.match(source, /priorityFamilies:\s*\[\.\.\.windowFamilies, 'terrain', 'rails', 'roads'\]/,
        'terrain, rail and road revisions remain ahead of noncritical physical changes');
    assert.match(source,
        /onPublished:\s*\(\)\s*=>\s*\{[\s\S]*?first-ground-publication[\s\S]*?track-ready[\s\S]*?roads-ready[\s\S]*?\}/,
        'track and roads become ready at the atomic ground publication, not when their source queues drain');
});

test('moving residency recenters rail, exact openings, terrain and collision in one publication', () => {
    for (const outcome of ['publish', 'rollback', 'cancel']) {
        const registry = createSurfacePublicationRegistry(), events = [];
        const prior = Object.freeze({ revision: 1 }), next = Object.freeze({ revision: 2 });
        const active = { terrain: prior, rail: prior, collision: prior };
        const opening = Object.freeze({ bounds: { minX: 5, minZ: 5, maxX: 10, maxZ: 10 },
            ring: [{ x: 5, z: 5 }, { x: 10, z: 5 }, { x: 10, z: 10 }, { x: 5, z: 10 }] });
        const terrainCutoutLayers = Object.freeze([{ operation: 'subtract', regions: [opening] }]);
        const lease = name => {
            let references = 1;
            const handle = () => { let released = false; return { isCurrent: () => true,
                retain() { references++; return handle(); },
                release() { if (released) return false; released = true;
                    if (--references === 0) events.push(`release:${name}`); return true; } }; };
            return handle();
        };
        const movedRing = Object.freeze([
            Object.freeze({ x: 805, z: 5 }), Object.freeze({ x: 815, z: 5 }),
            Object.freeze({ x: 815, z: 15 }), Object.freeze({ x: 805, z: 15 }),
        ]);
        const railFormation = Object.freeze({
            surfaceProfilesNear: () => [{ innerRing: movedRing, formationDressingDisabled: true,
                terrainCutoutDisabled: false, terrainExcavationRegions: [{ ring: movedRing }] }],
            getReplacementTerrainCutoutRegions: () => [], getTunnelPortalTerrainOpenings: () => [],
        });
        const receiverLease = lease('receivers');
        const admission = { sources: lease('sources'),
            terrain: { ...lease('terrain'), read: Object.freeze({ revision: 7,
                evidenceSceneYAtLocal: () => 20 }), rows: [{ key: '2_0', tileX: 2, tileZ: 0 }] },
            rails: lease('rails'),
            receivers: Object.freeze({ ...receiverLease, terrain: { revision: 7 }, terrainCutoutLayers,
                railFormation, roadFormation: {}, verticalAlignments: {}, isCurrent: () => true }) };
        const ctx = { terrain: {}, roadFormation: {}, publishedTerrain: {}, getGroundPhysics: () => physics };
        const physics = { admitGroundPublicationRegion(families) {
            assert.deepEqual(families, ['terrain', 'rail-trackbed', 'rail-formation-dressings']);
            return { ...lease('physics'), *prepareSteps(reads) {
                assert.deepEqual(Object.keys(reads), ['terrain', 'rail-trackbed', 'rail-formation-dressings']);
                assert.equal(reads.terrain.terrain, next);
                assert.equal(reads.terrain.terrainSource, ctx.terrain);
                yield { phase: 'fixture-physics' };
                return { entry: { clear: true, isCurrent: () => true,
                    commit() { active.collision = next; return true; },
                    rollback() { active.collision = prior; }, discard() {} }, finalize: () => true };
            } };
        } };
        const layers = { rails: { *prepareGroundGenerationSteps({ centerX, centerZ }) {
            assert.deepEqual([centerX, centerZ], [800, 0]);
            yield { phase: 'fixture-rails' };
            return { renderedRailSurface: Object.freeze({ getTerrainSurfaceRegions: () => [] }),
                railTrackbedRead: Object.freeze({ snapshot: 'moved-trackbed' }),
                railFormationDressingRead: Object.freeze({ formation: railFormation }),
                isCurrent: () => true, discard() {}, finalize: () => true,
                entries: [{ ticket: registry.begin({ key: 'fixture-rail', generation: 1 }), clear: true,
                    isCurrent: () => true, commit() { active.rail = next; return true; },
                    rollback() { active.rail = prior; }, discard() {} }] };
        } }, terrain: { *prepareGroundGenerationSteps({ cutoutForTile }) {
            const cut = cutoutForTile(admission.terrain.rows[0]);
            assert.equal(cut.layers.some(layer => layer.regions.some(region => region.source === 'rail-formation')), true,
                'the moved rail opening is compiled into the newly exposed tile');
            yield { phase: 'fixture-terrain' };
            return { terrain: next, isCurrent: () => true, usage: { rebuiltTiles: 1 },
                entries: [{ ticket: registry.begin({ key: 'fixture-terrain', generation: 1 }), clear: true,
                    isCurrent: () => true, commit() { active.terrain = next; return true; },
                    rollback() { active.terrain = prior; }, discard() {} }],
                finalize: () => true, discard() {} };
        } } };
        const steps = prepare({ ctx, layers, admission,
            scope: { terrainWindowOnly: true, centerX: 800, centerZ: 0 },
            limits: GROUND_GENERATION_LIMITS, registry, generation: 1, isCurrent: () => true });
        const candidate = drain(steps);
        assert.equal(candidate.usage.reusedReceivers, true);
        assert.deepEqual(active, { terrain: prior, rail: prior, collision: prior });
        if (outcome === 'cancel') candidate.discard();
        else {
            const batch = registry.prepareBatch(candidate.entries, outcome === 'rollback' ? {
                commit() { throw new Error('injected later publication failure'); },
            } : {});
            if (outcome === 'rollback') assert.throws(() => batch.publish(), /injected later publication failure/);
            else {
                assert.equal(batch.publish().status, 'published');
                assert.equal(candidate.finalize(), true);
            }
        }
        const expected = outcome === 'publish' ? next : prior;
        assert.deepEqual(active, { terrain: expected, rail: expected, collision: expected });
        assert.deepEqual(events.sort(), ['release:physics', 'release:rails', 'release:receivers', 'release:sources', 'release:terrain']);
        registry.close();
    }
});
