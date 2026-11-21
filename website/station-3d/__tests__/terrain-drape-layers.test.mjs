// Locks the drape contract the terrain inspector's city layers depend on:
// which windows may load them, how a window splits into fetchable bboxes, how
// OSM tags become a width and a vertical mode, and — the part that decides
// whether a road looks right — how relief samples (including missing ones)
// become vertex heights.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BRIDGE_DECK_LIFT_M,
    DRAPE_HOUSE_MAX_SPAN_KM,
    buildDrapedBuilding,
    buildDrapedRibbon,
    clipChainToRect,
    drapeClipRectFromView,
    drapeFetchBboxes,
    drapeVerticalMode,
    drapedBuildingBaseM,
    drapedHeights,
    railDrapeStyle,
    roadDrapeStyle,
    roadHighwayValuesForClasses,
    terrainDrapeLayerPolicy,
} from '../core/terrain-drape-layers.js';

const stationsAt = (arcs) => arcs.map((arc) => ({ x: arc, z: 0, arc, nx: 0, nz: 1, halfWidth: 3 }));

test('rails have no ceiling — a wide window is exactly what they are for', () => {
    // Measured: all of Zagreb at 35 km is 1,387 rail ways, FEWER than the 1,813
    // roads a 2 km window already builds. Refusing them at width was the bug.
    for (const span of [1, 3, 10, 13, 35]) {
        assert.equal(terrainDrapeLayerPolicy(span).rails.enabled, true, `${span} km`);
    }
});

test('houses are the only layer actually refused, and only above their ceiling', () => {
    assert.equal(terrainDrapeLayerPolicy(2).houses.enabled, true);
    assert.equal(terrainDrapeLayerPolicy(DRAPE_HOUSE_MAX_SPAN_KM).houses.enabled, true);
    assert.equal(terrainDrapeLayerPolicy(DRAPE_HOUSE_MAX_SPAN_KM + 0.5).houses.enabled, false);
    assert.equal(terrainDrapeLayerPolicy(35).houses.enabled, false);
});

test('roads thin out by class as the window widens instead of disappearing', () => {
    assert.equal(terrainDrapeLayerPolicy(2).roads.tier, 'all');
    assert.ok(terrainDrapeLayerPolicy(2).roads.classes.includes('residential'));

    const wide = terrainDrapeLayerPolicy(8).roads;
    assert.equal(wide.tier, 'tertiary');
    assert.equal(wide.enabled, true);
    assert.ok(!wide.classes.includes('residential'), 'side streets are what explode the count');
    assert.ok(wide.classes.includes('tertiary'));

    const widest = terrainDrapeLayerPolicy(35).roads;
    assert.equal(widest.tier, 'secondary');
    assert.equal(widest.enabled, true);
    assert.ok(!widest.classes.includes('tertiary'));
    assert.ok(widest.classes.includes('motorway') && widest.classes.includes('secondary'));
});

test('a missing span enables nothing — Number(null) is 0, not a small window', () => {
    for (const bad of [null, undefined, '', 0, -5]) {
        const policy = terrainDrapeLayerPolicy(bad);
        assert.equal(policy.rails.enabled, false, `${bad}`);
        assert.equal(policy.roads.enabled, false, `${bad}`);
        assert.equal(policy.houses.enabled, false, `${bad}`);
    }
});

test('class keys expand to the OSM highway values the endpoint filters on', () => {
    const values = roadHighwayValuesForClasses(['motorway', 'primary']);
    // The _link variants belong to their class or a slip road vanishes at a
    // junction while the road it serves is drawn.
    assert.ok(values.includes('motorway') && values.includes('motorway_link'));
    assert.ok(values.includes('primary') && values.includes('primary_link'));
    assert.ok(!values.includes('residential'));

    // `residential` is an umbrella over several OSM values in the class table;
    // the expansion must carry all of them, not just the literal tag.
    const residential = roadHighwayValuesForClasses(['residential']);
    for (const value of ['residential', 'unclassified', 'living_street', 'road']) {
        assert.ok(residential.includes(value), `missing ${value}`);
    }
    assert.deepEqual(roadHighwayValuesForClasses([]), []);
});

test('the widest tier still asks for a set the endpoint can answer completely', () => {
    // Zagreb at 35 km: 4,606 ways at this tier against the endpoint's 5,000-row
    // cap, and the client splits it across 9 tiles, so the cap cannot bite.
    const values = roadHighwayValuesForClasses(terrainDrapeLayerPolicy(35).roads.classes);
    assert.ok(values.length > 0);
    assert.ok(!values.includes('service'));
    assert.ok(!values.includes('residential'));
});

