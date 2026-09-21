// One-shot startup/build profiler for the cab/walk world.
//
// The existing perf overlay (scene/animate.js) measures STEADY-STATE per-frame
// cost. This measures the one-time WORLD BUILD instead: how long each layer's
// beginSession blocks, and how much CPU the chunk-queue layers (buildings,
// roads, cars) actually spend streaming their meshes in across later frames —
// work that a plain beginSession timer would miss entirely.
//
// The point of the summary is to separate "CPU this code demanded" from
// "wall-clock elapsed". If wall-clock >> CPU, the slowness is network waits,
// frame gaps, or other load on the machine — not this code.
//
// Enabled on localhost by default (like the stats overlay); silence with
// ?perf=0. Output is a compact, one-time console report — not per-frame spam.

function nowMs() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

function isEnabled() {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get('perf') === '0' || params.get('stats') === '0') return false;
    if (params.has('perf') || params.has('stats')) return true;
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
        || h === '' || h.endsWith('.local');
}

function ts() {
    // Wall-clock HH:MM:SS.mmm so lines are self-locating in a busy console.
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

class StartupTrace {
    constructor() {
        this.enabled = false;
        this.t0 = 0;
        this.layers = new Map();      // name → { syncMs, totalMs, async }
        this.milestones = [];         // [{ name, ms }]
        this.queues = new Map();      // label → { items, cpuMs, flushes, firstMs, lastMs, idle }
        this.tileEvents = [];         // payload/build milestones for reproducible streaming profiles
        this.reported = false;
        this.summarised = false;
    }

    begin() {
        this.enabled = isEnabled();
        if (!this.enabled) return;
        this.t0 = nowMs();
        this.layers = new Map();
        this.milestones = [];
        this.queues = new Map();
        this.tileEvents = [];
        this.reported = false;
        this.summarised = false;
        this.milestone('build-start');
    }

    // Synchronous cost of a layer's beginSession — the part that blocks its frame.
    layerSync(name, ms) {
        if (!this.enabled) return;
        const rec = this.layers.get(name) || { syncMs: 0, totalMs: 0, async: false };
        rec.syncMs = ms;
        this.layers.set(name, rec);
    }

    // For layers whose beginSession returns a promise (e.g. the blocking terrain
    // fetch): total wall time from call to resolve. Marked async so the summary
    // can note it isn't all main-thread CPU.
    layerAsync(name, totalMs) {
        if (!this.enabled) return;
        const rec = this.layers.get(name) || { syncMs: 0, totalMs: 0, async: false };
        rec.totalMs = totalMs;
        rec.async = true;
        this.layers.set(name, rec);
    }

    milestone(name) {
        if (!this.enabled) return;
        this.milestones.push({ name, ms: nowMs() - this.t0 });
    }

    // Called once per chunk-queue flush (a frame's worth of streaming work).
    queueFlush(label, items, cpuMs) {
        if (!this.enabled) return;
        const q = this.queues.get(label)
            || { items: 0, cpuMs: 0, flushes: 0, firstMs: nowMs() - this.t0, lastMs: 0, idle: false };
        q.items += items;
        q.cpuMs += cpuMs;
        q.flushes += 1;
        q.lastMs = nowMs() - this.t0;
        q.idle = false;
        this.queues.set(label, q);
    }

    // A queue emptied. Once the deferred layers are built AND every queue seen so
    // far has gone idle at least once, print the final summary (condition-based,
    // no timer). Queues re-fill as the camera moves — this is the initial snapshot.
    queueIdle(label) {
        if (!this.enabled) return;
        const q = this.queues.get(label);
        if (q) q.idle = true;
        this._maybeSummarise();
    }

    tileEvent(stage, label, tileKey) {
        if (!this.enabled) return;
        // A long drive can touch thousands of tiles. The one-shot startup
        // profiler needs only a bounded recent history for comparison.
        if (this.tileEvents.length >= 2000) this.tileEvents.shift();
        this.tileEvents.push({
            stage: String(stage || ''),
            label: String(label || ''),
            tileKey: String(tileKey || ''),
            ms: nowMs() - this.t0,
        });
    }

    snapshot() {
        return {
            enabled: this.enabled,
            elapsedMs: this.enabled ? nowMs() - this.t0 : 0,
            layers: [...this.layers.entries()].map(([label, value]) => ({
                label,
                ...value,
            })),
            milestones: this.milestones.map(entry => ({ ...entry })),
            queues: [...this.queues.entries()].map(([label, value]) => ({
                label,
                ...value,
            })),
            tileEvents: this.tileEvents.map(entry => ({ ...entry })),
        };
    }

    // Print the per-layer build table + timeline. Fires once, when the deferred
    // layers finish building.
    reportLayers() {
        if (!this.enabled || this.reported) return;
        this.reported = true;

        const rows = [...this.layers.entries()]
            .map(([name, r]) => ({
                layer: name,
                'sync ms': +r.syncMs.toFixed(1),
                'async ms': r.async ? +r.totalMs.toFixed(1) : '',
            }))
            .sort((a, b) => (b['sync ms']) - (a['sync ms']));
        const syncTotal = rows.reduce((s, r) => s + r['sync ms'], 0);

        console.groupCollapsed(
            `%c[startup-trace ${ts()}] world build — layer beginSession cost  (Σsync ${syncTotal.toFixed(0)}ms across ${rows.length} layers)`,
            'color:#9fe;font-weight:bold');
        if (console.table) console.table(rows);
        else rows.forEach((r) => console.log(`  ${r.layer.padEnd(18)} sync ${r['sync ms']}ms  async ${r['async ms']}`));
        console.log('%ctimeline (ms from build-start):', 'color:#9fe');
        this.milestones.forEach((m) => console.log(`  ${String(Math.round(m.ms)).padStart(6)}ms  ${m.name}`));
        console.log('%cnote:', 'color:#fc6',
            'chunk-queue layers (buildings, roads, cars) do most of their work AFTER beginSession — see the queue summary once streaming settles.');
        console.groupEnd();

        this._maybeSummarise();
    }

    _maybeSummarise() {
        if (!this.enabled || this.summarised || !this.reported) return;
        const labels = [...this.queues.keys()];
        if (labels.length === 0) return;
        if (!labels.every((l) => this.queues.get(l).idle)) return;   // wait until all seen queues idle
        this.summarised = true;

        const qRows = labels.map((l) => {
            const q = this.queues.get(l);
            return {
                queue: l,
                items: q.items,
                'cpu ms': +q.cpuMs.toFixed(0),
                frames: q.flushes,
                'wall ms': +q.lastMs.toFixed(0),
            };
        }).sort((a, b) => b['cpu ms'] - a['cpu ms']);

        const layerSyncCpu = [...this.layers.values()].reduce((s, r) => s + r.syncMs, 0);
        const queueCpu = qRows.reduce((s, r) => s + r['cpu ms'], 0);
        const totalCpu = layerSyncCpu + queueCpu;
        const blockingReady = (this.milestones.find((m) => m.name === 'blocking-ready') || {}).ms || 0;
        const settledWall = Math.max(0, ...labels.map((l) => this.queues.get(l).lastMs),
            ...this.milestones.map((m) => m.ms));

        console.groupCollapsed(`%c[startup-trace ${ts()}] SUMMARY`, 'color:#9fe;font-weight:bold');
        if (console.table) console.table(qRows);
        console.log(
            `%cwall-clock build→interactive : ${blockingReady.toFixed(0)}ms  (blocking/terrain gate to first frame)\n` +
            `wall-clock build→settled     : ${settledWall.toFixed(0)}ms  (all near-field queues drained once)\n` +
            `CPU this code spent          : ${totalCpu.toFixed(0)}ms  (layer sync ${layerSyncCpu.toFixed(0)} + queues ${queueCpu.toFixed(0)})`,
            'color:#9fe');
        const overhead = settledWall - totalCpu;
        console.log('%c→ isolation:', 'color:#fc6',
            `of ~${settledWall.toFixed(0)}ms wall-clock, ~${totalCpu.toFixed(0)}ms was this code's main-thread CPU; ` +
            `the other ~${overhead.toFixed(0)}ms was network waits, frame gaps between chunks, and whatever else the machine was doing. ` +
            `If that gap is large, the choppiness is not this code burning CPU.`);
        console.log('%cqueues keep re-filling as you move — call __s3dStartupReport() any time for a fresh dump.', 'color:#888');
        console.groupEnd();
    }

    // On-demand full dump (queues accumulate as the camera moves).
    dump() {
        if (!this.enabled) { console.log('[startup-trace] disabled (add ?perf to the URL)'); return; }
        // Force a full snapshot even if some queue is still streaming.
        this.queues.forEach((q) => { q.idle = true; });
        this.reported = false;
        this.summarised = false;
        this.reportLayers();   // prints the layer table, then summarises exactly once
    }
}

export const startupTrace = new StartupTrace();

if (typeof window !== 'undefined') {
    window.__s3dStartupReport = () => startupTrace.dump();
}
