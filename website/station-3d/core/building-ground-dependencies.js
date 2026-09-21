// Exact scalar inputs used by surveyed-building foundations. A terrain tile
// publication need not reconstruct its buildings when those inputs are equal.
// Typed chunks have a session-wide ceiling; an incomplete capture never proves
// reuse. No terrain snapshots, meshes or source payloads are retained here.
const STRIDE = 5; // query kind, foundation top, x, z, result
// Match the skirt builder's Number()/finite guard, including null versus NaN.
const canonical = value => Number.isFinite(Number(value)) ? Number(value) : NaN;

export function createBuildingGroundDependencyCache({
    maxSamples = 262144, chunkSamples = 128, checksPerStep = 16,
} = {}) {
    for (const value of [maxSamples, chunkSamples, checksPerStep]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid ground dependency limit');
    }
    const entries = new Map();
    let allocatedSamples = 0, peakSamples = 0, retainedChecks = 0, changedChecks = 0;

    function release(entry) {
        allocatedSamples -= entry.capacity;
        entry.capacity = 0;
        entry.chunks.length = 0;
        entry.count = 0;
        entry.valid = false;
    }
    function remove(key) {
        const entry = entries.get(key);
        if (!entry) return;
        release(entry);
        entries.delete(key);
    }
    return {
        begin(key) {
            remove(key);
            const entry = { chunks: [], count: 0, capacity: 0, valid: true, sealed: false };
            entries.set(key, entry);
            return {
                record(kind, top, x, z, value) {
                    if (!entry.valid || entry.sealed) return value;
                    if (entry.count === entry.capacity) {
                        if (allocatedSamples + chunkSamples > maxSamples) { release(entry); return value; }
                        entry.chunks.push(new Float64Array(chunkSamples * STRIDE));
                        entry.capacity += chunkSamples;
                        allocatedSamples += chunkSamples;
                        peakSamples = Math.max(peakSamples, allocatedSamples);
                    }
                    const chunk = entry.chunks[Math.floor(entry.count / chunkSamples)];
                    const offset = (entry.count++ % chunkSamples) * STRIDE;
                    chunk[offset] = kind; chunk[offset + 1] = top;
                    chunk[offset + 2] = x; chunk[offset + 3] = z;
                    chunk[offset + 4] = canonical(value);
                    return value;
                },
                seal() { if (entry.valid) entry.sealed = true; },
                discard() { if (entries.get(key) === entry) remove(key); },
            };
        },
        has: key => entries.get(key)?.valid === true && entries.get(key)?.sealed === true,
        *checkSteps(key, { sampleGround, sampleRoof, isCurrent = () => true }) {
            const entry = entries.get(key);
            if (!entry?.valid || !entry.sealed) return false;
            const current = () => entries.get(key) === entry && entry.valid && isCurrent();
            for (let index = 0; index < entry.count; index++) {
                if (index % checksPerStep === 0) {
                    if (!current()) return null;
                    if (index) yield { phase: 'building-ground-dependencies', checked: index };
                    if (!current()) return null;
                }
                const chunk = entry.chunks[Math.floor(index / chunkSamples)];
                const offset = (index % chunkSamples) * STRIDE;
                const x = chunk[offset + 2], z = chunk[offset + 3];
                const value = chunk[offset] === 0
                    ? sampleGround(x, z, chunk[offset + 1]) : sampleRoof(x, z);
                if (!Object.is(canonical(value), chunk[offset + 4])) {
                    if (!current()) return null;
                    changedChecks++;
                    return false;
                }
            }
            if (!current()) return null;
            retainedChecks++;
            return true;
        },
        delete: remove,
        clear() {
            for (const entry of entries.values()) release(entry);
            entries.clear();
            peakSamples = 0; retainedChecks = 0; changedChecks = 0;
        },
        snapshot: () => ({ tiles: entries.size, bytes: allocatedSamples * STRIDE * 8,
            peakBytes: peakSamples * STRIDE * 8, maxBytes: maxSamples * STRIDE * 8,
            retainedChecks, changedChecks }),
    };
}
