import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const carsSource = await readFile(new URL('../world/cars.js', import.meta.url), 'utf8');

test('parked cars are re-seated after their streamed road formation changes', () => {
    const queueStart = carsSource.indexOf('function queueParkedCarsForFormationRevision');
    const drainStart = carsSource.indexOf('function drainParkedCarReseats');
    const frameStart = carsSource.indexOf('    onFrame(pose, local, dt) {');
    const frameEnd = carsSource.indexOf('    endSession()', frameStart);
    assert.ok(queueStart >= 0);
    assert.ok(drainStart > queueStart);
    assert.ok(frameStart > drainStart);
    assert.ok(frameEnd > frameStart);

    const queueSource = carsSource.slice(queueStart, drainStart);
    assert.match(queueSource, /roadFormationModel\.getChangesSince\(parkedFormationRevision\)/);
    assert.match(queueSource, /PARKED_FORMATION_CHANGE_PAD_M/);
    assert.match(queueSource, /\.filter\(car => !car\.controlled\)/);
    assert.match(queueSource, /\.sort\(\(left, right\)/);

    const frameSource = carsSource.slice(frameStart, frameEnd);
    assert.match(frameSource, /queueParkedCarsForFormationRevision\(local\.x, local\.z\)/);
    assert.match(frameSource, /drainParkedCarReseats\(\)/);
    assert.ok(
        frameSource.indexOf('drainParkedCarReseats()') < frameSource.indexOf('if (!dt || dt <= 0)'),
        'stationary frames must still publish corrected parked-car heights',
    );

    const drainSource = carsSource.slice(drainStart, frameStart);
    assert.match(drainSource, /function drainParkedCarReseats\(maxCars = 10\)/);
    assert.match(drainSource, /placeCarOnTerrain\(car\)/);
});
