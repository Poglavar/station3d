// Locks the leut courier boat's authored lines and the shape of its exported
// geometry without loading Three.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LEUT_HELM_EYE, LEUT_HULL_DIMENSIONS, LEUT_MATERIALS, LEUT_WHEELHOUSE, LEUT_Y_STEM, LEUT_Y_STERN,
    buildLeutGeometryData, leutDeckZ, leutHalfBeam, leutKeelZ, leutSheerZ, leutSurfaceX,
} from '../models/vehicles/leut-geometry.js';

test('hull lines: full round midships, fine raked bow, sheer rising to both ends', () => {
    assert.ok(leutHalfBeam(-0.3) > 1.3);
    assert.ok(leutHalfBeam(LEUT_Y_STEM) < 0.06 && leutHalfBeam(LEUT_Y_STERN) < 0.06);
    assert.ok(leutKeelZ(0) < -0.7 && leutKeelZ(0) < leutSheerZ(0) - 1.4);
    assert.ok(leutSheerZ(LEUT_Y_STEM) > leutSheerZ(0) + 0.5, 'bow sheer rises');
    assert.ok(leutSheerZ(LEUT_Y_STERN) > leutSheerZ(0) + 0.15, 'stern sheer rises');
    for (let y = -3.9; y < LEUT_Y_STEM - 0.05; y += 0.1) {
        assert.ok(leutKeelZ(y) < leutSheerZ(y), `keel under the sheer at ${y.toFixed(1)}`);
        assert.ok(leutSurfaceX(y, 0) <= leutHalfBeam(y) + 1e-9, `waterline inside the sheer at ${y.toFixed(1)}`);
    }
    // the stem is raked: the waterline entry sits well aft of the stem head
    assert.ok(leutKeelZ(3.7) < 0 && leutKeelZ(4.3) > 0.4);
    // the deck cambers up toward the centreline
    assert.ok(leutDeckZ(0, 0) > leutDeckZ(0, 1.2) + 0.04);
});

test('exported geometry is finite, mirror-symmetric, boxed by the shared dimensions and merges into five families', () => {
    const data = buildLeutGeometryData();
    const families = new Set(data.groups.map(group => group.family));
    assert.deepEqual([...families].sort(), ['glass', 'hull', 'lamp', 'metal', 'paint']);
    let triangles = 0;
    const box = { x: 0, yMin: Infinity, yMax: -Infinity, z: 0 };
    const columns = new Map();
    for (const group of data.groups) {
        assert.ok(LEUT_MATERIALS[group.material], `known material ${group.material}`);
        assert.equal(group.positions.length, group.normals.length);
        assert.ok(group.positions.every(Number.isFinite) && group.normals.every(Number.isFinite));
        triangles += group.positions.length / 9;
        for (let i = 0; i < group.positions.length; i += 3) {
            box.x = Math.max(box.x, Math.abs(group.positions[i]));
            box.yMin = Math.min(box.yMin, group.positions[i + 1]);
            box.yMax = Math.max(box.yMax, group.positions[i + 1]);
            box.z = Math.max(box.z, Math.abs(group.positions[i + 2]));
            if (group.family === 'hull') {
                // every hull vertex has a mirrored twin on the other side
                const key = `${group.positions[i + 1].toFixed(2)}:${group.positions[i + 2].toFixed(2)}:${Math.abs(group.positions[i]).toFixed(2)}`;
                columns.set(key, (columns.get(key) || 0) + Math.sign(group.positions[i] || 1));
            }
        }
    }
    assert.ok(triangles > 12000 && triangles < 25000, `triangles ${triangles}`);
    assert.ok(box.x <= LEUT_HULL_DIMENSIONS.width / 2 + 0.2, 'fenders may overhang the box a little');
    assert.ok(box.z <= LEUT_HULL_DIMENSIONS.length / 2 + 0.1);
    assert.ok(box.yMin < -0.8 && box.yMin > -1.1, 'keel and rudder below the waterline');
    assert.ok(box.yMax > 4.5 && box.yMax < 5, 'mast top');
    const unbalanced = [...columns.values()].filter(count => Math.abs(count) > 0).length;
    assert.ok(unbalanced / columns.size < 0.02, `hull asymmetry ${unbalanced}/${columns.size}`);
});

test('the helm eye stands inside the wheelhouse below its roof', () => {
    assert.ok(LEUT_HELM_EYE.z > LEUT_WHEELHOUSE.zAft && LEUT_HELM_EYE.z < LEUT_WHEELHOUSE.zFore);
    assert.ok(LEUT_HELM_EYE.y > LEUT_WHEELHOUSE.deckY + 1.2 && LEUT_HELM_EYE.y < LEUT_WHEELHOUSE.roofY);
    assert.ok(Math.abs(leutDeckZ(-LEUT_HELM_EYE.z, 0) - LEUT_WHEELHOUSE.deckY) < 0.05);
});

test('lettering is painted on both bows and follows the name', () => {
    const named = buildLeutGeometryData({ name: 'GALEB', registration: 'VS 7' });
    const plain = buildLeutGeometryData({ name: '', registration: '' });
    const letters = named.groups.find(group => group.material === 'Lettering');
    assert.ok(letters && letters.positions.length > 0);
    assert.equal(plain.groups.find(group => group.material === 'Lettering'), undefined);
    const xs = [];
    for (let i = 0; i < letters.positions.length; i += 3) xs.push(letters.positions[i]);
    assert.ok(Math.min(...xs) < -0.8 && Math.max(...xs) > 0.8, 'lettering on both sides');
    const zs = [];
    for (let i = 2; i < letters.positions.length; i += 3) zs.push(letters.positions[i]);
    assert.ok(Math.min(...zs) > 1.5 && Math.max(...zs) < 3.3, 'lettering sits on the bow');
});

test('a livery repaints only the blue topsides, and an unknown one is refused', () => {
    const blue = buildLeutGeometryData({ name: 'GALEB', registration: 'VS 7' });
    const redBrown = buildLeutGeometryData({ name: 'GALEB', registration: 'VS 7', livery: 'red-brown' });
    assert.equal(redBrown.groups.length, blue.groups.length);
    let repainted = 0;
    blue.groups.forEach((group, index) => {
        const other = redBrown.groups[index];
        assert.equal(other.material, group.material);
        if (group.material === 'HullBlue' || group.material === 'HullBlue2') {
            const [r, g, b] = other.color;
            assert.ok(r > 2 * g && r > 2 * b && r < 0.25, `${group.material} is a dark red-brown, not ${other.color}`);
            repainted += 1;
        } else {
            assert.deepEqual(other.color, group.color, `${group.material} keeps its colour`);
        }
    });
    assert.ok(repainted > 0, 'the blue topsides exist to be repainted');
    assert.throws(() => buildLeutGeometryData({ livery: 'purple' }), /unknown livery/);
});
