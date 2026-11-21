import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildUrbanCoastGeometryData,
    buildUrbanCoastGeometryData as buildGeometry,
    createUrbanCoastLandingSampler,
    resolveUrbanCoastSection,
    splitLongCoastQuads,
} from '../core/urban-coast-formation.js';

const quad = {
    shoreA: [0, 0],
    shoreB: [0, 2],
    landA: [-4.5, 0],
    landB: [-4.5, 2],
};

test('missing coastal evidence is not a zero-height landing above a recessed sea', () => {
    for (const [road, terrain] of [[null, null], [0, null], [null, 0]]) {
        assert.equal(resolveUrbanCoastSection(quad, {
            seaY: -1,
            sampleRoadY: () => road,
            sampleTerrainY: () => terrain,
        }), null);
    }
    assert.ok(resolveUrbanCoastSection(quad, {
        seaY: -1,
        sampleRoadY: () => 0,
        sampleTerrainY: () => 0,
    }), 'real zero-height road and terrain evidence remain valid');
});

test('a narrow same-grade road-backed shoreline resolves to a flat quay', () => {
    const section = resolveUrbanCoastSection(quad, {
        seaY: 0,
        sampleRoadY: x => x <= -8 && x >= -12 ? 1.1 : null,
        sampleTerrainY: () => 1.0,
    });

    assert.ok(section);
    assert.equal(section.topAY, 1.1);
    assert.equal(section.topBY, 1.1);
    assert.ok(section.widthAM > 8 && section.widthAM < 10);
    assert.deepEqual(section.shoreA, [0, 0]);
    assert.ok(section.landA[0] < -8);

    const geometry = buildUrbanCoastGeometryData([section], { seaY: 0 });
    assert.equal(geometry.sectionCount, 1);
    assert.equal(geometry.topPositions.length, 18);
    assert.equal(geometry.topUvs.length, 12);
    assert.equal(geometry.wallPositions.length, 18);
    assert.ok(Math.abs(
        Math.min(...geometry.wallPositions.filter((_, i) => i % 3 === 1)) + 0.8,
    ) < 1e-6);
});

test('natural shore, explicit beach, raised bridge, and cliff road remain unformed', () => {
    assert.equal(resolveUrbanCoastSection(quad, {
        sampleRoadY: () => null,
        sampleTerrainY: () => 0.2,
    }), null);
    assert.equal(resolveUrbanCoastSection(quad, {
        seaY: 0,
        sampleRoadY: () => 1,
        sampleTerrainY: () => 1,
        explicitBeachAt: () => true,
    }), null);
    assert.equal(resolveUrbanCoastSection(quad, {
        seaY: 0,
        sampleRoadY: () => 7,
        sampleTerrainY: () => 1,
    }), null);
    assert.equal(resolveUrbanCoastSection(quad, {
        seaY: 0,
        sampleRoadY: () => 1.2,
        sampleTerrainY: () => 4.5,
    }), null);
});

test('a road merely near one endpoint cannot classify the entire coast segment', () => {
    const section = resolveUrbanCoastSection(quad, {
        seaY: 0,
        sampleRoadY: (_x, z) => z < 0.25 ? 1 : null,
        sampleTerrainY: () => 1,
    });
    assert.equal(section, null);
});

test('a quay reaches beyond the coast infill before meeting inland terrain', () => {
    const section = resolveUrbanCoastSection(quad, {
        seaY: 0,
        sampleRoadY: x => x <= -1 ? 1.1 : null,
        sampleTerrainY: () => 1.05,
    });

    assert.ok(section);
    assert.ok(section.widthAM > 5.25,
        'the deck overlaps beyond the 4.5 m terrain-collar boundary');
    assert.ok(section.landA[0] < -5.25);
});

test('adjacent quay sections explicitly fill the inland corner between them', () => {
    const sections = [
        {
            shoreA: [0, 0],
            shoreB: [0, 2],
            landA: [-5.4, -0.4],
            landB: [-5.2, 1.6],
            topAY: 1,
            topBY: 1.1,
        },
        {
            shoreA: [0, 2],
            shoreB: [1, 4],
            landA: [-4.8, 2.5],
            landB: [-3.7, 4.8],
            topAY: 1.1,
            topBY: 1.2,
        },
    ];

    const geometry = buildUrbanCoastGeometryData(sections, { seaY: 0 });
    assert.equal(geometry.sectionCount, 2);
    assert.equal(geometry.joinCount, 1);
    assert.equal(geometry.topPositions.length, 45,
        'four deck triangles plus one explicit corner join');
});

test('painted pedestrian ground is a firm landing on terrain evidence; mesh support still wins', () => {
    const sampler = createUrbanCoastLandingSampler({
        sampleRoadY: x => (x <= -8 && x >= -12 ? 1.1 : null),
        pavedGroundAt: x => x > -8,
        sampleTerrainY: () => 0.7,
        liftM: 0.012,
    });
    assert.equal(sampler(-9, 0), 1.1, 'a road mesh keeps its own height');
    assert.ok(Math.abs(sampler(-3, 0) - 0.712) < 1e-9, 'painted paving rests on terrain plus the collar lift');
    assert.equal(sampler(-13, 0), null, 'bare ground is not a landing');
    // Missing terrain evidence under paint is not a zero-height landing.
    assert.equal(createUrbanCoastLandingSampler({
        pavedGroundAt: () => true, sampleTerrainY: () => null, liftM: 0.012,
    })(0, 0), null);
    // Anything short of a boolean yes leaves the sample unpaved.
    for (const paved of [undefined, null, () => undefined, () => 1, () => 'yes']) {
        assert.equal(createUrbanCoastLandingSampler({ pavedGroundAt: paved, sampleTerrainY: () => 0.7 })(0, 0), null);
    }
});

