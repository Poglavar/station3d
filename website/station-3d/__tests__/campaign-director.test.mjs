// Exercises the campaign director's adapter lifecycle, persistence, retry,
// cancellation, remembered dialogue tone, and isolated cinematic replay.

import assert from 'node:assert/strict';
import test from 'node:test';

import { defineCampaign } from '../core/campaign-definition.js';
import { createCampaignDirector } from '../core/campaign-director.js';
import { createCampaignStore } from '../core/campaign-save.js';

const localized = text => ({ en: text, hr: text });

function definition() {
    return defineCampaign({
        id: 'director-test',
        version: 1,
        metadata: { title: localized('Test'), summary: localized('Test campaign') },
        startSceneId: 'one',
        actors: [],
        worldEffects: [{ id: 'changed' }],
        cinematics: [{
            id: 'ending',
            replaySceneId: 'one',
            title: localized('Ending'),
            durationMs: 100,
            keyframes: [
                { atMs: 0, camera: { position: { lat: 1, lon: 1, heightM: 1 } } },
                { atMs: 100, camera: { position: { lat: 2, lon: 2, heightM: 2 } } },
            ],
        }],
        conversations: [{
            id: 'talk',
            startBeatId: 'hello',
            rememberAs: 'tone',
            beats: [{
                id: 'hello',
                text: localized('Hello'),
                responses: [{ id: 'warm', tone: 'warm', text: localized('Hello!') }],
            }],
        }],
        scenes: [
            {
                id: 'one',
                adapter: 'walk',
                title: localized('One'),
                checkpoint: { id: 'one-cp', pose: { lat: 1, lon: 1 } },
                objectives: [{
                    id: 'leave',
                    text: localized('Leave'),
                    completeWhen: { event: { field: 'zoneId', equals: 'exit' } },
                }],
                transitions: [{
                    id: 'leave-one',
                    event: 'zone:entered',
                    when: { event: { field: 'zoneId', equals: 'exit' } },
                    targetSceneId: 'two',
                    effects: [
                        { type: 'world-effect.apply', worldEffectId: 'changed', stage: 'one' },
                        { type: 'cinematic.unlock', cinematicId: 'ending' },
                    ],
                }],
            },
            {
                id: 'two',
                adapter: 'gta',
                title: localized('Two'),
                checkpoint: { id: 'two-cp', pose: { lat: 2, lon: 2 } },
                objectives: [],
                onEnter: [{ type: 'conversation.start', conversationId: 'talk' }],
                transitions: [],
            },
        ],
    });
}

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
}

test('a failed checkpoint open keeps recovery visible and defers its presentation until retry', async () => {
    const authored = JSON.parse(JSON.stringify(definition()));
    authored.scenes[0].onEnter = [{ type: 'cinematic.start', cinematicId: 'ending' }];
    authored.scenes[0].resumeEffects = [{
        effects: [{ type: 'ui.toast', message: localized('Resumed') }],
    }];
    let unavailable = true;
    let failure;
    const presentations = [];
    const director = createCampaignDirector({
        definitions: [defineCampaign(authored)],
        adapters: {
            walk: {
                async open() {
                    if (unavailable) throw new Error('The start lies outside its driving track.');
                    return { close() {} };
                },
            },
        },
        store: createCampaignStore({ storage: memoryStorage() }),
        ui: {
            showFailure: input => { failure = input; },
            startCinematic: () => presentations.push('cinematic'),
            showToast: () => presentations.push('resume'),
        },
    });

    await director.startCheckpoint('director-test', 'one-cp');
    assert.equal(failure.reason, 'scene-open-failed');
    assert.deepEqual(presentations, [], 'a cinematic must not replace the recovery card');

    unavailable = false;
    await failure.retry();
    assert.deepEqual(presentations, ['cinematic', 'resume']);
});

