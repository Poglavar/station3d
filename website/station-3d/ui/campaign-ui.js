// Owns campaign menu, objective, dialogue, cinematic, and failure overlays.
// It emits callbacks but never changes campaign state or runs its own loop.

import {
    advanceConversation,
    createConversationState,
    currentConversationBeat,
} from '../core/campaign-conversation.js';
import {
    CINEMATIC_FADE_IN_MS,
    cinematicSubjectFromPose,
    finishCinematic,
    resolveRelativeCinematicCamera,
    sampleCinematic,
    sampleCinematicPresentation,
} from '../core/campaign-cinematics.js';
import {
    campaignDialogueCutOpacity,
    campaignDialogueShot,
    campaignDialogueSpeakerPlacement,
} from '../core/campaign-dialogue-staging.js';
import { createControlLeaseManager } from '../core/control-lease.js';
import { campaignRunSummary, formatCampaignDuration } from '../core/campaign-summary.js';
import { evaluateCampaignCondition } from '../core/campaign-conditions.js';
import { escapeHtml } from '../core/text.js';
import { getLang, onLangChange, t } from '../core/i18n.js';
import { campaignSceneLoadingHeading } from '../core/campaign-feature.js';
import { dropLoadingCurtain, raiseLoadingCurtain, setLoadingCurtainProgress } from './loading-curtain.js';
import { campaignPackFraction } from '../core/loading-progress.js';
import { campaignSpeechPlan } from '../core/campaign-voice.js';
import { campaignDialoguePauseElapsed } from '../core/campaign-dialogue-timing.js';

// Chrome fills speechSynthesis.getVoices() asynchronously and returns [] until
// then. Touching the list at load and again on 'voiceschanged' means the first
// spoken line already sees the installed Croatian voice instead of none.
const earlySynthesis = globalThis.window?.speechSynthesis;
earlySynthesis?.getVoices?.();
earlySynthesis?.addEventListener?.('voiceschanged', () => earlySynthesis.getVoices());
import {
    CAMPAIGN_ACTOR_SPEAKING_EVENT,
    CAMPAIGN_ACTOR_ATTENTION_EVENT,
    MAX_SPEAKING_S,
    campaignPresentationDeltaSeconds,
    speakingEventDetail,
    speakingSeconds,
} from '../core/campaign-speaking.js';
import {
    createFailurePresentationDelay,
    MAX_FAILURE_PRESENTATION_DELAY_MS,
} from '../core/campaign-failure-presentation.js';
import {
    isAudioMuted,
    registerAudioElement,
    setAudioDucked,
} from '../core/audio-unlock.js';
import { actorPortraitSource } from '../core/campaign-portrait.js';
import { dialogueRevealDurationMs, revealedDialogueText } from '../core/campaign-dialogue-reveal.js';
import { station3dAssetUrl } from '../core/asset-url.js';
import { containerEl, modalEl, showModal } from './modal.js';
import { playCampaignCinematicScore } from './campaign-cinematic-score.js';
import { formatCaptionText } from '../core/campaign-cinematics.js';
import { sampleCinematicNewspaper } from '../core/campaign-newspapers.js';
import { createCinematicNewspaper } from './campaign-newspaper.js';
import { createCinematicReadoutClock } from '../core/campaign-cinematic-readout.js';
import { playCampaignChapterTransitionSound } from './campaign-transition-sfx.js';
import { showCabToast, setHudTopClearance } from './hud.js';
import { setGuideHost } from './minimap.js';
import { setCampaignInteractionAvailable } from './walk-controls.js';
import { controlsHintKeyFor } from '../core/controls-hint.js';

let overlayEl = null;
let objectiveEl = null;
let interactionEl = null;
let spokenCaptionEl = null;
let activeRender = null;
let cinematicState = null;
let conversationStageState = null;
let pauseSession = () => {};
let resumeSession = () => {};
let clearInput = () => {};
let activeVoiceAudio = null;
let activeUtterance = null;
let lastObjectiveInput = null;
let lastMotionProgress = null;
let lastInteraction = null;
let lastControllerId = 'foot';
let lastControlsHintKey = '';
let objectiveLayoutObserver = null;
let observedRouteEl = null;
let objectiveHeightPx = 0;
let routeHeightPx = 0;
let chapterTransitionEl = null;
let presentedChapterKey = null;
let confirmingRestartId = null;
let confirmingExitId = null;
let presentationRevealEl = null;
let presentationRevealAnimation = null;
let failurePresentationDelay = null;

const leases = createControlLeaseManager({
    pause: () => pauseSession(),
    resume: () => resumeSession(),
    clearInput: () => clearInput(),
});

function localized(value) {
    if (typeof value === 'string') return value;
    return value?.[getLang()] || value?.en || value?.hr || '';
}

function conversationBeatText(beat, run) {
    const variant = (beat?.variants || []).find(item => (
        evaluateCampaignCondition(item.when, { run, event: {} })
    ));
    return localized(variant?.text || beat?.text);
}

// The card and the minimap share the top-left corner; this lets the stylesheet
// move the map down for exactly as long as a campaign objective is on screen.
function markObjectiveVisible(visible) {
    containerEl?.classList?.toggle('has-campaign-objective', !!visible);
}

function ensureUi() {
    if (!containerEl) return false;
    if (!objectiveEl) {
        objectiveEl = document.createElement('aside');
        objectiveEl.className = 'station-3d-campaign-objective hidden';
        objectiveEl.setAttribute('aria-live', 'polite');
        containerEl.appendChild(objectiveEl);
        objectiveLayoutObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const height = entry.borderBoxSize[0]?.blockSize;
                if (!Number.isFinite(height)) continue;
                if (entry.target === objectiveEl) objectiveHeightPx = height;
                else if (entry.target === observedRouteEl) routeHeightPx = height;
            }
            setHudTopClearance(objectiveHeightPx, routeHeightPx);
        });
        objectiveLayoutObserver.observe(objectiveEl, { box: 'border-box' });
    }
    if (!overlayEl) {
        overlayEl = document.createElement('section');
        overlayEl.className = 'station-3d-campaign-overlay hidden';
        overlayEl.setAttribute('aria-live', 'polite');
        containerEl.appendChild(overlayEl);
    }
    if (!interactionEl) {
        interactionEl = document.createElement('div');
        interactionEl.className = 'station-3d-campaign-interaction hidden';
        containerEl.appendChild(interactionEl);
    }
    if (!spokenCaptionEl) {
        spokenCaptionEl = document.createElement('div');
        spokenCaptionEl.className = 'station-3d-campaign-spoken-caption hidden';
        spokenCaptionEl.setAttribute('aria-live', 'assertive');
        spokenCaptionEl.setAttribute('role', 'status');
        const cue = document.createElement('span');
        cue.className = 'station-3d-campaign-spoken-caption-cue';
        const line = document.createElement('span');
        line.className = 'station-3d-campaign-spoken-caption-line';
        spokenCaptionEl.append(cue, line);
        spokenCaptionEl.addEventListener('animationend', (event) => {
            if (event.animationName !== 'station-3d-campaign-spoken-caption') return;
            spokenCaptionEl.classList.add('hidden');
            spokenCaptionEl.classList.remove('is-visible');
        });
        containerEl.appendChild(spokenCaptionEl);
    }
    return true;
}

