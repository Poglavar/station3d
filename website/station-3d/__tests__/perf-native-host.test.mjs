import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeNativeHostWindow } from '../../../tools/lib/perf-native-host.mjs';
import { parseCgroup2Mount, parseCgroupCpuMax, parseCgroupCpuStat, parseProcStatCpu,
    parseUnifiedCgroupPath, readLinuxContentionSample } from '../../../tools/lib/perf-native-linux.mjs';

const cgroup = ({ path = '/user.slice/session.scope', quota = null, nrThrottled = 0, throttledUsec = 0 } = {}) => ({
    mountPoint: '/sys/fs/cgroup', cgroupPath: path,
    ancestors: [
        { path: '/user.slice/session.scope', cpuCapacity: quota,
            cpuMaxSetting: quota === null ? 'max 100000' : `${quota * 100000} 100000`, nrThrottled, throttledUsec },
        { path: '/user.slice', cpuCapacity: null, cpuMaxSetting: 'max 100000', nrThrottled: 0, throttledUsec: 0 },
        { path: '/', cpuCapacity: null, cpuMaxSetting: null, nrThrottled: 0, throttledUsec: 0 },
    ],
    effectiveCpuCapacity: quota ?? 4,
});

const sample = (overrides = {}) => ({
    at: 1000, platform: 'linux', cpus: 8, load1: 4, pageSizeBytes: 4096,
    swapins: 100, swapouts: 50, procStatTotalTicks: 1000, stealTicks: 10,
    cgroupV2: cgroup(), effectiveCpuCapacity: 4, error: null, ...overrides,
});
const pair = (first = {}, second = {}) => [sample(first), sample({ at: 2000, procStatTotalTicks: 1100, stealTicks: 10, ...second })];

test('zero swap across a quiet window is accepted and retains interval measurements', () => {
    const result = summarizeNativeHostWindow(pair());
    assert.equal(result.clean, true);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.evidenceValid, true);
    assert.deepEqual(result.evidenceReasons, []);
    assert.equal(result.samples, 2);
    assert.equal(result.elapsedMs, 1000);
    assert.equal(result.swapInBytes, 0);
    assert.equal(result.swapOutBytes, 0);
    assert.equal(result.peakSwapMiBPerSecond, 0);
    assert.deepEqual(result.intervals, [{ elapsedMs: 1000, swapInBytes: 0, swapOutBytes: 0, swapMiBPerSecond: 0,
        cpuTotalTicks: 100, stealTicks: 0, stealRatio: 0, cgroupThrottleDeltas: [
            { path: '/user.slice/session.scope', nrThrottled: 0, throttledUsec: 0 },
            { path: '/user.slice', nrThrottled: 0, throttledUsec: 0 },
            { path: '/', nrThrottled: 0, throttledUsec: 0 },
        ] }]);
    assert.equal(result.effectiveCpuCapacity, 4);
    assert.equal(result.linuxContentionKnown, true);
    assert.equal(result.platform, 'linux');
    assert.equal(result.cpus, 8);
});

test('unknown and reset counters fail closed and keep the interval with null deltas', () => {
    const unknown = summarizeNativeHostWindow(pair({}, { swapins: null }));
    assert.equal(unknown.clean, false);
    assert.equal(unknown.swapInBytes, null);
    assert.equal(unknown.intervals.length, 1);
    assert.equal(unknown.intervals[0].swapInBytes, null);

    const reset = summarizeNativeHostWindow(pair({}, { swapins: 10 }));
    assert.equal(reset.clean, false);
    assert.ok(reset.reasons.some(reason => /counter reset or decreased/.test(reason)));
    assert.equal(reset.intervals[0].swapMiBPerSecond, null);
});

test('rejects long sample gaps while preserving their measurable swap deltas', () => {
    const samples = [sample(), sample({ at: 9000, swapins: 101 })];
    const result = summarizeNativeHostWindow(samples);
    assert.equal(result.clean, false);
    assert.ok(result.reasons.some(reason => /sample gap 8000ms exceeds 7500ms/.test(reason)));
    assert.equal(result.intervals[0].swapInBytes, 4096);
    assert.equal(result.intervals[0].swapMiBPerSecond, 4096 / 1024 / 1024 / 8);
});

test('rejects inconsistent page sizes or CPU counts', () => {
    const pageSize = summarizeNativeHostWindow(pair({}, { pageSizeBytes: 16384 }));
    assert.equal(pageSize.clean, false);
    assert.ok(pageSize.reasons.includes('host samples use inconsistent page sizes'));
    assert.equal(pageSize.intervals[0].swapInBytes, null);

    const cpus = summarizeNativeHostWindow(pair({}, { cpus: 4 }));
    assert.equal(cpus.clean, false);
    assert.ok(cpus.reasons.includes('host samples use inconsistent CPU counts'));
});