test('director crosses adapters, saves checkpoints, retries, and isolates replay', async () => {
    const calls = [];
    const uiCalls = [];
    let replayInput = null;
    const adapter = kind => ({
        async open({ scene }) {
            calls.push(`open:${kind}:${scene.id}`);
            return {
                close: ({ reason }) => calls.push(`close:${kind}:${scene.id}:${reason}`),
                handleEffect: effect => calls.push(`effect:${effect.type}`),
                setObjective: ({ scene: objectiveScene, objective }) => calls.push(
                    `objective-target:${objectiveScene.id}:${objective?.id || 'none'}`,
                ),
            };
        },
    });
    const store = createCampaignStore({ storage: memoryStorage() });
    const director = createCampaignDirector({
        definitions: [definition()],
        adapters: { walk: adapter('walk'), gta: adapter('gta') },
        store,
        clock: () => 10,
        ui: {
            showObjective: ({ scene }) => uiCalls.push(`objective:${scene.id}`),
            startConversation: input => {
                uiCalls.push(`conversation:${input.conversation.id}`);
                input.onResponse(input.conversation.beats[0].responses[0]);
            },
            startCinematic: input => {
                uiCalls.push(`cinematic:${input.cinematic.id}:${input.replay}`);
                if (input.replay) replayInput = input;
            },
        },
        onWorldEffectsChanged: effects => uiCalls.push(`world:${effects.changed || 'none'}`),
    });

    await director.start('director-test');
    assert.ok(calls.includes('objective-target:one:leave'));
    await director.dispatch({ type: 'zone:entered', zoneId: 'exit' });
    await director.dispatch({ type: 'timer:elapsed' });
    assert.equal(director.snapshot().currentSceneId, 'two');
    assert.equal(director.snapshot().choices.tone, 'warm');
    assert.equal(store.read().document.runs['director-test'].checkpointId, 'two-cp');
    assert.ok(calls.includes('close:walk:one:scene-change'));
    assert.ok(calls.includes('open:gta:two'));
    assert.ok(uiCalls.includes('world:one'));

    const beforeReplay = director.snapshot();
    assert.equal(await director.replayCinematic('director-test', 'ending'), true);
    assert.deepEqual(director.snapshot(), beforeReplay);
    assert.ok(uiCalls.includes('cinematic:ending:true'));
    const worldNotificationsBeforeClose = uiCalls.filter(call => call === 'world:one').length;
    await replayInput.onClose();
    assert.equal(
        uiCalls.filter(call => call === 'world:one').length,
        worldNotificationsBeforeClose + 1,
        'closing an isolated replay must restore the persisted world effect',
    );
    assert.deepEqual(director.snapshot(), beforeReplay);

    await director.retry();
    assert.equal(director.snapshot().currentSceneId, 'two');
    assert.ok(calls.includes('close:gta:two:retry'));
    assert.equal(
        uiCalls.filter(call => call === 'conversation:talk').length,
        2,
        'retry must reconstruct the checkpoint scene presentation',
    );
});

test('a declarative campaign failure is presented after its owning cinematic beat', async () => {
    const authored = JSON.parse(JSON.stringify(definition()));
    authored.scenes[0].transitions.unshift({
        id: 'scripted-failure',
        event: 'timer:elapsed',
        when: { event: { field: 'reason', equals: 'demolition-complete' } },
        effects: [{
            type: 'campaign.fail',
            reason: 'inspection-run',
            vehicleId: 'campaign:hz-7022',
            presentationDelayMs: 1800,
        }],
    });
    const failures = [];
    const director = createCampaignDirector({
        definitions: [defineCampaign(authored)],
        adapters: {
            walk: { async open() { return { close() {} }; } },
            gta: { async open() { return { close() {} }; } },
        },
        store: createCampaignStore({ storage: memoryStorage() }),
        ui: { showFailure: input => failures.push(input) },
    });
    await director.start('director-test');
    await director.dispatch({ type: 'timer:elapsed', reason: 'demolition-complete' });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].event.type, 'player:failed');
    assert.equal(failures[0].event.reason, 'inspection-run');
    assert.equal(failures[0].event.vehicleId, 'campaign:hz-7022');
    assert.equal(failures[0].presentationDelayMs, 1800);
    assert.equal(typeof failures[0].retry, 'function');
    assert.equal(typeof failures[0].exit, 'function');
});

test('superseded scene opens close their late session', async () => {
    const pending = [];
    const closed = [];
    const adapter = {
        open({ scene }) {
            return new Promise(resolve => pending.push(() => resolve({
                close: ({ reason }) => closed.push(`${scene.id}:${reason}`),
            })));
        },
    };
    const director = createCampaignDirector({
        definitions: [definition()],
        adapters: { walk: adapter, gta: adapter },
        store: createCampaignStore({ storage: memoryStorage() }),
    });
    const first = director.start('director-test');
    await Promise.resolve();
    const restarted = director.restart('director-test');
    await Promise.resolve();
    pending.shift()();
    await first;
    for (let spin = 0; spin < 5 && pending.length === 0; spin += 1) await Promise.resolve();
    assert.equal(pending.length, 1);
    pending.shift()();
    await restarted;
    assert.ok(closed.includes('one:superseded'));
    assert.equal(director.active().run.currentSceneId, 'one');
});

