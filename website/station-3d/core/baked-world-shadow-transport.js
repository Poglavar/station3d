// Local pilot transport: a shared network slot, bounded bodies and one owned decode Worker.
const abortError = () => new DOMException('Baked shadow session cancelled', 'AbortError');

export async function readBoundedWorldResponse(response, maxBytes) {
    if (!response.ok) {
        const error = new Error(`Baked world HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    if (!response.body?.getReader) throw new Error('Streaming response body is required');
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maxBytes) throw new Error('Baked world response exceeds its byte bound');
            chunks.push(value);
        }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
}

export function createWorldBakeShadowTransport({ baseUrl, scheduleNetworkRequest, mode = 'shadow', WorkerClass = globalThis.Worker, fetchFn = globalThis.fetch }) {
    const workerUrl = globalThis.window?.__station3DAssetConfig?.bakedWorldShadowWorkerUrl
        || new URL('./baked-world-shadow-worker.js', import.meta.url);
    const worker = new WorkerClass(workerUrl, { type: 'module', name: `station3d-bake-${mode}` });
    const pending = new Map();
    let nextId = 0, disposed = false;
    function dispose(reason = abortError()) {
        if (disposed) return;
        disposed = true; worker.terminate();
        for (const job of pending.values()) { clearTimeout(job.timer); job.reject(reason); }
        pending.clear();
    }
    worker.onmessage = ({ data }) => {
        const job = pending.get(data.id);
        if (!job) return;
        pending.delete(data.id); clearTimeout(job.timer);
        if (data.error) job.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
        else job.resolve(data.value);
    };
    worker.onerror = event => dispose(new Error(event.message || 'Baked shadow Worker failed'));
    function request(kind, fields = {}, transfer = []) {
        if (disposed) return Promise.reject(abortError());
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => dispose(new Error('Baked shadow Worker timed out')), 15000);
            pending.set(id, { resolve, reject, timer });
            try { worker.postMessage({ id, kind, ...fields }, transfer); }
            catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
        });
    }
    async function fetchBytes(path, maxBytes, signal, alreadyScheduled = false) {
        if (disposed || signal.aborted) throw abortError();
        const schedule = alreadyScheduled ? options => options.run() : scheduleNetworkRequest;
        return schedule({ label: `world-bake-${mode}`, groupKey: `world-bake-${mode}`, groupLimit: 1,
            supportLane: false, priority: { tier: 'background' }, signal,
            run: async () => {
                const controller = new AbortController();
                const abort = () => controller.abort(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
                const timeout = setTimeout(() => controller.abort(new Error('Baked shadow transfer timed out')), 12000);
                try {
                    if (signal.aborted) abort();
                    return await readBoundedWorldResponse(await fetchFn(new URL(path, baseUrl), {
                        signal: controller.signal, cache: 'no-store', credentials: 'omit',
                    }), maxBytes);
                } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
            },
        });
    }
    return {
        async manifest(config, expected, signal) {
            const path = `/api/station3d/manifest?location=${encodeURIComponent(config.location)}&release=${encodeURIComponent(config.releaseId)}`;
            const bytes = await fetchBytes(path, 8 * 1024 * 1024, signal);
            if (signal.aborted) throw abortError();
            return request('manifest', { bytes, expected }, [bytes]);
        },
        async tile(descriptor, signal, { alreadyScheduled = false } = {}) {
            const bytes = await fetchBytes(descriptor.url, descriptor.byteLength, signal, alreadyScheduled);
            if (signal.aborted) throw abortError();
            if (bytes.byteLength !== descriptor.byteLength) throw new Error('Baked tile byte count disagrees with manifest');
            return request('tile', { bytes, descriptor, transferTile: mode === 'authority' }, [bytes]);
        },
        retain: keys => request('retain', { keys }),
        compare: evidence => request('compare', { evidence }),
        dispose,
        state: () => ({ workers: disposed ? 0 : 1, pending: pending.size }),
    };
}
