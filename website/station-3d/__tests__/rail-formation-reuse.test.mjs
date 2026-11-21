// The per-feature assembly reuse must be invisible: a model built with reuse
// enabled has to equal a model built from scratch, feature for feature — and
// reuse must be REFUSED wherever equality cannot be guaranteed (terrain change
// in reach, changed chainage origin, changed context, duplicate geometry).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RailFormationModel } from '../core/rail-formation.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const ANCHOR_LAT = 43.52;
const ANCHOR_LON = 16.4;
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);

function lonLat(x, z) {
    return [ANCHOR_LON + x / M_PER_LON, ANCHOR_LAT - z / M_PER_LAT];
}

function track(points, properties = {}) {
    return {
        type: 'Feature',
        properties: { source: 'cb-proposal', proposalId: '5', ...properties },
        geometry: {
            type: 'LineString',
            coordinates: points.map(([x, z]) => lonLat(x, z)),
        },
    };
}

const flatSlope = (x, z) => 10 + x * 0.002 + z * 0.001;

function buildModel(features, {
    terrain = flatSlope,
    assemblyReuse = null,
    deferredBuild = false,
    absoluteSceneYAtHeight = (h) => Number(h) || 0,
    stationAccessPlanner = null,
} = {}) {
    return new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features,
        baseSceneYAtLocal: terrain,
        absoluteSceneYAtHeight,
        halfWidthForFeature: () => 4,
        assemblyReuse,
        deferredBuild,
        stationAccessPlanner,
    });
}

// Two tracks on independent proposals, far enough apart that a bounded change
// near one cannot reach the other's dressing.
const trackA = () => track([[0, 0], [150, 0], [300, 0]], { proposalId: 'A' });
const trackB = () => track([[2000, 0], [2150, 0], [2300, 0]], { proposalId: 'B' });
const FAR_FROM_BOTH = [{ minX: 900, maxX: 1100, minZ: -50, maxZ: 50 }];
const NEAR_B = [{ minX: 2100, maxX: 2200, minZ: -30, maxZ: 30 }];

