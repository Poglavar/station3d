// Headless checks that Split's architectural identity stays isolated from Zagreb.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NEW_BUILD_WALL_FINISHES,
    NEW_BUILD_WALL_PALETTE,
    getLowRiseFacadeStyle,
    getPitchedRoofStyle,
    hasFlatRoof,
    hasMassiveVolumeCurtain,
    kanalicaHeightAt,
    newBuildWindowStyles,
    resolveFacadeWindowStyle,
} from '../core/building-architectural-style.js';

test('limits Dalmatian stone facades to Split low-rise buildings', () => {
    assert.equal(getLowRiseFacadeStyle('zagreb', 1), null);
    assert.equal(getLowRiseFacadeStyle('split', 3), null);
    const style = getLowRiseFacadeStyle('split', 2);
    assert.equal(style.key, 'split-dalmatian-limestone');
    assert.ok(style.textureWidthM > 4);
    assert.ok(style.bumpScale > 0);
});

test('keeps Zagreb window frames unchanged and gives Split green frames', () => {
    const base = { frame: '#e8e2d6', glass: '#3a4654', panes: 'cross' };
    assert.equal(resolveFacadeWindowStyle('zagreb', base, 0), base);

    const split = resolveFacadeWindowStyle('split', base, 0);
    assert.notEqual(split, base);
    assert.equal(split.frame, split.mullion);
    const rgb = split.frame.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16));
    assert.ok(rgb[1] > rgb[0]);
    assert.ok(rgb[1] > rgb[2]);
});

test('uses a brighter kanalica roof only in Split', () => {
    const zagreb = getPitchedRoofStyle('zagreb');
    const split = getPitchedRoofStyle('split');
    assert.equal(zagreb.profile, 'flat-tile');
    assert.equal(split.profile, 'kanalica');
    assert.equal(split.roofForm, 'gable');
    assert.equal(zagreb.palette[0], 0x583020);
    const lightness = (hex) => {
        const channels = [hex >> 16, (hex >> 8) & 0xff, hex & 0xff];
        return (Math.max(...channels) + Math.min(...channels)) / (2 * 255);
    };
    assert.ok(split.palette.every((color) => lightness(color) > lightness(zagreb.palette[0])));
});

test('kanalica profile is periodic, rounded, and raised at tile overlaps', () => {
    const crown = kanalicaHeightAt(0.5, 0.5);
    const trough = kanalicaHeightAt(0, 0.5);
    assert.ok(crown - trough > 0.7);
    assert.ok(kanalicaHeightAt(0.5, 0.01) > crown);
    assert.equal(kanalicaHeightAt(0.37, 0.29), kanalicaHeightAt(2.37, 1.29));
    assert.ok(kanalicaHeightAt(1.5, 0.5) > kanalicaHeightAt(1.5, 0));
    assert.equal(kanalicaHeightAt(Number.NaN, 0), 0);
});

// Šibenik and Zadar live in the sjeverna-dalmacija location, whose own config already declares the
// "same Dalmatian recipe as Split". Only the architectural styling was still gated on the literal
// id 'split', so their houses came out with Zagreb's dark continental clay roofs.
test('gives the northern Dalmatian coast the same houses as Split', () => {
    const split = getPitchedRoofStyle('split');
    const sjevernaDalmacija = getPitchedRoofStyle('sjeverna-dalmacija');
    assert.equal(sjevernaDalmacija.key, split.key);
    assert.equal(sjevernaDalmacija.profile, 'kanalica');
    assert.deepEqual(sjevernaDalmacija.palette, split.palette);

    const lowRise = getLowRiseFacadeStyle('sjeverna-dalmacija', 2);
    assert.equal(lowRise.key, 'split-dalmatian-limestone');
    assert.equal(getLowRiseFacadeStyle('sjeverna-dalmacija', 3), null);

    const base = { frame: '#101010', mullion: '#202020' };
    const windows = resolveFacadeWindowStyle('sjeverna-dalmacija', base, 0);
    assert.deepEqual(windows, resolveFacadeWindowStyle('split', base, 0));
});