test('a window splits into bboxes that cover it exactly and never overhang', () => {
    const bounds = { west: 15.96, east: 16.00, south: 45.79, north: 45.82 };
    const boxes = drapeFetchBboxes(bounds, { maxSpanDeg: 0.018 });
    assert.equal(boxes.length, 6); // 3 columns x 2 rows
    for (const box of boxes) {
        assert.ok(box.west >= bounds.west - 1e-9 && box.east <= bounds.east + 1e-9);
        assert.ok(box.south >= bounds.south - 1e-9 && box.north <= bounds.north + 1e-9);
        assert.ok(box.east - box.west <= 0.018 + 1e-9, 'a box may not exceed the endpoint cap');
        assert.ok(box.north - box.south <= 0.018 + 1e-9);
    }
    assert.equal(Math.min(...boxes.map((b) => b.west)), bounds.west);
    assert.equal(Math.max(...boxes.map((b) => b.east)), bounds.east);
});

test('one box is enough when the window already fits', () => {
    const boxes = drapeFetchBboxes({ west: 15.98, east: 15.99, south: 45.80, north: 45.81 });
    assert.equal(boxes.length, 1);
    assert.deepEqual(boxes[0], { west: 15.98, east: 15.99, south: 45.80, north: 45.81 });
});

test('unusable bounds ask for nothing rather than a degenerate box', () => {
    assert.deepEqual(drapeFetchBboxes({ west: 16, east: 15, south: 45, north: 46 }), []);
    assert.deepEqual(drapeFetchBboxes(null), []);
});

test('bridge and tunnel tags decide the vertical mode, "no" is not a structure', () => {
    assert.equal(drapeVerticalMode({ bridge: 'viaduct' }), 'bridge');
    assert.equal(drapeVerticalMode({ tunnel: 'yes' }), 'tunnel');
    assert.equal(drapeVerticalMode({ bridge: 'yes', tunnel: 'yes' }), 'tunnel');
    assert.equal(drapeVerticalMode({ bridge: 'no', tunnel: 'no' }), 'drape');
    assert.equal(drapeVerticalMode({}), 'drape');
});

test('a building passage is a road at grade, not a bore through the hill', () => {
    // 284 of these against 30 real tunnels inside one 2 km central Zagreb box:
    // dropping them erases most of the arcaded centre.
    assert.equal(drapeVerticalMode({ tunnel: 'building_passage' }), 'drape');
    assert.equal(drapeVerticalMode({ tunnel: 'covered' }), 'drape');
    assert.equal(drapeVerticalMode({ tunnel: 'yes' }), 'tunnel');
});

test('a surveyed carriageway width wins over the class default', () => {
    assert.equal(roadDrapeStyle({ highway: 'residential', width_meters: 9.4 }).widthM, 9.4);
    assert.equal(roadDrapeStyle({ highway: 'residential' }).widthM, 6.5);
    // Sub-metre widths exist in osm_road and would render as threads.
    assert.equal(roadDrapeStyle({ highway: 'residential', width_meters: 0.4 }).widthM, 6.5);
    assert.equal(roadDrapeStyle({ highway: 'motorway_link' }).classKey, 'motorway');
    assert.equal(roadDrapeStyle({ highway: 'footway' }), null);
});

test('a two-track rail way is twice as wide as a single track', () => {
    const single = railDrapeStyle({ railway: 'rail' });
    const double = railDrapeStyle({ railway: 'rail', tracks: '2' });
    assert.equal(double.widthM, single.widthM * 2);
    assert.equal(railDrapeStyle({ railway: 'light_rail' }).classKey, 'tram');
    assert.equal(railDrapeStyle({ railway: 'platform' }), null);
});

test('draped heights follow the relief and carry the lift', () => {
    const solved = drapedHeights(stationsAt([0, 10, 20]), (x) => 100 + x, { liftM: 0.3 });
    assert.deepEqual([...solved.heights], [100.3, 110.3, 120.3]);
    assert.equal(solved.filledCount, 0);
    assert.equal(solved.ok, true);
});

test('a gap in DGU coverage interpolates between real samples, it never becomes zero', () => {
    // The middle station has no coverage. Number(null) would put it at 0 m —
    // a road diving to sea level between two 100 m samples.
    const solved = drapedHeights(stationsAt([0, 10, 20]), (x) => (x === 10 ? null : 100 + x));
    assert.deepEqual([...solved.heights], [100, 110, 120]);
    assert.equal(solved.filledCount, 1);
});

