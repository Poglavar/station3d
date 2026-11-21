import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createRailCutEdgeEvaluator,
    curbCrossesOpenRailCutAtLocal,
} from '../core/curb-rail-cut.js';

function railCut({ floorY = 10 } = {}) {
    return {
        getSurfaceProfiles: () => [{
            terrainCutoutBounds: {
                minX: -2,
                minZ: -5,
                maxX: 2,
                maxZ: 5,
            },
        }],
        isOpenCutAtLocal: (x, z) => Math.abs(x) <= 2 && Math.abs(z) <= 5,
        civilGroundSceneYAtLocal: () => floorY,
    };
}

test('long curb edges crossing a rail excavation enter exact subdivision', () => {
    const edgeMayTouchCut = createRailCutEdgeEvaluator(railCut(), 0.5);
    assert.equal(edgeMayTouchCut(
        { x: -10, z: 0 },
        { x: 10, z: 0 },
    ), true, 'both endpoints may sit outside while the middle spans the cut');
    assert.equal(edgeMayTouchCut(
        { x: -10, z: 8 },
        { x: 10, z: 8 },
    ), false, 'distant curbs keep the fast path');
});

test('ordinary curb dressing stops over a deep rail cut', () => {
    const formation = railCut({ floorY: 10 });
    assert.equal(curbCrossesOpenRailCutAtLocal({
        x: 0,
        z: 0,
        curbSceneYAtLocal: () => 13,
        railFormation: formation,
    }), true, 'unsupported upper curb cannot bridge an open excavation');
    assert.equal(curbCrossesOpenRailCutAtLocal({
        x: 0,
        z: 0,
        curbSceneYAtLocal: () => 10.3,
        railFormation: formation,
    }), false, 'a road genuinely carried on the cut floor keeps its curb');
    assert.equal(curbCrossesOpenRailCutAtLocal({
        x: 6,
        z: 0,
        curbSceneYAtLocal: () => 13,
        railFormation: formation,
    }), false, 'the rule never clips outside the measured open cut');
});

test('the raised curb band cannot overhang a cut after its face clears it', () => {
    const formation = railCut({ floorY: 10 });
    assert.equal(curbCrossesOpenRailCutAtLocal({
        x: 2.1,
        z: 0,
        normalX: -1,
        normalZ: 0,
        crossSectionOffsetsM: [0, 0.15, 0.3],
        curbSceneYAtLocal: () => 13,
        railFormation: formation,
    }), true);
});
