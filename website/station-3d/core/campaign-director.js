// Orchestrates serializable campaign runs across replaceable Station3D scene
// adapters. Browser I/O is injected so lifecycle and cancellation stay tested.

import { campaignAsset, campaignScene } from './campaign-definition.js';
import {
    currentCampaignObjective,
    reduceCampaign,
    restoreCampaignCheckpoint,
    startCampaignRun,
    startCampaignRunAtCheckpoint,
} from './campaign-engine.js';
import { campaignWorldEffectsFromSave } from './campaign-save.js';
import { finiteOrNull } from './math.js';
import { evaluateCampaignCondition } from './campaign-conditions.js';
import { campaignJournalEntries, canPresentJournalItem } from './campaign-journal.js';

const PERSISTENT_EFFECTS = new Set([
    'choice.remember',
    'cinematic.unlock',
    'scene.complete',
    'world-effect.apply',
    'world-effect.remove',
    'campaign.complete',
]);

function noop() {}

function definitionsById(definitions) {
    if (definitions instanceof Map) return new Map(definitions);
    if (Array.isArray(definitions)) return new Map(definitions.map(item => [item.id, item]));
    return new Map(Object.entries(definitions || {}));
}

function defaultUi() {
    return {
        closeTransient: noop,
        hideObjective: noop,
        showCompleted: noop,
        showFailure: noop,
        showLoading: noop,
        hideLoading: noop,
        showMenu: noop,
        showJournal: noop,
        showObjective: noop,
        showToast: noop,
        startConversation: noop,
        startCinematic: noop,
    };
}

function nowTimestamp(clock) {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
}

