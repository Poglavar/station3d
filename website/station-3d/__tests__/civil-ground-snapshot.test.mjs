// Captured civil inputs preserve authority, evidence and the requested prefix after providers change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CivilGroundComposition, CIVIL_GROUND_AUTHORITY as A } from '../core/civil-ground-composition.js';

const samplers = height => ({ terrainSceneYAtLocal: () => height,
    terrainEvidenceSceneYAtLocal: x => x === 3 ? null : height });
const provider = (id, threshold, lift) => ({ id,
    sampleSceneYAtLocal: (x, _z, { inputSceneY }) => x > threshold && inputSceneY != null ? inputSceneY + lift : null,
    sampleEvidenceSceneYAtLocal: (x, _z, { inputSceneY }) => x > threshold && inputSceneY != null ? inputSceneY + lift : null });
function fixture() {
    const live = new CivilGroundComposition(samplers(1));
    const rail = provider('rail', 0, 2), road = provider('road', 1, 3);
    live.setGroundAuthority(A.RAIL, rail);
    live.setGroundAuthority(A.ROAD, road);
    const inputs = { beforeAuthority: A.SIDEWALK, ...samplers(1),
        providers: new Map([[A.RAIL, rail], [A.ROAD, road]]) };
    return { live, inputs, rail, road };
}
const result = ground => [-1, 1, 2, 3].map(x => ({
    y: ground.inputSceneYAtLocal(A.SIDEWALK, x, 0),
    evidence: ground.inputEvidenceSceneYAtLocal(A.SIDEWALK, x, 0),
    owner: ground.inputOwnerAuthorityAtLocal(A.SIDEWALK, x, 0),
    source: ground.inputSceneYOwnedByAtLocal(A.SIDEWALK, A.TERRAIN, x, 0),
}));

test('captured civil queries preserve numeric, nullable evidence and ownership results', () => {
    const { live, inputs, rail } = fixture();
    const snapshot = live.captureReadSnapshot(inputs);
    assert.deepEqual(result(snapshot), result(live));
    assert.deepEqual(result(snapshot), [
        { y: 1, evidence: 1, owner: A.TERRAIN, source: 1 },
        { y: 3, evidence: 3, owner: A.RAIL, source: null },
        { y: 6, evidence: 6, owner: A.ROAD, source: null },
        { y: 6, evidence: null, owner: A.ROAD, source: null },
    ]);
    const before = result(snapshot);
    live.terrainSceneYAtLocal = () => 100;
    live.setGroundAuthority(A.RAIL, provider('rail', -2, 30));
    rail.sampleSceneYAtLocal = () => 900;
    inputs.providers.clear();
    assert.notDeepEqual(result(live), before);
    assert.deepEqual(result(snapshot), before);
    assert.equal(snapshot.sceneYAtLocal(2, 0), 6);
    assert.equal(snapshot.resolveAtLocal(2, 0).ownerAuthority, A.ROAD);
    assert.equal(Object.isFrozen(snapshot), true);
    for (const name of ['setGroundAuthority', 'setTerrainReplacement', '_providers', 'dependencySnapshotBefore']) {
        assert.equal(snapshot[name], undefined);
    }
});

test('a query cannot silently run past the captured authority prefix', () => {
    const { live, inputs } = fixture();
    const snapshot = live.captureReadSnapshot(inputs);
    assert.throws(() => snapshot.sceneYAtLocal(0, 0, { throughAuthority: A.SIDEWALK }), /exceeds/);
    assert.throws(() => snapshot.resolveAtLocal(0, 0, { throughAuthority: A.BUILDING }), /exceeds/);
    for (const name of ['inputSceneYAtLocal', 'inputEvidenceSceneYAtLocal', 'inputOwnerAuthorityAtLocal']) {
        assert.throws(() => snapshot[name](A.PATH, 0, 0), /exceeds/);
    }
    assert.equal(snapshot.inputSceneYAtLocal(A.SIDEWALK, 2, 0), 6);
    assert.throws(() => live.captureReadSnapshot({ ...inputs, beforeAuthority: A.TERRAIN }), /include terrain/);
});

test('only registered providers in the captured prefix are required', () => {
    const live = new CivilGroundComposition(samplers(1));
    live.setGroundAuthority(A.ROAD, provider('road', 0, 3));
    const inputs = { beforeAuthority: A.ROAD, ...samplers(1) };
    const snapshot = live.captureReadSnapshot(inputs);
    assert.equal(snapshot.inputSceneYAtLocal(A.ROAD, 1, 0), 1);
    assert.equal(live.hasGroundAuthority(A.RAIL), false);
    assert.equal(live.hasGroundAuthority(A.ROAD), true);
    assert.throws(() => live.captureReadSnapshot({ ...inputs,
        providers: new Map([[A.RAIL, provider('rail', 0, 2)]]) }), /extra/);
});

test('missing, extra, mismatched and evidence-changing provider inputs are rejected', () => {
    const { live, inputs, rail, road } = fixture();
    const withProviders = providers => () => live.captureReadSnapshot({ ...inputs, providers: new Map(providers) });
    assert.throws(withProviders([[A.ROAD, road]]), /missing/);
    assert.throws(withProviders([[A.RAIL, { ...rail, id: 'wrong' }], [A.ROAD, road]]), /mismatched/);
    assert.throws(withProviders([[A.RAIL, { ...rail, sampleEvidenceSceneYAtLocal: null }], [A.ROAD, road]]), /mismatched/);
    assert.throws(withProviders([[A.RAIL, rail], [A.ROAD, road], [A.PATH, provider('path', 0, 1)]]), /extra/);
    assert.throws(() => live.captureReadSnapshot({ ...inputs, terrainEvidenceSceneYAtLocal: null }), /explicit terrain/);
    live.setGroundAuthority(A.RAIL, { ...rail, sampleEvidenceSceneYAtLocal: null });
    assert.throws(() => live.captureReadSnapshot(inputs), /mismatched/);
});

