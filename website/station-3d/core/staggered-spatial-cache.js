// Caches quantized spatial samples with deterministic per-cell expiry so a
// moving crowd never refreshes every cached support point in the same frame.

import { finiteOrNull } from './math.js';

function positiveNumber(value, fallback) {
    const parsed = finiteOrNull(value);
    return parsed !== null && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hashKey(key) {
    let hash = 2166136261;
    for (let index = 0; index < key.length; index += 1) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function staggeredExpiryMs(
    key,
    nowMs,
    minLifetimeMs,
    jitterMs,
) {
    const minimum = Math.max(0, finiteOrNull(minLifetimeMs) ?? 0);
    const jitter = Math.max(0, Math.floor(finiteOrNull(jitterMs) ?? 0));
    return (finiteOrNull(nowMs) ?? 0) + minimum
        + (jitter > 0 ? hashKey(String(key)) % (jitter + 1) : 0);
}

export function createStaggeredSpatialCache({
    quantM = 0.2,
    minLifetimeMs = 250,
    jitterMs = 250,
    maxEntries = 4096,
    nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
    const quant = positiveNumber(quantM, 0.2);
    const maximum = positiveInteger(maxEntries, 4096);
    const clock = typeof nowMs === 'function' ? nowMs : Date.now;
    const entries = new Map();

    return {
        getOrCompute(x, z, compute) {
            const key = `${Math.round(Number(x) / quant)}|${Math.round(Number(z) / quant)}`;
            const now = finiteOrNull(clock()) ?? Date.now();
            const cached = entries.get(key);
            if (cached && now < cached.expiresAt) return cached.value;
            if (cached) entries.delete(key);
            const value = typeof compute === 'function' ? compute() : undefined;
            if (entries.size >= maximum) {
                const oldestKey = entries.keys().next().value;
                if (oldestKey !== undefined) entries.delete(oldestKey);
            }
            entries.set(key, {
                value,
                expiresAt: staggeredExpiryMs(key, now, minLifetimeMs, jitterMs),
            });
            return value;
        },
        // Keep the last known value available while a revision change fans
        // cache refreshes over a short deterministic window. Clearing the
        // entire cache made every consumer miss on the same animation frame,
        // which is exactly the synchronized spike this cache exists to avoid.
        invalidateStaggered({ minDelayMs = 0, spreadMs = jitterMs } = {}) {
            const now = finiteOrNull(clock()) ?? Date.now();
            const minimum = Math.max(0, finiteOrNull(minDelayMs) ?? 0);
            const spread = Math.max(0, Math.floor(finiteOrNull(spreadMs) ?? 0));
            for (const [key, entry] of entries) {
                entry.expiresAt = staggeredExpiryMs(key, now, minimum, spread);
            }
        },
        clear() {
            entries.clear();
        },
        get size() {
            return entries.size;
        },
    };
}
