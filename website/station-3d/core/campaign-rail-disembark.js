// Where a campaign train hands the player to the platform. Given the station's
// resolved platform extent (core/platform-extents.js) and the driver's pose,
// this puts the landing on the platform deck beside the train instead of a
// fixed offset from the track centreline, which at Glavni kolodvor landed the
// player in the track bed between the train and the raised platform
// (2026-09-09 audit). The outline only says a platform is there and on which
// side: findPlatformDeckLanding finds the deck itself in the world, standing
// above the rails. Pure, so the geometry is unit-tested.

const DEFAULT_INSET_M = 1.6;
// A train stopped a few metres past the platform end still gets the deck.
const DEFAULT_ALONG_SLACK_M = 6;

export function platformLandingPoint({
    trainX,
    trainZ,
    extent,
    insetM = DEFAULT_INSET_M,
    alongSlackM = DEFAULT_ALONG_SLACK_M,
} = {}) {
    if (!extent) return null;
    const x = Number(trainX);
    const z = Number(trainZ);
    const centerX = Number(extent.centerX);
    const centerZ = Number(extent.centerZ);
    const lengthM = Number(extent.lengthM);
    const widthM = Number(extent.widthM);
    const angleY = Number(extent.angleY);
    if (![x, z, centerX, centerZ, lengthM, widthM, angleY].every(Number.isFinite)) return null;
    if (lengthM <= 0 || widthM <= 0) return null;
    // resolvePrimaryPlatformExtent defines angleY = atan2(dx, dz) of the
    // start→end axis, so the along unit vector is (sin, cos).
    const alongX = Math.sin(angleY);
    const alongZ = Math.cos(angleY);
    const acrossX = alongZ;
    const acrossZ = -alongX;
    const dx = x - centerX;
    const dz = z - centerZ;
    const along = dx * alongX + dz * alongZ;
    const across = dx * acrossX + dz * acrossZ;
    if (Math.abs(along) > lengthM * 0.5 + alongSlackM) return null;
    const inset = Math.max(0.5, Math.min(insetM, widthM * 0.45));
    // Land on the platform edge nearest the train, a body's length in from
    // the coping, and never past the platform ends.
    const sideSign = across >= 0 ? 1 : -1;
    const landingAcross = sideSign * (widthM * 0.5 - inset);
    const landingAlong = Math.max(-(lengthM * 0.5 - inset), Math.min(lengthM * 0.5 - inset, along));
    return {
        x: centerX + landingAlong * alongX + landingAcross * acrossX,
        z: centerZ + landingAlong * alongZ + landingAcross * acrossZ,
        side: sideSign,
        trainOffsetM: Math.abs(across),
    };
}

// A platform deck stands clear above the rails. Support at rail height beside a
// train is the track bed or the gap to the coping, never the platform: taking it
// put the player between the 7022 and the deck at Glavni kolodvor (2026-09-11),
// whose authored outline follows the track itself.
const DECK_MIN_RISE_M = 0.25;
const DECK_MAX_RISE_M = 1.6;
const DECK_SEARCH_START_M = 1.8;
const DECK_SEARCH_END_M = 8;
const DECK_SEARCH_STEP_M = 0.25;
const DECK_STEP_IN_M = 1.2;

// Walks out across the track on both sides of the train and lands a step inside
// the nearest deck edge. `supportYAt(x, z)` is the world's walk support;
// (acrossX, acrossZ) is the unit vector of side +1.
export function findPlatformDeckLanding({
    trainX,
    trainZ,
    acrossX,
    acrossZ,
    railY,
    supportYAt,
    preferredSide = 1,
    minRiseM = DECK_MIN_RISE_M,
    maxRiseM = DECK_MAX_RISE_M,
    startM = DECK_SEARCH_START_M,
    endM = DECK_SEARCH_END_M,
    stepM = DECK_SEARCH_STEP_M,
    stepInM = DECK_STEP_IN_M,
} = {}) {
    const x0 = Number(trainX);
    const z0 = Number(trainZ);
    const ax = Number(acrossX);
    const az = Number(acrossZ);
    const rail = Number(railY);
    if (![x0, z0, ax, az, rail].every(Number.isFinite) || typeof supportYAt !== 'function') return null;
    const isDeck = y => Number.isFinite(y) && y >= rail + minRiseM && y <= rail + maxRiseM;
    const landingOnSide = (side) => {
        for (let step = 0; startM + step * stepM <= endM + 1e-9; step += 1) {
            const edgeM = startM + step * stepM;
            const edgeY = supportYAt(x0 + ax * side * edgeM, z0 + az * side * edgeM);
            if (!isDeck(edgeY)) continue;
            // A body's width in from the coping when the deck carries on level;
            // a narrow or stepped deck keeps the first sample on it.
            const inM = edgeM + stepInM;
            const inX = x0 + ax * side * inM;
            const inZ = z0 + az * side * inM;
            const inY = supportYAt(inX, inZ);
            const landing = isDeck(inY) && Math.abs(inY - edgeY) <= 0.3
                ? { x: inX, z: inZ, y: inY, distanceM: inM }
                : { x: x0 + ax * side * edgeM, z: z0 + az * side * edgeM, y: edgeY, distanceM: edgeM };
            return { ...landing, side, edgeM };
        }
        return null;
    };
    // The doors open onto the nearest deck; past it on the other side lies another
    // track (at Glavni kolodvor the far platform began 6.3 m out beyond a parked
    // train, the right one 3.8 m out). The outline's side only breaks a tie.
    const first = preferredSide < 0 ? -1 : 1;
    const candidates = [landingOnSide(first), landingOnSide(-first)].filter(Boolean);
    if (!candidates.length) return null;
    candidates.sort((left, right) => left.edgeM - right.edgeM);
    const { edgeM, ...landing } = candidates[0];
    return landing;
}

