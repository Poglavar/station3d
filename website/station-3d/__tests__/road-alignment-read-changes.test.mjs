// Completeness of vertical-alignment read change sets. Snapshot contexts are
// built exactly as captureReadSnapshotSteps binds them, over straight
// hand-made alignments; any query whose evidence misses the change set must
// answer the same from both snapshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadVerticalAlignmentModel, roadAlignmentReadChangesSteps } from '../core/road-vertical-alignment.js';
import { createGroundReadEvidence, freezeGroundReadEvidence, groundReadEvidenceDependsOn,
    withGroundReadEvidence } from '../core/ground-read-evidence.js';
import { roadReplacementPublicationReadyForOsmId, roadStructurePublicationChanges as roadStructureChanges }
    from '../core/road-replacement-publication.js';

const READ_METHODS = ['getAlignments', 'getAlignmentForOsmId', 'getProfileOwnerForOsmId',
    '_roadYFromAlignmentsAtLocal', 'roadYAtLocal', 'roadYForOsmIdsAtLocal',
    'isBufferedEndCapAtLocal', 'createBufferedRoadJoinArtifactEvaluator',
    'isBufferedRoadJoinArtifactAtLocal', 'structureAtLocal', 'replacesRoadSurfaceForOsmId',
    'laneCountOverrideForOsmId', 'retainsRoadFormationForOsmId',
    'containsReplacementCorridorForOsmId', 'getReplacementTerrainCutoutRegions',
    'isInsideReplacementTerrainOpening', 'containsReplacementCorridor'];

function straight({ id, members, from, to, rise = 4, kind = 'overpass', halfWidth = 5, replace = false }) {
    const [x0, z0] = from, [x1, z1] = to;
    const length = Math.hypot(x1 - x0, z1 - z0);
    return {
        id, kind, points: [{ x: x0, z: z0 }, { x: x1, z: z1 }], cumulative: [0, length], totalLengthM: length,
        structureStartM: length * .3, structureEndM: length * .7,
        memberOsmIds: new Set(members.map(String)), structureOsmIds: new Set(members.map(String)),
        definition: { corridorHalfWidthM: halfWidth, replaceRoadSurface: replace },
        profileYAtS: s => rise * Math.sin(Math.PI * s / length),
        terrainSceneYAtLocal: (x, z) => x * .02 + z * .01,
        nearest(x, z) {
            const dx = x1 - x0, dz = z1 - z0;
            const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / (length * length)));
            const px = x0 + dx * t, pz = z0 + dz * t;
            return { x: px, z: pz, s: t * length, distanceSquared: (x - px) ** 2 + (z - pz) ** 2, segmentIndex: 0 };
        },
    };
}

function read(alignments, owners = new Map(), regions = []) {
    const byOsmId = new Map();
    for (const alignment of alignments) for (const id of alignment.memberOsmIds) if (!byOsmId.has(id)) byOsmId.set(id, alignment);
    const context = { _compiled: Object.freeze([...alignments]), _byOsmId: byOsmId, _profileOwnerByAlignment: owners,
        _replacementTerrainCutoutRegions: Object.freeze(regions), authoredPortalReplacements: () => [], _ensureBuilt() {} };
    const api = {};
    for (const name of READ_METHODS) {
        context[name] = RoadVerticalAlignmentModel.prototype[name].bind(context);
        if (!name.startsWith('_')) api[name] = context[name];
    }
    return Object.freeze(api);
}

const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const QUERIES = [
    ['roadYAtLocal', (r, x, z) => r.roadYAtLocal(x, z)],
    ['roadYAtLocal 10', (r, x, z) => r.roadYAtLocal(x, z, 10)],
    ['roadYAtLocal 30', (r, x, z) => r.roadYAtLocal(x, z, 30)],
    ['roadYForOsmIdsAtLocal', (r, x, z) => r.roadYForOsmIdsAtLocal(x, z, [20, 30])],
    ['structureAtLocal', (r, x, z) => r.structureAtLocal(x, z)],
    ['structureAtLocal 20', (r, x, z) => r.structureAtLocal(x, z, 20)],
    ['isBufferedEndCapAtLocal', (r, x, z) => r.isBufferedEndCapAtLocal(x, z)],
    ['join artifact, unowned', (r, x, z) => r.isBufferedRoadJoinArtifactAtLocal(x, z, [99])],
    ['join evaluator reused', (r, x, z) => r.createBufferedRoadJoinArtifactEvaluator([99], 10)(x, z)],
    ['containsReplacementCorridor', (r, x, z) => r.containsReplacementCorridor(x, z, 7)],
    ['containsReplacementCorridorForOsmId', (r, x, z) => r.containsReplacementCorridorForOsmId(x, z, 20)],
    ['replacesRoadSurfaceForOsmId', r => r.replacesRoadSurfaceForOsmId(20)],
];

