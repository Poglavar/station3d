// The rule that decouples the drawing code from the survey that produced a
// building. Run: npm run test:unit (in website/station-3d).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    belongsInBuildingLayer, buildingPipelineForFeature, isMeshModeLocation,
    PIPELINE_MESH, PIPELINE_FOOTPRINT, PIPELINE_STATED,
} from '../core/building-pipeline.js';

test('road survey solids yield to the transport layer', () => {
    assert.equal(belongsInBuildingLayer({
        source: 'gdi', geometry_kind: 'mesh', use_class: 'Cesta',
    }), false);
    assert.equal(belongsInBuildingLayer({
        source: 'gdi', geometry_kind: 'mesh', use_class: 'Stambena i mješovita',
    }), true);
    assert.equal(belongsInBuildingLayer({
        source: 'landmark', use_class: 'Cesta', material: { kind: 'concrete' },
    }), true, 'an explicitly authored/stated model remains authoritative');
});

test('a mesh is a mesh whoever surveyed it', () => {
    // The whole point: GDI and our DGU-LiDAR reconstruction are indistinguishable
    // to the builder. Before this, the pipeline came from the survey name, so
    // source 'lidar' matched no branch and 64,760 LOD2 meshes would have been
    // drawn as flat extrusions.
    assert.equal(buildingPipelineForFeature(
        { geometry_kind: 'mesh', source: 'gdi' }), PIPELINE_MESH);
    assert.equal(buildingPipelineForFeature(
        { geometry_kind: 'mesh', source: 'lidar' }), PIPELINE_MESH);
    // An unknown future survey must work with no change to this file.
    assert.equal(buildingPipelineForFeature(
        { geometry_kind: 'mesh', source: 'some-city-2031' }), PIPELINE_MESH);
});

test('a footprint extrudes, whoever surveyed it', () => {
    assert.equal(buildingPipelineForFeature(
        { geometry_kind: 'footprint', source: 'overture' }), PIPELINE_FOOTPRINT);
    assert.equal(buildingPipelineForFeature(
        { geometry_kind: 'footprint', source: 'anything' }), PIPELINE_FOOTPRINT);
});

test('geometry_kind OUTRANKS the source name', () => {
    // A mixed tile (mesh endpoint with ?fill=overture) carries both kinds, and
    // the kind must decide — otherwise a footprint stamped 'gdi' would be sent
    // through the face builder and render nothing.
    assert.equal(buildingPipelineForFeature(
        { geometry_kind: 'footprint', source: 'gdi' }), PIPELINE_FOOTPRINT);
    assert.equal(buildingPipelineForFeature(
        { geometry_kind: 'mesh', source: 'overture' }), PIPELINE_MESH);
});

test('legacy endpoints keep resolving by source, unchanged', () => {
    // /buildings-3d and /buildings-overture do not send geometry_kind. This
    // change is additive: Zagreb must behave exactly as before.
    assert.equal(buildingPipelineForFeature({ source: 'gdi' }), 'gdi');
    assert.equal(buildingPipelineForFeature({ source: 'overture' }), 'overture');
    assert.equal(buildingPipelineForFeature({}, 'gdi'), 'gdi');       // tile default
    assert.equal(buildingPipelineForFeature(null, 'overture'), 'overture');
    assert.equal(buildingPipelineForFeature(null, null), null);
    // Per-feature source still beats the tile default, as it did before.
    assert.equal(buildingPipelineForFeature({ source: 'overture' }, 'gdi'), 'overture');
});

test('mesh mode is a property of the location, not of the features', () => {
    assert.equal(isMeshModeLocation({ buildings: 'mesh' }), true);
    assert.equal(isMeshModeLocation({ buildings: 'gdi' }), false);
    assert.equal(isMeshModeLocation({ buildings: 'overture' }), false);
    assert.equal(isMeshModeLocation(null), false);
});

