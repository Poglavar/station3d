// Native host sampling and pure window validation for performance measurements.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { parseProcVmstat, parseVmStat } from './perf-probe-summary.mjs';
import { readLinuxContentionSample } from './perf-native-linux.mjs';

const finiteNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const counter = value => Number.isSafeInteger(value) && value >= 0;
const MIB = 1024 * 1024;

function validCgroupEvidence(cgroup) {
    return typeof cgroup?.mountPoint === 'string' && cgroup.mountPoint.length > 0
        && typeof cgroup?.cgroupPath === 'string' && cgroup.cgroupPath.startsWith('/')
        && finiteNonnegative(cgroup.effectiveCpuCapacity) && cgroup.effectiveCpuCapacity > 0
        && Array.isArray(cgroup.ancestors) && cgroup.ancestors.length > 0
        && cgroup.ancestors.every(entry => entry && typeof entry.path === 'string' && entry.path.startsWith('/')
            && (entry.cpuCapacity === null || (finiteNonnegative(entry.cpuCapacity) && entry.cpuCapacity > 0))
            && (entry.cpuMaxSetting === null || typeof entry.cpuMaxSetting === 'string')
            && counter(entry.nrThrottled) && counter(entry.throttledUsec));
}

function parseMacPageSize(text) {
    const match = /page size of\s+(\d+)\s+bytes/i.exec(String(text));
    return match ? Number(match[1]) : null;
}

function systemContext() {
    return { cpus: os.cpus()?.length || null, load1: os.loadavg()?.[0] ?? null };
}

