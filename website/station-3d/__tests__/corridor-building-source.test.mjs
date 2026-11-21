// The tower blocklist (part_index) and the ≥35 m curtain-wall rule both speak
// GDI identity — GDI object_ids, GDI eave heights, the GDI build path. A
// location that can show a modelled Zagreb tower must therefore stream
// buildings from the GDI-keyed endpoint, and /buildings-3d?fill=overture
// resolves coverage PER TILE, so corridors that leave the survey lose nothing.
//
// zagreb-split was configured 'overture' for its whole 52 km: every building —
// including the city end — arrived UUID-keyed, the spec could suppress nothing
// (modelled towers wore their massing on top), and no high-rise ever met the
// curtain-wall rule. One config word, both symptoms.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LOCATIONS, buildingTileSourceForLocation, farBuildingTileSourceForLocation,
} from '../core/locations.js';

const source = (id) => buildingTileSourceForLocation(LOCATIONS[id]);
const farSource = (id) => farBuildingTileSourceForLocation(LOCATIONS[id]);

test('locations with a modelled landmark stream MESHES with per-tile fill', () => {
    // Zagreb moved to the source-agnostic endpoint: /buildings-mesh unions the
    // GDI survey AND the hand-modelled landmarks, and withholds the survey
    // massing a landmark covers, so the client no longer needs a part-index
    // blocklist to keep a grey slab from poking through the glass.
    assert.equal(source('zagreb').endpoint, 'buildings-mesh');

    // The corridors still stream GDI directly — they are not landmark cities,
    // and the tower blocklist and >=35 m curtain-wall rule still speak GDI
    // identity there.
    for (const id of ['zagreb-split', 'zagreb-sisak', 'nizinska-pruga']) {
        const s = source(id);
        assert.equal(s.endpoint, 'buildings-3d', `${id} must use the GDI-keyed endpoint`);
    }

    // Every mesh-serving endpoint resolves coverage per tile; without the fill,
    // tiles past the survey edge come back empty.
    for (const id of ['zagreb', 'zagreb-split', 'zagreb-sisak', 'nizinska-pruga']) {
        assert.equal(source(id).querySuffix, '&fill=overture', id);
    }
});

test('regions without GDI never probe the GDI-keyed endpoint', () => {
    // No GDI coverage and no modelled towers: probing empty GDI tiles for the
    // whole session would buy nothing. This is the invariant — which endpoint
    // they DO use is a separate question, answered below.
    for (const id of ['split', 'sjeverna-dalmacija']) {
        assert.notEqual(source(id).endpoint, 'buildings-3d', id);
    }
    // The fill suffix belongs to the MESH-serving endpoints, which resolve
    // ragged survey coverage per tile. Split now streams meshes (its own LiDAR
    // reconstruction, not GDI) so it wants the fill; sjeverna-dalmacija is
    // footprints-only and must not ask for it.
    assert.equal(source('split').querySuffix, '&fill=overture');
    assert.equal(source('sjeverna-dalmacija').querySuffix, '');
});

test('Trogir-Split streams resolved heights; regions without LiDAR stay on Overture', () => {
    // Split sits inside the 2023 DGU LiDAR delivery, so /buildings-render can
    // serve a measured height for 59,989 of its 98,268 buildings — and a LoD2
    // mesh where one has been reconstructed. /buildings-overture had a height
    // for 42 of them and the client invented the rest.
    // Split's DETAILED layer now streams real LOD2 meshes from the
    // source-agnostic endpoint: the server unions every survey covering the
    // bbox (here 64,760 DGU-LiDAR reconstructions) and labels each feature by
    // geometry KIND, so the builder never learns which survey produced it.
    assert.equal(source('split').endpoint, 'buildings-mesh');

    // sjeverna-dalmacija has no LiDAR delivery, so building_render would hold
    // nothing but the same Overture footprints with no heights. Pointing it at
    // the resolver would add a table lookup and buy nothing; it moves when a
    // delivery covers it.
    assert.equal(source('sjeverna-dalmacija').endpoint, 'buildings-overture');
});

test('the far ring streams the same heights as the detailed layer', () => {
    // A building must not grow or shrink at the ~300 m hand-off, so the horizon
    // ring has to read from whatever the detailed layer reads from.
    assert.equal(farSource('split').endpoint, 'buildings-render');
    // No fill=overture — the resolver unioned the surveys before the row existed.
    //
    // The limit must MATCH the ring's own FAR_MAX_PER_TILE, not exceed it: the
    // server returns them ordered by height, so its top 600 is the top 600.
    // Asking for 1200 measured 700 KB per 800 m Split tile against the lod1
    // path's 317 KB, to buy a re-ordering of buildings the ring discards — and
    // that is what made the horizon visibly slow to fill in.
    assert.equal(farSource('split').querySuffix, '&limit=600&simplify=1');
    assert.ok(!farSource('split').querySuffix.includes('fill=overture'));
    // simplify is explicit because the endpoint cannot infer it: the DETAILED
    // ring requests boxes the same ~800 m size, so a bbox heuristic hands the
    // horizon 0.5 m vertices it cannot resolve at 800-1600 m.
    assert.match(farSource('split').querySuffix, /simplify=1/);

    // Everywhere else keeps the GDI-backed coarse endpoint with its per-tile fill.
    for (const id of ['zagreb', 'zagreb-split', 'sjeverna-dalmacija']) {
        assert.equal(farSource(id).endpoint, 'buildings-lod1', id);
        assert.equal(farSource(id).querySuffix, '&fill=overture', id);
    }

    // Distinct cache keys, or SharedTileSession would serve one region's tiles
    // to another.
    assert.notEqual(farSource('split').key, farSource('zagreb').key);
});
