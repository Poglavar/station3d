// Tests geographic publication, bounded rail support and missing terrain evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCampaignPackSupportIndex } from '../core/campaign-pack-support.js';
import { createCampaignPackTerrainReference, sampleCampaignPackRailSurface } from '../core/campaign-pack-ground.js';
import { localToGeo } from '../core/math.js';
import { sessionPoseReadyForPublication } from '../core/session-pose-readiness.js';
import { captureGroundReadSnapshot } from '../core/terrain-snapshot.js';

const primitive = (surfaceClass, y, rise = 0) => ({
    positions: new Float32Array([0,y,0, 100,y+rise,0, 0,y,100]),
    indices: new Uint16Array([0,1,2]),
    surfaceClaims: [{surfaceClass, capabilities:{support:true}}],
});

test('baked terrain publishes the geographic evidence used by a rail session', () => {
    const support=createCampaignPackSupportIndex([{primitives:[primitive('terrain',0)]}]);
    const anchor={anchorLon:15.97,anchorLat:45.80,sceneDatumAslM:117.875,releaseId:'test'};
    const terrain=createCampaignPackTerrainReference(support,anchor);
    assert.equal(terrain.anchorHeightM,117.875);
    assert.equal(captureGroundReadSnapshot(terrain), terrain);
    assert.equal(terrain.absoluteToSceneY(120), 2.125);
    assert.equal(terrain.absoluteToSceneY(null), null);
    const point=localToGeo(10,20,anchor.anchorLon,anchor.anchorLat);
    const y=terrain.evidenceSceneYAt(point.lon,point.lat);
    assert.equal(y,0);
    assert.equal(sessionPoseReadyForPublication({terrainPresent:true,groundY:y}),true);
    assert.equal(terrain.evidenceSceneYAt(null,null),null);
    assert.equal(terrain.evidenceSceneYAtLocal(null,null),null);
    assert.equal(terrain.evidenceSceneYAtLocal(110,110),null);
    assert.equal(sessionPoseReadyForPublication({terrainPresent:true,groundY:terrain.evidenceSceneYAtLocal(110,110)}),false);
});

test('the captured rail profile keeps a flat endpoint from following a different rail level', () => {
    const support = { supportYAt(x) { return x > 0 ? 8 : 2; } };
    assert.equal(sampleCampaignPackRailSurface(support, 0, 0, { headingDeg: 90 }).grade, 0.3);
    assert.deepEqual(sampleCampaignPackRailSurface(support, 0, 0, {
        headingDeg: 90, profilePitchDeg: 0,
    }), { railY: 2, grade: 0 });
    assert.ok(Math.abs(sampleCampaignPackRailSurface(support, 0, 0, {
        profilePitchDeg: -1,
    }).grade - Math.tan(-Math.PI / 180)) < 1e-12);
});

test('baked rail uses the rendered trackbed at the current level and a 20 metre grade chord', () => {
    const support=createCampaignPackSupportIndex([{primitives:[
        primitive('terrain',-2), primitive('rail-trackbed',7,10),
        primitive('rail-trackbed',40,10), primitive('road-carriageway',80), primitive('building',100),
    ]}]);
    const rail=sampleCampaignPackRailSurface(support,50,20,{referenceY:12,headingDeg:90});
    assert.equal(rail.railY,12);
    assert.ok(Math.abs(rail.grade-0.1)<1e-9);
    assert.equal(sampleCampaignPackRailSurface(support,50,20,{referenceY:43,headingDeg:90}).railY,45);
    assert.equal(sampleCampaignPackRailSurface(support,110,110),null);
    assert.equal(sampleCampaignPackRailSurface(support,1,1,{headingDeg:90}).grade,null);
});


test('baked terrain exposes a measured 20 m slope and keeps a missing chord unknown', () => {
    const samples = [];
    const support = {terrainYAt(x, z) {samples.push({x,z}); return x < 100 ? x * 0.02 + 3 : null;}};
    const terrain = createCampaignPackTerrainReference(support, {releaseId: 'test', anchorLon: 16, anchorLat: 45});
    assert.ok(Math.abs(terrain.evidenceSlopeAlongHeadingDeg(16,45,90) - Math.atan(.02)*180/Math.PI) < 1e-8);
    assert.ok(Math.abs(samples.at(-1).x - samples.at(-2).x - 20) < 1e-8);
    assert.equal(terrain.evidenceSlopeAlongHeadingDeg(16.01,45,90), null);
});
