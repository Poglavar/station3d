import test from 'node:test';
import assert from 'node:assert/strict';

import {
    sampleRailFormationElevationAslMAtCoordinate,
} from '../core/rail-crossing-elevation.js';

function alignment(id, properties) {
    return { id, feature: { properties } };
}

test('samples the rail alignment with the matching OSM/ref identity before nearest fallback', () => {
    const m604 = alignment('m604:0', { legacyRef: 'M604' });
    const m202 = alignment('m202:0', { legacyRef: 'M202' });
    const railFormation = {
        alignments: [m202, m604],
        toLocal: (lon, lat) => ({ x: lon * 10, z: lat * -10 }),
        formationAtLocal: (_x, _z, { feature } = {}) => {
            if (feature === m604.feature) {
                return {
                    railY: 4.25,
                    distanceSquared: 2.25,
                    structure: 'formation',
                    alignment: { ...m604, authoredAbsolute: true },
                };
            }
            if (feature === m202.feature) {
                return {
                    railY: 40,
                    distanceSquared: 0.01,
                    alignment: m202,
                };
            }
            return {
                railY: 50,
                distanceSquared: 0,
                alignment: alignment('wrong-nearest', {}),
            };
        },
    };

    const sample = sampleRailFormationElevationAslMAtCoordinate({
        railFormation,
        coordinate: [16.4, 43.5],
        anchorElevationAslM: 100,
        composition: { ref: 'M604' },
    });

    assert.equal(sample.elevationAslM, 104.25);
    assert.equal(sample.match, 'rail-ref');
    assert.equal(sample.alignmentId, 'm604:0');
    assert.equal(sample.distanceM, 1.5);
    assert.equal(sample.authoredAbsolute, true);
});

test('uses the nearest canonical route when source identity is unavailable', () => {
    const nearest = alignment('nearest:0', { source: 'legacy-rail' });
    const sample = sampleRailFormationElevationAslMAtCoordinate({
        railFormation: {
            alignments: [nearest],
            toLocal: () => ({ x: 5, z: 6 }),
            formationAtLocal: (_x, _z, { feature } = {}) => feature === nearest.feature ? ({
                railY: -3,
                distanceSquared: 4,
                alignment: nearest,
            }) : null,
        },
        coordinate: [16.4, 43.5],
        anchorElevationAslM: 20,
        composition: { osmId: '123' },
    });

    assert.equal(sample.elevationAslM, 17);
    assert.equal(sample.match, 'nearest-route');
    assert.equal(sample.alignmentId, 'nearest:0');
});

test('never uses a nearby planner alignment as an existing OSM rail counterpart', () => {
    const proposal = alignment('proposal:0', {
        source: 'cb-proposal',
        proposalId: 77,
    });
    const sample = sampleRailFormationElevationAslMAtCoordinate({
        railFormation: {
            alignments: [proposal],
            toLocal: () => ({ x: 5, z: 6 }),
            formationAtLocal: () => ({
                railY: 30,
                distanceSquared: 0,
                alignment: proposal,
            }),
        },
        coordinate: [16.4, 43.5],
        anchorElevationAslM: 100,
        composition: { osmId: '123' },
    });

    assert.equal(sample, null);
});

test('does not jump to a different nearby railway when the identified route misses', () => {
    const m604 = alignment('m604:0', { legacyRef: 'M604' });
    const wrongNearest = alignment('m202:0', { legacyRef: 'M202' });
    const sample = sampleRailFormationElevationAslMAtCoordinate({
        railFormation: {
            alignments: [m604, wrongNearest],
            toLocal: () => ({ x: 5, z: 6 }),
            formationAtLocal: (_x, _z, { feature } = {}) => (
                feature ? null : {
                    railY: 40,
                    distanceSquared: 0,
                    alignment: wrongNearest,
                }
            ),
        },
        coordinate: [16.4, 43.5],
        anchorElevationAslM: 100,
        composition: { ref: 'M604' },
    });

    assert.equal(sample, null);
});

test('preserves an unavailable rail profile as missing evidence', () => {
    assert.equal(sampleRailFormationElevationAslMAtCoordinate({
        railFormation: {
            alignments: [alignment('missing:0', { source: 'legacy-rail' })],
            toLocal: () => ({ x: 0, z: 0 }),
            formationAtLocal: () => null,
        },
        coordinate: [16.4, 43.5],
        anchorElevationAslM: 100,
    }), null);
});
