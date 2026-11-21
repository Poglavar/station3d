import assert from 'node:assert/strict';
import test from 'node:test';

import {
    trafficRouteBaseSceneYAtLocal,
    trafficRouteFormationId,
} from '../core/traffic-route-elevation.js';

test('proposal traffic keeps its graph id separate from its formation owner', () => {
    const segment = {
        osmId: 'proposal-781-line-0',
        formationOsmId: 'proposal-road:781:s34:0',
    };
    assert.equal(trafficRouteFormationId(segment), 'proposal-road:781:s34:0');

    const queries = [];
    const sceneY = trafficRouteBaseSceneYAtLocal({
        x: 220,
        z: 174,
        segment,
        terrainSceneY: -1.8,
        roadFormation: {
            formationAtLocal(x, z, options) {
                queries.push({ x, z, options });
                return options.osmId === 'proposal-road:781:s34:0'
                    ? { roadY: 1.174 }
                    : null;
            },
        },
    });

    assert.equal(sceneY, 1.174,
        'the canonical route grade must win over terrain below the coastal road');
    assert.deepEqual(queries, [{
        x: 220,
        z: 174,
        options: { osmId: 'proposal-road:781:s34:0', allowStale: true },
    }]);
});

test('ordinary traffic falls back to evidenced terrain until its own formation exists', () => {
    const segment = { osmId: 42 };
    assert.equal(trafficRouteFormationId(segment), 42);
    assert.equal(trafficRouteBaseSceneYAtLocal({
        x: 5,
        z: 9,
        segment,
        terrainSceneY: 3.5,
        roadFormation: { formationAtLocal: () => null },
    }), 3.5);
    assert.equal(trafficRouteBaseSceneYAtLocal({
        x: 5,
        z: 9,
        segment,
        terrainSceneY: null,
        roadFormation: { formationAtLocal: () => null },
    }), null, 'missing terrain must remain missing, never become an imaginary zero floor');
});
