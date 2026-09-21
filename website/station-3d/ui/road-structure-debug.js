// Development-only road grade-separation decision overlay. Enabled explicitly
// with ?structureDebug=1; it shows and logs the nearest structure's measured
// inputs, fallbacks, cross-section, terrain fit, and civil build sequence.

import { geoToLocal } from '../core/math.js';
import { buildRoadStructureDecisionTrace } from '../core/road-structure-trace.js';
import { state } from '../state.js';
import { containerEl } from './modal.js';

const ENABLED_VALUES = new Set(['', '1', 'true', 'yes', 'on']);
const UPDATE_INTERVAL_MS = 200;

let enabled = false;
let buttonEl = null;
let panelEl = null;
let outputEl = null;
let panelVisible = true;
let currentTrace = null;
let lastUpdateMs = -Infinity;
let lastRenderedKey = '';
let lastLoggedKey = '';

export function isRoadStructureDebugRequested(search = '') {
    const params = new URLSearchParams(String(search || ''));
    if (!params.has('structureDebug')) return false;
    return ENABLED_VALUES.has(
        String(params.get('structureDebug') ?? '').trim().toLowerCase(),
    );
}

function setPanelVisible(visible) {
    panelVisible = !!visible;
    if (panelEl) panelEl.style.display = panelVisible ? 'flex' : 'none';
    if (buttonEl) buttonEl.setAttribute('aria-pressed', String(panelVisible));
}

function ensureButton() {
    if (buttonEl || !containerEl) return;
    buttonEl = document.createElement('button');
    buttonEl.type = 'button';
    buttonEl.textContent = 'Structure trace';
    buttonEl.setAttribute('aria-pressed', 'true');
    buttonEl.style.cssText = [
        'position:absolute',
        'right:14px',
        'bottom:14px',
        'left:auto',
        'width:auto',
        'margin:0',
        'z-index:40',
        'border:1px solid rgba(147,197,253,0.8)',
        'border-radius:8px',
        'padding:8px 11px',
        'background:rgba(15,23,42,0.92)',
        'color:#e0f2fe',
        'font:700 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace',
        'cursor:pointer',
        'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
    ].join(';');
    buttonEl.addEventListener('click', () => setPanelVisible(!panelVisible));
    containerEl.appendChild(buttonEl);
}

function ensurePanel() {
    if (panelEl || !containerEl) return;
    panelEl = document.createElement('section');
    panelEl.setAttribute('aria-label', 'Road structure decision trace');
    panelEl.style.cssText = [
        'position:absolute',
        'right:14px',
        'bottom:56px',
        'z-index:39',
        'display:flex',
        'flex-direction:column',
        'width:min(620px,calc(100% - 28px))',
        'max-height:min(68vh,720px)',
        'overflow:hidden',
        'border:1px solid rgba(147,197,253,0.6)',
        'border-radius:10px',
        'background:rgba(2,6,23,0.94)',
        'color:#e2e8f0',
        'box-shadow:0 10px 32px rgba(0,0,0,0.5)',
        'backdrop-filter:blur(8px)',
        '-webkit-backdrop-filter:blur(8px)',
        'pointer-events:auto',
    ].join(';');

    const header = document.createElement('div');
    header.textContent = 'Road grade-separation decisions';
    header.style.cssText = [
        'padding:10px 12px',
        'border-bottom:1px solid rgba(148,163,184,0.28)',
        'font:800 13px/1.2 ui-sans-serif,system-ui,sans-serif',
        'color:#bae6fd',
    ].join(';');
    panelEl.appendChild(header);

    outputEl = document.createElement('pre');
    outputEl.style.cssText = [
        'margin:0',
        'padding:12px',
        'overflow:auto',
        'white-space:pre-wrap',
        'overflow-wrap:anywhere',
        'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
        'tab-size:2',
        'user-select:text',
    ].join(';');
    outputEl.textContent = 'Waiting for road vertical-alignment data…';
    panelEl.appendChild(outputEl);
    containerEl.appendChild(panelEl);
}

