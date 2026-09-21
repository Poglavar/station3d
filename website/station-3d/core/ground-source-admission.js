// Seal dependents before their source dependencies. A curb callback may arrive
// before its road-mask callback; freezing both streams at once makes that
// missing input impossible to deliver until an expensive candidate is rejected.
// Only a finite captured tile set is retained while those dependencies arrive.
export function createGroundSourceAdmission({ session, sourceKeys, firstSources,
    captureDependencies, layersReady, maxDependencyTiles, drainRequested = false,
    requestedTileKeys = null }) {
    if (!session?.holdSources || !session?.retainSourceTiles || !session?.reconcileSourceWindows
        || !Array.isArray(sourceKeys) || !sourceKeys.length
        || new Set(sourceKeys).size !== sourceKeys.length || !Array.isArray(firstSources)
        || !firstSources.length || new Set(firstSources).size !== firstSources.length
        || firstSources.some(key => !sourceKeys.includes(key))
        || typeof captureDependencies !== 'function' || typeof layersReady !== 'function'
        || !Number.isSafeInteger(maxDependencyTiles) || maxDependencyTiles < 1) {
        throw new TypeError('Ground source admission requires a bounded dependency order');
    }
    const remaining = sourceKeys.filter(key => !firstSources.includes(key));
    const holds = [], retentions = [];
    const holdOptions = {
        drainQueued: true,
        drainRequested,
        requestedTileKeys,
        handoffDelivery: true,
        maxTiles: maxDependencyTiles,
    };
    let dependencies = null, sealed = false, released = false;
    const lease = {
        isCurrent: () => !released && [...holds, ...retentions].every(value => value.isCurrent()),
        release() {
            if (released) return false;
            released = true;
            for (const value of [...holds, ...retentions].reverse()) value.release();
            return true;
        },
    };
    return {
        poll() {
            if (released) return null;
            try {
                if (!holds.length) {
                    // A completed generation releases its source holds between
                    // frames. Drain already-expired membership before sealing
                    // the next one, or each bounded teardown slice gets pinned
                    // again and causes another whole ground generation.
                    if (!session.reconcileSourceWindows([...firstSources, ...remaining])) return null;
                    holds.push(session.holdSources(firstSources, holdOptions));
                }
                for (const hold of holds) hold.request?.();
                if (!holds[0].isReady()) return null;
                if (!dependencies) {
                    dependencies = captureDependencies();
                    let tileCount = 0;
                    for (const dependency of dependencies) {
                        tileCount += dependency.tileKeys.length;
                        if (tileCount > maxDependencyTiles) {
                            throw Object.assign(new RangeError('Ground source dependency capacity exceeded'),
                                { code: 'ground-generation-capacity' });
                        }
                        if (!remaining.includes(dependency.sourceKey) || typeof dependency.isReady !== 'function') {
                            throw new TypeError('Ground dependency must belong to an unsealed source');
                        }
                        retentions.push(session.retainSourceTiles(dependency.sourceKey, dependency.tileKeys,
                            { maxTiles: maxDependencyTiles }));
                    }
                    // Replace the prior publication's barrier before asking
                    // retained dependencies to deliver. This bounded hold
                    // admits only the matching source keys for this generation.
                    if (remaining.length) {
                        const dependencyTileKeys = [...new Set(dependencies.flatMap(value => value.tileKeys))];
                        const remainingRequestedTileKeys = [...new Set([
                            ...(requestedTileKeys || []),
                            ...dependencyTileKeys,
                        ])];
                        holds.push(session.holdSources(remaining, {
                            ...holdOptions,
                            drainRequested: true,
                            // An empty curb batch is valid when the generation
                            // was triggered by an eviction or another ground
                            // family. The remaining road sources must still
                            // admit the masks used by the retained curb model.
                            // [] is truthy, so the old fallback silently held
                            // an empty set and left dependency readiness false
                            // forever after the preceding publication.
                            // The first-source priority batch can be smaller
                            // than the dependency closure captured from the
                            // already-published curb model. Remaining sources
                            // must admit both sets. Reusing only the priority
                            // keys parks missing road masks behind this hold,
                            // so neither the admission nor any later moving
                            // ground generation can ever seal.
                            requestedTileKeys: remainingRequestedTileKeys,
                        }));
                    }
                }
                if (!dependencies.every(value => value.isReady())) {
                    // fetchTile preserves the shared source's ordinary retry
                    // backoff. New curb callbacks cannot grow this fixed set.
                    for (const retention of retentions) retention.request();
                    return null;
                }
                if (!sealed) sealed = true;
                if (!holds.every(value => value.isReady()) || !layersReady()) return null;
                holds.forEach(value => value.armHandoff?.());
                return lease;
            } catch (error) { lease.release(); throw error; }
        },
        release: lease.release,
    };
}
