// Guards the two crowd operations that previously synchronized expensive work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../world/pedestrians.js', import.meta.url), 'utf8');

test('pedestrian population and terrain refresh stay bounded across frames', () => {
    const population = source.slice(
        source.indexOf('function maintainPopulation'),
        source.indexOf('function soundNearbyDog'),
    );
    assert.doesNotMatch(population, /while \(/);
    assert.match(population, /if \(preferRoof\)/);
    assert.match(population, /else if \(needsGround && spawnPoints\.length > 0\)/);
    assert.match(population, /if \(spawn\) createWalker\(spawn\.x, spawn\.z, 1, \{ roofSurfaceId: surface\.id \}\)/);
    assert.match(population, /if \(spawn\) createWalker\(spawn\.x, spawn\.z, size\)/);
    assert.match(source, /POPULATION_FILL_INTERVAL_S/);
    assert.match(source, /prepareAmbientPersonMeshAssets\(\)/);
    assert.match(source, /prepareDogMeshAssets\(\)/);

    const terrainChangeStart = source.indexOf(
        'terrainChangeSubscription = activeTerrainReference',
    );
    const terrainChange = source.slice(
        terrainChangeStart,
        source.indexOf('renderedGroundYAt =', terrainChangeStart),
    );
    assert.match(terrainChange, /feetGroundCache\.invalidateStaggered/);
    assert.doesNotMatch(terrainChange, /feetGroundCache\.clear\(\)/);
    assert.doesNotMatch(terrainChange, /for \(const walker of walkers\)/);
});

test('pedestrian frame evidence names population and walker costs', () => {
    for (const phase of ['doors', 'population', 'audio', 'walkers']) {
        assert.match(source, new RegExp(`recordLayerFrameMs\\('pedestrians:${phase}'`));
    }
});

test('ambient walker support and route work is split into stable phases', () => {
    assert.match(source, /const PEDESTRIAN_UPDATE_PHASES = 4/);
    assert.match(source, /updatePhase: pedestrianUpdateSerial\+\+ % PEDESTRIAN_UPDATE_PHASES/);
    assert.match(source, /walker\.pendingDt = Math\.min\(0\.12/);
    assert.match(source, /if \(walker\.updatePhase !== pedestrianUpdatePhase\) continue/);
    assert.match(source, /pedestrianUpdatePhase = \(pedestrianUpdatePhase \+ 1\) % PEDESTRIAN_UPDATE_PHASES/);
});

test('roof target searches share a strict resumable frame budget', () => {
    assert.match(source, /const ROOF_TARGET_PROBES_PER_FRAME = 96/);
    assert.match(source, /const ROOF_TARGET_PROBES_PER_WALKER = 16/);
    assert.match(source, /roofActivityTargetSearchSteps/);
    assert.match(source, /advanceRoofTargetSearches\(\)/);
    assert.match(source, /targetKind = 'roof-search'/);
    assert.match(source, /recordLayerFrameMs\('pedestrians:roofTargets'/);
    const assignment = source.slice(
        source.indexOf('function assignRoofTarget'),
        source.indexOf('function assignWalkerTarget'),
    );
    assert.doesNotMatch(assignment, /for \(let attempt/);
    assert.doesNotMatch(assignment, /sampleRoofActivityPoint\(/);
});

test('ground target searches retain six tries under one global attempt per frame', () => {
    assert.match(source, /createRoadTargetSearchState\(\)/);
    assert.match(source, /advanceOnePendingRoadTargetSearch\(/);
    assert.match(source, /targetKind = 'road-search'/);
    assert.match(source, /recordLayerFrameMs\('pedestrians:roadTargets'/);
    const assignment = source.slice(
        source.indexOf('function assignRoadTarget'),
        source.indexOf('function advanceWalkerRoadTargetSearch'),
    );
    assert.doesNotMatch(assignment, /planFootprintAwareRoute\(/);
    assert.doesNotMatch(assignment, /setWalkerDestination\(/);
    assert.doesNotMatch(assignment, /for \(let attempt/);
    const creation = source.slice(
        source.indexOf('function createWalker'),
        source.indexOf('function figureCount'),
    );
    assert.doesNotMatch(creation, /advanceWalkerRoadTargetSearch\(/);
});

test('ground target publication and lifecycle cancel pending searches', () => {
    const advance = source.slice(
        source.indexOf('function advanceWalkerRoadTargetSearch'),
        source.indexOf('function advanceRoadTargetSearches'),
    );
    assert.match(advance, /setWalkerDestination\(walker, target, 'road'\) \? target : null/);

    const removal = source.slice(
        source.indexOf('function removeWalker'),
        source.indexOf('function chooseBuildingEntrance'),
    );
    assert.match(removal, /cancelRoadTargetSearch\(walker\)/);

    const teardown = source.slice(
        source.indexOf('endSession\(\)'),
        source.indexOf('if \(group && group\.parent\)', source.indexOf('endSession\(\)')),
    );
    assert.match(teardown, /for \(const walker of walkers\)/);
    assert.match(teardown, /cancelRoadTargetSearch\(walker\)/);
});
