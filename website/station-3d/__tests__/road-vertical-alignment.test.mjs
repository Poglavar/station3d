// Verifies road grade-separation metadata and profiles without Three.js or a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createIndexedPolylineNearest,
    filterReplacementTerrainCutoutsForAuthoredPortals,
    isBuriedStructureSample,
    isCoveredStructureSample,
    roadReplacementRequiresTerrainOpening,
    roadVerticalAlignmentFromProperties,
    roadVerticalCenterlinesFromSurfaceFeatures,
    roadStructureCompanionSidewalkBandsM,
    roadStructureFormationOffsetsAtSampleM,
    roadStructureFormationOffsetsM,
    roadStructureSidewalkBandsM,
    roadStructureSupportClearanceAtLocal,
    replacementCorridorTouchesEdge,
    ROAD_TUNNEL_PORTAL_CARVE_M,
    RoadVerticalAlignmentModel,
} from '../core/road-vertical-alignment.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { pointInRing } from '../core/mask-query.js';

const ANCHOR_LAT = 45.73;
const ANCHOR_LON = 16.03;
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);

function lonLat(x, z = 0) {
    return [ANCHOR_LON + x / M_PER_LON, ANCHOR_LAT - z / M_PER_LAT];
}

function feature(osmId, properties = {}, lengthM = 100) {
    return {
        type: 'Feature',
        properties: { osm_id: osmId, highway: 'secondary', ...properties },
        geometry: {
            type: 'LineString',
            coordinates: [lonLat(0), lonLat(lengthM)],
        },
    };
}

function surfaceFeature(osmId, properties, coordinates) {
    return {
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [],
        },
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

function model(definitions = [], terrain = () => 10) {
    return new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        locationId: 'test',
        definitions,
        terrainSceneYAtLocal: terrain,
        absoluteToSceneY: heightM => heightM - 100,
        sampleSpacingM: 10,
    });
}

test('an authored portal replaces only its overlapping generic terrain mouth', () => {
    const near = {
        alignmentId: 'osm-tunnel',
        cutoutRing: [{ x: 0, z: 0 }],
        cutoutBounds: { minX: 0, minZ: -12, maxX: 36, maxZ: 12 },
    };
    const far = {
        alignmentId: 'osm-tunnel',
        cutoutRing: [{ x: 300, z: 0 }],
        cutoutBounds: { minX: 290, minZ: -12, maxX: 326, maxZ: 12 },
    };
    const clear = {
        alignmentId: 'osm-tunnel',
        clearRing: [{ x: 30, z: 0 }],
        clearBounds: { minX: 20, minZ: -15, maxX: 320, maxZ: 15 },
        cutoutRing: null,
        cutoutBounds: null,
    };
    const other = {
        alignmentId: 'osm-other',
        cutoutRing: [{ x: 0, z: 0 }],
        cutoutBounds: { minX: 0, minZ: -12, maxX: 36, maxZ: 12 },
    };
    const replacement = {
        alignmentId: 'osm-tunnel',
        selectionBounds: { minX: -3, minZ: -2, maxX: 15, maxZ: 2 },
        replacementBackstopReady: true,
    };

    assert.deepEqual(
        filterReplacementTerrainCutoutsForAuthoredPortals(
            [near, far, clear, other],
            [replacement],
        ),
        [far, clear, other],
    );
    assert.deepEqual(
        filterReplacementTerrainCutoutsForAuthoredPortals(
            [near],
            [{ ...replacement, replacementBackstopReady: false }],
        ),
        [near],
        'an unpublished custom shell cannot remove the generic backstop',
    );
});

test('indexed alignment lookup preserves the exact nearest polyline result', () => {
    const points = Array.from({ length: 201 }, (_value, index) => ({
        x: index * 5,
        z: Math.sin(index / 12) * 8,
    }));
    const cumulative = [0];
    for (let index = 0; index + 1 < points.length; index++) {
        cumulative.push(cumulative[index] + Math.hypot(
            points[index + 1].x - points[index].x,
            points[index + 1].z - points[index].z,
        ));
    }
    const bruteNearest = (x, z) => {
        let best = null;
        for (let index = 0; index + 1 < points.length; index++) {
            const a = points[index];
            const b = points[index + 1];
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const lengthSquared = dx * dx + dz * dz;
            const t = Math.max(0, Math.min(1, (
                (x - a.x) * dx + (z - a.z) * dz
            ) / lengthSquared));
            const qx = a.x + dx * t;
            const qz = a.z + dz * t;
            const distanceSquared = (x - qx) ** 2 + (z - qz) ** 2;
            if (!best || distanceSquared < best.distanceSquared) {
                best = {
                    x: qx,
                    z: qz,
                    t,
                    distanceSquared,
                    segmentIndex: index,
                    s: cumulative[index]
                        + (cumulative[index + 1] - cumulative[index]) * t,
                };
            }
        }
        return best;
    };
    const indexedNearest = createIndexedPolylineNearest(points, cumulative);
    for (const query of [
        { x: 763, z: 4 },
        { x: 211, z: -17 },
        { x: -100, z: 70 },
        { x: 1300, z: -50 },
    ]) {
        const expected = bruteNearest(query.x, query.z);
        const actual = indexedNearest(query.x, query.z);
        assert.equal(actual.segmentIndex, expected.segmentIndex);
        assert.ok(Math.abs(actual.s - expected.s) < 1e-9);
        assert.ok(Math.abs(actual.distanceSquared - expected.distanceSquared) < 1e-9);
    }
});

test('maps explicit metadata and OSM bridge/tunnel/layer tags to vertical kinds', () => {
    assert.deepEqual(
        roadVerticalAlignmentFromProperties({ road_vertical_alignment: 'overpass' }),
        { kind: 'overpass' },
    );
    assert.equal(roadVerticalAlignmentFromProperties({ bridge: 'viaduct' }).kind, 'overpass');
    assert.equal(roadVerticalAlignmentFromProperties({ tunnel: 'yes' }).kind, 'underpass');
    assert.equal(roadVerticalAlignmentFromProperties({ layer: '-2' }).kind, 'underpass');
    assert.equal(roadVerticalAlignmentFromProperties({ layer: '1' }).kind, 'overpass');
    assert.equal(
        roadVerticalAlignmentFromProperties({
            tunnel: 'building_passage',
            layer: '-1',
        }),
        null,
        'a building passage remains excluded even when OSM also gives it layer -1',
    );
    assert.equal(roadVerticalAlignmentFromProperties({ bridge: 'no', layer: '0' }), null);
    assert.equal(
        roadVerticalAlignmentFromProperties({ tunnel: 'building_passage' }),
        null,
    );
});

test('promotes grade-separated cycleway surfaces without rendering a duplicate bridge', () => {
    const [centerline] = roadVerticalCenterlinesFromSurfaceFeatures([{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [] },
        properties: {
            osm_id: 163928115,
            highway_type: 'cycleway',
            tags: { bridge: 'yes', layer: '1' },
            centerline_geometry: {
                type: 'LineString',
                coordinates: [lonLat(0), lonLat(100)],
            },
        },
    }, {
        type: 'Feature',
        properties: {
            osm_id: 99,
            highway_type: 'cycleway',
            tags: {},
            centerline_geometry: {
                type: 'LineString',
                coordinates: [lonLat(0), lonLat(100)],
            },
        },
    }]);
    assert.equal(centerline.properties.highway, 'cycleway');
    assert.equal(centerline.properties.tags.bridge, 'yes');

    const alignmentModel = model();
    alignmentModel.setCenterlineTile('surface', [centerline]);
    const alignment = alignmentModel.getAlignmentForOsmId(163928115);
    assert.equal(alignment.kind, 'overpass');
    assert.equal(alignment.definition.renderStructure, false);
    assert.equal(alignmentModel.roadYAtLocal(50, 0, 163928115), 10.45);
});

test('a small footbridge without a crossed transport corridor does not lift its garden path', () => {
    const approach = surfaceFeature(688625965, {
        highway_type: 'footway',
        tags: { highway: 'footway', surface: 'fine_gravel' },
    }, [lonLat(-80), lonLat(0)]);
    const bridge = surfaceFeature(122270723, {
        highway_type: 'footway',
        tags: {
            highway: 'footway',
            bridge: 'yes',
            layer: '1',
            surface: 'wood',
        },
    }, [lonLat(0), lonLat(12)]);
    const exit = surfaceFeature(233438018, {
        highway_type: 'footway',
        tags: { highway: 'footway', surface: 'fine_gravel' },
    }, [lonLat(12), lonLat(80)]);

    const [centerline] = roadVerticalCenterlinesFromSurfaceFeatures([
        approach,
        bridge,
        exit,
    ], {
        terrainElevationAslMAtCoordinate: () => 100,
    });
    const details = centerline.properties.road_vertical_alignment;
    assert.equal(details.profile.peakOffsetM, 0.45);
    assert.equal(details.maxGrade, 0.16);

    const alignmentModel = model();
    alignmentModel.setCenterlineTile('botanicki', [centerline]);
    assert.equal(alignmentModel.roadYAtLocal(6, 0, 122270723), 10.45);
    assert.equal(
        alignmentModel.roadYAtLocal(-10, 0, 688625965),
        10,
        'the connected ordinary path has already rejoined terrain',
    );
});

test('a tagged pedestrian tunnel owns a compact structural box below the upper road', () => {
    const pedestrianTunnel = surfaceFeature(200342423, {
        highway_type: 'footway',
        tags: {
            highway: 'footway',
            surface: 'concrete',
            tunnel: 'yes',
            layer: '-1',
        },
    }, [lonLat(-30), lonLat(30)]);
    const upperRoad = surfaceFeature(179958692, {
        highway_type: 'secondary',
        tags: { highway: 'secondary', layer: '0' },
    }, [lonLat(0, -30), lonLat(0, 30)]);
    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures([
        pedestrianTunnel,
        upperRoad,
    ]);
    const centerline = centerlines.find(candidate => (
        candidate.properties.road_vertical_alignment.id === 'osm-200342423'
    ));
    assert.ok(centerline);
    const details = centerline.properties.road_vertical_alignment;
    assert.equal(details.clearHeightM, 2.6);
    assert.equal(details.roofDepthM, 0.45);
    assert.equal(details.maxGrade, 0.16);

    const alignmentModel = model();
    alignmentModel.setCenterlineTile('surface', centerlines);
    const alignment = alignmentModel.getAlignmentForOsmId(200342423);
    assert.equal(alignment.kind, 'underpass');
    assert.equal(alignment.definition.renderStructure, true);
    assert.equal(alignment.definition.clearHeightM, 2.6);
    assert.equal(alignment.definition.roofDepthM, 0.45);
});

