// The station box has to fit the depth it was authored at. Building the full
// 9.6 m hall at the 8 m tunnel depth pushed the roof slab up through the street.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    planUndergroundStationBox,
    fullStationBoxDepthM,
    STATION_FULL_HALL_HEIGHT_M,
    STATION_MEZZANINE_DECK_Y_M,
    STATION_MIN_HALL_HEIGHT_M,
    STATION_MIN_MEZZANINE_HEADROOM_M,
    STATION_ROOF_COVER_M,
} from '../core/underground-station-box.js';

// The roof must end up buried, whatever the depth. That is the whole contract.
function roofCoverM(depthM) {
    return depthM - planUndergroundStationBox(depthM).hallHeightM;
}

test('the roof is buried at every buildable depth', () => {
    for (const depthM of [6.9, 7.5, 7.93, 9.22, 10.3, 14, 30]) {
        const cover = roofCoverM(depthM);
        assert.ok(cover >= STATION_ROOF_COVER_M - 1e-9,
            `depth ${depthM} m left only ${cover.toFixed(2)} m over the roof`);
    }
});

test('the two real stations that were protruding now fit', () => {
    // Measured from project 74: rail 97.00 under terrain 104.93, and rail 98.30
    // under 107.52. Both built the full 9.6 m hall and broke the surface by
    // 1.67 m and 0.38 m respectively.
    const shallow = planUndergroundStationBox(7.93);
    assert.equal(shallow.tooShallow, false);
    assert.equal(shallow.hasMezzanine, false, '7.93 m cannot carry a walkable mezzanine');
    assert.ok(Math.abs(shallow.hallHeightM - 7.23) < 1e-9);

    const deeper = planUndergroundStationBox(9.22);
    assert.equal(deeper.hasMezzanine, true);
    assert.ok(deeper.mezzanineHeadroomM >= STATION_MIN_MEZZANINE_HEADROOM_M);
    assert.ok(Math.abs(deeper.hallHeightM - 8.52) < 1e-9);
});

test('a deep station gets the complete box and no more', () => {
    const deep = planUndergroundStationBox(30);
    assert.equal(deep.hallHeightM, STATION_FULL_HALL_HEIGHT_M, 'never taller than designed');
    assert.equal(deep.hasMezzanine, true);
    assert.equal(deep.mezzanineDeckY, STATION_MEZZANINE_DECK_Y_M);
    // At exactly the full-box depth the hall is complete with the cover intact.
    const exact = planUndergroundStationBox(fullStationBoxDepthM());
    assert.equal(exact.hallHeightM, STATION_FULL_HALL_HEIGHT_M);
    assert.ok(Math.abs(roofCoverM(fullStationBoxDepthM()) - STATION_ROOF_COVER_M) < 1e-9);
});

test('the mezzanine is dropped, never squeezed', () => {
    // Just under the threshold it disappears rather than becoming a crawl space.
    const threshold = STATION_MEZZANINE_DECK_Y_M + STATION_MIN_MEZZANINE_HEADROOM_M
        + STATION_ROOF_COVER_M;
    assert.equal(planUndergroundStationBox(threshold - 0.01).hasMezzanine, false);
    assert.equal(planUndergroundStationBox(threshold + 0.01).hasMezzanine, true);
    // And when present it always has usable headroom.
    for (const depthM of [threshold + 0.01, 9.22, 10.3, 20]) {
        const box = planUndergroundStationBox(depthM);
        assert.ok(box.mezzanineHeadroomM >= STATION_MIN_MEZZANINE_HEADROOM_M,
            `depth ${depthM} gave ${box.mezzanineHeadroomM.toFixed(2)} m of headroom`);
    }
});

test('too shallow is reported, not silently built', () => {
    // Below the train envelope there is no honest box. Say so, and say by how
    // much — the planner surfaces that rather than rendering something wrong.
    const box = planUndergroundStationBox(4);
    assert.equal(box.tooShallow, true);
    assert.equal(box.hasMezzanine, false);
    assert.ok(box.shortfallM > 0);
    assert.ok(Math.abs(box.shortfallM - (STATION_MIN_HALL_HEIGHT_M - (4 - STATION_ROOF_COVER_M))) < 1e-9);

    // The boundary: exactly enough for the platform level.
    const edge = planUndergroundStationBox(STATION_MIN_HALL_HEIGHT_M + STATION_ROOF_COVER_M);
    assert.equal(edge.tooShallow, false);
    assert.equal(edge.hallHeightM, STATION_MIN_HALL_HEIGHT_M);
});

test('nonsense depth is reported as too shallow rather than throwing', () => {
    for (const bad of [NaN, null, undefined, 'x', -5]) {
        const box = planUndergroundStationBox(bad);
        assert.equal(box.tooShallow, true, String(bad));
        assert.ok(Number.isFinite(box.hallHeightM), 'still returns a usable height');
    }
});
