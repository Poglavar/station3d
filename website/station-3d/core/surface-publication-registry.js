// Atomic lifecycle ownership for replaceable Station3D surface generations.
//
// SurfaceClaim answers "what is this surface?" and the hierarchy answers
// same-level overlap semantics. This registry answers the separate question
// "which complete generation of this one producer key is live?". Keys never
// compete spatially: a road below a rail bridge uses a different key and both
// remain published, with ordinary depth preserving the grade separation.

import { asSurfaceClaim } from './surface-hierarchy.js';

const RECENT_PROBLEM_LIMIT = 32;

export class SurfacePublicationError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'SurfacePublicationError';
        this.code = code;
        this.details = details;
    }
}

function publicationKey(value) {
    const key = String(value || '').trim();
    if (!key) {
        throw new SurfacePublicationError(
            'missing-publication-key',
            'Surface publication requires a non-empty replacement key',
        );
    }
    return key;
}

function publicationGeneration(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new SurfacePublicationError(
            'missing-publication-generation',
            'Surface publication requires a finite generation',
        );
    }
    return value;
}

function objectLabel(object) {
    return String(object?.name || object?.type || object?.constructor?.name || '(unnamed)');
}

function materialClaimsForObject(object) {
    const materials = Array.isArray(object?.material)
        ? object.material
        : object?.material
            ? [object.material]
            : [];
    const claims = [];
    for (const material of materials) {
        const claim = material?.userData?.surfaceClaim;
        if (claim) claims.push(asSurfaceClaim(claim));
    }
    return claims;
}

function walkObjectTree(root, visit) {
    const seen = new Set();
    const walk = (object, inheritedClaim = null) => {
        if (!object || typeof object !== 'object' || seen.has(object)) return;
        seen.add(object);
        const ownClaim = object.userData?.surfaceClaim
            ? asSurfaceClaim(object.userData.surfaceClaim)
            : null;
        const effectiveClaim = ownClaim || inheritedClaim;
        visit(object, effectiveClaim);
        for (const child of object.children || []) walk(child, effectiveClaim);
    };
    walk(root);
}

function surfacePublicationClaimRecords(root) {
    const records = [];
    walkObjectTree(root, (object, inheritedClaim) => {
        if (!object.isMesh) return;
        records.push({
            object,
            claims: inheritedClaim
                ? [inheritedClaim]
                : materialClaimsForObject(object),
        });
    });
    return records;
}

// Mixed scene payloads (for example land-use surfaces plus forest props) use
// this same coverage verdict to separate the surface-publication root before
// publishing. Keeping it beside the registry prevents producers from growing
// their own, subtly different definition of a claimed mesh.
export function surfacePublicationClaimCoverage(root) {
    const records = surfacePublicationClaimRecords(root);
    const missingObjects = records
        .filter(record => record.claims.length === 0)
        .map(record => objectLabel(record.object));
    return Object.freeze({
        meshCount: records.length,
        claimedMeshCount: records.length - missingObjects.length,
        missingMeshCount: missingObjects.length,
        complete: records.length > 0 && missingObjects.length === 0,
        missingObjects: Object.freeze(missingObjects),
    });
}

