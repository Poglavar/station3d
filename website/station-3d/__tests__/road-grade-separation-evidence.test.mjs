// Verifies paired OSM road/rail crossing evidence, clear zones, and continuous
// overpass approaches without Three.js or a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    roadGradeSeparationClearRange,
    roadGradeSeparationCrossingClearHalfLengthsM,
    roadGradeSeparationCorridorRecords,
    roadGradeSeparationCrossings,
    solveRoadGradeSeparationElevationPair,
} from '../core/road-grade-separation-evidence.js';
import {
    roadStructureSupportClearanceAtLocal,
    roadVerticalCenterlinesFromSurfaceFeatures,
    RoadVerticalAlignmentModel,
} from '../core/road-vertical-alignment.js';
import { resolveIntelligentPillarSamples } from '../core/intelligent-pillar-placement.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const ANCHOR_LAT = 45.73;
const ANCHOR_LON = 16.03;
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);

function lonLat(x, z = 0) {
    return [ANCHOR_LON + x / M_PER_LON, ANCHOR_LAT - z / M_PER_LAT];
}

function surfaceFeature(osmId, properties, coordinates) {
    return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [] },
        properties: {
            osm_id: osmId,
            ...properties,
            centerline_geometry: {
                type: 'LineString',
                coordinates,
            },
        },
    };
}

function lomnicaLikeFeatures() {
    return [
        surfaceFeature(101, {
            highway_type: 'secondary',
            tags: { highway: 'secondary', ref: '3109', lanes: '2' },
        }, [lonLat(-160), lonLat(0)]),
        surfaceFeature(102, {
            highway_type: 'secondary',
            tags: {
                highway: 'secondary',
                ref: '3109',
                lanes: '2',
                bridge: 'yes',
                layer: '1',
            },
        }, [lonLat(0), lonLat(100)]),
        surfaceFeature(103, {
            highway_type: 'secondary',
            tags: { highway: 'secondary', ref: '3109', lanes: '2' },
        }, [lonLat(100), lonLat(260)]),
        surfaceFeature(201, {
            highway_type: 'motorway',
            tags: { highway: 'motorway', lanes: '2', oneway: 'yes' },
        }, [lonLat(45, -100), lonLat(45, 100)]),
        surfaceFeature(301, {
            railway_type: 'rail',
            tags: {
                railway: 'rail',
                gauge: '1435',
                electrified: 'contact_line',
            },
        }, [lonLat(60, -100), lonLat(60, 100)]),
    ];
}

test('splits a clearance deficit by minimum weighted corridor movement', () => {
    const solution = solveRoadGradeSeparationElevationPair({
        upperBaseElevationAslM: 100,
        lowerBaseElevationAslM: 100,
        requiredSurfaceSeparationM: 6.5,
    });

    assert.equal(solution.status, 'solved');
    assert.equal(solution.allocation, 'split');
    assert.equal(solution.upperLiftM, 3.25);
    assert.equal(solution.lowerCutM, 3.25);
    assert.equal(solution.upperElevationAslM, 103.25);
    assert.equal(solution.lowerElevationAslM, 96.75);
    assert.equal(solution.achievedSeparationM, 6.5);
});

test('moves the remaining corridor when an approach/ownership cap binds', () => {
    const solution = solveRoadGradeSeparationElevationPair({
        upperBaseElevationAslM: 100,
        lowerBaseElevationAslM: 100,
        requiredSurfaceSeparationM: 6.5,
        upperRaiseLimitM: 2,
    });

    assert.equal(solution.status, 'solved');
    assert.equal(solution.allocation, 'split');
    assert.equal(solution.upperLiftM, 2);
    assert.equal(solution.lowerCutM, 4.5);
    assert.equal(solution.remainingDeficitM, 0);
});

test('reports an infeasible pair instead of hiding a clearance deficit', () => {
    const solution = solveRoadGradeSeparationElevationPair({
        upperBaseElevationAslM: 100,
        lowerBaseElevationAslM: 100,
        requiredSurfaceSeparationM: 6.5,
        upperRaiseLimitM: 2,
        lowerCutLimitM: 2,
    });

    assert.equal(solution.status, 'infeasible');
    assert.equal(solution.feasible, false);
    assert.equal(solution.achievedSeparationM, 4);
    assert.equal(solution.remainingDeficitM, 2.5);
});

test('pairs a bridge with every crossed road/rail and measures one clear zone', () => {
    const corridors = roadGradeSeparationCorridorRecords(
        lomnicaLikeFeatures(),
    );
    const owner = corridors.find(record => record.osmId === '102');
    const crossings = roadGradeSeparationCrossings(
        owner,
        corridors,
        'overpass',
    );

    assert.equal(crossings.length, 2);
    assert.deepEqual(
        crossings.map(crossing => crossing.lowerOsmIds[0]),
        ['201', '301'],
    );
    assert.equal(crossings[0].requiredClearanceM, 4.5);
    assert.equal(crossings[0].requiredSurfaceSeparationM, 5.5);
    assert.equal(crossings[1].requiredClearanceM, 5.5);
    assert.equal(crossings[1].requiredSurfaceSeparationM, 6.5);

    const clearRange = roadGradeSeparationClearRange(owner, crossings);
    assert.ok(clearRange.startM < 40, `${clearRange.startM}`);
    assert.ok(clearRange.endM > 63, `${clearRange.endM}`);
    assert.equal(clearRange.requiredSurfaceSeparationM, 6.5);
});