function showSpokenCaption(text, options = {}) {
    if (!ensureUi() || !spokenCaptionEl) return;
    const cue = spokenCaptionEl.querySelector('.station-3d-campaign-spoken-caption-cue');
    const line = spokenCaptionEl.querySelector('.station-3d-campaign-spoken-caption-line');
    const label = localized(options.captionLabel);
    if (cue) {
        cue.textContent = label || 'CC';
        cue.classList.toggle('is-generic', !label);
    }
    if (line) line.textContent = text;
    const durationMs = Math.max(1000, Number(options.durationMs) || 3600);
    spokenCaptionEl.style.setProperty('--campaign-spoken-caption-duration', `${durationMs}ms`);
    // Restart the CSS-only lifetime without adding a second simulation timer.
    spokenCaptionEl.classList.remove('is-visible');
    void spokenCaptionEl.offsetWidth;
    spokenCaptionEl.classList.remove('hidden');
    spokenCaptionEl.classList.add('is-visible');
}

function releaseLease() {
    leases.cancel();
}

function stopVoice() {
    if (activeVoiceAudio) {
        activeVoiceAudio.pause();
        activeVoiceAudio.currentTime = 0;
        activeVoiceAudio = null;
    }
    activeUtterance = null;
    window.speechSynthesis?.cancel?.();
}

function clearPresentationReveal() {
    presentationRevealAnimation?.cancel?.();
    presentationRevealAnimation = null;
    presentationRevealEl?.remove();
    presentationRevealEl = null;
}

function markCinematicPresentation(active) {
    const enabled = !!active;
    const changed = containerEl?.classList?.contains('has-campaign-cinematic') !== enabled;
    containerEl?.classList?.toggle('has-campaign-cinematic', enabled);
    modalEl?.classList?.toggle('has-campaign-cinematic', enabled);
    document.body?.classList?.toggle('station3d-cinematic-active', enabled);
    if (changed) window.dispatchEvent(new Event('resize'));
}

function markDialoguePresentation(active) {
    const enabled = !!active;
    const changed = containerEl?.classList?.contains('has-campaign-dialogue') !== enabled;
    containerEl?.classList?.toggle('has-campaign-dialogue', enabled);
    modalEl?.classList?.toggle('has-campaign-dialogue', enabled);
    document.body?.classList?.toggle('station3d-dialogue-active', enabled);
    if (changed) window.dispatchEvent(new Event('resize'));
}

function revealGameplayAfterPresentation({
    reducedMotion = false,
    durationMs = 720,
    className,
} = {}) {
    clearPresentationReveal();
    if (!modalEl || reducedMotion) return;
    const veil = document.createElement('div');
    veil.className = className;
    veil.setAttribute('aria-hidden', 'true');
    modalEl.appendChild(veil);
    presentationRevealEl = veil;
    try {
        const animation = veil.animate(
            [{ opacity: 1 }, { opacity: 0 }],
            {
                duration: durationMs,
                easing: 'cubic-bezier(0.22, 0.72, 0.2, 1)',
                fill: 'forwards',
            },
        );
        presentationRevealAnimation = animation;
        animation.finished.catch(() => {}).finally(() => {
            if (presentationRevealAnimation !== animation) return;
            clearPresentationReveal();
        });
    } catch (_) {
        clearPresentationReveal();
    }
}

function revealGameplayAfterCinematic({ reducedMotion = false, skipped = false } = {}) {
    revealGameplayAfterPresentation({
        reducedMotion,
        durationMs: skipped ? 360 : 720,
        className: 'station-3d-campaign-cinematic-reveal',
    });
}

function revealGameplayAfterDialogue({ reducedMotion = false } = {}) {
    revealGameplayAfterPresentation({
        reducedMotion,
        durationMs: 320,
        className: 'station-3d-campaign-dialogue-reveal',
    });
}

// Tells the world which actor is mouthing a beat, for how long and in what mood.
function announceSpeaking(actorId, seconds, mood = null) {
    const detail = speakingEventDetail({ actorId, seconds, mood });
    if (!detail) return;
    window.dispatchEvent(new CustomEvent(CAMPAIGN_ACTOR_SPEAKING_EVENT, { detail }));
}

// Returns true when a voice is playing; `onEnd` fires once it finishes on
// its own, never for a voice cut off by the next beat.
// The recorded voice-over, resolved by speaker and text hash from the generated
// manifest (see core/campaign-voice-clips.js). Installed by the campaign
// bootstrap once the manifest has loaded; until then every line is synthesised.
let voiceClipIndex = null;

function setVoiceClips(index) {
    voiceClipIndex = index && typeof index.resolve === 'function' ? index : null;
}

function playAudioSource(source, onEnd) {
    const audio = registerAudioElement(new Audio(source));
    activeVoiceAudio = audio;
    const finish = (completed) => {
        if (activeVoiceAudio !== audio) return;
        activeVoiceAudio = null;
        audio.onended = null;
        audio.onerror = null;
        onEnd({ completed });
    };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    audio.play().catch(() => finish(false));
    return true;
}

function playVoice(beat, spokenText = null, actor = null, onEnd = () => {}) {
    stopVoice();
    const voice = { ...(actor?.voice || {}), ...(beat?.voice || {}) };
    if (!voice) return false;
    const source = localized(voice.src || voice.sources);
    if (source) return playAudioSource(source, onEnd);
    // A recorded take of exactly this text wins over synthesis. `recorded`
    // lines (cinematic narration) have no synthesis fallback: silence rather
    // than a robot reading the caption.
    if (voice.speech === true || voice.recorded === true) {
        const clip = voiceClipIndex?.resolve({
            text: spokenText || localized(beat?.text),
            speakerId: actor?.id || beat?.speakerId || null,
        });
        if (clip) return playAudioSource(clip.url, onEnd);
    }
    if (voice.speech !== true || isAudioMuted()
        || typeof window.SpeechSynthesisUtterance !== 'function') return false;
    const synthesis = window.speechSynthesis;
    const plan = campaignSpeechPlan({
        profile: voice.profile,
        language: getLang(),
        voices: synthesis?.getVoices?.() || [],
    });
    const utterance = new SpeechSynthesisUtterance(spokenText || localized(beat.text));
    utterance.lang = plan.lang;
    utterance.rate = plan.rate;
    utterance.pitch = plan.pitch;
    if (plan.voice) utterance.voice = plan.voice;
    activeUtterance = utterance;
    utterance.onend = () => {
        if (activeUtterance === utterance) onEnd();
    };
    utterance.onerror = utterance.onend;
    window.speechSynthesis?.speak?.(utterance);
    return true;
}

function closeOverlay(reason = 'close') {
    failurePresentationDelay?.cancel?.();
    failurePresentationDelay = null;
    stopVoice();
    if (conversationStageState) {
        const closingConversation = conversationStageState;
        conversationStageState = null;
        closingConversation.setFrameHandler?.(null);
        setAudioDucked(false);
        markDialoguePresentation(false);
    }
    if (cinematicState) {
        const closingCinematic = cinematicState;
        cinematicState = null;
        closingCinematic.setFrameHandler?.(null);
        closingCinematic.score?.stop?.({
            fadeSeconds: reason === 'cinematic-complete' ? 0.9 : 0.35,
        });
        markCinematicPresentation(false);
        closingCinematic.onClose?.();
    }
    if (overlayEl) {
        overlayEl.classList.add('hidden');
        overlayEl.replaceChildren();
        delete overlayEl.dataset.kind;
        delete overlayEl.dataset.framing;
        delete overlayEl.dataset.shot;
        delete overlayEl.dataset.newspapers;
    }
    activeRender = null;
    releaseLease();
    window.dispatchEvent(new CustomEvent('station3d:campaign-overlay-closed', {
        detail: { reason },
    }));
}

