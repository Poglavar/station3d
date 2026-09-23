// GPU time of each frame's render through EXT_disjoint_timer_query_webgl2,
// never blocking: a frame's query is read back several frames later, from a
// small reused pool. Results that span a disjoint event (GPU clock or context
// change) are discarded. Without the extension (Safari, Firefox by default)
// nothing is measured and callers must treat GPU time as unknown. Only one
// timer query may be open per context, so external profilers pause this one
// (setEnabled(false)) while they take their own measurements.

export function createGpuFrameTimer(gl, { poolSize = 6, pollBacklog = 3 } = {}) {
    const ext = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2') || null;
    const pending = [];
    const free = [];
    const samples = [];
    let active = null;
    let enabled = true;

    function poll() {
        if (!pending.length) return;
        const disjoint = !!gl.getParameter(ext.GPU_DISJOINT_EXT);
        while (pending.length) {
            const query = pending[0];
            if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
            pending.shift();
            const ns = gl.getQueryParameter(query, gl.QUERY_RESULT);
            if (!disjoint && ns > 0) samples.push(ns / 1e6);
            free.push(query);
        }
        // A disjoint event invalidates every result still in flight too.
        if (disjoint) while (pending.length) free.push(pending.shift());
    }

    return {
        available: !!ext,
        begin() {
            if (!ext || !enabled || active) return;
            if (pending.length >= pollBacklog) poll();
            // Results lag; if the GPU is further behind than the pool, skip timing this frame.
            if (pending.length >= poolSize) return;
            active = free.pop() || gl.createQuery();
            gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
        },
        end() {
            if (!active) return;
            gl.endQuery(ext.TIME_ELAPSED_EXT);
            pending.push(active);
            active = null;
        },
        // Median GPU ms of the frames read back since the last call, or null.
        takeWindow() {
            if (ext && enabled) poll();
            if (!samples.length) return null;
            const sorted = samples.splice(0).sort((a, b) => a - b);
            return { frames: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)] };
        },
        setEnabled(value) {
            enabled = value !== false;
            if (!enabled && active) this.end();
            if (!enabled) { while (pending.length) free.push(pending.shift()); samples.length = 0; }
        },
        dispose() {
            if (active) this.end();
            for (const query of [...pending, ...free]) gl.deleteQuery(query);
            pending.length = free.length = samples.length = 0;
        },
    };
}
