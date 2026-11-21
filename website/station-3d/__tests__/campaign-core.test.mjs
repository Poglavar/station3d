// Exercises campaign validation, deterministic transitions, idempotence,
// checkpoints, save recovery, conversations, cinematics, and control leases.

import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateCampaignCondition } from '../core/campaign-conditions.js';
import {
    defineCampaign,
    validateCampaignDefinition,
} from '../core/campaign-definition.js';
import {
    currentCampaignObjective,
    reduceCampaign,
    restoreCampaignCheckpoint,
    startCampaignRun,
    startCampaignRunAtCheckpoint,
} from '../core/campaign-engine.js';
import {
    createCampaignSaveDocument,
    createCampaignStore,
    parseCampaignSave,
    saveCampaignRun,
} from '../core/campaign-save.js';
import {
    advanceConversation,
    conversationReconverges,
    createConversationState,
} from '../core/campaign-conversation.js';
import {
    cinematicCanonicalEndpoint,
    cinematicSubjectFromPose,
    resolveRelativeCinematicCamera,
    finishCinematic,
    sampleCinematic,
    sampleCinematicPresentation,
} from '../core/campaign-cinematics.js';
import { createControlLeaseManager } from '../core/control-lease.js';
import { evaluateRailArrival } from '../core/campaign-stations.js';

function localized(text) {
    return { en: text, hr: text };
}

function fixtureDefinition() {
    return {
        id: 'test-campaign',
        version: 1,
        metadata: { title: localized('Test'), summary: localized('Summary') },
        startSceneId: 'start',
        actors: [{ id: 'handler', label: localized('Handler') }],
        inventoryItems: [{ id: 'package', label: localized('Package') }],
        worldEffects: [{ id: 'tower' }],
        conversations: [{
            id: 'briefing',
            startBeatId: 'question',
            rememberAs: 'tone',
            beats: [
                {
                    id: 'question',
                    speakerId: 'handler',
                    text: localized('Ready?'),
                    responses: [
                        { id: 'yes', text: localized('Yes.'), tone: 'earnest', nextBeatId: 'end' },
                        { id: 'maybe', text: localized('Maybe.'), tone: 'cautious', nextBeatId: 'end' },
                    ],
                },
                { id: 'end', speakerId: 'handler', text: localized('Go.'), nextBeatId: null },
            ],
        }],
        cinematics: [{
            id: 'crossing',
            title: localized('Crossing'),
            durationMs: 1000,
            keyframes: [
                { atMs: 0, camera: { position: { lat: 43, lon: 16, heightM: 4 }, lookAt: { lat: 43.1, lon: 16.1, heightM: 0 } } },
                { atMs: 1000, easing: 'ease-in-out', camera: { position: { lat: 44, lon: 17, heightM: 8 }, lookAt: { lat: 44.1, lon: 17.1, heightM: 1 } } },
            ],
            captions: [{ startMs: 0, endMs: 1000, text: localized('Sea') }],
            endpoint: { pose: { lat: 44, lon: 17 } },
        }],
        scenes: [
            {
                id: 'start',
                adapter: 'walk',
                title: localized('Start'),
                checkpoint: { id: 'start-cp', pose: { lat: 43, lon: 16, headingDeg: 0 } },
                objectives: [{
                    id: 'speak',
                    text: localized('Speak'),
                    completeWhen: { event: { field: 'entityId', equals: 'handler' } },
                }],
                onEnter: [{ type: 'actor.spawn', actorId: 'handler' }],
                transitions: [{
                    id: 'take-package',
                    event: 'entity:interact',
                    when: { event: { field: 'entityId', equals: 'handler' } },
                    effects: [
                        { type: 'inventory.grant', itemId: 'package' },
                        { type: 'conversation.start', conversationId: 'briefing' },
                    ],
                }, {
                    id: 'leave',
                    event: 'zone:entered',
                    when: { all: [
                        { inventory: 'package' },
                        { event: { field: 'zoneId', equals: 'harbor' } },
                    ] },
                    targetSceneId: 'finish',
                    effects: [{ type: 'flag.set', flag: 'departed', value: true }],
                }],
            },
            {
                id: 'finish',
                adapter: 'gta',
                title: localized('Finish'),
                checkpoint: { id: 'finish-cp', pose: { lat: 44, lon: 17, headingDeg: 0 } },
                objectives: [{
                    id: 'complete',
                    text: localized('Complete'),
                    completeWhen: { event: { field: 'type', equals: 'cinematic:complete' } },
                }],
                transitions: [{
                    id: 'complete',
                    event: 'cinematic:complete',
                    when: { event: { field: 'cinematicId', equals: 'crossing' } },
                    effects: [
                        { type: 'cinematic.unlock', cinematicId: 'crossing' },
                        { type: 'world-effect.apply', worldEffectId: 'tower', stage: 'complete' },
                        { type: 'campaign.complete' },
                    ],
                }],
            },
        ],
    };
}

