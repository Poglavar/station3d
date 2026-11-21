import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildRetainingWallPositions,
    formationTerrainCutoutMaskRegions,
    RoadFormationModel,
} from '../core/road-formation.js';
import {
    proposalRoadFormationFeatures,
    proposalRoadFormationId,
} from '../core/proposal-road-formation.js';
import { proposalRoadSurfaceReady } from '../core/proposal-road-publication.js';

const ANCHOR_LAT = 45;
const ANCHOR_LON = 16;
const METRES_PER_DEGREE_LAT = Math.PI / 180 * 6371000;
const METRES_PER_DEGREE_LON = METRES_PER_DEGREE_LAT
    * Math.cos(ANCHOR_LAT * Math.PI / 180);

function geographicPoint(x, z) {
    return {
        lng: ANCHOR_LON + x / METRES_PER_DEGREE_LON,
        lat: ANCHOR_LAT - z / METRES_PER_DEGREE_LAT,
    };
}

function ringCoordinate(x, z) {
    const point = geographicPoint(x, z);
    return [point.lng, point.lat];
}

function drainFormation(model) {
    let steps = 0;
    while (model.hasPendingBuild() && steps < 10000) {
        model.stepPendingBuildPreparation();
        steps += 1;
    }
    assert.equal(model.hasPendingBuild(), false, 'formation build must finish cooperatively');
}

test('proposal road adapter publishes a paired engineered centerline and corridor', () => {
    const formationId = proposalRoadFormationId(708, 'main', 0);
    const features = proposalRoadFormationFeatures([{
        proposalId: 708,
        id: 'main',
        formationId,
        isTrack: false,
        line: [geographicPoint(-20, 0), geographicPoint(20, 0)],
        ring: [
            ringCoordinate(-20, -4),
            ringCoordinate(20, -4),
            ringCoordinate(20, 4),
            ringCoordinate(-20, 4),
        ],
    }]);

    assert.equal(features.centerlines.length, 1);
    assert.equal(features.surfaces.length, 1);
    assert.equal(features.centerlines[0].properties.osm_id, formationId);
    assert.equal(features.centerlines[0].properties.highway, 'residential');
    assert.equal(features.surfaces[0].properties.osm_id, formationId);
    assert.equal(features.surfaces[0].properties.highway_type, 'residential');
    assert.deepEqual(
        features.surfaces[0].geometry.coordinates[0][0],
        features.surfaces[0].geometry.coordinates[0].at(-1),
        'surface adapter closes the civil ownership ring',
    );
});