test('does not inflate a tiny private-access tunnel into a country-scale underpass opening', () => {
    const garageRamp = surfaceFeature(1432391814, {
        highway_type: 'service',
        tags: {
            highway: 'service',
            service: 'driveway',
            tunnel: 'yes',
            layer: '-1',
        },
    }, [lonLat(0), lonLat(4.6)]);
    const ordinaryApproach = surfaceFeature(1432391813, {
        highway_type: 'service',
        tags: { highway: 'service', service: 'driveway' },
    }, [lonLat(4.6), lonLat(11.3)]);

    assert.deepEqual(
        roadVerticalCenterlinesFromSurfaceFeatures([garageRamp, ordinaryApproach]),
        [],
        'an unmodelled garage entrance remains terrain-bound instead of cutting an 11 m hole',
    );

    const authored = structuredClone(garageRamp);
    authored.properties.road_vertical_alignment = {
        id: 'authored-garage-ramp',
        kind: 'underpass',
        offsetM: -2,
    };
    assert.equal(
        roadVerticalCenterlinesFromSurfaceFeatures([authored]).length,
        1,
        'explicitly authored garage geometry remains authoritative',
    );
    authored.properties.road_vertical_alignment = 'underpass';
    assert.equal(
        roadVerticalCenterlinesFromSurfaceFeatures([authored]).length,
        1,
        'the compact authored alignment form remains authoritative too',
    );
});

test('keeps railway bridges out of the road renderer and lowers connected road approaches', () => {
    const west = surfaceFeature(340064613, {
        highway_type: 'secondary',
        tags: { highway: 'secondary', ref: '1039', lanes: '2' },
    }, [lonLat(-100), lonLat(0)]);
    const tunnel = surfaceFeature(230585889, {
        highway_type: 'secondary',
        tags: {
            highway: 'secondary',
            ref: '1039',
            tunnel: 'yes',
            layer: '-1',
            maxheight: '3.8',
            lanes: '1',
        },
    }, [lonLat(0), lonLat(10)]);
    const east = surfaceFeature(230585890, {
        highway_type: 'secondary',
        tags: { highway: 'secondary', ref: '1039', lanes: '2' },
    }, [lonLat(10), lonLat(110)]);
    const railwayBridge = surfaceFeature(188333853, {
        railway_type: 'rail',
        tags: {
            railway: 'rail',
            bridge: 'yes',
            layer: '1',
            ref: 'M407',
        },
    }, [lonLat(5, -50), lonLat(5, 50)]);

    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures([
        railwayBridge,
        west,
        tunnel,
        east,
    ]);

    assert.equal(centerlines.length, 1, 'railway bridge must not become an asphalt road deck');
    const [centerline] = centerlines;
    assert.equal(centerline.properties.osm_id, 230585889);
    assert.equal(centerline.properties.road_vertical_alignment.kind, 'underpass');
    assert.deepEqual(
        new Set(centerline.properties.road_vertical_alignment.memberOsmIds),
        new Set(['230585889', '340064613', '230585890']),
    );
    assert.ok(
        Math.abs(
            centerline.properties.road_vertical_alignment.clearHeightM - 4.15,
        ) < 1e-9,
    );
    assert.equal(centerline.properties.road_vertical_alignment.roofDepthM, 0.7);
    assert.equal(centerline.properties.road_vertical_alignment.widthM, 6.5);
    assert.equal(centerline.properties.road_vertical_alignment.laneCountOverride, 2);
    assert.equal(
        centerline.properties.road_vertical_alignment.replaceRoadSurfaceRange,
        'profile',
    );
    assert.equal(
        centerline.properties.road_vertical_alignment.replacementCarriagewayOnly,
        true,
    );
    assert.equal(
        centerline.properties.road_vertical_alignment.crossSection
            .formationHalfWidthM,
        4,
    );
    assert.equal(
        centerline.properties.road_vertical_alignment.crossSection
            .terrainClearHalfWidthM,
        8,
    );
    assert.ok(
        Math.abs(
            centerline.properties.road_vertical_alignment.crossSection
                .terrainCutoutHalfWidthM - 4,
        ) < 1e-9,
    );
    assert.deepEqual(
        new Set(
            centerline.properties.road_vertical_alignment
                .replaceRoadSurfaceOsmIds,
        ),
        new Set(['230585889', '340064613', '230585890']),
    );
    assert.deepEqual(
        centerline.properties.road_vertical_alignment.structureOsmIds,
        ['230585889'],
    );

    const alignmentModel = model();
    alignmentModel.setCenterlineTile('surface', centerlines);
    const alignment = alignmentModel.getAlignmentForOsmId(230585889);
    assert.equal(alignment.kind, 'underpass');
    assert.equal(
        alignmentModel.getAlignmentForOsmId(340064613),
        alignment,
        'the west approach must consume the same smooth road profile',
    );
    assert.equal(alignmentModel.getAlignmentForOsmId(230585890), alignment);
    assert.equal(alignmentModel.replacesRoadSurfaceForOsmId(230585889), true);
    assert.equal(alignmentModel.replacesRoadSurfaceForOsmId(340064613), true);
    assert.equal(alignmentModel.laneCountOverrideForOsmId(230585889), 2);
    assert.equal(alignmentModel.laneCountOverrideForOsmId(340064613), 2);
    assert.equal(
        alignmentModel.retainsRoadFormationForOsmId(230585889),
        false,
        'the replacement owns the tunnel mask; retaining its legacy formation adds a second cutout',
    );
    assert.equal(alignmentModel.containsReplacementCorridor(5, 3.5), true);
    assert.equal(alignmentModel.containsReplacementCorridor(5, 8), false);
    assert.equal(
        alignmentModel.containsReplacementCorridorForOsmId(
            5,
            7,
            230585889,
        ),
        true,
        'the source formation must yield across the wider terrain-clear strip',
    );
    assert.equal(
        alignmentModel.containsReplacementCorridorForOsmId(
            -5,
            7,
            340064613,
        ),
        true,
        'the authored cross-section must own the approach beside its sidewalk',
    );
    assert.equal(
        alignmentModel.containsReplacementCorridorForOsmId(5, 0, 999),
        false,
    );
    assert.equal(
        alignmentModel.containsReplacementCorridor(-5, 0),
        true,
        'one replacement must own the tunnel and both graded ramps',
    );
    assert.equal(
        replacementCorridorTouchesEdge(
            alignmentModel,
            { x: -2, z: 3 },
            { x: 2, z: 3 },
            18,
        ),
        true,
        'the layer-0 curb cap at the tunnel join must opt into piece filtering',
    );
    assert.equal(alignmentModel.containsReplacementCorridor(-110, 0), false);
    assert.ok(Math.abs(alignmentModel.roadYAtLocal(5, 0, 230585889) - 5.15) < 1e-6);
    const approachY = alignmentModel.roadYAtLocal(-42, 0, 340064613);
    assert.ok(approachY > 5.15 && approachY < 10, `${approachY}`);
    assert.ok(
        Math.abs(alignmentModel.roadYAtLocal(-90.9375, 0, 340064613) - 10) < 1e-3,
    );
    let previousY = alignmentModel.roadYAtLocal(-90, 0, 340064613);
    for (let x = -89; x <= 0; x++) {
        const y = alignmentModel.roadYAtLocal(x, 0, 340064613);
        assert.ok(Math.abs(y - previousY) <= 0.081, `grade exceeded near ${x} m`);
        previousY = y;
    }
    assert.ok(
        alignment.samples.some(sample => (
            Math.abs(sample.s - alignment.structureStartM) < 1e-6
        )),
        'the tunnel box must start on an exact sampled station',
    );
    assert.ok(
        alignment.samples.some(sample => (
            Math.abs(sample.s - alignment.structureEndM) < 1e-6
        )),
        'the tunnel box must end on an exact sampled station',
    );
    assert.equal(alignmentModel.structureAtLocal(-20, 0, 340064613), null);
    assert.equal(
        alignmentModel.structureAtLocal(5, 0, 230585889).kind,
        'underpass',
    );
    const regions = alignmentModel.getReplacementTerrainCutoutRegions();
    const cutoutRegions = regions.filter(region => region.cutoutRing);
    const clearRegions = regions.filter(region => region.clearRing);
    assert.equal(
        cutoutRegions.length,
        2,
        'a covered box splits the terrain opening into one region per ramp',
    );
    // Burial depth — not the tagged structure range — decides where fill
    // exists: the grade runouts descend INSIDE the tagged span, and those
    // shallow stretches stay open wherever terrain actually intersects the
    // replacement floor.
    const clearHeightM = alignment.definition.clearHeightM;
    const roofDepthM = alignment.definition.roofDepthM;
    const buried = alignment.samples.map(sample => (
        isBuriedStructureSample(sample, clearHeightM, roofDepthM)
    ));
    const firstBuriedIndex = buried.indexOf(true);
    const lastBuriedIndex = buried.lastIndexOf(true);
    assert.ok(firstBuriedIndex > 0, 'the fixture must have an open west stretch');
    // Each intersecting, uncovered run is extended by its adjoining retained
    // boundary samples so the opening meets the ramp toe and portal exactly.
    const opensTerrain = alignment.samples.map((sample, index) => (
        roadReplacementRequiresTerrainOpening(sample) && !buried[index]
    ));
    const expectedRunLengths = [];
    let openStartIndex = null;
    for (let index = 0; index <= opensTerrain.length; index++) {
        if (opensTerrain[index] && openStartIndex == null) {
            openStartIndex = index;
            continue;
        }
        if (opensTerrain[index] || openStartIndex == null) continue;
        expectedRunLengths.push(
            index - openStartIndex
            + (openStartIndex > 0 ? 1 : 0)
            + (index < alignment.samples.length ? 1 : 0),
        );
        openStartIndex = null;
    }
    cutoutRegions.forEach((region, index) => {
        assert.equal(region.alignmentId, alignment.id);
        assert.equal(region.cutoutRing.length, expectedRunLengths[index] * 2);
    });
    // The protective reset covers only DEEP stretches: a near-grade approach
    // belongs to the real road, whose wide surface cuts must stay open.
    assert.ok(clearRegions.length >= 1, 'the deep trench must be protected');
    const gradeEnd = alignment.samples[0];
    assert.ok(
        !clearRegions.some(region => pointInRing(
            gradeEnd.x,
            gradeEnd.z,
            region.clearRing,
        )),
        'a near-grade profile end must not be blanked back to terrain',
    );
    const deepMid = alignment.samples[
        Math.floor((firstBuriedIndex + lastBuriedIndex) / 2)
    ];
    assert.ok(
        clearRegions.some(region => pointInRing(
            deepMid.x,
            deepMid.z,
            region.clearRing,
        )),
        'the buried span must stay protected from fragmented member cuts',
    );
    const boxMid = alignment.samples[
        Math.floor((firstBuriedIndex + lastBuriedIndex) / 2)
    ];
    assert.equal(
        alignmentModel.isInsideReplacementTerrainOpening(boxMid.x, boxMid.z),
        false,
        'the fill above the covered box is intact ground, not an opening',
    );
    const rampMid = alignment.samples[Math.max(0, Math.floor(firstBuriedIndex / 2))];
    assert.equal(
        alignmentModel.isInsideReplacementTerrainOpening(rampMid.x, rampMid.z),
        true,
        'the ramp trench is a real terrain opening',
    );
    assert.equal(alignmentModel.isInsideReplacementTerrainOpening(-110, 500), false);
    const [terrainCutout] = cutoutRegions;
    assert.ok(
        Math.abs(
            terrainCutout.cutoutBounds.maxZ - terrainCutout.cutoutBounds.minZ
            - 8,
        ) < 1e-6,
        'the authored terrain opening must be a square-ended ribbon inside the walls',
    );
    const toeWidthM = terrainCutout.cutoutRing[0].z
        - terrainCutout.cutoutRing[terrainCutout.cutoutRing.length - 1].z;
    assert.ok(
        toeWidthM >= 6.5 - 1e-6 && toeWidthM < 8,
        'the opening must begin near carriageway width and widen only as the'
        + ` cut deepens (${toeWidthM} m)`,
    );
});