test('uses pedestrian box clearance for a footway tunnel below a road', () => {
    const features = [
        surfaceFeature(200342423, {
            highway_type: 'footway',
            tags: { highway: 'footway', tunnel: 'yes', layer: '-1' },
        }, [lonLat(-30), lonLat(30)]),
        surfaceFeature(179958692, {
            highway_type: 'secondary',
            tags: { highway: 'secondary', layer: '0' },
        }, [lonLat(0, -30), lonLat(0, 30)]),
    ];
    const corridors = roadGradeSeparationCorridorRecords(features);
    const owner = corridors.find(record => record.osmId === '200342423');
    const [crossing] = roadGradeSeparationCrossings(
        owner,
        corridors,
        'underpass',
    );

    assert.ok(crossing);
    assert.equal(crossing.requiredClearanceM, 2.6);
    assert.ok(Math.abs(crossing.requiredSurfaceSeparationM - 3.15) < 1e-9);
});

test('keeps bridge supports outside complete crossed road and rail envelopes', () => {
    const [centerline] = roadVerticalCenterlinesFromSurfaceFeatures(
        lomnicaLikeFeatures(),
    );
    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 10,
        sampleSpacingM: 4,
    });
    model.setCenterlineTile('surface', [centerline]);
    const alignment = model.getAlignmentForOsmId(102);

    assert.equal(alignment.crossingClearRanges.length, 2);
    assert.ok(
        roadStructureSupportClearanceAtLocal(alignment, null, 45, 0) < 0,
        'the motorway formation and swept margin must reject a pier',
    );
    assert.ok(
        roadStructureSupportClearanceAtLocal(alignment, null, 60, 0) < 0,
        'the rail formation and swept margin must reject a pier',
    );
    assert.ok(
        roadStructureSupportClearanceAtLocal(alignment, null, 25, 0) > 0,
        'a station outside both projected crossing envelopes remains usable',
    );

    const [placed] = resolveIntelligentPillarSamples(
        [{ x: 60, z: 0, s: 60, ux: 1, uz: 0 }],
        (x, z) => roadStructureSupportClearanceAtLocal(
            alignment,
            null,
            x,
            z,
        ),
        { slideMaxM: 30 },
    );
    assert.equal(placed.placement, 'slid');
    assert.ok(
        roadStructureSupportClearanceAtLocal(
            alignment,
            null,
            placed.x,
            placed.z,
        ) >= 0,
    );
});

test('does not compile a terrain-relative road before every station has evidence', () => {
    const [centerline] = roadVerticalCenterlinesFromSurfaceFeatures(
        lomnicaLikeFeatures(),
    );
    const missing = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: x => (x < 30 ? 0 : null),
        sampleSpacingM: 4,
    });
    missing.setCenterlineTile('surface', [centerline]);
    assert.equal(missing.getAlignmentForOsmId(102), null);

    const ready = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 0,
        sampleSpacingM: 4,
    });
    ready.setCenterlineTile('surface', [centerline]);
    assert.ok(ready.getAlignmentForOsmId(102),
        'zero-height evidence is valid; only absence defers publication');
});

test('derives support clear ranges from canonical crossing composition', () => {
    const range = roadGradeSeparationCrossingClearHalfLengthsM({
        angleDeg: 30,
        lowerComposition: { formationWidthM: 8 },
    }, 'overpass');
    assert.ok(
        Math.abs(range.beforeM - 9) < 1e-9
        && Math.abs(range.afterM - 9) < 1e-9,
    );
});

test('extends an unmeasured bridge into one grade-bounded approach profile', () => {
    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures(
        lomnicaLikeFeatures(),
    );
    assert.equal(centerlines.length, 1);
    const details = centerlines[0].properties.road_vertical_alignment;

    assert.equal(details.source, 'osm-paired');
    assert.deepEqual(
        new Set(details.memberOsmIds),
        new Set(['101', '102', '103']),
    );
    assert.equal(details.crossings.length, 2);
    assert.equal(details.profile.peakOffsetM, 6.5);
    assert.ok(Math.abs(details.profile.approachRunoutM.start - 12) < 1e-6);
    assert.ok(Math.abs(details.profile.approachRunoutM.end - 12) < 1e-6);
    assert.equal(details.maxGrade, 0.08);
    assert.ok(
        centerlines[0].geometry.coordinates.length >= 4,
        'the axis includes real approach geometry rather than only the bridge member',
    );

    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 10,
        sampleSpacingM: 4,
    });
    model.setCenterlineTile('surface', centerlines);
    const alignment = model.getAlignmentForOsmId(102);
    assert.equal(model.getAlignmentForOsmId(101), alignment);
    assert.equal(model.getAlignmentForOsmId(103), alignment);
    assert.ok(alignment.structureStartM > 70, `${alignment.structureStartM}`);
    assert.ok(
        alignment.structureEndM - alignment.structureStartM > 99.9,
        'the physical deck remains the complete tagged bridge member',
    );
    assert.equal(
        model.roadYAtLocal(
            alignment.points[0].x,
            alignment.points[0].z,
            101,
        ),
        10,
    );
    assert.ok(model.roadYAtLocal(-40, 0, 101) > 10);
    assert.equal(model.roadYAtLocal(50, 0, 102), 16.5);
    const lastPoint = alignment.points[alignment.points.length - 1];
    assert.equal(model.roadYAtLocal(lastPoint.x, lastPoint.z, 103), 10);
    assert.ok(
        alignment.samples
            .filter(sample => (
                sample.s <= details.profile.approachRunoutM.start
            ))
            .every(sample => sample.y === sample.terrainY),
        'the alignment begins with an at-grade runout before the vertical curve',
    );

    let maximumGrade = 0;
    for (let index = 0; index + 1 < alignment.samples.length; index++) {
        const a = alignment.samples[index];
        const b = alignment.samples[index + 1];
        maximumGrade = Math.max(
            maximumGrade,
            Math.abs(b.y - a.y) / (b.s - a.s),
        );
    }
    assert.ok(maximumGrade <= 0.0801, `${maximumGrade}`);
});

