// The oriented fit that sizes and turns a stop shelter to its footprint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orientedFootprintFit } from '../core/shelter-fit.js';

const LAT = 45.78;
const LON = 15.98;
const M_LAT = (Math.PI / 180) * 6378137;
const M_LON = M_LAT * Math.cos((LAT * Math.PI) / 180);
// A ring built from local metre offsets around the anchor.
const ring = (offsets) => offsets.map(([east, north]) => [LON + east / M_LON, LAT + north / M_LAT]);

test('an east-west shelter footprint fits with its long axis on X', () => {
    const fit = orientedFootprintFit(ring([[0, 0], [5, 0], [5, 2], [0, 2], [0, 0]]), LAT, LON);
    assert.ok(Math.abs(fit.lengthM - 5) < 0.01);
    assert.ok(Math.abs(fit.depthM - 2) < 0.01);
    // Long axis due east: local +X must map onto it, so angleY ≈ 0 (mod π).
    const normalized = ((fit.angleY % Math.PI) + Math.PI) % Math.PI;
    assert.ok(normalized < 0.01 || Math.PI - normalized < 0.01);
    // Centre at (2.5 east, 1 north) → scene z is NEGATIVE north.
    assert.ok(Math.abs(fit.x - 2.5) < 0.01);
    assert.ok(Math.abs(fit.z + 1) < 0.01);
});

test('a rotated footprint keeps its true dimensions and heading', () => {
    // 6×1.8 m at 30°: corners via the rotation.
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const corners = [[0, 0], [6, 0], [6, 1.8], [0, 1.8]].map(([x, y]) => [x * c - y * s, x * s + y * c]);
    const fit = orientedFootprintFit(ring([...corners, corners[0]]), LAT, LON);
    assert.ok(Math.abs(fit.lengthM - 6) < 0.02);
    assert.ok(Math.abs(fit.depthM - 1.8) < 0.02);
    // rotation.y maps local +X to (cosθ, −sinθ); the long axis runs 30° north
    // of east, so θ ≡ +30° — modulo π, because a symmetric shelter has no
    // front-to-back and the fit may walk the long edge in either direction.
    const delta = ((fit.angleY - Math.PI / 6) % Math.PI + Math.PI) % Math.PI;
    assert.ok(delta < 0.01 || Math.PI - delta < 0.01);
});

test('degenerate rings produce null, never a guess', () => {
    assert.equal(orientedFootprintFit(null, LAT, LON), null);
    assert.equal(orientedFootprintFit([[15.98, 45.78]], LAT, LON), null);
    assert.equal(orientedFootprintFit([[15.98, 45.78], [15.98, 45.78], [15.98, 45.78]], LAT, LON), null);
    assert.equal(orientedFootprintFit([[15.98, Number.NaN], [15.99, 45.78], [15.98, 45.79]], LAT, LON), null);
});