test('condition language combines flags, inventory, choices, objectives, and event fields', () => {
    const run = {
        flags: { ready: true },
        inventory: { package: 1 },
        choices: { tone: 'earnest' },
        completedObjectives: ['speak'],
        completedScenes: [],
    };
    assert.equal(evaluateCampaignCondition({ all: [
        { flag: 'ready' },
        { inventory: 'package' },
        { objective: 'speak' },
        { choice: { field: 'tone', equals: 'earnest' } },
        { event: { field: 'detail.zoneId', equals: 'harbor' } },
    ] }, { run, event: { detail: { zoneId: 'harbor' } } }), true);
    assert.equal(evaluateCampaignCondition({ not: { flag: 'ready' } }, { run }), false);
});

test('definition validator rejects unknown adapters, effects, missing localization, and unreachable scenes', () => {
    const invalid = fixtureDefinition();
    invalid.scenes[0].adapter = 'script';
    invalid.scenes[0].title.hr = '';
    invalid.scenes[0].authored = { environment: { kind: 'castle' } };
    invalid.scenes[0].onEnter.push({ type: 'execute.javascript' });
    invalid.scenes.push({
        id: 'orphan',
        adapter: 'walk',
        title: localized('Orphan'),
        checkpoint: { id: 'orphan-cp', pose: { lat: 0, lon: 0 } },
        objectives: [],
        transitions: [],
    });
    invalid.cinematics[0].captions = [{ startMs: 0, endMs: 500, speakerId: 'nobody', text: localized('Hi') }];
    const errors = validateCampaignDefinition(invalid);
    assert.ok(errors.some(error => error.includes('unknown speaker "nobody"')), 'a caption speaker must be a known actor');
    assert.ok(errors.some(error => error.includes('unknown adapter')));
    assert.ok(errors.some(error => error.includes('title.hr')));
    assert.ok(errors.some(error => error.includes('unknown effect')));
    assert.ok(errors.some(error => error.includes('unknown kind')));
    assert.ok(errors.some(error => error.includes('unreachable')));
});

test('reducer completes objectives, applies each transition once, and restores scene checkpoints', () => {
    const definition = defineCampaign(fixtureDefinition());
    const started = startCampaignRun(definition, { timestamp: 10 });
    assert.equal(started.run.currentSceneId, 'start');
    assert.equal(started.run.checkpointId, 'start-cp');
    assert.equal(currentCampaignObjective(definition, started.run).id, 'speak');

    const interacted = reduceCampaign(definition, started.run, {
        type: 'entity:interact',
        eventId: 'interaction-1',
        entityId: 'handler',
        timestamp: 20,
    });
    assert.equal(interacted.run.inventory.package, 1);
    assert.deepEqual(interacted.run.completedObjectives, ['speak']);
    assert.ok(interacted.effects.some(effect => effect.type === 'conversation.start'));
    const duplicate = reduceCampaign(definition, interacted.run, {
        type: 'entity:interact',
        eventId: 'interaction-1',
        entityId: 'handler',
        timestamp: 21,
    });
    assert.equal(duplicate.run.inventory.package, 1);
    assert.equal(duplicate.effects.length, 0);

    const departed = reduceCampaign(definition, interacted.run, {
        type: 'zone:entered',
        eventId: 'zone-1',
        zoneId: 'harbor',
        timestamp: 30,
    });
    assert.equal(departed.run.currentSceneId, 'finish');
    assert.equal(departed.run.checkpointId, 'finish-cp');
    assert.equal(departed.run.flags.departed, true);
    const failedMutation = JSON.parse(JSON.stringify(departed.run));
    failedMutation.inventory.package = 0;
    failedMutation.flags.bad = true;
    const restored = restoreCampaignCheckpoint(failedMutation, 40);
    assert.equal(restored.inventory.package, 1);
    assert.equal(restored.flags.bad, undefined);
    assert.equal(restored.currentSceneId, 'finish');
});

