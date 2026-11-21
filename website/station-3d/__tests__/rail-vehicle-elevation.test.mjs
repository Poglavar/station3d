// Rail vehicle elevation has one vertical authority: photo registration, a
// rendered formation, or ground plus a relative profile when neither exists.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    authoredAbsoluteRailGrade,
    authoredAbsoluteRailSceneY,
    composeRailVehicleSceneY,
} from '../core/rail-vehicle-elevation.js';

test('a rendered rail formation absorbs the authored profile instead of adding it twice', () => {
    assert.equal(composeRailVehicleSceneY({
        formationSceneY: -1.65,
        groundSceneY: -1.65,
        relativePoseY: 2.04,
    }), -1.65);
});

test('photo registration wins and a formation-free ride keeps its relative profile', () => {
    assert.equal(composeRailVehicleSceneY({
        photoSceneY: 8.5,
        formationSceneY: 3,
        groundSceneY: 2,
        relativePoseY: 4,
    }), 8.5);
    assert.equal(composeRailVehicleSceneY({
        groundSceneY: 2,
        relativePoseY: 4,
    }), 6);
    assert.equal(composeRailVehicleSceneY({
        walkMode: true,
        photoSceneY: 8.5,
    }), 0);
});

test('an authored EVRF2000 profile stays authoritative while its formation publication catches up', () => {
    const authoredAbsoluteSceneY = authoredAbsoluteRailSceneY({
        elevationM: 18.4,
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        absoluteToSceneY: heightM => heightM - 12,
    });
    assert.ok(Math.abs(authoredAbsoluteSceneY - 6.4) < 1e-12);
    assert.ok(Math.abs(composeRailVehicleSceneY({
        authoredAbsoluteSceneY,
        groundSceneY: 22,
        relativePoseY: 18.4,
    }) - 6.4) < 1e-12);
    assert.equal(composeRailVehicleSceneY({
        formationSceneY: 5.9,
        authoredAbsoluteSceneY,
        groundSceneY: 22,
        relativePoseY: 18.4,
    }), 5.9);
});

test('absolute conversion rejects relative profiles and missing datum conversion', () => {
    assert.equal(authoredAbsoluteRailSceneY({
        elevationM: 18.4,
        elevationMode: 'ground-relative',
        elevationDatum: 'EVRF2000',
        absoluteToSceneY: heightM => heightM - 12,
    }), null);
    assert.equal(authoredAbsoluteRailSceneY({
        elevationM: 18.4,
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
    }), null);
});

test('an authored EVRF2000 pose supplies the cab grade without a spatial formation lookup', () => {
    assert.ok(Math.abs(authoredAbsoluteRailGrade({
        pitchDeg: 0.75,
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
    }) - Math.tan(0.75 * Math.PI / 180)) < 1e-12);
    assert.equal(authoredAbsoluteRailGrade({
        pitchDeg: 0.75,
        elevationMode: 'ground-relative',
        elevationDatum: 'EVRF2000',
    }), null);
});