export function readNativeHostSample() {
    const sample = {
        at: Date.now(), platform: process.platform, ...systemContext(),
        pageSizeBytes: null, swapins: null, swapouts: null, error: null,
    };
    try {
        if (process.platform === 'darwin') {
            const output = execFileSync('vm_stat', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            const counters = parseVmStat(output);
            sample.pageSizeBytes = parseMacPageSize(output);
            sample.swapins = counters.swapins;
            sample.swapouts = counters.swapouts;
            if (sample.pageSizeBytes === null) sample.error = 'vm_stat page size is unavailable';
        } else if (process.platform === 'linux') {
            const output = readFileSync('/proc/vmstat', 'utf8');
            const counters = parseProcVmstat(output);
            sample.pageSizeBytes = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
            sample.swapins = counters.swapins;
            sample.swapouts = counters.swapouts;
            if (!positiveInteger(sample.pageSizeBytes)) sample.pageSizeBytes = null;
            const contention = readLinuxContentionSample({ readText: file => readFileSync(file, 'utf8'),
                availableCpus: os.availableParallelism?.() });
            sample.procStatTotalTicks = contention.totalTicks;
            sample.stealTicks = contention.stealTicks;
            sample.cgroupV2 = contention.cgroupV2;
            sample.effectiveCpuCapacity = contention.cgroupV2.effectiveCpuCapacity;
        } else {
            sample.error = `unsupported host platform: ${process.platform}`;
        }
        if (sample.swapins === null || sample.swapouts === null || sample.pageSizeBytes === null) {
            sample.error ??= 'native swap counters or page size are unavailable';
        }
    } catch (error) {
        sample.error = error instanceof Error ? error.message : String(error);
    }
    return sample;
}

export function summarizeNativeHostWindow(samples, {
    maxSwapMiBPerSecond = 0.5, maxLoadPerCpu = 1.5, maxGapMs = 7500, maxStealRatio = 0.01,
} = {}) {
    const rows = Array.isArray(samples) ? samples : [];
    const reasons = [];
    const intervals = [];
    const addReason = (condition, message) => { if (!condition && !reasons.includes(message)) reasons.push(message); };
    addReason(Array.isArray(samples), 'samples must be an array');
    addReason(rows.length >= 2, 'at least two host samples are required');
    addReason(finiteNonnegative(maxSwapMiBPerSecond), 'maxSwapMiBPerSecond must be finite and nonnegative');
    addReason(finiteNonnegative(maxLoadPerCpu), 'maxLoadPerCpu must be finite and nonnegative');
    addReason(finiteNonnegative(maxGapMs) && maxGapMs > 0, 'maxGapMs must be finite and positive');
    addReason(finiteNonnegative(maxStealRatio) && maxStealRatio <= 1, 'maxStealRatio must be between 0 and 1');

    let elapsedMs = null;
    if (rows.length >= 2 && finiteNonnegative(rows[0]?.at) && finiteNonnegative(rows.at(-1)?.at)) {
        elapsedMs = rows.at(-1).at - rows[0].at;
        addReason(elapsedMs > 0, 'host sample timestamps do not advance');
    }

    let pageSize = null;
    let cpus = null;
    let peakLoadPerCpu = null;
    let swapInTotal = 0;
    let swapOutTotal = 0;
    let allSwapDeltasKnown = rows.length >= 2;
    let platform = null;
    let effectiveCpuCapacity = null;
    let peakStealRatio = null;
    let allLinuxContentionKnown = rows.length >= 2;
    let observedCgroupThrottle = false;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        addReason(row && typeof row === 'object' && !Array.isArray(row), `sample ${i} is invalid`);
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            allSwapDeltasKnown = false;
            if (platform === 'linux') allLinuxContentionKnown = false;
            if (i > 0) {
                const previous = rows[i - 1];
                const intervalElapsedMs = previous && typeof previous === 'object' && !Array.isArray(previous)
                    && finiteNonnegative(row?.at) && finiteNonnegative(previous.at) ? row.at - previous.at : null;
                intervals.push({ elapsedMs: intervalElapsedMs, swapInBytes: null, swapOutBytes: null, swapMiBPerSecond: null });
            }
            continue;
        }
        addReason(finiteNonnegative(row.at), `sample ${i} timestamp is missing or invalid`);
        addReason(positiveInteger(row.pageSizeBytes), `sample ${i} page size is missing or invalid`);
        addReason(Number.isInteger(row.cpus) && row.cpus > 0, `sample ${i} CPU count is missing or invalid`);
        addReason(finiteNonnegative(row.load1), `sample ${i} load average is missing or invalid`);
        addReason(counter(row.swapins), `sample ${i} swap-in counter is missing or invalid`);
        addReason(counter(row.swapouts), `sample ${i} swap-out counter is missing or invalid`);
        addReason(row.error === null || row.error === undefined, `sample ${i} has a native sampling error`);
        if (platform === null) platform = row.platform;
        else addReason(row.platform === platform, 'host samples use inconsistent platforms');

        if (positiveInteger(row.pageSizeBytes)) {
            if (pageSize === null) pageSize = row.pageSizeBytes;
            else addReason(row.pageSizeBytes === pageSize, 'host samples use inconsistent page sizes');
        }
        if (Number.isInteger(row.cpus) && row.cpus > 0) {
            if (cpus === null) cpus = row.cpus;
            else addReason(row.cpus === cpus, 'host samples use inconsistent CPU counts');
        }
        if (finiteNonnegative(row.load1) && Number.isInteger(row.cpus) && row.cpus > 0) {
            const ratio = row.load1 / row.cpus;
            peakLoadPerCpu = peakLoadPerCpu === null ? ratio : Math.max(peakLoadPerCpu, ratio);
            addReason(ratio <= maxLoadPerCpu, `host load per CPU ${ratio.toFixed(3)} exceeds ${maxLoadPerCpu}`);
        }

        if (row.platform === 'linux') {
            const cg = row.cgroupV2;
            const cgroupValid = validCgroupEvidence(cg);
            addReason(counter(row.procStatTotalTicks), `sample ${i} /proc/stat CPU ticks are missing or invalid`);
            addReason(counter(row.stealTicks), `sample ${i} /proc/stat steal ticks are missing or invalid`);
            addReason(cgroupValid,
                `sample ${i} cgroup v2 contention evidence is missing or invalid`);
            addReason(finiteNonnegative(row.effectiveCpuCapacity) && row.effectiveCpuCapacity > 0,
                `sample ${i} effective CPU capacity is missing or invalid`);
            if (finiteNonnegative(row.effectiveCpuCapacity) && row.effectiveCpuCapacity > 0) {
                effectiveCpuCapacity = effectiveCpuCapacity === null ? row.effectiveCpuCapacity
                    : Math.min(effectiveCpuCapacity, row.effectiveCpuCapacity);
            }
            if (!counter(row.procStatTotalTicks) || !counter(row.stealTicks) || !cgroupValid) allLinuxContentionKnown = false;
        }

        if (i === 0) continue;
        const previous = rows[i - 1];
        const validRows = previous && typeof previous === 'object' && !Array.isArray(previous);
        const intervalElapsedMs = validRows && finiteNonnegative(row.at) && finiteNonnegative(previous.at) ? row.at - previous.at : null;
        const validElapsed = finiteNonnegative(intervalElapsedMs) && intervalElapsedMs > 0;
        if (validElapsed) addReason(intervalElapsedMs <= maxGapMs, `host sample gap ${intervalElapsedMs}ms exceeds ${maxGapMs}ms`);
        else addReason(false, `host sample interval ${i - 1}-${i} has invalid timestamps`);

        let swapInBytes = null;
        let swapOutBytes = null;
        let swapMiBPerSecond = null;
        if (validRows && counter(row.swapins) && counter(previous.swapins) && counter(row.swapouts) && counter(previous.swapouts)
            && positiveInteger(row.pageSizeBytes) && positiveInteger(previous.pageSizeBytes) && row.pageSizeBytes === previous.pageSizeBytes) {
            const swapInPages = row.swapins - previous.swapins;
            const swapOutPages = row.swapouts - previous.swapouts;
            if (swapInPages < 0 || swapOutPages < 0) {
                addReason(false, `host swap counter reset or decreased in interval ${i - 1}-${i}`);
                allSwapDeltasKnown = false;
            } else {
                swapInBytes = swapInPages * row.pageSizeBytes;
                swapOutBytes = swapOutPages * row.pageSizeBytes;
                if (!Number.isSafeInteger(swapInBytes) || !Number.isSafeInteger(swapOutBytes)) {
                    swapInBytes = swapOutBytes = null;
                    allSwapDeltasKnown = false;
                    addReason(false, `host swap byte count overflowed in interval ${i - 1}-${i}`);
                } else {
                    swapMiBPerSecond = validElapsed ? (swapInBytes + swapOutBytes) / MIB / (intervalElapsedMs / 1000) : null;
                    swapInTotal += swapInBytes;
                    swapOutTotal += swapOutBytes;
                    if (!Number.isSafeInteger(swapInTotal) || !Number.isSafeInteger(swapOutTotal)) {
                        allSwapDeltasKnown = false;
                        addReason(false, 'total host swap byte count overflowed');
                    }
                    if (swapMiBPerSecond !== null) addReason(swapMiBPerSecond <= maxSwapMiBPerSecond,
                        `host swap rate ${swapMiBPerSecond.toFixed(3)} MiB/s exceeds ${maxSwapMiBPerSecond}`);
                }
            }
        } else {
            allSwapDeltasKnown = false;
            addReason(false, `host swap counters are unavailable in interval ${i - 1}-${i}`);
        }
        const interval = { elapsedMs: intervalElapsedMs, swapInBytes, swapOutBytes, swapMiBPerSecond };
        if (row.platform === 'linux' || previous?.platform === 'linux') {
            let cpuTotalTicks = null, stealTicks = null, stealRatio = null, cgroupThrottleDeltas = null;
            const previousCg = previous?.cgroupV2, currentCg = row.cgroupV2;
            const previousAncestors = previousCg?.ancestors, currentAncestors = currentCg?.ancestors;
            const cgroupsValid = validCgroupEvidence(previousCg) && validCgroupEvidence(currentCg);
            const stableCgroup = cgroupsValid && previous?.platform === 'linux' && row.platform === 'linux'
                && previousCg?.mountPoint === currentCg?.mountPoint
                && previousCg?.cgroupPath === currentCg?.cgroupPath
                && previous?.effectiveCpuCapacity === row.effectiveCpuCapacity
                && Array.isArray(previousAncestors) && Array.isArray(currentAncestors)
                && previousAncestors.length === currentAncestors.length
                && previousAncestors.every((entry, index) => entry?.path === currentAncestors[index]?.path
                    && entry?.cpuCapacity === currentAncestors[index]?.cpuCapacity
                    && entry?.cpuMaxSetting === currentAncestors[index]?.cpuMaxSetting);
            if (!stableCgroup) {
                allLinuxContentionKnown = false;
                addReason(false, cgroupsValid
                    ? `cgroup v2 path or CPU quota changed in interval ${i - 1}-${i}`
                    : `cgroup v2 contention evidence is unavailable in interval ${i - 1}-${i}`);
            }
            if (row.platform === 'linux' && previous?.platform === 'linux'
                && counter(row.procStatTotalTicks) && counter(previous.procStatTotalTicks)
                && counter(row.stealTicks) && counter(previous.stealTicks)) {
                cpuTotalTicks = row.procStatTotalTicks - previous.procStatTotalTicks;
                stealTicks = row.stealTicks - previous.stealTicks;
                if (cpuTotalTicks <= 0 || stealTicks < 0 || stealTicks > cpuTotalTicks) {
                    allLinuxContentionKnown = false;
                    addReason(false, `host CPU or steal counters reset/decreased in interval ${i - 1}-${i}`);
                    cpuTotalTicks = stealTicks = null;
                } else {
                    stealRatio = stealTicks / cpuTotalTicks;
                    peakStealRatio = peakStealRatio === null ? stealRatio : Math.max(peakStealRatio, stealRatio);
                    addReason(stealRatio <= maxStealRatio,
                        `host CPU steal ${(stealRatio * 100).toFixed(3)}% exceeds ${(maxStealRatio * 100).toFixed(3)}%`);
                }
            } else {
                allLinuxContentionKnown = false;
                addReason(false, `host CPU steal counters are unavailable in interval ${i - 1}-${i}`);
            }
            if (stableCgroup) {
                cgroupThrottleDeltas = currentAncestors.map((entry, index) => {
                    const prior = previousAncestors[index];
                    const nrThrottled = entry.nrThrottled - prior.nrThrottled;
                    const throttledUsec = entry.throttledUsec - prior.throttledUsec;
                    if (nrThrottled < 0 || throttledUsec < 0) {
                        allLinuxContentionKnown = false;
                        addReason(false, `cgroup throttling counters reset/decreased at ${entry.path} in interval ${i - 1}-${i}`);
                        return { path: entry.path, nrThrottled: null, throttledUsec: null };
                    }
                    if (nrThrottled > 0 || throttledUsec > 0) {
                        observedCgroupThrottle = true;
                        addReason(false, `cgroup CPU throttling observed at ${entry.path} in interval ${i - 1}-${i}`);
                    }
                    return { path: entry.path, nrThrottled, throttledUsec };
                });
            }
            Object.assign(interval, { cpuTotalTicks, stealTicks, stealRatio, cgroupThrottleDeltas });
        }
        intervals.push(interval);
    }

    return {
        clean: reasons.length === 0,
        reasons,
        samples: rows.length,
        elapsedMs,
        swapInBytes: allSwapDeltasKnown ? swapInTotal : null,
        swapOutBytes: allSwapDeltasKnown ? swapOutTotal : null,
        peakSwapMiBPerSecond: intervals.reduce((peak, interval) => interval.swapMiBPerSecond === null
            ? peak : Math.max(peak ?? 0, interval.swapMiBPerSecond), null),
        maxSwapMiBPerSecond,
        peakLoadPerCpu,
        maxLoadPerCpu,
        ...(platform === 'linux' ? { effectiveCpuCapacity, peakStealRatio, maxStealRatio,
            platform: 'linux', observedCgroupThrottle, linuxContentionKnown: allLinuxContentionKnown } : {}),
        intervals,
    };
}