test('a terrain replacement has explicit captured visual and evidence ownership', () => {
    const { live, inputs } = fixture();
    const replacement = { id: 'coast', sampleSceneYAtLocal: x => x < 0 ? 8 : null,
        sampleEvidenceSceneYAtLocal: x => x < 0 ? 8 : null };
    assert.throws(() => live.captureReadSnapshot({ ...inputs, terrainReplacement: replacement }), /replacement mismatch/);
    live.setTerrainReplacement(replacement);
    assert.throws(() => live.captureReadSnapshot(inputs), /replacement mismatch/);
    assert.throws(() => live.captureReadSnapshot({ ...inputs,
        terrainReplacement: { ...replacement, sampleEvidenceSceneYAtLocal: null } }), /mismatched/);
    const snapshot = live.captureReadSnapshot({ ...inputs, terrainReplacement: replacement });
    assert.equal(snapshot.terrainReplacementOwnsAtLocal(-1, 0), true);
    assert.equal(snapshot.terrainReplacementOwnsAtLocal(1, 0), false);
    assert.equal(snapshot.inputSceneYOwnedByAtLocal(A.SIDEWALK, A.TERRAIN, -1, 0), 8);
    live.setTerrainReplacement({ ...replacement, sampleSceneYAtLocal: () => 20 });
    replacement.sampleSceneYAtLocal = () => 30;
    assert.equal(snapshot.sceneYAtLocal(-1, 0), 8);
});

test('terrain replacement capture retains one generation and preserves absent evidence', () => {
    const live = new CivilGroundComposition(samplers(1));
    assert.equal(live.captureTerrainReplacementReadSnapshot(), null);
    const replacement = { id: 'coast', sampleSceneYAtLocal: x => x < 0 ? 8 : null };
    const releaseOld = live.setTerrainReplacement(replacement);
    const captured = live.captureTerrainReplacementReadSnapshot();
    assert.equal(Object.isFrozen(captured), true);
    assert.equal(captured.sampleEvidenceSceneYAtLocal, null);
    const snapshot = live.captureReadSnapshot({ beforeAuthority: A.ROAD,
        ...samplers(1), terrainReplacement: captured });
    const releaseNew = live.setTerrainReplacement({ ...replacement, sampleSceneYAtLocal: () => 20 });
    replacement.sampleSceneYAtLocal = () => 30;
    assert.equal(releaseOld(), false, 'a retired registration cannot clear its successor');
    assert.equal(captured.sampleSceneYAtLocal(-1, 0), 8);
    assert.equal(snapshot.sceneYAtLocal(-1, 0), 8);
    assert.equal(snapshot.sceneYAtLocal(1, 0), 1);
    assert.equal(snapshot.evidenceSceneYAtLocal(-1, 0), 1, 'visual replacement must not invent evidence');
    assert.equal(snapshot.evidenceSceneYAtLocal(3, 0), null);
    assert.equal(releaseNew(), true);
    assert.equal(live.captureTerrainReplacementReadSnapshot(), null);
    assert.equal(snapshot.sceneYAtLocal(-1, 0), 8, 'unregistering must preserve readers of the old generation');
});

test('a prepared coastal replacement can be added, changed or removed without changing published civil inputs', () => {
    const live = new CivilGroundComposition(samplers(1));
    const inputs = { beforeAuthority: A.ROAD, ...samplers(1) };
    const coast = height => Object.freeze({ id: 'coast', sampleSceneYAtLocal: x => x < 0 ? height : null,
        sampleEvidenceSceneYAtLocal: x => x < 0 ? height : null });
    const replacement = coast(5);
    const addition = live.captureReadSnapshot({ ...inputs, preparedTerrainReplacement: replacement });
    assert.equal(addition.sceneYAtLocal(-1, 0), 5);
    assert.equal(live.sceneYAtLocal(-1, 0), 1);
    assert.equal(live.captureTerrainReplacementReadSnapshot(), null);
    const release = live.setTerrainReplacement(replacement);
    const update = live.captureReadSnapshot({ ...inputs, preparedTerrainReplacement: coast(8) });
    const removal = live.captureReadSnapshot({ ...inputs, preparedTerrainReplacement: null });
    assert.equal(update.sceneYAtLocal(-1, 0), 8);
    assert.equal(removal.sceneYAtLocal(-1, 0), 1);
    assert.equal(live.sceneYAtLocal(-1, 0), 5);
    assert.equal(addition.sceneYAtLocal(-1, 0), 5);
    assert.throws(() => live.captureReadSnapshot({ ...inputs, preparedTerrainReplacement: { ...replacement } }), /immutable/);
    assert.throws(() => live.captureReadSnapshot({ ...inputs, preparedTerrainReplacement: Object.freeze({ ...replacement, id: 'other' }) }), /owner mismatch/);
    release();
    assert.equal(live.sceneYAtLocal(-1, 0), 1);
    assert.equal(update.sceneYAtLocal(-1, 0), 8, 'retained candidates own their exact callbacks');
});