test('only genuinely buried structure samples carry fill', () => {
    // The grade runouts descend INSIDE the tagged tunnel span: a tagged
    // sample whose roof would poke out of the ground is an open trench.
    const clearHeightM = 4.45;
    const roofDepthM = 0.7;
    const buriedDeep = { structure: true, y: -6, terrainY: 0 };
    const shallowTagged = { structure: true, y: -2, terrainY: 0 };
    const atPortalFace = { structure: true, y: -5.15, terrainY: 0 };
    const openRamp = { structure: false, y: -6, terrainY: 0 };
    const unknownTerrain = { structure: true, y: -6, terrainY: null };
    assert.equal(isBuriedStructureSample(buriedDeep, clearHeightM, roofDepthM), true);
    assert.equal(isBuriedStructureSample(shallowTagged, clearHeightM, roofDepthM), false);
    assert.equal(isBuriedStructureSample(atPortalFace, clearHeightM, roofDepthM), true);
    assert.equal(isBuriedStructureSample(openRamp, clearHeightM, roofDepthM), false);
    assert.equal(
        isBuriedStructureSample(unknownTerrain, clearHeightM, roofDepthM),
        false,
        'absent terrain is ABSENT — Number(null) must never read as sea level',
    );
});

test('a replacement above the DTM cannot open a void in the terrain below it', () => {
    assert.equal(
        roadReplacementRequiresTerrainOpening({ terrainY: 2, y: 12 }),
        false,
        'an elevated replacement has no terrain to excavate',
    );
    assert.equal(
        roadReplacementRequiresTerrainOpening({ terrainY: 12, y: 2 }),
        true,
        'a depressed replacement still opens the terrain that intersects it',
    );
    assert.equal(
        roadReplacementRequiresTerrainOpening({ terrainY: 2.04, y: 2 }),
        false,
        'the portal coincidence tolerance keeps the terrain backstop stable',
    );
});

test('replacement terrain cutout follows an asymmetric structure inside its sealing collar', () => {
    const alignmentModel = model([
        {
            id: 'underpass',
            kind: 'underpass',
            axis: [lonLat(0), lonLat(100)],
            memberOsmIds: ['road'],
            profile: { type: 'terrain-offset', offsetM: -6 },
            replaceRoadSurface: true,
            replacementCarriagewayOnly: true,
            // A sealing collar around an OPEN trench: a covered box would keep
            // its fill and open only the ramps (covered elsewhere).
            structureMode: 'open-cut',
            crossSection: {
                carriagewayHalfWidthM: 3.25,
                formationHalfWidthM: 4,
                terrainClearHalfWidthM: 8,
                terrainCutoutHalfWidthM: 4,
            },
        },
        {
            id: 'right-path',
            kind: 'underpass',
            axis: [lonLat(0, -5), lonLat(100, -5)],
            memberOsmIds: ['path'],
            profile: { type: 'terrain-offset', offsetM: -6 },
            widthM: 2,
            renderStructure: false,
            replaceRoadSurface: true,
            replacementCarriagewayOnly: true,
            crossSection: {
                carriagewayHalfWidthM: 1,
                formationHalfWidthM: 1.75,
                terrainClearHalfWidthM: 5.75,
                terrainCutoutHalfWidthM: 1.75,
            },
        },
    ], () => 0);
    const alignment = alignmentModel.getAlignmentForOsmId('road');
    const regions = alignmentModel.getReplacementTerrainCutoutRegions();
    const cutoutRegion = regions.find(candidate => candidate.cutoutRing);
    const clearRegion = regions.find(candidate => candidate.clearRing);
    assert.equal(
        regions.filter(candidate => candidate.cutoutRing).length,
        1,
        'the structural owner must be the only terrain-cutout owner',
    );
    const sampleIndex = Math.floor(alignment.samples.length * 0.5);
    const rightIndex = cutoutRegion.cutoutRing.length - 1 - sampleIndex;
    const sample = alignment.samples[sampleIndex];
    const distanceM = point => Math.hypot(
        point.x - sample.x,
        point.z - sample.z,
    );

    assert.ok(Math.abs(distanceM(cutoutRegion.cutoutRing[sampleIndex]) - 4) < 1e-6);
    assert.ok(
        Math.abs(distanceM(cutoutRegion.cutoutRing[rightIndex]) - 6.5) < 1e-6,
        'the terrain hole must stop at the expanded structure edge',
    );
    assert.ok(Math.abs(distanceM(clearRegion.clearRing[sampleIndex]) - 8) < 1e-6);
    assert.ok(
        Math.abs(distanceM(clearRegion.clearRing[rightIndex]) - 10.5) < 1e-6,
        'the source-mask reset must use the same asymmetric formation offsets',
    );
    const [sidewalkBand] = roadStructureCompanionSidewalkBandsM(
        3.25,
        roadStructureFormationOffsetsM(
            alignment,
            alignmentModel.getAlignments(),
            4,
        ),
        alignment,
        alignmentModel.getAlignments(),
    );
    assert.equal(sidewalkBand.side, 'right');
    assert.equal(sidewalkBand.leftOffsetM, -3.25);
    assert.ok(Math.abs(sidewalkBand.rightOffsetM + 6.5) < 1e-6);
});

test('companion-side formation contains the widest sidewalk offset at both portals', () => {
    const alignmentModel = model([
        {
            id: 'underpass',
            kind: 'underpass',
            axis: [lonLat(0), lonLat(100)],
            memberOsmIds: ['road'],
            profile: { type: 'terrain-offset', offsetM: -6 },
            crossSection: {
                carriagewayHalfWidthM: 3.25,
                formationHalfWidthM: 4,
            },
        },
        {
            id: 'varying-right-path',
            kind: 'underpass',
            axis: [
                lonLat(0, -7),
                lonLat(40, -7),
                lonLat(60, -5),
                lonLat(100, -5),
            ],
            memberOsmIds: ['path'],
            profile: { type: 'terrain-offset', offsetM: -6 },
            widthM: 2,
            renderStructure: false,
        },
    ], () => 0);
    const alignment = alignmentModel.getAlignmentForOsmId('road');
    const offsets = roadStructureFormationOffsetsM(
        alignment,
        alignmentModel.getAlignments(),
        4,
    );

    assert.ok(
        offsets.rightM > 8.45 && offsets.rightM < 8.55,
        `the wall must clear the seven-metre portal offset, got ${offsets.rightM}`,
    );
    assert.equal(offsets.leftM, 4);
});

