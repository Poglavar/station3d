// Resolves authored campaign world reuse: in-place walker relocation and the
// immutable world pack a directly restored descendant scene must reopen.

import { DEG_TO_RAD, finiteOrNull, geoToLocal } from './math.js';

export function campaignWorldPackForScene(definition, scene) {
    const scenes = new Map(
        (definition?.scenes || []).map(candidate => [candidate.id, candidate]),
    );
    const visited = new Set();
    let candidate = scene || null;
    while (candidate && !visited.has(candidate.id)) {
        visited.add(candidate.id);
        if (candidate.authored?.campaignWorldPack) {
            return candidate.authored.campaignWorldPack;
        }
        const preload = scenes.get(candidate.authored?.preloadSceneId);
        if (preload?.authored?.campaignWorldPack) {
            return preload.authored.campaignWorldPack;
        }
        candidate = scenes.get(candidate.authored?.reuseWorldFrom) || null;
    }
    return null;
}

export function resolveCampaignWalkRelocation({
    pose,
    anchorLat,
    anchorLon,
    groundYAt,
    verticalOffsetM = 0,
} = {}) {
    const lat = finiteOrNull(pose?.lat);
    const lon = finiteOrNull(pose?.lon);
    const anchorLatitude = finiteOrNull(anchorLat);
    const anchorLongitude = finiteOrNull(anchorLon);
    if (lat == null || lon == null || anchorLatitude == null || anchorLongitude == null
        || typeof groundYAt !== 'function') return null;
    const local = geoToLocal(lon, lat, anchorLongitude, anchorLatitude);
    const groundY = finiteOrNull(groundYAt(local.x, local.z));
    if (groundY == null) return null;
    const verticalOffset = finiteOrNull(verticalOffsetM) ?? 0;
    const headingDeg = finiteOrNull(pose?.headingDeg) ?? 0;
    return {
        lat,
        lon,
        x: local.x,
        z: local.z,
        y: groundY + verticalOffset,
        yaw: headingDeg * DEG_TO_RAD,
    };
}

// Replays can move backwards along a reuse chain. Cycles and missing parents
// never establish compatibility, even if two malformed scenes name each other.
export function campaignScenesShareWorld(definition, first, second) {
    const scenes = new Map((definition?.scenes || []).map(scene => [scene.id, scene]));
    const root = scene => {
        const visited = new Set();
        while (scene && !visited.has(scene.id)) {
            visited.add(scene.id);
            const parentId = scene.authored?.reuseWorldFrom;
            if (!parentId) return scene.id;
            scene = scenes.get(parentId);
        }
        return null;
    };
    const a = root(first), b = root(second);
    return a != null && a === b;
}
