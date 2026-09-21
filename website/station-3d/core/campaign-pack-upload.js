// Uploads a baked campaign level's render packets into the scene behind the
// opaque loading curtain. The level is not streamed work competing with an
// interactive frame — nothing is visible until every packet is in — so it is
// built in large cooperative slices: primitives are appended until the slice
// elapses, then the loop yields one frame so the curtain can paint its
// progress bar and an abort can land. Routing this through the frame-chunk
// scheduler's 1 ms loading-phase delivery budget once stretched a five-second
// build into a hundred-second curtain.
export const CAMPAIGN_PACK_UPLOAD_SLICE_MS = 40;
// A hidden or occluded window stops animation frames; the build must not.
const FRAME_YIELD_FALLBACK_MS = 250;

function abortError() {
    const error = new Error('Campaign pack upload aborted');
    error.name = 'AbortError';
    return error;
}

export function yieldCampaignPackUploadFrame() {
    return new Promise(resolve => {
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf !== 'function') { setTimeout(resolve, 0); return; }
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        const frameId = raf(() => { clearTimeout(timer); done(); });
        const timer = setTimeout(() => { globalThis.cancelAnimationFrame?.(frameId); done(); }, FRAME_YIELD_FALLBACK_MS);
    });
}

export async function uploadCampaignPackPackets(entries, {
    createTask,
    publish,
    signal,
    onProgress = null,
    sliceMs = CAMPAIGN_PACK_UPLOAD_SLICE_MS,
    yieldFrame = yieldCampaignPackUploadFrame,
    now = () => performance.now(),
} = {}) {
    signal?.throwIfAborted();
    const total = entries.length;
    let uploaded = 0;
    let task = null;
    let sliceStartedAt = now();
    const throwIfAborted = () => { if (signal?.aborted) throw abortError(); };
    // The slice check stays synchronous so a slice really holds the thread;
    // only an elapsed slice awaits a frame.
    const sliceElapsed = () => now() - sliceStartedAt >= sliceMs;
    const yieldSlice = async () => {
        await yieldFrame();
        throwIfAborted();
        sliceStartedAt = now();
    };
    try {
        for (let index = 0; index < total; index++) {
            const entry = entries[index];
            throwIfAborted();
            task = createTask(entry);
            while (!task.step(1)) if (sliceElapsed()) await yieldSlice();
            const result = task.result();
            task = null;
            publish(result, entry);
            uploaded += 1;
            onProgress?.({ uploaded, total });
            if (index < total - 1 && sliceElapsed()) await yieldSlice();
        }
        // The caller publishes the world after this resolves; an abort that
        // arrives during the last slice must still stop it.
        await yieldFrame();
        throwIfAborted();
    } finally {
        task?.dispose?.();
    }
}