test('a chain running off the grid holds the last real height at each end', () => {
    const solved = drapedHeights(
        stationsAt([0, 10, 20, 30]),
        (x) => (x === 0 || x === 30 ? null : 100 + x),
    );
    assert.deepEqual([...solved.heights], [110, 110, 120, 120]);
    assert.equal(solved.filledCount, 2);
});

test('a chain with no coverage at all is refused, not invented', () => {
    const solved = drapedHeights(stationsAt([0, 10]), () => null);
    assert.equal(solved.ok, false);
    assert.equal(solved.heights, null);
});

test('a bridge rides a straight ramp between its abutments instead of the valley', () => {
    // Terrain dips to 40 m mid-span; a draped deck would follow it down.
    const terrain = (x) => (x === 0 || x === 40 ? 100 : 40);
    const solved = drapedHeights(stationsAt([0, 10, 20, 30, 40]), terrain, { mode: 'bridge' });
    for (const height of solved.heights) {
        assert.equal(height, 100 + BRIDGE_DECK_LIFT_M);
    }
});

test('a sloping bridge ramps linearly from one abutment to the other', () => {
    const terrain = (x) => (x === 0 ? 100 : (x === 20 ? 140 : 10));
    const solved = drapedHeights(stationsAt([0, 10, 20]), terrain, { mode: 'bridge' });
    assert.deepEqual([...solved.heights].map((h) => h - BRIDGE_DECK_LIFT_M), [100, 120, 140]);
});

test('a ribbon is a continuous strip of the requested width at relief height', () => {
    const ribbon = buildDrapedRibbon(
        [{ x: 0, z: 0 }, { x: 40, z: 0 }],
        { widthM: 10, sampleHeightM: () => 120, liftM: 0.3, maxSegmentM: 10 },
    );
    assert.ok(ribbon, 'a straight surveyed road must build');
    assert.equal(ribbon.positions.length / 3, ribbon.stationCount * 2);
    assert.equal(ribbon.indices.length, (ribbon.stationCount - 1) * 6);
    // Densified to the sampling step, so it cannot chord across a DTM cell.
    assert.ok(ribbon.stationCount >= 5, `expected densification, got ${ribbon.stationCount}`);
    for (let index = 0; index < ribbon.positions.length; index += 3) {
        assert.ok(Math.abs(ribbon.positions[index + 1] - 120.3) < 1e-4);
    }
    // Half-width either side of a due-east centreline lying on z = 0.
    assert.deepEqual(
        [ribbon.positions[2], ribbon.positions[5]].sort((a, b) => a - b),
        [-5, 5],
    );
});

test('a ribbon rides a slope instead of chording across it', () => {
    const ribbon = buildDrapedRibbon(
        [{ x: 0, z: 0 }, { x: 100, z: 0 }],
        { widthM: 8, sampleHeightM: (x) => 100 + x * 0.05, maxSegmentM: 8 },
    );
    const heights = [];
    for (let index = 1; index < ribbon.positions.length; index += 6) heights.push(ribbon.positions[index]);
    assert.ok(heights[0] < heights[heights.length - 1]);
    // Every interior station sits on the ramp, not on a chord between the ends.
    for (let index = 0; index < ribbon.positions.length; index += 3) {
        const expected = 100 + ribbon.positions[index] * 0.05;
        assert.ok(Math.abs(ribbon.positions[index + 1] - expected) < 0.35);
    }
});

test('a tunnel builds nothing — it must not paint a road over the hill', () => {
    assert.equal(buildDrapedRibbon(
        [{ x: 0, z: 0 }, { x: 40, z: 0 }],
        { mode: 'tunnel', sampleHeightM: () => 120 },
    ), null);
});

test('degenerate and uncovered centrelines are skipped, not built as slivers', () => {
    const sampler = () => 120;
    assert.equal(buildDrapedRibbon([{ x: 0, z: 0 }], { sampleHeightM: sampler }), null);
    assert.equal(buildDrapedRibbon([], { sampleHeightM: sampler }), null);
    // Two coincident nodes are one node.
    assert.equal(buildDrapedRibbon(
        [{ x: 5, z: 5 }, { x: 5.01, z: 5 }], { sampleHeightM: sampler },
    ), null);
    assert.equal(buildDrapedRibbon(
        [{ x: 0, z: 0 }, { x: 40, z: 0 }], { sampleHeightM: () => null },
    ), null);
});

test('a prism stands on the lowest relief under its footprint, never floating', () => {
    const ring = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
    assert.equal(drapedBuildingBaseM(ring, (x, z) => 100 + x + z), 100);
    assert.equal(drapedBuildingBaseM(ring, () => null), null);
    // A partly-uncovered footprint still stands on the samples it does have.
    assert.equal(drapedBuildingBaseM(ring, (x) => (x === 0 ? null : 150)), 150);
});