function openOverlay(kind) {
    if (!ensureUi()) return false;
    // Every campaign overlay lives inside the Station3D modal, and a scene that
    // failed to open has already closed its session — which hides that modal.
    // Without this the failure card would be rendered into a display:none tree
    // and the player would be dropped back onto the map with no explanation.
    if (modalEl?.classList?.contains('hidden')) showModal();
    closeOverlay('replace');
    leases.acquire(kind);
    overlayEl.dataset.kind = kind;
    overlayEl.classList.remove('hidden');
    return true;
}

function button(label, action, { primary = false, danger = false, disabled = false } = {}) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = [
        'station-3d-campaign-action',
        primary ? 'is-primary' : '',
        danger ? 'is-danger' : '',
    ].filter(Boolean).join(' ');
    element.textContent = label;
    element.disabled = disabled;
    element.addEventListener('click', action);
    return element;
}

function panel(eyebrow, title, body = '') {
    const card = document.createElement('div');
    card.className = 'station-3d-campaign-card';
    card.innerHTML = [
        eyebrow ? `<div class="station-3d-campaign-eyebrow">${escapeHtml(eyebrow)}</div>` : '',
        `<h2>${escapeHtml(title)}</h2>`,
        body ? `<p>${escapeHtml(body)}</p>` : '',
    ].join('');
    overlayEl.appendChild(card);
    return card;
}

function actionRow(card) {
    const row = document.createElement('div');
    row.className = 'station-3d-campaign-actions';
    card.appendChild(row);
    return row;
}

function finiteCssColor(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 0xffffff) return null;
    return `#${number.toString(16).padStart(6, '0')}`;
}

