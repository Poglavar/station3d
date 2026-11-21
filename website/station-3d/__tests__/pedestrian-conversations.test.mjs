// Verifies the authored ambient dialogue, spatial policy, shipped voice clips,
// and the civilian collision-reaction pools used by GTA street scenes.

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import {
    CONVERSATION_LANGUAGES,
    conversationSpatial,
    nextConversationDelayS,
    pedestrianConversationLine,
    pedestrianConversationCity,
    pedestrianConversationsForCity,
    PEDESTRIAN_CONVERSATIONS,
    setPedestrianConversationClips,
} from '../core/pedestrian-conversations.js';
import { textHash } from '../core/campaign-voice-lines.js';
import { gtaCollisionReactionTexts } from '../ui/cab-voice.js';
import { resolveSpatialLocation } from '../core/locations.js';

test('every city gets generic chatter plus only its own local exchanges', () => {
    const genericIds = ['c2', 'c3', 'c4', 'c5'];
    for (const city of [undefined, null, 'osijek', 'unknown']) {
        assert.deepEqual(pedestrianConversationsForCity(city).map(script => script.id), genericIds);
    }
    assert.deepEqual(pedestrianConversationsForCity('zagreb').map(script => script.id),
        ['c1', ...genericIds, 'c6']);
    assert.deepEqual(pedestrianConversationsForCity('split').map(script => script.id),
        [...genericIds, 'c7', 'c8', 'c9']);
});


test('a recorded Croatian take replaces the generated clip only while it says the line’s current words', () => {
    const line = PEDESTRIAN_CONVERSATIONS[0].lines[0];
    try {
        setPedestrianConversationClips({ clips: { [line.id]: { file: `${line.id}.take-a.mp3`, hash: textHash(line.text.hr) } } });
        assert.equal(pedestrianConversationLine(line, 'hr').file, `station-3d/audio/conversations/voice/${line.id}.take-a.mp3`);
        assert.equal(pedestrianConversationLine(line, 'en').file, line.files.en, 'English keeps its generated clip');
        setPedestrianConversationClips({ clips: { [line.id]: { file: `${line.id}.take-b.mp3`, hash: 'older-words' } } });
        assert.equal(pedestrianConversationLine(line, 'hr').file, line.files.hr, 'a take of older words never plays');
    } finally {
        setPedestrianConversationClips(null);
    }
});

test('conversation cadence is sparse and retries sooner when no pair exists', () => {
    assert.equal(nextConversationDelayS({ first: true, randomValue: 0 }), 10);
    assert.equal(nextConversationDelayS({ first: true, randomValue: 1 }), 26);
    assert.equal(nextConversationDelayS({ foundPair: true, randomValue: 0 }), 32);
    assert.equal(nextConversationDelayS({ foundPair: true, randomValue: 1 }), 78);
    assert.equal(nextConversationDelayS({ foundPair: false, randomValue: 1 }), 13);
});

test('conversation audio attenuates and pans with the actual speaker', () => {
    const right = conversationSpatial({
        sourceX: 10, sourceZ: 0, cameraX: 0, cameraZ: 0,
        cameraRightX: 1, cameraRightZ: 0,
    });
    assert.ok(right.gain > 0);
    assert.ok(right.pan > 0.7);
    assert.equal(conversationSpatial({
        sourceX: 60, sourceZ: 0, cameraX: 0, cameraZ: 0,
        cameraRightX: 1, cameraRightZ: 0,
    }), null);
});

test('GTA collision reactions use exactly the approved civilian pools', () => {
    assert.deepEqual(gtaCollisionReactionTexts('medium'), [
        'Ej, pazi majmune!',
        'Promet je u ovom gradu sve gori, majkemi',
        'Alooooo jesi ti normalan??',
        'Koji ti je??',
        'Budalo!',
        'ej!',
        'Heeeeeej',
    ]);
    assert.deepEqual(gtaCollisionReactionTexts('severe'), [
        'Danas stvarno nije moj dan',
        'Ponekad poželim da imam tenk',
        'Još jedna rata lizinga mi je ostala, još jedna',
        'I tako je od punice auto, briga me',
        'Ajme meni i kaj bum sad? Ne bum niš',
        'Jesu ovo pripreme za vojnu paradu ili kaj? El možete pazit malo?',
        'Ode životna ušteđevina',
    ]);
});


test('GTA pedestrian layer supplies the player pose and live audio controls to the shared controller', async () => {
    const [pedestrians, cab] = await Promise.all([
        readFile(new URL('../world/pedestrians.js', import.meta.url), 'utf8'),
        readFile(new URL('../modes/cab.js', import.meta.url), 'utf8'),
    ]);
    assert.match(cab, /isGtaSession:\s*\(\)\s*=>[\s\S]*sessionPresetId === 'gta'/);
    assert.match(pedestrians, /conversationsEnabled = !!\(ctx\.isGtaSession && ctx\.isGtaSession\(\)\)/);
    assert.match(pedestrians, /getMembers: walker => pedestrianConversationMembers\(walker, scene\)/);
    assert.match(pedestrians, /getLanguage: getLang/);
    assert.match(pedestrians, /getCityId: \(\) => pedestrianConversationCity\(getLocation\(\)\)/);
    assert.match(pedestrians, /playLine: playPedestrianConversationLine/);
    assert.match(pedestrians, /updateLine: updatePedestrianConversationSpatial/);
    assert.match(pedestrians, /x: local\.x, y: pose\.y \+ 1\.55, z: local\.z/);
});

test('street conversations fall silent for a listener far above them', async () => {
    const { conversationSpatial, STREET_LISTENER_MAX_HEIGHT_M, streetListenerOutOfReach } = await import('../core/pedestrian-conversations.js');
    const base = { sourceX: 4, sourceZ: 3, cameraX: 0, cameraZ: 0, cameraRightX: 1, cameraRightZ: 0 };
    const street = conversationSpatial({ ...base, sourceY: 1.55, cameraY: 1.7 });
    assert.ok(street && street.gain > 0.5, 'eye level on the pavement hears it');
    const balcony = conversationSpatial({ ...base, sourceY: 1.55, cameraY: 12 });
    assert.ok(balcony && balcony.gain < street.gain, 'a balcony hears it, fainter');
    assert.equal(conversationSpatial({ ...base, sourceY: 1.55, cameraY: 1.55 + STREET_LISTENER_MAX_HEIGHT_M + 1 }), null, 'a rooftop-and-a-half up hears nothing');
    assert.equal(conversationSpatial({ ...base, sourceY: 1.55, cameraY: 300 }), null, 'a pilot at 300 m hears nothing');
    assert.deepEqual(conversationSpatial(base), conversationSpatial({ ...base, sourceY: null, cameraY: null }), 'callers without heights keep the old rule');
    assert.equal(streetListenerOutOfReach(null, 300), false, 'an unknown height never mutes');
});
