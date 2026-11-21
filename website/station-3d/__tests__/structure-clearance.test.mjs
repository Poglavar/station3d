// Telling an overpass from a wall. The plan test cannot, and until this rule
// existed an open formation demolished whatever its footprint touched — which
// took Split airport's whole 22,578 m² terminal for the 9 m deck arm that
// reaches across the alignment. Run: npm run test:unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    structureOverheadVerdict,
    MIN_STRUCTURE_OPENING_M,
} from '../core/structure-clearance.js';
import { RAIL_TUBE_HEIGHT_ABOVE_RAIL_M } from '../core/rail-formation.js';

const NEED = RAIL_TUBE_HEIGHT_ABOVE_RAIL_M;

test('the rule the tunnel threshold is built from is the clearance we need', () => {
    assert.equal(NEED, 7.3, '7.3 m of tube above rail — one source, not a second opinion');
});

test('a building on the ground is in the way and is demolished', () => {
    const v = structureOverheadVerdict({ soffitY: 0.1, groundY: 0, railY: 1.7, clearanceNeededM: NEED });
    assert.equal(v.spared, false);
    assert.equal(v.reason, 'grounded');
});

test('a plinth is not a deck: an opening under the minimum still demolishes', () => {
    const justUnder = MIN_STRUCTURE_OPENING_M - 0.01;
    const v = structureOverheadVerdict({ soffitY: justUnder, groundY: 0, railY: -1, clearanceNeededM: NEED });
    assert.equal(v.spared, false);
    assert.equal(v.reason, 'grounded');
    assert.equal(+v.openingM.toFixed(2), +justUnder.toFixed(2));
});

test('a deck with the full tube height above rail is spared outright', () => {
    const v = structureOverheadVerdict({ soffitY: 8, groundY: 0, railY: 0.5, clearanceNeededM: NEED });
    assert.equal(v.spared, true);
    assert.equal(v.reason, 'clears');
    assert.equal(v.clearanceM, 7.5);
    assert.equal(v.shortfallM, undefined);
});

test('exactly the needed clearance clears — the rule is not exclusive', () => {
    const v = structureOverheadVerdict({ soffitY: NEED, groundY: 0, railY: 0, clearanceNeededM: NEED });
    assert.equal(v.spared, true);
    assert.equal(v.reason, 'clears');
});

test('Split airport: spared, with the metres the alignment must drop', () => {
    // Measured at the crossing (chainage ~3,592 m): terminal arm base 17.8 m
    // EVRF2000, natural ground 13.3 m, designed rail 15.05 m.
    const v = structureOverheadVerdict({
        soffitY: 17.8, groundY: 13.3, railY: 15.05, clearanceNeededM: NEED,
    });
    assert.equal(v.spared, true, 'the terminal must survive the deck it reaches across');
    assert.equal(v.reason, 'short-clearance');
    assert.equal(+v.openingM.toFixed(1), 4.5, 'about what a covered primary road wants');
    assert.equal(+v.clearanceM.toFixed(2), 2.75);
    assert.equal(+v.shortfallM.toFixed(2), 4.55, 'drop the rail this much and it clears');
});

test('rail at or above the soffit is not passing under anything', () => {
    for (const railY of [17.8, 20]) {
        const v = structureOverheadVerdict({ soffitY: 17.8, groundY: 13.3, railY, clearanceNeededM: NEED });
        assert.equal(v.spared, false, `railY ${railY}`);
        assert.equal(v.reason, 'rail-above-soffit');
    }
});

test('no surveyed base is no evidence of a deck — behaviour is unchanged', () => {
    // An Overture footprint, or any prism from a guessed height. Absence of
    // evidence must not become evidence: the plan hit still decides.
    for (const soffitY of [null, undefined, NaN, '17.8']) {
        const v = structureOverheadVerdict({ soffitY, groundY: 13.3, railY: 15.05, clearanceNeededM: NEED });
        assert.equal(v.spared, false, `soffitY ${String(soffitY)}`);
        assert.equal(v.reason, 'no-soffit');
    }
});

test('a null soffit is not a soffit at datum zero', () => {
    // Number(null) is 0, which would read as a deck flush with sea level and
    // spare or demolish on a number nobody measured.
    const v = structureOverheadVerdict({ soffitY: null, groundY: -30, railY: -28, clearanceNeededM: NEED });
    assert.equal(v.reason, 'no-soffit');
});

test('a missing terrain sample never invents a demolition', () => {
    const v = structureOverheadVerdict({ soffitY: 17.8, groundY: null, railY: 15.05, clearanceNeededM: NEED });
    assert.equal(v.spared, true);
    assert.equal(v.reason, 'unknown-ground');
});