test('companion sidewalk keeps the open-cut wall outside it along the ramps', () => {
    const alignmentModel = model([
        {
            id: 'underpass',
            kind: 'underpass',
            axis: [lonLat(0), lonLat(100)],
            memberOsmIds: ['road'],
            profile: {
                peakOffsetM: -6,
                peakRange: {
                    start: { fraction: 0.45 },
                    end: { fraction: 0.55 },
                },
            },
            replaceRoadSurface: true,
            replacementCarriagewayOnly: true,
            crossSection: {
                carriagewayHalfWidthM: 3.25,
                formationHalfWidthM: 4,
            },
        },
        {
            id: 'right-path',
            kind: 'underpass',
            axis: [lonLat(0, -5), lonLat(100, -5)],
            memberOsmIds: ['path'],
            profile: { type: 'terrain-offset', offsetM: -6 },
            widthM: 2,
            renderStructure: false,
        },
    ], () => 0);
    const alignment = alignmentModel.getAlignmentForOsmId('road');
    const alignments = alignmentModel.getAlignments();
    const rampSample = alignment.samples[0];
    const offsets = roadStructureFormationOffsetsAtSampleM(
        alignment,
        alignments,
        { leftM: 3.25, rightM: 3.25 },
        rampSample,
    );

    assert.equal(offsets.leftM, 3.25);
    assert.ok(
        Math.abs(offsets.rightM - 6.5) < 1e-6,
        'the ramp wall must stay beyond the mapped sidewalk even where the road meets terrain',
    );

    const region = alignmentModel.getReplacementTerrainCutoutRegions()
        .find(candidate => candidate.cutoutRing);
    const rightRampEdge = region.cutoutRing[region.cutoutRing.length - 1];
    assert.ok(
        Math.abs(
            Math.hypot(
                rightRampEdge.x - rampSample.x,
                rightRampEdge.z - rampSample.z,
            ) - 6.5,
        ) < 1e-6,
        'the terrain opening must use the same companion-side ramp envelope as the wall',
    );
});

test('alignment change history identifies only the alignments that need rebuilding', () => {
    const alignmentModel = model();
    const first = alignmentModel.setCenterlineTile('0_0', [
        feature(81, { bridge: 'yes', layer: '1' }),
    ]);
    assert.deepEqual(first.ids, ['osm-81']);
    const revision = first.revision;

    const second = alignmentModel.setCenterlineTile('1_0', [
        {
            ...feature(82, { tunnel: 'yes', layer: '-1' }),
            geometry: {
                type: 'LineString',
                coordinates: [lonLat(200), lonLat(300)],
            },
        },
    ]);
    assert.deepEqual(second.ids, ['osm-82']);
    assert.deepEqual(
        alignmentModel.getChangesSince(revision).ids,
        ['osm-82'],
    );
});

test('one bridge profile, deck, and fence own a parallel cycleway companion', () => {
    const alignmentModel = model([], (_x, z) => 10 + z);
    alignmentModel.setCenterlineTile('surface', [
        {
            ...feature(71, { bridge: 'yes', layer: '1' }),
            geometry: {
                type: 'LineString',
                coordinates: [lonLat(0, 0), lonLat(100, 0)],
            },
        },
        {
            ...feature(72, {
                highway: 'cycleway',
                bridge: 'yes',
                layer: '1',
                width_meters: 2.5,
            }),
            geometry: {
                type: 'LineString',
                coordinates: [lonLat(0, 5.5), lonLat(100, 5.5)],
            },
        },
    ]);
    const alignments = alignmentModel.getAlignments();
    const bridge = alignmentModel.getAlignmentForOsmId(71);
    const cycleway = alignmentModel.getAlignmentForOsmId(72);

    assert.equal(cycleway.definition.renderStructure, false);
    assert.equal(
        alignmentModel.getProfileOwnerForOsmId(72),
        bridge,
        'parallel paved companions must expose the same canonical profile owner',
    );
    assert.ok(
        Math.abs(alignmentModel.roadYAtLocal(50, 5.5, 72) - 16.5) < 1e-6,
        'cycleway must use the carriageway crest, not its independently sampled cross-slope',
    );
    const companionStructure = alignmentModel.structureAtLocal(50, 5.5);
    assert.equal(companionStructure.kind, 'overpass');
    assert.deepEqual(companionStructure.osmIds, ['72']);
    assert.ok(
        Math.abs(
            alignmentModel.roadYAtLocal(
                50,
                5.5,
                companionStructure.osmIds[0],
            ) - 16.5,
        ) < 1e-6,
        'the non-rendering companion still supplies firm structural walk support',
    );
    const offsets = roadStructureFormationOffsetsM(bridge, alignments, 6);
    assert.ok(offsets.leftM >= 7.24 && offsets.leftM <= 7.26, `${offsets.leftM}`);
    assert.equal(offsets.rightM, 6);
    const sidewalkBands = roadStructureSidewalkBandsM(
        4.5,
        offsets,
        bridge,
        alignments,
    );
    assert.equal(sidewalkBands.length, 2);
    assert.equal(sidewalkBands[0].side, 'left');
    assert.ok(sidewalkBands[0].leftOffsetM >= 7.24);
    assert.ok(sidewalkBands[0].rightOffsetM >= 6.74);
    assert.ok(sidewalkBands[0].rightOffsetM <= 6.76);
    assert.deepEqual(sidewalkBands[1], {
        side: 'right',
        leftOffsetM: -4.5,
        rightOffsetM: -6,
    });
    assert.ok(
        sidewalkBands[0].rightOffsetM > 5.5 + 1.2,
        'bridge infill must stop outside the companion cycleway instead of z-fighting through it',
    );
});

test('identifies only the rounded buffer caps at bridge joins as non-curb edges', () => {
    const alignmentModel = model();
    alignmentModel.setCenterlineTile('0_0', [
        feature(73, { bridge: 'yes', layer: '1' }),
    ]);

    assert.equal(alignmentModel.isBufferedEndCapAtLocal(-4, 0, [73]), true);
    assert.equal(alignmentModel.isBufferedEndCapAtLocal(104, 0, [73]), true);
    assert.equal(alignmentModel.isBufferedEndCapAtLocal(50, 4, [73]), false);
    assert.equal(alignmentModel.isBufferedEndCapAtLocal(50, 0, [999]), false);
    assert.equal(
        alignmentModel.isBufferedEndCapAtLocal(-4, 0),
        true,
        'an adjoining at-grade curb can discover the bridge cap spatially',
    );
});

test('treats bridge and adjoining road buffers as one continuous curb run', () => {
    const alignmentModel = model();
    alignmentModel.setCenterlineTile('0_0', [
        feature(73, { bridge: 'yes', layer: '1' }),
    ]);

    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(-4, 2, [73]),
        true,
        'the bridge-owned start cap extends outside its axis',
    );
    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(4, 2, [73]),
        false,
        'the bridge longitudinal curb begins immediately after the join',
    );
    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(4, 2, [72]),
        true,
        'the adjoining road end cap protrudes into the bridge axis',
    );
    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(-4, 2, [72]),
        false,
        'the adjoining longitudinal curb remains intact before the join',
    );
    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(96, 2, [72]),
        true,
        'the far adjoining cap protrudes backward into the bridge axis',
    );
    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(104, 2, [72]),
        false,
        'the far adjoining longitudinal curb remains intact after the join',
    );
});

test('opens round curb caps at internal bridge-member joins, not only profile ends', () => {
    const alignmentModel = model([{
        id: 'continuous-profile',
        locationId: 'test',
        kind: 'overpass',
        memberOsmIds: [72, 73, 74],
        structureOsmIds: [73],
        axis: [lonLat(0), lonLat(100)],
        profile: {
            type: 'relative-peak',
            peakOffsetM: 6.5,
            peakRange: {
                start: { distanceM: 40 },
                end: { distanceM: 60 },
            },
        },
        structureRange: {
            start: { distanceM: 40 },
            end: { distanceM: 60 },
        },
    }]);

    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(36, 2, [73]),
        true,
        'the bridge-member cap outside its start must be removed',
    );
    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(44, 2, [73]),
        false,
        'the bridge longitudinal curb inside the structure must remain',
    );
    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(44, 2, [72]),
        true,
        'the approach-member cap protruding into the structure must be removed',
    );
    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(36, 2, [72]),
        false,
        'the approach longitudinal curb outside the structure must remain',
    );
    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(64, 2, [73]),
        true,
        'the bridge-member cap outside its end must be removed',
    );
    assert.equal(
        alignmentModel.isBufferedRoadJoinArtifactAtLocal(56, 2, [74]),
        true,
        'the far approach-member cap protruding backward must be removed',
    );
});

test('resolves a curb owner set to the nearest matching vertical alignment', () => {
    const alignmentModel = model();
    alignmentModel.setCenterlineTile('0_0', [
        feature(73, { bridge: 'yes', layer: '1' }),
        {
            ...feature(74, { bridge: 'yes', layer: '1' }),
            geometry: {
                type: 'LineString',
                coordinates: [lonLat(0, 30), lonLat(100, 30)],
            },
        },
    ]);

    assert.equal(alignmentModel.roadYForOsmIdsAtLocal(50, 1, [74, 73]), 16.5);
    assert.equal(alignmentModel.roadYForOsmIdsAtLocal(50, 29, [73, 74]), 16.5);
    assert.equal(alignmentModel.roadYForOsmIdsAtLocal(50, 60, [73, 74]), null);
    assert.equal(alignmentModel.roadYForOsmIdsAtLocal(50, 1, [999]), null);
});

test('uses a signed terrain-relative peak and keeps both ends on terrain', () => {
    const alignmentModel = model([{
        id: 'relative',
        locationId: 'test',
        kind: 'overpass',
        memberOsmIds: [11],
        axis: [lonLat(0), lonLat(100)],
        profile: {
            type: 'relative-peak',
            peakOffsetM: 7,
            peakRange: {
                start: { distanceM: 40 },
                end: { distanceM: 60 },
            },
        },
    }]);
    assert.equal(alignmentModel.roadYAtLocal(0, 0, 11), 10);
    assert.equal(alignmentModel.roadYAtLocal(50, 0, 11), 17);
    assert.ok(Math.abs(alignmentModel.roadYAtLocal(100, 0, 11) - 10) < 1e-6);
    assert.equal(
        alignmentModel.roadYAtLocal(105, 0, 11),
        null,
        'the corridor-width endpoint cap must not extend a fixed height past the axis',
    );
    assert.equal(
        alignmentModel.roadYAtLocal(100, 5, 11),
        10,
        'the endpoint plane still owns the road cross-section itself',
    );

    const crossSlopedEndpoint = model([{
        id: 'cross-sloped-runout',
        locationId: 'test',
        kind: 'overpass',
        memberOsmIds: [12],
        axis: [lonLat(0), lonLat(100)],
        profile: {
            type: 'relative-peak',
            peakOffsetM: 7,
            peakRange: {
                start: { distanceM: 40 },
                end: { distanceM: 60 },
            },
        },
    }], (_x, z) => 10 + z * 0.1);
    assert.ok(
        Math.abs(crossSlopedEndpoint.roadYAtLocal(100, 5, 12) - 10) < 1e-6,
        'terrain-bound runout must retain the ordinary flat road cross-section',
    );
    assert.ok(
        Math.abs(
            crossSlopedEndpoint.roadYAtLocal(99, 5, 12)
            - crossSlopedEndpoint.roadYAtLocal(100, 5, 12)
        ) < 0.05,
        'the lateral terrain envelope must fade continuously into the runout',
    );
});

