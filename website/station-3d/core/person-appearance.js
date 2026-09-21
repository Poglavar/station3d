// Stable crowd appearance shared by moving people and instanced waiting people.
// The atlas is a fixed palette; head proportions add independent variation.
export const CROWD_FACE_COLUMNS = 8;
export const CROWD_FACE_COUNT = 64;
export const CROWD_FACE_TILE_PX = 128;
export const CROWD_FACE_NEAR_M = 15;
export const CROWD_FACE_FAR_M = 30;

function mix(value) {
    let n = value >>> 0;
    n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
    n = Math.imul(n ^ (n >>> 15), 0x735a2d97);
    return (n ^ (n >>> 15)) >>> 0;
}

export function personFaceSeed(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
    let hash = 2166136261;
    for (const character of String(value)) {
        hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    }
    return hash >>> 0;
}

export function personHeadProfile(seed, kind = 'male') {
    const faceSeed = personFaceSeed(seed);
    const sample = salt => mix(faceSeed ^ Math.imul(salt, 0x9e3779b9));
    const base = kind === 'kid' ? 0 : kind === 'female' ? 16 : 32;
    const variant = base + sample(1) % (base === 32 ? 32 : 16);
    return {
        faceSeed,
        variant,
        width: 0.93 + sample(2) / 0x100000000 * 0.15,
        height: 0.95 + sample(3) / 0x100000000 * 0.14,
        depth: 0.96 + sample(4) / 0x100000000 * 0.09,
    };
}

export function crowdFaceDetailAtDistance(distance) {
    const t = Math.max(0, Math.min(1,
        (distance - CROWD_FACE_NEAR_M) / (CROWD_FACE_FAR_M - CROWD_FACE_NEAR_M)));
    return 1 - t * t * (3 - 2 * t);
}

export function crowdFaceFeatures(variant) {
    const n = ((variant % CROWD_FACE_COUNT) + CROWD_FACE_COUNT) % CROWD_FACE_COUNT;
    const hairColors = [0x302722, 0x523929, 0x72533a, 0xb59259, 0x945436, 0x9c9790, 0x242528, 0x594842];
    const eyeColors = [0x4d655c, 0x526b7c, 0x655039, 0x4a3c30];
    return {
        hairColor: hairColors[mix(n + 23) % hairColors.length],
        eyeColor: eyeColors[mix(n + 71) % eyeColors.length],
        eyeX: 0.29 + n % 4 * 0.025,
        eyeY: 0.12 + Math.floor(n / 4) % 3 * 0.023,
        eyeWidth: 0.104 + n % 3 * 0.008,
        eyeHeight: 0.058 + Math.floor(n / 3) % 3 * 0.007,
        browSlope: (n % 5 - 2) * 0.1,
        browThickness: 0.024 + n % 3 * 0.007,
        mouthWidth: 0.19 + n % 4 * 0.018,
        smile: 0.14 + Math.floor(n / 5) % 4 * 0.08,
        hairline: 0.59 + n % 4 * 0.04,
        part: n % 3 - 1,
        bald: n >= 32 && n % 11 === 0,
        beard: n >= 32 && n % 5 === 0,
        moustache: n >= 32 && n % 7 === 0,
    };
}