test('derives one absolute deck elevation from the highest lower clearance target', () => {
    const terrainElevationAslMAtCoordinate = ([lon]) => {
        const x = (Number(lon) - ANCHOR_LON) * M_PER_LON;
        return x >= 55 ? 11 : 10;
    };
    const [centerline] = roadVerticalCenterlinesFromSurfaceFeatures(
        lomnicaLikeFeatures(),
        { terrainElevationAslMAtCoordinate },
    );
    const details = centerline.properties.road_vertical_alignment;

    assert.equal(details.profile.type, 'terrain-clearance-peak');
    assert.equal(details.profile.peakElevationAslM, 17.5);
    assert.deepEqual(
        details.crossings.map(crossing => (
            crossing.elevationSolution.allocation
        )),
        ['upper-only', 'upper-only'],
    );
    assert.ok(details.crossings.every(crossing => (
        crossing.elevationSolution.lowerOwnership === 'fixed-counterpart'
        && crossing.elevationSolution.feasible
    )));
    assert.ok(
        details.approachLengthsM.start > details.approachLengthsM.end,
        'the lower start terrain needs a longer vertical curve to the same deck',
    );

    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        anchorElevationAslM: 0,
        terrainSceneYAtLocal: x => (x >= 55 ? 11 : 10),
        absoluteToSceneY: heightM => heightM,
        sampleSpacingM: 4,
    });
    model.setCenterlineTile('surface', [centerline]);

    assert.equal(model.roadYAtLocal(45, 0, 102), 17.5);
    assert.equal(model.roadYAtLocal(60, 0, 102), 17.5);
});

test('solves a road overpass against the rail-owned profile, not bare earth', () => {
    const [centerline] = roadVerticalCenterlinesFromSurfaceFeatures(
        lomnicaLikeFeatures(),
        {
            terrainElevationAslMAtCoordinate: ([lon]) => {
                const x = (Number(lon) - ANCHOR_LON) * M_PER_LON;
                return x >= 55 ? 11 : 10;
            },
            railElevationAslMAtCoordinate: (_coordinate, { composition }) => ({
                elevationAslM: 14,
                source: 'rail-formation',
                match: composition.ref ? 'rail-ref' : 'nearest-route',
                alignmentId: 'legacy:M604',
                distanceM: 0.2,
                authoredAbsolute: true,
            }),
        },
    );
    const details = centerline.properties.road_vertical_alignment;
    const railCrossing = details.crossings.find(crossing => (
        crossing.lowerComposition.mode === 'rail'
    ));

    assert.equal(details.profile.peakElevationAslM, 20.5);
    assert.equal(railCrossing.elevationSolution.lowerBaseElevationAslM, 14);
    assert.equal(railCrossing.elevationSolution.lowerBaseSource, 'rail-formation');
    assert.equal(railCrossing.elevationSolution.lowerCutM, 0);
    assert.equal(railCrossing.elevationSolution.upperElevationAslM, 20.5);
    assert.equal(railCrossing.elevationEvidence.lower.alignmentId, 'legacy:M604');
    assert.equal(railCrossing.elevationEvidence.lower.authoredAbsolute, true);
});

test('solves a road underpass below a rail profile already cut into terrain', () => {
    const features = [
        surfaceFeature(501, {
            highway_type: 'secondary',
            tags: { highway: 'secondary', ref: '501' },
        }, [lonLat(-160), lonLat(0)]),
        surfaceFeature(502, {
            highway_type: 'secondary',
            tags: {
                highway: 'secondary',
                ref: '501',
                tunnel: 'yes',
                layer: '-1',
            },
        }, [lonLat(0), lonLat(100)]),
        surfaceFeature(503, {
            highway_type: 'secondary',
            tags: { highway: 'secondary', ref: '501' },
        }, [lonLat(100), lonLat(260)]),
        surfaceFeature(601, {
            railway_type: 'rail',
            tags: { railway: 'rail', layer: '0', ref: 'M604' },
        }, [lonLat(50, -100), lonLat(50, 100)]),
    ];
    const [centerline] = roadVerticalCenterlinesFromSurfaceFeatures(features, {
        terrainElevationAslMAtCoordinate: () => 20,
        railElevationAslMAtCoordinate: () => ({
            elevationAslM: 15,
            source: 'rail-formation',
            match: 'rail-ref',
        }),
    });
    const details = centerline.properties.road_vertical_alignment;
    const [crossing] = details.crossings;

    assert.equal(crossing.elevationSolution.upperBaseElevationAslM, 15);
    assert.equal(crossing.elevationSolution.upperBaseSource, 'rail-formation');
    assert.equal(crossing.elevationSolution.upperLiftM, 0);
    assert.ok(Math.abs(crossing.elevationSolution.lowerElevationAslM - 9.7) < 1e-9);
    assert.ok(Math.abs(details.profile.peakElevationAslM - 9.7) < 1e-9);
});

test('does not replace a missing canonical rail profile with bare earth', () => {
    const [centerline] = roadVerticalCenterlinesFromSurfaceFeatures(
        lomnicaLikeFeatures(),
        {
            terrainElevationAslMAtCoordinate: () => 10,
            railElevationAslMAtCoordinate: () => null,
        },
    );
    const railCrossing = centerline.properties.road_vertical_alignment.crossings
        .find(crossing => crossing.lowerComposition.mode === 'rail');

    assert.equal(railCrossing.elevationSolution, undefined);
    assert.deepEqual(railCrossing.elevationEvidence.lower, {
        elevationAslM: null,
        source: 'rail-formation-unavailable',
    });
});