const SQUARE = {
    properties: { eave_height_m: 12 },
    geometry: {
        type: 'Polygon',
        coordinates: [[
            [15.9800, 45.8000], [15.9802, 45.8000],
            [15.9802, 45.8002], [15.9800, 45.8002], [15.9800, 45.8000],
        ]],
    },
};

test('a building extrudes its surveyed eave height above the draped ground', () => {
    const built = buildDrapedBuilding(SQUARE, {
        centerLon: 15.98,
        centerLat: 45.80,
        sampleHeightM: () => 122,
    });
    assert.ok(built);
    assert.equal(built.baseY, 122);
    assert.equal(built.heightM, 12);
    let lowest = Infinity;
    let highest = -Infinity;
    for (let index = 1; index < built.positions.length; index += 3) {
        lowest = Math.min(lowest, built.positions[index]);
        highest = Math.max(highest, built.positions[index]);
    }
    assert.equal(lowest, 122);
    assert.equal(highest, 134);
    assert.ok(built.indices.length >= 3 * 6, 'walls plus a roof cap');
});

test('a building outside DGU coverage is skipped rather than dropped to sea level', () => {
    assert.equal(buildDrapedBuilding(SQUARE, {
        centerLon: 15.98, centerLat: 45.80, sampleHeightM: () => null,
    }), null);
});

test('a height-poor Overture footprint still gets a plausible prism', () => {
    const built = buildDrapedBuilding({
        properties: { source: 'overture', object_id: 'abc', eave_height_m: null },
        geometry: SQUARE.geometry,
    }, { centerLon: 15.98, centerLat: 45.80, sampleHeightM: () => 40 });
    assert.ok(built);
    assert.ok(built.heightM >= 2, 'never a zero-height sliver');
});

// Clipping to the rendered crop. Without it a way that merely INTERSECTS the
// request bbox is drawn in full, and since the DGU grid keeps answering past
// the crop it comes out as kilometres of road floating over the sea plane.
const RECT = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };

test('a chain fully inside the crop is returned untouched', () => {
    const chain = [{ x: -50, z: 0 }, { x: 0, z: 10 }, { x: 50, z: 0 }];
    const runs = clipChainToRect(chain, RECT);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].length, 3);
    assert.deepEqual(runs[0][0], { x: -50, z: 0 });
    assert.deepEqual(runs[0][2], { x: 50, z: 0 });
});

test('a chain leaving the crop is cut exactly at the boundary', () => {
    const runs = clipChainToRect([{ x: 0, z: 0 }, { x: 400, z: 0 }], RECT);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0][0], { x: 0, z: 0 });
    assert.equal(runs[0][runs[0].length - 1].x, 100, 'must stop on the crop edge');
});

test('a chain that leaves and re-enters comes back as two runs, not one chord', () => {
    const chain = [{ x: -50, z: 0 }, { x: 300, z: 0 }, { x: 300, z: 50 }, { x: -50, z: 50 }];
    const runs = clipChainToRect(chain, RECT);
    assert.equal(runs.length, 2);
    assert.equal(runs[0][runs[0].length - 1].x, 100);
    assert.equal(runs[1][0].x, 100);
    // A single run would have drawn a road straight across the gap.
    for (const run of runs) {
        for (const point of run) assert.ok(point.x <= 100 + 1e-9 && point.x >= -100 - 1e-9);
    }
});

test('a chain entirely outside the crop builds nothing', () => {
    assert.deepEqual(clipChainToRect([{ x: 300, z: 300 }, { x: 400, z: 400 }], RECT), []);
});

test('no rect means no clipping — the caller has not cropped anything', () => {
    const chain = [{ x: 0, z: 0 }, { x: 900, z: 0 }];
    assert.deepEqual(clipChainToRect(chain, null), [chain]);
});

test('the clip rect is the rendered crop in local metres', () => {
    const view = {
        centerLon: 16, centerLat: 45,
        metresPerDegreeLon: 1000, metresPerDegreeLat: 2000,
        bounds: { west: 15.99, east: 16.02, south: 44.99, north: 45.01 },
    };
    const rect = drapeClipRectFromView(view);
    for (const [key, expected] of Object.entries({ minX: -10, maxX: 20, minZ: -20, maxZ: 20 })) {
        assert.ok(Math.abs(rect[key] - expected) < 1e-6, `${key} was ${rect[key]}`);
    }
    assert.equal(drapeClipRectFromView({}), null);
});
