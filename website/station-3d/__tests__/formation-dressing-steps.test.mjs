// Proves the cooperative kernel preserves the frozen v31 geometry while
// keeping skipped/suppressed profile work resumable for the frame scheduler.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildRetainingWallPositionsSteps,
    buildWorldXZUvsForPositions,
    buildWorldXZUvsForPositionsSteps,
    buildFormationSurfaceApronGeometryData,
    buildFormationSurfaceApronGeometryDataSteps,
    buildFormationTerrainCollarGeometryData,
    buildFormationTerrainCollarGeometryDataSteps,
} from '../core/road-formation.js';
import { profile, goldens } from './fixtures/formation-dressing-v31-goldens.mjs';
import { createHash } from 'node:crypto';

function drain(iterator) {
    let step = iterator.next();
    const progress = [];
    while (!step.done) { progress.push(step.value); step = iterator.next(); }
    return { value: step.value, progress };
}

test('retaining wall cooperative steps preserve synchronous geometry', () => {
    const before = JSON.stringify(profile);
    const stepped = drain(buildRetainingWallPositionsSteps(profile));
    const hash = createHash('sha256').update(JSON.stringify(stepped.value)).digest('hex');
    assert.equal(hash, goldens.wall.sha256);
    assert.equal(JSON.stringify(profile), before);
    assert.ok(stepped.progress.length >= profile.points.length);
});

test('apron and steep collar match independent v31 captures', () => {
    const apron = drain(buildFormationSurfaceApronGeometryDataSteps(profile)).value;
    const collar = drain(buildFormationTerrainCollarGeometryDataSteps(profile)).value;
    const hash = x => createHash('sha256').update(JSON.stringify([...x])).digest('hex');
    assert.equal(hash(apron.positions), goldens.apron.sha256);
    assert.equal(hash(apron.uvs), goldens.apron.uvSha256);
    assert.equal(hash(collar.positions), goldens.collar.sha256);
    assert.equal(hash(collar.uvs), goldens.collar.uvSha256);
    assert.deepEqual(apron, buildFormationSurfaceApronGeometryData(profile));
    assert.deepEqual(collar, buildFormationTerrainCollarGeometryData(profile));
});

test('many suppression ranges yield bounded progress before returning pieces', () => {
    for (const builder of [buildRetainingWallPositionsSteps, buildFormationSurfaceApronGeometryDataSteps,
        buildFormationTerrainCollarGeometryDataSteps]) {
        let accesses = 0, total = 0;
        const ranges = Array.from({ length: 1000 }, (_, i) => new Proxy([i / 1000, (i + .5) / 1000], {
            get(target, key, receiver) {
                if (key === '0' || key === '1') accesses++;
                return Reflect.get(target, key, receiver);
            },
        }));
        const iterator = builder({ ...profile, roadOpeningSegmentRanges: [ranges] });
        for (;;) {
            accesses = 0;
            const next = iterator.next();
            assert.ok(accesses <= 2, 'every next() processes at most one suppression range');
            total += accesses;
            if (next.done) break;
            assert.equal(typeof next.value.phase, 'string', 'progress never exposes partially built arrays');
        }
        assert.equal(total, 2000, 'the test advances through every range, beyond the initial yield');
    }
});

test('world UV cooperative steps are bounded and parity preserving', () => {
    const positions = new Float32Array(3 * 257);
    for (let i = 0; i < positions.length; i += 3) { positions[i] = i; positions[i + 2] = -i; }
    const stepped = drain(buildWorldXZUvsForPositionsSteps(positions, 2));
    assert.deepEqual([...stepped.value], [...buildWorldXZUvsForPositions(positions, 2)]);
    assert.equal(stepped.progress.length, 3);
});