test('keeps explicit OSM elevation fixed, cuts a road, and reports fixed rail deficit', () => {
    const features = lomnicaLikeFeatures();
    const bridge = features.find(feature => feature.properties.osm_id === 102);
    bridge.properties.tags.ele = '14';
    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures(features, {
        terrainElevationAslMAtCoordinate: () => 10,
    });
    const centerline = centerlines.find(feature => (
        feature.properties.osm_id === 102
    ));
    const details = centerline.properties.road_vertical_alignment;
    const roadCrossing = details.crossings.find(crossing => (
        crossing.lowerOsmIds.includes('201')
    ));
    const railCrossing = details.crossings.find(crossing => (
        crossing.lowerOsmIds.includes('301')
    ));

    assert.equal(details.profile.type, 'absolute-peak');
    assert.equal(details.profile.peakElevationAslM, 14);
    assert.equal(details.crossingElevationPairSolved, false);
    assert.equal(roadCrossing.elevationSolution.status, 'solved');
    assert.equal(roadCrossing.elevationSolution.allocation, 'lower-only');
    assert.equal(roadCrossing.elevationSolution.lowerCutM, 1.5);
    assert.equal(
        roadCrossing.elevationSolution.lowerOwnership,
        'generated-counterpart',
    );
    assert.equal(railCrossing.elevationSolution.status, 'infeasible');
    assert.equal(railCrossing.elevationSolution.lowerCutM, 0);
    assert.equal(railCrossing.elevationSolution.remainingDeficitM, 2.5);

    const lower = centerlines.find(feature => (
        feature.properties.road_vertical_alignment?.structureMode === 'open-cut'
    ));
    assert.ok(lower);
    assert.equal(lower.properties.osm_id, 201);
    assert.equal(
        lower.properties.road_vertical_alignment.profile.peakElevationAslM,
        8.5,
    );
    assert.equal(
        lower.properties.road_vertical_alignment.pairedAlignmentId,
        'osm-102',
    );
});

test('splits road-road clearance when the tagged bridge has insufficient approach run', () => {
    const features = [
        surfaceFeature(710, {
            highway_type: 'secondary',
            tags: {
                highway: 'secondary',
                bridge: 'yes',
                layer: '1',
            },
        }, [lonLat(0), lonLat(20)]),
        surfaceFeature(720, {
            highway_type: 'secondary',
            tags: { highway: 'secondary', layer: '0' },
        }, [lonLat(10, -150), lonLat(10, 150)]),
    ];
    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures(features, {
        terrainElevationAslMAtCoordinate: () => 10,
    });
    const upperFeature = centerlines.find(feature => (
        feature.properties.osm_id === 710
    ));
    const lowerFeature = centerlines.find(feature => (
        feature.properties.osm_id === 720
    ));
    const upperDetails = upperFeature.properties.road_vertical_alignment;
    const lowerDetails = lowerFeature.properties.road_vertical_alignment;
    const [solution] = upperDetails.crossings.map(crossing => (
        crossing.elevationSolution
    ));

    assert.equal(centerlines.length, 2);
    assert.equal(solution.allocation, 'split');
    assert.ok(solution.upperLiftM > 0 && solution.upperLiftM < 0.3);
    assert.ok(solution.lowerCutM > 5.2 && solution.lowerCutM < 5.5);
    assert.ok(Math.abs(solution.achievedSeparationM - 5.5) < 1e-9);
    assert.equal(upperDetails.jointProfileSolved, true);
    assert.equal(lowerDetails.structureMode, 'open-cut');
    assert.equal(lowerDetails.jointProfileSolved, true);

    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 10,
        absoluteToSceneY: heightM => heightM,
        sampleSpacingM: 1,
    });
    model.setCenterlineTile('surface', centerlines);
    const upperY = model.roadYAtLocal(10, 0, 710);
    const lowerY = model.roadYAtLocal(10, 0, 720);
    assert.ok(Math.abs(upperY - lowerY - 5.5) < 1e-6);
    for (const osmId of [710, 720]) {
        const alignment = model.getAlignmentForOsmId(osmId);
        let maximumGrade = 0;
        for (let index = 0; index + 1 < alignment.samples.length; index++) {
            const a = alignment.samples[index];
            const b = alignment.samples[index + 1];
            maximumGrade = Math.max(
                maximumGrade,
                Math.abs(b.y - a.y) / (b.s - a.s),
            );
        }
        assert.ok(maximumGrade <= 0.0801, `${osmId}: ${maximumGrade}`);
    }
});

test('one lower road owns a continuous profile beneath road, rail, and foot bridges', () => {
    const lowerRoad = surfaceFeature(846828121, {
        highway_type: 'tertiary',
        tags: {
            highway: 'tertiary',
            name: 'Miramarski podvožnjak',
            ref: '10078',
            lanes: '4',
            maxheight: '3.65',
        },
    }, [lonLat(0, -180), lonLat(0, 180)]);
    const roadBridge = surfaceFeature(405207956, {
        highway_type: 'unclassified',
        tags: { highway: 'unclassified', bridge: 'yes', layer: '1' },
    }, [lonLat(-15, -55), lonLat(15, -55)]);
    const railBridge = surfaceFeature(739579926, {
        railway_type: 'rail',
        tags: { railway: 'rail', bridge: 'yes', layer: '1' },
    }, [lonLat(-15, 0), lonLat(15, 0)]);
    const footBridge = surfaceFeature(207567941, {
        highway_type: 'footway',
        tags: { highway: 'footway', bridge: 'yes', layer: '1' },
    }, [lonLat(-15, 55), lonLat(15, 55)]);
    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures([
        lowerRoad,
        roadBridge,
        railBridge,
        footBridge,
    ], {
        terrainElevationAslMAtCoordinate: () => 10,
        railElevationAslMAtCoordinate: () => ({
            elevationAslM: 16.5,
            source: 'rail-formation',
        }),
    });
    const lowers = centerlines.filter(feature => (
        feature.properties.road_vertical_alignment?.kind === 'underpass'
    ));
    assert.equal(lowers.length, 1, 'competing upper bridges share one lower owner');
    const details = lowers[0].properties.road_vertical_alignment;
    assert.equal(details.source, 'osm-paired-split-composite');
    assert.deepEqual(details.replaceRoadSurfaceOsmIds, ['846828121']);
    assert.deepEqual(
        new Set(details.crossings.flatMap(crossing => crossing.upperOsmIds)),
        new Set(['405207956', '739579926', '207567941']),
        'the canonical low plateau spans every upper transport mode',
    );

    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 10,
        absoluteToSceneY: heightM => heightM,
        sampleSpacingM: 1,
    });
    model.setCenterlineTile('miramarska', centerlines);
    const lower = model.getAlignmentForOsmId(846828121);
    assert.ok(lower);
    for (const z of [-55, 0, 55]) {
        const lowerY = model.roadYAtLocal(0, z, 846828121);
        assert.ok(lowerY < 10 - 4, `lower road remains in its trench at z=${z}`);
        assert.equal(
            model.isInsideReplacementTerrainOpening(0, z),
            true,
            `terrain opens over the lower road at z=${z}`,
        );
    }
    const roadUpperY = model.roadYAtLocal(0, -55, 405207956);
    const footUpperY = model.roadYAtLocal(0, 55, 207567941);
    assert.ok(roadUpperY - model.roadYAtLocal(0, -55, 846828121) >= 5.5 - 1e-6);
    assert.ok(footUpperY - model.roadYAtLocal(0, 55, 846828121) >= 5.5 - 1e-6);
    assert.ok(16.5 - model.roadYAtLocal(0, 0, 846828121) >= 5.5);
});

