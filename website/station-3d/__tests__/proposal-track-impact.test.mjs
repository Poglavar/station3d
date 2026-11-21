// Verifies indexed, whole-building demolition for proposed rail corridors —
// and that the demolition only claims buildings whose ground the track really
// disturbs: bored tunnels and viaduct decks spare them, open works do not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProposalTrackImpactIndex } from '../core/proposal-track-impact.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const ANCHOR_LAT = 43.52;
const ANCHOR_LON = 16.4;
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);

function lonLat(x, z) {
    return [ANCHOR_LON + x / M_PER_LON, ANCHOR_LAT - z / M_PER_LAT];
}

function track(points, properties = {}) {
    return {
        type: 'Feature',
        properties,
        geometry: {
            type: 'LineString',
            coordinates: points.map(([x, z, elev]) => (elev === undefined
                ? lonLat(x, z)
                : [...lonLat(x, z), elev])),
        },
    };
}

function building(minX, minZ, maxX, maxZ, properties = undefined) {
    const ring = [
        lonLat(minX, minZ),
        lonLat(maxX, minZ),
        lonLat(maxX, maxZ),
        lonLat(minX, maxZ),
        lonLat(minX, minZ),
    ];
    return {
        type: 'Feature',
        ...(properties ? { properties } : {}),
        geometry: { type: 'Polygon', coordinates: [ring] },
    };
}

function indexFor(points, halfWidthM = 2.5, { properties = {}, railFormation = null } = {}) {
    return new ProposalTrackImpactIndex({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [track(points, properties)],
        halfWidthForFeature: () => halfWidthM,
        railFormation,
    });
}

test('demolishes a whole building when the track crosses its footprint', () => {
    const index = indexFor([[-100, 0], [100, 0]]);
    assert.equal(index.intersectsFeature(building(-5, -5, 5, 5)), true);
});

test('never demolishes one stated-material bucket out of an authored landmark', () => {
    const index = indexFor([[-100, 0], [100, 0]]);
    const airportGlass = building(-5, -5, 5, 5, {
        object_id: '2655',
        source: 'landmark',
        geometry_kind: 'mesh',
        material: { kind: 'glass', color: '527486' },
    });
    assert.equal(index.intersectsFeature(airportGlass), false);
});

test('material ownership protects authored meshes independently of their source label', () => {
    const index = indexFor([[-100, 0], [100, 0]]);
    const futureAuthoredSource = building(-5, -5, 5, 5, {
        object_id: 'future-authored-source',
        source: 'lidar',
        geometry_kind: 'mesh',
        material: { kind: 'solid', color: 'ffffff' },
    });
    assert.equal(index.intersectsFeature(futureAuthoredSource), false);
});

test('the landmark source remains protected if a near payload omits material', () => {
    const index = indexFor([[-100, 0], [100, 0]]);
    assert.equal(index.intersectsFeature(building(-5, -5, 5, 5, {
        object_id: 'landmark-without-material',
        source: 'landmark',
        geometry_kind: 'mesh',
    })), false);
});

test('protects every canonical far-LOD provenance marker for landmark parts', () => {
    const index = indexFor([[-100, 0], [100, 0]]);
    const markers = [
        { render_source: 'landmark_mesh' },
        { mesh_table: 'buildings.landmark_mesh' },
        { footprint_source: 'landmark' },
    ];
    for (const marker of markers) {
        assert.equal(index.intersectsFeature(building(-5, -5, 5, 5, {
            object_id: '2655',
            ...marker,
        })), false, JSON.stringify(marker));
    }
});

test('ordinary survey meshes remain subject to track acquisition', () => {
    const index = indexFor([[-100, 0], [100, 0]]);
    const lidarBuilding = building(-5, -5, 5, 5, {
        object_id: 'ordinary-lidar-building',
        source: 'lidar',
        geometry_kind: 'mesh',
    });
    assert.equal(index.intersectsFeature(lidarBuilding), true);
});

