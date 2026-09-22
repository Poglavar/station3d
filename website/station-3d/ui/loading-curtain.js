// The one loading screen of every Station3D session, on <body> above the 3D
// modal (z-index 4100), from the click that asks
// for a world until that world is built. A host raises it before the engine has
// loaded; the engine adopts the same element, feeds its bar, and drops it when the
// world is ready. Every piece of state lives on the element, so the host's copy of
// this module and the engine bundle's copy agree without sharing an instance. It
// began as the campaign's chapter curtain, which is why the class keeps that name.

import { noteWorldMilestone } from '../core/world-ready.js';
import { getSessionHost } from '../core/session-host.js';

export const LOADING_CURTAIN_CLASS = 'station-3d-campaign-curtain';

const PARTS = [
    ['brand', 'img', `${LOADING_CURTAIN_CLASS}-brand`],
    ['spinner', 'span', 'station-3d-photo-loading-spinner'],
    ['title', 'div', `${LOADING_CURTAIN_CLASS}-title`],
    ['label', 'span', `${LOADING_CURTAIN_CLASS}-label`],
    ['bar', 'span', `${LOADING_CURTAIN_CLASS}-bar`],
    // The way back sits above the developer breakdown, so a short screen never
    // pushes it out of reach.
    ['cancel', 'button', `${LOADING_CURTAIN_CLASS}-cancel`],
    ['diagnostics', 'div', `${LOADING_CURTAIN_CLASS}-diagnostics`],
];

function doc() {
    return typeof document === 'undefined' ? null : document;
}

export function loadingCurtainElement() {
    return doc()?.querySelector(`.${LOADING_CURTAIN_CLASS}`) || null;
}

export function loadingCurtainRaised() {
    return !!loadingCurtainElement();
}

// Every part exists exactly once and in a fixed order, whether the element was
// created here or adopted from a host page's static markup.
function part(curtain, name) {
    const index = PARTS.findIndex(([key]) => key === name);
    const [, tag, className] = PARTS[index];
    let element = curtain.querySelector(`:scope > .${className}`);
    if (element) return element;
    element = doc().createElement(tag);
    element.className = className;
    if (name === 'brand') {
        element.alt = '';
        element.decoding = 'async';
        element.hidden = true;
    }
    if (name === 'spinner') element.setAttribute('aria-hidden', 'true');
    if (name === 'bar') {
        element.hidden = true;
        element.appendChild(Object.assign(doc().createElement('span'), { className: `${LOADING_CURTAIN_CLASS}-fill` }));
    }
    if (name === 'title' || name === 'diagnostics' || name === 'cancel') element.hidden = true;
    if (name === 'cancel') element.type = 'button';
    const next = PARTS.slice(index + 1)
        .map(([, , nextClass]) => curtain.querySelector(`:scope > .${nextClass}`))
        .find(Boolean);
    curtain.insertBefore(element, next || null);
    return element;
}

const LOADING_THEME_PROPERTIES = Object.freeze({
    background: '--station3d-loading-background',
    foreground: '--station3d-loading-foreground',
    accent: '--station3d-loading-accent',
});

function applyLoadingScreenConfiguration(curtain) {
    const loadingScreen = getSessionHost().loadingScreen;
    const brand = part(curtain, 'brand');
    if (loadingScreen?.logoUrl) {
        brand.src = loadingScreen.logoUrl;
        brand.alt = loadingScreen.logoAlt || '';
        brand.hidden = false;
    } else {
        brand.removeAttribute('src');
        brand.alt = '';
        brand.hidden = true;
    }
    for (const [field, property] of Object.entries(LOADING_THEME_PROPERTIES)) {
        const value = loadingScreen?.[field];
        if (value) curtain.style.setProperty(property, value);
        else curtain.style.removeProperty(property);
    }
}

export function raiseLoadingCurtain({ eyebrow, headline, label, cancelLabel, onCancel } = {}) {
    const d = doc();
    if (!d?.body) return null;
    let curtain = loadingCurtainElement();
    if (!curtain) {
        curtain = d.createElement('div');
        curtain.className = LOADING_CURTAIN_CLASS;
        curtain.setAttribute('role', 'status');
        curtain.setAttribute('aria-live', 'polite');
        d.body.appendChild(curtain);
    }
    curtain.hidden = false;
    curtain.classList.remove('hidden');
    curtain.setAttribute('aria-atomic', 'false');
    for (const [name] of PARTS) part(curtain, name);
    applyLoadingScreenConfiguration(curtain);
    if (eyebrow !== undefined || headline !== undefined) setLoadingCurtainHeading({ eyebrow, headline });
    if (typeof label === 'string') setLoadingCurtainLabel(label);
    if (typeof onCancel === 'function') {
        const cancel = part(curtain, 'cancel');
        cancel.textContent = String(cancelLabel || '');
        cancel.onclick = () => onCancel();
        cancel.hidden = !cancel.textContent;
    }
    return curtain;
}