test('a single road-under-footbridge counterpart also stays low beneath adjacent rail bridges', () => {
    const lowerRoad = surfaceFeature(846828121, {
        highway_type: 'tertiary',
        tags: {
            highway: 'tertiary',
            name: 'Miramarski podvožnjak',
            ref: '10078',
            lanes: '4',
            maxheight: '3.65',
        },
    }, [lonLat(0, -120), lonLat(0, 120)]);
    const railBridge = surfaceFeature(739579926, {
        railway_type: 'rail',
        tags: { railway: 'rail', bridge: 'yes', layer: '1' },
    }, [lonLat(-15, -35), lonLat(15, -35)]);
    const footBridge = surfaceFeature(207567941, {
        highway_type: 'footway',
        tags: { highway: 'footway', bridge: 'yes', layer: '1' },
    }, [lonLat(-15, 35), lonLat(15, 35)]);

    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures([
        lowerRoad,
        railBridge,
        footBridge,
    ], {
        terrainElevationAslMAtCoordinate: () => 10,
        railElevationAslMAtCoordinate: () => ({
            elevationAslM: 16.5,
            source: 'rail-formation',
        }),
    });
    const lowers = centerlines.filter(feature => (
        feature.properties.road_vertical_alignment?.kind === 'underpass'
    ));
    assert.equal(lowers.length, 1);
    const details = lowers[0].properties.road_vertical_alignment;
    assert.equal(details.source, 'osm-paired-split-composite');
    assert.deepEqual(
        new Set(details.crossings.flatMap(crossing => crossing.upperOsmIds)),
        new Set(['739579926', '207567941']),
        'non-road crossing owners extend the one generated lower profile',
    );

    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 10,
        absoluteToSceneY: heightM => heightM,
        sampleSpacingM: 1,
    });
    model.setCenterlineTile('miramarska-foot-and-rail', centerlines);
    for (const z of [-35, 35]) {
        assert.ok(
            model.roadYAtLocal(0, z, 846828121) < 6,
            `the road floor must not climb between the structures at z=${z}`,
        );
    }
});

test('a split lower approach replaces every traced Miramarska asphalt member', () => {
    const roadProperties = {
        highway_type: 'tertiary',
        tags: {
            highway: 'tertiary',
            name: 'Miramarski podvožnjak',
            ref: '10078',
            lanes: '4',
            maxheight: '3.65',
        },
    };
    const southApproach = surfaceFeature(
        35866854,
        roadProperties,
        [lonLat(0, -160), lonLat(0, -10)],
    );
    const crossedMember = surfaceFeature(
        846828121,
        roadProperties,
        [lonLat(0, -10), lonLat(0, 10)],
    );
    const northApproach = surfaceFeature(
        30166661,
        roadProperties,
        [lonLat(0, 10), lonLat(0, 160)],
    );
    const footBridge = surfaceFeature(207567941, {
        highway_type: 'footway',
        tags: { highway: 'footway', bridge: 'yes', layer: '1' },
    }, [lonLat(-15, 0), lonLat(15, 0)]);
    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures([
        southApproach,
        crossedMember,
        northApproach,
        footBridge,
    ], {
        terrainElevationAslMAtCoordinate: () => 10,
    });
    const lower = centerlines.find(feature => (
        feature.properties.road_vertical_alignment?.kind === 'underpass'
    ));
    assert.ok(lower, 'the footbridge produces a lower-road counterpart');
    const details = lower.properties.road_vertical_alignment;
    assert.equal(details.source, 'osm-paired-split');
    assert.deepEqual(
        new Set(details.replaceRoadSurfaceOsmIds.map(String)),
        new Set(['35866854', '846828121', '30166661']),
        'the generated floor owns both traced approach ways and the seed way',
    );

    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 10,
        absoluteToSceneY: heightM => heightM,
        sampleSpacingM: 1,
    });
    model.setCenterlineTile('miramarska-split', centerlines);
    for (const osmId of [35866854, 846828121, 30166661]) {
        assert.equal(
            model.replacesRoadSurfaceForOsmId(osmId),
            true,
            `ordinary asphalt ${osmId} is suppressed beneath the continuous floor`,
        );
    }
    assert.ok(model.roadYAtLocal(0, -80, 35866854) < 10);
    assert.ok(model.roadYAtLocal(0, 80, 30166661) < 10);
});

