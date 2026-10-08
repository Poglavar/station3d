// Linux contention evidence for performance runs: host CPU steal plus every visible cgroup v2 ancestor.
import { posix as path } from 'node:path';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const decodeMountField = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

export function parseProcStatCpu(text) {
    const line = String(text).split(/\r?\n/).find(row => row.startsWith('cpu '));
    const fields = line?.trim().split(/\s+/).slice(1).map(Number);
    if (!fields || fields.length < 8 || fields.slice(0, 8).some(value => !integer(value))) {
        throw new Error('/proc/stat aggregate CPU counters are missing or malformed');
    }
    // guest and guest_nice are already included in user and nice.
    const totalTicks = fields.slice(0, 8).reduce((sum, value) => sum + value, 0);
    if (!integer(totalTicks)) throw new Error('/proc/stat aggregate CPU counter overflowed');
    return { totalTicks, stealTicks: fields[7] };
}

export function parseUnifiedCgroupPath(text) {
    const entries = String(text).split(/\r?\n/).filter(line => /^0::/.test(line));
    if (entries.length !== 1) throw new Error('unified cgroup v2 path is missing or ambiguous');
    const value = entries[0].slice(3);
    if (!value.startsWith('/') || value.split('/').includes('..')) throw new Error('unified cgroup v2 path is malformed');
    return path.normalize(value);
}

export function parseCgroup2Mount(text) {
    const mounts = [];
    for (const line of String(text).split(/\r?\n/)) {
        const parts = line.split(' - ');
        if (parts.length !== 2 || parts[1].split(/\s+/)[0] !== 'cgroup2') continue;
        const left = parts[0].split(/\s+/);
        if (left.length < 5) continue;
        mounts.push({ root: path.normalize(decodeMountField(left[3])), mountPoint: path.normalize(decodeMountField(left[4])) });
    }
    if (mounts.length !== 1) throw new Error('cgroup v2 mount is missing or ambiguous');
    return mounts[0];
}

export function parseCgroupCpuMax(text) {
    const fields = String(text).trim().split(/\s+/);
    if (fields.length !== 2 || !integer(Number(fields[1])) || Number(fields[1]) === 0) {
        throw new Error('cgroup cpu.max is malformed');
    }
    const period = Number(fields[1]);
    if (fields[0] === 'max') return null;
    const quota = Number(fields[0]);
    if (!integer(quota) || quota === 0) throw new Error('cgroup cpu.max quota is malformed');
    return quota / period;
}

export function parseCgroupCpuStat(text) {
    const values = new Map(String(text).trim().split(/\r?\n/).map(line => {
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 2 || !integer(Number(fields[1]))) throw new Error('cgroup cpu.stat is malformed');
        return [fields[0], Number(fields[1])];
    }));
    if (!values.has('nr_throttled') || !values.has('throttled_usec')) {
        throw new Error('cgroup cpu.stat throttling counters are missing');
    }
    return { nrThrottled: values.get('nr_throttled'), throttledUsec: values.get('throttled_usec') };
}

function isMissingFile(error) { return error?.code === 'ENOENT'; }

// This collector deliberately supports the unified v2 hierarchy only; v1 or an
// unresolvable mount is unknown contention evidence and must fail closed.
export function readLinuxContentionSample({ readText, availableCpus }) {
    if (typeof readText !== 'function') throw new Error('Linux host sampler needs an injected text reader');
    const cpu = parseProcStatCpu(readText('/proc/stat'));
    const cgroupPath = parseUnifiedCgroupPath(readText('/proc/self/cgroup'));
    const mount = parseCgroup2Mount(readText('/proc/self/mountinfo'));
    if (mount.root !== '/') throw new Error('cgroup v2 mount exposes only a subtree; ancestor throttling cannot be verified');
    const relative = mount.root === '/' ? cgroupPath.slice(1)
        : cgroupPath === mount.root ? ''
            : cgroupPath.startsWith(`${mount.root}/`) ? cgroupPath.slice(mount.root.length + 1) : null;
    if (relative === null) throw new Error('unified cgroup path is outside the cgroup v2 mount root');
    const ownPath = path.resolve(mount.mountPoint, relative);
    if (ownPath !== mount.mountPoint && !ownPath.startsWith(`${mount.mountPoint}/`)) {
        throw new Error('resolved cgroup v2 path escapes its mount');
    }

    const paths = [];
    for (let current = ownPath;; current = path.dirname(current)) {
        paths.push(current);
        if (current === mount.mountPoint) break;
        if (!current.startsWith(`${mount.mountPoint}/`)) throw new Error('cgroup v2 ancestry escaped its mount');
    }
    const ancestors = paths.map(cgroup => {
        const rel = path.relative(mount.mountPoint, cgroup);
        const cpuMaxPath = path.join(cgroup, 'cpu.max');
        let cpuCapacity, cpuMaxSetting;
        try {
            cpuMaxSetting = readText(cpuMaxPath).trim();
            cpuCapacity = parseCgroupCpuMax(cpuMaxSetting);
        }
        catch (error) {
            if (!isMissingFile(error)) throw error;
            cpuCapacity = null; // cpu.max can be absent when the controller is not enabled here.
            cpuMaxSetting = null;
        }
        const counters = parseCgroupCpuStat(readText(path.join(cgroup, 'cpu.stat')));
        return { path: rel ? `/${rel}` : '/', cpuCapacity, cpuMaxSetting, ...counters };
    });
    const limits = ancestors.map(row => row.cpuCapacity).filter(Number.isFinite);
    const affinity = Number.isFinite(availableCpus) && availableCpus > 0 ? availableCpus : null;
    if (affinity !== null) limits.push(affinity);
    const effectiveCpuCapacity = limits.length ? Math.min(...limits) : null;
    if (effectiveCpuCapacity === null) throw new Error('effective CPU capacity is unavailable from affinity and cgroup v2 quotas');
    return { ...cpu, cgroupV2: { mountPoint: mount.mountPoint, cgroupPath, ancestors, effectiveCpuCapacity } };
}
