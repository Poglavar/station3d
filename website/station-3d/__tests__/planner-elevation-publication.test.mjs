import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PLANNER_ELEVATION_PUBLICATION_KEY,
    plannerElevationOpeningClaimInput,
    plannerElevationPublicationCommitted,
    plannerElevationSurfaceClaimInput,
} from '../core/planner-elevation-publication.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    compileSurfaceRenderContract,
} from '../core/surface-hierarchy.js';

test('planner civil meshes declare canonical grade-separated surface semantics', () => {
    const generation = 12;
    const walkway = compileSurfaceClaim(
        plannerElevationSurfaceClaimInput('PlannerEmergencyWalkway', generation),
    );
    assert.equal(walkway.surfaceClass, SURFACE_CLASS.SIDEWALK);
    assert.equal(walkway.verticalRelation, SURFACE_VERTICAL_RELATION.GRADE_SEPARATED);
    assert.equal(walkway.verticalBand, 'elevated');
    assert.equal(walkway.capabilities.support, true);
    assert.equal(walkway.capabilities.backstopCut, false);
    assert.equal(
        compileSurfaceRenderContract(walkway).disabledReason,
        'grade-separated-depth-owned',
    );

    const deck = compileSurfaceClaim(
        plannerElevationSurfaceClaimInput('PlannerViaductDeck', generation),
    );
    assert.equal(deck.surfaceClass, SURFACE_CLASS.STRUCTURE);
    assert.equal(deck.capabilities.support, true);
    assert.equal(deck.capabilities.backstopCut, false);
    assert.equal(
        compileSurfaceRenderContract(deck).disabledReason,
        'grade-separated-depth-owned',
    );

    for (const name of [
        'PlannerLowRampFill',
        'PlannerTunnelFloors',
        'PlannerTunnelInteriorFloors',
    ]) {
        const claim = compileSurfaceClaim(
            plannerElevationSurfaceClaimInput(name, generation),
        );
        assert.equal(claim.capabilities.support, true, name);
        assert.equal(claim.capabilities.backstopCut, true, name);
    }

    const wall = compileSurfaceClaim(
        plannerElevationSurfaceClaimInput('PlannerTrenchWalls', generation),
    );
    assert.equal(wall.verticalBand, 'subsurface');
    assert.equal(wall.capabilities.support, false);
    assert.equal(wall.capabilities.backstopCut, false);
    assert.equal(wall.replacementKey, PLANNER_ELEVATION_PUBLICATION_KEY);
    assert.equal(wall.generation, generation);
});

test('planner openings share the visible generation and fail closed without commit', () => {
    const opening = compileSurfaceClaim(plannerElevationOpeningClaimInput(7));
    assert.equal(opening.coverageState, SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING);
    assert.equal(opening.verticalRelation, SURFACE_VERTICAL_RELATION.GRADE_SEPARATED);
    assert.equal(opening.replacementKey, PLANNER_ELEVATION_PUBLICATION_KEY);
    assert.equal(opening.generation, 7);
    assert.equal(opening.replacementBackstopReady, true);
    assert.equal(opening.capabilities.color, false);
    assert.equal(opening.capabilities.support, true);
    assert.equal(opening.capabilities.backstopCut, true);

    for (const status of [
        'published',
        'published-with-retirement-error',
        'cleared',
        'cleared-with-retirement-error',
    ]) {
        assert.equal(plannerElevationPublicationCommitted(status), true, status);
    }
    for (const status of ['already-active', 'stale-rejected', 'conflict-rejected', 'failed']) {
        assert.equal(plannerElevationPublicationCommitted(status), false, status);
    }
});
