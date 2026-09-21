// Pure population policy for ambient dog walkers. The first crowd gets a
// companion deterministically, while the hard cap keeps draw cost bounded.

export const MAX_AMBIENT_DOG_WALKERS = 4;
export const AMBIENT_DOG_WALKER_CHANCE = 0.22;

export function shouldAttachAmbientDog({
    groupSize = 1,
    currentDogWalkers = 0,
    randomValue = 1,
} = {}) {
    if (Number(groupSize) < 1) return false;
    const current = Math.max(0, Math.floor(Number(currentDogWalkers) || 0));
    if (current >= MAX_AMBIENT_DOG_WALKERS) return false;
    if (current === 0) return true;
    return Number(randomValue) < AMBIENT_DOG_WALKER_CHANCE;
}