test('checkpoint starts enter the real scene with a canonical seeded run', () => {
    const definition = defineCampaign(fixtureDefinition());
    const started = startCampaignRunAtCheckpoint(definition, 'finish-cp', {
        timestamp: 15,
        state: {
            completedScenes: ['start'],
            completedObjectives: ['speak'],
            flags: { departed: true },
            inventory: { package: 1 },
            choices: { tone: 'earnest' },
            unlockedCinematics: ['crossing'],
        },
    });
    assert.equal(started.run.currentSceneId, 'finish');
    assert.equal(started.run.checkpointId, 'finish-cp');
    assert.equal(started.run.checkpoint.sceneId, 'finish');
    assert.deepEqual(started.run.completedScenes, ['start']);
    assert.deepEqual(started.run.inventory, { package: 1 });
    assert.equal(started.run.checkpoint.state.flags.departed, true);
    assert.deepEqual(started.effects, [{ type: 'scene.open', sceneId: 'finish' }]);
    assert.throws(
        () => startCampaignRunAtCheckpoint(definition, 'missing'),
        /Unknown campaign checkpoint/,
    );
});

test('save round-trips, migrates schema zero, and recovers corrupt documents', () => {
    const definition = defineCampaign(fixtureDefinition());
    const run = startCampaignRun(definition).run;
    const saved = saveCampaignRun(createCampaignSaveDocument(), run);
    assert.deepEqual(parseCampaignSave(JSON.stringify(saved)).document, saved);
    const migrated = parseCampaignSave(JSON.stringify({ campaigns: { [run.campaignId]: run } }));
    assert.equal(migrated.ok, true);
    assert.equal(migrated.migrated, true);
    const corrupt = parseCampaignSave('{not-json');
    assert.equal(corrupt.ok, false);
    assert.deepEqual(corrupt.recovery, createCampaignSaveDocument());

    const memory = new Map();
    const storage = {
        getItem: key => memory.get(key) ?? null,
        setItem: (key, value) => memory.set(key, value),
    };
    const store = createCampaignStore({ storage });
    store.saveRun(run);
    assert.equal(store.read().document.runs[run.campaignId].checkpointId, 'start-cp');
});

test('conversation flavor paths reconverge and remember tone', () => {
    const conversation = fixtureDefinition().conversations[0];
    assert.equal(conversationReconverges(conversation), true);
    let state = createConversationState(conversation);
    const response = advanceConversation(conversation, state, 'yes');
    state = response.state;
    assert.deepEqual(response.remembered, { key: 'tone', value: 'earnest' });
    assert.equal(state.beatId, 'end');
    assert.equal(advanceConversation(conversation, state).state.complete, true);

    const looping = JSON.parse(JSON.stringify(conversation));
    looping.beats[1].nextBeatId = 'question';
    assert.equal(conversationReconverges(looping), false);
});

test('cinematic reduced motion samples cuts and skip reaches the canonical endpoint', () => {
    const cinematic = fixtureDefinition().cinematics[0];
    const middle = sampleCinematic(cinematic, 500);
    assert.equal(middle.camera.position.lat, 43.5);
    const reduced = sampleCinematic(cinematic, 500, { reducedMotion: true });
    assert.equal(reduced.camera.position.lat, 43);
    assert.deepEqual(
        finishCinematic(cinematic, { skipped: true }).endpoint,
        cinematicCanonicalEndpoint(cinematic).endpoint,
    );
});

test('cinematic presentation fades the reel edges and masks authored shot changes', () => {
    const cinematic = {
        durationMs: 10_000,
        keyframes: [{ atMs: 0 }, { atMs: 4_000 }, { atMs: 10_000 }],
    };
    assert.equal(sampleCinematicPresentation(cinematic, 0).curtainOpacity, 1);
    assert.equal(sampleCinematicPresentation(cinematic, 2_000).curtainOpacity, 0);
    assert.equal(sampleCinematicPresentation(cinematic, 4_000).curtainOpacity, 0.72);
    assert.equal(sampleCinematicPresentation(cinematic, 4_000).shotIndex, 1);
    assert.equal(sampleCinematicPresentation(cinematic, 10_000).curtainOpacity, 1);

    // Reduced-motion camera sampling holds the first pose until 85% of its
    // span, so its blackout must cover that exact cut rather than the keyframe.
    const reducedCutMs = 4_000 * 0.85;
    assert.equal(sampleCinematicPresentation(
        cinematic,
        reducedCutMs,
        { reducedMotion: true },
    ).curtainOpacity, 0.9);
    assert.equal(sampleCinematicPresentation(
        cinematic,
        reducedCutMs,
        { reducedMotion: true },
    ).shotIndex, 1);
});

