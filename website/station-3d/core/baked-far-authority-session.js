// Local-only visible pilot: pin a release, replace completely covered local
// source tiles, and release decoded geometry with the ordinary keep-ring.
import { bakedWorldTileKey, validateWorldManifest } from './baked-world-manifest.js';
import { FAR_SHADOW_COMPATIBILITY } from './baked-world-shadow-session.js';
import { bakedFarCoverage, selectBakedFarFeatures, prepareBakedFarPacket } from './baked-far-authority.js';
import { renderPacketTransferables } from './render-packet.js';

const aborted = () => new DOMException('Baked authority session cancelled', 'AbortError');
export function createBakedFarAuthoritySession({ config, transport, signal, memoryBudget = null, onError = () => {} }) {
    const lifetime = new AbortController(), cache = new Map(), failures = new Map(), routes = new Map();
    let manifest = null, startup = null, closed = false, phase = 'created';
    let selections = new WeakMap();
    const errors = [], counters = { requests: 0, loaded: 0, evicted: 0, bakedLoads: 0, liveLoads: 0, packetSelections: 0 };
    function report(error) {
        if (errors.length < 12) errors.push(error.message);
        onError(error);
    }
    function check(entrySignal) {
        if (closed || entrySignal?.aborted) throw entrySignal?.reason || aborted();
    }
    function release(tileKey, expected = null) {
        const route = routes.get(tileKey);
        if (!route || expected && expected !== route) return;
        routes.delete(tileKey);
        for (const key of route.keys || []) {
            const entry = cache.get(key);
            if (!entry) continue;
            entry.owners.delete(tileKey);
            if (!entry.owners.size) {
                entry.controller.abort(); entry.memory?.release(); cache.delete(key); counters.evicted++;
            }
        }
    }
    function start() {
        if (startup) return startup;
        if (closed) return Promise.resolve();
        phase = 'manifest';
        const expected = { location: config.location, releaseId: config.releaseId, layers: FAR_SHADOW_COMPATIBILITY };
        startup = transport.manifest(config, expected, lifetime.signal).then(value => {
            check(); manifest = validateWorldManifest(value, expected); phase = 'authority';
        }).catch(error => {
            if (!closed) { phase = 'live-fallback'; report(error); }
        });
        return startup;
    }
    function acquire(descriptor, tileKey) {
        const key = bakedWorldTileKey(descriptor);
        if (failures.has(key)) return Promise.reject(new Error(failures.get(key)));
        let entry = cache.get(key);
        if (!entry) {
            if (cache.size >= 9) throw new Error('Baked pilot exceeded its nine-tile decoded working set');
            entry = { owners: new Set(), controller: new AbortController(), memory: null, bytes: 0, loaded: false };
            cache.set(key, entry); counters.requests++;
            // loadPayload already owns a SharedTileSession request slot. Taking
            // a second slot here could deadlock a saturated streaming scheduler.
            entry.promise = transport.tile(descriptor, entry.controller.signal, { alreadyScheduled: true }).then(indexed => {
                check(entry.controller.signal);
                if (cache.get(key) !== entry) throw aborted();
                entry.bytes = renderPacketTransferables(indexed.tile.packet).reduce((sum, buffer) => sum + buffer.byteLength, 0);
                entry.memory = memoryBudget?.trackSource({ lane: 'far', key: `baked:${key}`, cpuBytes: entry.bytes, gpuBytes: 0 });
                entry.loaded = true; counters.loaded++;
                return indexed;
            }).catch(error => {
                if (!closed && !entry.controller.signal.aborted) failures.set(key, error.message);
                throw error;
            });
        }
        entry.owners.add(tileKey);
        return entry.promise;
    }
    async function loadPayload({ bbox, tileKey, signal: entrySignal, loadLive }) {
        await start(); check(entrySignal);
        release(tileKey);
        const descriptors = manifest && bakedFarCoverage(manifest, bbox);
        const route = { kind: 'loading', keys: descriptors?.map(bakedWorldTileKey) || [], reason: null };
        routes.set(tileKey, route);
        const abort = () => release(tileKey, route);
        entrySignal.addEventListener('abort', abort, { once: true });
        try {
            if (descriptors) {
                try {
                    const indexed = [];
                    for (const descriptor of descriptors) {
                        check(entrySignal);
                        indexed.push(await acquire(descriptor, tileKey));
                    }
                    check(entrySignal);
                    const selection = selectBakedFarFeatures(indexed, bbox);
                    selections.set(selection.features, selection);
                    route.kind = 'baked'; route.entities = selection.features.length;
                    counters.bakedLoads++;
                    return { type: 'FeatureCollection', features: selection.features };
                } catch (error) {
                    check(entrySignal);
                    // Any failed baked key (including transport errors) stays
                    // live until reload in this bounded pilot. Never publish an
                    // empty success or start a per-frame baked retry loop.
                    report(error); release(tileKey, route);
                    route.keys = []; route.reason = error.message; routes.set(tileKey, route);
                }
            } else route.reason = manifest ? 'outside-complete-baked-coverage' : 'manifest-unavailable';
            check(entrySignal); route.kind = 'live'; counters.liveLoads++;
            return await loadLive();
        } finally {
            entrySignal.removeEventListener('abort', abort);
            if (closed || entrySignal.aborted) release(tileKey, route);
        }
    }
    function dispose() {
        if (closed) return;
        closed = true; phase = 'closed'; lifetime.abort();
        for (const key of [...routes.keys()]) release(key);
        cache.clear(); failures.clear(); selections = new WeakMap(); transport.dispose();
        signal?.removeEventListener('abort', dispose);
    }
    if (signal?.aborted) dispose();
    else signal?.addEventListener('abort', dispose, { once: true });
    return {
        mode: 'authority', sourceBaseUrl: config.sourceBaseUrl || null,
        start, loadPayload, dispose, evictSource: release,
        updatePose() {}, observeSource() {}, observeSelection() {},
        packetFor(request, features) {
            const selection = selections.get(features);
            if (!selection || closed) return null;
            const result = prepareBakedFarPacket(request, selection);
            counters.packetSelections++;
            return { ...result, releaseId: config.releaseId };
        },
        debugState() {
            return { mode: 'authority', phase, releaseId: config.releaseId,
                selectionPolicy: 'geographic-bounds/frozen-priority-600/id-ties',
                tiles: [...routes].map(([key, route]) => ({ key, ...route })),
                loaded: [...cache].filter(([, entry]) => entry.loaded).map(([key]) => key),
                retainedPacketBytes: [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0),
                failed: [...failures], counters: { ...counters }, errors: [...errors], ...transport.state() };
        },
    };
}
