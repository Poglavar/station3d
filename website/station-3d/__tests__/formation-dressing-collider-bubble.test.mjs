// A formation dressing collider owes complete support inside its bubble only.
// Long corridors that merely touch the bubble must not exhaust the triangle
// budget (the Zagreb car start failed this way), and nearby-profile queries
// must find collars through the civil bounds the dressing actually occupies.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoadFormationDressingTrimeshData } from '../core/gta-road-surface.js';
import { RoadFormationModel } from '../core/road-formation.js';
import { RailFormationModel } from '../core/rail-formation.js';

// A straight dressed strip from x0 to x1, sampled every stepM on both sides.
function stripProfile({ x0 = 0, x1 = 2000, stepM = 4, osmId = 'strip' } = {}) {
    const side = (x, sign) => ({
        innerX: x, innerZ: sign * 1, roadY: 0,
        outerX: x, outerZ: sign * 2, terrainY: 0.2, wallTerrainY: -0.2,
        cutoutX: x, cutoutZ: sign * 2.5, cutoutTerrainY: 0.2,
        overlapX: x, overlapZ: sign * 3, overlapTerrainY: 0.2,
    });
    const xs = [];
    for (let x = x0; x <= x1; x += stepM) xs.push(x);
    const points = [...xs.map(x => side(x, -1)), ...xs.toReversed().map(x => side(x, 1))];
    const n = points.length;
    return {
        osmId,
        bounds: { minX: x0, minZ: -1, maxX: x1, maxZ: 1 },
        outerBounds: { minX: x0, minZ: -2, maxX: x1, maxZ: 2 },
        terrainCutoutBounds: { minX: x0, minZ: -2.5, maxX: x1, maxZ: 2.5 },
        overlapBounds: { minX: x0, minZ: -3, maxX: x1, maxZ: 3 },
        internalSegments: new Array(n).fill(false),
        collarInternalSegments: new Array(n).fill(false),
        roadOpeningSegmentRanges: Array.from({ length: n }, () => []),
        formationDressingDisabled: false,
        points,
    };
}

function trianglesOf(data) {
    const out = [];
    for (let i = 0; i < data.indices.length; i += 3) {
        const tri = [];
        for (let k = 0; k < 3; k++) {
            const v = data.indices[i + k] * 3;
            tri.push(data.vertices[v], data.vertices[v + 1], data.vertices[v + 2]);
        }
        out.push(tri.map(value => value.toFixed(4)).join(','));
    }
    return out;
}

test('a long corridor touching the bubble spends budget only on in-bubble triangles', () => {
    const profile = stripProfile();
    const unclipped = buildRoadFormationDressingTrimeshData({ profiles: [profile],
        centerX: 1000, centerZ: 0, radiusM: 1e6, maxTriangles: 1e7 });
    const bubble = buildRoadFormationDressingTrimeshData({ profiles: [profile],
        centerX: 1000, centerZ: 0, radiusM: 110, maxTriangles: 8000 });
    assert.ok(unclipped.triangleCount > 8000, `fixture must exceed the old budget (${unclipped.triangleCount})`);
    assert.equal(bubble.truncated, false);
    assert.ok(bubble.triangleCount > 0 && bubble.triangleCount < unclipped.triangleCount / 5,
        `bubble kept ${bubble.triangleCount} of ${unclipped.triangleCount}`);
    assert.equal(bubble.requiredTriangles, bubble.triangleCount);
    for (let i = 0; i < bubble.indices.length; i += 3) {
        const xs = [0, 1, 2].map(k => bubble.vertices[bubble.indices[i + k] * 3]);
        assert.ok(Math.min(...xs) <= 1110 && Math.max(...xs) >= 890, 'every stored triangle reaches the disc');
    }
});

test('clipping keeps every triangle that intersects the disc, including edge-straddlers', () => {
    const profile = stripProfile({ x0: 0, x1: 400, stepM: 4 });
    const all = new Set(trianglesOf(buildRoadFormationDressingTrimeshData({ profiles: [profile],
        centerX: 200, centerZ: 0, radiusM: 1e6, maxTriangles: 1e7 })));
    const kept = trianglesOf(buildRoadFormationDressingTrimeshData({ profiles: [profile],
        centerX: 200, centerZ: 0, radiusM: 50, maxTriangles: 1e6 }));
    const expected = [...all].filter(key => {
        const v = key.split(',').map(Number);
        const pts = [[v[0], v[2]], [v[3], v[5]], [v[6], v[8]]];
        // Brute force: sample each triangle densely and ask whether any sample lies in the disc.
        for (let a = 0; a <= 20; a++) for (let b = 0; a + b <= 20; b++) {
            const u = a / 20, w = b / 20, t = 1 - u - w;
            const x = pts[0][0] * t + pts[1][0] * u + pts[2][0] * w;
            const z = pts[0][1] * t + pts[1][1] * u + pts[2][1] * w;
            if (Math.hypot(x - 200, z) <= 50) return true;
        }
        return false;
    });
    const keptSet = new Set(kept);
    for (const key of expected) assert.ok(keptSet.has(key), `in-disc triangle dropped: ${key}`);
    assert.ok(kept.some(key => { const v = key.split(',').map(Number);
        return Math.min(v[0], v[3], v[6]) > 250 || Math.max(v[0], v[3], v[6]) < 150; }) === false,
    'triangles wholly outside the disc are not stored');
});

test('a bubble that genuinely needs more than its budget reports the required count', () => {
    const profiles = Array.from({ length: 12 }, (_, i) => ({ ...stripProfile({ x0: -150, x1: 150, osmId: `p${i}` }) }));
    const data = buildRoadFormationDressingTrimeshData({ profiles, centerX: 0, centerZ: 0,
        radiusM: 110, maxTriangles: 500 });
    assert.equal(data.truncated, true);
    assert.equal(data.triangleCount, 500);
    assert.ok(data.requiredTriangles > 500, `required ${data.requiredTriangles}`);
    assert.equal(data.candidateProfiles, 12);
});

test('road dressing queries find a collar through its civil bounds, not only the paved ring', () => {
    const profile = stripProfile({ x0: 0, x1: 100 });
    // Paved ring ends at z=1; the civil overlap ring reaches z=3.
    const civilIndex = new Map([['0_0', [profile]]]);
    const fake = { _ensureBuilt() {}, _civilGroundProfileIndex: civilIndex };
    const near = RoadFormationModel.prototype.dressingProfilesNear.call(fake, 50, 5.5, 2.6);
    assert.deepEqual(near, [profile], 'collar within 2.6 m of the query is found');
    assert.deepEqual(RoadFormationModel.prototype.dressingProfilesNear.call(fake, 50, 9, 2.6), []);
    assert.deepEqual(RoadFormationModel.prototype.dressingProfilesNear.call(fake, NaN, 0, 5), []);
});

test('rail dressing queries use the bounded envelope index instead of every profile', () => {
    const near = stripProfile({ x0: 0, x1: 30, osmId: 'near' });
    const far = stripProfile({ x0: 4000, x1: 4030, osmId: 'far' });
    const index = new Map([['0_0', [near]], ['100_0', [far]], ['-1_-1', [near]]]);
    const fake = { surfaceProfileIndex: index };
    assert.deepEqual(RailFormationModel.prototype.dressingProfilesNear.call(fake, 10, 0, 112), [near]);
    assert.deepEqual(RailFormationModel.prototype.dressingProfilesNear.call(fake, 2000, 0, 112), []);
});