test('director starts a seeded checkpoint through its real scene adapter', async () => {
    const opened = [];
    const store = createCampaignStore({ storage: memoryStorage() });
    const director = createCampaignDirector({
        definitions: [definition()],
        adapters: {
            walk: { async open() { return { close() {} }; } },
            gta: {
                async open({ scene, run }) {
                    opened.push({ sceneId: scene.id, flags: { ...run.flags } });
                    return { close() {} };
                },
            },
        },
        store,
        clock: () => 42,
    });

    const run = await director.startCheckpoint('director-test', 'two-cp', {
        completedScenes: ['one'],
        completedObjectives: ['leave'],
        flags: { linked: true },
    });
    assert.equal(run.currentSceneId, 'two');
    assert.equal(run.checkpointId, 'two-cp');
    assert.deepEqual(opened, [{ sceneId: 'two', flags: { linked: true } }]);
    assert.equal(store.read().document.runs['director-test'].flags.linked, true);
});

test('director reuses a live world without showing a second loading state', async () => {
    const calls = [];
    const session = {
        transitionTo({ scene }) {
            calls.push(`transition:${scene.id}`);
            return true;
        },
        close({ reason }) {
            calls.push(`close:${reason}`);
        },
    };
    const director = createCampaignDirector({
        definitions: [definition()],
        adapters: {
            walk: {
                async open({ scene }) {
                    calls.push(`open:${scene.id}`);
                    return session;
                },
            },
            gta: {
                async open({ scene }) {
                    calls.push(`open:${scene.id}`);
                    return { close() {} };
                },
            },
        },
        store: createCampaignStore({ storage: memoryStorage() }),
        ui: {
            showLoading: ({ scene }) => calls.push(`loading:${scene.id}`),
        },
    });

    await director.start('director-test');
    await director.dispatch({ type: 'zone:entered', zoneId: 'exit' });

    assert.deepEqual(calls, [
        'loading:one',
        'open:one',
        'transition:two',
    ]);
    assert.equal(director.active().run.currentSceneId, 'two');
    assert.equal(director.active().session, session);
});

test('director opens a fresh scene when the live session cannot transition in place', async () => {
    const calls = [];
    const firstSession = {
        transitionTo({ scene }) {
            calls.push(`transition:${scene.id}:unsupported`);
            return false;
        },
        close({ reason }) {
            calls.push(`close:one:${reason}`);
        },
    };
    const secondSession = { close() {} };
    const director = createCampaignDirector({
        definitions: [definition()],
        adapters: {
            walk: {
                async open({ scene }) {
                    calls.push(`open:${scene.id}`);
                    return firstSession;
                },
            },
            gta: {
                async open({ scene }) {
                    calls.push(`open:${scene.id}`);
                    return secondSession;
                },
            },
        },
        store: createCampaignStore({ storage: memoryStorage() }),
        ui: {
            showLoading: ({ scene }) => calls.push(`loading:${scene.id}`),
            hideLoading: reason => calls.push(`hide-loading:${reason}`),
        },
    });

    await director.start('director-test');
    await director.dispatch({ type: 'zone:entered', zoneId: 'exit' });

    // The curtain goes up BEFORE the previous session is closed: closing it
    // hides the whole Station3D modal, and the /prijevoz map underneath must
    // never be on screen between chapters. It comes down on world-ready.
    assert.deepEqual(calls, [
        'loading:one',
        'open:one',
        'hide-loading:world-ready',
        'transition:two:unsupported',
        'loading:two',
        'close:one:scene-change',
        'open:two',
        'hide-loading:world-ready',
    ]);
    assert.equal(director.active().run.currentSceneId, 'two');
    assert.equal(director.active().session, secondSession);
});

test('continue restores a saved run and refuses an outdated save without throwing', async () => {
    const store = createCampaignStore({ storage: memoryStorage() });
    const opens = [];
    const toasts = [];
    let menus = 0;
    const adapter = kind => ({
        async open({ scene }) {
            opens.push(`${kind}:${scene.id}`);
            return { close: () => {}, handleEffect: () => {}, setObjective: () => {} };
        },
    });
    const make = () => createCampaignDirector({
        definitions: [definition()],
        adapters: { walk: adapter('walk'), gta: adapter('gta') },
        store,
        clock: () => 10,
        ui: {
            showObjective: () => {},
            showToast: (message, options) => toasts.push(options?.key || message),
            showMenu: () => { menus += 1; },
        },
    });
    await make().start('director-test');
    const resumed = await make().continue('director-test');
    assert.equal(resumed.currentSceneId, 'one');
    assert.deepEqual(opens, ['walk:one', 'walk:one']);

    const document = store.read().document;
    document.runs['director-test'].campaignVersion = 99;
    store.write(document);
    const outdated = await make().continue('director-test');
    assert.equal(outdated, null, 'an outdated save is refused, not thrown');
    assert.deepEqual(toasts, ['campaign.saveOutdated']);
    assert.equal(menus, 1, 'the player lands back on the menu, which offers Restart');
    assert.deepEqual(opens, ['walk:one', 'walk:one'], 'no scene opened for the refused save');
});

