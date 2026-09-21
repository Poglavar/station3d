// Pure formatting helpers for railway cab chainage and signed grade readouts.
//
// Both refuse a non-number outright. `Number(null)` is 0, so the obvious
// `Number.isFinite(Number(x))` guard turned "this vehicle has no chainage" into
// a confident "km 0+000 · 0.0%" — which is how an aircraft over Pleso came to
// display railway chainage. A missing measurement must stay missing.

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatRailChainage(stationM) {
    const value = finiteNumber(stationM);
    if (value === null || value < 0) return '';
    const rounded = Math.round(value);
    const kilometres = Math.floor(rounded / 1000);
    const metres = rounded - kilometres * 1000;
    return `km ${kilometres}+${String(metres).padStart(3, '0')}`;
}

export function formatSignedGradePercent(gradePercent) {
    const value = finiteNumber(gradePercent);
    if (value === null) return '';
    const rounded = Math.abs(value) < 0.05 ? 0 : value;
    const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
    return `${sign}${Math.abs(rounded).toFixed(1)}%`;
}