test('leaves continental and unlisted locations on the Zagreb style', () => {
    assert.equal(getPitchedRoofStyle('zagreb').key, 'zagreb-clay');
    assert.equal(getPitchedRoofStyle('somewhere-new').key, 'zagreb-clay');
    assert.equal(getLowRiseFacadeStyle('zagreb', 1), null);
    const base = { frame: '#101010', mullion: '#202020' };
    assert.equal(resolveFacadeWindowStyle('zagreb', base, 0), base);
});

// Rijeka's towers are post-war modernist and flat topped. The upstream roof gate only measures
// footprint AREA, so a slim tall block on a small footprint was getting a gable.
test('flattens the roofs of tall Rijeka buildings only', () => {
    assert.equal(hasFlatRoof('rijeka', 12), true);
    assert.equal(hasFlatRoof('rijeka', 7), true);
    assert.equal(hasFlatRoof('rijeka', 6), false, 'the Habsburg core keeps its pitched roofs');
    assert.equal(hasFlatRoof('rijeka', 1), false);
});

test('leaves every other location pitched however tall the building is', () => {
    for (const locationId of ['zagreb', 'split', 'sjeverna-dalmacija', 'somewhere-new']) {
        assert.equal(hasFlatRoof(locationId, 20), false, locationId);
    }
});

test('treats an unknown floor count as not-a-tower rather than flattening it', () => {
    for (const floors of [null, undefined, Number.NaN, 'tall', {}]) {
        assert.equal(hasFlatRoof('rijeka', floors), false);
    }
});

// The massive-volume curtain wall used to be a bare latitude ceiling in the renderer. Every coastal
// location sits entirely below it (Split 43.4–43.6, sjeverna-dalmacija 43.65–44.2, Rijeka 45.28–
// 45.42, Istria 44.8–45.5), so ordinary two-storey coastal buildings were glazed like the airport
// terminal. The rule is now granted per location and cannot be inherited from a coordinate.
const VG_CURTAINS = { maxLatitude: 45.745, minAreaM2: 500, minVolumeM3: 5500 };

test('glazes a genuine hall inside the granted band', () => {
    // 900 m² × 8 m = 7 200 m³, north of the airport's south edge but below the city.
    assert.equal(hasMassiveVolumeCurtain(VG_CURTAINS, {
        areaM2: 900, heightM: 8, latitude: 45.73,
    }), true);
});

test('never glazes a location that was not granted the rule', () => {
    for (const latitude of [43.51, 43.73, 44.12, 45.33]) {   // Split, Šibenik, Zadar, Rijeka
        assert.equal(hasMassiveVolumeCurtain(null, {
            areaM2: 900, heightM: 8, latitude,
        }), false, `latitude ${latitude}`);
        assert.equal(hasMassiveVolumeCurtain(undefined, {
            areaM2: 5000, heightM: 20, latitude,
        }), false, `latitude ${latitude}`);
    }
});

test('keeps the granted band off the city proper above its latitude ceiling', () => {
    assert.equal(hasMassiveVolumeCurtain(VG_CURTAINS, {
        areaM2: 900, heightM: 8, latitude: 45.81,
    }), false);
});

test('holds the two-storey coastal case that started this', () => {
    // 800 m² × 7 m = 5 600 m³ — over the volume threshold, which is exactly why a bare latitude
    // test caught it. Without a granted config it stays an ordinary plastered building.
    assert.equal(hasMassiveVolumeCurtain(null, {
        areaM2: 800, heightM: 7, latitude: 43.51,
    }), false);
    // Inside the granted band the same massing is a hall, and still qualifies.
    assert.equal(hasMassiveVolumeCurtain(VG_CURTAINS, {
        areaM2: 800, heightM: 7, latitude: 45.70,
    }), true);
});

