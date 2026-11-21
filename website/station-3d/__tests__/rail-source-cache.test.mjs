import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('rail source resolution survives road-only generations and invalidates on its actual inputs', () => {
    const source = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
    let resolves = 0, merges = 0, smooths = 0;
    const sourceSet = [{ id: 'rail-1' }];
    const runtime = vm.createContext({ railSessionToken: 1, streamedRailInputRevision: 2,
        streamedRailTileFeatures: new Map(), streamedRailBaseFeatures: [], streamedRailProfileMode: 'solved',
        lastTerrainSource: {}, resolvedStreamedRailSource: null,
        mergeStreamedRailFeatureTiles() { merges++; return sourceSet; },
        smoothRailTrackFeatures(features) { smooths++; return features; },
        *resolveStreamedRailSessionFeaturesSteps({ terrainReference }) {
            resolves++; return [{ revision: terrainReference.revision }];
        } });
    vm.runInContext(source.slice(source.indexOf('function resolveCurrentStreamedRailFeatures('),
        source.indexOf('\nfunction resolveStandaloneRailFeatures(')), runtime);
    const read = () => Object.freeze({ revision: 7, contract: 'station3d-terrain-read-snapshot-v1' });
    const captured = read(), first = runtime.resolveCurrentStreamedRailFeatures(captured);
    const callbacks = [];
    assert.equal(runtime.resolveCurrentStreamedRailFeatures(read(), rows => callbacks.push(rows)), first);
    assert.deepEqual([resolves, merges, smooths], [1, 1, 1]);
    assert.deepEqual(callbacks, [sourceSet], 'publication still acknowledges the captured source membership');
    assert.ok(!Object.values(runtime.resolvedStreamedRailSource.key).includes(captured));
    for (const change of [
        () => { runtime.streamedRailInputRevision++; },
        () => { runtime.streamedRailBaseFeatures = []; },
        () => { runtime.streamedRailProfileMode = 'osm'; },
        () => { runtime.railSessionToken++; },
    ]) {
        const before = resolves; change(); runtime.resolveCurrentStreamedRailFeatures(read());
        assert.equal(resolves, before + 1);
    }
    const before = resolves;
    assert.equal(runtime.resolveCurrentStreamedRailFeatures({ ...read(), revision: 8 })[0].revision, 8);
    assert.equal(resolves, before + 1);
    runtime.resolvedStreamedRailSource = null;
    runtime.resolveCurrentStreamedRailFeatures(read());
    assert.equal(resolves, before + 2, 'session cleanup drops the bounded source cache');
});

test('rail admission releases its source lease on cancellation, stale input and compiler failure', () => {
    const source = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
    let current = true, fail = false;
    const features = [{ id: 'rail' }];
    const runtime = vm.createContext({ group: {}, railGroundGenerationLease: null,
        pendingRailFormationBuild: null, pendingRailVisualRefresh: null, pendingRailStructuresRefresh: null,
        pendingCrossingFormationRefresh: null, pendingEmbeddedTramMeshRefresh: null,
        railSessionToken: 1, lastFeatures: [], lastStops: [], groundManaged: true,
        streamedRailTileFeatures: new Map(), lastTerrain: null, lastTerrainSource: null,
        lastRailFormation: null, lastRoadFormation: null, lastRoadVerticalAlignments: null,
        streamedRailInputRevision: 1, sampledTrackbedRevision: 1, renderedRailSurfaceRevision: 1,
        lastPhotoTrackFrame: null, lastPillarClearance: null, pillarClearanceReady: false,
        mappedSeaStructuresRevision: 1, photoStationStructureRevision: 1,
        lastBridgeStyleLocationId: null, lastBridgeStyleCityId: null,
        *resolveCurrentStreamedRailFeaturesSteps() {
            yield { phase: 'rail-source:context' };
            if (fail) throw Error('source compiler failed');
            return features;
        } });
    vm.runInContext(source.slice(source.indexOf('function* admitRailGroundGenerationSteps('),
        source.indexOf('\n// Civil construction precedes')), runtime);
    const start = () => runtime.admitRailGroundGenerationSteps({ isCurrent: () => current, maxFeatures: 10 });
    const cancelled = start();
    assert.equal(cancelled.next().done, false);
    assert.ok(runtime.railGroundGenerationLease, 'the suspended compiler owns its captured source');
    assert.equal(start().next().value, null, 'a second admission cannot race the suspended compiler');
    cancelled.return();
    assert.equal(runtime.railGroundGenerationLease, null);
    for (const failure of ['stale', 'compile']) {
        const steps = start(); steps.next();
        if (failure === 'stale') current = false;
        else fail = true;
        assert.throws(() => steps.next(), failure === 'stale' ? /admission expired/ : /compiler failed/);
        assert.equal(runtime.railGroundGenerationLease, null);
        current = true; fail = false;
    }
    const completed = start(); completed.next();
    const admission = completed.next().value;
    assert.equal(admission.features, features);
    assert.ok(admission.isCurrent());
    admission.release();
    assert.equal(runtime.railGroundGenerationLease, null);
});