test('an overpass approach never dives below its ordinary terrain surface', () => {
    const terrain = x => (x >= 10 && x <= 20 ? 15 : 10);
    const alignmentModel = model([{
        id: 'terrain-envelope',
        locationId: 'test',
        kind: 'overpass',
        memberOsmIds: [14],
        axis: [lonLat(0), lonLat(100)],
        profile: {
            type: 'relative-peak',
            peakOffsetM: 7,
            peakRange: {
                start: { distanceM: 40 },
                end: { distanceM: 60 },
            },
        },
    }], terrain);

    assert.equal(alignmentModel.roadYAtLocal(15, 0, 14), 15);
    const alignment = alignmentModel.getAlignmentForOsmId(14);
    assert.ok(
        alignment.samples.every(sample => sample.y >= sample.terrainY),
        'the moved road and its sidewalk/path surfaces must stay above terrain throughout both approaches',
    );
});

test('an overpass approach clears laterally higher terrain across the paved ribbon', () => {
    const alignmentModel = model([{
        id: 'lateral-terrain-envelope',
        locationId: 'test',
        kind: 'overpass',
        memberOsmIds: [15],
        axis: [lonLat(0), lonLat(100)],
        profile: {
            type: 'relative-peak',
            peakOffsetM: 7,
            peakRange: {
                start: { distanceM: 40 },
                end: { distanceM: 60 },
            },
        },
        structureRange: {
            start: { distanceM: 40 },
            end: { distanceM: 60 },
        },
    }], (_x, z) => (z >= 3 ? 15 : 10));

    assert.equal(
        alignmentModel.roadYAtLocal(15, 8, 15),
        15,
        'a buffered approach/sidewalk vertex outside the physical formation must still inherit the profile',
    );
});

test('converts an absolute EVRF2000 peak into scene coordinates', () => {
    const alignmentModel = model([{
        id: 'absolute',
        locationId: 'test',
        kind: 'overpass',
        memberOsmIds: [12],
        axis: [lonLat(0), lonLat(100)],
        profile: {
            type: 'absolute-peak',
            peakElevationAslM: 123,
            peakRange: {
                start: { fraction: 0.4 },
                end: { fraction: 0.6 },
            },
        },
    }]);
    assert.equal(alignmentModel.roadYAtLocal(50, 0, 12), 23);
});

test('interpolates detailed absolute and terrain-relative profile nodes', () => {
    const alignmentModel = model([{
        id: 'nodes',
        locationId: 'test',
        kind: 'underpass',
        memberOsmIds: [13],
        axis: [lonLat(0), lonLat(100)],
        profile: {
            type: 'nodes',
            nodes: [
                { at: { distanceM: 0 }, elevationAslM: 110 },
                { at: { distanceM: 50 }, terrainOffsetM: -8 },
                { at: { distanceM: 100 }, elevationAslM: 112 },
            ],
        },
    }]);
    assert.equal(alignmentModel.roadYAtLocal(0, 0, 13), 10);
    assert.equal(alignmentModel.roadYAtLocal(25, 0, 13), 6);
    assert.equal(alignmentModel.roadYAtLocal(50, 0, 13), 2);
    assert.ok(Math.abs(alignmentModel.roadYAtLocal(100, 0, 13) - 12) < 1e-6);
});

test('streams OSM-tagged alignments and authored definitions take precedence', () => {
    const alignmentModel = model([{
        id: 'authored',
        locationId: 'test',
        kind: 'overpass',
        memberOsmIds: [20],
        axis: [lonLat(0), lonLat(100)],
        profile: {
            type: 'relative-peak',
            peakOffsetM: 9,
            peakRange: {
                start: { fraction: 0.4 },
                end: { fraction: 0.6 },
            },
        },
    }]);
    alignmentModel.setCenterlineTile('0_0', [
        feature(20, { tunnel: 'yes' }),
        feature(21, { tunnel: 'yes', layer: '-1' }),
        feature(22, { bridge: 'yes', layer: '1' }),
        feature(23, { tunnel: 'building_passage' }),
    ]);
    assert.equal(alignmentModel.getAlignmentForOsmId(20).id, 'authored');
    assert.equal(alignmentModel.getAlignmentForOsmId(21).kind, 'underpass');
    assert.equal(alignmentModel.getAlignmentForOsmId(22).kind, 'overpass');
    assert.equal(alignmentModel.getAlignmentForOsmId(23), null);
    assert.equal(alignmentModel.roadYAtLocal(50, 0, 20), 19);
    assert.equal(alignmentModel.roadYAtLocal(50, 0, 21), 3.5);
    assert.equal(alignmentModel.roadYAtLocal(0, 0, 21), 3.5);
    assert.equal(alignmentModel.roadYAtLocal(0, 0, 22), 10);
    assert.equal(alignmentModel.roadYAtLocal(50, 0, 22), 16.5);
    assert.ok(Math.abs(alignmentModel.roadYAtLocal(100, 0, 22) - 10) < 1e-6);
    alignmentModel.removeCenterlineTile('0_0');
    assert.equal(alignmentModel.getAlignmentForOsmId(21), null);
});

test('uses OSM ele as absolute evidence and defaults an unmeasured overpass to 6.5 m', () => {
    const alignmentModel = model();
    alignmentModel.setCenterlineTile('0_0', [
        feature(24, { bridge: 'yes', layer: '2', ele: '121.5 m' }),
        feature(25, { bridge: 'yes', layer: '5' }),
    ]);
    assert.equal(alignmentModel.roadYAtLocal(50, 0, 24), 21.5);
    assert.equal(alignmentModel.roadYAtLocal(0, 0, 25), 10);
    assert.equal(alignmentModel.roadYAtLocal(50, 0, 25), 16.5);
    assert.ok(Math.abs(alignmentModel.roadYAtLocal(100, 0, 25) - 10) < 1e-6);
});

test('reports structure extents separately from approach profile extents', () => {
    const alignmentModel = model([{
        id: 'short-structure',
        locationId: 'test',
        kind: 'overpass',
        memberOsmIds: [30],
        axis: [lonLat(0), lonLat(100)],
        profile: { type: 'relative-peak', peakOffsetM: 6 },
        structureRange: {
            start: { distanceM: 40 },
            end: { distanceM: 60 },
        },
        replaceRoadSurface: true,
    }]);
    assert.equal(alignmentModel.structureAtLocal(20, 0, 30), null);
    assert.equal(alignmentModel.structureAtLocal(50, 0, 30).kind, 'overpass');
    assert.equal(alignmentModel.replacesRoadSurfaceForOsmId(30), true);
    assert.equal(alignmentModel.containsReplacementCorridor(50, 5), true);
    assert.equal(alignmentModel.containsReplacementCorridor(50, 20), false);
});

test('accepts persisted road-scale features and supersedes shipped bootstrap data', () => {
    const alignmentModel = model([{
        id: 'persist-me',
        locationId: 'test',
        kind: 'overpass',
        memberOsmIds: [40],
        axis: [lonLat(0), lonLat(100)],
        profile: { type: 'relative-peak', peakOffsetM: 4 },
    }]);
    alignmentModel.setAlignmentTile('0_0', [{
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [lonLat(0), lonLat(100)],
        },
        properties: {
            id: 'persist-me',
            city: 'test',
            kind: 'underpass',
            member_osm_ids: [40],
            profile: {
                type: 'relative-peak',
                peakOffsetM: -9,
                peakRange: {
                    start: { fraction: 0.4 },
                    end: { fraction: 0.6 },
                },
            },
            structure_range: {
                start: { fraction: 0.4 },
                end: { fraction: 0.6 },
            },
            corridor_half_width_m: 8,
            replace_road_surface: false,
            source: 'consensus-builder',
        },
    }]);
    assert.equal(alignmentModel.getAlignmentForOsmId(40).kind, 'underpass');
    assert.equal(alignmentModel.getAlignmentForOsmId(40).definition.source, 'consensus-builder');
    assert.equal(alignmentModel.roadYAtLocal(50, 0, 40), 1);
});

test('compiles persisted paired crossings into support-clear ranges', () => {
    const alignmentModel = model();
    alignmentModel.setAlignmentTile('0_0', [{
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [lonLat(0), lonLat(100)],
        },
        properties: {
            id: 'persisted-pair',
            city: 'test',
            kind: 'overpass',
            member_osm_ids: [45],
            profile: { type: 'terrain-offset', offsetM: 6.5 },
            crossings: [{
                coordinate: lonLat(50),
                angleDeg: 90,
                upperOsmIds: [45],
                lowerOsmIds: [81],
                lowerComposition: {
                    mode: 'rail',
                    formationWidthM: 6,
                },
                requiredClearanceM: 5.5,
                evidence: { source: 'authored' },
            }],
        },
    }]);

    const alignment = alignmentModel.getAlignmentForOsmId(45);
    assert.equal(alignment.crossingClearRanges.length, 1);
    assert.ok(
        roadStructureSupportClearanceAtLocal(alignment, null, 50, 0) < 0,
    );
    assert.ok(
        roadStructureSupportClearanceAtLocal(alignment, null, 30, 0) > 0,
    );
});