test('requires a supported native platform and exposes platform and CPU identity', () => {
    for (const platform of [undefined, 'windows', '']) {
        const result = summarizeNativeHostWindow(pair({ platform }, { platform }));
        assert.equal(result.clean, false);
        assert.equal(result.evidenceValid, false);
        assert.ok(result.evidenceReasons.some(reason => /platform is missing or unsupported/.test(reason)));
    }

    const macSamples = [
        sample({ platform: 'darwin', cgroupV2: undefined, procStatTotalTicks: undefined, stealTicks: undefined }),
        sample({ at: 2000, platform: 'darwin', cgroupV2: undefined, procStatTotalTicks: undefined, stealTicks: undefined }),
    ];
    const mac = summarizeNativeHostWindow(macSamples);
    assert.equal(mac.clean, true);
    assert.equal(mac.evidenceValid, true);
    assert.equal(mac.platform, 'darwin');
    assert.equal(mac.cpus, 8);
});

test('rejects high per-CPU load and combined swap-in plus swap-out rate', () => {
    const loaded = summarizeNativeHostWindow(pair({}, { load1: 16 }));
    assert.equal(loaded.clean, false);
    assert.ok(loaded.reasons.some(reason => /host load per CPU/.test(reason)));

    const swapping = summarizeNativeHostWindow(pair({}, { swapins: 101, swapouts: 51 }), { maxSwapMiBPerSecond: 0.005 });
    assert.equal(swapping.clean, false);
    assert.equal(swapping.intervals[0].swapInBytes, 4096);
    assert.equal(swapping.intervals[0].swapOutBytes, 4096);
    assert.ok(swapping.reasons.some(reason => /host swap rate/.test(reason)));
});

test('missing timestamps, load, CPU and error-bearing samples fail closed', () => {
    const samples = pair();
    samples[1].at = NaN;
    samples[0].load1 = null;
    samples[0].cpus = null;
    samples[1].error = 'vm_stat unavailable';
    const result = summarizeNativeHostWindow(samples);
    assert.equal(result.clean, false);
    assert.ok(result.reasons.some(reason => /timestamp is missing or invalid/.test(reason)));
    assert.ok(result.reasons.some(reason => /load average is missing or invalid/.test(reason)));
    assert.ok(result.reasons.some(reason => /CPU count is missing or invalid/.test(reason)));
    assert.ok(result.reasons.some(reason => /native sampling error/.test(reason)));
    assert.equal(result.intervals.length, 1);
    assert.equal(result.intervals[0].swapMiBPerSecond, null);
});

test('requires at least two samples and does not invent missing aggregate counters', () => {
    const one = summarizeNativeHostWindow([sample()]);
    assert.equal(one.clean, false);
    assert.equal(one.swapInBytes, null);
    assert.ok(one.reasons.includes('at least two host samples are required'));

    const invalid = summarizeNativeHostWindow([sample(), null]);
    assert.equal(invalid.clean, false);
    assert.equal(invalid.intervals.length, 1);
    assert.deepEqual(invalid.intervals[0], { elapsedMs: null, swapInBytes: null, swapOutBytes: null, swapMiBPerSecond: null });
});

test('parses aggregate CPU ticks without guest double counting and reports steal ticks', () => {
    assert.deepEqual(parseProcStatCpu('cpu 100 20 30 400 5 6 7 8 1000 200\ncpu0 1 2 3 4 5 6 7 8'),
        { totalTicks: 576, stealTicks: 8 });
    assert.throws(() => parseProcStatCpu('cpu 1 2 3 4 5 6 7'), /missing or malformed/);
});

test('parses unified cgroup v2 identity, mount escapes, cpu.max and required throttle counters', () => {
    assert.equal(parseUnifiedCgroupPath('12:memory:/x\n0::/user.slice/session.scope'), '/user.slice/session.scope');
    assert.deepEqual(parseCgroup2Mount('29 22 0:25 / /sys/fs/cgroup rw - cgroup2 cgroup rw'),
        { root: '/', mountPoint: '/sys/fs/cgroup' });
    assert.deepEqual(parseCgroup2Mount('29 22 0:25 / /sys/fs/cgroup\\040root rw - cgroup2 cgroup rw'),
        { root: '/', mountPoint: '/sys/fs/cgroup root' });
    assert.equal(parseCgroupCpuMax('max 100000'), null);
    assert.equal(parseCgroupCpuMax('200000 100000'), 2);
    assert.deepEqual(parseCgroupCpuStat('usage_usec 100\nnr_periods 10\nnr_throttled 2\nthrottled_usec 30'),
        { nrThrottled: 2, throttledUsec: 30 });
    assert.throws(() => parseUnifiedCgroupPath('2:cpu:/legacy-v1'), /unified cgroup v2/);
    assert.throws(() => parseCgroup2Mount('29 22 0:25 / /sys/fs/cgroup rw - cgroup cgroup rw'), /cgroup v2 mount/);
    assert.throws(() => parseCgroupCpuStat('usage_usec 10'), /throttling counters are missing/);
    assert.throws(() => parseCgroupCpuMax('bad'), /malformed/);
});