test('includes the construction envelope when a rail just misses a wall', () => {
    const index = indexFor([[-100, 0], [100, 0]], 3);
    assert.equal(index.intersectsFeature(building(-5, 2.8, 5, 8)), true);
    assert.equal(index.intersectsFeature(building(-5, 3.2, 5, 8)), false);
});

test('does not scan or demolish distant streamed buildings', () => {
    const index = indexFor([[-100, 0], [100, 0]]);
    assert.equal(index.intersectsFeature(building(4000, 4000, 4020, 4020)), false);
});

test('respects courtyard holes while still detecting their boundary walls', () => {
    const outer = building(-20, -20, 20, 20).geometry.coordinates[0];
    const inner = building(-10, -10, 10, 10).geometry.coordinates[0];
    const courtyardBuilding = {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [outer, inner] },
    };
    assert.equal(indexFor([[-5, 0], [5, 0]], 1).intersectsFeature(courtyardBuilding), false);
    assert.equal(indexFor([[-15, 0], [15, 0]], 1).intersectsFeature(courtyardBuilding), true);
});

// ── Vertical rule, flat world (relative third coordinates) ─────────────────

test('a level bored run under flat ground spares the building above it', () => {
    assert.equal(indexFor([[-100, 0, -10], [100, 0, -10]])
        .intersectsFeature(building(-5, -5, 5, 5)), false);
});

test('a sloping underground ramp is an open trench and still demolishes', () => {
    assert.equal(indexFor([[-100, 0, -6], [100, 0, -12]])
        .intersectsFeature(building(-5, -5, 5, 5)), true);
});

test('a level elevated deck spares, a low embankment does not', () => {
    assert.equal(indexFor([[-100, 0, 10], [100, 0, 10]])
        .intersectsFeature(building(-5, -5, 5, 5)), false);
    assert.equal(indexFor([[-100, 0, 2], [100, 0, 2]])
        .intersectsFeature(building(-5, -5, 5, 5)), true);
});

test('absolute-datum elevations never read as deck height without a formation', () => {
    // 120 m EVRF2000 on a terrain world is NOT "120 m above the building" —
    // with no formation to consult, the old whole-corridor rule stands.
    const index = indexFor([[-100, 0, 120], [100, 0, 120]], 2.5, {
        properties: { elevationMode: 'absolute', elevationDatum: 'EVRF2000' },
    });
    assert.equal(index.intersectsFeature(building(-5, -5, 5, 5)), true);
});

// ── Vertical rule, terrain world (rail-formation classification) ───────────

// The real formation answers formationAtLocal with the structure of the
// nearest classified segment; the stub answers from an x-addressed table the
// same way, with stations measured from x = -100.
function stubFormation(structureAtStation, coverAtStation = () => null, cutFootprint = null) {
    const alignment = { routeStartStationM: 0 };
    return () => ({
        formationAtLocal: (x) => {
            const stationM = x + 100;
            const structure = structureAtStation(stationM);
            return structure ? { structure, stationM, alignment, railY: 0 } : null;
        },
        coverAtLocal: (x) => coverAtStation(x + 100),
        // The excavation footprint: |z| within the batter toe, which is wider
        // than the bed the construction envelope covers.
        isOpenCutAtLocal: cutFootprint || (() => false),
    });
}

test('a bored tunnel with cover over it spares the building above', () => {
    const railFormation = stubFormation(() => 'tunnel', () => 20);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, -5, 5, 5)), false);
});

test('a mouth is where the cover runs out, and it still demolishes', () => {
    const railFormation = stubFormation(() => 'tunnel', () => 2);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, -5, 5, 5)), true);
});

// The regression, in two parts. Sibenik project 141, stations 653–762: a 61 m
// dip in cover (3.4–10.6 m, never once reaching daylight) split one bore into
// two, each grew a 24 m cut-and-cover mouth, and 109 m of city block came down.
test('a bore boundary with deep cover over it grows no phantom portal', () => {
    const railFormation = stubFormation(() => 'tunnel', () => 10.6);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, -5, 5, 5)), false);
});