test('empty and overlapping alignment tiles do not churn the active revision', () => {
    const alignmentModel = model();
    const stored = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [lonLat(0), lonLat(100)],
        },
        properties: {
            id: 'dedupe-me',
            city: 'test',
            kind: 'overpass',
            member_osm_ids: [51],
            profile: { type: 'terrain-offset', offsetM: 6 },
            corridor_half_width_m: 9,
        },
    };

    assert.equal(alignmentModel.setAlignmentTile('empty', []).changed, false);
    const first = alignmentModel.setAlignmentTile('0_0', [stored]);
    assert.equal(first.changed, true);
    assert.equal(first.bounds.length, 1);
    assert.deepEqual(first.osmIds, ['51']);
    const revision = alignmentModel.revision;

    assert.equal(alignmentModel.setAlignmentTile('0_0', [stored]).changed, false);
    assert.equal(alignmentModel.setAlignmentTile('1_0', [stored]).changed, false);
    assert.equal(alignmentModel.removeAlignmentTile('0_0').changed, false);
    assert.equal(alignmentModel.revision, revision);
    assert.equal(alignmentModel.removeAlignmentTile('1_0').changed, true);
    assert.equal(alignmentModel.revision, revision + 1);
    const changes = alignmentModel.getChangesSince(0);
    assert.equal(changes.full, false);
    assert.equal(changes.revision, revision + 1);
    assert.equal(
        changes.bounds.length,
        2,
        'curb invalidation receives both the added and removed alignment bounds',
    );
    assert.deepEqual(alignmentModel.getChangesSince(revision + 1), {
        revision: revision + 1,
        full: false,
        bounds: [],
        ids: [],
    });
});

test('a road tile mutation collects one definition generation and compilation reuses it', () => {
    const alignmentModel = model();
    const collect = alignmentModel._collectDefinitions.bind(alignmentModel);
    let collections = 0;
    alignmentModel._collectDefinitions = () => { collections += 1; return collect(); };
    alignmentModel.setCenterlineTile('a', [feature(610, { bridge: 'yes', ele: '120' })]);
    alignmentModel.getAlignments();
    assert.equal(collections, 1, 'before/diff/compile must not independently collect the world');
    assert.equal(alignmentModel.getAlignmentForOsmId(610).definition.profile.elevationAslM, 120);
    alignmentModel.setCenterlineTile('b', [feature(611, { bridge: 'yes', ele: '125' })]);
    alignmentModel.getAlignments();
    assert.equal(collections, 2);
});

test('updating another road tile does not renormalize unchanged source geometry', () => {
    const alignmentModel = model();
    const source = feature(610, { bridge: 'yes', ele: '120' });
    const coordinates = source.geometry.coordinates;
    let reads = 0;
    Object.defineProperty(source.geometry, 'coordinates', {
        get() { reads += 1; return coordinates; },
    });
    alignmentModel.setCenterlineTile('a', [source]);
    alignmentModel.getAlignments();
    assert.ok(reads > 0);
    reads = 0;
    alignmentModel.setCenterlineTile('b', [feature(611, { bridge: 'yes', ele: '125' })]);
    alignmentModel.getAlignments();
    assert.equal(reads, 0, 'normalization belongs to the changed tile, not every loaded tile');
});

test('a differing duplicate is promoted after winner eviction without losing precedence', () => {
    const alignmentModel = model();
    alignmentModel.setCenterlineTile('a', [feature(610, { bridge: 'yes', ele: '120' })]);
    const duplicate = alignmentModel.setCenterlineTile('b', [
        feature(610, { bridge: 'yes', ele: '135' }, 200),
    ]);
    assert.equal(duplicate.changed, false);
    assert.equal(alignmentModel.getAlignmentForOsmId(610).definition.profile.elevationAslM, 120);
    const promoted = alignmentModel.removeCenterlineTile('a');
    assert.equal(promoted.changed, true);
    assert.equal(promoted.bounds.length, 2);
    assert.equal(alignmentModel.getAlignmentForOsmId(610).definition.profile.elevationAslM, 135);
    const firstBounds = { ...promoted.bounds[1] };
    promoted.bounds[1].maxX = 999999;
    const removed = alignmentModel.removeCenterlineTile('b');
    assert.deepEqual(removed.bounds, [firstBounds], 'callers cannot corrupt cached invalidation bounds');
    assert.equal(alignmentModel.getAlignments().length, 0);
});

test('cached road definitions still recompile against current terrain on a real mutation', () => {
    let terrainY = 10;
    const alignmentModel = model([], () => terrainY);
    alignmentModel.setCenterlineTile('a', [feature(612, { tunnel: 'yes' })]);
    const firstY = alignmentModel.getAlignmentForOsmId(612).samples[0].y;
    terrainY = 17;
    alignmentModel.setCenterlineTile('b', [feature(613, { bridge: 'yes', ele: '125' })]);
    const secondY = alignmentModel.getAlignmentForOsmId(612).samples[0].y;
    assert.equal(secondY - firstY, 7, 'only definitions are cached, not terrain-dependent solutions');
});

test('stored differing duplicates promote their cached geometry and profile on eviction', () => {
    const alignmentModel = model();
    const stored = (heightM, lengthM) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [lonLat(0), lonLat(lengthM)] },
        properties: {
            id: 'stored-duplicate', kind: 'overpass', member_osm_ids: [620],
            profile: { type: 'absolute', elevationAslM: heightM },
        },
    });
    alignmentModel.setAlignmentTile('a', [stored(120, 100)]);
    assert.equal(alignmentModel.setAlignmentTile('b', [stored(135, 200)]).changed, false);
    assert.equal(alignmentModel.getAlignmentForOsmId(620).definition.profile.elevationAslM, 120);
    const promotion = alignmentModel.removeAlignmentTile('a');
    assert.equal(promotion.changed, true);
    assert.equal(promotion.bounds.length, 2);
    assert.deepEqual(promotion.ids, ['stored-duplicate']);
    const current = alignmentModel.getAlignmentForOsmId(620);
    assert.equal(current.definition.profile.elevationAslM, 135);
    assert.deepEqual(current.definition.axis, [lonLat(0), lonLat(200)]);
});

test('removing a persisted owner restores the suppressed cached dynamic alignment', () => {
    const alignmentModel = model();
    alignmentModel.setCenterlineTile('dynamic', [feature(630, { bridge: 'yes', ele: '125' })]);
    alignmentModel.setAlignmentTile('persisted', [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [lonLat(0), lonLat(200)] },
        properties: {
            id: 'persisted-owner', kind: 'overpass', member_osm_ids: [630],
            profile: { type: 'absolute', elevationAslM: 140 },
        },
    }]);
    assert.equal(alignmentModel.getAlignments().length, 1);
    assert.equal(alignmentModel.getAlignmentForOsmId(630).id, 'persisted-owner');
    const change = alignmentModel.removeAlignmentTile('persisted');
    assert.deepEqual(new Set(change.ids), new Set(['persisted-owner', 'osm-630']));
    assert.equal(change.bounds.length, 2);
    assert.equal(alignmentModel.getAlignments().length, 1);
    assert.equal(alignmentModel.getAlignmentForOsmId(630).id, 'osm-630');
    assert.equal(alignmentModel.getAlignmentForOsmId(630).definition.profile.elevationAslM, 125);
});

test('ordinary centerline arrivals do not invalidate vertical alignment consumers', () => {
    const alignmentModel = model();
    assert.equal(alignmentModel.hasAlignmentDefinitions(), false);
    const ordinary = alignmentModel.setCenterlineTile('0_0', [
        feature(60),
        feature(61, { tunnel: 'building_passage' }),
    ]);
    assert.equal(ordinary.changed, false);
    assert.equal(alignmentModel.revision, 0);
    assert.equal(alignmentModel.hasAlignmentDefinitions(), false,
        'ordinary roads keep curb filtering on its no-alignment fast path');

    const bridge = alignmentModel.setCenterlineTile('0_0', [
        feature(62, { bridge: 'yes' }),
    ]);
    assert.equal(bridge.changed, true);
    assert.equal(alignmentModel.hasAlignmentDefinitions(), true);
    assert.deepEqual(bridge.osmIds, ['62']);
    assert.ok(bridge.bounds[0].minX < 0);
    assert.ok(bridge.bounds[0].maxX > 100);
});

