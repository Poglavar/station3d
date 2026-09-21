// Pure rules for the one loading screen (ui/loading-curtain.js): who may see its
// diagnostics — the per-layer build bars and the downloaded megabytes — and how a
// free-roam start names itself. Everyone, localhost included, gets one bar and one
// label; the layer breakdown is a debugging aid that only an explicit ?stats=1
// brings back (2026-09-11: the green bars were noise on the loading screen).

export function loadingDiagnosticsAllowed({ search = '' } = {}) {
    return new URLSearchParams(String(search || '')).get('stats') === '1';
}

// A chapter loads as "Poglavlje 6 — Toranj"; a free-roam start as the mode over
// the place: "Sloboda — Zagreb", or the generic start-point name for a link that
// carries only coordinates.
export function freeRoamLoadingHeading({ modeLabel = '', placeLabel = '', fallbackPlace = '' } = {}) {
    const eyebrow = String(modeLabel || '').trim();
    const headline = String(placeLabel || '').trim() || String(fallbackPlace || '').trim();
    return Object.freeze({ eyebrow, headline });
}
