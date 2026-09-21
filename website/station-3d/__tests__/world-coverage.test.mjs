// The rule that separates "nothing is here" from "nothing was prepared here".
// The case that matters most is the negative one: open karst inside a served
// area must stay silent, or the warning becomes noise and gets ignored on the
// day it is telling the truth.

import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWorldCoverage } from '../core/world-coverage.js';

const PROD_LIKE = {
    overtureBuildings: { zagreb: 373790, split: 53537 },
    gdiBuildings: 512000,
    demTiles: 1439,
};
const LOCAL_LIKE = {
    overtureBuildings: {
        zagreb: 373790, split: 53537, 'sjeverna-dalmacija': 187545,
        'zagreb-split': 53718, 'zagreb-sisak': 15158,
    },
    gdiBuildings: 512000,
    demTiles: 5439,
};

test('a spawn outside every served area says so, whatever the server holds', () => {
    const verdict = assessWorldCoverage({
        locationId: 'zagreb-split',
        buildingSource: 'overture',
        declaresTerrain: true,
        insidePreparedArea: false,
        coverage: LOCAL_LIKE,
        terrainState: 'ok',
    });
    assert.equal(verdict.level, 'none');
    assert.equal(verdict.key, 'coverage.outside');
});

test('a location the server never ingested reports nothing prepared', () => {
    // Exactly the production state on 2026-07-27: the frontend advertises the
    // corridor, the server holds neither its buildings nor its terrain.
    const verdict = assessWorldCoverage({
        locationId: 'sjeverna-dalmacija',
        buildingSource: 'overture',
        country: 'croatia',
        declaresTerrain: true,
        insidePreparedArea: true,
        coverage: PROD_LIKE,
        terrainState: 'missing',
    });
    assert.equal(verdict.level, 'none');
    assert.equal(verdict.key, 'coverage.nothingPrepared');
    assert.equal(verdict.params.location, 'sjeverna-dalmacija');
});

test('buildings present but terrain absent is a partial warning, not a blackout', () => {
    const verdict = assessWorldCoverage({
        locationId: 'zagreb-sisak',
        buildingSource: 'overture',
        declaresTerrain: true,
        insidePreparedArea: true,
        coverage: LOCAL_LIKE,
        terrainState: 'missing',
    });
    assert.equal(verdict.level, 'warn');
    assert.equal(verdict.key, 'coverage.noTerrain');
});

test('terrain present but the location never ingested still warns on buildings', () => {
    const verdict = assessWorldCoverage({
        locationId: 'zagreb-split',
        buildingSource: 'overture',
        country: 'croatia',
        declaresTerrain: true,
        insidePreparedArea: true,
        coverage: PROD_LIKE,
        terrainState: 'ok',
    });
    assert.equal(verdict.level, 'warn');
    assert.equal(verdict.key, 'coverage.noBuildings');
});

test('empty ground inside a fully prepared location stays silent', () => {
    // 40 km of Lika between Gračac and Knin genuinely has no buildings. The
    // check must not fire here — that is why it counts the ingest rather than
    // the bbox response.
    assert.equal(assessWorldCoverage({
        locationId: 'zagreb-split',
        buildingSource: 'overture',
        declaresTerrain: true,
        insidePreparedArea: true,
        coverage: LOCAL_LIKE,
        terrainState: 'ok',
    }), null);
});

test('Zagreb is judged on its GDI count, not on an Overture city key', () => {
    assert.equal(assessWorldCoverage({
        locationId: 'zagreb',
        buildingSource: 'gdi',
        declaresTerrain: false,
        insidePreparedArea: true,
        coverage: PROD_LIKE,
        terrainState: 'unknown',
    }), null);
    const stripped = assessWorldCoverage({
        locationId: 'zagreb',
        buildingSource: 'gdi',
        declaresTerrain: false,
        insidePreparedArea: true,
        coverage: { ...PROD_LIKE, gdiBuildings: 0 },
        terrainState: 'unknown',
    });
    assert.equal(stripped.key, 'coverage.noBuildings');
});

test('an unreachable coverage endpoint never invents a warning', () => {
    // A failed probe is not evidence of missing data; the tile streams report
    // their own fetch failures and the status dot goes red for that.
    assert.equal(assessWorldCoverage({
        locationId: 'split',
        buildingSource: 'overture',
        declaresTerrain: true,
        insidePreparedArea: true,
        coverage: null,
        terrainState: 'unknown',
    }), null);
});

test('an unknown spawn position is not treated as outside', () => {
    assert.equal(assessWorldCoverage({
        locationId: 'split',
        buildingSource: 'overture',
        declaresTerrain: true,
        insidePreparedArea: null,
        coverage: LOCAL_LIKE,
        terrainState: 'ok',
    }), null);
});

// ─── Country-bucketed ingest ────────────────────────────────────────────────
// The Overture pull was widened from city-at-a-time to whole countries, so the
// server's keys became `croatia` and `belgrade`. Every Croatian location then
// looked un-ingested and wore a false "no buildings" banner while its tiles
// streamed in fine.
const COUNTRY_BUCKETED = {
    overtureBuildings: { croatia: 2889898, belgrade: 187126 },
    gdiBuildings: 357683,
    demTiles: 11001,
};

test('a country bucket answers for a city the server does not bucket', () => {
    assert.equal(assessWorldCoverage({
        locationId: 'sjeverna-dalmacija',
        buildingSource: 'overture',
        country: 'croatia',
        declaresTerrain: true,
        insidePreparedArea: true,
        coverage: COUNTRY_BUCKETED,
        terrainState: 'ok',
    }), null);
});

test('a city bucket still wins where the server keeps one', () => {
    const verdict = assessWorldCoverage({
        locationId: 'sjeverna-dalmacija',
        buildingSource: 'overture',
        country: 'croatia',
        declaresTerrain: true,
        insidePreparedArea: true,
        coverage: { ...COUNTRY_BUCKETED, overtureBuildings: { croatia: 2889898, 'sjeverna-dalmacija': 0 } },
        terrainState: 'ok',
    });
    assert.equal(verdict.key, 'coverage.noBuildings');
});

test('a country the server never ingested still reports missing buildings', () => {
    const verdict = assessWorldCoverage({
        locationId: 'belgrade-nord',
        buildingSource: 'overture',
        country: 'serbia',
        declaresTerrain: false,
        insidePreparedArea: true,
        coverage: COUNTRY_BUCKETED,
        terrainState: 'unknown',
    });
    assert.equal(verdict.key, 'coverage.noBuildings');
});

test('a location that declares no country never invents a warning', () => {
    // Neither key can be resolved, so the honest answer is no opinion — this is
    // the exact shape of the false alarm: an absent key is not a zero.
    assert.equal(assessWorldCoverage({
        locationId: 'sjeverna-dalmacija',
        buildingSource: 'overture',
        country: null,
        declaresTerrain: true,
        insidePreparedArea: true,
        coverage: COUNTRY_BUCKETED,
        terrainState: 'ok',
    }), null);
});