test('retry relocates inside the live session instead of reloading the world', async () => {
    const calls = [];
    const liveSession = {
        transitionTo({ scene, reason }) {
            calls.push(`transition:${scene.id}:${reason}`);
            return true;
        },
        close: ({ reason }) => calls.push(`close:${reason}`),
        handleEffect: effect => calls.push(`effect:${effect.type}`),
    };
    const director = createCampaignDirector({
        definitions: [definition()],
        adapters: {
            walk: {
                async open({ scene }) {
                    calls.push(`open:walk:${scene.id}`);
                    return { close() {} };
                },
            },
            gta: {
                async open({ scene }) {
                    calls.push(`open:gta:${scene.id}`);
                    return liveSession;
                },
            },
        },
        store: createCampaignStore({ storage: memoryStorage() }),
        ui: {
            showLoading: ({ scene }) => calls.push(`loading:${scene.id}`),
            startConversation: input => calls.push(`conversation:${input.conversation.id}`),
        },
    });

    await director.start('director-test');
    await director.dispatch({ type: 'zone:entered', zoneId: 'exit' });
    const openedBefore = calls.filter(call => call.startsWith('open:')).length;

    await director.retry();

    // A failed chase changed nothing about the streamed world; reopening it
    // would re-download the whole campaign pack.
    assert.ok(calls.includes('transition:two:retry'), 'retry asks the live session to relocate');
    assert.equal(
        calls.filter(call => call.startsWith('open:')).length,
        openedBefore,
        'the adapter never reopens a world the session can reuse',
    );
    assert.equal(
        calls.filter(call => call === 'loading:two').length,
        1,
        'an in-place retry raises no second loading curtain',
    );
    assert.ok(!calls.some(call => call.startsWith('close:')), 'the live session is not closed');
    assert.equal(
        calls.filter(call => call === 'conversation:talk').length,
        2,
        'the checkpoint presentation is rebuilt in place',
    );
});

test('retry falls back to a fresh open when the session cannot relocate', async () => {
    const calls = [];
    const director = createCampaignDirector({
        definitions: [definition()],
        adapters: {
            walk: {
                async open({ scene }) {
                    calls.push(`open:walk:${scene.id}`);
                    return { close() {} };
                },
            },
            gta: {
                async open({ scene }) {
                    calls.push(`open:gta:${scene.id}`);
                    return {
                        transitionTo: () => false,
                        close: ({ reason }) => calls.push(`close:${reason}`),
                    };
                },
            },
        },
        store: createCampaignStore({ storage: memoryStorage() }),
        ui: {},
    });

    await director.start('director-test');
    await director.dispatch({ type: 'zone:entered', zoneId: 'exit' });
    await director.retry();

    assert.deepEqual(calls, [
        'open:walk:one',
        'open:gta:two',
        'close:retry',
        'open:gta:two',
    ]);
});

test('continuing a finished run opens free roam instead of replaying the epilogue', async () => {
    const store = createCampaignStore({ storage: memoryStorage() });
    const calls = [];
    const adapter = kind => ({
        async open({ scene }) {
            calls.push(`open:${kind}:${scene.id}`);
            return { close() {}, handleEffect() {}, setObjective() {}, enterFreeRoam() { calls.push('detach'); return true; } };
        },
    });
    const make = () => createCampaignDirector({
        definitions: [definition()],
        adapters: { walk: adapter('walk'), gta: adapter('gta') },
        store,
        clock: () => 10,
        ui: {
            showObjective: () => {},
            hideObjective: () => calls.push('hide-objective'),
            closeTransient: reason => calls.push(`transient:${reason}`),
            startConversation: () => calls.push('conversation'),
        },
    });

    const first = make();
    await first.start('director-test');
    await first.dispatch({ type: 'zone:entered', zoneId: 'exit' });
    const document = store.read().document;
    document.runs['director-test'].completed = true;
    store.write(document);
    calls.length = 0;

    const resumedDirector = make();
    const resumed = await resumedDirector.continue('director-test');
    await resumedDirector.continue('director-test');
    await resumedDirector.freeRoam();
    assert.equal(calls.filter(call => call === 'detach').length, 1);
    assert.equal(resumed.completed, true);
    assert.equal((await resumedDirector.dispatch({ type: 'zone:entered', zoneId: 'exit' })).reason, 'free-roam');

    assert.equal(resumed.currentSceneId, 'two');
    assert.deepEqual(
        calls.filter(call => call.startsWith('open:')),
        ['open:gta:two'],
        'the final world reopens',
    );
    assert.ok(!calls.includes('conversation'), 'a spent epilogue conversation is never replayed');
    assert.ok(calls.includes('hide-objective'), 'free roam carries no objective card');
    assert.ok(calls.includes('transient:campaign-free-roam'));
});

