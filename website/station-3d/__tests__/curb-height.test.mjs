// Verifies that grade-separated curbs keep their explicit vertical owner and
// cannot fall through to a crossing road or terrain during streamed loading.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    curbUnionHasSeparatedOwnersAtLocal,
    curbUnionNeedsSeparatedOwnerChecks,
    resolveCurbOwnerAtLocal,
    resolveCurbSceneYAtLocal,
} from '../core/curb-height.js';

test('only layer-zero mixed unions need client-side owner separation checks', () => {
    assert.equal(curbUnionNeedsSeparatedOwnerChecks({
        verticalLayer: 0,
        osmIds: [17, 18],
        verticalOsmIds: ['17'],
    }), true, 'manual layer-zero alignments can share a planar union with an at-grade road');
    assert.equal(curbUnionNeedsSeparatedOwnerChecks({
        verticalLayer: 1,
        osmIds: [17, 18],
        verticalOsmIds: [17],
    }), false, 'the server already keeps a tagged bridge separate from layer zero');
    assert.equal(curbUnionNeedsSeparatedOwnerChecks({
        verticalLayer: -1,
        osmIds: [17, 18],
        verticalOsmIds: [17],
    }), false, 'the server already keeps a tagged tunnel separate from layer zero');
    assert.equal(curbUnionNeedsSeparatedOwnerChecks({
        verticalLayer: 0,
        osmIds: [17, 18],
        verticalOsmIds: [17, 18],
    }), false, 'a union wholly owned by aligned roads has no lower owner to discover');
});

test('an explicit overpass curb cannot be claimed by the lower road formation', () => {
    let formationCalls = 0;
    const y = resolveCurbSceneYAtLocal({
        x: 10,
        z: 20,
        osmIds: [52916558],
        verticalOsmIds: [52916558],
        roadVerticalAlignments: {
            roadYForOsmIdsAtLocal: (_x, _z, osmIds) => {
                assert.deepEqual(osmIds, [52916558]);
                return 6.5;
            },
        },
        roadFormation: {
            sceneYAtLocal: () => {
                formationCalls += 1;
                return 0;
            },
        },
        terrain: { sceneYAtLocal: () => -1 },
    });

    assert.equal(y, 6.5);
    assert.equal(formationCalls, 0);
});

test('ordinary curbs retain road-formation ownership and terrain evidence fallback', () => {
    const calls = [];
    const formationY = resolveCurbSceneYAtLocal({
        x: 2,
        z: 3,
        osmIds: [52916557, 52916550],
        verticalOsmIds: [],
        roadFormation: {
            sceneYAtLocal: (x, z, options) => {
                calls.push({ x, z, options });
                return 1.25;
            },
        },
        terrain: { evidenceSceneYAtLocal: () => 4 },
    });
    assert.equal(formationY, 1.25);
    assert.deepEqual(calls, [{
        x: 2,
        z: 3,
        options: {
            maxDistanceM: 15,
            osmIds: [52916557, 52916550],
            allowStale: false,
        },
    }]);

    assert.equal(resolveCurbSceneYAtLocal({
        x: 2,
        z: 3,
        roadFormation: { sceneYAtLocal: () => null },
        terrain: { evidenceSceneYAtLocal: () => 4 },
    }), 4);
    assert.equal(resolveCurbSceneYAtLocal({
        x: 2,
        z: 3,
        roadFormation: { sceneYAtLocal: () => null },
        terrain: { sceneYAtLocal: () => 4 },
    }), null, 'visual no-void fallback is not a publishable curb height');
    assert.equal(resolveCurbSceneYAtLocal({
        x: 2,
        z: 3,
        roadFormation: { sceneYAtLocal: () => null },
        terrain: null,
    }), 0, 'an intentional flat world retains its authored scene-zero datum');
});

test('cooperative curb draping can stay on the last published road generation', () => {
    const calls = [];
    const y = resolveCurbSceneYAtLocal({
        x: 8,
        z: 9,
        osmIds: [17],
        allowStaleRoadFormation: true,
        roadFormation: {
            formationAtLocal: (x, z, options) => {
                calls.push({ method: 'owner', x, z, options });
                return null;
            },
            sceneYAtLocal: (x, z, options) => {
                calls.push({ method: 'height', x, z, options });
                return 2.5;
            },
        },
    });

    assert.equal(y, 2.5);
    assert.deepEqual(calls, [
        {
            method: 'owner',
            x: 8,
            z: 9,
            options: { maxDistanceM: 15, osmIds: [17], allowStale: true },
        },
        {
            method: 'height',
            x: 8,
            z: 9,
            options: { maxDistanceM: 15, osmIds: [17], allowStale: true },
        },
    ]);
});

