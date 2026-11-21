// `ACTIVE_LOCATION` — an import-time snapshot of the session location — was
// retired when `loc` stopped being the world authority (MEMORY.md 2026-08-13).
// Architecture is now resolved LIVE per build through architecturalLocationId(),
// so a country/corridor session (`croatia`, `zagreb-split`) presents as its
// nearest prepared city and newly streamed tiles are not stuck on whichever
// architecture happened to be active at import.
//
// This is a merge guard, not decoration: main still carries the old binding, so
// a clean textual merge can reintroduce `ACTIVE_LOCATION.id` into a file that no
// longer defines it — a ReferenceError on every facade resolve that `node
// --check` and the rest of this suite cannot see (buildings.js needs THREE, so
// nothing imports it here). That exact case reached the branch on 2026-08-15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;

function sourceFiles(dir, found = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '__tests__') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) sourceFiles(full, found);
        else if (entry.endsWith('.js')) found.push(full);
    }
    return found;
}

test('no station-3d source references the retired ACTIVE_LOCATION binding', () => {
    const offenders = sourceFiles(ROOT).filter((file) => {
        const source = readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        return /\bACTIVE_LOCATION\b/.test(source);
    }).map((file) => file.slice(ROOT.length));
    assert.deepEqual(
        offenders,
        [],
        'use architecturalLocationId() (world/buildings.js) instead of ACTIVE_LOCATION',
    );
});

test('the live architecture resolver is what feeds new-build window styles', () => {
    const source = readFileSync(join(ROOT, 'world/buildings.js'), 'utf8');
    let city = 'zagreb';
    const styles = { zagreb: ['Z0', 'Z1'], split: ['S0', 'S1', 'S2'] };
    const context = vm.createContext({
        getLocation: () => ({ id: 'croatia', styleCityId: city }), LOCATIONS: { zagreb: {}, split: {} },
        NEW_BUILD_WINDOW_STYLE_BASE: 100, newBuildWindowStyles: id => styles[id],
        FACADE_WINDOW_STYLES: ['ordinary'], FACADE_GLASS_STYLES: ['glass'],
        resolveFacadeWindowStyle: (id, base) => id + ':' + base,
        isProposalBuildingObjectId: () => true, hashObjectId: () => 5, JITTER_BUCKETS: 64,
    });
    for (const name of ['architecturalLocationId', 'getFacadeWindowStyle', 'getFacadeStyleIndex', 'facadeOverlayDescriptor']) {
        const start = source.indexOf(`function ${name}(`);
        assert.ok(start >= 0, `Missing production function ${name}`);
        vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
    }
    const old = context.facadeOverlayDescriptor('proposal', 4, 6);
    assert.equal(old.styleIdx, 101);
    assert.equal(context.getFacadeWindowStyle(old.styleIdx), 'Z1');
    assert.equal(context.getFacadeWindowStyle(0), 'zagreb:ordinary');
    city = 'split';
    const fresh = context.facadeOverlayDescriptor('proposal', 4, 6);
    assert.equal(fresh.styleIdx, 102, 'new construction follows the live regional style set');
    assert.equal(context.getFacadeWindowStyle(fresh.styleIdx), 'S2');
    assert.equal(context.getFacadeWindowStyle(0), 'split:ordinary');
    assert.notEqual(fresh.key, old.key);
    assert.equal(context.getFacadeWindowStyle(old.styleIdx, old.architectureId), 'Z1',
        'an in-flight old-region source must not paint new-region pixels under its old cache key');
});