test('proposal roads use longitudinal grade with a level cross-section and real cut/fill', () => {
    const formationId = proposalRoadFormationId(708, 'slope', 0);
    const features = proposalRoadFormationFeatures([{
        proposalId: 708,
        id: 'slope',
        formationId,
        isTrack: false,
        line: [geographicPoint(-20, 0), geographicPoint(20, 0)],
        ring: [
            ringCoordinate(-20, -4),
            ringCoordinate(20, -4),
            ringCoordinate(20, 4),
            ringCoordinate(-20, 4),
        ],
    }]);
    // The centreline rises gently eastward while the untouched hillside rises
    // sharply across it. Per-vertex terrain drape would differ by 4.8 m across
    // a six-metre cross-section; the road authority must return one chainage Y.
    const terrainY = (x, z) => x * 0.02 + z * 0.8;
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: terrainY,
        terrainEvidenceSceneYAtLocal: terrainY,
        sourceTerrainInputSceneYAtLocal: terrainY,
        sourceTerrainOwnsInputAtLocal: () => true,
    });
    assert.equal(
        model.setSurfacePublicationReadyForOsmIds([formationId], false),
        true,
    );
    model.setCenterlineTile('proposal-test:centerlines', features.centerlines);
    model.setSurfaceTile('proposal-test:surfaces', features.surfaces);
    drainFormation(model);

    const uphillEdgeY = model.sceneYAtLocal(5, 3, { osmId: formationId });
    const downhillEdgeY = model.sceneYAtLocal(5, -3, { osmId: formationId });
    assert.ok(Math.abs(uphillEdgeY - downhillEdgeY) < 1e-9,
        `cross-section banked by ${uphillEdgeY - downhillEdgeY} m`);
    assert.ok(
        model.sceneYAtLocal(15, 0, { osmId: formationId })
            > model.sceneYAtLocal(-15, 0, { osmId: formationId }),
        'the road must still climb longitudinally',
    );

    const [profile] = model.getSurfaceProfilesForOsmId(formationId);
    assert.ok(profile, 'proposal corridor must publish a civil surface profile');
    assert.equal(profile.surfacePublicationReady, false);
    assert.equal(profile.formationDressingDisabled, false);
    assert.equal(profile.terrainCutoutDisabled, false);
    assert.deepEqual(formationTerrainCutoutMaskRegions(profile), [],
        'an unpublished visible surface cannot cut terrain');
    assert.equal(model.civilGroundSceneYAtLocal(5, 0), null,
        'an unpublished visible surface cannot claim composed civil ground');
    assert.ok(profile.points.some(point => point.terrainY - point.roadY > 0.5),
        'uphill edge must be a cut');
    assert.ok(profile.points.some(point => point.roadY - point.terrainY > 0.5),
        'downhill edge must be fill');
    assert.ok(buildRetainingWallPositions(profile, 0.1, { faceKind: 'cut' }).length > 0);
    assert.ok(buildRetainingWallPositions(profile, 0.1, { faceKind: 'fill' }).length > 0);

    const formationRevision = model.revision;
    const publicationRevision = model.surfacePublicationRevision;
    assert.equal(
        model.setSurfacePublicationReadyForOsmIds([formationId], true),
        true,
    );
    assert.equal(model.revision, formationRevision,
        'publishing a visible surface must not rebuild the formation authority');
    assert.equal(model.surfacePublicationRevision, publicationRevision + 1);
    assert.equal(profile.surfacePublicationReady, true);
    assert.ok(formationTerrainCutoutMaskRegions(profile).length > 0,
        'the already visible road may now cut terrain under its civil work');
    assert.ok(Number.isFinite(model.civilGroundSceneYAtLocal(5, 0)),
        'the already visible road may now claim composed civil ground');
    assert.equal(
        model.setSurfacePublicationReadyForOsmIds([formationId], true),
        false,
        'an identical publication state is a no-op',
    );
    assert.equal(model.surfacePublicationRevision, publicationRevision + 1);
});

test('proposal road publication accepts a complete formation across a terrain NoData gap', () => {
    const formationId = proposalRoadFormationId(781, 'coastal', 0);
    const features = proposalRoadFormationFeatures([{
        proposalId: 781,
        id: 'coastal',
        formationId,
        isTrack: false,
        line: [
            geographicPoint(-30, 0),
            geographicPoint(0, 0),
            geographicPoint(30, 0),
        ],
        ring: [
            ringCoordinate(-30, -4),
            ringCoordinate(30, -4),
            ringCoordinate(30, 4),
            ringCoordinate(-30, 4),
        ],
    }]);
    const terrainY = (x, z) => (
        Math.abs(x) < 3 ? null : x * 0.02 + z * 0.4
    );
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: terrainY,
        terrainEvidenceSceneYAtLocal: terrainY,
        sourceTerrainInputSceneYAtLocal: terrainY,
        sourceTerrainOwnsInputAtLocal: () => true,
    });
    model.setCenterlineTile('coastal-test:centerlines', features.centerlines);
    model.setSurfaceTile('coastal-test:surfaces', features.surfaces);

    assert.equal(proposalRoadSurfaceReady(model, [formationId]), false,
        'a pending formation cannot publish its visible road');
    drainFormation(model);
    assert.equal(proposalRoadSurfaceReady(model, [formationId]), true,
        'the designed profile bridges a bounded NoData gap without suppressing the road');

    const [profile] = model.getSurfaceProfilesForOsmId(formationId);
    profile.points[0].roadY = Number.NaN;
    assert.equal(proposalRoadSurfaceReady(model, [formationId]), false,
        'a non-finite designed surface must still be rejected');
});
