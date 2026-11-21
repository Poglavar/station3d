// Verifies that the human-facing road-structure trace reports the same
// elevations, dimensions, build stages, and explicit limitations as the model.

import assert from 'node:assert/strict';
import test from 'node:test';

import { RoadVerticalAlignmentModel } from '../core/road-vertical-alignment.js';
import { roadGradeSeparationBuildPlan } from '../core/road-grade-separation-spec.js';
import { buildRoadStructureDecisionTrace } from '../core/road-structure-trace.js';

function modelFor(definition) {
    return new RoadVerticalAlignmentModel({
        anchorLon: 16,
        anchorLat: 45.8,
        anchorElevationAslM: 100,
        terrainSceneYAtLocal: () => 0,
        absoluteToSceneY: heightM => Number(heightM) - 100,
        sampleSpacingM: 10,
        definitions: [definition],
    });
}

test('overpass trace exposes terrain-relative fallback and the concrete build plan', () => {
    const model = modelFor({
        id: 'test-overpass',
        kind: 'overpass',
        memberOsmIds: [101],
        source: 'osm',
        osm: { bridge: 'yes', layer: 1 },
        axis: [[16, 45.8], [16.002, 45.8]],
        profile: {
            type: 'relative-peak',
            peakOffsetM: 6.5,
            peakRange: {
                start: { fraction: 0.4 },
                end: { fraction: 0.6 },
            },
        },
        structureRange: {
            start: { fraction: 0.4 },
            end: { fraction: 0.6 },
        },
        widthM: 8,
    });
    const alignment = model.getAlignmentForOsmId(101);
    const midpoint = alignment.samples[Math.floor(alignment.samples.length / 2)];
    const trace = buildRoadStructureDecisionTrace(model, midpoint.x, midpoint.z);

    assert.equal(trace.id, 'test-overpass');
    assert.equal(trace.kind, 'overpass');
    assert.equal(trace.steps.length, 6);
    assert.equal(trace.steps[2].status, 'heuristic');
    assert.deepEqual(
        trace.steps[2].measurements.roadElevationAslM,
        { min: 100, max: 106.5 },
    );
    assert.ok(
        trace.steps[5].measurements.stages.includes('concrete deck slab'),
        'trace must name the rendered deck stage',
    );
    assert.equal(trace.steps[5].measurements.bridge.deckDepthM, 0.9);
    assert.equal(trace.steps[5].measurements.bridge.fenceHeightM, 2);
    assert.equal(
        trace.steps[5].measurements.curbOwnership.separatedOwnerThresholdM,
        1,
    );
    assert.equal(
        trace.steps[5].measurements.curbOwnership.upperLowerConnectors,
        'removed',
    );
    assert.ok(
        trace.warnings.some(warning => warning.includes('counterpart')),
        'trace must admit that the crossed line is not jointly solved',
    );
});

test('underpass trace reports one continuous replacement and explicit wall/roof dimensions', () => {
    const model = modelFor({
        id: 'test-underpass',
        kind: 'underpass',
        memberOsmIds: [201, 202],
        source: 'osm',
        axis: [[16, 45.8], [16.002, 45.8]],
        profile: {
            type: 'relative-peak',
            peakOffsetM: -6.5,
            peakRange: {
                start: { fraction: 0.35 },
                end: { fraction: 0.65 },
            },
        },
        structureRange: {
            start: { fraction: 0.35 },
            end: { fraction: 0.65 },
        },
        replaceRoadSurface: true,
        replacementCarriagewayOnly: true,
        maxGrade: 0.08,
        laneCountOverride: 2,
        crossSection: {
            carriagewayHalfWidthM: 3.5,
            formationHalfWidthM: 4.25,
            terrainClearHalfWidthM: 8.25,
            terrainCutoutHalfWidthM: 4.25,
        },
    });
    const alignment = model.getAlignmentForOsmId(201);
    const midpoint = alignment.samples[Math.floor(alignment.samples.length / 2)];
    const trace = buildRoadStructureDecisionTrace(model, midpoint.x, midpoint.z);

    assert.equal(trace.steps[1].status, 'owned replacement');
    assert.equal(trace.steps[2].measurements.permittedGradePercent, 8);
    assert.equal(trace.steps[3].measurements.laneCount, 2);
    assert.equal(trace.steps[5].measurements.underpass.wallThicknessM, 0.45);
    assert.equal(trace.steps[5].measurements.underpass.roofDepthM, 0.7);
    assert.ok(
        trace.steps[5].measurements.stages.includes(
            'terrain-to-wall crown collar',
        ),
    );
    assert.ok(
        !trace.warnings.some(warning => warning.includes('continuous replacement')),
        'owned underpass must not be described as member-ended road pieces',
    );
});