test('an actor that is not available yet answers with its authored hint', async () => {
    const toasts = [];
    const director = createCampaignDirector({
        definitions: [definition()],
        adapters: { walk: { async open() { return { close() {} }; } } },
        store: createCampaignStore({ storage: memoryStorage() }),
        ui: {
            showToast: (message, options) => toasts.push({ message, actorId: options?.actorId }),
        },
    });

    await director.start('director-test');
    await director.dispatch({
        type: 'entity:unavailable',
        entityId: 'zagreb-contact',
        hint: { en: 'He is waiting for the signal.', hr: 'Čeka znak.' },
    });

    assert.deepEqual(toasts, [{
        message: { en: 'He is waiting for the signal.', hr: 'Čeka znak.' },
        actorId: 'zagreb-contact',
    }]);
    assert.equal(director.snapshot().currentSceneId, 'one', 'a hint never advances the run');
});

test('a checkpoint link applies the scene resume effects its saved state implies', async () => {
    const base = definition();
    const armed = defineCampaign({
        ...base,
        encounters: [{ id: 'wave' }],
        scenes: base.scenes.map(scene => (scene.id === 'one'
            ? { ...scene, resumeEffects: [{ when: { flag: 'armed' }, effects: [{ type: 'encounter.start', encounterId: 'wave' }] }] }
            : scene)),
    });
    const effects = [];
    const adapter = () => ({
        async open() {
            return { close: () => {}, handleEffect: effect => effects.push(effect.type), setObjective: () => {} };
        },
    });
    const director = createCampaignDirector({
        definitions: [armed],
        adapters: { walk: adapter(), gta: adapter() },
        store: createCampaignStore({ storage: memoryStorage() }),
        clock: () => 10,
        ui: { showObjective: () => {} },
    });
    await director.startCheckpoint('director-test', 'one-cp', { flags: { armed: true } });
    assert.ok(effects.includes('encounter.start'), 'the encounter is armed on a deep link, not only on continue');
    const cold = [];
    const coldDirector = createCampaignDirector({
        definitions: [armed],
        adapters: { walk: { async open() { return { close: () => {}, handleEffect: e => cold.push(e.type), setObjective: () => {} }; } }, gta: adapter() },
        store: createCampaignStore({ storage: memoryStorage() }),
        clock: () => 10,
        ui: { showObjective: () => {} },
    });
    await coldDirector.startCheckpoint('director-test', 'one-cp', {});
    assert.ok(!cold.includes('encounter.start'), 'without the flag nothing resumes');
});

test('Continue keeps a live position and progress; Retry is a separate menu action', async () => {
    let opened = 0;
    let menu;
    const session = { close() {} };
    const director = createCampaignDirector({
        definitions: [definition()], store: createCampaignStore({ storage: memoryStorage() }),
        adapters: { walk: { async open() { opened++; return session; } } },
        ui: { showMenu: input => { menu = input; } },
    });
    await director.start('director-test');
    const before = director.snapshot();
    director.openMenu();
    await menu.continue('director-test');
    assert.equal(opened, 1);
    assert.equal(director.active().session, session);
    assert.deepEqual(director.snapshot(), before);
    assert.equal(typeof menu.retry, 'function');
    await menu.retry();
    assert.equal(opened, 2);
    await director.exit();
});

test('gallery waits for its own world and restores the previous position without saving replay events', async () => {
    const store = createCampaignStore({ storage: memoryStorage() });
    const seen = [];
    const snapshot = { pose: { lat: 1.0001, lon: 1.0002, headingDeg: 31, y: 5 }, paused: true };
    let film;
    let finishOpening;
    let openings = 0;
    let restoringInput;
    let returnMenu = 0;
    const director = createCampaignDirector({
        definitions: [definition()], store,
        adapters: { walk: { async open(input) {
            openings++;
            seen.push(`open:${input.scene.id}`);
            if (openings === 2) {
                await new Promise(resolve => { finishOpening = resolve; });
                input.emit({ type: 'zone:entered', zoneId: 'exit' });
            }
            if (openings === 3) restoringInput = input;
            return {
                snapshotCheckpoint: () => snapshot,
                restoreRuntimeSnapshot: saved => { assert.deepEqual(saved, snapshot); seen.push('restore'); },
                close: () => seen.push('close'),
            };
        } } },
        ui: { startCinematic: input => { film = input; }, showMenu: () => returnMenu++ },
    });
    await director.start('director-test');
    const run = director.snapshot();
    run.unlockedCinematics = ['ending'];
    store.saveRun(run);
    const beforeRun = director.snapshot();
    const beforeSave = store.read().document;
    const playing = director.replayCinematic('director-test', 'ending');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(film, undefined, 'the camera waits for scene readiness');
    assert.equal(openings, 2);
    finishOpening();
    assert.equal(await playing, true);
    await director.dispatch({ type: 'zone:entered', zoneId: 'exit' });
    film.onComplete({ endpoint: { flags: { surprise: true } } });
    await film.onClose();
    assert.deepEqual(restoringInput.restoreSnapshot, snapshot);
    assert.equal(returnMenu, 1, 'return to the paused menu');
    assert.deepEqual(director.snapshot(), beforeRun);
    assert.deepEqual(store.read().document, beforeSave);
    assert.deepEqual(seen, ['open:one', 'close', 'open:one', 'close', 'open:one', 'restore']);
    await director.exit();
});