// Validate the complete detached candidate before it is allowed into a scene.
// A mesh may inherit an object claim or use a material claim, but every mesh in
// a replaceable root must have one. Optional identity carried by an individual
// claim must agree with the transaction identity; null means the root-level
// publication supplies that identity for a mixed semantic group.
export function inspectSurfacePublicationRoot(root, { key, generation } = {}) {
    const replacementKey = publicationKey(key);
    const resolvedGeneration = publicationGeneration(generation);
    if (!root || typeof root !== 'object') {
        throw new SurfacePublicationError(
            'missing-publication-root',
            `Surface publication ${replacementKey} has no candidate root`,
        );
    }
    if (root.parent) {
        throw new SurfacePublicationError(
            'candidate-already-attached',
            `Surface publication ${replacementKey} must be validated off-scene`,
            { object: objectLabel(root) },
        );
    }

    const records = surfacePublicationClaimRecords(root);
    const meshCount = records.length;
    const claims = new Set();
    const missingObjects = [];
    const keyMismatches = [];
    const generationMismatches = [];
    for (const { object, claims: resolvedClaims } of records) {
        if (resolvedClaims.length === 0) {
            missingObjects.push(objectLabel(object));
            continue;
        }
        for (const claim of resolvedClaims) {
            claims.add(claim);
            if (claim.replacementKey && claim.replacementKey !== replacementKey) {
                keyMismatches.push({
                    object: objectLabel(object),
                    claimKey: claim.replacementKey,
                });
            }
            if (claim.generation != null && claim.generation !== resolvedGeneration) {
                generationMismatches.push({
                    object: objectLabel(object),
                    claimGeneration: claim.generation,
                });
            }
        }
    }
    if (meshCount === 0) {
        throw new SurfacePublicationError(
            'empty-publication-root',
            `Surface publication ${replacementKey} contains no meshes; clear it explicitly`,
        );
    }
    if (missingObjects.length > 0) {
        throw new SurfacePublicationError(
            'missing-surface-claim',
            `Surface publication ${replacementKey} has ${missingObjects.length} unclaimed mesh(es)`,
            { objects: missingObjects.slice(0, 12) },
        );
    }
    if (keyMismatches.length > 0) {
        throw new SurfacePublicationError(
            'publication-key-mismatch',
            `Surface publication ${replacementKey} contains a competing replacement key`,
            { mismatches: keyMismatches.slice(0, 12) },
        );
    }
    if (generationMismatches.length > 0) {
        throw new SurfacePublicationError(
            'publication-generation-mismatch',
            `Surface publication ${replacementKey} contains a stale claim generation`,
            { mismatches: generationMismatches.slice(0, 12) },
        );
    }

    const claimList = [...claims];
    return Object.freeze({
        key: replacementKey,
        generation: resolvedGeneration,
        meshCount,
        claimCount: claimList.length,
        surfaceClasses: Object.freeze([...new Set(claimList.map(claim => claim.surfaceClass))]),
        verticalBands: Object.freeze([
            ...new Set(claimList.map(claim => claim.verticalBand).filter(Boolean)),
        ]),
        ownerIds: Object.freeze([
            ...new Set(claimList.map(claim => claim.ownerId).filter(Boolean)),
        ]),
    });
}

function defaultAdd(parent, root) {
    if (!parent || typeof parent.add !== 'function') {
        throw new SurfacePublicationError(
            'missing-publication-parent',
            'Surface publication parent must provide add(root)',
        );
    }
    parent.add(root);
}

function defaultRemove(_context, root) {
    root?.parent?.remove?.(root);
}

export function surfacePublicationIdentityForObject(object) {
    for (let node = object; node; node = node.parent) {
        const identity = node.userData?.surfacePublication;
        if (identity?.contract === 'station3d-surface-publication-v1') return identity;
    }
    return null;
}

