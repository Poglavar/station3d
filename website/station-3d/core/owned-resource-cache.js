// Byte-accounted warm cache: explicit borrowers pin entries; only unused entries
// may retire. Bookkeeping is incremental, with bounded eviction at the caller's gate.
export function createOwnedResourceCache({ maxIdleBytes, now = () => performance.now() }) {
    if (!Number.isSafeInteger(maxIdleBytes) || maxIdleBytes < 0) throw new RangeError('Invalid idle byte budget');
    if (typeof now !== 'function') throw new TypeError('Resource cache clock must be callable');
    const entries = new Map();
    const byValue = new WeakMap();
    const idle = new Map();
    const owners = new Map();
    let cpuBytes = 0, gpuBytes = 0, idleBytes = 0, references = 0;
    let created = 0, evicted = 0, hits = 0, peakBytes = 0;
    let peakIdleBytes = 0, peakPinnedBytes = 0;

    function getOrCreate(key, create) {
        let entry = entries.get(key);
        if (entry) {
            hits++;
            if (entry.refs === 0) { idle.delete(key); idle.set(key, entry); }
            return entry.value;
        }
        const resource = create();
        for (const bytes of [resource.cpuBytes, resource.gpuBytes]) {
            if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid resource byte estimate');
        }
        if (!resource.value || typeof resource.value !== 'object' || typeof resource.dispose !== 'function') {
            throw new TypeError('Resource needs an object value and a disposer');
        }
        if (byValue.has(resource.value)) throw new Error('Resource already cached under another key');
        entry = { ...resource, key, refs: 0, owners: new Map(), bytes: resource.cpuBytes + resource.gpuBytes };
        entries.set(key, entry);
        byValue.set(entry.value, entry);
        idle.set(key, entry);
        cpuBytes += entry.cpuBytes;
        gpuBytes += entry.gpuBytes;
        idleBytes += entry.bytes;
        peakBytes = Math.max(peakBytes, cpuBytes + gpuBytes);
        peakIdleBytes = Math.max(peakIdleBytes, idleBytes);
        created++;
        return entry.value;
    }

    function retain(value, owner) {
        const entry = byValue.get(value);
        if (!entry) return null; // The caller may also handle unrelated shared materials.
        if (typeof owner !== 'string' || !owner) throw new TypeError('Resource owner must be named');
        if (entry.refs++ === 0) { idle.delete(entry.key); idleBytes -= entry.bytes; }
        peakPinnedBytes = Math.max(peakPinnedBytes, cpuBytes + gpuBytes - idleBytes);
        references++;
        owners.set(owner, (owners.get(owner) || 0) + 1);
        entry.owners.set(owner, (entry.owners.get(owner) || 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            references--;
            const count = owners.get(owner) - 1;
            if (count === 0) owners.delete(owner); else owners.set(owner, count);
            const entryCount = entry.owners.get(owner) - 1;
            if (entryCount === 0) entry.owners.delete(owner); else entry.owners.set(owner, entryCount);
            if (--entry.refs === 0) {
                idle.set(entry.key, entry);
                idleBytes += entry.bytes;
                peakIdleBytes = Math.max(peakIdleBytes, idleBytes);
            }
        };
    }

    function evict(entry) {
        if (entry.refs !== 0) throw new Error('Cannot evict an owned resource');
        entry.dispose();
        idle.delete(entry.key);
        entries.delete(entry.key);
        byValue.delete(entry.value);
        cpuBytes -= entry.cpuBytes;
        gpuBytes -= entry.gpuBytes;
        idleBytes -= entry.bytes;
        evicted++;
    }

    function trim(maxEntries = 1, timeBudgetMs = Infinity) {
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new RangeError('Invalid eviction work limit');
        if (!(timeBudgetMs >= 0) || typeof timeBudgetMs !== 'number') throw new RangeError('Invalid eviction time budget');
        const deadline = timeBudgetMs === Infinity ? Infinity : now() + timeBudgetMs;
        let count = 0;
        while (idleBytes > maxIdleBytes && count < maxEntries && (deadline === Infinity || now() < deadline)) {
            evict(idle.values().next().value);
            count++;
        }
        return count;
    }

    function clear() {
        if (references !== 0) throw new Error(`Resource cache still has ${references} owners at teardown`);
        for (const entry of idle.values()) evict(entry);
    }

    function snapshot({ includeEntries = false } = {}) {
        return {
            entries: entries.size, idleEntries: idle.size, references,
            owners: Object.fromEntries(owners), estimatedCanvasBytes: cpuBytes,
            estimatedTextureBytes: gpuBytes, estimatedBytes: cpuBytes + gpuBytes,
            pinnedBytes: cpuBytes + gpuBytes - idleBytes, idleBytes, maxIdleBytes,
            evictionPendingBytes: Math.max(0, idleBytes - maxIdleBytes),
            created, evicted, hits, peakEstimatedBytes: peakBytes,
            peakIdleBytes, peakPinnedBytes,
            // Detailed ownership is diagnostic-only, never a per-frame scan.
            ...(includeEntries ? { entryDetails: Array.from(entries.values(), entry => ({
                key: entry.key,
                references: entry.refs,
                owners: Object.fromEntries(entry.owners),
                idle: entry.refs === 0,
                estimatedCanvasBytes: entry.cpuBytes,
                estimatedTextureBytes: entry.gpuBytes,
                estimatedBytes: entry.bytes,
            })) } : {}),
        };
    }
    return { getOrCreate, retain, trim, clear, snapshot };
}

// An individual/staged/retiring mesh pins its material until its geometry is
// actually disposed. Reapplying a passage variant must not add another owner.
export function createMeshResourceBindings(cache) {
    const bindings = new WeakMap();
    return function bind(mesh, value) {
        const previous = bindings.get(mesh);
        if (previous?.value === value && previous.geometry === mesh.geometry) return;
        const release = cache.retain(value, 'mesh');
        previous?.dispose();
        if (!release) return;
        const geometry = mesh.geometry;
        if (!geometry?.addEventListener) {
            release();
            throw new TypeError('Owned mesh resource requires a disposable geometry');
        }
        const binding = { value, geometry, dispose() {
            geometry.removeEventListener('dispose', binding.dispose);
            bindings.delete(mesh);
            release();
        } };
        bindings.set(mesh, binding);
        geometry.addEventListener('dispose', binding.dispose);
    };
}