test('does not glaze a small or low-volume building even inside the band', () => {
    assert.equal(hasMassiveVolumeCurtain(VG_CURTAINS, {
        areaM2: 400, heightM: 40, latitude: 45.70,
    }), false, 'below the footprint floor');
    assert.equal(hasMassiveVolumeCurtain(VG_CURTAINS, {
        areaM2: 600, heightM: 5, latitude: 45.70,
    }), false, 'below the volume floor');
});

test('treats an unknown height as one storey rather than a fake volume', () => {
    // 5 000 m² × the 3 m fallback clears 5 500 m³; 900 m² × 3 m does not.
    assert.equal(hasMassiveVolumeCurtain(VG_CURTAINS, {
        areaM2: 5000, heightM: null, latitude: 45.70,
    }), true);
    assert.equal(hasMassiveVolumeCurtain(VG_CURTAINS, {
        areaM2: 900, heightM: Number.NaN, latitude: 45.70,
    }), false);
});

test('refuses a building with no usable footprint or latitude', () => {
    assert.equal(hasMassiveVolumeCurtain(VG_CURTAINS, { areaM2: Number.NaN, heightM: 8, latitude: 45.7 }), false);
    assert.equal(hasMassiveVolumeCurtain(VG_CURTAINS, { areaM2: 900, heightM: 8, latitude: null }), false);
    assert.equal(hasMassiveVolumeCurtain(VG_CURTAINS, {}), false);
});

// ─── New-build (proposal) architecture ──────────────────────────────────────

test('keeps the new-build wall palette in whites and light tones', () => {
    assert.ok(NEW_BUILD_WALL_PALETTE.length >= 6);
    for (const hex of NEW_BUILD_WALL_PALETTE) {
        const channels = [hex >> 16, (hex >> 8) & 0xff, hex & 0xff];
        const average = channels.reduce((sum, c) => sum + c, 0) / 3;
        assert.ok(average >= 210, `0x${hex.toString(16)} is not a light tone`);
        // Whites/creams, never olive: no strong channel spread.
        assert.ok(Math.max(...channels) - Math.min(...channels) <= 30,
            `0x${hex.toString(16)} is too saturated for a new-build wall`);
    }
});

test('weights marble as the dominant new-build finish', () => {
    const counts = {};
    for (const finish of NEW_BUILD_WALL_FINISHES) {
        counts[finish.key] = (counts[finish.key] || 0) + 1;
    }
    assert.ok(counts.marble >= 2);
    for (const [key, count] of Object.entries(counts)) {
        if (key !== 'marble') assert.ok(count < counts.marble, `${key} outweighs marble`);
    }
});

test('gives Dalmatian new builds mostly green aluminium shutters', () => {
    for (const locationId of ['split', 'sjeverna-dalmacija']) {
        const styles = newBuildWindowStyles(locationId);
        const shuttered = styles.filter((style) => style.shutter);
        assert.ok(shuttered.length > styles.length / 2, `${locationId}: shutters are not the majority`);
        for (const style of shuttered) {
            const rgb = style.shutterColor.match(/[0-9a-f]{2}/gi).map((v) => Number.parseInt(v, 16));
            assert.ok(rgb[1] > rgb[0] && rgb[1] > rgb[2], `${style.shutterColor} is not green`);
        }
    }
});

test('keeps continental new builds shutterless modern aluminium', () => {
    for (const style of newBuildWindowStyles('zagreb')) {
        assert.equal(style.shutter, null);
    }
});

// The opening mask in buildings.js reserves WINDOW_MAX_W_SCALE 1.15 ×
// WINDOW_MAX_H_SCALE 1.12 for every style. A new-build style outside that
// envelope would paint windows the mask never cleared, back onto roof edges.
test('keeps every new-build window style inside the opening-mask envelope', () => {
    for (const locationId of ['zagreb', 'split', 'sjeverna-dalmacija']) {
        for (const style of newBuildWindowStyles(locationId)) {
            assert.ok(style.wScale <= 1.15, `${locationId} wScale ${style.wScale}`);
            assert.ok(style.hScale <= 1.12, `${locationId} hScale ${style.hScale}`);
        }
    }
});
