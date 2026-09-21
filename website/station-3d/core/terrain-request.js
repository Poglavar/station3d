// Whether terrain was REQUESTED for a session — the rule behind
// isTerrainRequested() in world/terrain.js, kept pure (URL params and what the
// location offers in, boolean out) so it can be tested headlessly instead of
// only by loading a world and looking at it.
//
// Sibling: terrain-grid-request.js is a different kind of request — the bbox and
// resolution of the DGU height grid this session asks the API for, once terrain
// has been requested at all.
//
// Zagreb still has a temporary opt-in rollout while its elevation path is being
// finished, but elevation-on is the target world and the only performance path
// we optimize. A saved PROJECT already requires it: its grade, viaducts, tunnels,
// cuts and estimate are answers to the real ground, so opening it on a flat plane
// would disagree with its own numbers.
//
// Deliberately not solved by decorating links with ?elevation=true: that fixes
// only the links someone remembered to decorate, and leaves a project opened by
// typing a URL, or navigated to in-app, still showing the wrong world.

export function isPhotoLikeWorld(params) {
    return params.has('photo') || params.has('rw') || params.has('real') || params.has('photoreal');
}

export const TERRAIN_SESSION_POLICY = Object.freeze({
    OPT_IN: 'opt-in',
    REQUIRED: 'required',
    LOCATION_DEFAULT: 'location-default',
});

// Absent = not requested. Present with an off-ish value = explicitly refused.
export function flagEnabled(params, key) {
    if (!params.has(key)) return false;
    const value = (params.get(key) || '').trim().toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(value);
}

function flagRefused(params, key) {
    return params.has(key) && !flagEnabled(params, key);
}

// Resolve policy from session intent, not merely from whichever national source
// profile happens to be active. GTA, campaign and project worlds depend on the
// real vertical datum. An ordinary Zagreb tram/walk retains the temporary
// rollout opt-in until the default flips; other prepared locations retain their
// historical default.
export function resolveTerrainSessionPolicy(params, {
    sessionPresetId = '',
    campaignSession = false,
    location = null,
} = {}) {
    const mode = String(params?.get?.('st3d') || '').trim().toLowerCase();
    const preset = String(sessionPresetId || '').trim().toLowerCase();
    if (campaignSession
        || preset === 'gta'
        || ['gta', 'campaign', 'scenario'].includes(mode)
        || params?.has?.('project')) {
        return TERRAIN_SESSION_POLICY.REQUIRED;
    }

    const requestedLocationId = String(params?.get?.('loc') || '').trim().toLowerCase();
    const locationId = String(
        location?.regionalLocationId
        || requestedLocationId
        || (location?.id && location.id !== 'croatia' ? location.id : 'zagreb'),
    ).trim().toLowerCase();
    if (location?.terrainOptIn === true || locationId === 'zagreb') {
        return TERRAIN_SESSION_POLICY.OPT_IN;
    }
    return TERRAIN_SESSION_POLICY.LOCATION_DEFAULT;
}

// params: URLSearchParams (anything with has/get works)
// locationHasTerrain: this location ships or streams an elevation grid
// locationOptIn: that grid stays off unless something asks for it
export function terrainRequested(params, {
    locationHasTerrain,
    locationOptIn,
    sessionPolicy = null,
} = {}) {
    // Photo worlds render Google's own mesh; a DGU surface underneath it is
    // always wrong, so neither a flag nor a project may turn it on.
    if (isPhotoLikeWorld(params)) return false;
    // An explicit ?elevation=0 wins over everything below, including the project
    // rule — there must still be a way to see a project on the flat world.
    if (flagRefused(params, 'elevation')) return false;
    const asked = flagEnabled(params, 'elevation');
    if (!locationHasTerrain) return asked;   // nothing to show; only a flag would try
    if (sessionPolicy === TERRAIN_SESSION_POLICY.REQUIRED) return true;
    if (sessionPolicy === TERRAIN_SESSION_POLICY.OPT_IN) {
        return asked || params.has('project');
    }
    if (!locationOptIn) return true;         // a location that HAS terrain shows it
    return asked || params.has('project');
}