test('exiting while a gallery world loads closes its late session and cannot reopen the old world', async () => {
    const store = createCampaignStore({ storage: memoryStorage() });
    let opened = 0;
    let finishOpening;
    let closed = 0;
    let films = 0;
    const director = createCampaignDirector({
        definitions: [definition()], store,
        adapters: { walk: { async open() {
            opened++;
            if (opened === 2) await new Promise(resolve => { finishOpening = resolve; });
            return { close() { closed++; } };
        } } },
        ui: { startCinematic() { films++; } },
    });
    await director.start('director-test');
    store.saveRun({ ...director.snapshot(), unlockedCinematics: ['ending'] });
    const playing = director.replayCinematic('director-test', 'ending');
    await new Promise(resolve => setImmediate(resolve));
    await director.exit();
    finishOpening();
    assert.equal(await playing, false);
    assert.equal(director.active(), null);
    assert.equal(opened, 2);
    assert.equal(closed, 2);
    assert.equal(films, 0);
});

test('a failed gallery load restores the live run and reports the failure', async () => {
    const store = createCampaignStore({ storage: memoryStorage() });
    let opened = 0;
    let toast;
    const director = createCampaignDirector({
        definitions: [definition()], store,
        adapters: { walk: { async open() {
            if (++opened === 2) throw new Error('Replay scene unavailable');
            return { close() {} };
        } } },
        ui: { showToast: (_text, options) => { toast = options.key; } },
    });
    await director.start('director-test');
    store.saveRun({ ...director.snapshot(), unlockedCinematics: ['ending'] });
    const before = director.snapshot();
    assert.equal(await director.replayCinematic('director-test', 'ending'), false);
    assert.equal(opened, 3);
    assert.ok(director.active().session);
    assert.deepEqual(director.snapshot(), before);
    assert.equal(toast, 'campaign.galleryUnavailable');
    await director.exit();
});

test('gallery captures an active pursuit once and restores it without touching the run or save', async () => {
    const storage = memoryStorage();
    const store = createCampaignStore({ storage });
    const snapshot = { pose: { lat: 1, lon: 1 }, paused: true,
        encounter: { id: 'chase', previousGameMode: 'sandbox', enemies: [{ health: 61, speed: 6 }] } };
    let captured = 0;
    let restored;
    let film;
    let opened = 0;
    const director = createCampaignDirector({
        definitions: [definition()], store,
        ui: { startCinematic(input) { film = input; } },
        adapters: { walk: { async open(input) {
            opened++;
            return {
                snapshotCheckpoint() { captured++; return structuredClone(snapshot); },
                restoreRuntimeSnapshot(saved) { restored = structuredClone(saved); },
                close() {},
            };
        } } },
    });
    await director.start('director-test');
    store.saveRun({ ...director.snapshot(), unlockedCinematics: ['ending'] });
    const runBefore = director.snapshot();
    const saveBefore = storage.getItem('station3d:campaigns');
    assert.equal(await director.replayCinematic('director-test', 'ending'), true);
    assert.equal(captured, 1);
    await film.onClose();
    assert.equal(opened, 3);
    assert.deepEqual(restored, snapshot);
    assert.deepEqual(director.snapshot(), runBefore);
    assert.equal(storage.getItem('station3d:campaigns'), saveBefore);
    await director.exit();
});