function modelShape(model) {
    return {
        alignments: model.alignments.map((alignment) => ({
            id: alignment.id,
            railY: alignment.samples.map((sample) => sample.railY),
            segmentCount: alignment.segments.length,
            profileCounts: alignment.profiles.map((profile) => profile.points?.length ?? 0),
        })),
        segments: model.segments.length,
        profiles: model.profiles.length,
        viaductRuns: model.viaductRuns.length,
        tunnelRuns: model.tunnelRuns.length,
        stationAccessPlans: model.stationAccessPlans.length,
        surfaceIndex: [...model.surfaceProfileIndex.entries()]
            .map(([key, profiles]) => [
                key,
                profiles.map(profile => [
                    profile.alignment?.id || '',
                    profile.startStation,
                    profile.endStation,
                ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
            ])
            .sort(([left], [right]) => left.localeCompare(right)),
    };
}

test('a bounded change away from both tracks shares compiled geometry with private generation wrappers', () => {
    const first = buildModel([trackA(), trackB()]);
    const featuresAgain = [trackA(), trackB()];
    const reusedModel = buildModel(featuresAgain, {
        assemblyReuse: { previousModel: first, terrainChangedBounds: FAR_FROM_BOTH },
    });
    assert.equal(reusedModel.buildTimings.reusedCount, 2);
    for (let i = 0; i < 2; i++) {
        assert.notEqual(reusedModel.alignments[i], first.alignments[i]);
        assert.equal(reusedModel.alignments[i].samples, first.alignments[i].samples);
        assert.equal(reusedModel.alignments[i].profiles[0].points,
            first.alignments[i].profiles[0].points);
        assert.notEqual(reusedModel.alignments[i].profiles[0].internalSegments,
            first.alignments[i].profiles[0].internalSegments);
    }
    // Re-keyed to the NEW feature objects for formationAtFeatureStation.
    assert.equal(reusedModel.alignmentByFeature.get(featuresAgain[0]), reusedModel.alignments[0]);
    // And the aggregate shape equals a from-scratch build.
    assert.deepEqual(modelShape(reusedModel), modelShape(buildModel([trackA(), trackB()])));
});

test('unchanged features reuse preparation without resampling the terrain', () => {
    let samples = 0;
    const terrain = (x, z) => { samples += 1; return flatSlope(x, z); };
    const first = buildModel([trackA(), trackB()], { terrain });
    assert.ok(samples > 0);
    samples = 0;
    const second = buildModel([trackA(), trackB()], {
        terrain,
        assemblyReuse: { previousModel: first, terrainChangedBounds: [] },
    });
    assert.equal(samples, 0, 'a stable feature must skip terrain and cross-section sampling');
    assert.equal(second.buildTimings.preparedReusedCount, 2);
    assert.equal(second.buildTimings.preparedDirtyCount, 0);
    assert.deepEqual(modelShape(second), modelShape(first));
});

test('preparation reuse is invalidated by terrain beyond an explicit structure endpoint', () => {
    const features = () => [track([[0, 0], [160, 0]], {
        proposalId: 'bridge', railProfileSource: 'osm-inferred', railStructure: 'viaduct',
    })];
    const first = buildModel(features(), { terrain: () => 10 });
    const terrain = (x) => x > 290 && x < 330 ? 18 : 10;
    const second = buildModel(features(), {
        terrain,
        assemblyReuse: {
            previousModel: first,
            terrainChangedBounds: [{ minX: 290, maxX: 330, minZ: -5, maxZ: 5 }],
        },
    });
    assert.equal(second.buildTimings.preparedReusedCount, 0);
    assert.notDeepEqual(second.alignments[0].samples.map(s => s.railY),
        first.alignments[0].samples.map(s => s.railY));
    assert.deepEqual(modelShape(second), modelShape(buildModel(features(), { terrain })));
});

test('reused pre-join preparation picks up changed and removed bridge neighbours', () => {
    const ordinary = () => track([[-300, 0], [0, 0]], {
        proposalId: 'approach', railProfileSource: 'osm-inferred',
    });
    const bridge = () => track([[0, 0], [50, 0]], {
        proposalId: 'bridge', railProfileSource: 'osm-inferred', railStructure: 'viaduct',
    });
    const terrain = x => 10 + (x > 100 ? 3 : 0);
    const first = buildModel([ordinary(), bridge()], { terrain });
    const changedTerrain = x => 10 + (x > 100 ? 9 : 0);
    const second = buildModel([ordinary(), bridge()], {
        terrain: changedTerrain,
        assemblyReuse: {
            previousModel: first,
            terrainChangedBounds: [{ minX: 100, maxX: 250, minZ: -5, maxZ: 5 }],
        },
    });
    assert.equal(second.buildTimings.preparedReusedCount, 1, 'the approach sampling is unchanged');
    assert.deepEqual(modelShape(second),
        modelShape(buildModel([ordinary(), bridge()], { terrain: changedTerrain })));
    const withoutBridge = buildModel([ordinary()], {
        terrain: changedTerrain,
        assemblyReuse: { previousModel: second, terrainChangedBounds: [] },
    });
    assert.equal(withoutBridge.buildTimings.preparedReusedCount, 1);
    assert.deepEqual(modelShape(withoutBridge),
        modelShape(buildModel([ordinary()], { terrain: changedTerrain })),
        'cached design must not retain an earlier endpoint correction');
});

test('an absolute scene datum change reuses terrain but not the old rail heights', () => {
    const features = () => {
        const feature = trackA();
        feature.properties.elevationMode = 'absolute';
        feature.properties.elevationDatum = 'EVRF2000';
        feature.geometry.coordinates.forEach(point => point.push(20));
        return [feature];
    };
    const first = buildModel(features());
    const options = { absoluteSceneYAtHeight: height => height - 7 };
    const second = buildModel(features(), {
        ...options,
        assemblyReuse: { previousModel: first, terrainChangedBounds: [] },
    });
    assert.equal(second.buildTimings.preparedReusedCount, 1);
    assert.equal(second.buildTimings.reusedCount, 0);
    assert.deepEqual(modelShape(second), modelShape(buildModel(features(), options)));
});

test('a long feature yields during preparation without publishing partial geometry', () => {
    let terrainCalls = 0;
    const feature = track([[0, 0], [4000, 0]]);
    const model = buildModel([feature], {
        deferredBuild: true,
        terrain: () => { terrainCalls += 1; return 10; },
    });
    let sawTerrainSlice = false;
    let sawPrepare = false;
    while (model.hasPendingBuild() && !sawPrepare) {
        const before = terrainCalls;
        const outcome = model.stepPendingBuild();
        assert.equal(model.revision, 0);
        assert.equal(model.alignments.length, 0);
        assert.ok(terrainCalls - before <= 64, 'one preparation step cannot sample the whole feature');
        if (outcome.phase === 'prepare:terrain') sawTerrainSlice = true;
        if (outcome.phase === 'prepare') sawPrepare = true;
    }
    assert.ok(sawTerrainSlice);
    assert.ok(sawPrepare);
    assert.ok(terrainCalls > 64);
});

test('discarding a prepared replacement cannot modify the previous model samples', () => {
    const features = () => [track([[0, 0], [4000, 0]])];
    const first = buildModel(features());
    const oldSamples = structuredClone(first.alignments[0].samples);
    const pending = buildModel(features(), {
        deferredBuild: true,
        assemblyReuse: { previousModel: first, terrainChangedBounds: [] },
    });
    while (pending.stepPendingBuild().phase !== 'prepare') {
        assert.equal(pending.revision, 0);
    }
    assert.deepEqual(first.alignments[0].samples, oldSamples);
    assert.notEqual(pending._preparations.values().next().value.samples,
        first.alignments[0].samples);
});

test('chainage, civil runs and rail mode changes invalidate preparation with identical coordinates', () => {
    const first = buildModel([trackA()]);
    for (const properties of [
        { railSourceChainagesM: [100, 250, 400] },
        { railCivilRuns: [{ startM: 0, endM: 300, structure: 'tunnel' }] },
        { railMode: 'tram' },
    ]) {
        const make = () => Object.assign(trackA(), {
            properties: { ...trackA().properties, ...properties },
        });
        const second = buildModel([make()], {
            assemblyReuse: { previousModel: first, terrainChangedBounds: [] },
        });
        assert.equal(second.buildTimings.preparedReusedCount, 0);
        assert.deepEqual(modelShape(second), modelShape(buildModel([make()])));
    }
});

test('both diagonal structure approach tangents invalidate their cached preparation', () => {
    const features = () => [track([[-50, -50], [50, 50]], {
        proposalId: 'diagonal', railProfileSource: 'osm-inferred', railStructure: 'viaduct',
    })];
    const first = buildModel(features(), { terrain: () => 10 });
    for (const bounds of [
        { minX: -180, maxX: -90, minZ: -180, maxZ: -90 },
        { minX: 90, maxX: 180, minZ: 90, maxZ: 180 },
    ]) {
        const terrain = (x, z) => x >= bounds.minX && x <= bounds.maxX
            && z >= bounds.minZ && z <= bounds.maxZ ? 18 : 10;
        const second = buildModel(features(), {
            terrain,
            assemblyReuse: { previousModel: first, terrainChangedBounds: [bounds] },
        });
        assert.equal(second.buildTimings.preparedReusedCount, 0);
        assert.deepEqual(modelShape(second), modelShape(buildModel(features(), { terrain })));
    }
});

for (const dense of [true, false]) {
    test(`${dense ? 'many source coordinates' : 'one long source segment'} yield before publication`, () => {
        const points = dense
            ? Array.from({ length: 4200 }, (_, index) => [index * 2, 0])
            : [[0, 0], [85000, 0]];
        const feature = track(points, { elevationMode: 'absolute', elevationDatum: 'EVRF2000' });
        feature.geometry.coordinates.forEach(point => point.push(50));
        let terrainCalls = 0;
        const model = buildModel([feature], {
            deferredBuild: true,
            terrain: () => { terrainCalls += 1; return 10; },
        });
        const phases = new Set();
        while (model.hasPendingBuild()) {
            const before = terrainCalls;
            const outcome = model.stepPendingBuild();
            phases.add(outcome.phase);
            assert.ok(terrainCalls - before <= 64);
            if (!outcome.done) assert.equal(model.revision, 0);
        }
        assert.ok(phases.has(dense ? 'prepare:coordinates' : 'prepare:densify'));
        assert.ok(phases.has('alignmentCrossSection:terrain'));
        assert.ok(model.alignments[0].samples.length > 4096);
        assert.equal(model.revision, 1);
    });
}

test('a change inside one track\'s reach re-assembles only that track', () => {
    const first = buildModel([trackA(), trackB()]);
    const changedTerrain = (x, z) => flatSlope(x, z)
        + (x > 2100 && x < 2200 ? 3 : 0);
    const partial = buildModel([trackA(), trackB()], {
        terrain: changedTerrain,
        assemblyReuse: { previousModel: first, terrainChangedBounds: NEAR_B },
    });
    assert.equal(partial.buildTimings.reusedCount, 1);
    assert.equal(partial.alignments[0].samples, first.alignments[0].samples, 'A geometry is reused');
    assert.notEqual(partial.alignments[1].samples, first.alignments[1].samples, 'B is re-assembled');
    // The partial rebuild equals a full build over the changed terrain.
    assert.deepEqual(
        modelShape(partial),
        modelShape(buildModel([trackA(), trackB()], { terrain: changedTerrain })),
    );
});

test('reused profiles re-enter the whole-set passes with pristine flags', () => {
    const first = buildModel([trackA(), trackB()]);
    const profile = first.alignments[0].profiles[0];
    assert.ok(profile, 'fixture must produce a surface profile');
    const pristine = [...profile.internalSegments];
    const pristineOpeningRanges = profile.roadOpeningSegmentRanges?.map(
        ranges => (ranges || []).map(range => [...range]),
    );
    const pristineSharedWalls = profile.sharedRetainingWallSegments
        ? [...profile.sharedRetainingWallSegments] : undefined;
    // Simulate a scene-layer crossing flagger latching a suppression mid-session.
    profile.internalSegments[0] = true;
    profile.roadOpeningSegmentRanges = Array.from(
        { length: profile.points.length },
        (_, index) => index === 0 ? [[0.2, 0.8]] : [],
    );
    profile.sharedRetainingWallSegments = Array.from(profile.points, () => true);
    const activeFlags = structuredClone({ internal: profile.internalSegments,
        openings: profile.roadOpeningSegmentRanges, shared: profile.sharedRetainingWallSegments });
    const reusedModel = buildModel([trackA(), trackB()], {
        assemblyReuse: { previousModel: first, terrainChangedBounds: [] },
    });
    const next = reusedModel.alignments[0].profiles[0];
    assert.notEqual(next, profile);
    assert.deepEqual(next.internalSegments, pristine);
    assert.deepEqual(next.roadOpeningSegmentRanges, pristineOpeningRanges,
        'a vanished opening cannot survive on a reused profile');
    assert.deepEqual(next.sharedRetainingWallSegments, pristineSharedWalls,
        'a vanished shared retaining interface cannot stay suppressed');
    assert.deepEqual({ internal: profile.internalSegments,
        openings: profile.roadOpeningSegmentRanges, shared: profile.sharedRetainingWallSegments }, activeFlags,
    'the active generation keeps its published crossing flags');
});

test('every deferred reuse slice preserves the active graph, features and crossing flags', () => {
    const features = [trackA(), trackB()];
    const first = buildModel(features);
    const active = first.alignments.map(alignment => {
        Object.freeze(alignment);
        return { alignment, profiles: alignment.profiles.map(profile => {
            profile.internalSegments[0] = true;
            profile.collarInternalSegments[0] = true;
            profile.roadOpeningSegmentRanges = [[[0.2, 0.8]]];
            Object.freeze(profile.internalSegments);
            Object.freeze(profile.collarInternalSegments);
            return { profile, internal: profile.internalSegments,
                collar: profile.collarInternalSegments, openings: profile.roadOpeningSegmentRanges };
        }) };
    });
    const pending = buildModel([trackA(), trackB()], {
        deferredBuild: true,
        assemblyReuse: { previousModel: first, terrainChangedBounds: [] },
    });
    const phases = new Set();
    while (pending.hasPendingBuild()) {
        phases.add(pending.stepPendingBuild().phase);
        for (let i = 0; i < active.length; i++) {
            assert.equal(first.alignments[i], active[i].alignment);
            assert.equal(first.alignments[i].feature, features[i]);
            for (const row of active[i].profiles) {
                assert.equal(row.profile.internalSegments, row.internal);
                assert.equal(row.profile.collarInternalSegments, row.collar);
                assert.equal(row.profile.roadOpeningSegmentRanges, row.openings);
                assert.equal(row.internal[0], true);
                assert.equal(row.collar[0], true);
                assert.deepEqual(row.openings, [[[0.2, 0.8]]]);
            }
        }
    }
    assert.ok(phases.has('alignmentReuse:profile'));
    for (const alignment of pending.alignments) {
        assert.equal(alignment.profile, alignment.profiles[0]);
        for (const profile of alignment.profiles) assert.equal(profile.alignment, alignment);
        for (const segment of alignment.segments) assert.equal(segment.alignment, alignment);
        for (const bucket of alignment.segmentIndex.values()) {
            for (const segment of bucket) {
                assert.equal(segment.alignment, alignment);
                assert.ok(alignment.segments.includes(segment));
            }
        }
    }
});

test('reused tunnel, viaduct and station access records reference only the new generation', () => {
    const features = () => [
        track([[0, 0], [100, 0]], { proposalId: 'V', railStructure: 'viaduct' }),
        track([[2000, 0], [2100, 0]], { proposalId: 'T', railStructure: 'tunnel' }),
    ];
    const stationAccessPlanner = ({ alignment }) => [{ alignment, sections: [] }];
    const first = buildModel(features(), { stationAccessPlanner });
    const next = buildModel(features(), { stationAccessPlanner,
        assemblyReuse: { previousModel: first, terrainChangedBounds: [] } });
    assert.equal(next.buildTimings.reusedCount, 2);
    assert.ok(next.tunnelRuns.length > 0 && next.viaductRuns.length > 0);
    assert.equal(next.stationAccessPlans.length, 2);
    for (const name of ['tunnelRuns', 'viaductRuns', 'stationAccessPlans']) {
        assert.equal(next[name].length, first[name].length);
        for (let i = 0; i < next[name].length; i++) {
            const record = next[name][i];
            assert.notEqual(record, first[name][i]);
            assert.ok(next.alignments.includes(record.alignment));
            assert.ok(first.alignments.includes(first[name][i].alignment));
            if (record.samples) assert.equal(record.samples, first[name][i].samples);
            for (const segment of record.segments || []) {
                assert.equal(segment.alignment, record.alignment);
                assert.ok(record.alignment.segments.includes(segment));
            }
        }
    }
    assert.deepEqual(modelShape(next), modelShape(buildModel(features(), { stationAccessPlanner })));
});

test('duplicate identical geometry never shares one reused alignment', () => {
    const twins = () => [
        track([[0, 0], [150, 0], [300, 0]], { proposalId: 'T1' }),
        track([[0, 0], [150, 0], [300, 0]], { proposalId: 'T1b' }),
    ];
    const first = buildModel(twins());
    const reusedModel = buildModel(twins(), {
        assemblyReuse: { previousModel: first, terrainChangedBounds: [] },
    });
    assert.equal(reusedModel.alignments.length, 2);
    assert.notEqual(reusedModel.alignments[0], reusedModel.alignments[1]);
});

test('reuse is refused without bounds, and across a context change', () => {
    const first = buildModel([trackA()]);
    const noBounds = buildModel([trackA()], {
        assemblyReuse: { previousModel: first, terrainChangedBounds: null },
    });
    assert.equal(noBounds.buildTimings.reusedCount, 0);
    const otherContext = buildModel([trackA()], {
        assemblyReuse: {
            previousModel: first,
            terrainChangedBounds: [],
            contextKey: 'different-stops',
        },
    });
    assert.equal(otherContext.buildTimings.reusedCount, 0);
});

test('a changed upstream feature breaks reuse of same-proposal continuations', () => {
    // Both features chain on one proposal: the second's chainage origin is the
    // first's length. Lengthening the first must re-assemble the second even
    // though its own geometry is untouched.
    const original = [
        track([[0, 0], [300, 0]], { proposalId: 'C' }),
        track([[300, 0], [600, 0]], { proposalId: 'C' }),
    ];
    const lengthened = [
        track([[-100, 0], [300, 0]], { proposalId: 'C' }),
        track([[300, 0], [600, 0]], { proposalId: 'C' }),
    ];
    const first = buildModel(original);
    const rebuilt = buildModel(lengthened, {
        assemblyReuse: { previousModel: first, terrainChangedBounds: [] },
    });
    assert.equal(rebuilt.buildTimings.reusedCount, 0);
    assert.deepEqual(modelShape(rebuilt), modelShape(buildModel(lengthened)));
});

test('terrain-stable index envelopes conservatively contain every profile point', () => {
    const model = buildModel([
        track([[0, 0], [100, 80], [220, -40], [340, 20]], { proposalId: 'curve' }),
    ], {
        terrain: (x, z) => 16 + Math.sin(x / 30) * 5 + z * 0.01,
    });
    const distanceSquaredToSegment = (point, segment) => {
        const dx = segment.x2 - segment.x1;
        const dz = segment.z2 - segment.z1;
        const lengthSquared = dx * dx + dz * dz;
        const t = lengthSquared > 0
            ? Math.max(0, Math.min(1,
                ((point.x - segment.x1) * dx + (point.z - segment.z1) * dz)
                    / lengthSquared))
            : 0;
        const x = segment.x1 + dx * t;
        const z = segment.z1 + dz * t;
        return (point.x - x) ** 2 + (point.z - z) ** 2;
    };
    for (const profile of model.profiles) {
        assert.equal(profile._civilGroundEnvelopePlanStable, true);
        const radiusSquared = profile._civilGroundEnvelopeRadiusM ** 2;
        for (const row of profile.points || []) {
            for (const point of [
                { x: row.innerX, z: row.innerZ },
                { x: row.outerX, z: row.outerZ },
                { x: row.overlapX, z: row.overlapZ },
            ]) {
                const nearest = Math.min(...profile.alignment.segments.map(
                    segment => distanceSquaredToSegment(point, segment),
                ));
                assert.ok(nearest <= radiusSquared + 1e-6);
            }
        }
    }
});

test('cooperative formation construction publishes the synchronous model exactly', () => {
    const features = [trackA(), trackB()];
    const synchronous = buildModel(features);
    const cooperative = buildModel([trackA(), trackB()], { deferredBuild: true });
    assert.equal(cooperative.revision, 0, 'an incomplete model must not publish');
    assert.equal(cooperative.hasPendingBuild(), true);
    const phases = [];
    while (cooperative.hasPendingBuild()) {
        const outcome = cooperative.stepPendingBuild();
        phases.push(outcome.phase);
    }
    const dirtyAlignmentPhases = [
        'alignmentCrossSection',
        'alignmentClassify',
        'alignmentStructures',
        'alignmentProfile',
        'alignment',
    ];
    // Large/slow profiles may expose one or more bounded inner slices. Their
    // presence is deliberately time-budget dependent; the stable lifecycle
    // contract is the enclosing alignment phases and final publication.
    const alignmentProfileSlicePhases = new Set([
        'alignmentProfile:densify',
        'alignmentProfile:relief',
        'alignmentProfile:points',
        'alignmentProfile:finalize',
    ]);
    assert.ok(phases
        .filter(phase => phase.startsWith('alignmentProfile:'))
        .every(phase => alignmentProfileSlicePhases.has(phase)));
    assert.ok(phases
        .filter(phase => phase.startsWith('wholeSet:overlaps:'))
        .every(phase => phase === 'wholeSet:overlaps:edges'));
    assert.deepEqual(phases.filter(phase => (
        !phase.startsWith('prepare:')
            && !phase.startsWith('alignmentCrossSection:')
            && !phase.startsWith('alignmentProfile:')
            && !phase.startsWith('wholeSet:overlaps:')
    )), [
        'prepare',
        ...dirtyAlignmentPhases,
        ...dirtyAlignmentPhases,
        'wholeSet:caps',
        'wholeSet:merge',
        'wholeSet:index',
        'wholeSet:overlaps',
        'wholeSet:portalOpenings',
        'finalize',
    ]);
    assert.deepEqual(modelShape(cooperative), modelShape(synchronous));
    assert.equal(cooperative.revision, 1);
});