test('world-effect-only cinematic beats do not black out visible action', () => {
    const cinematic = {
        durationMs: 10_000,
        keyframes: [
            { atMs: 0 },
            { atMs: 2_000, maskTransition: false, worldEffects: { bridge: 'blast' } },
            { atMs: 4_000, worldEffects: { bridge: 'collapse' } },
            { atMs: 10_000 },
        ],
    };
    const effectBeat = sampleCinematicPresentation(cinematic, 2_000);
    assert.equal(effectBeat.curtainOpacity, 0);
    assert.equal(effectBeat.shotIndex, 0);
    assert.equal(sampleCinematicPresentation(cinematic, 4_000).curtainOpacity, 0.72);
    assert.equal(sampleCinematicPresentation(cinematic, 4_000).shotIndex, 1);
});

test('control leases pause and resume exactly once across cancellation', () => {
    const calls = [];
    const manager = createControlLeaseManager({
        clearInput: () => calls.push('clear'),
        pause: () => calls.push('pause'),
        resume: () => calls.push('resume'),
    });
    const first = manager.acquire('conversation');
    assert.equal(manager.release({ id: first.id }), false);
    assert.equal(manager.release(first), true);
    assert.equal(manager.release(first), false);
    const second = manager.acquire('cinematic');
    manager.cancel();
    assert.deepEqual(calls, [
        'clear', 'pause', 'clear', 'resume',
        'clear', 'pause', 'clear', 'resume',
    ]);
    assert.equal(manager.current(), null);
    assert.equal(second.owner, 'cinematic');
});

test('heavy-rail arrival requires the platform band, full stop, and open doors', () => {
    const station = {
        id: 'zagreb-glavni',
        arrivalBand: {
            start: { lat: 45.8044, lon: 15.9787 },
            end: { lat: 45.8045, lon: 15.9790 },
            widthM: 8,
        },
        stoppingPoint: { lat: 45.80445, lon: 15.97883 },
    };
    const moving = evaluateRailArrival(station, {
        pose: { lat: 45.80445, lon: 15.97883 },
        speedMps: 1,
        doorsOpen: true,
    });
    assert.equal(moving.inArrivalBand, true);
    assert.equal(moving.complete, false);
    assert.equal(evaluateRailArrival(station, {
        pose: { lat: 45.80445, lon: 15.97883 },
        speedMps: 0,
        doorsOpen: true,
    }).complete, true);
});

test('player-relative shots interpolate their offsets and never blend with a geographic shot', () => {
    const relative = (rightM, upM, forwardM) => ({ rightM, upM, forwardM });
    const cinematic = {
        durationMs: 3000,
        keyframes: [
            { atMs: 0, camera: { relativeTo: 'player', position: relative(10, 4, 20), lookAt: relative(0, 1, 0), fovDeg: 60 } },
            { atMs: 1000, camera: { relativeTo: 'player', position: relative(0, 4, 0), lookAt: relative(0, 1, 10), fovDeg: 50 } },
            { atMs: 1001, camera: { position: { lat: 43.06, lon: 16.18, heightM: 2 }, lookAt: { lat: 43.061, lon: 16.18, heightM: 1 }, fovDeg: 55 } },
            { atMs: 3000, camera: { position: { lat: 43.07, lon: 16.18, heightM: 2 }, lookAt: { lat: 43.071, lon: 16.18, heightM: 1 }, fovDeg: 55 } },
        ],
    };
    const half = sampleCinematic(cinematic, 500);
    assert.equal(half.camera.relativeTo, 'player');
    assert.deepEqual(half.camera.position, { lat: null, lon: null, heightM: null, rightM: 5, upM: 4, forwardM: 10 });
    assert.deepEqual(half.camera.lookAt, { lat: null, lon: null, heightM: null, rightM: 0, upM: 1, forwardM: 5 });
    assert.equal(half.camera.fovDeg, 55);
    // The one-millisecond cut between the two kinds holds the relative frame
    // wholesale instead of averaging metres with degrees.
    const cut = sampleCinematic(cinematic, 1000.5);
    assert.equal(cut.camera.relativeTo, 'player');
    assert.deepEqual(cut.camera.position, { lat: null, lon: null, heightM: null, rightM: 0, upM: 4, forwardM: 0 });
    const geo = sampleCinematic(cinematic, 2000);
    assert.equal(geo.camera.relativeTo, null);
    assert.ok(Math.abs(geo.camera.position.lat - 43.065) < 1e-4);
    assert.equal(geo.camera.position.rightM, undefined);
});