export function createSurfacePublicationRegistry({
    prepare = null,
    inspect = inspectSurfacePublicationRoot,
    now = () => Date.now(),
    recentProblemLimit = RECENT_PROBLEM_LIMIT,
} = {}) {
    const activeByKey = new Map();
    const latestRequestedByKey = new Map();
    const pendingTickets = new Map();
    const ticketHandles = new WeakMap();
    const listeners = new Set();
    const recentProblems = [];
    let nextTicketId = 1;
    let closed = false;
    const counters = {
        begun: 0,
        published: 0,
        cleared: 0,
        retired: 0,
        discarded: 0,
        staleRejected: 0,
        conflicts: 0,
        missingClaims: 0,
        invalidClaims: 0,
        failed: 0,
    };

    const notify = (event) => {
        const immutableEvent = Object.freeze(event);
        for (const listener of [...listeners]) {
            try {
                listener(immutableEvent);
            } catch (error) {
                // A lifecycle observer may request dependent rebuilds, but it
                // is never part of the already-committed publication itself.
                // Keep the active owner and report the observer failure.
                noteProblem(
                    'publication-listener-failed',
                    event.key,
                    event.generation,
                    error?.message,
                );
            }
        }
    };

    const noteProblem = (type, key, generation, message, details = null) => {
        recentProblems.push(Object.freeze({
            type,
            key,
            generation,
            message: String(message || type),
            details,
            atMs: now(),
        }));
        while (recentProblems.length > Math.max(1, recentProblemLimit)) {
            recentProblems.shift();
        }
    };

    const resolveTicket = (ticket, status) => {
        ticket.state = status;
        pendingTickets.delete(ticket.id);
    };

    const discardRoot = (ticket, root, reason, lifecycle) => {
        const discard = root ? lifecycle.discard || lifecycle.retire || defaultRemove : lifecycle.discard;
        if (!discard) return;
        try {
            discard({
                key: ticket.key,
                generation: ticket.generation,
                reason,
                registry: api,
            }, root);
        } catch (error) {
            // A throwing disposer must not leave a rejected candidate visible.
            defaultRemove(null, root);
            counters.failed += 1;
            noteProblem('discard-failed', ticket.key, ticket.generation, error?.message, {
                object: objectLabel(root),
            });
        }
    };

    const rejectTicket = (ticket, type, root, lifecycle, message, details = null) => {
        if (type === 'stale-rejected') counters.staleRejected += 1;
        else counters.conflicts += 1;
        noteProblem(type, ticket.key, ticket.generation, message, details);
        discardRoot(ticket, root, type, lifecycle);
        resolveTicket(ticket, type);
        return Object.freeze({ status: type, key: ticket.key, generation: ticket.generation });
    };

    const checkFreshness = (ticket, root, lifecycle) => {
        const requestedGeneration = latestRequestedByKey.get(ticket.key);
        const active = activeByKey.get(ticket.key) || null;
        if ((requestedGeneration != null && ticket.generation < requestedGeneration)
            || (active && ticket.generation < active.generation)) {
            return rejectTicket(
                ticket,
                'stale-rejected',
                root,
                lifecycle,
                `Rejected stale generation ${ticket.generation}; newest is ${Math.max(
                    requestedGeneration ?? -Infinity,
                    active?.generation ?? -Infinity,
                )}`,
            );
        }
        if (active && ticket.generation === active.generation) {
            if (root && active.root === root) {
                resolveTicket(ticket, 'already-active');
                return Object.freeze({
                    status: 'already-active',
                    key: ticket.key,
                    generation: ticket.generation,
                });
            }
            return rejectTicket(
                ticket,
                'conflict-rejected',
                root,
                lifecycle,
                `Generation ${ticket.generation} already has an active owner`,
                { activeObject: objectLabel(active.root), candidateObject: objectLabel(root) },
            );
        }
        return null;
    };

    const retireRecord = (record, context) => {
        if (!record) return null;
        try {
            (record.retire || defaultRemove)(context, record.root);
            counters.retired += 1;
            return null;
        } catch (error) {
            // Ownership already switched. Keep retirement failure observable,
            // but never render both generations because cleanup threw.
            defaultRemove(null, record.root);
            counters.conflicts += 1;
            counters.failed += 1;
            noteProblem('retire-failed', record.key, record.generation, error?.message, {
                object: objectLabel(record.root),
            });
            return error;
        }
    };

    function begin(options = {}) {
        if (closed) {
            throw new SurfacePublicationError(
                'registry-closed',
                'Cannot begin a publication on a closed surface registry',
            );
        }
        const key = publicationKey(options.key);
        const generation = publicationGeneration(options.generation);
        const latestRequested = latestRequestedByKey.get(key);
        if (latestRequested == null || generation > latestRequested) {
            latestRequestedByKey.set(key, generation);
        }
        const ticket = {
            id: nextTicketId++,
            key,
            generation,
            state: 'pending',
            lifecycle: {
                parent: options.parent || null,
                add: options.add || null,
                retire: options.retire || null,
                discard: options.discard || null,
                prepare: options.prepare || null,
                isCurrent: options.isCurrent ?? null,
            },
        };
        counters.begun += 1;
        pendingTickets.set(ticket.id, ticket);

        const requirePending = () => {
            if (ticket.state !== 'pending') {
                throw new SurfacePublicationError(
                    'ticket-settled',
                    `Surface publication ticket is already ${ticket.state}`,
                    { key, generation },
                );
            }
        };

        const handle = Object.freeze({
            key,
            generation,
            get state() { return ticket.state; },
            publish(root, publishOptions = {}) {
                requirePending();
                const batch = prepareBatch([{ ...publishOptions, ticket: handle, root }]);
                if (!batch.publish) return Object.freeze({ ...batch, key, generation });
                const result = batch.publish();
                return result.results?.[0] || Object.freeze({ ...result, key, generation });
            },
            clear(clearOptions = {}) {
                requirePending();
                const batch = prepareBatch([{ ...clearOptions, ticket: handle, clear: true }]);
                if (!batch.publish) return Object.freeze({ ...batch, key, generation });
                const result = batch.publish();
                return result.results?.[0] || Object.freeze({ ...result, key, generation });
            },
            discard(reason = 'discarded') {
                requirePending();
                counters.discarded += 1;
                resolveTicket(ticket, reason);
                return Object.freeze({ status: reason, key, generation });
            },
        });
        ticketHandles.set(handle, ticket);
        return handle;
    }

    // Prepare an already-built dependency group off-scene. The returned publish
    // operation performs scene/index/pointer swaps only: geometry compilation,
    // collider construction and asynchronous GPU prewarming belong to callers
    // before this boundary. Notifications and retirement follow ALL commits.
    // Entries use ordinary registry tickets; this is not another owner registry.
    function prepareBatch(entries, options = {}) {
        if (closed) throw new SurfacePublicationError('registry-closed', 'Surface registry is closed');
        if (!Array.isArray(entries) || entries.length === 0) {
            throw new SurfacePublicationError('empty-publication-batch', 'A surface batch requires candidates');
        }
        if (options.isCurrent != null && typeof options.isCurrent !== 'function') {
            throw new SurfacePublicationError('invalid-publication-validity', 'Batch validity must be a synchronous function');
        }
        if (options.withValidationScope != null && typeof options.withValidationScope !== 'function') {
            throw new SurfacePublicationError('invalid-publication-validity', 'Validation scope must be a synchronous function');
        }
        const keys = new Set(), roots = new Set();
        const rows = entries.map(entry => {
            const ticket = ticketHandles.get(entry?.ticket);
            const clear = entry?.clear === true;
            if (!ticket || ticket.state !== 'pending' || keys.has(ticket.key)
                || (clear ? entry.root != null : !entry.root || roots.has(entry.root))) {
                throw new SurfacePublicationError('invalid-publication-batch', 'Batch tickets must be distinct and pending; each entry requires a distinct root or an explicit clear');
            }
            keys.add(ticket.key); if (!clear) roots.add(entry.root);
            const validity = entry.isCurrent ?? ticket.lifecycle.isCurrent;
            if (validity != null && typeof validity !== 'function') {
                throw new SurfacePublicationError('invalid-publication-validity', 'Candidate validity must be a synchronous function');
            }
            return { ticket, clear, root: clear ? null : entry.root, lifecycle: { ...ticket.lifecycle, ...entry },
                previous: activeByKey.get(ticket.key) || null,
                priorIdentity: entry.root?.userData?.surfacePublication,
                inspection: null, active: null, commitEntered: false };
        });
        let batchState = 'preparing';
        const contextFor = row => ({
            key: row.ticket.key, generation: row.ticket.generation,
            previous: row.previous, inspection: row.inspection, active: row.active, registry: api,
        });
        const contexts = () => rows.map(contextFor);
        const discard = reason => {
            for (const row of rows) {
                if (['pending', 'staged'].includes(row.ticket.state)) {
                    discardRoot(row.ticket, row.root, reason, row.lifecycle);
                    resolveTicket(row.ticket, reason);
                    counters.discarded += 1;
                }
                row.ticket.stagedRoot = null;
                row.ticket.stagedLifecycle = null;
            }
            rows.length = 0;
            batchState = reason;
            return Object.freeze({ status: reason });
        };
        const freshCore = () => {
            for (const row of rows) {
                if (!['pending', 'staged'].includes(row.ticket.state)) return row.ticket.state;
                const result = checkFreshness(row.ticket, row.root, row.lifecycle);
                if (result) return result.status;
                if ((activeByKey.get(row.ticket.key) || null) !== row.previous) return 'dependency-revised';
                if (row.lifecycle.isCurrent) {
                    try {
                        if (row.lifecycle.isCurrent(contextFor(row)) !== true) return 'dependency-revised';
                    } catch (error) {
                        counters.failed += 1;
                        noteProblem('dependency-check-failed', row.ticket.key, row.ticket.generation, error?.message);
                        return 'dependency-check-failed';
                    }
                }
            }
            if (options.isCurrent) {
                try {
                    if (options.isCurrent({ registry: api, entries: contexts() }) !== true) return 'dependency-revised';
                } catch (error) {
                    counters.failed += 1;
                    noteProblem('dependency-check-failed', null, null, error?.message);
                    return 'dependency-check-failed';
                }
            }
            return null;
        };
        const fresh = () => {
            if (!options.withValidationScope) return freshCore();
            let calls = 0, result, expected, active = true;
            const check = () => {
                if (!active) return false;
                calls += 1;
                if (calls !== 1) throw new Error('Validation scope check invoked more than once');
                expected = freshCore(); return expected;
            };
            try { result = options.withValidationScope(check); }
            catch (error) {
                active = false;
                counters.failed += 1;
                noteProblem('dependency-check-failed', null, null, error?.message);
                return 'dependency-check-failed';
            }
            active = false;
            if (calls !== 1 || result !== expected || result && typeof result.then === 'function') {
                counters.failed += 1;
                noteProblem('dependency-check-failed', null, null, 'Validation scope must invoke its check exactly once and return synchronously');
                return 'dependency-check-failed';
            }
            return result;
        };
        const initialRejection = fresh();
        if (initialRejection) return discard(initialRejection);
        try {
            // Inspect every root before preparing any resource. Neither phase
            // may attach a candidate or mutate a published support authority.
            for (const row of rows) if (!row.clear) row.inspection = inspect(row.root, row.ticket);
            for (const row of rows) {
                const { ticket, root, lifecycle } = row;
                if (!row.clear) {
                    root.userData ||= {};
                    root.userData.surfacePublication = Object.freeze({
                        contract: 'station3d-surface-publication-v1', key: ticket.key, generation: ticket.generation,
                    });
                    const prepareCandidate = lifecycle.prepare || prepare;
                    const value = prepareCandidate?.(root, contextFor(row));
                    if (value?.then) throw new SurfacePublicationError('async-publication-prepare', 'Await resource preparation before staging publication');
                    if (root.parent) throw new SurfacePublicationError('candidate-already-attached', 'Batch preparation must leave candidates off-scene');
                }
                ticket.state = 'staged';
                ticket.stagedRoot = root;
                ticket.stagedLifecycle = lifecycle;
            }
        } catch (error) {
            if (error?.code === 'missing-surface-claim') counters.missingClaims += 1;
            else counters.invalidClaims += 1;
            counters.failed += 1;
            noteProblem(error?.code || 'batch-preparation-failed', null, null, error?.message);
            discard('validation-failed');
            throw error;
        }
        batchState = 'staged';
        return Object.freeze({
            get state() { return batchState; },
            discard(reason = 'discarded') {
                if (batchState !== 'staged') throw new SurfacePublicationError('batch-settled', `Batch is ${batchState}`);
                return discard(reason);
            },
            publish() {
                if (batchState !== 'staged') throw new SurfacePublicationError('batch-settled', `Batch is ${batchState}`);
                const rejection = fresh();
                if (rejection) return discard(rejection);
                const batchContext = { registry: api, entries: contexts() };
                let switched = false, groupCommitEntered = false;
                try {
                    for (const [index, row] of rows.entries()) {
                        if (row.clear) continue;
                        if (row.root.parent) throw new SurfacePublicationError('candidate-already-attached', 'A staged candidate was attached before publication');
                        const context = batchContext.entries[index];
                        if (row.lifecycle.add) row.lifecycle.add(context, row.root);
                        else defaultAdd(row.lifecycle.parent, row.root);
                        row.active = {
                            key: row.ticket.key, generation: row.ticket.generation, root: row.root,
                            retire: row.lifecycle.retire || null, inspection: row.inspection, publishedAtMs: now(),
                        };
                    }
                    for (const row of rows) {
                        if (row.clear) activeByKey.delete(row.ticket.key);
                        else activeByKey.set(row.ticket.key, row.active);
                    }
                    switched = true;
                    batchContext.entries = contexts();
                    for (const [index, row] of rows.entries()) {
                        row.commitEntered = true;
                        const value = row.lifecycle.commit?.(batchContext.entries[index]);
                        if (value?.then) throw new SurfacePublicationError('async-publication-commit', 'Publication commits must be synchronous');
                        if (value === false) throw new SurfacePublicationError(
                            'rejected-publication-commit',
                            `Publication commit rejected for ${row.ticket.key}@${row.ticket.generation}`,
                        );
                    }
                    groupCommitEntered = true;
                    const value = options.commit?.(batchContext);
                    if (value?.then) throw new SurfacePublicationError('async-publication-commit', 'Publication commits must be synchronous');
                    if (value === false) throw new SurfacePublicationError(
                        'rejected-publication-commit',
                        'Publication group commit rejected',
                    );
                } catch (error) {
                    if (switched) for (const row of rows) {
                        if (row.previous) activeByKey.set(row.ticket.key, row.previous);
                        else activeByKey.delete(row.ticket.key);
                    }
                    const rollback = (callback, context) => {
                        try { callback?.({ ...context, error }); }
                        catch (failure) { noteProblem('rollback-failed', context.key, context.generation, failure?.message); }
                    };
                    if (groupCommitEntered) rollback(options.rollback, batchContext);
                    for (let index = rows.length - 1; index >= 0; index--) {
                        const row = rows[index];
                        if (row.commitEntered) rollback(row.lifecycle.rollback, batchContext.entries[index]);
                        if (row.root) {
                            if (row.priorIdentity) row.root.userData.surfacePublication = row.priorIdentity;
                            else delete row.root.userData.surfacePublication;
                        }
                    }
                    counters.failed += 1;
                    noteProblem('batch-publish-failed', null, null, error?.message);
                    discard('failed');
                    throw error;
                }
                const results = [];
                // Settle the entire group before callbacks can begin successors.
                for (const row of rows) {
                    row.ticket.stagedRoot = null;
                    row.ticket.stagedLifecycle = null;
                    resolveTicket(row.ticket, row.clear ? 'cleared' : 'published');
                    if (row.clear) counters.cleared += 1;
                    else counters.published += 1;
                }
                batchState = 'published';
                for (const [index, row] of rows.entries()) {
                    const retirementError = retireRecord(row.previous, {
                        ...batchContext.entries[index], reason: row.clear ? 'cleared' : 'replaced', next: row.active,
                    });
                    const status = row.clear ? 'cleared' : 'published';
                    results.push(Object.freeze({ status: retirementError ? status + '-with-retirement-error' : status,
                        key: row.ticket.key, generation: row.ticket.generation,
                        previousGeneration: row.previous?.generation ?? null }));
                }
                for (const row of rows) notify({ type: row.clear ? 'cleared' : 'published', key: row.ticket.key,
                    generation: row.ticket.generation, root: row.root, previous: row.previous, active: row.active });
                rows.length = 0;
                return Object.freeze({ status: results.some(result => result.status.endsWith('-with-retirement-error'))
                    ? 'published-with-retirement-error' : 'published', results: Object.freeze(results) });
            },
        });
    }

    function retire(keyValue, { root = null, reason = 'retired', dispose = true } = {}) {
        const key = publicationKey(keyValue);
        const record = activeByKey.get(key);
        if (!record || (root && record.root !== root)) return false;
        activeByKey.delete(key);
        if (dispose) retireRecord(record, {
            key,
            generation: record.generation,
            previous: record,
            reason,
            registry: api,
        });
        notify({
            type: 'retired',
            key,
            generation: record.generation,
            root: null,
            previous: record,
            active: null,
            reason,
        });
        return true;
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') {
            throw new TypeError('Surface publication subscriber must be a function');
        }
        if (closed) return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function getActive(keyValue) {
        const key = publicationKey(keyValue);
        return activeByKey.get(key) || null;
    }

    function snapshot() {
        const active = [...activeByKey.values()]
            .map(record => Object.freeze({
                key: record.key,
                generation: record.generation,
                rootName: objectLabel(record.root),
                meshCount: record.inspection.meshCount,
                claimCount: record.inspection.claimCount,
                surfaceClasses: record.inspection.surfaceClasses,
                verticalBands: record.inspection.verticalBands,
                ownerIds: record.inspection.ownerIds,
                publishedAtMs: record.publishedAtMs,
            }))
            .sort((a, b) => a.key.localeCompare(b.key));
        return Object.freeze({
            contract: 'station3d-surface-publications-v1',
            activeCount: active.length,
            pendingCount: pendingTickets.size,
            active: Object.freeze(active),
            counters: Object.freeze({ ...counters }),
            recentProblems: Object.freeze([...recentProblems]),
        });
    }

    function backgroundActivity() {
        return {
            kind: 'layer',
            label: 'surface publications',
            pending: pendingTickets.size,
            activeOwners: activeByKey.size,
            staleRejected: counters.staleRejected,
            conflicts: counters.conflicts,
            missingClaims: counters.missingClaims,
            invalidClaims: counters.invalidClaims,
            failed: counters.failed,
        };
    }

    function close({ retireActive = false } = {}) {
        if (closed) return;
        for (const ticket of pendingTickets.values()) {
            // Rootless entries own prepared query, texture or physics resources
            // too. Their discard lifecycle is registered when the batch stages.
            if (ticket.state === 'staged') {
                discardRoot(ticket, ticket.stagedRoot, 'registry-closed', ticket.stagedLifecycle);
                ticket.stagedRoot = null;
                ticket.stagedLifecycle = null;
            }
            ticket.state = 'registry-closed';
            counters.discarded += 1;
        }
        pendingTickets.clear();
        if (retireActive) {
            for (const record of [...activeByKey.values()]) {
                activeByKey.delete(record.key);
                retireRecord(record, {
                    key: record.key,
                    generation: record.generation,
                    previous: record,
                    reason: 'registry-closed',
                    registry: api,
                });
            }
        } else {
            activeByKey.clear();
        }
        latestRequestedByKey.clear();
        listeners.clear();
        closed = true;
    }

    const api = Object.freeze({
        begin,
        prepareBatch,
        retire,
        getActive,
        subscribe,
        snapshot,
        backgroundActivity,
        close,
    });
    return api;
}
