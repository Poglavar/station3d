// Admission for overlapping building geometry generations, not a whole-world
// memory cap. Separate near/far lanes preserve near progress while far prewarm
// waits for a stop. Published storage stays counted until its actual retirement.
export function createGeometryMemoryBudget({ nearBytes, farBytes }) {
    const limits = { near: nearBytes, far: farBytes };
    for (const value of Object.values(limits)) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Invalid geometry byte allowance');
    }
    const waiting = { near: new Set(), far: new Set() };
    const states = Object.fromEntries(['waiting', 'candidate', 'resident', 'source'].map(state =>
        [state, { count: 0, cpuBytes: 0, gpuBytes: 0 }]));
    const lanes = Object.fromEntries(Object.keys(limits).map(lane =>
        [lane, { limitBytes: limits[lane], candidateBytes: 0, candidateCount: 0,
            admissions: 0, waits: 0, oversizedAdmissions: 0 }]));
    let peakEstimatedBytes = 0, admissions = 0, waits = 0, oversizedAdmissions = 0;

    function adjust(record, sign) {
        const total = states[record.state];
        total.count += sign;
        total.cpuBytes += sign * record.cpuBytes;
        total.gpuBytes += sign * record.gpuBytes;
        if (record.state === 'candidate') {
            lanes[record.lane].candidateBytes += sign * (record.cpuBytes + record.gpuBytes);
            lanes[record.lane].candidateCount += sign;
        }
        const held = ['candidate', 'resident', 'source'].reduce((sum, state) =>
            sum + states[state].cpuBytes + states[state].gpuBytes, 0);
        peakEstimatedBytes = Math.max(peakEstimatedBytes, held);
    }

    function create({ lane, key, cpuBytes, gpuBytes }, source) {
        if (!lanes[lane]) throw new TypeError('Unknown geometry memory lane');
        if (typeof key !== 'string' || !key) throw new TypeError('Geometry memory owner needs a key');
        for (const bytes of [cpuBytes, gpuBytes, cpuBytes + gpuBytes]) {
            if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid geometry byte estimate');
        }
        const record = { lane, key, cpuBytes, gpuBytes, state: source ? 'source' : 'waiting' };
        if (!source) waiting[lane].add(record);
        adjust(record, 1);
        const transition = state => {
            adjust(record, -1);
            if (record.state === 'waiting') waiting[lane].delete(record);
            record.state = state;
            adjust(record, 1);
        };
        let waited = false;
        return Object.freeze({
            tryAcquire() {
                if (record.state === 'released') throw new Error('Geometry reservation was released');
                if (record.state !== 'waiting') return true;
                const laneState = lanes[lane];
                const bytes = cpuBytes + gpuBytes;
                const oldest = waiting[lane].values().next().value;
                // Never strand an indivisible legacy bucket forever. An
                // oversized item runs ALONE in its lane and is explicitly
                // counted, not misreported as obeying a hard ceiling.
                const fits = laneState.candidateBytes + bytes <= laneState.limitBytes;
                if (oldest !== record || (!fits && laneState.candidateCount > 0)) {
                    if (!waited) { waits++; laneState.waits++; waited = true; }
                    return false;
                }
                if (!fits) { oversizedAdmissions++; laneState.oversizedAdmissions++; }
                transition('candidate');
                admissions++;
                laneState.admissions++;
                return true;
            },
            publish() {
                if (record.state === 'resident') return;
                if (record.state !== 'candidate') throw new Error('Only admitted geometry may publish');
                transition('resident');
            },
            release() {
                if (record.state === 'released') return;
                adjust(record, -1);
                waiting[lane].delete(record);
                record.state = 'released';
            },
            get state() { return record.state; },
        });
    }

    return Object.freeze({
        request: options => create(options, false),
        // Incoming transferred packet buffers already exist. Track them
        // separately from future allocation; do not pretend to pre-admit them.
        trackSource: options => create(options, true),
        snapshot() {
            const snapshot = Object.fromEntries(Object.entries(states).map(([state, value]) => [state, { ...value }]));
            return {
                ...snapshot,
                lanes: Object.fromEntries(Object.entries(lanes).map(([lane, value]) => [lane, { ...value }])),
                estimatedBytes: ['candidate', 'resident', 'source'].reduce((sum, state) =>
                    sum + states[state].cpuBytes + states[state].gpuBytes, 0),
                peakEstimatedBytes, admissions, waits, oversizedAdmissions,
            };
        },
    });
}

// First bounded slice: 32 MiB of candidate CPU+GPU estimates per lane. Source
// rows, terrain/road/rail/decor resources and facade textures have other owners;
// these limits must never be advertised as total browser/GPU memory limits.
export const buildingGeometryMemory = createGeometryMemoryBudget({
    nearBytes: 32 * 1024 * 1024,
    farBytes: 32 * 1024 * 1024,
});

const bindings = new WeakMap();
export function bindGeometryMemory(resource, reservation, { disposeEvent = false } = {}) {
    if (!reservation) return;
    if (bindings.has(resource)) throw new Error('Geometry memory owner already bound');
    bindings.set(resource, reservation);
    if (disposeEvent) {
        const disposed = () => {
            resource.removeEventListener('dispose', disposed);
            releaseGeometryMemory(resource);
        };
        resource.addEventListener('dispose', disposed);
    }
}
export function publishGeometryMemory(resource) { bindings.get(resource)?.publish(); }
export function releaseGeometryMemory(resource) {
    bindings.get(resource)?.release();
    bindings.delete(resource);
}
