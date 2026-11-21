// Locks in-place campaign relocation to the live world's coordinate frame and
// destination support surface instead of rebuilding a second Zagreb session.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    campaignWorldPackForScene,
    resolveCampaignWalkRelocation,
} from '../core/campaign-world-reuse.js';

test('a directly restored descendant reopens the immutable world it normally reuses', () => {
    const pack = { packId: 'zagreb-level' };
    const contact = { id: 'contact', authored: { campaignWorldPack: pack } };
    const chamber = { id: 'chamber', authored: { reuseWorldFrom: 'contact' } };
    const tower = { id: 'tower', authored: { reuseWorldFrom: 'chamber' } };
    const definition = { scenes: [contact, chamber, tower] };

    assert.equal(campaignWorldPackForScene(definition, tower), pack);
    assert.equal(campaignWorldPackForScene(definition, chamber), pack);
    assert.equal(campaignWorldPackForScene(definition, contact), pack);
});

test('world-pack inheritance follows preload scenes and terminates cyclic reuse safely', () => {
    const pack = { packId: 'preloaded-level' };
    const preload = { id: 'preload', authored: { campaignWorldPack: pack } };
    const approach = { id: 'approach', authored: { preloadSceneId: 'preload' } };
    const a = { id: 'a', authored: { reuseWorldFrom: 'b' } };
    const b = { id: 'b', authored: { reuseWorldFrom: 'a' } };
    const definition = { scenes: [preload, approach, a, b] };

    assert.equal(campaignWorldPackForScene(definition, approach), pack);
    assert.equal(campaignWorldPackForScene(definition, a), null);
});

test('campaign walk relocation resolves destination coordinates and ground in the live anchor', () => {
    const calls = [];
    const result = resolveCampaignWalkRelocation({
        pose: { lat: 45.798650, lon: 15.976650, headingDeg: 45 },
        anchorLat: 45.8035551,
        anchorLon: 15.9695197,
        groundYAt(x, z) {
            calls.push({ x, z });
            return 4.75;
        },
        verticalOffsetM: 80,
    });

    assert.equal(result.lat, 45.79865);
    assert.equal(result.lon, 15.97665);
    assert.equal(result.y, 84.75);
    assert.ok(Math.abs(result.yaw - Math.PI / 4) < 1e-9);
    assert.equal(calls.length, 1);
    assert.ok(Math.hypot(calls[0].x, calls[0].z) > 500);
});

test('campaign walk relocation refuses a destination without firm support', () => {
    assert.equal(resolveCampaignWalkRelocation({
        pose: { lat: 45.8, lon: 15.97 },
        anchorLat: 45.8,
        anchorLon: 15.97,
        groundYAt: () => null,
    }), null);
});

test('gallery compatibility follows a reuse chain in both directions and rejects malformed roots',async()=>{
 const {campaignScenesShareWorld}=await import('../core/campaign-world-reuse.js');
 const a={id:'a'},b={id:'b',authored:{reuseWorldFrom:'a'}},c={id:'c',authored:{reuseWorldFrom:'b'}},other={id:'other'};
 const definition={scenes:[a,b,c,other]};
 assert.equal(campaignScenesShareWorld(definition,c,a),true);
 assert.equal(campaignScenesShareWorld(definition,a,c),true);
 assert.equal(campaignScenesShareWorld(definition,c,other),false);
 a.authored={reuseWorldFrom:'c'};
 assert.equal(campaignScenesShareWorld(definition,c,a),false);
 a.authored.reuseWorldFrom='missing';
 assert.equal(campaignScenesShareWorld(definition,c,a),false);
});
