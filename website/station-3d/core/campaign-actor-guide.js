// Pure movement policy for a campaign guide: advance toward the authored
// route while the player is close, then wait instead of abandoning them.

import { finiteOrNull } from './math.js';

function finite(value, fallback = 0) {
    return finiteOrNull(value) ?? fallback;
}

export function stepCampaignActorGuide({
    actorX,
    actorZ,
    targetX,
    targetZ,
    playerX,
    playerZ,
    dt,
    leading = false,
    // A guide who walks slower than the person following her is not leading:
    // the player (1.8 m/s in a story scene) overtakes her within a few metres
    // and she spends the whole tunnel trailing behind, then appears ahead again
    // at the next scene's start pose — which reads as teleporting. So her base
    // pace beats a walk, and she lengthens her stride while the player is right
    // behind her, keeping the gap she is supposed to be leading by.
    speedMps = 2,
    hurrySpeedMps = 2.6,
    keepAheadM = 6,
    resumeDistanceM = 10,
    waitDistanceM = 16,
    stopDistanceM = 0.8,
} = {}) {
    const x = finite(actorX);
    const z = finite(actorZ);
    const tx = finite(targetX, x);
    const tz = finite(targetZ, z);
    const px = finite(playerX, x);
    const pz = finite(playerZ, z);
    const targetDx = tx - x;
    const targetDz = tz - z;
    const targetDistanceM = Math.hypot(targetDx, targetDz);
    const playerDx = px - x;
    const playerDz = pz - z;
    const playerDistanceM = Math.hypot(playerDx, playerDz);
    const stopM = Math.max(0, finite(stopDistanceM, 0.8));
    const resumeM = Math.max(stopM, finite(resumeDistanceM, 10));
    const waitM = Math.max(resumeM, finite(waitDistanceM, 16));
    const stepSeconds = Math.max(0, finite(dt));
    let nextLeading = !!leading;

    // Dialogue and cinematic leases freeze simulation at dt=0. Keep a guide
    // facing the player during that presentation instead of letting proximity
    // start the route and turn the actor's back before the final line lands.
    // An already-active guide retains its state and resumes on the first live
    // frame after the overlay closes.
    if (stepSeconds <= 0) {
        return {
            x,
            z,
            heading: playerDistanceM > 0.001 ? Math.atan2(playerDx, playerDz) : 0,
            leading: targetDistanceM <= stopM ? false : nextLeading,
            walking: false,
            arrived: targetDistanceM <= stopM,
            playerDistanceM,
            targetDistanceM,
        };
    }

    if (targetDistanceM <= stopM) nextLeading = false;
    else if (nextLeading && playerDistanceM >= waitM) nextLeading = false;
    else if (!nextLeading && playerDistanceM <= resumeM) nextLeading = true;

    if (!nextLeading || targetDistanceM <= 0.001) {
        return {
            x,
            z,
            heading: playerDistanceM > 0.001 ? Math.atan2(playerDx, playerDz) : 0,
            leading: false,
            walking: false,
            arrived: targetDistanceM <= stopM,
            playerDistanceM,
            targetDistanceM,
        };
    }

    const basePace = Math.max(0, finite(speedMps, 2));
    const hurryPace = Math.max(basePace, finite(hurrySpeedMps, 2.6));
    const keepAhead = Math.max(0, finite(keepAheadM, 6));
    const pace = playerDistanceM <= keepAhead ? hurryPace : basePace;
    const stepM = Math.min(
        Math.max(0, targetDistanceM - stopM),
        pace * stepSeconds,
    );
    return {
        x: x + targetDx / targetDistanceM * stepM,
        z: z + targetDz / targetDistanceM * stepM,
        heading: Math.atan2(targetDx, targetDz),
        leading: true,
        walking: stepM > 0,
        arrived: targetDistanceM - stepM <= stopM,
        playerDistanceM,
        targetDistanceM: Math.max(0, targetDistanceM - stepM),
    };
}