test('a joining side road opens a junction gap in the companion sidewalk', () => {
    const west = surfaceFeature(340064613, {
        highway_type: 'secondary',
        tags: { highway: 'secondary', ref: '1039', lanes: '2' },
    }, [lonLat(-100), lonLat(0)]);
    const tunnel = surfaceFeature(230585889, {
        highway_type: 'secondary',
        tags: {
            highway: 'secondary',
            ref: '1039',
            tunnel: 'yes',
            layer: '-1',
            // Deep enough that the traced west approach wants more than the
            // 100 m member and stops AT its end node — where an arm joins.
            maxheight: '4.8',
            lanes: '1',
        },
    }, [lonLat(0), lonLat(10)]);
    const east = surfaceFeature(230585890, {
        highway_type: 'secondary',
        tags: { highway: 'secondary', ref: '1039', lanes: '2' },
    }, [lonLat(10), lonLat(110)]);
    // A residential arm joins the west approach at the tunnel mouth node and
    // leaves toward +z (the alignment's left); the sidewalk must break there.
    const sideRoad = surfaceFeature(999, {
        highway_type: 'residential',
        tags: { highway: 'residential' },
    }, [lonLat(0), lonLat(0, 40)]);
    // A wide arm joins where the traced approach ENDS: the profile must hold
    // the bed at grade through this mouth (the trace cannot continue past it).
    const endRoad = surfaceFeature(997, {
        highway_type: 'residential',
        tags: { highway: 'residential', width: '12' },
    }, [lonLat(-100), lonLat(-100, 30)]);
    // A footway arm joins the east node; pedestrians merge into the sidewalk,
    // so no gap is recorded for it.
    const footway = surfaceFeature(998, {
        highway_type: 'footway',
        tags: { highway: 'footway' },
    }, [lonLat(10), lonLat(10, 30)]);

    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures([
        west,
        tunnel,
        east,
        sideRoad,
        endRoad,
        footway,
    ]);
    assert.equal(centerlines.length, 1);
    const details = centerlines[0].properties.road_vertical_alignment;
    assert.deepEqual(
        new Set(details.junctions.map(junction => junction.osmId)),
        new Set(['999', '997']),
        'both carriageway arms are junction mouths, the footway is not',
    );

    const alignmentModel = model();
    alignmentModel.setCenterlineTile('surface', centerlines);
    const alignment = alignmentModel.getAlignmentForOsmId(230585889);
    assert.equal(alignment.junctionGapRanges.length, 2);
    const gap = alignment.junctionGapRanges
        .find(range => range.osmId === '999');
    assert.equal(gap.side, 'left', 'the arm leaves toward +z, the left band');
    const mouth = alignment.nearest(0, 0);
    assert.ok(
        Math.abs(gap.stationM - mouth.s) < 0.5,
        `gap centred on the junction node (${gap.stationM} vs ${mouth.s})`,
    );
    assert.ok(gap.startM < gap.stationM && gap.stationM < gap.endM);
    assert.ok(
        alignment.samples.some(sample => Math.abs(sample.s - gap.startM) < 1e-6),
        'the sidewalk break must start on an exact sampled station',
    );
    assert.ok(
        alignment.samples.some(sample => Math.abs(sample.s - gap.endM) < 1e-6),
        'the sidewalk break must end on an exact sampled station',
    );

    // The end-touching mouth: 12 m arm → 7.5 m setback held at grade, so the
    // joining road meets flat asphalt instead of a sunken bed and its step.
    const endGap = alignment.junctionGapRanges
        .find(range => range.osmId === '997');
    assert.equal(endGap.startM, 0, 'the mouth touches the alignment start');
    assert.ok(
        Math.abs(endGap.endM - 7.5) < 1e-6,
        `end gap spans the arm half width plus fillet (${endGap.endM})`,
    );
    const terrainSceneY = 10;
    assert.ok(
        Math.abs(alignment.profileYAtS(3) - terrainSceneY) < 1e-6,
        `bed stays at grade through the mouth (${alignment.profileYAtS(3)})`,
    );
    assert.ok(
        Math.abs(alignment.profileYAtS(endGap.endM) - terrainSceneY) < 1e-6,
        'grade holds to the gap edge',
    );
    assert.ok(
        alignment.profileYAtS(30) < terrainSceneY - 0.5,
        'the descent still happens beyond the mouth',
    );
});

test('bridge members separated by a short embankment share one continuous road profile', () => {
    const tags = { highway: 'primary', ref: '6', lanes: '3' };
    const west = surfaceFeature(800, {
        highway_type: 'primary',
        tags,
    }, [lonLat(-100), lonLat(0)]);
    const bridgeA = surfaceFeature(801, {
        highway_type: 'primary',
        tags: { ...tags, bridge: 'yes', layer: '1' },
    }, [lonLat(0), lonLat(100)]);
    const connector = surfaceFeature(802, {
        highway_type: 'primary',
        tags: { ...tags, embankment: 'yes' },
    }, [lonLat(100), lonLat(120)]);
    const bridgeB = surfaceFeature(803, {
        highway_type: 'primary',
        tags: { ...tags, bridge: 'yes', layer: '1' },
    }, [lonLat(120), lonLat(155)]);
    const east = surfaceFeature(804, {
        highway_type: 'primary',
        tags,
    }, [lonLat(155), lonLat(255)]);

    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures([
        west,
        connector,
        bridgeB,
        east,
        bridgeA,
    ]);
    assert.equal(centerlines.length, 1, 'the three elevated members have one owner');
    const details = centerlines[0].properties.road_vertical_alignment;
    assert.deepEqual(
        new Set(details.structureOsmIds),
        new Set(['801', '802', '803']),
    );

    const alignmentModel = model();
    alignmentModel.setCenterlineTile('surface', centerlines);
    const alignment = alignmentModel.getAlignmentForOsmId(801);
    assert.equal(alignmentModel.getAlignmentForOsmId(802), alignment);
    assert.equal(alignmentModel.getAlignmentForOsmId(803), alignment);

    const beforeFirstJoin = alignmentModel.roadYAtLocal(99.95, 0, 801);
    const afterFirstJoin = alignmentModel.roadYAtLocal(100.05, 0, 802);
    const beforeSecondJoin = alignmentModel.roadYAtLocal(119.95, 0, 802);
    const afterSecondJoin = alignmentModel.roadYAtLocal(120.05, 0, 803);
    assert.ok(Math.abs(beforeFirstJoin - afterFirstJoin) < 0.02);
    assert.ok(Math.abs(beforeSecondJoin - afterSecondJoin) < 0.02);
    assert.ok(
        Math.min(beforeFirstJoin, afterFirstJoin, beforeSecondJoin, afterSecondJoin) > 10.5,
        'the connector stays on the elevated crest instead of dropping to terrain',
    );
});

test('a bore keeps its hill: floor grades portal-to-portal, only the mouths open', () => {
    // Tent-shaped hill over a 429 m tunnel-tagged way (the Divulje shape:
    // low portals, high mid-span cover). The dip profile used to hold the
    // whole bed at mid-span terrain - 6.5, hanging it far above its own
    // portals; every stretch where that bed was not buried was carved open —
    // most of the hillside. The guard here is on what actually rendered
    // wrong: the terrain cutout regions, which must hug the portals. The old
    // approachLengthsM assertion passed while the artefact was still visible.
    const lengthM = 429;
    const portalStartY = 10;
    const portalEndY = 20;
    const hillTopY = 80;
    // A shallow shelf just inside the start portal (cover stays below the box
    // height past the fixed carve — the Divulje shape), then the hill proper,
    // then a steep drop to the end portal. The start mouth must EXTEND until
    // the hill can swallow the box; the end mouth keeps the fixed carve.
    const terrainAtX = (x) => {
        if (x <= 0) return portalStartY;
        if (x >= lengthM) return portalEndY;
        if (x < 50) return portalStartY + 2;
        if (x < 90) {
            return portalStartY + 2
                + (hillTopY - portalStartY - 2) * ((x - 50) / 40);
        }
        if (x < 339) return hillTopY;
        return hillTopY - (hillTopY - portalEndY) * ((x - 339) / 90);
    };
    const tunnelFeature = (osmId, wayLengthM) => ({
        type: 'Feature',
        properties: {
            osm_id: osmId,
            highway_type: 'service',
            tags: { tunnel: 'yes' },
            centerline_geometry: {
                type: 'LineString',
                coordinates: [lonLat(0), lonLat(wayLengthM)],
            },
        },
    });
    const options = {
        terrainElevationAslMAtCoordinate: ([lon]) => (
            100 + terrainAtX((lon - ANCHOR_LON) * M_PER_LON)
        ),
    };

    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures(
        [tunnelFeature(306878572, lengthM)],
        options,
    );
    assert.equal(centerlines.length, 1, 'a bore still gets its tunnel');
    assert.equal(centerlines[0].properties.road_vertical_alignment.kind, 'underpass');
    const alignmentModel = model([], (x) => terrainAtX(x));
    alignmentModel.setCenterlineTile('surface', centerlines);
    const alignment = alignmentModel.getAlignmentForOsmId(306878572);
    assert.ok(alignment, 'the bore compiles into an alignment');

    // The floor grades between the portals instead of tracking the hilltop.
    const chordMidY = (portalStartY + portalEndY) / 2;
    const midY = alignmentModel.roadYAtLocal(lengthM / 2, 0, 306878572);
    assert.ok(
        Math.abs(midY - chordMidY) < 2,
        `mid-span floor ${midY} m strays from the portal chord ${chordMidY} m`
        + ' — the bed is back on the hilltop',
    );

    // The covered span is decided by STATION, rail's portal convention: a
    // bounded mouth at each end, everything deeper keeps its hill whatever
    // the DMR reads mid-bore. Each mouth runs until the hill can swallow the
    // covered box (else the roof pokes out of the slope), clamped between
    // the fixed carve and its cap (else the carve chases shallow cover — a
    // ragged opening no wall set closes).
    assert.equal(
        centerlines[0].properties.road_vertical_alignment.structureMode,
        'bored',
    );
    const openLengths = alignment.borePortalOpenM;
    assert.ok(openLengths, 'a bore records its mouth lengths');
    assert.ok(
        openLengths.startM > ROAD_TUNNEL_PORTAL_CARVE_M
            && openLengths.startM <= 3 * ROAD_TUNNEL_PORTAL_CARVE_M,
        `the shelf start mouth ${openLengths.startM} m extends past the fixed`
        + ' carve but stays capped',
    );
    assert.equal(
        openLengths.endM,
        ROAD_TUNNEL_PORTAL_CARVE_M,
        'the steep end mouth keeps the fixed carve',
    );
    const structureSamples = alignment.samples.filter(sample => sample.structure);
    assert.ok(structureSamples.length > 0, 'the tunnel span produced samples');
    for (const sample of structureSamples) {
        const intoStartM = sample.s - alignment.structureStartM;
        const intoEndM = alignment.structureEndM - sample.s;
        assert.equal(
            isCoveredStructureSample(alignment, sample, 5.5, 0.7),
            intoStartM >= openLengths.startM && intoEndM >= openLengths.endM,
            `covered rule at ${intoStartM.toFixed(1)} m /`
            + ` ${intoEndM.toFixed(1)} m into the bore`,
        );
    }

    // Every terrain opening hugs a portal. This is the artefact: the old
    // profile produced cutout regions running from each portal to wherever
    // the hillside finally buried the elevated bed (8.14 ha at Divulje).
    const cutouts = alignmentModel.getReplacementTerrainCutoutRegions()
        .filter(region => region.cutoutBounds);
    assert.ok(cutouts.length >= 1, 'the mouths still open the terrain');
    const sampleSlackM = 12;
    for (const region of cutouts) {
        const nearStartPortal = region.cutoutBounds.maxX
            <= openLengths.startM + sampleSlackM;
        const nearEndPortal = region.cutoutBounds.minX
            >= lengthM - openLengths.endM - sampleSlackM;
        assert.ok(
            nearStartPortal || nearEndPortal,
            `cutout spans x ${region.cutoutBounds.minX.toFixed(0)}..`
            + `${region.cutoutBounds.maxX.toFixed(0)} — an opened hillside,`
            + ' not a portal mouth',
        );
    }

    // A long tunnel under FLAT ground is a cut-and-cover, not a bore: it must
    // keep the dug dip (its separation comes from excavation, not a hill) and
    // the full ramps that depth requires.
    const [flat] = roadVerticalCenterlinesFromSurfaceFeatures(
        [tunnelFeature(2, lengthM)],
        { terrainElevationAslMAtCoordinate: () => 110 },
    );
    const flatModel = model();
    flatModel.setCenterlineTile('surface', [flat]);
    const flatMidY = flatModel.roadYAtLocal(lengthM / 2, 0, 2);
    assert.ok(
        flatMidY < 10 - 5,
        `flat-ground cut-and-cover floor ${flatMidY} m lost its dip`,
    );
    assert.ok(
        flat.properties.road_vertical_alignment.approachLengthsM.start
            > ROAD_TUNNEL_PORTAL_CARVE_M,
        'a cut-and-cover keeps the ramp its depth requires',
    );

    // A short tunnel-tagged way is an ordinary dip and keeps its full ramp.
    const [dip] = roadVerticalCenterlinesFromSurfaceFeatures(
        [tunnelFeature(1, 80)],
        options,
    );
    assert.ok(dip, 'a short tunnel-tagged road is still an underpass');
    assert.ok(dip.properties.road_vertical_alignment.approachLengthsM.start
        > ROAD_TUNNEL_PORTAL_CARVE_M,
        'a dip must keep the ramp its depth requires');
});