// Eyebrow, rule and mark, like the chapter card. Text nodes only, so a scene or
// place name can never become markup.
export function setLoadingCurtainHeading({ eyebrow = '', headline = '' } = {}) {
    const curtain = loadingCurtainElement();
    if (!curtain) return;
    const title = part(curtain, 'title');
    const top = String(eyebrow || '').trim();
    const mark = String(headline || '').trim();
    title.replaceChildren();
    if (top) title.appendChild(Object.assign(doc().createElement('span'), { textContent: top }));
    if (top && mark) {
        const rule = doc().createElement('i');
        rule.setAttribute('aria-hidden', 'true');
        title.appendChild(rule);
    }
    if (mark) title.appendChild(Object.assign(doc().createElement('strong'), { textContent: mark }));
    title.hidden = !(top || mark);
}

export function setLoadingCurtainLabel(text) {
    const curtain = loadingCurtainElement();
    if (!curtain || typeof text !== 'string') return;
    const label = labelPart(curtain, 'stage');
    if (label.textContent !== text) label.textContent = text;
}

// Adopt the host's plain label without replacing it on every frame. Additional
// public detail lives inside that same part, preserving static host markup.
function labelPart(curtain, name) {
    const label = part(curtain, 'label');
    const className = `${LOADING_CURTAIN_CLASS}-${name}`;
    let element = label.querySelector(`.${className}`);
    if (element) return element;
    if (!label.querySelector(`.${LOADING_CURTAIN_CLASS}-stage`)) {
        const stage = Object.assign(doc().createElement('span'), {
            className: `${LOADING_CURTAIN_CLASS}-stage`, textContent: label.textContent,
        });
        label.replaceChildren(stage);
        if (name === 'stage') return stage;
    }
    element = Object.assign(doc().createElement('span'), { className });
    if (name === 'activity') element.setAttribute('aria-live', 'off');
    label.appendChild(element);
    return element;
}

export function setLoadingCurtainDetails({ tasks, activity } = {}) {
    const curtain = loadingCurtainElement();
    if (!curtain) return;
    for (const [name, text] of [['tasks', tasks], ['activity', activity]]) {
        if (text === undefined) continue;
        const element = labelPart(curtain, name);
        if (element.textContent !== text) element.textContent = text;
        if (element.hidden !== !text) element.hidden = !text;
    }
}

// A fraction always describes the named stage, never guessed remaining time.
// Unknown work explicitly resets a previous stage's completed bar.
export function setLoadingCurtainProgress({ fraction = null, text = null } = {}) {
    const curtain = loadingCurtainElement();
    if (!curtain) return;
    const known = Number.isFinite(fraction);
    const bar = part(curtain, 'bar');
    if (bar.hidden) bar.hidden = false;
    const pct = known ? Math.floor(Math.max(0, Math.min(1, fraction)) * 100) : null;
    const state = pct === null ? 'unknown' : String(pct);
    if (bar.dataset.progressState !== state) {
        bar.dataset.progressState = state;
        bar.classList.toggle('is-indeterminate', !known);
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        const fill = bar.querySelector(`.${LOADING_CURTAIN_CLASS}-fill`);
        if (known) {
            if (fill) fill.style.width = `${pct}%`;
            bar.setAttribute('aria-valuenow', String(pct));
        } else {
            if (fill) fill.style.width = '';
            bar.removeAttribute('aria-valuenow');
        }
    }
    if (typeof text === 'string' && text) setLoadingCurtainLabel(text);
    const label = labelPart(curtain, 'stage').textContent;
    if (bar.getAttribute('aria-label') !== label) bar.setAttribute('aria-label', label);
}

// The development breakdown under the bar (see core/loading-curtain-policy.js);
// null when no curtain is up.
export function loadingCurtainDiagnostics({ show = true } = {}) {
    const curtain = loadingCurtainElement();
    if (!curtain) return null;
    const diagnostics = part(curtain, 'diagnostics');
    diagnostics.hidden = !show;
    return diagnostics;
}

export function dropLoadingCurtain() {
    const curtain = loadingCurtainElement();
    if (!curtain) return;
    curtain.remove();
    noteWorldMilestone('curtain-open');
}
