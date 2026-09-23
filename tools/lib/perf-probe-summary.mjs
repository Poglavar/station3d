// Pure helpers for tools/perf-probe.mjs: frame-interval statistics, host paging
// readings and the verdict that decides whether a measurement window is usable.

// Percentile summary of rAF intervals (ms). Counts use >= so a 50 ms frame is a hitch.
export function summarizeIntervals(values) {
    const f = (Array.isArray(values) ? values : []).filter(v => typeof v === 'number' && Number.isFinite(v))
        .sort((a, b) => a - b);
    if (!f.length) return { n: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, over50: 0, over100: 0, over250: 0 };
    const q = p => f[Math.min(f.length - 1, Math.floor(p * f.length))];
    return { n: f.length, meanMs: f.reduce((s, v) => s + v, 0) / f.length,
        p50Ms: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: f.at(-1),
        over50: f.filter(v => v >= 50).length, over100: f.filter(v => v >= 100).length,
        over250: f.filter(v => v >= 250).length };
}

// Display refresh period from idle rAF intervals: the median, so one late frame cannot move it.
export function displayPeriodMs(intervals) {
    const s = summarizeIntervals(intervals);
    return s.n ? s.p50Ms : null;
}

// macOS `vm_stat` text → cumulative page counters. Missing fields stay null, never 0:
// a counter we could not read must not look like a quiet host.
export function parseVmStat(text) {
    const read = label => {
        const match = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(String(text || ''));
        return match ? Number(match[1]) : null;
    };
    return { pageins: read('Pageins'), swapins: read('Swapins'), swapouts: read('Swapouts') };
}

// Linux /proc/vmstat text → the same shape.
export function parseProcVmstat(text) {
    const read = key => {
        const match = new RegExp(`^${key}\\s+(\\d+)`, 'm').exec(String(text || ''));
        return match ? Number(match[1]) : null;
    };
    return { pageins: read('pgpgin'), swapins: read('pswpin'), swapouts: read('pswpout') };
}

// A timing window is only evidence when the host was not paging. The CPU contention
// probe alone passed while 16,000 pages were swapped in during a 3.5 s main-thread stall.
export function hostWindowVerdict({ before, after, seconds, loadAvg = null, cpus = null,
    maxSwapinsPerSecond = 50, maxLoadPerCpu = 1.5 } = {}) {
    const reasons = [];
    const swapins = typeof before?.swapins === 'number' && typeof after?.swapins === 'number'
        ? after.swapins - before.swapins : null;
    const rate = swapins !== null && seconds > 0 ? swapins / seconds : null;
    if (rate === null) reasons.push('swap-in counter unavailable');
    else if (rate > maxSwapinsPerSecond) reasons.push(`paging: ${Math.round(rate)} swap-ins/s`);
    if (typeof loadAvg === 'number' && typeof cpus === 'number' && cpus > 0 && loadAvg / cpus > maxLoadPerCpu) {
        reasons.push(`load ${loadAvg.toFixed(1)} on ${cpus} CPUs`);
    }
    return { clean: reasons.length === 0, swapins, swapinsPerSecond: rate, reasons };
}

// GPU timer samples (ms) → summary; null when the extension was unavailable.
export function summarizeGpuMs(samples) {
    if (!Array.isArray(samples)) return null;
    const s = summarizeIntervals(samples);
    return s.n ? { n: s.n, meanMs: s.meanMs, p50Ms: s.p50Ms, p95Ms: s.p95Ms, maxMs: s.maxMs } : null;
}
