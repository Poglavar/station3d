// Opt-in shadow lifecycle. Pins a release, bounds work, and only emits diagnostics.
import { bakedWorldTileKey, validateWorldManifest } from './baked-world-manifest.js';
import { worldTileAt } from './world-tile-placement.js';
import { FAR_BUILDING_PACKET_COMPILER_ID, FAR_BUILDING_PACKET_COMPILER_VERSION } from './compilers/far-building-render-packet.js';
import { FAR_BUILDING_BAKE_VERSION } from './compilers/far-building-bake.js';

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export function resolveWorldBakeShadowConfig(url) {
    const mode = url.searchParams.get('worldBake');
    if (mode == null) return null;
    if (!['shadow', 'authority'].includes(mode)) throw new Error('Only shadow and authority baking pilots are enabled');
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error('This baking pilot is loopback-only; staging/production cutovers are not enabled');
    }
    const location = url.searchParams.get('worldBakeLocation'), releaseId = url.searchParams.get('worldBakeRelease');
    const port = Number(url.searchParams.get('worldBakePort'));
    if (!location || !releaseId || !ID.test(location) || !ID.test(releaseId)
        || !Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('Baking requires an explicit location, pinned release and loopback API port');
    }
    const config = { location, releaseId, baseUrl: `http://${url.hostname}:${port}` };
    if (mode === 'authority') config.mode = mode;
    if (url.searchParams.has('worldBakeSourcePort')) {
        const sourcePort = Number(url.searchParams.get('worldBakeSourcePort'));
        if (!Number.isInteger(sourcePort) || sourcePort < 1024 || sourcePort > 65535) throw new Error('Canonical QA source requires a loopback port');
        config.sourceBaseUrl = `http://${url.hostname}:${sourcePort}/api`;
    }
    return config;
}

export const FAR_SHADOW_COMPATIBILITY = Object.freeze({
    'far-buildings': { compilerId: FAR_BUILDING_PACKET_COMPILER_ID, compilerVersion: FAR_BUILDING_PACKET_COMPILER_VERSION,
        bakeVersion: FAR_BUILDING_BAKE_VERSION, lod: 1, z: 15 },
});
const abortError = () => new DOMException('Shadow session closed', 'AbortError');
function mergeReport(target, source) {
    for (const key of ['examined', 'matched', 'outsideCoverage', 'boundaryUnresolved', 'missing', 'changed', 'unsupportedSource', 'topologyChanged']) {
        target[key] = (target[key] || 0) + source[key];
    }
    target.maxVertexDeltaM = Math.max(target.maxVertexDeltaM || 0, source.maxVertexDeltaM);
    target.examples = [...(target.examples || []), ...source.examples].slice(0, 12);
}

