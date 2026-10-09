// Browser process CPU accounting. These counters are scheduled CPU time across
// all browser threads; they do not measure GPU execution or engine-only work.

const validTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validCpuTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function invalidResult(reasons, elapsedMs = null) {
    return {
        valid: false,
        reasons,
        elapsedMs,
        totalCpuSeconds: null,
        perType: null,
        millisecondsPerFrame: null,
        secondsPerMeter: null,
    };
}

/**
 * Summarize cumulative CPU-time counters for one stable browser process set.
 * Metrics are null unless both snapshots form a valid, gap-free window.
 */
export function summarizeBrowserCpuWindow(start, end, options = {}) {
    const reasons = [];
    const addReason = message => { if (!reasons.includes(message)) reasons.push(message); };
    const optionsValid = options !== null && typeof options === 'object' && !Array.isArray(options);
    if (!optionsValid) addReason('CPU window options are invalid');
    const { frameCount, distanceM } = optionsValid ? options : {};
    const validSnapshot = (snapshot, name) => {
        let valid = true;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
            addReason(`${name} snapshot is invalid`);
            return false;
        }
        if (!validTime(snapshot.at)) { addReason(`${name} timestamp is missing or invalid`); valid = false; }
        if (typeof snapshot.error === 'string' && snapshot.error.length > 0) {
            addReason(`${name} snapshot has a collection error`);
            valid = false;
        }
        if (!Array.isArray(snapshot.processes)) {
            addReason(`${name} process list is missing or invalid`);
            return false;
        }
        if (snapshot.processes.length === 0) {
            addReason(`${name} process list is empty`);
            valid = false;
        }
        const ids = new Set();
        for (let i = 0; i < snapshot.processes.length; i++) {
            const processInfo = snapshot.processes[i];
            if (!processInfo || typeof processInfo !== 'object' || Array.isArray(processInfo)
                || (typeof processInfo.id !== 'number' && typeof processInfo.id !== 'string')
                || String(processInfo.id).length === 0
                || (typeof processInfo.id === 'number' && (!Number.isFinite(processInfo.id) || processInfo.id < 0))
                || (typeof processInfo.id === 'string' && processInfo.id.trim().length === 0)
                || typeof processInfo.type !== 'string' || processInfo.type.length === 0
                || !validCpuTime(processInfo.cpuTime)) {
                addReason(`${name} process ${i} is malformed`);
                valid = false;
                continue;
            }
            const id = String(processInfo.id);
            if (ids.has(id)) {
                addReason(`${name} process IDs are duplicated`);
                valid = false;
            }
            ids.add(id);
        }
        return valid;
    };

    const startValid = validSnapshot(start, 'start');
    const endValid = validSnapshot(end, 'end');
    const elapsedMs = start && end && validTime(start.at) && validTime(end.at) ? end.at - start.at : null;
    if (elapsedMs !== null && elapsedMs <= 0) addReason('CPU snapshot timestamps do not advance');

    const validFrameCount = frameCount === undefined || (typeof frameCount === 'number' && Number.isFinite(frameCount) && frameCount > 0);
    const validDistance = distanceM === undefined || (typeof distanceM === 'number' && Number.isFinite(distanceM) && distanceM > 0);
    if (!validFrameCount) addReason('frameCount must be finite and positive');
    if (!validDistance) addReason('distanceM must be finite and positive');

    if (startValid && endValid) {
        const startById = new Map(start.processes.map(processInfo => [String(processInfo.id), processInfo]));
        const endById = new Map(end.processes.map(processInfo => [String(processInfo.id), processInfo]));
        if (startById.size !== endById.size || [...startById.keys()].some(id => !endById.has(id))) {
            addReason('browser process membership changed during the CPU window');
        } else {
            let typeChanged = false;
            let reset = false;
            for (const [id, initial] of startById) {
                const final = endById.get(id);
                if (initial.type !== final.type) typeChanged = true;
                if (final.cpuTime < initial.cpuTime) reset = true;
            }
            if (typeChanged) addReason('browser process type changed during the CPU window');
            if (reset) addReason('browser process CPU counter reset or decreased');
        }
    }

    if (reasons.length > 0) return invalidResult(reasons, elapsedMs);

    const perType = Object.create(null);
    let totalCpuSeconds = 0;
    for (const [id, initial] of new Map(start.processes.map(processInfo => [String(processInfo.id), processInfo]))) {
        const delta = end.processes.find(processInfo => String(processInfo.id) === id).cpuTime - initial.cpuTime;
        perType[initial.type] = (perType[initial.type] ?? 0) + delta;
        totalCpuSeconds += delta;
    }
    if (!Number.isFinite(totalCpuSeconds) || !Object.values(perType).every(Number.isFinite)) {
        return invalidResult(['browser CPU delta overflowed'], elapsedMs);
    }

    const millisecondsPerFrame = frameCount === undefined ? null : (totalCpuSeconds * 1000) / frameCount;
    const secondsPerMeter = distanceM === undefined ? null : totalCpuSeconds / distanceM;
    if ((millisecondsPerFrame !== null && !Number.isFinite(millisecondsPerFrame))
        || (secondsPerMeter !== null && !Number.isFinite(secondsPerMeter))) {
        return invalidResult(['browser CPU normalized metric overflowed'], elapsedMs);
    }

    return {
        valid: true,
        reasons: [],
        elapsedMs,
        totalCpuSeconds,
        perType,
        millisecondsPerFrame,
        secondsPerMeter,
    };
}

/** Collect one raw SystemInfo.getProcessInfo snapshot without hiding errors. */
export async function readBrowserCpuSnapshot(cdp) {
    const at = Date.now();
    try {
        if (!cdp || typeof cdp.send !== 'function') throw new TypeError('CDP session with send() is required');
        const response = await cdp.send('SystemInfo.getProcessInfo');
        if (!response || !Array.isArray(response.processInfo)) {
            return { at, processes: null, error: 'SystemInfo.getProcessInfo returned no processInfo array' };
        }
        return {
            at,
            processes: response.processInfo.map(processInfo => ({
                id: processInfo?.id,
                type: processInfo?.type,
                cpuTime: processInfo?.cpuTime,
            })),
            error: null,
        };
    } catch (error) {
        return { at, processes: null, error: error instanceof Error ? error.message : String(error) };
    }
}