test('a mixed planar union resolves each curb vertex to its nearest vertical owner', () => {
    const alignments = {
        getAlignmentForOsmId: osmId => (
            String(osmId) === '17' ? { id: 'upper' } : null
        ),
        getProfileOwnerForOsmId: osmId => (
            String(osmId) === '17' ? { id: 'upper' } : null
        ),
        roadYAtLocal: (_x, _z, osmId) => (
            String(osmId) === '17' ? 6.5 : null
        ),
    };
    const formation = {
        formationAtLocal: (x, _z, options) => {
            if (Array.isArray(options.osmIds)) {
                return x < 0
                    ? { osmId: 18, roadY: 0, distanceSquared: 0.25 }
                    : { osmId: 17, roadY: 6.5, distanceSquared: 0.25 };
            }
            return String(options.osmId) === '17'
                ? { osmId: 17, roadY: 6.5, distanceSquared: 4 }
                : { osmId: 18, roadY: 0, distanceSquared: 4 };
        },
    };

    assert.deepEqual(resolveCurbOwnerAtLocal({
        x: -1,
        z: 0,
        osmIds: [17, 18],
        verticalOsmIds: [17],
        roadVerticalAlignments: alignments,
        roadFormation: formation,
    }), {
        osmId: '18',
        profileOwnerId: null,
        sceneY: 0,
        vertical: false,
    });
    assert.deepEqual(resolveCurbOwnerAtLocal({
        x: 1,
        z: 0,
        osmIds: [17, 18],
        verticalOsmIds: [17],
        roadVerticalAlignments: alignments,
        roadFormation: formation,
    }), {
        osmId: '17',
        profileOwnerId: 'upper',
        sceneY: 6.5,
        vertical: true,
    });
});

test('a mixed upper/lower union is cut where its nearby owners are vertically separated', () => {
    const alignments = {
        getAlignmentForOsmId: osmId => (
            String(osmId) === '17' ? { id: 'upper' } : null
        ),
        getProfileOwnerForOsmId: osmId => (
            String(osmId) === '17' ? { id: 'upper' } : null
        ),
    };
    const formationAtLocal = (_x, _z, { osmIds }) => {
        const osmId = osmIds[0];
        return String(osmId) === '17'
            ? { osmId: 17, roadY: 6.5, distanceSquared: 9 }
            : { osmId: 18, roadY: 0, distanceSquared: 4 };
    };

    assert.equal(curbUnionHasSeparatedOwnersAtLocal({
        x: 0,
        z: 0,
        osmIds: [17, 18],
        roadVerticalAlignments: alignments,
        roadFormation: { formationAtLocal },
    }), true);
    assert.equal(curbUnionHasSeparatedOwnersAtLocal({
        x: 0,
        z: 0,
        osmIds: [17],
        roadVerticalAlignments: alignments,
        roadFormation: { formationAtLocal },
    }), false);
    assert.equal(curbUnionHasSeparatedOwnersAtLocal({
        x: 0,
        z: 0,
        osmIds: [17, 18],
        roadVerticalAlignments: alignments,
        roadFormation: {
            formationAtLocal: (_x, _z, { osmIds }) => ({
                osmId: osmIds[0],
                roadY: String(osmIds[0]) === '17' ? 0.4 : 0,
                distanceSquared: 4,
            }),
        },
    }), false, 'ordinary sub-metre crossfall must remain one curb union');
});

test('owner separation performs one indexed lookup per vertical category', () => {
    const calls = [];
    const separated = curbUnionHasSeparatedOwnersAtLocal({
        x: 0,
        z: 0,
        osmIds: [17, 19, 18, 20],
        verticalOsmIds: [17, 19],
        roadVerticalAlignments: {
            getAlignmentForOsmId: osmId => (
                [17, 19].includes(Number(osmId)) ? { id: 'upper' } : null
            ),
        },
        roadFormation: {
            formationAtLocal: (_x, _z, { osmIds }) => {
                calls.push(osmIds);
                return {
                    roadY: osmIds.includes('17') ? 6.5 : 0,
                    distanceSquared: 4,
                };
            },
        },
    });

    assert.equal(separated, true);
    assert.deepEqual(calls, [['17', '19'], ['18', '20']]);
});

test('cooperative owner separation can retain the published formation generation', () => {
    const optionsSeen = [];
    const separated = curbUnionHasSeparatedOwnersAtLocal({
        x: 0,
        z: 0,
        osmIds: [17, 18],
        verticalOsmIds: [17],
        allowStaleRoadFormation: true,
        roadVerticalAlignments: {
            getAlignmentForOsmId: osmId => (String(osmId) === '17' ? {} : null),
        },
        roadFormation: {
            formationAtLocal: (_x, _z, options) => {
                optionsSeen.push(options);
                return String(options.osmIds[0]) === '17'
                    ? { roadY: 5, distanceSquared: 1 }
                    : { roadY: 0, distanceSquared: 1 };
            },
        },
    });

    assert.equal(separated, true);
    assert.equal(optionsSeen.length, 2);
    assert.ok(optionsSeen.every(options => options.allowStale === true));
});