export function createBakedWorldShadowSession({ config, transport, signal,
    nextSlice = () => new Promise(resolve => setTimeout(resolve, 0)), chunkSize = 16 } = {}) {
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 32) throw new Error('Shadow evidence chunk must be 1..32 entities');
    let closed = false, started = false, pumping = false, manifest = null, phase = 'created';
    let centre = null, coverageVersion = 0, active = null, neighbours = null, observationSequence = 0;
    let desired = new Map();
    const lifetime = new AbortController(), loaded = new Set(), failed = new Map(), sources = new Map(), reports = new Map();
    const counters = { requests: 0, loaded: 0, cancelled: 0, evicted: 0, comparedChunks: 0 };
    const errors = [];
    function error(message) { if (errors.length < 12) errors.push(String(message)); }
    function markDirty() { for (const value of sources.values()) value.dirty = true; }
    function refreshDesired() {
        if (!manifest || !centre || closed) return;
        const next = new Map(manifest.tiles.filter(tile => Math.abs(tile.tile.x - centre.x) <= 1
            && Math.abs(tile.tile.y - centre.y) <= 1).map(tile => [bakedWorldTileKey(tile), tile]));
        if (next.size === desired.size && [...next.keys()].every(key => desired.has(key))) return;
        desired = next; coverageVersion++; reports.clear(); markDirty();
        if (active && !desired.has(active.key)) active.controller.abort(abortError());
        for (const key of loaded) if (!desired.has(key)) { loaded.delete(key); counters.evicted++; }
        const version = coverageVersion;
        transport.retain([...desired.keys()]).then(value => {
            if (!closed && version === coverageVersion) neighbours = value;
        }, reason => { if (!closed) error(reason.message); });
        void pump();
    }
    async function pump() {
        if (pumping || closed || !manifest || phase === 'failed') return;
        pumping = true;
        try {
            while (!closed) {
                const pending = [...desired].find(([key]) => !loaded.has(key) && !failed.has(key));
                if (pending) {
                    const [key, descriptor] = pending, controller = new AbortController();
                    active = { key, controller }; counters.requests++;
                    try {
                        const value = await transport.tile(descriptor, controller.signal);
                        if (closed) break;
                        if (controller.signal.aborted || !desired.has(key)) {
                            counters.cancelled++;
                            // Decode is bounded but not preemptible. Drop stale Worker data
                            // before starting another tile; closing terminates the Worker.
                            neighbours = await transport.retain([...desired.keys()]);
                        } else {
                            loaded.add(key); counters.loaded++; neighbours = value;
                            coverageVersion++; reports.clear(); markDirty();
                        }
                    } catch (reason) {
                        if (closed) break;
                        if (controller.signal.aborted || !desired.has(key)) counters.cancelled++;
                        else {
                            // Shadow failure never retries on each camera frame, marks a
                            // missing tile empty, or falls back to a browser compiler.
                            failed.set(key, reason.message); error(`${key}: ${reason.message}`);
                        }
                    } finally { active = null; }
                    continue;
                }
                const entry = [...sources.entries()].find(([, value]) => value.dirty);
                if (!entry || loaded.size === 0) break;
                const [key, source] = entry, version = coverageVersion;
                source.dirty = false;
                const result = { kind: source.kind, sourceKey: source.sourceKey, sequence: source.sequence };
                for (let offset = 0; offset < source.features.length; offset += chunkSize) {
                    await nextSlice(lifetime.signal);
                    if (closed || version !== coverageVersion || sources.get(key) !== source) break;
                    let features = source.features.slice(offset, offset + chunkSize);
                    if (source.kind === 'selected') features = features.map((feature, i) => ({ ...feature,
                        sourceProperties: source.sourceFeatures[offset + i].feature.properties }));
                    const chunk = await transport.compare({ kind: source.kind, features, frame: source.frame });
                    if (closed || version !== coverageVersion || sources.get(key) !== source) break;
                    mergeReport(result, chunk); counters.comparedChunks++;
                }
                if (!closed && version === coverageVersion && sources.get(key) === source) reports.set(key, result);
            }
        } catch (reason) { if (!closed) { phase = 'failed'; error(reason.message); } }
        finally { pumping = false; }
    }
    function observe(kind, sourceKey, features, frame = null, sourceFeatures = null) {
        if (closed || !Array.isArray(features)) return;
        const key = `${kind}:${sourceKey}`;
        // References already retained by the live layer; no eager geometry clone.
        // At most the live keep-ring (25 tiles), each with source + selection.
        if (!sources.has(key) && sources.size >= 50) { error('Shadow live evidence exceeded its 25-tile keep-ring bound'); return; }
        sources.set(key, { kind, sourceKey, features, frame, sourceFeatures, sequence: ++observationSequence, dirty: true });
        reports.delete(key); void pump();
    }
    function dispose() {
        if (closed) return;
        closed = true; phase = 'closed'; lifetime.abort(); active?.controller.abort();
        transport.dispose(); signal?.removeEventListener('abort', dispose);
        sources.clear(); reports.clear(); desired.clear(); loaded.clear(); failed.clear(); neighbours = null;
    }
    if (signal?.aborted) dispose();
    else signal?.addEventListener('abort', dispose, { once: true });
    return {
        sourceBaseUrl: config.sourceBaseUrl || null,
        async start() {
            if (closed || started) return;
            started = true; phase = 'manifest';
            try {
                const expected = { location: config.location, releaseId: config.releaseId, layers: FAR_SHADOW_COMPATIBILITY };
                const value = await transport.manifest(config, expected, lifetime.signal);
                if (closed) return;
                manifest = validateWorldManifest(value, expected);
                phase = 'shadow'; refreshDesired();
            } catch (reason) { if (!closed) { phase = 'failed'; error(reason.message); } }
        },
        updatePose({ lon, lat }) {
            if (closed || !Number.isFinite(lon) || !Number.isFinite(lat)) return;
            const next = worldTileAt(lon, lat, 15);
            if (centre?.x === next.x && centre?.y === next.y) return;
            centre = next; refreshDesired();
        },
        observeSource: (key, features) => observe('source', key, features),
        observeSelection: (key, request, features) => observe('selected', key, request.inputs.features, {
            anchorLat: request.inputs.anchorLat, anchorLon: request.inputs.anchorLon,
            tileOriginX: request.inputs.tileOriginX, tileOriginZ: request.inputs.tileOriginZ,
        }, features),
        evictSource(key) {
            for (const kind of ['source', 'selected']) { sources.delete(`${kind}:${key}`); reports.delete(`${kind}:${key}`); }
        },
        dispose,
        debugState() {
            const comparisons = [...reports.values()];
            const comparisonStatus = comparisons.some(report => report.unsupportedSource > 0) ? 'unsupported-live-source'
                : (neighbours?.conflicts > 0 || comparisons.some(report => report.changed > 0 || report.missing > 0)) ? 'mismatch'
                    : comparisons.length > 0 && !pumping ? 'compared-covered-evidence' : 'pending';
            return { mode: 'shadow', phase, releaseId: manifest?.releaseId || config.releaseId,
                sourceMode: config.sourceBaseUrl ? 'canonical-source-qa-only' : 'ordinary-api',
                comparisonStatus,
                centre, desired: [...desired.keys()], loaded: [...loaded], failed: [...failed.entries()],
                active: active?.key || null, pendingEvidence: [...sources.values()].filter(value => value.dirty).length,
                evidenceWorking: pumping && !active, retainedLiveSources: sources.size,
                neighbours, reports: comparisons, counters: { ...counters }, errors: [...errors], ...transport.state() };
        },
    };
}