test('a painted promenade resolves to a quay whose deck is the painted terrain', () => {
    // Split's Riva after receiver paving: no road mesh within reach, paving
    // everywhere inland, DGU terrain 0.7 m above the sea.
    const section = resolveUrbanCoastSection(quad, {
        seaY: -1,
        sampleRoadY: createUrbanCoastLandingSampler({
            sampleRoadY: () => null, pavedGroundAt: () => true, sampleTerrainY: () => -0.3, liftM: 0.012,
        }),
        sampleTerrainY: () => -0.3,
    });
    assert.ok(section, 'the promenade is a firm landing');
    assert.ok(Math.abs(section.topAY - (-0.288)) < 1e-9);
    assert.ok(Math.abs(section.topBY - (-0.288)) < 1e-9);
    assert.equal(resolveUrbanCoastSection(quad, {
        seaY: -1, sampleRoadY: () => null, sampleTerrainY: () => -0.3,
    }), null, 'without the sampler the same shore stays a collar');
});

test('a long straight quay is classified in DTM-sized pieces that share their nodes exactly', () => {
    const long = { shoreA: [0, 0], shoreB: [133, 0], landA: [0, -4.5], landB: [133, -4.5] };
    const pieces = splitLongCoastQuads([long], 24);
    assert.equal(pieces.length, 6);
    assert.deepEqual(pieces[0].shoreA, [0, 0]);
    assert.deepEqual(pieces[5].shoreB, [133, 0]);
    for (let i = 1; i < pieces.length; i++) {
        assert.equal(pieces[i].shoreA, pieces[i - 1].shoreB, 'consecutive pieces share the same node array');
        assert.equal(pieces[i].landA, pieces[i - 1].landB);
    }
    // Short quads and malformed ones pass through untouched.
    const short = { shoreA: [0, 0], shoreB: [10, 0], landA: [0, -4.5], landB: [10, -4.5] };
    assert.equal(splitLongCoastQuads([short], 24)[0], short);
    assert.equal(splitLongCoastQuads([{ shoreA: [0, 0] }], 24)[0].shoreB, undefined);
    // The deck of the pieces follows the ground; one long section could not.
    const terrain = (x) => -0.3 + 0.3 * Math.sin(x / 40);
    const sections = pieces.map(piece => resolveUrbanCoastSection(piece, {
        seaY: -1, sampleRoadY: (x) => terrain(x) + 0.012, sampleTerrainY: (x) => terrain(x),
    })).filter(Boolean);
    assert.equal(sections.length, 6);
    const geometry = buildGeometry(sections, { seaY: -1 });
    assert.equal(geometry.sectionCount, 6);
    assert.equal(geometry.joinCount, 0, 'collinear pieces need no bend joins');
    const whole = resolveUrbanCoastSection(long, {
        seaY: -1, sampleRoadY: (x) => terrain(x) + 0.012, sampleTerrainY: (x) => terrain(x),
    });
    const worstStep = Math.max(...sections.map(s => Math.abs(s.topAY - (terrain(s.shoreA[0]) + 0.012))));
    const wholeStep = Math.max(...pieces.map(p => Math.abs(whole.topAY + (whole.topBY - whole.topAY) * (p.shoreA[0] / 133) - (terrain(p.shoreA[0]) + 0.012))));
    assert.ok(worstStep < 0.05 && wholeStep > 0.2, `pieces ${worstStep.toFixed(3)} vs whole ${wholeStep.toFixed(3)}`);
});

test('the deck stands at the apron\'s highest ground behind the first landing, not at a DTM dip', () => {
    // Measured on the Riva: no evidence for 3 m, then -0.09, -0.05, 0.00, then +0.01.
    const ground = d => (d < 4 ? null : d < 5 ? -0.09 : d < 6 ? -0.05 : d < 7 ? 0.0 : 0.01);
    const along = x => ground(-x); // the land lies towards -x from the quad's shore
    const section = resolveUrbanCoastSection(quad, {
        seaY: -0.738,
        sampleRoadY: x => (along(x) === null ? null : along(x) + 0.012),
        sampleTerrainY: x => along(x),
    });
    assert.ok(section);
    assert.ok(Math.abs(section.topAY - 0.022) < 1e-9, `deck at ${section.topAY}`);
    // The deck still starts at the first landing, so it overlaps the collar as before.
    assert.ok(section.widthAM > 4.4 && section.widthAM < 5.5, `width ${section.widthAM}`);
    // Ground beyond the apron cannot raise the deck (a higher street behind the promenade).
    const withStreet = resolveUrbanCoastSection(quad, {
        seaY: -0.738,
        sampleRoadY: x => (-x > 12 ? 1.5 : along(x) === null ? null : along(x) + 0.012),
        sampleTerrainY: x => (-x > 12 ? 1.5 : along(x)),
    });
    assert.ok(Math.abs(withStreet.topAY - 0.022) < 1e-9);
});