test('a short hillside tunnel keeps its low portal approach on the ground', () => {
    // Grič's south branch is only 86 m long, so the old length heuristic
    // treated it as a cut-and-cover dip. Its solved crossing floor is about
    // 12 m ABOVE this lower portal, though: squeezing that rise into the 24 m
    // exterior stair approach made a floating sidewalk and a broad hole in
    // the otherwise valid hillside. A tunnel profile that would rise above
    // either portal terrain is a bore even when the tagged way is short.
    const tunnelLengthM = 86;
    const crossingX = 44;
    const terrainAt = (x, z = 0) => (
        5
        + (Math.max(0, x) / tunnelLengthM) * 30
        - Math.min(1, Math.abs(z) / 150) * 25
    );
    const steps = surfaceFeature(431439471, {
        highway_type: 'steps',
        tags: { highway: 'steps', incline: 'up' },
    }, [lonLat(-24), lonLat(0)]);
    const tunnel = surfaceFeature(431439463, {
        highway_type: 'footway',
        tags: {
            highway: 'footway',
            tunnel: 'yes',
            layer: '-1',
            location: 'underground',
        },
    }, [lonLat(0), lonLat(tunnelLengthM)]);
    const upper = surfaceFeature(45325942, {
        highway_type: 'pedestrian',
        tags: { highway: 'pedestrian' },
    }, [lonLat(crossingX, -30), lonLat(crossingX, 30)]);
    const mainTunnel = surfaceFeature(431439467, {
        highway_type: 'footway',
        tags: {
            highway: 'footway',
            tunnel: 'yes',
            layer: '-2',
            location: 'underground',
        },
    }, [
        lonLat(tunnelLengthM, -150),
        lonLat(tunnelLengthM, 0),
        lonLat(tunnelLengthM, 150),
    ]);
    const options = {
        terrainElevationAslMAtCoordinate: ([lon, lat]) => 100 + terrainAt(
            (lon - ANCHOR_LON) * M_PER_LON,
            -(lat - ANCHOR_LAT) * M_PER_LAT,
        ),
    };

    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures(
        [steps, tunnel, upper, mainTunnel],
        options,
    );
    const tunnelCenterline = centerlines.find(candidate => (
        String(candidate.properties.osm_id) === '431439463'
    ));
    assert.ok(tunnelCenterline, 'the hillside branch gets an alignment');
    assert.equal(
        tunnelCenterline.properties.road_vertical_alignment.structureMode,
        'bored',
        'an impossible exposed climb selects the hillside-bore profile',
    );
    const details = tunnelCenterline.properties.road_vertical_alignment;
    assert.equal(details.widthM, 2.5, 'a widthless foot tunnel stays pedestrian-scale');
    assert.equal(details.crossSection.formationHalfWidthM, 1.75);
    assert.equal(
        details.borePortalOpenEnds.end,
        false,
        'the shared interior node is not mistaken for a daylight portal',
    );

    const alignmentModel = model([], terrainAt);
    alignmentModel.setCenterlineTile('gric', centerlines);
    const alignment = alignmentModel.getAlignmentForOsmId(431439463);
    assert.ok(alignment, 'the hillside bore compiles');
    assert.equal(
        alignmentModel.getAlignmentForOsmId(431439471),
        alignment,
        'the entrance steps stay part of the continuous portal profile',
    );
    const approachX = -12;
    assert.ok(
        Math.abs(
            alignmentModel.roadYAtLocal(approachX, 0, 431439471)
            - terrainAt(approachX)
        ) < 1e-6,
        'the exterior steps drape the real hillside instead of floating',
    );
    assert.equal(
        alignmentModel.isInsideReplacementTerrainOpening(approachX, 0),
        false,
        'the portal approach retains the opaque terrain backstop below it',
    );
    assert.ok(
        Math.abs(
            alignmentModel.roadYAtLocal(tunnelLengthM, 0, 431439463)
            - 10
        ) < 0.1,
        'the branch meets the connected tunnel floor instead of climbing to'
        + ' the 35 m hilltop at their underground junction',
    );
    assert.equal(alignment.borePortalOpenM.endM, 0);
    assert.ok(
        alignment.borePortalOpenM.startM >= 6
            && alignment.borePortalOpenM.startM <= 18,
        `the pedestrian mouth stays bounded (${alignment.borePortalOpenM.startM} m)`,
    );
    const cutouts = alignmentModel.getReplacementTerrainCutoutRegions()
        .filter(region => region.alignmentId === alignment.id && region.cutoutBounds);
    assert.ok(cutouts.length > 0, 'the real daylight mouth still opens');
    assert.ok(
        cutouts.every(region => (
            region.cutoutBounds.maxZ - region.cutoutBounds.minZ < 5
        )),
        'the path opening remains pedestrian-width rather than using the 24 m'
        + ' generic vehicle corridor',
    );
});

test('an elevated walkway may not dig the at-grade roads it crosses', () => {
    // Way 783288530 at Strojarska: an ~80 m footway deck (bridge=yes, layer=1)
    // crosses five at-grade service alleys. Its stair-served endpoints trace
    // almost no approach run, so the capped vehicular solve used to push the
    // whole clearance deficit into generated split-lower counterparts — five
    // open-cut trenches through flat ground. A pedestrian deck climbs in place
    // (stairs/ramps/lifts) and its bridge tag is proof the clearance is built.
    const deck = surfaceFeature(1, {
        highway_type: 'footway',
        tags: { highway: 'footway', bridge: 'yes', layer: '1' },
    }, [lonLat(-40, 0), lonLat(40, 0)]);
    const alleys = [11, 12].map((osmId, index) => surfaceFeature(osmId, {
        highway_type: 'service',
        tags: { highway: 'service' },
    }, [lonLat(-20 + index * 30, -60), lonLat(-20 + index * 30, 60)]));

    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures(
        [deck, ...alleys],
        { terrainElevationAslMAtCoordinate: () => 114 },
    );
    const details = centerlines
        .map(feature => feature.properties.road_vertical_alignment)
        .filter(entry => entry && typeof entry === 'object');
    assert.equal(
        details.filter(entry => entry.source === 'osm-paired-split'
            || String(entry.source).includes('composite')).length,
        0,
        'no generated lower trench under a pedestrian deck',
    );
    const deckDetails = details.find(entry => String(entry.id) === 'osm-1');
    assert.ok(deckDetails, 'the walkway still gets its own overpass profile');
    assert.ok(deckDetails.crossings.length >= 2, 'both alleys are crossings');
    for (const crossing of deckDetails.crossings) {
        assert.ok(
            !(crossing.elevationSolution?.lowerCutM > 1e-6),
            'no crossing allocates a road cut',
        );
        assert.equal(
            crossing.elevationSolution?.feasible,
            true,
            'the deck absorbs the full clearance instead',
        );
    }
});

test('a capped vehicular bridge still shares its deficit with a generated lower cut', () => {
    // The Miramarska-under-Slavonska contract: a short road bridge whose
    // approaches cannot climb the full clearance legitimately passes the
    // residual into a generated split-lower trench. The pedestrian exemption
    // above must not disturb this.
    const bridge = surfaceFeature(2, {
        highway_type: 'primary',
        tags: { highway: 'primary', bridge: 'yes', layer: '1' },
    }, [lonLat(-40, 0), lonLat(40, 0)]);
    const lowerRoad = surfaceFeature(21, {
        highway_type: 'secondary',
        tags: { highway: 'secondary' },
    }, [lonLat(0, -200), lonLat(0, 200)]);

    const centerlines = roadVerticalCenterlinesFromSurfaceFeatures(
        [bridge, lowerRoad],
        { terrainElevationAslMAtCoordinate: () => 114 },
    );
    const generated = centerlines
        .map(feature => feature.properties.road_vertical_alignment)
        .filter(entry => entry && typeof entry === 'object')
        .filter(entry => entry.source === 'osm-paired-split'
            || String(entry.source).includes('composite'));
    assert.ok(
        generated.length > 0,
        'a grade-capped vehicular bridge still generates the lower counterpart',
    );
});