export function ensureRoadStructureDebug() {
    enabled = isRoadStructureDebugRequested(window.location.search);
    if (!enabled) return false;
    ensureButton();
    ensurePanel();
    setPanelVisible(true);
    return true;
}

function formatMeasurementValue(value) {
    if (value == null) return 'unknown';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return JSON.stringify(value);
}

function formatTrace(trace) {
    const lines = [
        `${trace.kind.toUpperCase()}  ${trace.name || trace.id}`,
        `id ${trace.id} · OSM ${trace.memberOsmIds.join(', ') || 'none'}`,
        ...(trace.profileOwner?.inherited
            ? [`profile/structure owner ${trace.profileOwner.id} · OSM ${trace.profileOwner.memberOsmIds.join(', ') || 'none'}`]
            : []),
        `observer ${trace.observer.distanceFromAxisM} m from axis at station ${trace.observer.stationM} m`
            + ` · ${trace.observer.insidePhysicalStructure ? 'inside structure' : 'on approach'}`,
        '',
    ];
    for (const step of trace.steps) {
        lines.push(`${step.number}. ${step.name}  [${step.status}]`);
        lines.push(`   ${step.decision}`);
        for (const [key, value] of Object.entries(step.measurements || {})) {
            lines.push(`   ${key}: ${formatMeasurementValue(value)}`);
        }
        lines.push('');
    }
    if (trace.warnings.length > 0) {
        lines.push('CURRENT LIMITS / FALLBACKS');
        trace.warnings.forEach((warning, index) => {
            lines.push(`! ${index + 1}. ${warning}`);
        });
    }
    return lines.join('\n');
}

function logTrace(trace) {
    const key = `${trace.revision}:${trace.id}`;
    if (key === lastLoggedKey) return;
    lastLoggedKey = key;
    console.groupCollapsed(
        `[road-structure] ${trace.kind} ${trace.name || trace.id} · revision ${trace.revision}`,
    );
    for (const step of trace.steps) {
        console.groupCollapsed(`${step.number}. ${step.name} [${step.status}]`);
        console.log(step.decision);
        console.log(step.measurements);
        console.groupEnd();
    }
    if (trace.warnings.length > 0) console.warn('Current limits/fallbacks:', trace.warnings);
    console.log('Full trace:', trace);
    console.groupEnd();
}

export function updateRoadStructureDebug(now = performance.now()) {
    if (!enabled || !outputEl || now - lastUpdateMs < UPDATE_INTERVAL_MS) return;
    lastUpdateMs = now;
    const cabState = state.cabState;
    const pose = cabState?.lastRenderedPose || cabState?.lastAutoPose;
    const model = cabState?.roadVerticalAlignments;
    if (!pose || !model) {
        currentTrace = null;
        outputEl.textContent = 'Waiting for elevation-mode road vertical-alignment data…';
        return;
    }
    const local = geoToLocal(
        Number(pose.lon),
        Number(pose.lat),
        Number(cabState.anchorLon),
        Number(cabState.anchorLat),
    );
    const params = new URLSearchParams(window.location.search);
    const trace = buildRoadStructureDecisionTrace(model, local.x, local.z, {
        radiusM: Number(params.get('structureDebugRadius')) || 250,
        alignmentId: params.get('structureId'),
        osmId: params.get('structureOsm'),
    });
    currentTrace = trace;
    if (!trace) {
        outputEl.textContent = 'No resolved road structure is within the debug radius yet.';
        return;
    }
    const renderedKey = `${trace.revision}:${trace.id}:${trace.observer.stationM}:`
        + `${trace.observer.distanceFromAxisM}`;
    if (renderedKey !== lastRenderedKey) {
        lastRenderedKey = renderedKey;
        outputEl.textContent = formatTrace(trace);
    }
    logTrace(trace);
}

export function getCurrentRoadStructureTrace() {
    return currentTrace;
}