test('a STATED material outranks geometry_kind', () => {
    // The regression this locks: a landmark part is `geometry_kind: 'mesh'`, so
    // resolving on kind alone routed it to the mesh pipeline. That pipeline is
    // selected at the work-item by `BUILDING_SOURCE === 'gdi'`, which returns
    // before addBuildingFeature() is ever called — so the stated-material branch
    // inside it could not run, whatever it said. Cibona's glass rendered as
    // beige stucco with a procedural window grid painted over the mullions.
    assert.equal(buildingPipelineForFeature({
        geometry_kind: 'mesh', source: 'landmark',
        material: { kind: 'glass', color: '859ab2', metalness: 0.92, roughness: 0.066 },
    }), PIPELINE_STATED);

    // It is a property of the DATA, not of landmarks: any survey that starts
    // stating its materials gets drawn as modelled with no change here.
    assert.equal(buildingPipelineForFeature({
        geometry_kind: 'mesh', source: 'lidar', material: { kind: 'metal' },
    }), PIPELINE_STATED);

    // And a mesh that states nothing still goes through the facade machinery,
    // which is what gives 357k unstyled GDI meshes their look.
    assert.equal(buildingPipelineForFeature(
        { geometry_kind: 'mesh', source: 'gdi' }), PIPELINE_MESH);
    assert.equal(buildingPipelineForFeature(
        { geometry_kind: 'mesh', source: 'gdi', material: null }), PIPELINE_MESH);
});

// ── Greenhouses survive a survey migration ───────────────────────────────────
// This is the regression these lock. The greenhouse signal is Overture's
// `class`, and it is the only thing separating a glass cover system from a
// one-storey shed. When Split moved from Overture footprints to the DGU-LiDAR
// LOD2 reconstruction, the class stopped reaching the client and 76 greenhouses
// in the Kaštela fields were drawn as buildings — median 3.8 m against a 2.4 m
// ridge. The pipeline must be chosen by what the building IS, not only by the
// shape of the geometry that happened to arrive.
test('a greenhouse delivered as a MESH still builds as a greenhouse', () => {
    const properties = {
        geometry_kind: 'mesh',
        source: 'lidar',
        object_id: '35442',
        class: 'greenhouse',
        use_class: null,
        footprint: { type: 'Polygon', coordinates: [[[16.3, 43.53], [16.301, 43.53], [16.301, 43.531], [16.3, 43.53]]] },
    };
    assert.equal(buildingPipelineForFeature(properties), PIPELINE_FOOTPRINT,
        'the mesh pipeline extrudes walls and a roof, which a greenhouse has neither of');
});

test('a greenhouse mesh with NO outline falls back to the mesh pipeline', () => {
    // Better a wrong-looking greenhouse than none: the footprint pipeline has
    // nothing to rebuild the rows from without an outline.
    const properties = { geometry_kind: 'mesh', source: 'lidar', class: 'greenhouse' };
    assert.equal(buildingPipelineForFeature(properties), PIPELINE_MESH);
});

test('an Overture greenhouse footprint is unaffected', () => {
    const properties = { geometry_kind: 'footprint', source: 'overture', class: 'greenhouse' };
    assert.equal(buildingPipelineForFeature(properties), PIPELINE_FOOTPRINT);
});

test('a stated material still outranks the greenhouse rule', () => {
    // A modelled landmark is drawn as modelled, whatever it is classed as.
    const properties = {
        geometry_kind: 'mesh', class: 'greenhouse', material: { kind: 'glass' },
        footprint: { type: 'Polygon', coordinates: [] },
    };
    assert.equal(buildingPipelineForFeature(properties), PIPELINE_STATED);
});

test('an ordinary LiDAR mesh is untouched by the greenhouse rule', () => {
    const properties = {
        geometry_kind: 'mesh', source: 'lidar', class: 'house',
        footprint: { type: 'Polygon', coordinates: [] },
    };
    assert.equal(buildingPipelineForFeature(properties), PIPELINE_MESH);
});
