// Deterministic traffic-light phases and approach braking shared by the visual
// signal layer and ambient road traffic.

export const TRAFFIC_SIGNAL_CYCLE_SECONDS = 24;

function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function trafficSignalPhase(signal, elapsedSeconds = 0) {
    const offset = Number.isFinite(signal?.phaseOffsetSeconds)
        ? signal.phaseOffsetSeconds
        : stableHash(signal?.id) % TRAFFIC_SIGNAL_CYCLE_SECONDS;
    const cycle = ((Number(elapsedSeconds) || 0) + offset) % TRAFFIC_SIGNAL_CYCLE_SECONDS;
    if (cycle < 10) return 'green';
    if (cycle < 12) return 'amber';
    return 'red';
}

export function trafficSignalBrakeFactor({
    vehicleX,
    vehicleZ,
    heading,
    signal,
    elapsedSeconds = 0,
    detectDistanceM = 18,
    stopLineOffsetM = 2,
    lateralToleranceM = 3.4,
} = {}) {
    if (!signal || trafficSignalPhase(signal, elapsedSeconds) === 'green') return 1;
    const dx = Number(signal.x) - Number(vehicleX);
    const dz = Number(signal.z) - Number(vehicleZ);
    const yaw = Number(heading) || 0;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const aheadM = dx * forwardX + dz * forwardZ;
    const lateralM = Math.abs(dx * forwardZ - dz * forwardX);
    if (!(aheadM > stopLineOffsetM) || aheadM >= detectDistanceM
        || lateralM > lateralToleranceM) return 1;

    const bearingRad = Number(signal.bearingDeg) * Math.PI / 180;
    if (Number.isFinite(bearingRad)) {
        const roadX = Math.sin(bearingRad);
        const roadZ = -Math.cos(bearingRad);
        const alignment = Math.abs(forwardX * roadX + forwardZ * roadZ);
        if (alignment < 0.7) return 1;
    }
    return Math.max(0, Math.min(1,
        (aheadM - stopLineOffsetM) / Math.max(1, detectDistanceM - stopLineOffsetM - 2),
    ));
}