test('the notebook rechecks the live location before presenting a learned document', async () => {
    const content = structuredClone(definition());
    content.journal = [{ id: 'papers', itemId: 'papers', title: localized('Order'), text: localized('Travel order'),
        when: { flag: 'learned' }, presentSceneId: 'one', recipientId: 'inspector', presentWhen: { flag: 'asked' } }];
    content.scenes[0].authored = { actors: [{ actorId: 'inspector', lat: 1, lon: 1 }] };
    content.scenes[0].transitions.push({ id: 'present', event: 'item:presented',
        when: { event: { field: 'itemId', equals: 'papers' } }, effects: [{ type: 'flag.set', flag: 'presented', value: true }] });
    let input;
    let pose = { lat: 1, lon: 1 };
    let captures = 0;
    const director = createCampaignDirector({ definitions: [content],
        store: createCampaignStore({ storage: memoryStorage() }),
        ui: { showJournal(value) { input = value; } },
        adapters: { walk: { async open() { return {
            snapshotInteraction: () => ({ pose, speedMps: 0 }),
            snapshotCheckpoint() { captures++; }, close() {},
        }; } } },
    });
    await director.startCheckpoint('director-test', 'one-cp', { flags: { learned: true, asked: true } });
    assert.equal(director.openJournal(), true);
    assert.deepEqual(input.presentableIds, ['papers']);
    assert.equal(captures, 0, 'reading notes never captures traffic or vehicle state');
    pose = { lat: 2, lon: 2 };
    assert.equal(await input.present('papers'), false);
    assert.equal(director.snapshot().flags.presented, undefined);
    pose = { lat: 1, lon: 1 };
    assert.equal(await input.present('papers'), true);
    assert.equal(director.snapshot().flags.presented, true);
    await director.exit();
    assert.equal(await input.present('papers'), false, 'a stale notebook callback cannot present in another session');
});

test('a compatible gallery film retains the mounted session and restores staged world effects and runtime',async()=>{
 const store=createCampaignStore({storage:memoryStorage()});
 let film,opens=0,closes=0,restores=0,menus=0,effects=0;
 const motion={pose:{lat:1,lon:1,y:185.4,headingDeg:87},controllerId:'foot',paused:true};
 const session={canReplayInPlace:()=>true,snapshotCheckpoint:()=>structuredClone(motion),
  restoreRuntimeSnapshot:saved=>{restores++;assert.deepEqual(saved,motion);},close:()=>closes++};
 const director=createCampaignDirector({definitions:[definition()],store,
  adapters:{walk:{open:async()=>{opens++;return session;}}},
  onWorldEffectsChanged:()=>effects++,
  ui:{startCinematic:input=>{film=input;},showMenu:()=>menus++}});
 await director.start('director-test');
 const run=director.snapshot();run.unlockedCinematics=['ending'];store.saveRun(run);
 const before=store.read().document,priorEffects=effects;
 assert.equal(await director.replayCinematic('director-test','ending'),true);
 assert.equal(opens,1);assert.equal(closes,0);assert.equal(director.active().session,session);
 await director.dispatch({type:'zone:entered',zoneId:'exit'});
 await film.onClose();
 assert.equal(restores,1);assert.equal(effects,priorEffects+1);assert.equal(menus,1);
 assert.deepEqual(store.read().document,before);
 await director.exit();assert.equal(closes,1);
});

test('exiting a compatible gallery closes the retained world once without restoring it',async()=>{
 const store=createCampaignStore({storage:memoryStorage()});let film,closes=0,restores=0;
 const director=createCampaignDirector({definitions:[definition()],store,
  adapters:{walk:{open:async()=>({canReplayInPlace:()=>true,snapshotCheckpoint:()=>null,
   close:()=>closes++,restoreRuntimeSnapshot:()=>restores++})}},ui:{startCinematic:input=>{film=input;}}});
 await director.start('director-test');const run=director.snapshot();run.unlockedCinematics=['ending'];store.saveRun(run);
 await director.replayCinematic('director-test','ending');await director.exit();await film.onClose();
 assert.equal(closes,1);assert.equal(restores,0);assert.equal(director.active(),null);
});


test('live scene events survive an in-place replay after a gallery that loaded another world', async () => {
    const store = createCampaignStore({ storage: memoryStorage() });
    let film, emit, reuse = false;
    const director = createCampaignDirector({ definitions: [definition()], store,
        adapters: {
            walk: { async open(input) { emit = input.emit; return {
                canReplayInPlace: () => reuse, close() {}, snapshotCheckpoint: () => null,
                restoreRuntimeSnapshot() {},
            }; } },
            gta: { async open() { return { close() {} }; } },
        },
        ui: { startCinematic: input => { film = input; } },
    });
    await director.start('director-test');
    store.saveRun({ ...director.snapshot(), unlockedCinematics: ['ending'] });
    await director.replayCinematic('director-test', 'ending');
    await film.onClose();
    reuse = true;
    await director.replayCinematic('director-test', 'ending');
    await film.onClose();
    emit({ type: 'zone:entered', zoneId: 'exit' });
    await director.dispatch({ type: 'zone:entered', zoneId: 'elsewhere' });
    assert.equal(director.snapshot().currentSceneId, 'two');
    await director.exit();
});

