// Sharp curb corners must bevel instead of turning a clamped miter into a
// long diagonal tail. This test stays pure so the join policy is verifiable
// without loading three.js or the streamed curb layer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { prepareCurbTileGeometrySteps } from '../core/curb-tile-geometry.js';

import {
    computeCurbOffsetJoins,
    createCurbProfileRow,
} from '../core/curb-profile.js';

const magnitude = vector => Math.hypot(vector.x, vector.z);
const CURBS = readFileSync(new URL('../world/curbs.js', import.meta.url), 'utf8');
const CAB = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');

test('a gentle corner keeps one exact miter shared by both segments', () => {
    const joins = computeCurbOffsetJoins([
        { x: -1, z: 0 },
        { x: 0, z: 0 },
        { x: 0, z: 1 },
    ], { closed: false, miterLimit: 2 });

    const corner = joins[1];
    assert.equal(corner.beveled, false);
    assert.deepEqual(corner.incoming, corner.outgoing);
    assert.ok(Math.abs(magnitude(corner.incoming) - Math.SQRT2) < 1e-9);
});

test('a 135-degree corner uses bounded segment normals and requests a bevel', () => {
    const joins = computeCurbOffsetJoins([
        { x: -1, z: 0 },
        { x: 0, z: 0 },
        { x: -Math.SQRT1_2, z: Math.SQRT1_2 },
    ], { closed: false, miterLimit: 2 });

    const corner = joins[1];
    assert.ok(corner.rawMiterScale > 2.5);
    assert.equal(corner.beveled, true);
    assert.ok(Math.abs(magnitude(corner.incoming) - 1) < 1e-9);
    assert.ok(Math.abs(magnitude(corner.outgoing) - 1) < 1e-9);
    assert.notDeepEqual(corner.incoming, corner.outgoing);
    assert.match(CURBS, /computeCurbOffsetJoins\(points,/);
    assert.match(CURBS, /pushCurbBevelJoin\(curb,/);
});

test('open-run endpoints use their one adjacent segment normal', () => {
    const joins = computeCurbOffsetJoins([
        { x: 0, z: 0 },
        { x: 2, z: 0 },
    ], { closed: false, miterLimit: 2 });

    assert.deepEqual(joins[0].incoming, { x: 0, z: 1 });
    assert.deepEqual(joins[0].outgoing, { x: 0, z: 1 });
    assert.deepEqual(joins[1].incoming, { x: 0, z: 1 });
    assert.deepEqual(joins[1].outgoing, { x: 0, z: 1 });
});

test('fallback curb terrain collar shares the stone edge and tucks under DGU ground', () => {
    const row = createCurbProfileRow(
        { x: 4, z: 7 },
        { x: 0, z: 1 },
        {
            u: 2,
            bandWidthM: 0.3,
            rampWidthM: 1,
            curbTopY: 0.18,
            terrainOverlapM: 0.035,
        },
    );

    assert.deepEqual(row.b, { x: 4, y: 0.18, z: 7.3 });
    assert.deepEqual(row.r, { x: 4, y: 0, z: 8.3 });
    assert.deepEqual(row.terrainLanding, { x: 4, y: -0.035, z: 8.3 });
    assert.match(
        CURBS,
        /backProfile === 'terrain-seam'[\s\S]{0,500}pushRampQuad\([\s\S]{0,120}terrainSeam,[\s\S]{0,180}a\.b,[\s\S]{0,80}b\.b,[\s\S]{0,120}a\.terrainLanding,[\s\S]{0,120}b\.terrainLanding/,
        'the terrain collar must begin on the exact rear curb vertices',
    );
    assert.doesNotMatch(
        CURBS,
        /roadFormationDressingAtLocal/,
        'a lower civil batter must not replace the raised-side infill with an exposed rear face',
    );
    const material = new THREE.MeshBasicMaterial();
    const seamPositions = [row.b.x, row.b.y, row.b.z, row.terrainLanding.x, row.terrainLanding.y, row.terrainLanding.z,
        row.b.x + 1, row.b.y, row.b.z];
    const steps = prepareCurbTileGeometrySteps({ tileKey: 'collar', bounds: {},
        curb: { positions: [4, .18, 7, 4, .18, 7.3, 5, .18, 7], uvs: [0, 0, 0, 1, 1, 0] },
        ramp: { positions: [] }, greenRamp: { positions: [] }, terrainSeam: { positions: seamPositions } }, {
        materials: { curb: material, terrainSeam: material }, uvPerM: { terrainSeam: 1 },
    });
    let next; do { next = steps.next(); } while (!next.done);
    const output = next.value, seam = output.root.getObjectByName('CurbTerrainSeam');
    assert.equal(seam.userData.walkableSurface, true);
    assert.equal(output.collisionSurface.additionalPositions[0], seam.geometry.attributes.position.array,
        'vehicle collision uses the exact visible raised-side triangles');
    assert.deepEqual([...seam.geometry.attributes.position.array], [...new Float32Array(seamPositions)]);
    output.root.traverse(object => object.geometry?.dispose()); material.dispose();
    assert.match(
        CAB,
        /group:\s*getCurbsGroupForWalkSupport\(\)[\s\S]{0,220}name === 'CurbTerrainSeam'[\s\S]{0,80}name === 'CurbProfile'/,
        'walk ground must resolve against the visible curb top and raised-side triangles',
    );
});

test('parking curbs close behind the stone instead of projecting a one-metre ramp', () => {
    const parkingStart = CURBS.indexOf('function appendParkingRingGeometry(');
    assert.notEqual(parkingStart, -1);
    const parkingSource = CURBS.slice(parkingStart, parkingStart + 4400);
    assert.match(parkingSource, /appendRunGeometry\([\s\S]{0,260}backProfile:\s*'vertical'/,
        'parking and tree-island outlines must not paint synthetic sidewalk wedges');
    assert.match(CURBS, /if \(backProfile === 'vertical'\)[\s\S]{0,420}pushQuad\(curb,/,
        'the removed ramp is replaced by a closed curb-stone back face');
});

test('masked open curb runs close both exposed cross-sections', () => {
    const appendStart = CURBS.indexOf('function appendRunGeometry(');
    assert.notEqual(appendStart, -1);
    const appendSource = CURBS.slice(appendStart, appendStart + 9000);
    assert.match(
        appendSource,
        /if \(!run\.closed\) \{[\s\S]{0,260}pushCurbRunEndCap\(curb, rows\[0\]\.outgoing,[\s\S]{0,180}pushCurbRunEndCap\(curb, rows\[n - 1\]\.incoming,/,
        'parking/crossing ownership splits must not leave hollow curb ends',
    );
    assert.match(
        CURBS,
        /const rearBottom = backProfile === 'vertical'[\s\S]{0,120}\? row\.terrainLanding[\s\S]{0,40}: row\.r;/,
        'the cap must close parking backs, DGU terrain collars, and ordinary curb ramps',
    );
});
