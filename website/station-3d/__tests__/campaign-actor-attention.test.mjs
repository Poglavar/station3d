import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { geoToLocal, localToGeo } from '../core/math.js';

import { campaignActorTracksPlayer } from '../core/campaign-actor-attention.js';

test('a fisherman keeps the fishing pose until dialogue claims his attention', () => {
    assert.equal(campaignActorTracksPlayer({ activityType: 'fishing' }), false);
    assert.equal(campaignActorTracksPlayer({
        activityType: 'fishing',
        dialogueFocused: true,
    }), true);
});

test('authored look direction remains authoritative outside dialogue', () => {
    assert.equal(campaignActorTracksPlayer({ lookAtPlayer: true }), true);
    assert.equal(campaignActorTracksPlayer({ lookAtPlayer: false }), false);
});


test('a dialogue beat aims the actor at its actual camera and overlay close releases the pose', async () => {
    const source = await readFile(new URL('../world/campaign-actors.js', import.meta.url), 'utf8');
    const record = { actor: { id: 'inspector' }, mesh: { position: { x: 0, z: 0 }, rotation: { y: 0 } }, dialogueFocused: true };
    const sandbox = { actors: [record], geoToLocal, sessionAnchorLon: 16, sessionAnchorLat: 45 };
    runInNewContext(source.slice(source.indexOf('function onActorAttention('), source.indexOf('// The dialogue UI announces')), sandbox);
    sandbox.onActorAttention({ detail: { actorId: 'inspector', pose: localToGeo(-2, 0, 16, 45) } });
    assert.ok(Math.abs(record.dialogueHeading + Math.PI / 2) < 1e-8, 'the camera can be opposite the player');
    assert.equal(record.mesh.rotation.y, record.dialogueHeading);
    const heading = record.dialogueHeading;
    sandbox.onActorAttention({ detail: { actorId: 'inspector', pose: { lat: null, lon: 16 } } });
    assert.equal(record.dialogueHeading, heading, 'missing geography cannot turn a speaker');
    sandbox.onOverlayClosed();
    assert.equal(record.dialogueHeading, null);
    assert.equal(record.dialogueFocused, false);
});
