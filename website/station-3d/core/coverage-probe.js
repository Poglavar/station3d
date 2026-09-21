// Collects the three signals that tell an empty world apart from an unprepared
// one, and re-runs the verdict whenever one of them lands.
//
// They arrive at different times and from different layers — the registry knows
// the spawn position immediately, /prepared-coverage is one request, and the
// terrain layer only finds out whether a DGU grid exists when its fetch answers
// — so this is a small reactive collector rather than a single call. The rule
// it applies lives in world-coverage.js and is pure; everything stateful and
// asynchronous is here.

import { getApiBase } from './api.js';
import { assessWorldCoverage } from './world-coverage.js';

const listeners = new Set();
let signals = null;
let lastVerdict = null;

function emit() {
    if (!signals) return;
    const verdict = assessWorldCoverage(signals);
    // Only notify on a real change: the terrain layer and the coverage fetch
    // both settle during the loading storm, and re-rendering the banner on
    // every tick would make it flicker.
    const same = JSON.stringify(verdict) === JSON.stringify(lastVerdict);
    lastVerdict = verdict;
    if (same) return;
    for (const listener of listeners) {
        try { listener(verdict); } catch (error) { console.warn('[coverage] listener failed', error); }
    }
}

export function onCoverageVerdict(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    if (signals) listener(lastVerdict);
    return () => listeners.delete(listener);
}

// Called by the terrain layer: 'ok' once a grid decodes, 'missing' when the
// endpoint says there is no DGU coverage for this area.
export function noteTerrainCoverage(state) {
    if (!signals) return;
    signals.terrainState = state;
    emit();
}

// Starts a session's probe. location is the LOCATIONS entry (needs .id and
// .buildings); the anchor decides whether the spawn is inside a served area at
// all, which the classic-script registry answers.
export function beginCoverageProbe({ location, anchorLat, anchorLon } = {}) {
    const registry = (typeof window !== 'undefined' && window.__locationRegistry) || null;
    const insidePreparedArea = registry && Number.isFinite(anchorLat) && Number.isFinite(anchorLon)
        ? registry.detectByLatLng(anchorLat, anchorLon) !== null
        : null;
    signals = {
        locationId: location?.id,
        buildingSource: location?.buildings || false,
        country: location?.country || null,
        declaresTerrain: !!location?.terrain,
        insidePreparedArea,
        coverage: null,
        terrainState: 'unknown',
    };
    lastVerdict = null;
    emit();

    fetch(`${getApiBase()}/prepared-coverage`)
        .then(response => (response.ok ? response.json() : null))
        .then((coverage) => {
            if (!signals) return;
            signals.coverage = coverage;
            emit();
        })
        // A failed probe stays null, which assessWorldCoverage treats as "no
        // opinion" — a warning invented from a network error would be worse
        // than none, and the tile streams already report their own failures.
        .catch(error => console.warn('[coverage] prepared-coverage probe failed', error));
}