test('a player-relative camera resolves into scene space beside the subject', () => {
    const camera = {
        relativeTo: 'player',
        position: { rightM: 2, upM: 3, forwardM: -10 },
        lookAt: { rightM: 0, upM: 1, forwardM: 7 },
        fovDeg: 58,
    };
    // Scene yaw 0: forward is +z, right is -x (a right-handed scene).
    const north = resolveRelativeCinematicCamera(camera, { x: 100, y: 300, z: -50, heading: 0 });
    assert.deepEqual(north, {
        position: { x: 98, y: 303, z: -60 },
        lookAt: { x: 100, y: 301, z: -43 },
        fovDeg: 58,
    });
    // Yaw π/2: forward is +x, right is +z.
    const east = resolveRelativeCinematicCamera(camera, { x: 0, y: 0, z: 0, heading: Math.PI / 2 });
    assert.ok(Math.abs(east.position.x - -10) < 1e-9 && Math.abs(east.position.z - 2) < 1e-9);
    assert.ok(Math.abs(east.lookAt.x - 7) < 1e-9 && Math.abs(east.lookAt.z) < 1e-9);
    assert.equal(resolveRelativeCinematicCamera(camera, null), null);
    assert.equal(resolveRelativeCinematicCamera({ position: {}, lookAt: {} }, { x: 0, y: 0, z: 0, heading: 0 }), null);
    // The subject comes from the vehicle pose the frame owner renders; a pose
    // without scene coordinates is no subject at all.
    assert.deepEqual(cinematicSubjectFromPose({ gtaPose: { x: 1, y: 2, z: 3, heading: 0.5 }, x: 9 }), { x: 1, y: 2, z: 3, heading: 0.5 });
    assert.deepEqual(cinematicSubjectFromPose({ x: 1, y: 2, z: 3, heading: 0.5 }), { x: 1, y: 2, z: 3, heading: 0.5 });
    assert.equal(cinematicSubjectFromPose({ lat: 43, lon: 16, headingDeg: 155 }), null);
    assert.equal(cinematicSubjectFromPose(null), null);
});

// A transition that both sets a flag and leaves the scene used to strand any
// objective gated on that flag: objectives were swept once, before the
// transition's effects ran, and the scene was gone by the next event. The
// launch campaign's `flight-survive` waits on `vis-plane-lost`, which the same
// transition that enters Vis sets, so chapter 1 could never be fully credited.
test('an objective gated on a flag its own departing transition sets still completes', () => {
    const source = fixtureDefinition();
    const start = source.scenes.find(scene => scene.id === 'start');
    start.objectives.push({
        id: 'departed-objective',
        text: localized('Depart'),
        completeWhen: { flag: 'departed' },
    });
    const definition = defineCampaign(source);
    let run = startCampaignRun(definition, { timestamp: 10 }).run;
    run = reduceCampaign(definition, run, {
        type: 'entity:interact', eventId: 'i1', entityId: 'handler', timestamp: 20,
    }).run;
    const left = reduceCampaign(definition, run, {
        type: 'zone:entered', eventId: 'z1', zoneId: 'harbor', timestamp: 30,
    });
    assert.equal(left.run.currentSceneId, 'finish');
    assert.equal(left.run.flags.departed, true);
    assert.ok(
        left.run.completedObjectives.includes('departed-objective'),
        'the departing scene must credit an objective its own effects satisfied',
    );
    assert.ok(left.effects.some(effect => (
        effect.type === 'objective.complete' && effect.objectiveId === 'departed-objective'
    )));
});
