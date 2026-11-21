import test from 'node:test';
import assert from 'node:assert/strict';
import {
    proposalBlockMassing,
    proposalCourtyardRings,
} from '../core/proposal-block-massing.js';
import * as turf from '@turf/turf';

const geometryOps = {
    union: features => turf.union({ type: 'FeatureCollection', features }),
    buffer: (feature, distanceM) => turf.buffer(feature, distanceM, { units: 'meters' }),
    area: feature => turf.area(feature),
};

function rectangle(x0, y0, x1, y1) {
    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
            ]],
        },
    };
}

test('authored block massing is the canonical courtyard source', () => {
    const blockMassing = rectangle(0, 0, 10, 10);
    blockMassing.geometry.coordinates.push([
        [3, 3], [3, 7], [7, 7], [7, 3], [3, 3],
    ]);
    const proposal = {
        geometry: {
            blockMassing,
            buildings: [rectangle(0, 0, 2, 2)],
        },
    };

    assert.deepEqual(proposalBlockMassing(proposal), blockMassing);
    assert.deepEqual(proposalCourtyardRings(proposal), [blockMassing.geometry.coordinates[1]]);
});

test('legacy parcel pieces are unioned once to recover the common courtyard', () => {
    const proposal = {
        geometry: {
            buildings: [
                rectangle(0, 0, 10, 3),
                rectangle(0, 7, 10, 10),
                rectangle(0, 3, 3, 7),
                rectangle(7, 3, 10, 7),
            ],
        },
    };

    const massing = proposalBlockMassing(proposal, geometryOps);
    assert.equal(massing.geometry.type, 'Polygon');
    assert.equal(massing.geometry.coordinates.length, 2, 'outer ring + recovered courtyard');
    assert.equal(proposalCourtyardRings(proposal, geometryOps).length, 1);
});

test('disjoint legacy pieces do not invent a courtyard', () => {
    const proposal = {
        geometry: {
            buildings: [rectangle(0, 0, 2, 2), rectangle(5, 0, 7, 2)],
        },
    };
    assert.equal(proposalBlockMassing(proposal, geometryOps).geometry.type, 'MultiPolygon');
    assert.deepEqual(proposalCourtyardRings(proposal, geometryOps), []);
});

test('a microscopic legacy clipping slit is closed without guessing across a real opening', () => {
    const m = 1 / 111320;
    const x = metres => 15.87 + metres * m;
    const y = metres => 43.75 + metres * m;
    const metreRect = (x0, y0, x1, y1) => rectangle(x(x0), y(y0), x(x1), y(y1));
    const slitHalfWidthM = 0.005;
    const proposal = {
        typologyType: 'block',
        geometry: {
            buildings: [
                metreRect(0, 0, 100, 30),
                metreRect(0, 30, 30, 70),
                metreRect(70, 30, 100, 70),
                metreRect(0, 70, 50 - slitHalfWidthM, 100),
                metreRect(50 + slitHalfWidthM, 70, 100, 100),
            ],
        },
    };
    const raw = turf.union({ type: 'FeatureCollection', features: proposal.geometry.buildings });
    assert.equal(raw.geometry.coordinates.length, 1, 'the slit connects the court to the outside');

    const repaired = proposalBlockMassing(proposal, geometryOps);
    assert.equal(proposalCourtyardRings(proposal, geometryOps).length, 1);
    assert.ok(Math.abs(turf.area(repaired) - turf.area(raw)) < 1);
});