function assertComplete(before, after, label) {
    const changes = drain(roadAlignmentReadChangesSteps(before, after, { now: () => 0 }));
    let skipped = 0, dependent = 0;
    for (let index = 0; index < 500; index++) {
        const x = ((index * 37) % 240) - 120 + (index % 7) * .29, z = ((index * 53) % 200) - 100 + (index % 5) * .13;
        for (const [name, query] of QUERIES) {
            const evidence = createGroundReadEvidence();
            const answer = withGroundReadEvidence(evidence, () => query(before, x, z));
            if (groundReadEvidenceDependsOn(freezeGroundReadEvidence(evidence), changes)) { dependent++; continue; }
            skipped++;
            assert.deepEqual(query(after, x, z), answer, `${label}: ${name} at ${x.toFixed(2)},${z.toFixed(2)} changed without evidence`);
        }
    }
    assert.ok(skipped > 200 && dependent > 50, `${label}: ${skipped} skipped, ${dependent} dependent`);
    return changes;
}

const a = straight({ id: 'a', members: [10], from: [-80, 0], to: [80, 0] });
const b = straight({ id: 'b', members: [20], from: [-60, 60], to: [60, 60], replace: true });

test('a re-solved alignment and a new one change only reads that reach them', () => {
    const resolved = straight({ id: 'a', members: [10], from: [-80, 0], to: [80, 0], rise: 6 });
    const added = straight({ id: 'c', members: [30], from: [-40, -70], to: [40, -70] });
    const changes = assertComplete(read([a, b]), read([resolved, b, added]), 'resolve+add');
    assert.deepEqual([...changes.ids].sort(), ['10', '30']);
});

test('a profile owner change is a change of its companion', () => {
    const companion = { ...straight({ id: 'd', members: [40], from: [-50, 5], to: [50, 5], kind: 'approach' }),
        definition: { corridorHalfWidthM: 5, renderStructure: false } };
    const before = read([a, b, companion], new Map([[companion, a]]));
    const after = read([a, b, companion], new Map([[companion, b]]));
    const changes = assertComplete(before, after, 'owner');
    assert.ok(changes.ids.has('40'));
    assert.equal(drain(roadAlignmentReadChangesSteps(before, read([a, b, companion], new Map([[companion, a]])), { now: () => 0 })).empty,
        true, 'a recaptured snapshot of the same alignments is not a change');
});

test('a structure root publishing or retiring is a change of its replaced roads', () => {
    const alignments = read([a, b]);
    const publications = roots => Object.freeze({ getActive: key => (roots.has(key) ? { root: roots.get(key) } : null) });
    const root = {};
    const empty = publications(new Map()), published = publications(new Map([['roads:structure:b', root]]));
    const evidence = createGroundReadEvidence();
    withGroundReadEvidence(evidence, () => roadReplacementPublicationReadyForOsmId({
        alignmentModel: alignments, surfacePublications: empty, osmId: 20 }));
    const frozen = freezeGroundReadEvidence(evidence);
    const changes = roadStructureChanges({ previousPublications: empty, nextPublications: published,
        previousAlignments: alignments, nextAlignments: alignments });
    assert.equal(groundReadEvidenceDependsOn(frozen, changes), true);
    assert.ok(changes.boxes.length > 0, 'receivers without evidence see the region');
    const unchanged = roadStructureChanges({ previousPublications: published, nextPublications: publications(new Map([['roads:structure:b', root]])),
        previousAlignments: alignments, nextAlignments: alignments });
    assert.equal(unchanged.empty, true);
    assert.equal(roadStructureChanges({ previousPublications: null, nextPublications: published,
        previousAlignments: alignments, nextAlignments: alignments }).full, true);
});

test('cut-out and clear-corridor regions changing are a change of the cut-out read', () => {
    const ring = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
    const cut = Object.freeze({ alignmentId: 'a', clearRing: null, clearBounds: null,
        cutoutRing: ring(-20, -4, 20, 4), cutoutBounds: { minX: -20, minZ: -4, maxX: 20, maxZ: 4 } });
    const clear = Object.freeze({ alignmentId: 'a', cutoutRing: null, cutoutBounds: null,
        clearRing: ring(30, -6, 50, 6), clearBounds: { minX: 30, minZ: -6, maxX: 50, maxZ: 6 } });
    const opening = [['isInsideReplacementTerrainOpening', (r, x, z) => r.isInsideReplacementTerrainOpening(x, z)]];
    for (const [before, after] of [[[cut], [cut, clear]], [[cut, clear], [cut]], [[], [cut]]]) {
        const previous = read([a, b], new Map(), before), next = read([a, b], new Map(), after);
        const changes = drain(roadAlignmentReadChangesSteps(previous, next, { now: () => 0 }));
        assert.equal(changes.full, false, 'regions carry their own bounds');
        assert.ok(changes.boxes.length > 0);
        for (const [name, query] of opening) for (let x = -30; x <= 60; x += 5) {
            const evidence = createGroundReadEvidence();
            const answer = withGroundReadEvidence(evidence, () => query(previous, x, 0));
            if (!groundReadEvidenceDependsOn(freezeGroundReadEvidence(evidence), changes)) {
                assert.equal(query(next, x, 0), answer, `${name} at ${x}`);
            }
        }
    }
});