test('real Miramarska topology stays low through ground gaps between three bridges', () => {
    const anchorLat = 45.804239;
    const anchorLon = 15.974078;
    const metresPerLon = M_PER_LAT * Math.cos(anchorLat * DEG_TO_RAD);
    const local = ([lon, lat]) => ({
        x: (Number(lon) - anchorLon) * metresPerLon,
        z: -(Number(lat) - anchorLat) * M_PER_LAT,
    });
    const roadProperties = {
        highway_type: 'tertiary',
        tags: {
            highway: 'tertiary',
            name: 'Miramarski podvožnjak',
            short_name: 'Miramarska',
            ref: '10078',
            lanes: '4',
            maxheight: '3.65',
        },
    };
    const north = surfaceFeature(30166661, roadProperties, [
        [15.9739932, 45.805602],
        [15.9739952, 45.8055651],
        [15.973999, 45.8054654],
        [15.9740039, 45.8054136],
        [15.9740214, 45.805227],
    ]);
    const middle = surfaceFeature(846828121, roadProperties, [
        [15.9740214, 45.805227],
        [15.974119, 45.8043385],
    ]);
    const south = surfaceFeature(35866854, roadProperties, [
        [15.974119, 45.8043385],
        [15.9741636, 45.8039833],
    ]);
    const footBridge = surfaceFeature(207567941, {
        highway_type: 'footway',
        tags: { highway: 'footway', bridge: 'yes', layer: '1' },
    }, [
        [15.973939, 45.8045395],
        [15.9739356, 45.8045733],
        [15.9739682, 45.8045749],
        [15.974222, 45.8045874],
    ]);
    const railBridge = surfaceFeature(739579926, {
        railway_type: 'rail',
        tags: { railway: 'rail', bridge: 'yes', layer: '1' },
    }, [
        [15.9742654, 45.8042205],
        [15.9740226, 45.8042068],
    ]);
    const roadBridge = surfaceFeature(405207956, {
        highway_type: 'unclassified',
        tags: { highway: 'unclassified', bridge: 'yes', layer: '1' },
    }, [
        [15.9742891, 45.8040726],
        [15.9740434, 45.80406],
    ]);
    for (const lowerMember of [north, middle, south]) {
        assert.equal(lowerMember.properties.tags.layer, undefined);
        assert.equal(lowerMember.properties.tags.tunnel, undefined);
    }

    // Model the user's suspected failure explicitly: DGU rises in the open
    // space between the rail and Koturaška bridges. That terrain is lateral
    // evidence for the cut walls, never a vertical anchor for the road floor.
    const terrainAslAtCoordinate = ([, lat]) => {
        const distance = (Number(lat) - 45.80413) / 0.000055;
        return 116 + 2.2 * Math.exp(-(distance * distance));
    };
    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures([
        north,
        middle,
        south,
        footBridge,
        railBridge,
        roadBridge,
    ], {
        terrainElevationAslMAtCoordinate: terrainAslAtCoordinate,
        railElevationAslMAtCoordinate: () => ({
            elevationAslM: 119,
            source: 'rail-formation',
        }),
    });
    const lowerFeature = centerlines.find(feature => (
        feature.properties.road_vertical_alignment?.kind === 'underpass'
    ));
    assert.ok(lowerFeature);
    const details = lowerFeature.properties.road_vertical_alignment;
    assert.equal(details.source, 'osm-paired-split-composite');
    assert.deepEqual(
        new Set(details.replaceRoadSurfaceOsmIds.map(String)),
        new Set(['30166661', '846828121', '35866854']),
    );
    assert.deepEqual(
        new Set(details.crossings.flatMap(crossing => crossing.upperOsmIds)),
        new Set(['207567941', '739579926', '405207956']),
    );

    const model = new RoadVerticalAlignmentModel({
        anchorLat,
        anchorLon,
        terrainSceneYAtLocal: (x, z) => terrainAslAtCoordinate([
            anchorLon + x / metresPerLon,
            anchorLat - z / M_PER_LAT,
        ]),
        absoluteToSceneY: heightM => heightM,
        sampleSpacingM: 1,
    });
    model.setCenterlineTile('miramarska-real', centerlines);
    const lower = model.getAlignmentForOsmId(35866854);
    assert.ok(lower);
    const crossingStations = details.crossings
        .map(crossing => local(crossing.coordinate))
        .map(point => lower.nearest(point.x, point.z).s)
        .sort((a, b) => a - b);
    const centralStations = [
        ...crossingStations,
        ...crossingStations.slice(0, -1).map((stationM, index) => (
            (stationM + crossingStations[index + 1]) * 0.5
        )),
    ];
    const centralYs = centralStations.map(stationM => lower.profileYAtS(stationM));
    assert.ok(
        Math.max(...centralYs) - Math.min(...centralYs) < 1e-6,
        'the lower road is one level plateau beneath bridges and intervening ground',
    );
    const reportedPoint = local([15.9741521, 45.8041102]);
    const reportedY = model.roadYAtLocal(
        reportedPoint.x,
        reportedPoint.z,
        35866854,
    );
    assert.ok(Math.abs(reportedY - centralYs[0]) < 1e-6);
    assert.ok(
        terrainAslAtCoordinate([15.9741521, 45.8041102]) - reportedY > 4,
        'the DGU bump above the open cut cannot pull Miramarska upward',
    );
    assert.ok(Math.abs(lower.samples[0].y - lower.samples[0].terrainY) < 1e-6);
    assert.ok(
        Math.abs(lower.samples.at(-1).y - lower.samples.at(-1).terrainY) < 1e-6,
        'terrain tie-in is allowed only at the two outer ends',
    );
});

