import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ROAD_TARGET_MAX_ATTEMPTS,
    advanceOnePendingRoadTargetSearch,
    advanceRoadTargetSearchState,
    createRoadTargetSearchState,
} from '../core/pedestrian-road-target-search.js';

test('road target retries retain six attempts while exposing one attempt at a time', () => {
    const search = createRoadTargetSearchState();
    let calls = 0;
    for (let attempt = 1; attempt <= ROAD_TARGET_MAX_ATTEMPTS; attempt++) {
        const outcome = advanceRoadTargetSearchState(search, () => {
            calls += 1;
            return null;
        });
        assert.equal(outcome.attempted, true);
        assert.equal(outcome.status, attempt < ROAD_TARGET_MAX_ATTEMPTS ? 'pending' : 'failed');
        assert.equal(calls, attempt);
    }
    assert.deepEqual(
        advanceRoadTargetSearchState(search, () => { calls += 1; }),
        { attempted: false, status: 'failed', value: null },
    );
    assert.equal(calls, ROAD_TARGET_MAX_ATTEMPTS, 'an exhausted search never performs a seventh attempt');
});

test('road target success is returned atomically and ends the retry sequence', () => {
    const search = createRoadTargetSearchState();
    const route = { destination: { x: 8, z: 5 }, route: [{ x: 8, z: 5 }] };
    const outcome = advanceRoadTargetSearchState(search, () => route);
    assert.deepEqual(outcome, { attempted: true, status: 'success', value: route });
    assert.equal(search.attemptsRemaining, 0);
    assert.equal(
        advanceRoadTargetSearchState(search, () => assert.fail('completed search retried'))
            .attempted,
        false,
    );
});

test('round-robin scheduling performs at most one road target attempt globally', () => {
    const walkers = [
        { id: 'a', roadTargetSearch: createRoadTargetSearchState() },
        { id: 'idle', roadTargetSearch: null },
        { id: 'b', roadTargetSearch: createRoadTargetSearchState() },
    ];
    const visited = [];
    const first = advanceOnePendingRoadTargetSearch(walkers, 0, (walker) => visited.push(walker.id));
    assert.deepEqual(first, { attempts: 1, cursor: 1 });
    assert.deepEqual(visited, ['a']);

    const second = advanceOnePendingRoadTargetSearch(walkers, first.cursor, (walker) => visited.push(walker.id));
    assert.deepEqual(second, { attempts: 1, cursor: 0 });
    assert.deepEqual(visited, ['a', 'b']);
});