test('reads every unified ancestor, accepts a missing ancestor cpu.max and uses the tightest quota', () => {
    const root = '/sys/fs/cgroup';
    const cgroupPath = '/user.slice/user-0.slice/session-77.scope';
    const files = new Map([
        ['/proc/stat', 'cpu 100 0 20 500 0 0 0 4 100 0'],
        ['/proc/self/cgroup', `0::${cgroupPath}`],
        ['/proc/self/mountinfo', '29 22 0:25 / /sys/fs/cgroup rw - cgroup2 cgroup rw'],
        [`${root}/user.slice/user-0.slice/session-77.scope/cpu.max`, 'max 100000'],
        [`${root}/user.slice/user-0.slice/cpu.max`, '200000 100000'],
        // The root has cpu.stat but no cpu.max when the controller is not enabled there.
        [`${root}/user.slice/user-0.slice/session-77.scope/cpu.stat`, 'nr_throttled 0\nthrottled_usec 0'],
        [`${root}/user.slice/user-0.slice/cpu.stat`, 'nr_throttled 0\nthrottled_usec 0'],
        [`${root}/user.slice/cpu.stat`, 'nr_throttled 0\nthrottled_usec 0'],
        [`${root}/cpu.stat`, 'nr_throttled 0\nthrottled_usec 0'],
    ]);
    const result = readLinuxContentionSample({ readText: file => {
        if (!files.has(file)) { const error = new Error(`missing fixture ${file}`); error.code = 'ENOENT'; throw error; }
        return files.get(file);
    }, availableCpus: 8 });
    assert.equal(result.totalTicks, 624);
    assert.equal(result.stealTicks, 4);
    assert.equal(result.cgroupV2.ancestors.length, 4);
    assert.equal(result.cgroupV2.effectiveCpuCapacity, 2);
    files.set('/proc/self/mountinfo', '29 22 0:25 /visible /sys/fs/cgroup rw - cgroup2 cgroup rw');
    assert.throws(() => readLinuxContentionSample({ readText: file => files.get(file), availableCpus: 8 }), /mount exposes only a subtree/);
    files.set('/proc/self/mountinfo', '29 22 0:25 / /sys/fs/cgroup rw - cgroup2 cgroup rw');
    files.delete(`${root}/cpu.stat`);
    assert.throws(() => readLinuxContentionSample({ readText: file => {
        if (!files.has(file)) { const error = new Error(`missing fixture ${file}`); error.code = 'ENOENT'; throw error; }
        return files.get(file);
    }, availableCpus: 8 }), /missing fixture/);
});

test('cgroup throttling, steal, counter resets, path changes and quota changes fail Linux admission', () => {
    const throttled = summarizeNativeHostWindow(pair({}, {
        cgroupV2: cgroup({ nrThrottled: 1, throttledUsec: 9623 }),
    }));
    assert.equal(throttled.clean, false);
    assert.equal(throttled.observedCgroupThrottle, true);
    assert.ok(throttled.reasons.some(reason => /cgroup CPU throttling observed/.test(reason)));
    assert.equal(throttled.evidenceValid, true);
    assert.deepEqual(throttled.evidenceReasons, []);

    const steal = summarizeNativeHostWindow(pair({}, { procStatTotalTicks: 1100, stealTicks: 12 }));
    assert.equal(steal.clean, false);
    assert.equal(steal.peakStealRatio, 0.02);
    assert.ok(steal.reasons.some(reason => /host CPU steal 2\.000% exceeds 1\.000%/.test(reason)));
    assert.equal(steal.evidenceValid, true);
    assert.deepEqual(steal.evidenceReasons, []);

    const reset = summarizeNativeHostWindow(pair({}, { stealTicks: 9 }));
    assert.equal(reset.clean, false);
    assert.ok(reset.reasons.some(reason => /CPU or steal counters reset/.test(reason)));
    assert.equal(reset.evidenceValid, false);
    assert.ok(reset.evidenceReasons.some(reason => /CPU or steal counters reset/.test(reason)));

    const throttleReset = summarizeNativeHostWindow(pair({ cgroupV2: cgroup({ nrThrottled: 2, throttledUsec: 30 }) }, {
        cgroupV2: cgroup({ nrThrottled: 1, throttledUsec: 20 }),
    }));
    assert.equal(throttleReset.clean, false);
    assert.ok(throttleReset.reasons.some(reason => /cgroup throttling counters reset/.test(reason)));

    const moved = summarizeNativeHostWindow(pair({}, { cgroupV2: cgroup({ path: '/other.scope' }) }));
    assert.equal(moved.clean, false);
    assert.ok(moved.reasons.some(reason => /path or CPU quota changed/.test(reason)));
    assert.equal(moved.evidenceValid, false);

    const changedQuota = summarizeNativeHostWindow(pair({}, { cgroupV2: cgroup({ quota: 2 }), effectiveCpuCapacity: 2 }));
    assert.equal(changedQuota.clean, false);
    assert.ok(changedQuota.reasons.some(reason => /path or CPU quota changed/.test(reason)));
    assert.equal(changedQuota.evidenceValid, false);

    const equivalentCapacity = cgroup();
    equivalentCapacity.ancestors[0].cpuMaxSetting = '400000 200000';
    const changedPeriod = summarizeNativeHostWindow(pair({}, { cgroupV2: equivalentCapacity }));
    assert.equal(changedPeriod.clean, false);
    assert.ok(changedPeriod.reasons.some(reason => /path or CPU quota changed/.test(reason)));
});

