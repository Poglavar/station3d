// Landmarks light up through the CITY's dusk switch, not their own layer.
//
// The regression this exists for: the bespoke landmark layer owned the only
// code that raised emissiveIntensity (applyLateNight / setNightLights). When
// that layer was unmounted, every lit window and LED strip on every landmark
// went permanently dark and nothing reported it — the parts still arrived, the
// materials still carried their emissive COLOUR, and the intensity just stayed
// at 0 forever. Run: npm run test:unit (in website/station-3d).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    statedNightIntensity, NIGHT_STATED_EMISSIVE, NIGHT_STATED_EDGE_LIGHT_FACTOR,
} from '../core/stated-night-lights.js';

test('nothing glows by day', () => {
    // A landmark burning its night windows at noon is as wrong as one dark at
    // midnight, and far more obvious.
    for (const kind of ['litGlass', 'edgeLight', 'glass', 'concrete', 'metal']) {
        assert.equal(statedNightIntensity(kind, false), 0, kind);
    }
});

test('a stated night light comes on after dark', () => {
    assert.ok(statedNightIntensity('litGlass', true) > 0);
    assert.ok(statedNightIntensity('edgeLight', true) > 0);
});

test('LED strips burn hotter than lit windows', () => {
    // Not cosmetic: the strips read as light SOURCES and the windows as rooms
    // behind glass. Equalise them and Cibona loses the thing it is actually
    // recognisable by after dark, because the shaft goes almost black.
    const strip = statedNightIntensity('edgeLight', true);
    const window_ = statedNightIntensity('litGlass', true);
    assert.ok(strip > window_, `edge light ${strip} must exceed lit glass ${window_}`);
    assert.equal(strip, NIGHT_STATED_EMISSIVE * NIGHT_STATED_EDGE_LIGHT_FACTOR);
});

test('a kind nobody has modelled yet still lights up', () => {
    // The set of material kinds is DATA — the server sends whatever the bake
    // stored, and a new landmark may introduce one. An unknown kind must fall
    // back to the ordinary lit level, never to darkness, or the next landmark
    // to invent 'neonSign' ships silently unlit.
    assert.equal(statedNightIntensity('neonSign', true), NIGHT_STATED_EMISSIVE);
    assert.equal(statedNightIntensity(undefined, true), NIGHT_STATED_EMISSIVE);
});