test('the host receives persisted checkpoint changes and exit without losing the saved run', async () => {
    const store = createCampaignStore({ storage: memoryStorage() });
    const states = [];
    const closed = [];
    const director = createCampaignDirector({
        definitions: [definition()], store,
        adapters: { walk: { async open() { return { close() {} }; } } },
        onStateChanged: state => states.push(state),
        ui: { closeTransient: reason => closed.push(reason) },
    });
    await director.start('director-test');
    assert.deepEqual(states.at(-1), { campaignId: 'director-test', checkpointId: 'one-cp' });
    const saved = store.read().document.runs['director-test'];
    await director.exit();
    assert.equal(states.at(-1), null);
    assert.ok(closed.includes('campaign-exit'));
    assert.deepEqual(store.read().document.runs['director-test'], saved);
});

test('a checkpoint link to the checkpoint the save is at resumes that run instead of reseeding it', async () => {
    // The host rewrites its URL to the earned checkpoint, so a page reload
    // arrives as a checkpoint link. It must keep the player's history.
    const store = createCampaignStore({ storage: memoryStorage() });
    const opens = [];
    const adapter = kind => ({
        async open({ scene }) {
            opens.push(`${kind}:${scene.id}`);
            return { close: () => {}, handleEffect: () => {}, setObjective: () => {} };
        },
    });
    let now = 1000;
    const make = () => createCampaignDirector({
        definitions: [definition()],
        adapters: { walk: adapter('walk'), gta: adapter('gta') },
        store,
        clock: () => now,
        ui: { showObjective: () => {}, startConversation: () => {} },
    });
    const first = make();
    await first.start('director-test');
    await first.dispatch({ type: 'zone:entered', zoneId: 'exit' });
    const played = first.snapshot();
    assert.equal(played.checkpoint.id, 'two-cp');
    assert.equal(played.startedAt, 1000);
    assert.deepEqual(played.unlockedCinematics, ['ending']);

    now = 5000;
    const reloaded = await make().startCheckpoint('director-test', 'two-cp', {});
    assert.equal(reloaded.currentSceneId, 'two');
    assert.equal(reloaded.startedAt, 1000, 'the start time survives the reload');
    assert.deepEqual(reloaded.unlockedCinematics, ['ending'], 'unlocks survive the reload');
    assert.deepEqual(reloaded.completedScenes, ['one'], 'earned progress survives the reload');
    assert.deepEqual(opens, ['walk:one', 'gta:two', 'gta:two']);

    // A link to a checkpoint the save is NOT at is an explicit checkpoint test
    // and still starts from the canonical seed.
    now = 9000;
    const seeded = await make().startCheckpoint('director-test', 'one-cp', {});
    assert.equal(seeded.currentSceneId, 'one');
    assert.equal(seeded.startedAt, 9000);
    assert.deepEqual(seeded.unlockedCinematics, []);
});

test('a retained-world journey releases the dialogue pause before waiting for arrival', async () => {
    let paused = false;
    const director = createCampaignDirector({
        definitions: [definition()],
        adapters: {
            walk: { async open() { return {
                async transitionTo() {
                    assert.equal(paused, false, 'simulation must advance during physical travel');
                    return true;
                }, close() {},
            }; } },
            gta: { async open() { throw new Error('must reuse world'); } },
        },
        store: createCampaignStore({ storage: memoryStorage() }),
        ui: { closeTransient() { paused = false; } },
    });
    await director.start('director-test');
    paused = true;
    await director.dispatch({ type: 'zone:entered', zoneId: 'exit' });
    assert.equal(director.active().run.currentSceneId, 'two');
});

test('completion action detaches once and blocks late story events during handoff', async () => {
    const authored = JSON.parse(JSON.stringify(definition()));
    authored.scenes[0].onEnter = [{ type: 'campaign.complete' }];
    let completion;
    let finish;
    let detached = 0;
    let closed = 0;
    const director = createCampaignDirector({
        definitions: [defineCampaign(authored)],
        store: createCampaignStore({ storage: memoryStorage() }),
        adapters: { walk: { open: async () => ({
            close() { closed++; },
            enterFreeRoam() { detached++; return new Promise(resolve => { finish = resolve; }); },
        }) } },
        ui: { showCompleted: input => { completion = input; } },
    });
    await director.start('director-test');
    assert.equal(typeof completion.freeRoam, 'function');
    const first = completion.freeRoam();
    const repeated = completion.freeRoam();
    assert.equal(detached, 1);
    assert.equal((await director.dispatch({ type: 'zone:entered', zoneId: 'exit' })).reason, 'free-roam');
    finish(true);
    assert.equal(await first, true);
    assert.equal(await repeated, true);
    assert.equal(closed, 0, 'world remains open');
    assert.equal(director.active().run.currentSceneId, 'one');
});