test('paired trace distinguishes a clearance-derived absolute deck from survey evidence', () => {
    const model = modelFor({
        id: 'paired-overpass',
        kind: 'overpass',
        memberOsmIds: [301, 302, 303],
        source: 'osm-paired',
        axis: [[16, 45.8], [16.002, 45.8]],
        profile: {
            type: 'terrain-clearance-peak',
            peakElevationAslM: 106.5,
            fallbackOffsetM: 6.5,
            peakRange: {
                start: { fraction: 0.4 },
                end: { fraction: 0.6 },
            },
        },
        crossings: [{
            coordinate: [16.001, 45.8],
            lowerOsmIds: [401],
            requiredClearanceM: 5.5,
            requiredSurfaceSeparationM: 6.5,
        }],
        maxGrade: 0.08,
    });
    const alignment = model.getAlignmentForOsmId(301);
    const midpoint = alignment.samples[Math.floor(alignment.samples.length / 2)];
    const trace = buildRoadStructureDecisionTrace(model, midpoint.x, midpoint.z);

    assert.equal(trace.steps[2].status, 'paired OSM heuristic');
    assert.match(trace.steps[2].decision, /lower-corridor terrain \+ clearance/);
    assert.equal(
        trace.steps[2].measurements.clearanceDerivedPeakElevationAslM,
        106.5,
    );
    assert.ok(
        trace.warnings.some(warning => warning.includes('No surveyed absolute')),
    );
    assert.ok(
        !trace.warnings.some(warning => warning.includes('terrain-relative fallback')),
    );
});

test('trace exposes coupled crossing targets and the fixed-counterpart limitation', () => {
    const model = modelFor({
        id: 'coupled-underpass',
        kind: 'underpass',
        memberOsmIds: [501],
        source: 'osm-paired',
        axis: [[16, 45.8], [16.002, 45.8]],
        profile: {
            type: 'coupled-clearance-peak',
            peakElevationAslM: 93.5,
            peakRange: {
                start: { fraction: 0.4 },
                end: { fraction: 0.6 },
            },
        },
        crossings: [{
            coordinate: [16.001, 45.8],
            upperOsmIds: [601],
            lowerOsmIds: [501],
            requiredClearanceM: 4.5,
            requiredSurfaceSeparationM: 5.3,
            elevationSolution: {
                allocation: 'lower-only',
                feasible: true,
                upperElevationAslM: 100,
                lowerElevationAslM: 94.7,
                upperLiftM: 0,
                lowerCutM: 5.3,
                remainingDeficitM: 0,
            },
        }],
        crossingElevationPairSolved: true,
        replaceRoadSurface: true,
        maxGrade: 0.08,
    });
    const alignment = model.getAlignmentForOsmId(501);
    const midpoint = alignment.samples[Math.floor(alignment.samples.length / 2)];
    const trace = buildRoadStructureDecisionTrace(model, midpoint.x, midpoint.z);

    assert.match(trace.steps[2].decision, /coupled crossing target/);
    assert.equal(
        trace.steps[2].measurements.crossingElevationPairSolved,
        true,
    );
    assert.deepEqual(
        trace.steps[2].measurements.crossingElevationSolutions[0],
        {
            upperElevationAslM: 100,
            lowerElevationAslM: 94.7,
            upperLiftM: 0,
            lowerCutM: 5.3,
            allocation: 'lower-only',
            feasible: true,
            remainingDeficitM: 0,
        },
    );
    assert.ok(trace.warnings.some(warning => (
        warning.includes('counterpart fixed to its normal profile')
    )));
});

test('open-cut build plan has retaining walls and no tunnel box or portals', () => {
    const model = modelFor({
        id: 'split-lower-open-cut',
        kind: 'underpass',
        memberOsmIds: [651],
        source: 'osm-paired-split',
        axis: [[16, 45.8], [16.002, 45.8]],
        profile: {
            type: 'coupled-clearance-peak',
            peakElevationAslM: 95,
        },
        structureMode: 'open-cut',
        replaceRoadSurface: true,
        replacementCarriagewayOnly: true,
        crossSection: {
            carriagewayHalfWidthM: 3.25,
            formationHalfWidthM: 4,
            terrainClearHalfWidthM: 8,
            terrainCutoutHalfWidthM: 4,
        },
    });
    const alignment = model.getAlignmentForOsmId(651);
    const plan = roadGradeSeparationBuildPlan(alignment, [alignment]);

    assert.equal(plan.underpass.structureMode, 'open-cut');
    assert.ok(plan.stages.includes('replacement road surface'));
    assert.ok(plan.stages.includes('thick concrete approach walls'));
    assert.ok(plan.stages.includes('terrain-to-wall crown collar'));
    assert.ok(!plan.stages.includes('thick concrete underpass box and roof slab'));
    assert.ok(!plan.stages.includes('start portal'));
    assert.ok(!plan.stages.includes('end portal'));
});

