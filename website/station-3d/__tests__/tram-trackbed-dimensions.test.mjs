// Locks the renderer to the gauges carried by planner and OSM rail features.
// Locks the canonical and explicitly tagged rail gauges used by Station3D.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getRailFormationHalfWidthMeters,
    getRenderedRailTrackbedHalfWidthAtSpacingMeters,
    getSingleTrackBedHalfWidthMeters,
    getTrackbedHalfWidthMeters,
    getTrackCenterSpacingMeters,
    getTrackGaugeMeters,
    getRailVisualProfile,
    isHeavyRailProperties,
    TRAM_GAUGE_M,
} from '../world/tram-trackbed-dimensions.js';

test('Zagreb OSM tram gauge is read as 1000 millimetres', () => {
    const osmTram = {
        railway_type: 'tram',
        tags: { railway: 'tram', gauge: '1000' },
    };
    assert.equal(TRAM_GAUGE_M, 1);
    assert.equal(getTrackGaugeMeters(osmTram), 1);
    assert.equal(getTrackCenterSpacingMeters(osmTram), 2.8);
    assert.equal(getSingleTrackBedHalfWidthMeters(osmTram), 1.05);
});

test('numeric and metre-valued gauges are both accepted', () => {
    assert.equal(getTrackGaugeMeters({ gauge: 1000 }), 1);
    assert.equal(getTrackGaugeMeters({ gauge: 1 }), 1);
    assert.equal(getTrackGaugeMeters({ tags: { gauge: '1435' } }), 1.435);
});

test('untagged heavy rail does not inherit the tram gauge', () => {
    assert.equal(getTrackGaugeMeters({ railway_type: 'rail' }), 1.435);
    assert.equal(getTrackCenterSpacingMeters({ railway_type: 'rail' }), 3.4);
});

test('heavy rail and street tram have distinct physical cross-sections', () => {
    const heavy = getRailVisualProfile({ railway_type: 'rail', gauge: '1435' });
    const tram = getRailVisualProfile({ railway_type: 'tram', gauge: '1435' });
    assert.equal(heavy.kind, 'heavy-rail');
    assert.equal(heavy.hasSleepers, true);
    assert.equal(heavy.hasFlatCurbs, false);
    assert.ok(heavy.railWidthM > tram.railWidthM);
    assert.ok(heavy.railHeightM > tram.railHeightM);
    assert.ok(heavy.trackbedShoulderM > tram.trackbedShoulderM);
    assert.equal(tram.kind, 'light-rail', 'explicit tram identity wins over standard gauge');
    assert.equal(isHeavyRailProperties({ railMode: 'train' }), true);
});

test('a reconstructed heavy-rail formation has a level apron outside its ballast bed', () => {
    const properties = {
        source: 'reference-project',
        trackType: 'g1435',
        trackCount: 1,
    };
    const visibleBedHalfWidthM = getTrackbedHalfWidthMeters(properties);
    const formationHalfWidthM = getRailFormationHalfWidthMeters(properties);
    assert.ok(Math.abs(visibleBedHalfWidthM - 1.6375) < 1e-9);
    assert.ok(Math.abs(formationHalfWidthM - 2.8875) < 1e-9);
    assert.ok(formationHalfWidthM * 2 >= 5, 'single-track formation should be about five metres wide');
    assert.equal(
        getRailFormationHalfWidthMeters({ trackType: 'g1435', trackCount: 1 }),
        visibleBedHalfWidthM,
        'new/planner rail keeps its authored cross-section',
    );
});

test('curated station-yard rails paint their wider formation as one ballast field', () => {
    const properties = {
        source: 'osm-solved-context',
        railContextRole: 'station-yard',
        railway_type: 'rail',
        gauge: '1435',
        trackCount: 1,
    };
    assert.ok(Math.abs(getTrackbedHalfWidthMeters(properties) - 1.6375) < 1e-9);
    assert.ok(Math.abs(getRailFormationHalfWidthMeters(properties) - 3.6375) < 1e-9);
    assert.ok(
        Math.abs(getRenderedRailTrackbedHalfWidthAtSpacingMeters(properties) - 3.6375) < 1e-9,
        'the visible context ballast must cover the shared yard formation',
    );
    assert.equal(
        getRenderedRailTrackbedHalfWidthAtSpacingMeters({ railway_type: 'rail' }),
        getTrackbedHalfWidthMeters({ railway_type: 'rail' }),
        'ordinary rail keeps its narrow visible ballast bed',
    );
});