test('a composed lower road retraces its lineage after later crossings deepen the approach', () => {
    const roadProperties = {
        highway_type: 'tertiary',
        tags: {
            highway: 'tertiary',
            name: 'Miramarski podvožnjak',
            short_name: 'Miramarska',
            ref: '10078',
            lanes: '4',
            maxheight: '3.65',
        },
    };
    const north = surfaceFeature(30166661, roadProperties, [
        lonLat(0, -180),
        lonLat(0, -80),
    ]);
    const middle = surfaceFeature(846828121, roadProperties, [
        lonLat(0, -80),
        lonLat(0, 20),
    ]);
    const south = surfaceFeature(35866854, roadProperties, [
        lonLat(0, 20),
        lonLat(0, 65),
    ]);
    const farSouth = surfaceFeature(99887766, roadProperties, [
        lonLat(0, 65),
        lonLat(0, 320),
    ]);
    const footBridge = surfaceFeature(207567941, {
        highway_type: 'footway',
        tags: { highway: 'footway', bridge: 'yes', layer: '1' },
    }, [lonLat(-15, 0), lonLat(15, 0)]);
    const railBridge = surfaceFeature(739579926, {
        railway_type: 'rail',
        tags: { railway: 'rail', bridge: 'yes', layer: '1' },
    }, [lonLat(-15, 38), lonLat(15, 38)]);
    const roadBridge = surfaceFeature(405207956, {
        highway_type: 'unclassified',
        tags: { highway: 'unclassified', bridge: 'yes', layer: '1' },
    }, [lonLat(-15, 58), lonLat(15, 58)]);
    const terrainElevationAslMAtCoordinate = ([, lat]) => {
        const z = (ANCHOR_LAT - Number(lat)) * M_PER_LAT;
        if (z <= 5) return 111;
        const blend = Math.max(0, Math.min(1, (z - 5) / 45));
        return 111 + 5.6 * blend;
    };
    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures([
        north,
        middle,
        south,
        farSouth,
        footBridge,
        railBridge,
        roadBridge,
    ], {
        terrainElevationAslMAtCoordinate,
        railElevationAslMAtCoordinate: () => null,
    });
    const lowerFeature = centerlines.find(feature => (
        feature.properties.road_vertical_alignment?.kind === 'underpass'
    ));
    assert.ok(lowerFeature);
    const details = lowerFeature.properties.road_vertical_alignment;
    assert.deepEqual(
        new Set(details.crossings.flatMap(crossing => crossing.upperOsmIds)),
        new Set(['207567941', '739579926', '405207956']),
        'extending the required ramp reveals the adjacent road bridge too',
    );
    assert.ok(
        details.replaceRoadSurfaceOsmIds.includes('99887766'),
        'the retraced continuation is owned by the replacement surface',
    );
    assert.ok(
        details.crossings
            .filter(crossing => crossing.elevationSolution)
            .every(crossing => crossing.elevationSolution.feasible === true),
        'later crossings reuse their authored upper profiles instead of bare-earth heights',
    );

    const alignmentModel = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: (x, z) => terrainElevationAslMAtCoordinate([
            ANCHOR_LON + x / M_PER_LON,
            ANCHOR_LAT - z / M_PER_LAT,
        ]),
        absoluteToSceneY: heightM => heightM,
        sampleSpacingM: 1,
    });
    alignmentModel.setCenterlineTile('composed-ramp-retrace', centerlines);
    const lower = alignmentModel.getAlignmentForOsmId(846828121);
    assert.ok(lower);
    const crossingStations = details.crossings.map(crossing => {
        const [lon, lat] = crossing.coordinate;
        const point = {
            x: (lon - ANCHOR_LON) * M_PER_LON,
            z: -(lat - ANCHOR_LAT) * M_PER_LAT,
        };
        return lower.nearest(point.x, point.z).s;
    });
    const crossingYs = crossingStations.map(stationM => lower.profileYAtS(stationM));
    assert.ok(
        Math.max(...crossingYs) - Math.min(...crossingYs) < 1e-6,
        'the road remains on one lower plateau through every adjacent crossing',
    );
    let maximumGrade = 0;
    let maximumGradePair = null;
    for (let index = 0; index + 1 < lower.samples.length; index += 1) {
        const a = lower.samples[index];
        const b = lower.samples[index + 1];
        const grade = Math.abs(b.y - a.y) / Math.max(1e-6, b.s - a.s);
        if (grade > maximumGrade) {
            maximumGrade = grade;
            maximumGradePair = { a, b };
        }
    }
    assert.ok(
        maximumGrade <= 0.0801,
        `the extended tie-in respects the 8% road grade (${maximumGrade}; `
            + `${JSON.stringify(maximumGradePair)})`,
    );
});

test('sloped lower approaches constrain the split and expose remaining deficit', () => {
    const features = [
        surfaceFeature(810, {
            highway_type: 'secondary',
            tags: { highway: 'secondary', bridge: 'yes', layer: '1' },
        }, [lonLat(0), lonLat(20)]),
        surfaceFeature(820, {
            highway_type: 'secondary',
            tags: { highway: 'secondary', layer: '0' },
        }, [lonLat(10, -150), lonLat(10, 150)]),
    ];
    const terrainElevationAslMAtCoordinate = ([, lat]) => {
        const z = (ANCHOR_LAT - Number(lat)) * M_PER_LAT;
        return z < -100 ? 14 : 10;
    };
    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures(features, {
        terrainElevationAslMAtCoordinate,
    });
    const upper = centerlines.find(feature => feature.properties.osm_id === 810);
    const solution = upper.properties.road_vertical_alignment
        .crossings[0].elevationSolution;

    assert.equal(solution.status, 'infeasible');
    assert.equal(solution.allocation, 'split');
    assert.ok(solution.remainingDeficitM > 1);
    assert.ok(solution.lowerCutM < 4);

    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: (_x, z) => (z < -100 ? 14 : 10),
        absoluteToSceneY: heightM => heightM,
        sampleSpacingM: 1,
    });
    model.setCenterlineTile('surface', centerlines);
    const lowerAlignment = model.getAlignmentForOsmId(820);
    let maximumGrade = 0;
    for (let index = 0; index + 1 < lowerAlignment.samples.length; index++) {
        const a = lowerAlignment.samples[index];
        const b = lowerAlignment.samples[index + 1];
        maximumGrade = Math.max(
            maximumGrade,
            Math.abs(b.y - a.y) / (b.s - a.s),
        );
    }
    assert.ok(maximumGrade <= 0.0801, `${maximumGrade}`);
});