test('no rail height means no verdict to give, so nothing is spared', () => {
    const v = structureOverheadVerdict({ soffitY: 17.8, groundY: 13.3, railY: null, clearanceNeededM: NEED });
    assert.equal(v.spared, false);
    assert.equal(v.reason, 'no-rail');
});

test('no arguments at all does not throw and spares nothing', () => {
    assert.equal(structureOverheadVerdict().spared, false);
    assert.equal(structureOverheadVerdict({}).reason, 'no-soffit');
});

test('an unstated clearance requirement spares any real opening', () => {
    const v = structureOverheadVerdict({ soffitY: 17.8, groundY: 13.3, railY: 15.05 });
    assert.equal(v.spared, true);
    assert.equal(v.reason, 'clears');
});

// ── Wiring ────────────────────────────────────────────────────────────────────
// The pure verdict above passed 13 tests while the class that calls it threw
// ReferenceError on every invocation, because nothing exercised the two
// together. These do: they drive the real index, with a stub formation standing
// in for the rails layer, so a typo in the wiring cannot hide behind green
// unit tests again.
import { ProposalTrackImpactIndex } from '../core/proposal-track-impact.js';

// The Divulje geometry, in the scene frame: ground 4.5 m below the deck soffit,
// rail 1.75 m above ground. Anchor height cancels out, so ASL and scene agree.
const ANCHOR = { lat: 43.5351, lon: 16.2988 };
const D = Math.PI / 180, EARTH = 6371000;
const mLon = D * EARTH * Math.cos(ANCHOR.lat * D), mLat = D * EARTH;
const at = (eastM, southM) => [ANCHOR.lon + eastM / mLon, ANCHOR.lat - southM / mLat];

// A corridor running east, and a building footprint square astride it.
const corridor = {
    type: 'Feature',
    properties: { source: 'user-line', elevationMode: 'absolute' },
    geometry: { type: 'LineString', coordinates: [at(-60, 0), at(60, 0)] },
};
const buildingAt = (zMin) => ({
    type: 'Feature',
    properties: { object_id: 'T1', z_min: zMin },
    geometry: { type: 'MultiPolygon', coordinates: [[[
        at(-15, -20), at(15, -20), at(15, 20), at(-15, 20), at(-15, -20),
    ]]] },
});
const stubFormation = ({ railY, groundY }) => ({
    formationAtLocal: () => ({ structure: 'formation', railY }),
    coverAtLocal: () => groundY - railY,
});
const indexWith = (formation) => new ProposalTrackImpactIndex({
    anchorLat: ANCHOR.lat,
    anchorLon: ANCHOR.lon,
    features: [corridor],
    halfWidthForFeature: () => 3.72,
    railFormation: () => formation,
    absoluteToSceneY: (m) => m,
});

test('wiring: an open formation still demolishes a building on the ground', () => {
    const index = indexWith(stubFormation({ railY: 15.05, groundY: 13.3 }));
    assert.equal(index.intersectsFeature(buildingAt(13.4)), true);
    assert.deepEqual(index.getClearanceShortfalls(), []);
});

test('wiring: a deck the railway fits under is spared, and reported clean', () => {
    const index = indexWith(stubFormation({ railY: 15.05, groundY: 13.3 }));
    assert.equal(index.intersectsFeature(buildingAt(23)), false, 'clears 7.95 m over rail');
    assert.deepEqual(index.getClearanceShortfalls(), [], 'nothing to fix');
});

test('wiring: Split airport — spared, with the drop recorded against the id', () => {
    const index = indexWith(stubFormation({ railY: 15.05, groundY: 13.3 }));
    assert.equal(index.intersectsFeature(buildingAt(17.8)), false, 'the terminal survives');
    const shortfalls = index.getClearanceShortfalls();
    assert.equal(shortfalls.length, 1);
    assert.equal(shortfalls[0].objectId, 'T1');
    assert.equal(+shortfalls[0].shortfallM.toFixed(2), 4.55);
    assert.equal(+shortfalls[0].clearanceM.toFixed(2), 2.75);
});

test('wiring: with no absoluteToSceneY the flat world behaves exactly as before', () => {
    const index = new ProposalTrackImpactIndex({
        anchorLat: ANCHOR.lat,
        anchorLon: ANCHOR.lon,
        features: [corridor],
        halfWidthForFeature: () => 3.72,
        railFormation: () => stubFormation({ railY: 15.05, groundY: 13.3 }),
    });
    assert.equal(index.intersectsFeature(buildingAt(17.8)), true, 'no converter, no sparing');
});

test('wiring: a viaduct still spares regardless of the building', () => {
    const index = indexWith({
        formationAtLocal: () => ({ structure: 'viaduct', railY: 15.05 }),
        coverAtLocal: () => -1.75,
    });
    assert.equal(index.intersectsFeature(buildingAt(13.4)), false);
});
