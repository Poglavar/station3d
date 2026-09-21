// Vertical ownership for OSM pedestrian/cycle surfaces carried by /roads/cab.
// Ordinary paths follow the composed civil ground supplied by their builder.
// Only a way explicitly mapped as a roadside sidewalk may inherit the nearby
// carriageway centreline's smoothed longitudinal profile.

const SIDEWALK_PATH_TYPES = new Set([
    'footway',
    'path',
    'cycleway',
    'steps',
    'bridleway',
    'pedestrian',
]);

function normalized(value) {
    return String(value ?? '').trim().toLowerCase();
}

export function roadPathUsesNearbyCarriagewayProfile(properties = {}) {
    const highway = normalized(properties.highway_type ?? properties.highway);
    if (!SIDEWALK_PATH_TYPES.has(highway)) return false;
    const tags = properties.tags || {};
    return normalized(tags.footway) === 'sidewalk'
        || normalized(tags.cycleway) === 'sidewalk';
}

// A separately mapped sidewalk may approach an intersection more closely than
// the carriageway it actually follows. Resolve its local direction once from
// the source centerline so elevation sampling can prefer a parallel road over
// a merely closer perpendicular one. Returning a sampler keeps this pure and
// avoids rebuilding the path segments for every tessellated surface vertex.
export function createRoadPathTangentSampler(localLines = []) {
    const segments = [];
    for (const line of Array.isArray(localLines) ? localLines : []) {
        if (!Array.isArray(line)) continue;
        for (let index = 0; index + 1 < line.length; index++) {
            const a = line[index];
            const b = line[index + 1];
            const x1 = Number(a?.x);
            const z1 = Number(a?.z);
            const x2 = Number(b?.x);
            const z2 = Number(b?.z);
            const dx = x2 - x1;
            const dz = z2 - z1;
            const lengthM = Math.hypot(dx, dz);
            if (![x1, z1, x2, z2].every(Number.isFinite) || !(lengthM > 1e-6)) continue;
            segments.push({
                x1,
                z1,
                dx,
                dz,
                lengthSquared: lengthM * lengthM,
                tangentX: dx / lengthM,
                tangentZ: dz / lengthM,
            });
        }
    }
    if (segments.length === 0) return null;
    return (x, z) => {
        const localX = Number(x);
        const localZ = Number(z);
        if (!Number.isFinite(localX) || !Number.isFinite(localZ)) return null;
        let nearest = null;
        let nearestDistanceSquared = Infinity;
        for (const segment of segments) {
            const t = Math.max(0, Math.min(1,
                ((localX - segment.x1) * segment.dx
                    + (localZ - segment.z1) * segment.dz)
                    / segment.lengthSquared));
            const projectedX = segment.x1 + segment.dx * t;
            const projectedZ = segment.z1 + segment.dz * t;
            const distanceSquared = (localX - projectedX) ** 2
                + (localZ - projectedZ) ** 2;
            if (distanceSquared >= nearestDistanceSquared) continue;
            nearestDistanceSquared = distanceSquared;
            nearest = {
                tangentX: segment.tangentX,
                tangentZ: segment.tangentZ,
            };
        }
        return nearest;
    };
}