// The threshold is the design rule, not a dial: 8 m of cover is 7.3 m of tube
// above rail plus 0.7 m over the roof slab. Below it the crown stands proud of
// the ground, so the building is not over a tunnel at all and cannot be spared.
test('cover too thin to bury the roof is not a tunnel to stand on', () => {
    for (const coverM of [3.4, 6.9, 7.9]) {
        const railFormation = stubFormation(() => 'tunnel', () => coverM);
        assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
            .intersectsFeature(building(-5, -5, 5, 5)), true, `cover ${coverM} m`);
    }
});

test('unknown cover keeps the bore its benefit of the doubt', () => {
    // A missing terrain sample is not "no cover"; demolishing on it would turn
    // an unloaded tile into a razed building.
    const railFormation = stubFormation(() => 'tunnel', () => null);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, -5, 5, 5)), false);
});

test('an open formation stays open however deep the ground beside it is', () => {
    const railFormation = stubFormation(() => 'formation', () => 30);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, -5, 5, 5)), true);
});

test('a viaduct span spares, open formation demolishes', () => {
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation: stubFormation(() => 'viaduct') })
        .intersectsFeature(building(-5, -5, 5, 5)), false);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation: stubFormation(() => 'formation') })
        .intersectsFeature(building(-5, -5, 5, 5)), true);
});

test('a formation that cannot see the hit falls back to the old rule', () => {
    const railFormation = stubFormation(() => null);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, -5, 5, 5)), true);
});

// ── Over the cut, not just over the bed ────────────────────────────────────
// A cut is a wedge. Demolishing only what stands on the level bed leaves the
// buildings on the slope standing on ground that is about to be dug away.

const CUT_HALF_WIDTH_M = 10;   // batter toe, well outside the 2.5 m bed
const cutOut = (x, z) => Math.abs(z) <= CUT_HALF_WIDTH_M;

test('a building on the batter is demolished, not only one on the bed', () => {
    const railFormation = stubFormation(() => 'formation', () => 4, cutOut);
    // 6–9 m off the centreline: clear of the 2.5 m envelope, inside the cut.
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, 6, 5, 9)), true);
});

test('a building beyond the cut toe still stands', () => {
    const railFormation = stubFormation(() => 'formation', () => 4, cutOut);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, 11, 5, 14)), false);
});

test('an overhang into the cut is enough, the centre need not be in it', () => {
    // Centre at z = 12.5, outside the toe; the near edge reaches z = 10.
    const railFormation = stubFormation(() => 'formation', () => 4, cutOut);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, 10, 5, 15)), true);
});

test('with no cut under it, the bed still decides', () => {
    // Same geometry, formation reports no excavation: the batter building lives.
    const railFormation = stubFormation(() => 'formation', () => 4, () => false);
    const index = indexFor([[-100, 0], [100, 0]], 2.5, { railFormation });
    assert.equal(index.intersectsFeature(building(-5, 6, 5, 9)), false);
    assert.equal(index.intersectsFeature(building(-5, -5, 5, 5)), true);
});

test('a bore that opens no ground spares the batter', () => {
    // A bore with real cover carves no surface profile, so nothing above it is
    // standing on excavated ground.
    const railFormation = stubFormation(() => 'tunnel', () => 20, () => false);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, 6, 5, 9)), false);
});

// The contradiction this precedence resolves. A cut-and-cover mouth carves the
// surface at a bore end even where the cover reads deep, so the formation says
// "open" and the cover says "buried" about the same ground. The hole wins:
// sparing here left whole walls at the rim with their foundation skirt hanging
// into the trench (Sibenik 141, four buildings, cover 9.1-10.6 m).
test('an excavated footprint beats a deep cover reading', () => {
    const railFormation = stubFormation(() => 'tunnel', () => 10.6, cutOut);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, 6, 5, 9)), true);
});

// ...but only where the ground is actually opened. Away from the carve the
// cover rule still owns the answer, or every building over a bore would go.
test('deep cover still spares where nothing is excavated', () => {
    const railFormation = stubFormation(() => 'tunnel', () => 10.6, () => false);
    assert.equal(indexFor([[-100, 0], [100, 0]], 2.5, { railFormation })
        .intersectsFeature(building(-5, -5, 5, 5)), false);
});
