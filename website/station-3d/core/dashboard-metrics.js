// Formatting for the cab's separate altitude, grade, and chainage gauges. Pure
// and DOM-free so the display rules are unit-testable headless; ui/dashboard.js
// only pushes each returned value into its own fixed-size instrument.

// Loading-overlay telemetry: seconds since the build began and the bytes it
// cost. The wire figure (Resource Timing transfer sizes) is what the player
// actually downloaded; the decoded estimate is several times larger (terrain
// grids and building meshes inflate on decode) and used to read as the
// download size ("169 MB" for a 7 MB Zagreb start, 2026-09-10).
export function formatLoadTelemetry({ elapsedMs = 0, receivedBytes = 0, transferBytes = 0 } = {}, labels = {}) {
    const seconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
    const transfer = Math.max(0, Number(transferBytes) || 0);
    const decoded = Math.max(0, Number(receivedBytes) || 0);
    const wire = transfer > 0;
    const megabytes = (wire ? transfer : decoded) / 1_000_000;
    const label = wire ? labels.downloaded : labels.decoded;
    return `${seconds} s · ${megabytes.toFixed(1)} MB${label ? ` ${label}` : ''}`;
}

export function formatDashboardMetricValues(altitudeM, absolute = false, gradePct = null, chainageText = '') {
    const raw = Number(altitudeM);
    const rounded = Number.isFinite(raw) ? Math.round(raw * 10) / 10 : null;
    const normalized = rounded != null && Math.abs(rounded) < 0.05 ? 0 : rounded;
    const altitude = normalized == null
        ? '–'
        : `${!absolute && normalized > 0 ? '+' : ''}${normalized.toFixed(1)} m`;
    // A finite near-level grade reads as zero rather than blinking out. Each
    // value now owns a box, but stable content still prevents distracting
    // changes between an empty instrument and a real one during a ride.
    const shownGrade = Number.isFinite(gradePct)
        ? (Math.abs(gradePct) < 0.05 ? 0 : gradePct)
        : null;
    const grade = shownGrade == null
        ? '–'
        : `${shownGrade > 0 ? '+' : ''}${shownGrade.toFixed(1)}%`;
    return {
        altitude,
        grade,
        chainage: chainageText || '–',
    };
}