test('solves an underpass against the fixed upper corridor in absolute elevation', () => {
    const features = [
        surfaceFeature(501, {
            highway_type: 'secondary',
            tags: { highway: 'secondary', ref: '501' },
        }, [lonLat(-160), lonLat(0)]),
        surfaceFeature(502, {
            highway_type: 'secondary',
            tags: {
                highway: 'secondary',
                ref: '501',
                tunnel: 'yes',
                layer: '-1',
            },
        }, [lonLat(0), lonLat(100)]),
        surfaceFeature(503, {
            highway_type: 'secondary',
            tags: { highway: 'secondary', ref: '501' },
        }, [lonLat(100), lonLat(260)]),
        surfaceFeature(601, {
            railway_type: 'rail',
            tags: { railway: 'rail', layer: '0' },
        }, [lonLat(50, -100), lonLat(50, 100)]),
    ];
    const [centerline] = roadVerticalCenterlinesFromSurfaceFeatures(features, {
        terrainElevationAslMAtCoordinate: () => 20,
    });
    const details = centerline.properties.road_vertical_alignment;
    const [crossing] = details.crossings;

    assert.equal(details.profile.type, 'coupled-clearance-peak');
    assert.equal(details.profile.peakElevationAslM, 13.5);
    assert.equal(crossing.elevationSolution.allocation, 'lower-only');
    assert.equal(crossing.elevationSolution.upperOwnership, 'fixed-counterpart');
    assert.equal(crossing.elevationSolution.lowerElevationAslM, 14.7);
    assert.ok(
        Math.abs(crossing.elevationSolution.achievedSeparationM - 5.3) < 1e-9,
    );

    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 20,
        absoluteToSceneY: heightM => heightM,
        sampleSpacingM: 4,
    });
    model.setCenterlineTile('surface', [centerline]);
    assert.equal(model.roadYAtLocal(50, 0, 502), 13.5);
    const alignment = model.getAlignmentForOsmId(502);
    let maximumGrade = 0;
    for (let index = 0; index + 1 < alignment.samples.length; index++) {
        const a = alignment.samples[index];
        const b = alignment.samples[index + 1];
        maximumGrade = Math.max(
            maximumGrade,
            Math.abs(b.y - a.y) / (b.s - a.s),
        );
    }
    assert.ok(maximumGrade <= 0.0801, `${maximumGrade}`);
});

test('does not turn a missing absolute terrain sample into sea level', () => {
    const [centerline] = roadVerticalCenterlinesFromSurfaceFeatures(
        lomnicaLikeFeatures(),
        { terrainElevationAslMAtCoordinate: () => null },
    );
    const details = centerline.properties.road_vertical_alignment;

    assert.equal(details.profile.type, 'crossing-clearance');
    assert.equal(details.profile.peakOffsetM, 6.5);
    assert.ok(details.crossings.every(crossing => (
        crossing.elevationSolution == null
    )));
});

test('does not mistake an adjoining member endpoint for a crossed corridor', () => {
    const features = lomnicaLikeFeatures().slice(0, 3);
    const corridors = roadGradeSeparationCorridorRecords(features);
    const owner = corridors.find(record => record.osmId === '102');

    assert.deepEqual(
        roadGradeSeparationCrossings(owner, corridors, 'overpass'),
        [],
    );
});

test('keeps a bridge cycleway continuous when its approach is tagged path', () => {
    const features = [
        surfaceFeature(401, {
            highway_type: 'path',
            tags: {
                highway: 'path',
                foot: 'designated',
                bicycle: 'designated',
            },
        }, [lonLat(-160, 6), lonLat(0, 6)]),
        surfaceFeature(402, {
            highway_type: 'cycleway',
            tags: {
                highway: 'cycleway',
                foot: 'designated',
                bicycle: 'designated',
                bridge: 'yes',
                layer: '1',
            },
        }, [lonLat(0, 6), lonLat(100, 6)]),
        surfaceFeature(403, {
            highway_type: 'cycleway',
            tags: {
                highway: 'cycleway',
                foot: 'designated',
                bicycle: 'designated',
            },
        }, [lonLat(100, 6), lonLat(260, 6)]),
        surfaceFeature(301, {
            railway_type: 'rail',
            tags: { railway: 'rail', electrified: 'contact_line' },
        }, [lonLat(50, -100), lonLat(50, 100)]),
    ];
    const [centerline] = roadVerticalCenterlinesFromSurfaceFeatures(features);
    const details = centerline.properties.road_vertical_alignment;

    assert.deepEqual(
        new Set(details.memberOsmIds),
        new Set(['401', '402', '403']),
    );
    assert.equal(details.renderStructure, undefined);

    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 10,
        sampleSpacingM: 4,
    });
    model.setCenterlineTile('surface', [centerline]);
    const alignment = model.getAlignmentForOsmId(402);
    assert.equal(model.getAlignmentForOsmId(401), alignment);
    assert.equal(model.getAlignmentForOsmId(403), alignment);
    assert.equal(alignment.definition.renderStructure, false);
    assert.ok(
        model.roadYAtLocal(-40, 6, 401) > 10,
        'the path-tagged approach must ride the shared bridge profile',
    );
});
