// Advances the authored secret-door reveal without any DOM or Three.js state,
// so the lever/door timing remains deterministic and unit-testable.

import { finiteOrNull } from './math.js';

export function stepCampaignSecretDoor({ elapsed = 0, duration = 1.65 } = {}, dt = 0) {
    const safeDuration = Math.max(0.1, finiteOrNull(duration) ?? 1.65);
    const safeElapsed = Math.max(0, finiteOrNull(elapsed) ?? 0);
    const seconds = Math.max(0, Math.min(0.1, finiteOrNull(dt) ?? 0));
    const nextElapsed = Math.min(safeDuration, safeElapsed + seconds);
    const linearProgress = nextElapsed / safeDuration;
    return {
        elapsed: nextElapsed,
        duration: safeDuration,
        doorProgress: linearProgress * linearProgress * (3 - 2 * linearProgress),
        leverProgress: Math.min(1, linearProgress * 1.45),
        complete: nextElapsed >= safeDuration,
    };
}
