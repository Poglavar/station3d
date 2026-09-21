// Rapier resource staging for the shared surface generation boundary. This is
// not a second surface authority: callers supply the already resolved physical
// meshes. Disabled candidates can be prepared without replacing active support.

export function fixedSurfaceColliders(entry) {
    return Array.isArray(entry?.colliders) ? entry.colliders : entry?.collider ? [entry.collider] : [];
}

export function* prepareFixedSurfacePublicationSteps({
    RAPIER, world, active, metadata, replacements, activeColliderCount,
    maxColliders, maxStagedColliders,
}) {
    if (!world || !(active instanceof Map) || !(metadata instanceof Map)
        || !Array.isArray(replacements) || replacements.length === 0) {
        throw new TypeError('Fixed surface publication requires a world, indexes and replacements');
    }
    const keys = new Set();
    let addedCount = 0;
    let removedCount = 0;
    const rows = replacements.map(({ key, spec, meshes }) => {
        if (typeof key !== 'string' || !key || keys.has(key) || spec?.id !== key
            || !Array.isArray(meshes)) throw new TypeError('Invalid fixed surface replacement');
        keys.add(key);
        const previous = active.get(key);
        addedCount += meshes.length;
        removedCount += fixedSurfaceColliders(previous).length;
        return {
            key, spec, meshes, previous, next: null,
            previousEnabled: previous?.body?.isEnabled() === true,
            previousMetadata: fixedSurfaceColliders(previous)
                .filter(collider => metadata.has(collider.handle))
                .map(collider => [collider.handle, metadata.get(collider.handle)]),
        };
    });
    for (const value of [activeColliderCount, maxColliders, maxStagedColliders]) {
        if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid collider capacity');
    }
    const nextColliderCount = activeColliderCount - removedCount + addedCount;
    if (nextColliderCount < 0 || nextColliderCount > maxColliders || addedCount > maxStagedColliders) {
        const error = new Error('Fixed surface publication exceeds collider capacity');
        error.code = 'surface-collider-capacity';
        throw error;
    }
    let state = 'preparing';
    const remove = entry => { if (entry?.body) world.removeRigidBody(entry.body); };
    const clearRows = () => { rows.length = 0; };
    const discard = () => {
        for (const row of rows) remove(row.next);
        state = 'discarded';
        clearRows();
    };
    let prepared = false;
    try {
        let stagedColliders = 0;
        for (const row of rows) {
            const body = row.meshes.length
                ? world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setEnabled(false)) : null;
            const colliders = [];
            row.next = { body, colliders, collider: null, spec: row.spec };
            for (const mesh of row.meshes) {
                const descriptor = RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices)
                    .setFriction(mesh.friction)
                    .setCollisionGroups(mesh.collisionGroups);
                const collider = world.createCollider(descriptor, body);
                colliders.push(collider);
                // Rapier can enable a newly attached collider after its
                // disabled parent has already crossed a world.step(). Keep
                // each staged collider explicitly disabled across yields.
                collider.setEnabled(false);
                // Mesh geometry is already bounded by its producer. Yield
                // after each native allocation while old support stays live.
                yield { phase: 'surface-collider-allocation', stagedColliders: ++stagedColliders };
            }
            row.next.collider = colliders[0] || null;
        }
        state = 'prepared';
        prepared = true;
    } finally {
        // Closing a superseded iterator owns the partially constructed body
        // too, even if no publication handle was returned to the caller yet.
        if (!prepared) discard();
    }
    const rollback = () => {
        if (state !== 'promoted') return false;
        for (const row of rows) {
            row.next.body?.setEnabled(false);
            for (const collider of row.next.colliders) collider.setEnabled(false);
            for (const collider of fixedSurfaceColliders(row.next)) metadata.delete(collider.handle);
            if (row.previous) active.set(row.key, row.previous);
            else active.delete(row.key);
            row.previous?.body?.setEnabled(row.previousEnabled);
            for (const [handle, value] of row.previousMetadata) metadata.set(handle, value);
        }
        state = 'prepared';
        return true;
    };
    return {
        get state() { return state; },
        addedCount, removedCount, nextColliderCount,
        // Entries become query-visible only at promote. No allocations or
        // trimesh construction belong here. Call before the next physics step.
        promote() {
            if (state !== 'prepared') throw new Error(`Cannot promote ${state} surface colliders`);
            if (rows.some(row => active.get(row.key) !== row.previous)) {
                discard();
                return false;
            }
            state = 'promoted';
            try {
                for (const row of rows) row.previous?.body?.setEnabled(false);
                for (const row of rows) {
                    row.next.body?.setEnabled(true);
                    for (const collider of row.next.colliders) collider.setEnabled(true);
                    active.set(row.key, row.next);
                    for (const collider of fixedSurfaceColliders(row.previous)) metadata.delete(collider.handle);
                    row.next.colliders.forEach((collider, index) => {
                        metadata.set(collider.handle, row.meshes[index].spec || row.spec);
                    });
                }
            } catch (error) {
                rollback();
                discard();
                throw error;
            }
            return true;
        },
        rollback,
        // The render/support transaction calls retire only after every member
        // has promoted. Until then rollback can re-enable the previous bodies.
        retire() {
            if (state !== 'promoted') throw new Error(`Cannot retire ${state} surface colliders`);
            const errors = [];
            for (const row of rows) {
                try { remove(row.previous); } catch (error) { errors.push(error); }
            }
            state = 'retired';
            clearRows();
            return errors;
        },
        dispose() {
            if (state === 'retired' || state === 'discarded') return false;
            rollback();
            discard();
            return true;
        },
    };
}

// Immediate callers use the same compiler and lifecycle; engine work queues
// consume the generator above to spread allocation across scheduler turns.
export function prepareFixedSurfacePublication(options) {
    const steps = prepareFixedSurfacePublicationSteps(options);
    let next;
    do { next = steps.next(); } while (!next.done);
    return next.value;
}
