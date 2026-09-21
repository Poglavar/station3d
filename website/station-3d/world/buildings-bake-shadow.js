// Thin session adapter for local-only baked diagnostics or visible far authority.
// Both use the shared world's terrain, source lifecycle and publication rules.
import { resolveWorldBakeShadowConfig, createBakedWorldShadowSession } from '../core/baked-world-shadow-session.js';
import { createWorldBakeShadowTransport } from '../core/baked-world-shadow-transport.js';
import { createBakedFarAuthoritySession } from '../core/baked-far-authority-session.js';
import { buildingGeometryMemory } from '../core/geometry-memory-budget.js';

export function createFarBuildingBakeShadow(ctx, url = new URL(window.location.href)) {
    const disabled = error => {
        console.warn('[world-bake-shadow]', error.message);
        return { start() {}, updatePose() {}, dispose() {}, observeSource() {}, observeSelection() {}, evictSource() {},
            debugState: () => ({ mode: 'shadow', phase: 'disabled', errors: [error.message], workers: 0 }) };
    };
    let transport;
    try {
        const config = resolveWorldBakeShadowConfig(url);
        if (!config) return null;
        transport = createWorldBakeShadowTransport({ baseUrl: config.baseUrl, mode: config.mode || 'shadow',
            scheduleNetworkRequest: options => ctx.sharedTileSession.scheduleNetworkRequest(options) });
        const session = config.mode === 'authority' ? createBakedFarAuthoritySession({ config, transport,
            signal: ctx.fetchController.signal, memoryBudget: buildingGeometryMemory,
            onError: error => console.warn(`[${new Date().toISOString()}] [world-bake-authority] live fallback: ${error.message}`),
        }) : createBakedWorldShadowSession({ config, transport, signal: ctx.fetchController.signal,
            nextSlice: signal => new Promise((resolve, reject) => {
                if (signal.aborted) { reject(signal.reason); return; }
                const abort = () => { cancelAnimationFrame(frame); reject(signal.reason); };
                const frame = requestAnimationFrame(() => { signal.removeEventListener('abort', abort); resolve(); });
                signal.addEventListener('abort', abort, { once: true });
            }),
        });
        session.updatePose({ lat: ctx.anchorLat, lon: ctx.anchorLon });
        void session.start();
        return session;
    } catch (error) {
        // An optional diagnostic cannot prevent the ordinary world opening,
        // including when Worker construction is refused before any RPC exists.
        transport?.dispose();
        return disabled(error);
    }
}