test('native pressure makes admission dirty without invalidating otherwise sound evidence', () => {
    for (const result of [
        summarizeNativeHostWindow(pair({}, { load1: 16 })),
        summarizeNativeHostWindow(pair({}, { swapins: 101, swapouts: 51 }), { maxSwapMiBPerSecond: 0.005 }),
    ]) {
        assert.equal(result.clean, false);
        assert.equal(result.evidenceValid, true);
        assert.deepEqual(result.evidenceReasons, []);
    }
});

test('rejects invalid Linux steal thresholds instead of silently using them', () => {
    for (const maxStealRatio of [-0.01, 1.01, NaN]) {
        const result = summarizeNativeHostWindow(pair(), { maxStealRatio });
        assert.equal(result.clean, false);
        assert.ok(result.reasons.includes('maxStealRatio must be between 0 and 1'));
    }
});

test('missing Linux contention evidence fails closed while macOS summary retains generic metrics', () => {
    const missing = summarizeNativeHostWindow(pair({}, { cgroupV2: null, procStatTotalTicks: null, stealTicks: null }));
    assert.equal(missing.clean, false);
    assert.equal(missing.evidenceValid, false);
    assert.equal(missing.linuxContentionKnown, false);
    assert.ok(missing.reasons.some(reason => /cgroup v2 contention evidence is missing/.test(reason)));

    const nullAncestor = cgroup();
    nullAncestor.ancestors[1] = null;
    const malformedArray = summarizeNativeHostWindow(pair({}, { cgroupV2: nullAncestor }));
    assert.equal(malformedArray.clean, false);
    assert.equal(malformedArray.linuxContentionKnown, false);
    assert.ok(malformedArray.reasons.some(reason => /cgroup v2 contention evidence is missing or invalid/.test(reason)));

    const missingCounter = cgroup();
    delete missingCounter.ancestors[0].nrThrottled;
    const malformedCounter = summarizeNativeHostWindow(pair({}, { cgroupV2: missingCounter }));
    assert.equal(malformedCounter.clean, false);
    assert.equal(malformedCounter.linuxContentionKnown, false);
    assert.ok(malformedCounter.reasons.some(reason => /contention evidence is unavailable in interval/.test(reason)));

    const mixed = summarizeNativeHostWindow(pair({}, { platform: 'darwin',
        cgroupV2: undefined, effectiveCpuCapacity: undefined, procStatTotalTicks: undefined, stealTicks: undefined }));
    assert.equal(mixed.clean, false);
    assert.ok(mixed.reasons.includes('host samples use inconsistent platforms'));

    const macPair = [sample({ platform: 'darwin', cgroupV2: undefined, effectiveCpuCapacity: undefined,
        procStatTotalTicks: undefined, stealTicks: undefined }),
    sample({ at: 2000, platform: 'darwin', cgroupV2: undefined, effectiveCpuCapacity: undefined,
        procStatTotalTicks: 1100, stealTicks: undefined })];
    const mac = summarizeNativeHostWindow(macPair);
    assert.equal(mac.clean, true);
    assert.equal(mac.evidenceValid, true);
    assert.equal(mac.platform, 'darwin');
    assert.equal(mac.cpus, 8);
    assert.equal('peakStealRatio' in mac, false);
    assert.deepEqual(mac.intervals, [{ elapsedMs: 1000, swapInBytes: 0, swapOutBytes: 0, swapMiBPerSecond: 0 }]);
});