export function createCampaignDirector({
    definitions,
    adapters = {},
    store,
    ui = {},
    clock = Date.now,
    onWorldEffectsChanged = noop,
    onStateChanged = noop,
} = {}) {
    const catalog = definitionsById(definitions);
    if (!store) throw new Error('Campaign director requires a save store.');
    const view = { ...defaultUi(), ...ui };
    let activeDefinition = null;
    let activeRun = null;
    let activeSession = null;
    let sceneAbortController = null;
    let sceneGeneration = 0;
    let eventSequence = 0;
    let eventQueue = Promise.resolve();
    let replayState = null;
    let freeRoamDetached = false;
    let freeRoamPending = null;

    const definitionFor = (campaignId) => {
        const definition = catalog.get(String(campaignId || ''));
        if (!definition) throw new Error(`Unknown campaign "${campaignId}".`);
        return definition;
    };

    const readDocument = () => {
        const result = store.read();
        return result.ok ? result.document : null;
    };

    const notifyWorldEffects = (document = readDocument()) => {
        if (!document) return;
        onWorldEffectsChanged(campaignWorldEffectsFromSave(document));
    };

    // A saved, unfinished run of the current content version whose last
    // committed checkpoint is exactly this one. Its own checkpoint id is what
    // the host writes into the URL, so a reload asks for precisely it.
    const savedRunAtCheckpoint = (definition, checkpointId) => {
        const saved = readDocument()?.runs?.[definition.id];
        if (!saved) return false;
        if (Number(saved.campaignVersion) !== Number(definition.version)) return false;
        return saved.checkpoint?.id === String(checkpointId || '').trim();
    };

    const persistRun = () => {
        if (!activeRun) return null;
        const document = store.saveRun(activeRun);
        notifyWorldEffects(document);
        onStateChanged({ campaignId: activeDefinition.id, checkpointId: activeRun.checkpoint?.id || null });
        return document;
    };

    const renderObjective = (checkpointConfirmed = false) => {
        if (freeRoamDetached || !activeDefinition || !activeRun) return;
        const scene = campaignScene(activeDefinition, activeRun.currentSceneId);
        const objective = currentCampaignObjective(activeDefinition, activeRun);
        activeSession?.setObjective?.({
            definition: activeDefinition,
            run: activeRun,
            scene,
            objective,
        });
        if (activeRun.completed) { view.hideObjective(); return; }
        view.showObjective({
            definition: activeDefinition,
            run: activeRun,
            scene,
            objective,
            checkpointConfirmed,
            openJournal: () => director.openJournal(),
        });
    };

    const freeRoam = () => {
        if (freeRoamPending) return freeRoamPending;
        if (freeRoamDetached) return Promise.resolve(true);
        if (!activeRun?.completed) return Promise.resolve(false);
        const session = activeSession;
        freeRoamDetached = true;
        freeRoamPending = (async () => {
            try {
                if (session?.enterFreeRoam && await session.enterFreeRoam() === false) {
                    freeRoamDetached = false;
                    return false;
                }
                if (session !== activeSession) return false;
                view.closeTransient('campaign-free-roam');
                view.hideObjective();
                return true;
            } catch (error) {
                freeRoamDetached = false;
                throw error;
            } finally { freeRoamPending = null; }
        })();
        return freeRoamPending;
    };

    const closeScene = async (reason = 'replace') => {
        sceneAbortController?.abort(reason);
        sceneAbortController = null;
        const previous = activeSession;
        activeSession = null;
        view.closeTransient(reason);
        if (previous?.close) await previous.close({ reason });
    };

    const cancelReplay = async (reason) => {
        const replay = replayState;
        if (!replay) return;
        replayState = null;
        replay.cancelled = true;
        replay.abort.abort(reason);
        await replay.session?.close?.({ reason });
    };

    const openScene = async (sceneId) => {
        const scene = campaignScene(activeDefinition, sceneId);
        if (!scene) throw new Error(`Unknown campaign scene "${sceneId}".`);
        const adapter = adapters[scene.adapter];
        if (!adapter?.open) throw new Error(`Campaign adapter "${scene.adapter}" is unavailable.`);
        const generation = ++sceneGeneration;
        if (activeSession?.transitionTo) {
            try {
                // A retained-world transition can involve physical travel.
                // Release the dialogue's simulation pause before awaiting it.
                view.closeTransient('scene-transition');
                const reused = await activeSession.transitionTo({
                    definition: activeDefinition,
                    run: activeRun,
                    scene,
                    emit: event => queueEvent(event),
                });
                if (generation !== sceneGeneration) return false;
                if (reused) {
                    view.closeTransient('scene-change-in-place');
                    renderObjective(true);
                    return true;
                }
            } catch (error) {
                if (generation !== sceneGeneration) return false;
                view.showFailure({
                    reason: 'scene-transition-failed',
                    error,
                    retry: () => director.retry(),
                    exit: () => director.exit(),
                });
                return false;
            }
        }
        // The curtain goes up BEFORE the running session is closed: closing it
        // hides the Station3D modal, and without a cover the /prijevoz map
        // underneath is on screen for the whole of the next world's download.
        view.showLoading({ definition: activeDefinition, run: activeRun, scene });
        await closeScene('scene-change');
        if (generation !== sceneGeneration) return false;
        sceneAbortController = new AbortController();
        const signal = sceneAbortController.signal;
        try {
            const session = await adapter.open({
                definition: activeDefinition,
                run: activeRun,
                scene,
                signal,
                emit: event => queueEvent(event),
            });
            if (signal.aborted || generation !== sceneGeneration) {
                // A newer open already owns the curtain; leave it up for it.
                await session?.close?.({ reason: 'superseded' });
                return false;
            }
            activeSession = session || {};
            view.hideLoading('world-ready');
            renderObjective(true);
            return true;
        } catch (error) {
            if (signal.aborted || generation !== sceneGeneration) return false;
            view.hideLoading('scene-open-failed');
            view.showFailure({
                reason: 'scene-open-failed',
                error,
                retry: () => director.retry(),
                exit: () => director.exit(),
            });
            return false;
        }
    };

    const applyEffect = async (effect) => {
        switch (effect.type) {
        case 'scene.open':
            return openScene(effect.sceneId);
        case 'conversation.start': {
            const conversation = campaignAsset(
                activeDefinition,
                'conversations',
                effect.conversationId,
            );
            if (!conversation) throw new Error(`Unknown conversation "${effect.conversationId}".`);
            view.startConversation({
                definition: activeDefinition,
                conversation,
                run: activeRun,
                scene: campaignScene(activeDefinition, activeRun.currentSceneId),
                onResponse: response => queueEvent({
                    type: 'conversation:response',
                    conversationId: conversation.id,
                    responseId: response.id,
                    choiceKey: response.rememberAs || conversation.rememberAs || null,
                    choiceValue: response.tone || response.id,
                }),
                onComplete: () => queueEvent({
                    type: 'conversation:complete',
                    conversationId: conversation.id,
                }),
            });
            break;
        }
        case 'cinematic.start': {
            const cinematic = campaignAsset(activeDefinition, 'cinematics', effect.cinematicId);
            if (!cinematic) throw new Error(`Unknown cinematic "${effect.cinematicId}".`);
            try {
                view.startCinematic({
                    definition: activeDefinition,
                    cinematic,
                    replay: false,
                    onClose: () => notifyWorldEffects(),
                    onComplete: result => queueEvent({
                        type: 'cinematic:complete',
                        cinematicId: cinematic.id,
                        endpoint: result?.endpoint || cinematic.endpoint || null,
                    }),
                    onSkip: result => queueEvent({
                        type: 'cinematic:skip',
                        cinematicId: cinematic.id,
                        endpoint: result?.endpoint || cinematic.endpoint || null,
                    }),
                });
            } catch (error) {
                // A scene whose only exit is `cinematic:complete` — the Adriatic
                // crossing — is a dead end if the presentation cannot start (no
                // frame owner). Offer the checkpoint instead of stranding the
                // player in a boat with no reachable objective.
                view.showFailure({
                    reason: 'cinematic-unavailable',
                    error,
                    retry: () => director.retry(),
                    exit: () => director.exit(),
                });
            }
            break;
        }
        case 'ui.toast':
            view.showToast(effect.message || '', { ...effect, key: effect.messageKey || null });
            break;
        // A timed caption track over live gameplay: the story speaks while the
        // player keeps flying, unlike a cinematic, which pauses the world.
        case 'ui.captions':
            view.showCaptions?.(effect.captions || []);
            break;
        case 'world-effect.apply':
        case 'world-effect.remove':
            notifyWorldEffects();
            break;
        case 'campaign.fail':
            view.showFailure({
                reason: 'player:failed',
                event: {
                    type: 'player:failed',
                    reason: effect.reason || 'campaign-failed',
                    vehicleId: effect.vehicleId || null,
                },
                presentationDelayMs: effect.presentationDelayMs,
                retry: () => director.retry(),
                exit: () => director.exit(),
            });
            break;
        // Reaching the end of a 60–90 minute campaign used to look exactly like
        // an ordinary scene transition: the save flipped to completed and the
        // screen went back to gameplay with a blank objective card. Say so.
        case 'campaign.complete':
            view.showCompleted({
                definition: activeDefinition,
                run: activeRun,
                restart: () => director.restart(activeDefinition.id),
                exit: () => director.exit(),
                freeRoam: () => director.freeRoam(),
            });
            break;
        default:
            await activeSession?.handleEffect?.(effect, {
                definition: activeDefinition,
                run: activeRun,
                scene: campaignScene(activeDefinition, activeRun.currentSceneId),
            });
            break;
        }
    };

    const applyEffects = async (effects) => {
        for (const effect of effects || []) {
            // A failed or superseded open has no world for its following
            // presentation. Keep its recovery card instead of covering it
            // with an intro cinematic that can never advance.
            if (await applyEffect(effect) === false) return false;
        }
        renderObjective(false);
        return true;
    };

    const rehydrateScene = async () => {
        const scene = campaignScene(activeDefinition, activeRun?.currentSceneId);
        if (!scene) return;
        // onEnter owns presentation setup as well as state effects. The state
        // portion is already present in the serialized checkpoint; replaying
        // the commands reconstructs actors/cinematics without mutating it twice.
        await applyEffects(scene.onEnter || []);
        await applyResumeEffects(scene);
    };

    // Presentation that a saved state implies but onEnter never replays: an
    // attached actor, a running encounter. Every way into a scene with state
    // already in hand — continue, retry, a checkpoint link — must apply them.
    const applyResumeEffects = async (scene) => {
        for (const resume of scene?.resumeEffects || []) {
            if (!evaluateCampaignCondition(resume.when, { run: activeRun, event: {} })) continue;
            await applyEffects(resume.effects || []);
        }
    };

    const dispatchNow = async (inputEvent) => {
        if (freeRoamDetached) return { ignored: true, reason: 'free-roam' };
        if (replayState || !activeDefinition || !activeRun || !inputEvent?.type) return null;
        const event = {
            ...inputEvent,
            eventId: inputEvent.eventId || `campaign-event:${++eventSequence}`,
            timestamp: finiteOrNull(inputEvent.timestamp) != null
                ? finiteOrNull(inputEvent.timestamp)
                : nowTimestamp(clock),
        };
        // An actor the story has not unlocked yet is silent otherwise: the E
        // prompt never appears and the player concludes the actor is broken.
        // Authoring attaches `unavailableHint` to the placement; say it.
        if (event.type === 'entity:unavailable') {
            view.showToast(event.hint || '', { actorId: event.entityId || null });
            return { run: activeRun, effects: [], checkpointChanged: false };
        }
        if (event.type === 'player:failed'
            || event.type === 'vehicle:destroyed'
            || event.type === 'encounter:failed') {
            view.showFailure({
                reason: event.type,
                event,
                retry: () => director.retry(),
                exit: () => director.exit(),
            });
            return { run: activeRun, effects: [], checkpointChanged: false };
        }
        const result = reduceCampaign(activeDefinition, activeRun, event);
        if (event.type === 'conversation:response' && event.choiceKey) {
            result.run.choices[event.choiceKey] = event.choiceValue;
            result.effects.push({
                type: 'choice.remember',
                key: event.choiceKey,
                value: event.choiceValue,
            });
        }
        activeRun = result.run;
        if (result.checkpointChanged
            || result.effects.some(effect => PERSISTENT_EFFECTS.has(effect.type))) {
            persistRun();
        }
        await applyEffects(result.effects);
        return { ...result, run: activeRun };
    };

    function queueEvent(event) {
        eventQueue = eventQueue.then(
            () => dispatchNow(event),
            () => dispatchNow(event),
        );
        return eventQueue;
    }

    const director = {
        freeRoam,
        list() {
            return [...catalog.values()];
        },

        openMenu() {
            const result = store.read();
            view.showMenu({
                definitions: [...catalog.values()],
                document: result.ok ? result.document : null,
                corruptError: result.ok ? null : result.error,
                activeCampaignId: activeDefinition?.id || null,
                start: campaignId => director.start(campaignId),
                continue: campaignId => director.continue(campaignId),
                restart: campaignId => director.restart(campaignId),
                retry: () => director.retry(),
                journal: () => director.openJournal(),
                replay: (campaignId, cinematicId) => director.replayCinematic(
                    campaignId,
                    cinematicId,
                ),
                recover: () => director.recoverSave(),
                exit: () => director.exit(),
                cancel: () => view.closeTransient('menu-cancel'),
            });
            return result;
        },

        // Development only: put an item in the active run's inventory (the
        // sidearm has no pickup in the story yet). Persists and re-renders.
        debugGrantItem(itemId, count = 1) {
            if (!activeDefinition || !activeRun) return false;
            const id = String(itemId || '').trim();
            if (!id || !(activeDefinition.inventoryItems || []).some(item => item.id === id)) return false;
            activeRun.inventory = { ...(activeRun.inventory || {}), [id]: (Number(activeRun.inventory?.[id]) || 0) + Math.max(1, Math.trunc(count) || 1) };
            persistRun();
            renderObjective();
            return true;
        },

        openJournal() {
            if (replayState || !activeDefinition || !activeRun) return false;
            const scene = campaignScene(activeDefinition, activeRun.currentSceneId);
            const entries = campaignJournalEntries(activeDefinition, activeRun);
            const snapshot = activeSession?.snapshotInteraction?.();
            view.showJournal({
                entries, objective: currentCampaignObjective(activeDefinition, activeRun),
                presentableIds: entries.filter(entry => canPresentJournalItem(entry, scene, activeRun, snapshot))
                    .map(entry => entry.itemId),
                present: async (itemId) => {
                    if (replayState || activeRun?.currentSceneId !== scene?.id) return false;
                    const entry = entries.find(item => item.itemId === itemId);
                    if (!canPresentJournalItem(entry, scene, activeRun, activeSession?.snapshotInteraction?.())) return false;
                    view.closeTransient('journal-present');
                    await queueEvent({ type: 'item:presented', itemId });
                    return true;
                },
            });
            return true;
        },

        async start(campaignId) {
            freeRoamDetached = false;
            if (replayState) { ++sceneGeneration; await cancelReplay('start'); }
            const definition = definitionFor(campaignId);
            activeDefinition = definition;
            const started = startCampaignRun(definition, { timestamp: nowTimestamp(clock) });
            activeRun = started.run;
            persistRun();
            await applyEffects(started.effects);
            return activeRun;
        },

        async startCheckpoint(campaignId, checkpointId, state = {}) {
            freeRoamDetached = false;
            if (replayState) { ++sceneGeneration; await cancelReplay('checkpoint'); }
            const definition = definitionFor(campaignId);
            // The host rewrites its URL to the checkpoint the player just
            // earned, so a reload arrives here as a checkpoint link. The
            // canonical seed stands in for the state AT that checkpoint; the
            // player's own saved run at the same checkpoint is that state,
            // with its start time, choices and unlocks intact. Only a link to
            // a checkpoint the save is not at is an explicit checkpoint test.
            if (savedRunAtCheckpoint(definition, checkpointId)) return director.continue(campaignId);
            activeDefinition = definition;
            const started = startCampaignRunAtCheckpoint(
                definition,
                checkpointId,
                { state, timestamp: nowTimestamp(clock) },
            );
            activeRun = started.run;
            persistRun();
            const opened = await applyEffects(started.effects);
            // A link into a chase must arm the chase, the same as a resume.
            if (opened) await applyResumeEffects(campaignScene(definition, activeRun.currentSceneId));
            return activeRun;
        },

        async continue(campaignId) {
            if (replayState) { ++sceneGeneration; await cancelReplay('continue'); }
            const definition = definitionFor(campaignId);
            if (activeDefinition?.id === campaignId && activeRun && activeSession) {
                view.closeTransient('resume');
                if (activeRun.completed) await freeRoam();
                else renderObjective(false);
                return activeRun;
            }
            const result = store.read();
            if (!result.ok) {
                director.openMenu();
                return null;
            }
            const saved = result.document.runs[campaignId];
            if (!saved) return director.start(campaignId);
            if (Number(saved.campaignVersion) !== Number(definition.version)) {
                // No migration exists across content versions. Tell the player
                // and return to the menu, which offers Restart for such a save.
                view.showToast('', { key: 'campaign.saveOutdated' });
                director.openMenu();
                return null;
            }
            activeDefinition = definition;
            activeRun = saved.completed === true ? saved : restoreCampaignCheckpoint(saved, nowTimestamp(clock));
            persistRun();
            // A finished run has nothing left to continue into: rehydrating its
            // epilogue would replay a conversation the player already spent and
            // leave an objective card with no objective. Reopen the final
            // world as free roam — the transformed city is the reward.
            if (saved.completed === true) {
                if (await openScene(activeRun.currentSceneId)) {
                    await freeRoam();
                }
                return activeRun;
            }
            if (await openScene(activeRun.currentSceneId)) await rehydrateScene();
            return activeRun;
        },

        async restart(campaignId) {
            freeRoamDetached = false;
            const definition = definitionFor(campaignId);
            ++sceneGeneration;
            await cancelReplay('restart');
            await closeScene('restart');
            const document = store.removeRun(definition.id);
            notifyWorldEffects(document);
            return director.start(definition.id);
        },

        // Retrying a chase used to close the session and open it again, which
        // re-downloads the whole campaign world pack for a failure that changed
        // nothing about the world. Ask the live session to relocate to the
        // checkpoint first; only a missing session or a world it cannot reuse
        // pays for a reload.
        async retry() {
            if (replayState) { ++sceneGeneration; await cancelReplay('retry'); }
            if (!activeRun || !activeDefinition) return null;
            const restored = restoreCampaignCheckpoint(activeRun, nowTimestamp(clock));
            const scene = campaignScene(activeDefinition, restored.currentSceneId);
            if (scene && activeSession?.transitionTo) {
                const generation = ++sceneGeneration;
                let reused = false;
                try {
                    reused = await activeSession.transitionTo({
                        definition: activeDefinition,
                        run: restored,
                        scene,
                        reason: 'retry',
                        emit: event => queueEvent(event),
                    });
                } catch (error) {
                    console.error('[campaign] in-place retry failed', error);
                    reused = false;
                }
                if (generation !== sceneGeneration) return activeRun;
                if (reused) {
                    activeRun = restored;
                    persistRun();
                    view.closeTransient('retry');
                    renderObjective(true);
                    await rehydrateScene();
                    return activeRun;
                }
            }
            ++sceneGeneration;
            await closeScene('retry');
            activeRun = restored;
            persistRun();
            if (await openScene(activeRun.currentSceneId)) await rehydrateScene();
            return activeRun;
        },

        async exit() {
            ++sceneGeneration;
            await cancelReplay('campaign-exit');
            await closeScene('campaign-exit');
            view.hideLoading('campaign-exit');
            view.hideObjective();
            activeDefinition = null;
            activeRun = null;
            view.closeTransient('campaign-exit');
            onStateChanged(null);
        },

        dispatch: queueEvent,

        snapshot(campaignId = activeDefinition?.id) {
            if (activeDefinition?.id === campaignId && activeRun) {
                return JSON.parse(JSON.stringify(activeRun));
            }
            const result = store.read();
            return result.ok && result.document.runs[campaignId]
                ? JSON.parse(JSON.stringify(result.document.runs[campaignId]))
                : null;
        },

        async replayCinematic(campaignId, cinematicId) {
            if (replayState) return false;
            const definition = definitionFor(campaignId);
            const result = store.read();
            if (!result.ok) return false;
            const unlocked = result.document.cinematicUnlocks[campaignId] || [];
            if (!unlocked.includes(cinematicId)) return false;
            const cinematic = campaignAsset(definition, 'cinematics', cinematicId);
            const replayScene = campaignScene(definition, cinematic?.replaySceneId);
            if (!cinematic || !replayScene || !adapters[replayScene.adapter]?.open) return false;
            await eventQueue;
            if (replayState) return false;
            if (activeSession?.canReplayInPlace?.({ definition, scene: replayScene, cinematic })) {
                const previousSession = activeSession;
                const snapshot = previousSession.snapshotCheckpoint?.()
                    || previousSession.snapshotInteraction?.() || null;
                const paused = snapshot?.paused === true;
                // The retained session's event lease belongs to this generation.
                const generation = sceneGeneration;
                const replay = { abort: new AbortController(), session: null, cancelled: false, restoring: null };
                replayState = replay;
                const current = () => replayState === replay && !replay.cancelled && generation === sceneGeneration;
                const restore = () => {
                    if (!current()) return Promise.resolve();
                    if (replay.restoring) return replay.restoring;
                    replay.restoring = (async () => {
                        notifyWorldEffects();
                        // onClose runs inside the overlay teardown. Let it
                        // release its lease before restoring the menu.
                        await Promise.resolve();
                        if (!current()) return;
                        await previousSession.restoreRuntimeSnapshot?.(snapshot);
                        if (!current()) return;
                        replayState = null;
                        renderObjective(false);
                        if (paused) director.openMenu();
                    })();
                    return replay.restoring;
                };
                view.hideObjective();
                try {
                    view.startCinematic({ definition, scene: replayScene, cinematic, replay: true,
                        onClose: restore, onComplete: noop, onSkip: noop });
                    return true;
                } catch (error) {
                    await restore();
                    console.error('[campaign] in-place gallery failed', error);
                    view.showToast('', { key: 'campaign.galleryUnavailable' });
                    return false;
                }
            }
            const previous = {
                definition: activeDefinition,
                run: activeRun,
                scene: activeDefinition && campaignScene(activeDefinition, activeRun?.currentSceneId),
                snapshot: activeSession?.snapshotCheckpoint?.() || null,
            };
            const generation = ++sceneGeneration;
            const replay = { abort: new AbortController(), session: null, cancelled: false, restoring: null };
            replayState = replay;
            const current = () => !replay.cancelled && generation === sceneGeneration;
            view.showLoading({ definition, scene: replayScene });
            await closeScene('gallery-replay');
            view.hideObjective();
            if (!current()) return false;

            const restore = () => {
                if (!current()) return Promise.resolve();
                if (replay.restoring) return replay.restoring;
                replay.restoring = (async () => {
                    replay.abort.abort('replay-closed');
                    await replay.session?.close?.({ reason: 'replay-closed' });
                    if (!current()) return;
                    notifyWorldEffects();
                    if (previous.scene) {
                        view.showLoading({ definition: previous.definition, scene: previous.scene });
                        sceneAbortController = new AbortController();
                        let session;
                        try {
                            session = await adapters[previous.scene.adapter].open({
                                definition: previous.definition, run: previous.run, scene: previous.scene,
                                restoreSnapshot: previous.snapshot, signal: sceneAbortController.signal,
                                emit: event => { if (current() && !replayState) queueEvent(event); },
                            });
                            if (!current()) { await session?.close?.({ reason: 'superseded' }); return; }
                            // Only runtime setup belongs here. Conversations,
                            // checkpoint commits and story effects must not replay.
                            const setup = [
                                ...(previous.scene.onEnter || []),
                                ...(previous.scene.resumeEffects || [])
                                    .filter(entry => evaluateCampaignCondition(entry.when, { run: previous.run }))
                                    .flatMap(entry => entry.effects || []),
                            ];
                            for (const effect of setup.filter(effect => effect.type.startsWith('actor.')
                                || effect.type.startsWith('rail-vehicle.'))) {
                                await session?.handleEffect?.(effect, { definition: previous.definition, scene: previous.scene, run: previous.run });
                            }
                            await session?.restoreRuntimeSnapshot?.(previous.snapshot);
                            if (!current()) { await session?.close?.({ reason: 'superseded' }); return; }
                            activeSession = session;
                        } catch (error) {
                            await session?.close?.({ reason: 'restore-failed' });
                            if (!current()) return;
                            view.hideLoading('gallery-restore-failed');
                            replay.restoring = null;
                            view.showFailure({ reason: 'scene-open-failed', error,
                                retry: () => restore(), exit: () => director.exit() });
                            return;
                        }
                    }
                    replayState = null;
                    view.hideLoading('gallery-restored');
                    if (previous.scene) {
                        if (previous.run.completed) view.hideObjective();
                        else renderObjective(false);
                    }
                    if (!previous.scene || previous.snapshot?.paused) director.openMenu();
                })();
                return replay.restoring;
            };
            try {
                const replayRun = startCampaignRunAtCheckpoint(definition, replayScene.checkpoint.id).run;
                replay.session = await adapters[replayScene.adapter].open({
                    definition, scene: replayScene, run: replayRun,
                    signal: replay.abort.signal, emit: noop,
                    restoreSnapshot: cinematic.replayPose ? { pose: cinematic.replayPose } : null,
                });
                if (!current()) {
                    await replay.session?.close?.({ reason: 'superseded' });
                    return false;
                }
                for (const effect of [...(replayScene.onEnter || []), ...(cinematic.replayEffects || [])]) {
                    if (effect.type.startsWith('actor.') || effect.type.startsWith('rail-vehicle.')) {
                        await replay.session?.handleEffect?.(effect, { definition, scene: replayScene, run: replayRun });
                    }
                }
                if (!current()) return false;
                view.startCinematic({ definition, scene: replayScene, cinematic, replay: true,
                    onClose: restore, onComplete: noop, onSkip: noop });
                view.hideLoading('gallery-ready');
                return true;
            } catch (error) {
                if (!current()) return false;
                console.error('[campaign] gallery scene failed', error);
                await restore();
                view.showToast('', { key: 'campaign.galleryUnavailable' });
                return false;
            }
        },

        recoverSave() {
            const document = store.recover();
            notifyWorldEffects(document);
            return document;
        },

        active() {
            return activeDefinition && activeRun
                ? { definition: activeDefinition, run: activeRun, session: activeSession }
                : null;
        },
    };

    return director;
}