function addActorPortrait(card, actor, speaker, mood = null) {
    if (!actor) return;
    const portraitSource = localized(actorPortraitSource(actor, mood));
    let portrait;
    if (portraitSource) {
        portrait = document.createElement('img');
        portrait.src = station3dAssetUrl(portraitSource.replace(/^station-3d\//, ''));
        portrait.alt = speaker;
        portrait.classList.add('is-image');
    } else {
        portrait = document.createElement('div');
        portrait.setAttribute('role', 'img');
        portrait.setAttribute('aria-label', speaker);
        portrait.textContent = actor.kind === 'female' ? '●' : '◆';
        const color = finiteCssColor(actor.appearance?.bodyColor);
        if (color) portrait.style.setProperty('--campaign-portrait-color', color);
    }
    portrait.classList.add('station-3d-campaign-portrait');
    card.prepend(portrait);
}

export function configureCampaignUi({ pause, resume, clear, setFrameHandler } = {}) {
    pauseSession = typeof pause === 'function' ? pause : () => {};
    resumeSession = typeof resume === 'function' ? resume : () => {};
    clearInput = typeof clear === 'function' ? clear : () => {};
    campaignUi.setFrameHandler = typeof setFrameHandler === 'function'
        ? setFrameHandler
        : () => false;
}

function showMenu(input) {
    if (!openOverlay('menu')) return;
    confirmingRestartId = null;
    confirmingExitId = null;
    const render = () => {
        overlayEl.replaceChildren();
        // With one campaign the wrapper's own summary just repeated the card
        // below it — and the two came from different strings, so in Croatian the
        // menu said the same thing twice in two different wordings.
        const card = panel(
            t('campaign.menu.eyebrow'),
            t('campaign.menu.title'),
            input.corruptError ? t('campaign.saveCorrupt') : '',
        );
        if (input.corruptError) {
            const row = actionRow(card);
            row.appendChild(button(t('campaign.recoverSave'), () => {
                input.recover();
                closeOverlay('save-recovered');
                input.cancel?.();
            }, { danger: true }));
            row.appendChild(button(t('campaign.cancel'), () => closeOverlay('cancel')));
            return;
        }
        for (const definition of input.definitions || []) {
            const run = input.document?.runs?.[definition.id] || null;
            if (confirmingRestartId === definition.id) {
                const confirmCard = document.createElement('article');
                confirmCard.className = 'station-3d-campaign-menu-item';
                confirmCard.innerHTML = [
                    `<h3>${escapeHtml(localized(definition.metadata.title))}</h3>`,
                    `<p>${escapeHtml(t('campaign.restartConfirm'))}</p>`,
                ].join('');
                const confirmRow = actionRow(confirmCard);
                confirmRow.appendChild(button(t('campaign.restart'), async () => {
                    confirmingRestartId = null;
                    closeOverlay('restart');
                    await input.restart(definition.id);
                }, { danger: true }));
                confirmRow.appendChild(button(t('campaign.cancel'), () => {
                    confirmingRestartId = null;
                    render();
                }));
                card.appendChild(confirmCard);
                continue;
            }
            if (confirmingExitId === definition.id) {
                // Exiting ends the run and returns to the map, so the card
                // asks the way it asks before a restart.
                const confirmCard = document.createElement('article');
                confirmCard.className = 'station-3d-campaign-menu-item';
                confirmCard.innerHTML = [
                    `<h3>${escapeHtml(localized(definition.metadata.title))}</h3>`,
                    `<p>${escapeHtml(t('campaign.exitConfirm'))}</p>`,
                ].join('');
                const confirmRow = actionRow(confirmCard);
                confirmRow.appendChild(button(t('campaign.exit'), async () => {
                    confirmingExitId = null;
                    closeOverlay('exit');
                    await input.exit();
                }, { danger: true }));
                confirmRow.appendChild(button(t('campaign.cancel'), () => {
                    confirmingExitId = null;
                    render();
                }));
                card.appendChild(confirmCard);
                continue;
            }
            const campaign = document.createElement('article');
            campaign.className = 'station-3d-campaign-menu-item';
            campaign.innerHTML = [
                `<h3>${escapeHtml(localized(definition.metadata.title))}</h3>`,
                `<p>${escapeHtml(localized(definition.metadata.summary))}</p>`,
            ].join('');
            const row = actionRow(campaign);
            // A content update that bumps the campaign version cannot restore
            // an older run; say so here instead of failing behind the button.
            const outdated = !!run && Number(run.campaignVersion) !== Number(definition.version);
            if (outdated) {
                const notice = document.createElement('p');
                notice.className = 'station-3d-campaign-menu-notice';
                notice.textContent = t('campaign.saveOutdated');
                campaign.appendChild(notice);
            }
            if (run) {
                // A finished run has no next objective: Continue would restore
                // the epilogue checkpoint and replay a spent conversation. The
                // same button reopens that final world as free roam instead.
                const completed = run.completed === true;
                if (!outdated) row.appendChild(button(
                    t(completed ? 'campaign.menu.freeRoam' : 'campaign.continue'),
                    async () => {
                        closeOverlay('continue');
                        await input.continue(definition.id);
                    },
                    { primary: true },
                ));
                if (!outdated && !completed && input.activeCampaignId === definition.id) {
                    const retry = button(t('campaign.retry'), async () => {
                        closeOverlay('retry');
                        await input.retry();
                    });
                    retry.title = t('campaign.retryHint');
                    row.appendChild(retry);
                    const hint = document.createElement('p');
                    hint.className = 'station-3d-campaign-menu-notice';
                    hint.textContent = t('campaign.retryHint');
                    campaign.appendChild(hint);
                }
                row.appendChild(button(t('campaign.restart'), () => {
                    // A native confirm() is unstyled, unlocalised beyond its one
                    // string, and blocks the page. The overlay already owns this
                    // conversation, so it asks here.
                    confirmingRestartId = definition.id;
                    render();
                }, { danger: true }));
                if (input.activeCampaignId === definition.id) {
                    row.appendChild(button(t('campaign.journal'), input.journal));
                    // Progress saves itself at checkpoints; the player asked
                    // for a save button, so the menu says where they stand.
                    const checkpointScene = (definition.scenes || []).find(scene => scene.checkpoint?.id === run.checkpointId);
                    const autosave = document.createElement('p');
                    autosave.className = 'station-3d-campaign-menu-notice';
                    autosave.textContent = t('campaign.menu.autosave', {
                        checkpoint: localized(checkpointScene?.title) || run.checkpointId || '',
                    });
                    campaign.appendChild(autosave);
                    if (input.exit) {
                        row.appendChild(button(t('campaign.exit'), () => {
                            confirmingExitId = definition.id;
                            render();
                        }, { danger: true }));
                    }
                }
                const unlocked = input.document?.cinematicUnlocks?.[definition.id] || [];
                const gallery = document.createElement('details');
                gallery.className = 'station-3d-campaign-gallery';
                gallery.innerHTML = `<summary>${escapeHtml(t('campaign.cinematics'))}</summary>`;
                for (const cinematic of definition.cinematics || []) {
                    gallery.appendChild(button(localized(cinematic.title), () => {
                        input.replay(definition.id, cinematic.id);
                    }, { disabled: !unlocked.includes(cinematic.id) }));
                }
                campaign.appendChild(gallery);
            } else {
                row.appendChild(button(t('campaign.start'), async () => {
                    closeOverlay('start');
                    await input.start(definition.id);
                }, { primary: true }));
            }
            card.appendChild(campaign);
        }
        // While a restart or an exit is being confirmed the card already
        // offers Cancel; a second identical button underneath it would mean
        // two different things by the same name.
        if (confirmingRestartId || confirmingExitId) return;
        const footer = actionRow(card);
        footer.appendChild(button(t('campaign.cancel'), () => {
            closeOverlay('cancel');
            input.cancel?.();
        }));
    };
    activeRender = render;
    render();
}

function showJournal({ entries, objective, presentableIds = [], present } = {}) {
    if (!openOverlay('journal')) return;
    const card = panel(t('campaign.journal'), t('campaign.journalTitle'), localized(objective?.text));
    const list = document.createElement('div');
    list.className = 'station-3d-campaign-journal';
    for (const entry of [...(entries || [])].reverse()) {
        const note = document.createElement('details');
        note.open = entry === entries[entries.length-1] || presentableIds.includes(entry.itemId);
        const title = document.createElement('summary');
        title.textContent = localized(entry.title);
        const body = document.createElement('p');
        body.textContent = localized(entry.text);
        note.append(title, body);
        if (presentableIds.includes(entry.itemId)) note.appendChild(button(t('campaign.presentPapers'), () => present?.(entry.itemId), { primary: true }));
        list.appendChild(note);
    }
    card.appendChild(list);
    actionRow(card).appendChild(button(t('campaign.continue'), () => closeOverlay('journal-close')));
}

function removeChapterTransition() {
    chapterTransitionEl?.remove();
    chapterTransitionEl = null;
}

function showChapterTransition(scene) {
    if (!ensureUi() || !scene?.chapter) return;
    removeChapterTransition();
    const element = document.createElement('aside');
    element.className = 'station-3d-campaign-chapter-transition';
    element.setAttribute('aria-live', 'polite');
    element.innerHTML = [
        `<span>${escapeHtml(t('campaign.chapter', { n: scene.chapter }))}</span>`,
        '<i aria-hidden="true"></i>',
        `<strong>${escapeHtml(localized(scene.title))}</strong>`,
    ].join('');
    element.addEventListener('animationend', (event) => {
        if (event.target === element) removeChapterTransition();
    }, { once: true });
    containerEl.appendChild(element);
    chapterTransitionEl = element;
    playCampaignChapterTransitionSound();
}

function updateControllerHint() {
    const hint = objectiveEl?.querySelector('.station-3d-campaign-controls-hint');
    // A canopy descent keeps its own key list; on the ground the campaign's
    // foot hint (talk or board) replaces the free-roam one.
    if (hint) hint.textContent = t(lastControlsHintKey === 'walk.parachuteHint' ? lastControlsHintKey
        : lastControllerId === 'foot' ? 'campaign.footControls'
            : (lastControlsHintKey || controlsHintKeyFor(lastControllerId)));
}

function showObjective({ definition, scene, objective, checkpointConfirmed, openJournal }) {
    if (!ensureUi() || !scene) return;
    if (!observedRouteEl) {
        observedRouteEl = containerEl.querySelector('.station-3d-route-overlay');
        if (observedRouteEl) objectiveLayoutObserver.observe(observedRouteEl, { box: 'border-box' });
    }
    if (lastObjectiveInput?.scene?.id !== scene.id
        || lastObjectiveInput?.objective?.progressTimerId !== objective?.progressTimerId) lastMotionProgress = null;
    lastObjectiveInput = { definition, scene, objective, checkpointConfirmed, openJournal };
    objectiveEl.classList.remove('hidden');
    markObjectiveVisible(true);
    modalEl?.classList.toggle('has-campaign-hud', true);
    modalEl?.classList.toggle('has-campaign-encounter', !!scene.authored?.encounter);
    objectiveEl.setAttribute('aria-label', localized(scene.title));
    // One line at the top: the next step, then the two things that explain it.
    const line = document.createElement('div');
    line.className = 'station-3d-campaign-objective-line';
    const instruction = document.createElement('span');
    instruction.className = 'station-3d-campaign-objective-text';
    instruction.textContent = localized(objective?.text || scene.title);
    line.appendChild(instruction);
    objectiveEl.replaceChildren(line);
    // The direction arrow and distance ride inside this line. Floating, they
    // sat between the objective band and the interaction prompt as a third,
    // narrower shape; the line already names the target, so the chip carries
    // only the arrow and the distance.
    setGuideHost(line);
    if (objective?.progressTimerId) {
        const progress = document.createElement('progress');
        progress.className = 'station-3d-campaign-motion-progress';
        progress.max = 1;
        progress.value = lastMotionProgress?.progress || 0;
        progress.setAttribute('aria-label', t('campaign.drivingProgress'));
        const label = document.createElement('small');
        label.className = 'station-3d-campaign-motion-label';
        label.textContent = lastMotionProgress
            ? t('campaign.drivingSeconds', { n: lastMotionProgress.seconds, total: lastMotionProgress.totalSeconds })
            : t('campaign.drivingProgress');
        objectiveEl.append(progress, label);
    }
    if (openJournal) {
        const compact = button('📓', openJournal);
        compact.classList.add('station-3d-campaign-journal-compact');
        compact.setAttribute('aria-label', t('campaign.journal'));
        compact.title = t('campaign.journal');
        line.appendChild(compact);
    }
    // How to move, on the same line and folded away until asked for: on a
    // phone the control list is three lines of keys the player cannot press.
    const controls = document.createElement('div');
    controls.className = 'station-3d-campaign-controls-panel';
    controls.hidden = true;
    const hint = document.createElement('p');
    hint.className = 'station-3d-campaign-controls-hint';
    controls.appendChild(hint);
    const touch = button(t('campaign.touchControls'), () => {
        const shown = !modalEl.classList.contains('show-touch-controls');
        modalEl.classList.toggle('show-touch-controls', shown);
        touch.setAttribute('aria-pressed', String(shown));
    });
    touch.classList.add('station-3d-campaign-touch-toggle');
    touch.setAttribute('aria-pressed', String(modalEl.classList.contains('show-touch-controls')));
    controls.appendChild(touch);
    const movement = button('🕹️', () => {
        controls.hidden = !controls.hidden;
        movement.setAttribute('aria-expanded', String(!controls.hidden));
    });
    movement.classList.add('station-3d-campaign-movement-help');
    movement.setAttribute('aria-label', t('campaign.movementHelp'));
    movement.setAttribute('aria-expanded', 'false');
    movement.title = t('campaign.movementHelp');
    line.appendChild(movement);
    objectiveEl.appendChild(controls);
    updateControllerHint();
    const chapterKey = [
        definition?.id || 'campaign',
        scene.chapter || '',
        scene.authored?.chapterTransitionCue === true ? scene.id : '',
    ].join(':');
    if (checkpointConfirmed && scene.chapter && chapterKey !== presentedChapterKey) {
        presentedChapterKey = chapterKey;
        showChapterTransition(scene);
    }
}

function hideObjective() {
    lastObjectiveInput = null;
    lastMotionProgress = null;
    presentedChapterKey = null;
    removeChapterTransition();
    objectiveEl?.classList.add('hidden');
    markObjectiveVisible(false);
    objectiveHeightPx = 0;
    setHudTopClearance(0);
    modalEl?.classList.remove('has-campaign-hud', 'has-campaign-encounter');
    setGuideHost(null);
    if (objectiveEl) objectiveEl.replaceChildren();
}

function startConversation(input) {
    if (!openOverlay('conversation')) return;
    markDialoguePresentation(true);
    clearPresentationReveal();
    setAudioDucked(true);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const curtain = document.createElement('div');
    curtain.className = 'station-3d-campaign-dialogue-curtain';
    curtain.setAttribute('aria-hidden', 'true');
    let state = createConversationState(input.conversation);
    let lastBeatId = null;
    let beatIndex = -1;
    let speakerId = null;
    let physicalSpeaker = false;
    let cutStartedAt = performance.now();
    let stagedShot = null;
    let pauseStartedAt = cutStartedAt;
    let pauseReady = true;
    let voicePlayedBeatId = null;
    // The line is read at the pace it is spoken, and the player may answer at
    // any moment: answering stops the voice and drops the rest of the line in.
    let reveal = null;
    const applyReveal = (nowMs) => {
        if (!reveal || reveal.done) return;
        // A recorded take sets the true pace from its own clock. Synthesis and
        // silent lines report no duration, so they use the reading estimate.
        const clip = activeVoiceAudio;
        const clipSeconds = clip && Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : null;
        const totalMs = clipSeconds === null ? reveal.totalMs : dialogueRevealDurationMs({ clipSeconds });
        const elapsedMs = clipSeconds === null ? nowMs - reveal.startedAtMs : clip.currentTime * 1000;
        const shown = revealedDialogueText(reveal.text, elapsedMs, totalMs);
        if (reveal.element && reveal.element.textContent !== shown.text) reveal.element.textContent = shown.text;
        reveal.done = shown.done;
    };
    const completeReveal = () => {
        if (!reveal) return;
        if (reveal.element) reveal.element.textContent = reveal.text;
        reveal.done = true;
    };
    const updateFrame = ({ nowMs = performance.now(), pose = null } = {}) => {
        const curtainOpacity = physicalSpeaker
            ? String(campaignDialogueCutOpacity(nowMs - cutStartedAt, { reducedMotion }))
            : '0';
        if (curtain.style.opacity !== curtainOpacity) curtain.style.opacity = curtainOpacity;
        applyReveal(nowMs);
        if (!pauseReady && campaignDialoguePauseElapsed({
            startedAtMs: pauseStartedAt,
            nowMs,
            pauseBeforeMs: currentConversationBeat(input.conversation, state)?.pauseBeforeMs,
        })) {
            pauseReady = true;
            render();
        }
        if (!physicalSpeaker) return null;
        if (!stagedShot) {
            // The conversation lease freezes the player. Resolve each authored
            // shot once on its first frame instead of repeating geo math for the
            // full beat; the frame owner can safely reuse this immutable pose.
            stagedShot = campaignDialogueShot({
                scene: input.scene,
                speakerId,
                playerPose: pose,
                beatIndex,
            });
            if (stagedShot) window.dispatchEvent(new CustomEvent(CAMPAIGN_ACTOR_ATTENTION_EVENT, {
                detail: { actorId: speakerId, pose: stagedShot.position },
            }));
        }
        return stagedShot;
    };
    const render = (overrideText = null) => {
        const beat = currentConversationBeat(input.conversation, state);
        if (!beat) return;
        if (beat.id !== lastBeatId) {
            stopVoice();
            lastBeatId = beat.id;
            beatIndex += 1;
            speakerId = beat.speakerId || null;
            physicalSpeaker = !!campaignDialogueSpeakerPlacement(input.scene, speakerId);
            cutStartedAt = performance.now();
            stagedShot = null;
            pauseStartedAt = cutStartedAt;
            pauseReady = !(Number.isFinite(beat.pauseBeforeMs) && beat.pauseBeforeMs > 0);
            voicePlayedBeatId = null;
        }
        if (!pauseReady) {
            overlayEl.replaceChildren(curtain);
            overlayEl.dataset.framing = physicalSpeaker ? 'speaker' : 'radio';
            overlayEl.dataset.shot = physicalSpeaker ? String(beatIndex + 1) : 'radio';
            // A stage direction is the narrator's aside, never the speaker's
            // line: no name, no portrait, just the italic direction.
            const direction = beat.direction ? localized(beat.direction) : '';
            const card = panel('', direction || '…');
            card.classList.add('station-3d-campaign-dialogue', 'is-stage-direction');
            return;
        }
        overlayEl.replaceChildren(curtain);
        const gamePrompt = !physicalSpeaker && beat.prompt ? localized(beat.prompt) : null;
        overlayEl.dataset.framing = physicalSpeaker ? 'speaker' : (gamePrompt ? 'prompt' : 'radio');
        overlayEl.dataset.shot = physicalSpeaker ? String(beatIndex + 1) : 'radio';
        const actor = (input.definition.actors || []).find(item => item.id === beat.speakerId);
        const speaker = actor ? localized(actor.label) : (gamePrompt || t('campaign.radio'));
        const resolvedText = overrideText
            ? localized(overrideText)
            : conversationBeatText(beat, input.run);
        const card = panel(speaker, resolvedText);
        card.classList.add('station-3d-campaign-dialogue');
        if (beat.direction) {
            const directionEl = document.createElement('p');
            directionEl.className = 'station-3d-campaign-dialogue-direction';
            directionEl.textContent = localized(beat.direction);
            card.insertBefore(directionEl, card.querySelector('h2'));
        }
        addActorPortrait(card, actor, speaker, beat.mood || null);
        const row = actionRow(card);
        if ((beat.responses || []).length > 0) {
            for (const response of beat.responses) {
                row.appendChild(button(localized(response.text), async () => {
                    // Answering interrupts: the actor stops mid-sentence and
                    // the line they were reading lands whole.
                    stopVoice();
                    completeReveal();
                    for (const choice of row.querySelectorAll('button')) choice.disabled = true;
                    const dispatched = await input.onResponse(response);
                    if (dispatched?.run) input.run = dispatched.run;
                    const result = advanceConversation(input.conversation, state, response.id);
                    state = result.state;
                    if (result.rejected) {
                        render(result.rejection);
                    } else if (state.complete) {
                        revealGameplayAfterDialogue({ reducedMotion });
                        closeOverlay('conversation-complete');
                        await input.onComplete();
                    } else render();
                }));
            }
        } else {
            row.appendChild(button(t('campaign.continueBeat'), () => {
                stopVoice();
                completeReveal();
                const result = advanceConversation(input.conversation, state);
                state = result.state;
                if (state.complete) {
                    revealGameplayAfterDialogue({ reducedMotion });
                    closeOverlay('conversation-complete');
                    input.onComplete();
                } else render();
            }, { primary: true }));
        }
        row.querySelector('button')?.focus();
        // Nothing waits for the actor: the answers are live from the first
        // frame, and the line writes itself in beside them at speaking pace.
        const lineEl = card.querySelector('h2');
        const voiced = voicePlayedBeatId === beat.id
            ? false
            : playVoice(beat, resolvedText, actor, () => { announceSpeaking(actor?.id, 0); completeReveal(); });
        reveal = {
            element: lineEl,
            text: resolvedText,
            startedAtMs: performance.now(),
            totalMs: dialogueRevealDurationMs({ text: resolvedText }),
            done: false,
        };
        if (lineEl) lineEl.textContent = '';
        applyReveal(performance.now());
        voicePlayedBeatId = beat.id;
        announceSpeaking(
            actor?.id,
            voiced ? MAX_SPEAKING_S : speakingSeconds(resolvedText),
            beat.mood || null,
        );
    };
    activeRender = render;
    render();
    conversationStageState = { setFrameHandler: campaignUi.setFrameHandler };
    campaignUi.setFrameHandler(updateFrame);
}

function startCinematic(input) {
    if (!openOverlay('cinematic')) return;
    markCinematicPresentation(true);
    clearPresentationReveal();
    const startedAt = performance.now();
    let previousFrameNowMs = startedAt;
    let presentationElapsedMs = 0;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const readoutClock = createCinematicReadoutClock(input.cinematic, { language: getLang(), reducedMotion });
    const curtain = document.createElement('div');
    curtain.className = 'station-3d-campaign-cinematic-curtain';
    curtain.setAttribute('aria-hidden', 'true');
    overlayEl.appendChild(curtain);
    const card = panel('', localized(input.cinematic.title));
    card.classList.add('station-3d-campaign-cinematic');
    const newspapers = input.cinematic.newspapers?.length
        ? createCinematicNewspaper(localized)
        : null;
    if (newspapers) {
        overlayEl.dataset.newspapers = 'true';
        overlayEl.appendChild(newspapers.element);
    }
    let artwork = null;
    if (input.cinematic.artwork) {
        artwork = document.createElement('figure');
        artwork.className = 'station-3d-campaign-cinematic-artwork';
        if (input.cinematic.artwork.effect === 'shimmer') {
            artwork.classList.add('has-shimmer');
        }
        const image = document.createElement('img');
        image.src = station3dAssetUrl(localized(input.cinematic.artwork.src).replace(/^station-3d\//, ''));
        image.alt = localized(input.cinematic.artwork.alt);
        image.decoding = 'async';
        artwork.appendChild(image);
        overlayEl.appendChild(artwork);
    }
    const caption = document.createElement('p');
    caption.className = 'station-3d-campaign-caption';
    caption.setAttribute('aria-live', 'polite');
    card.appendChild(caption);
    const progress = document.createElement('progress');
    progress.max = 1;
    progress.value = 0;
    card.appendChild(progress);
    const row = actionRow(card);
    const skip = button(t('campaign.skip'), () => finish(true), { primary: true });
    skip.disabled = true;
    row.appendChild(skip);
    if (input.replay) row.appendChild(button(t('campaign.close'), () => finish(true)));
    let lastWorldEffects = null;
    let lastReadoutCue = null;
    let ownState = null;
    const updateFrame = ({ nowMs = performance.now(), pose = null } = {}) => {
        // This clock advances only by time that was actually rendered. Shader
        // compilation or a backgrounded tab can otherwise skip a whole stunt
        // while a wall clock races straight to the failure card.
        const frameDeltaMs = campaignPresentationDeltaSeconds({
            simulationDt: 0,
            nowMs,
            previousNowMs: previousFrameNowMs,
        }) * 1000;
        presentationElapsedMs += frameDeltaMs;
        previousFrameNowMs = nowMs;
        const elapsedMs = readoutClock.advance(frameDeltaMs);
        const sampled = sampleCinematic(input.cinematic, elapsedMs, { reducedMotion });
        const presentation = sampleCinematicPresentation(
            input.cinematic,
            elapsedMs,
            { reducedMotion },
        );
        // The film clock advances at most 50 ms per rendered frame, so on a
        // host still building the world the 900 ms opening fade took ~2 s of
        // black. The intro alone is capped by the wall clock: this can only
        // ever brighten the opening; shot cuts and the outro stay on the film clock.
        const introCap = elapsedMs < CINEMATIC_FADE_IN_MS ? Math.max(0, 1 - (nowMs - startedAt) / CINEMATIC_FADE_IN_MS) : 1;
        curtain.style.opacity = String(readoutClock.holding ? 0 : Math.min(presentation.curtainOpacity, introCap));
        overlayEl.dataset.shot = String(presentation.shotIndex + 1);
        caption.textContent = formatCaptionText(sampled.caption, getLang());
        // A caption owns its complete recording. At the next caption or shot
        // boundary the film holds until ended; absent/failed/muted audio uses
        // the localized text's reading time. Cue identity also lets consecutive
        // identical lines be spoken independently by their authored speakers.
        const cue = readoutClock.cue;
        if (cue !== lastReadoutCue) {
            lastReadoutCue = cue;
            if (cue) {
                readoutClock.beginNarration(cue.id);
                const voiced = !isAudioMuted() && playVoice(
                    { text: cue.content.text, mood: cue.content.mood, voice: { recorded: true } },
                    cue.text,
                    { id: cue.content.speakerId || 'narrator' },
                    result => readoutClock.endNarration(cue.id, result),
                );
                if (!voiced) readoutClock.endNarration(cue.id, { completed: false });
            }
        }
        progress.value = sampled.progress || 0;
        newspapers?.render(sampleCinematicNewspaper(input.cinematic, elapsedMs, { reducedMotion }));
        artwork?.classList.toggle('is-visible', !!sampled.artwork);
        skip.disabled = presentationElapsedMs < Number(input.cinematic.skipGuardMs || 0);
        if (JSON.stringify(sampled.worldEffects) !== JSON.stringify(lastWorldEffects)) {
            lastWorldEffects = sampled.worldEffects;
            if (sampled.worldEffects) {
                window.dispatchEvent(new CustomEvent('station3d:campaign-world-effects-changed', {
                    detail: { worldEffects: sampled.worldEffects, transient: true },
                }));
            }
        }
        if (sampled.done) {
            finish(false);
            return null;
        }
        // A player-relative shot is resolved here, against the pose the frame
        // owner just rendered, into scene coordinates. Without a subject pose
        // there is no shot: the live camera holds rather than a NaN frame.
        const relative = sampled.camera?.relativeTo
            ? resolveRelativeCinematicCamera(sampled.camera, cinematicSubjectFromPose(pose))
            : null;
        const cameraFrame = sampled.camera?.relativeTo
            ? (relative ? { local: relative, fovDeg: relative.fovDeg } : null)
            : sampled.camera;
        return cameraFrame ? {
            ...cameraFrame,
            groundReference: input.cinematic.groundReference || null,
            worldEffects: sampled.worldEffects,
            // The camera and any authored moving set piece must sample one
            // clock. A renderer-owned world layer can start a few frames before
            // this overlay, which is enough to leave an 18 m/s boat several
            // metres ahead of an otherwise correctly authored cabin camera.
            campaignCinematic: {
                id: input.cinematic.id,
                elapsedMs,
                fog: input.cinematic.fog || null,
                // How the film mixes its aircraft's engine (core/film-engine-audio.js).
                engineAudio: input.cinematic.engineAudio || null,
            },
        } : null;
    };
    const finish = (skipped) => {
        if (!ownState || cinematicState !== ownState) return;
        const result = finishCinematic(input.cinematic, { skipped });
        revealGameplayAfterCinematic({ reducedMotion, skipped });
        closeOverlay(skipped ? 'cinematic-skip' : 'cinematic-complete');
        if (input.replay) return;
        if (skipped) input.onSkip(result);
        else input.onComplete(result);
    };
    ownState = {
        setFrameHandler: campaignUi.setFrameHandler,
        onClose: input.onClose,
        score: playCampaignCinematicScore(input.cinematic),
    };
    cinematicState = ownState;
    if (!campaignUi.setFrameHandler(updateFrame)) {
        closeOverlay('cinematic-frame-owner-unavailable');
        throw new Error('Campaign cinematics require the Station3D frame owner.');
    }
}

// Every way a run can end: the emitted reason first, then the event type, so a
// new failure source cannot silently fall through to the generic body. Keep it
// exhaustive — an unexplained failure card is what "nothing happened" feels like.
const FAILURE_BODY_KEYS = Object.freeze({
    'aircraft-crashed': 'campaign.failure.aircraftCrashed',
    'missed-riva': 'campaign.failure.missedRiva',
    'lost-at-sea': 'campaign.failure.lostAtSea',
    'left-bounds': 'campaign.failure.leftBounds',
    'required-vehicle-lost': 'campaign.failure.requiredVehicleLost',
    'vehicle-stuck': 'campaign.failure.vehicleStuck',
    'no-safe-exit': 'campaign.failure.noSafeExit',
    'spawn-unavailable': 'campaign.failure.pursuitUnavailable',
    'inspection-run': 'campaign.failure.inspectionRun',
    'patrol-impound': 'campaign.failure.patrolImpound',
    'arrested': 'campaign.failure.arrested',
    'vehicle:destroyed': 'campaign.failure.vehicleDestroyed',
    'cinematic-unavailable': 'campaign.failure.cinematicUnavailable',
    'scene-open-failed': 'campaign.failure.worldUnavailable',
    'scene-transition-failed': 'campaign.failure.worldUnavailable',
});

function showFailure(input) {
    if (!openOverlay('failure')) return;
    const reason = input.event?.reason || input.reason || '';
    const failureKey = FAILURE_BODY_KEYS[reason]
        || FAILURE_BODY_KEYS[input.event?.type]
        // Adapter errors carry developer text: English, technical, and useless
        // to a player. The card gets a translated line; the cause goes to the
        // console. A rejected baked level is content, not the connection.
        || (input.error?.name === 'CampaignPackError' ? 'campaign.failure.levelOutdated'
            : input.error ? 'campaign.failure.worldUnavailable' : 'campaign.failure.body');
    const body = t(failureKey);
    if (input.error) console.error('[campaign] scene failed to open', input.error);
    const card = panel(t('campaign.failure.eyebrow'), t('campaign.failure.title'), body);
    const row = actionRow(card);
    row.appendChild(button(t('campaign.retry'), async () => {
        closeOverlay('retry');
        await input.retry?.();
    }, { primary: true }));
    row.appendChild(button(t('campaign.exit'), () => {
        // Same guard as the menu: exiting returns to the map, so ask first.
        const question = document.createElement('p');
        question.className = 'station-3d-campaign-menu-notice';
        question.textContent = t('campaign.exitConfirm');
        const confirmRow = actionRow(card);
        row.replaceWith(question, confirmRow);
        confirmRow.appendChild(button(t('campaign.exit'), async () => {
            closeOverlay('exit');
            await input.exit?.();
        }, { danger: true }));
        confirmRow.appendChild(button(t('campaign.cancel'), () => {
            question.remove();
            confirmRow.replaceWith(row);
        }));
    }, { danger: true }));
    const reveal = () => {
        if (!overlayEl || overlayEl.dataset.kind !== 'failure') return;
        overlayEl.classList.remove('hidden');
        failurePresentationDelay = null;
    };
    const delay = Math.max(0, Math.min(MAX_FAILURE_PRESENTATION_DELAY_MS,
        Number(input.presentationDelayMs) || 0));
    if (delay > 0) {
        overlayEl.classList.add('hidden');
        failurePresentationDelay = createFailurePresentationDelay({
            delayMs: delay,
            setFrameHandler: campaignUi.setFrameHandler,
            reveal,
        });
    }
}

// The end card. Reaching it is the whole point of the campaign, so it names the
// campaign, says the tower stands, and offers the two things a player wants
// next: keep the transformed city and walk around it, or start over.
// The run's own numbers, so finishing reads as an accomplishment rather than a
// notice. Everything here comes from the save the director just completed.
function appendCompletionStats(card, definition, run) {
    const summary = campaignRunSummary(definition, run);
    const duration = formatCampaignDuration(summary.durationMs, {
        hour: t('campaign.completed.hour'),
        minute: t('campaign.completed.minute'),
    });
    const stats = [
        [t('campaign.completed.chapters'), String(summary.chapters)],
        // Omitted entirely for a checkpoint-seeded run: see campaign-summary.js.
        ...(duration ? [[t('campaign.completed.duration'), duration]] : []),
    ];
    const list = document.createElement('dl');
    list.className = 'station-3d-campaign-stats';
    list.innerHTML = stats.map(([label, value]) => (
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
    )).join('');
    card.appendChild(list);
}

function showCompleted(input) {
    if (!openOverlay('completed')) return;
    const card = panel(
        t('campaign.completed.eyebrow'),
        localized(input.definition?.metadata?.title) || t('campaign.completed.title'),
        t('campaign.completed.body'),
    );
    appendCompletionStats(card, input.definition, input.run);
    const row = actionRow(card);
    row.appendChild(button(t('campaign.completed.freeRoam'), () => {
        closeOverlay('completed-free-roam');
        void input.freeRoam?.();
    }, { primary: true }));
    row.appendChild(button(t('campaign.restart'), async () => {
        closeOverlay('completed-restart');
        await input.restart?.();
    }, { danger: true }));
}

// Opening a chapter in a fresh world closes the previous 3D session first, and
// closing it hides the whole Station3D modal, which uncovers the /prijevoz map
// underneath for as long as the next world takes to download. The loading screen
// is mounted on <body> for exactly that reason: anything inside the modal goes
// dark with it (ui/loading-curtain.js). It names the chapter it is loading as the
// chapter card does, and a live world feeds its bar from the build hold.
// The baked level is the one load with a true denominator: its manifest lists
// every chunk's size, so the bar is bytes received over bytes total.
function onCampaignPackProgress(event) {
    const detail = event?.detail || {};
    setLoadingCurtainProgress({
        fraction: campaignPackFraction(detail),
        text: detail.phase === 'build'
            ? t('campaign.packBuild', { done: Number(detail.uploadedPackets) || 0, total: Number(detail.totalPackets) || 0 })
            : t('campaign.packDownload', {
                loaded: (Number(detail.loadedBytes) / 1048576 || 0).toFixed(0),
                total: (Number(detail.totalBytes) / 1048576 || 0).toFixed(0),
            }),
    });
}

function showCampaignCurtain(scene) {
    if (!document?.body) return;
    // A host raises the same screen before this module has even loaded (a Sloboda
    // click, a transit.html deep link); raising adopts that element instead of
    // stacking a second one it could never remove.
    const heading = campaignSceneLoadingHeading(
        scene?.chapter ? t('campaign.chapter', { n: scene.chapter }) : '',
        localized(scene?.title),
    );
    raiseLoadingCurtain({ eyebrow: heading.eyebrow, headline: heading.headline, label: t('hud.loadingWorld') });
    window.removeEventListener('station3d:campaign-pack-progress', onCampaignPackProgress);
    window.addEventListener('station3d:campaign-pack-progress', onCampaignPackProgress);
}

function hideCampaignCurtain() {
    window.removeEventListener('station3d:campaign-pack-progress', onCampaignPackProgress);
    dropLoadingCurtain();
}

function showLoading({ definition, scene }) {
    showCampaignCurtain(scene);
    if (!ensureUi()) return;
    showObjective({ definition, scene, objective: null, checkpointConfirmed: false });
}

// Called when the next world is ready, and on every failure path — a curtain
// that outlives its load would leave the player staring at a dead screen.
function hideLoading() {
    hideCampaignCurtain();
}

function showToast(message, options = {}) {
    const text = options.key ? t(options.key) : localized(message);
    if (!text) return;
    const durationMs = Math.max(1000, Number(options.durationMs) || 3600);
    if (options.speech === true) showSpokenCaption(text, { ...options, durationMs });
    else showCabToast(text, durationMs);
    window.dispatchEvent(new CustomEvent('station3d:campaign-toast', {
        detail: { message: text, actorId: options.actorId || null },
    }));
    if (options.speech === true) {
        const voiced = playVoice({
            text: message,
            voice: { speech: true, profile: options.voiceProfile || '' },
        }, text, options.actorId ? { id: options.actorId } : null);
        if (options.actorId) {
            announceSpeaking(
                options.actorId,
                voiced ? MAX_SPEAKING_S : speakingSeconds(text),
                options.mood || 'stern',
            );
        }
    }
}

// Gameplay captions: authored lines drawn over the live world without any
// overlay, lease or pause, advanced by the session's own pose broadcast (the
// render loop, ~10 Hz) rather than a timer. A new track replaces the previous
// one; there is only ever one caption element.
let gameplayCaptionEl = null;
let gameplayCaptionTrack = null;
let gameplayCaptionListening = false;

function onGameplayCaptionPose() {
    renderGameplayCaption(performance.now());
}

function listenForGameplayCaptionFrames(listen) {
    if (listen === gameplayCaptionListening) return;
    gameplayCaptionListening = listen;
    if (listen) window.addEventListener('station3d:pose', onGameplayCaptionPose);
    else window.removeEventListener('station3d:pose', onGameplayCaptionPose);
}

function ensureGameplayCaptionEl() {
    if (gameplayCaptionEl) return gameplayCaptionEl;
    if (!ensureUi()) return null;
    gameplayCaptionEl = document.createElement('p');
    gameplayCaptionEl.className = 'station-3d-campaign-gameplay-caption hidden';
    gameplayCaptionEl.setAttribute('aria-live', 'polite');
    containerEl.appendChild(gameplayCaptionEl);
    return gameplayCaptionEl;
}

// The caption currently voiced over live play, so a track that keeps the same
// text on screen across frames is read once, like a film caption.
let lastGameplayCaptionKey = '';

function renderGameplayCaption(nowMs = performance.now()) {
    const el = ensureGameplayCaptionEl();
    if (!el) return;
    const track = gameplayCaptionTrack;
    if (!track) {
        el.classList.add('hidden');
        listenForGameplayCaptionFrames(false);
        return;
    }
    const elapsedMs = nowMs - track.startedAt;
    const current = track.captions.find(caption => (
        elapsedMs >= caption.startMs && elapsedMs < caption.endMs
    ));
    const text = current ? localized(current.text) : '';
    const shown = current ? formatCaptionText(current, getLang()) : '';
    if (el.textContent !== shown) el.textContent = shown;
    // Narration over live play: each new caption plays its recorded reading,
    // exactly as a film caption does — by the narrator, or by the character
    // the caption names. No synthesis fallback.
    if (text !== lastGameplayCaptionKey) {
        lastGameplayCaptionKey = text;
        if (text) playVoice({ text: current.text, mood: current.mood, voice: { recorded: true } }, text, { id: current.speakerId || 'narrator' });
    }
    el.classList.toggle('hidden', !text);
    const remaining = track.captions.some(caption => caption.endMs > elapsedMs);
    if (!remaining) gameplayCaptionTrack = null;
    listenForGameplayCaptionFrames(remaining);
}

function showCaptions(captions = []) {
    const track = (Array.isArray(captions) ? captions : [])
        .map(caption => ({
            text: caption?.text,
            speakerId: caption?.speakerId || null,
            mood: caption?.mood || null,
            label: caption?.label || null,
            cue: caption?.cue || null,
            startMs: Math.max(0, Number(caption?.startMs) || 0),
            endMs: Number(caption?.endMs) || 0,
        }))
        .filter(caption => caption.text && caption.endMs > caption.startMs);
    gameplayCaptionTrack = track.length > 0 ? { captions: track, startedAt: performance.now() } : null;
    lastGameplayCaptionKey = '';
    renderGameplayCaption();
    return track.length > 0;
}

function hideCaptions() {
    gameplayCaptionTrack = null;
    lastGameplayCaptionKey = '';
    gameplayCaptionEl?.classList.add('hidden');
    listenForGameplayCaptionFrames(false);
}

function interactionPrompt(detail) {
    const key = detail?.action === 'approach' ? 'campaign.approach'
        : detail?.action === 'board' ? 'campaign.board'
        : detail?.action === 'enter' ? 'campaign.enter' : 'campaign.interact';
    return t(key, { name: detail?.name || '' });
}

export const campaignUi = {
    setFrameHandler: () => false,
    closeTransient: closeOverlay,
    hideObjective,
    showCompleted,
    showFailure,
    showLoading,
    hideLoading,
    showMenu,
    showJournal,
    showObjective,
    showToast,
    showCaptions,
    hideCaptions,
    setVoiceClips,
    startConversation,
    startCinematic,
};

onLangChange(() => {
    activeRender?.();
    if (lastObjectiveInput) showObjective(lastObjectiveInput);
    if (lastInteraction?.entityId && interactionEl) {
        interactionEl.textContent = interactionPrompt(lastInteraction);
        setCampaignInteractionAvailable(
            true,
            lastInteraction.name || '',
            lastInteraction.action || 'talk',
        );
    }
});

window.addEventListener('station3d:campaign-interaction', (event) => {
    if (!ensureUi()) return;
    const detail = event.detail;
    lastInteraction = detail || null;
    if (!detail?.entityId) {
        setCampaignInteractionAvailable(false);
        interactionEl.classList.add('hidden');
        interactionEl.textContent = '';
        return;
    }
    interactionEl.textContent = interactionPrompt(detail);
    setCampaignInteractionAvailable(true, detail.name || '', detail.action || 'talk');
    interactionEl.classList.remove('hidden');
});


// Pose telemetry already runs for campaign interactions. Only a controller
// change updates this label; it never re-renders the objective every frame.
window.addEventListener('station3d:pose', (event) => {
    const controller = event.detail?.snapshot?.controllerId;
    const key = event.detail?.snapshot?.status?.controlsHintKey || '';
    if (!controller || (controller === lastControllerId && key === lastControlsHintKey)) return;
    lastControllerId = controller;
    lastControlsHintKey = key;
    if (lastObjectiveInput) updateControllerHint();
});

window.addEventListener('station3d:campaign-motion-progress', ({ detail }) => {
    if (lastObjectiveInput?.objective?.progressTimerId !== detail?.timerId) return;
    lastMotionProgress = detail;
    const progress = objectiveEl?.querySelector('.station-3d-campaign-motion-progress');
    const label = objectiveEl?.querySelector('.station-3d-campaign-motion-label');
    if (progress) progress.value = detail.progress;
    if (label) label.textContent = t('campaign.drivingSeconds', { n: detail.seconds, total: detail.totalSeconds });
});