test('trace makes an infeasible crossing pair explicit', () => {
    const model = modelFor({
        id: 'infeasible-overpass',
        kind: 'overpass',
        memberOsmIds: [701],
        source: 'osm-paired',
        axis: [[16, 45.8], [16.002, 45.8]],
        profile: {
            type: 'absolute-peak',
            peakElevationAslM: 104,
        },
        crossings: [{
            coordinate: [16.001, 45.8],
            requiredSurfaceSeparationM: 6.5,
            elevationSolution: {
                allocation: 'existing-clearance',
                feasible: false,
                upperElevationAslM: 104,
                lowerElevationAslM: 100,
                upperLiftM: 0,
                lowerCutM: 0,
                remainingDeficitM: 2.5,
            },
        }],
        crossingElevationPairSolved: false,
    });
    const alignment = model.getAlignmentForOsmId(701);
    const midpoint = alignment.samples[Math.floor(alignment.samples.length / 2)];
    const trace = buildRoadStructureDecisionTrace(model, midpoint.x, midpoint.z);

    assert.equal(
        trace.steps[2].measurements.crossingElevationSolutions[0]
            .remainingDeficitM,
        2.5,
    );
    assert.ok(trace.warnings.some(warning => (
        warning.includes('cannot satisfy the required separation')
    )));
});

test('trace can pin an OSM owner instead of selecting a nearer unrelated alignment', () => {
    const model = new RoadVerticalAlignmentModel({
        anchorLon: 16,
        anchorLat: 45.8,
        terrainSceneYAtLocal: () => 0,
        definitions: [
            {
                id: 'near',
                kind: 'overpass',
                memberOsmIds: [1],
                axis: [[16, 45.8], [16.001, 45.8]],
                profile: { type: 'relative-peak', peakOffsetM: 6.5 },
            },
            {
                id: 'pinned',
                kind: 'underpass',
                memberOsmIds: [2],
                axis: [[16, 45.8002], [16.001, 45.8002]],
                profile: { type: 'terrain-offset', offsetM: -6.5 },
            },
        ],
    });
    const trace = buildRoadStructureDecisionTrace(model, 0, 0, {
        radiusM: 100,
        osmId: 2,
    });

    assert.equal(trace.id, 'pinned');
});

test('companion trace reports the structural owner and its rendered elevation', () => {
    const model = new RoadVerticalAlignmentModel({
        anchorLon: 16,
        anchorLat: 45.8,
        anchorElevationAslM: 100,
        terrainSceneYAtLocal: () => 0,
        absoluteToSceneY: heightM => Number(heightM) - 100,
        sampleSpacingM: 10,
        definitions: [
            {
                id: 'carriageway-owner',
                kind: 'overpass',
                memberOsmIds: [701],
                axis: [[16, 45.8], [16.002, 45.8]],
                profile: {
                    type: 'absolute-peak',
                    peakElevationAslM: 108,
                    peakRange: {
                        start: { fraction: 0.4 },
                        end: { fraction: 0.6 },
                    },
                },
                widthM: 8,
            },
            {
                id: 'cycleway-companion',
                kind: 'overpass',
                memberOsmIds: [702, 703],
                axis: [[16, 45.80005], [16.002, 45.80005]],
                profile: {
                    type: 'relative-peak',
                    peakOffsetM: 4,
                    peakRange: {
                        start: { fraction: 0.4 },
                        end: { fraction: 0.6 },
                    },
                },
                widthM: 2.5,
                renderStructure: false,
            },
        ],
    });
    const cycleway = model.getAlignmentForOsmId(702);
    const midpoint = cycleway.samples[Math.floor(cycleway.samples.length / 2)];
    const trace = buildRoadStructureDecisionTrace(
        model,
        midpoint.x,
        midpoint.z,
        { osmId: 702 },
    );

    assert.deepEqual(trace.profileOwner, {
        id: 'carriageway-owner',
        memberOsmIds: ['701'],
        inherited: true,
    });
    assert.equal(trace.steps[0].status, 'surface companion');
    assert.equal(trace.steps[2].status, 'inherited from carriageway-owner');
    assert.deepEqual(
        trace.steps[2].measurements.roadElevationAslM,
        { min: 100, max: 108 },
    );
    assert.equal(trace.steps[5].status, 'owned by carriageway-owner');
    assert.ok(
        trace.steps[5].measurements.stages.includes('concrete deck slab'),
    );
});
