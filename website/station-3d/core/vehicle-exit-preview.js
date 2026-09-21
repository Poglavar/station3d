// The HUD may preview a landing without running support/collision probes each
// frame. E always resolves the real exit again before changing occupancy.
export function createVehicleExitPreview({ intervalMs = 300 } = {}) {
    let cached = null;
    return {
        reset() { cached = null; },
        read({ vehicleId, pose, speedMps, maxSpeedMps, nowMs, resolve }) {
            if (!pose || !Number.isFinite(speedMps) || Math.abs(speedMps) > maxSpeedMps) {
                cached = null;
                return { key: 'gta.stopToExitPrompt', available: false, exitTarget: null };
            }
            const moved = !cached || cached.vehicleId !== vehicleId
                || Math.hypot(pose.x - cached.x, pose.z - cached.z) > .4
                || Math.abs(Math.atan2(Math.sin(pose.heading - cached.heading), Math.cos(pose.heading - cached.heading))) > .08;
            if (moved || nowMs - cached.at >= intervalMs) {
                cached = { vehicleId, x: pose.x, z: pose.z, heading: pose.heading,
                    at: nowMs, target: resolve() || null };
            }
            return {
                key: cached.target ? 'gta.boatExitPrompt' : 'gta.boatMoveCloserPrompt',
                available: !!cached.target,
                exitTarget: cached.target,
            };
        },
    };
}
