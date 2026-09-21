// Combine changed curb tiles with unchanged support into one captured query
// and one physics reservation. The caller supplies the shared registry/boundary.
export function curbCollisionSurfacesNear(surfaces, x, z, radiusM = 120) {
    if (![x, z, radiusM].every(Number.isFinite) || radiusM <= 0) return [];
    const result = [], radiusSquared = radiusM * radiusM;
    for (const surface of surfaces.values()) {
        const bounds = surface.bounds;
        const dx = Math.max(bounds.minX - x, 0, x - bounds.maxX);
        const dz = Math.max(bounds.minZ - z, 0, z - bounds.maxZ);
        if (dx * dx + dz * dz <= radiusSquared) result.push(surface);
    }
    return result;
}

export function* prepareCurbPublicationGroupSteps({
    members, activeSurfaces, revision, getRevision, isCurrent,
    getPhysics, registry, generation, now = () => performance.now(),
    measure = (_label, callback) => callback(),
    preparePhysics = true,
}) {
    const physicsSession = preparePhysics ? getPhysics?.() || null : null;
    const region = physicsSession?.captureGroundPublicationRegion(['curb-surfaces']) || null;
    const physicsCurrent = () => !preparePhysics || (getPhysics?.() || null) === physicsSession
        && (region ? region.isCurrent() : !physicsSession?.captureGroundPublicationRegion(['curb-surfaces']));
    const current = () => isCurrent() && getRevision() === revision && physicsCurrent()
        && members.every(member => member.entry.isCurrent());
    let physics = null, ticket = null, handedOff = false, finalized = false, discarded = false;
    const discard = () => {
        if (discarded || finalized) return;
        discarded = true;
        physics?.entry.discard();
        if (ticket?.state === 'pending') ticket.discard();
        for (const member of members) member.discard();
    };
    try {
        if (!current()) return null;
        const replacements = new Map(members.map(member => [member.tileKey, member.collisionSurface]));
        if (replacements.size !== members.length) throw new TypeError('Duplicate curb group tile');
        const surfaces = new Map();
        let started = now();
        for (const [key, surface] of activeSurfaces) {
            if (!replacements.has(key)) surfaces.set(key, surface);
            if (now() - started >= 0.5) {
                yield { phase: 'curb-support-table' }; started = now();
                if (!current()) return null;
            }
        }
        for (const [key, surface] of replacements) if (surface) surfaces.set(key, surface);
        const read = Object.freeze({ revision: revision + members.length,
            surfacesNear: (x, z, radius) => curbCollisionSurfacesNear(surfaces, x, z, radius),
            isCurrent: current });
        if (region) {
            physics = yield* region.prepareSteps({ 'curb-surfaces': read }, current, measure);
            if (!physics || !current()) return null;
        }
        if (!current()) return null;
        ticket = registry.begin({ key: 'curbs:collision', generation });
        const entry = { ticket, clear: true,
            isCurrent: () => current() && (!physics || physics.entry.isCurrent()),
            commit: () => physics?.entry.commit() ?? true,
            rollback: () => physics?.entry.rollback(),
            discard,
        };
        handedOff = true;
        return { entries: [...members.map(member => member.entry), entry], read, discard,
            finalize() {
                if (finalized || discarded || ticket.state !== 'cleared') return false;
                finalized = true;
                physics?.finalize();
                for (const member of members) member.finalize();
                return true;
            },
        };
    } finally { if (!handedOff) discard(); }
}
