// Deterministic semantic composition for terrain and civil earthworks. Named
// authorities accumulate in design order, independent of renderer or stream order.

import { finiteOrNull } from './math.js';
import {
    CIVIL_GROUND_AUTHORITY,
    CIVIL_GROUND_AUTHORITY_ORDER,
} from './surface-hierarchy.js';

export {
    CIVIL_GROUND_AUTHORITY,
    CIVIL_GROUND_AUTHORITY_ORDER,
} from './surface-hierarchy.js';

const AUTHORITY_INDEX = new Map(
    CIVIL_GROUND_AUTHORITY_ORDER.map((authority, index) => [authority, index]),
);

function requireAuthority(authority) {
    const normalized = String(authority || '');
    const index = AUTHORITY_INDEX.get(normalized);
    if (index == null) throw new Error(`Unknown civil-ground authority: ${normalized || '(empty)'}`);
    return { authority: normalized, index };
}

function validBounds(bounds) {
    return !!bounds
        && [bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ].every(Number.isFinite)
        && bounds.minX <= bounds.maxX
        && bounds.minZ <= bounds.maxZ;
}

function cloneBounds(bounds) {
    return {
        minX: bounds.minX,
        minZ: bounds.minZ,
        maxX: bounds.maxX,
        maxZ: bounds.maxZ,
    };
}

export function civilGroundAuthoritiesBefore(authority) {
    const { index } = requireAuthority(authority);
    return CIVIL_GROUND_AUTHORITY_ORDER.slice(0, index);
}

// Multiset diff for bounded civil-ground dependencies. Geometry tokens, not
// model identity or stream revisions, decide whether a downstream owner must
// rebuild. Every dependency must provide bounds so a change can stay spatial.
export function changedCivilGroundDependencyBounds(
    previousEntries = [],
    nextEntries = [],
) {
    const steps = changedCivilGroundDependencyBoundsSteps(previousEntries, nextEntries, {
        now: () => 0, maxEntries: Number.MAX_SAFE_INTEGER, maxBounds: Number.MAX_SAFE_INTEGER,
    });
    for (;;) { const next = steps.next(); if (next.done) return next.value; }
}

export function* changedCivilGroundDependencyBoundsSteps(previousEntries = [], nextEntries = [], {
    maxEntries, maxBounds, now = () => performance.now(), isCurrent = () => true,
} = {}) {
    if (![previousEntries, nextEntries].every(Array.isArray)
        || ![maxEntries, maxBounds].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('Civil-ground diff requires bounded dependency tables');
    }
    const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
    if (previousEntries.length + nextEntries.length > maxEntries) {
        fail('ground-dependency-capacity', 'Civil-ground diff exceeds dependency capacity');
    }
    let deadline = now() + .5;
    function* budget() {
        if (!isCurrent()) fail('ground-dependency-stale', 'Civil-ground dependencies changed during preparation');
        if (now() >= deadline) { yield { phase: 'ground-civil-closure' }; deadline = now() + .5; }
    }
    function* counts(entries) {
        const result = new Map();
        for (const entry of entries) {
            yield* budget();
            const signature = String(entry?.signature || '');
            result.set(signature, (result.get(signature) || 0) + 1);
        }
        return result;
    }
    const previousCounts = yield* counts(previousEntries);
    const nextCounts = yield* counts(nextEntries);
    const previousNeeded = new Map();
    const nextNeeded = new Map();
    for (const [signature, count] of previousCounts) {
        yield* budget();
        previousNeeded.set(signature, Math.max(0, count - (nextCounts.get(signature) || 0)));
    }
    for (const [signature, count] of nextCounts) {
        yield* budget();
        nextNeeded.set(signature, Math.max(0, count - (previousCounts.get(signature) || 0)));
    }
    const changed = [];
    function* takeNeeded(entry, needed) {
        yield* budget();
        const signature = String(entry?.signature || '');
        const remaining = needed.get(signature) || 0;
        if (remaining <= 0) return;
        const bounds = Array.isArray(entry?.changeBounds)
            ? entry.changeBounds
            : [entry?.bounds];
        if (bounds.length === 0) {
            throw new Error(`Civil-ground dependency '${signature}' has no bounded change region`);
        }
        for (const candidate of bounds) {
            yield* budget();
            if (!validBounds(candidate)) throw new Error(`Civil-ground dependency '${signature}' has no bounded change region`);
            if (changed.length >= maxBounds) fail('ground-dependency-capacity', 'Civil-ground diff exceeds changed-bound capacity');
            changed.push(cloneBounds(candidate));
        }
        needed.set(signature, remaining - 1);
    }
    for (const entry of previousEntries) yield* takeNeeded(entry, previousNeeded);
    for (const entry of nextEntries) yield* takeNeeded(entry, nextNeeded);
    if (!isCurrent()) fail('ground-dependency-stale', 'Civil-ground dependencies changed during preparation');
    return changed;
}

export class CivilGroundComposition {
    constructor({ terrainSceneYAtLocal, terrainEvidenceSceneYAtLocal } = {}) {
        this.terrainSceneYAtLocal = typeof terrainSceneYAtLocal === 'function'
            ? terrainSceneYAtLocal
            : (() => null);
        // Deliberately no fallback to the visual sampler. The visible terrain
        // is total so it can beat void; civil solvers need a nullable statement
        // that the height was actually observed.
        this.terrainEvidenceSceneYAtLocal = typeof terrainEvidenceSceneYAtLocal === 'function'
            ? terrainEvidenceSceneYAtLocal
            : (() => null);
        // Terrain remains the first semantic authority, but a published
        // vector-bounded replacement (for example the OSM/DGU coast
        // transition) may supersede the raw datum inside its own footprint.
        // Keeping that replacement in the terrain stage makes every later
        // civil solver consume the same ground that is actually rendered.
        this._terrainReplacement = null;
        this._providers = new Map();
        this.registrationRevision = 0;
        // Composition is a pure function of the provider snapshots, and roads ask
        // for it once per frame. Providers hand back the SAME snapshot object
        // while nothing has rebuilt, so identical inputs let us reuse the last
        // composed result instead of re-cloning every bounds and re-sorting the
        // signature on every frame. Keyed per authority: each asks about a
        // different prefix of the order.
        this._snapshotCache = new Map();   // authorityId → { inputs, result }
    }

    // Samplers belong to one immutable published generation. Publish changes
    // by registering new samplers; captured readers can outlive registration.
    setTerrainReplacement({
        id,
        sampleSceneYAtLocal,
        sampleEvidenceSceneYAtLocal = null,
        dependencySnapshot = null,
    } = {}) {
        const providerId = String(id || '').trim();
        if (!providerId) throw new Error('Terrain replacement requires an owner id');
        if (typeof sampleSceneYAtLocal !== 'function') {
            throw new Error(`Terrain replacement '${providerId}' requires sampleSceneYAtLocal`);
        }
        if (sampleEvidenceSceneYAtLocal != null
            && typeof sampleEvidenceSceneYAtLocal !== 'function') {
            throw new Error(`Terrain replacement '${providerId}' has an invalid evidence sampler`);
        }
        if (dependencySnapshot != null && typeof dependencySnapshot !== 'function') {
            throw new Error(`Terrain replacement '${providerId}' has an invalid dependency snapshot`);
        }
        const previous = this._terrainReplacement;
        if (previous && previous.id !== providerId) {
            throw new Error(`Terrain replacement is already owned by '${previous.id}'`);
        }
        const registration = Symbol(providerId);
        this._terrainReplacement = {
            id: providerId,
            sampleSceneYAtLocal,
            sampleEvidenceSceneYAtLocal,
            dependencySnapshot,
            registration,
        };
        this._snapshotCache.clear();
        this.registrationRevision += 1;
        return () => {
            if (this._terrainReplacement?.registration !== registration) return false;
            this._terrainReplacement = null;
            this._snapshotCache.clear();
            this.registrationRevision += 1;
            return true;
        };
    }

    prepareTerrainReplacementPublication(replacement) {
        if (replacement !== null && (typeof replacement !== 'object' || !Object.isFrozen(replacement))) throw new TypeError('Prepared terrain replacement requires an immutable read');
        const prepared = new CivilGroundComposition();
        if (replacement) prepared.setTerrainReplacement(replacement);
        const previous = this._terrainReplacement, next = prepared._terrainReplacement;
        if (previous && next && previous.id !== next.id) throw new Error('Terrain replacement owner mismatch');
        const revision = this.registrationRevision;
        let committed = false;
        return Object.freeze({
            isCurrent: () => this._terrainReplacement === previous && this.registrationRevision === revision,
            commit: () => {
                if (this._terrainReplacement !== previous || this.registrationRevision !== revision) return false;
                this._terrainReplacement = next; this.registrationRevision++; this._snapshotCache.clear();
                committed = true; return true;
            },
            rollback: () => {
                if (!committed) return;
                this._terrainReplacement = previous; this.registrationRevision = revision; this._snapshotCache.clear();
                committed = false;
            },
            release: () => {
                if (!committed || this._terrainReplacement !== next) return false;
                this._terrainReplacement = null; this.registrationRevision++; this._snapshotCache.clear();
                committed = false;
                return true;
            },
        });
    }

    captureTerrainReplacementReadSnapshot() {
        const replacement = this._terrainReplacement;
        if (!replacement) return null;
        // Retain only the generation's query callbacks, not the live slot or
        // its dependency bookkeeping. Coast samplers own compiled triangles.
        return Object.freeze({
            id: replacement.id,
            sampleSceneYAtLocal: replacement.sampleSceneYAtLocal,
            sampleEvidenceSceneYAtLocal: replacement.sampleEvidenceSceneYAtLocal,
        });
    }

    _terrainValueAtLocal(x, z, { evidence = false } = {}) {
        const source = finiteOrNull((evidence
            ? this.terrainEvidenceSceneYAtLocal
            : this.terrainSceneYAtLocal)(x, z));
        const replacement = this._terrainReplacement;
        const sampler = evidence
            ? replacement?.sampleEvidenceSceneYAtLocal
            : replacement?.sampleSceneYAtLocal;
        if (typeof sampler !== 'function') return source;
        const candidate = finiteOrNull(sampler(x, z, {
            authority: CIVIL_GROUND_AUTHORITY.TERRAIN,
            inputSceneY: source,
        }));
        return candidate == null ? source : candidate;
    }

    // A later civil solver sometimes needs to distinguish the raw terrain
    // datum from an opaque, vector-bounded terrain replacement. In particular,
    // a road fill meeting the mapped coast can end its earth face directly on
    // that replacement instead of drawing a second terrain collar across it.
    // This is an ownership query only: it deliberately does not fall back to
    // the raw terrain when the replacement sampler declines the point.
    terrainReplacementOwnsAtLocal(x, z) {
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        const replacement = this._terrainReplacement;
        if (localX == null || localZ == null
            || typeof replacement?.sampleSceneYAtLocal !== 'function') return false;
        const source = finiteOrNull(this.terrainSceneYAtLocal(localX, localZ));
        return finiteOrNull(replacement.sampleSceneYAtLocal(localX, localZ, {
            authority: CIVIL_GROUND_AUTHORITY.TERRAIN,
            inputSceneY: source,
        })) != null;
    }

    // One subsystem owns each semantic stage. Re-registering that same owner
    // replaces its closures safely; a competing owner is an architecture error.
    setGroundAuthority(authority, {
        id,
        sampleSceneYAtLocal,
        sampleEvidenceSceneYAtLocal = null,
        dependencySnapshot = null,
    } = {}) {
        const resolved = requireAuthority(authority);
        if (resolved.authority === CIVIL_GROUND_AUTHORITY.TERRAIN) {
            throw new Error('Terrain is the immutable civil-ground baseline');
        }
        const providerId = String(id || '').trim();
        if (!providerId) throw new Error(`Civil-ground authority '${authority}' requires an owner id`);
        if (typeof sampleSceneYAtLocal !== 'function') {
            throw new Error(`Civil-ground owner '${providerId}' requires sampleSceneYAtLocal`);
        }
        if (sampleEvidenceSceneYAtLocal != null
            && typeof sampleEvidenceSceneYAtLocal !== 'function') {
            throw new Error(`Civil-ground owner '${providerId}' has an invalid evidence sampler`);
        }
        if (dependencySnapshot != null && typeof dependencySnapshot !== 'function') {
            throw new Error(`Civil-ground owner '${providerId}' has an invalid dependency snapshot`);
        }
        const previous = this._providers.get(resolved.authority);
        if (previous && previous.id !== providerId) {
            throw new Error(
                `Civil-ground authority '${resolved.authority}' is already owned by '${previous.id}'`,
            );
        }
        const registration = Symbol(providerId);
        this._providers.set(resolved.authority, {
            id: providerId,
            sampleSceneYAtLocal,
            sampleEvidenceSceneYAtLocal,
            dependencySnapshot,
            registration,
        });
        this.registrationRevision += 1;
        return () => {
            if (this._providers.get(resolved.authority)?.registration !== registration) return false;
            this._providers.delete(resolved.authority);
            this.registrationRevision += 1;
            return true;
        };
    }

    resolveAtLocal(x, z, {
        throughAuthority = CIVIL_GROUND_AUTHORITY.BUILDING,
    } = {}) {
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        const target = requireAuthority(throughAuthority);
        if (localX == null || localZ == null) {
            return {
                sceneY: null,
                ownerAuthority: null,
                ownerId: null,
                stages: [],
            };
        }
        const sourceTerrainY = finiteOrNull(this.terrainSceneYAtLocal(localX, localZ));
        const replacementTerrainY = finiteOrNull(
            this._terrainReplacement?.sampleSceneYAtLocal?.(localX, localZ, {
                authority: CIVIL_GROUND_AUTHORITY.TERRAIN,
                inputSceneY: sourceTerrainY,
            }),
        );
        let sceneY = replacementTerrainY == null ? sourceTerrainY : replacementTerrainY;
        let ownerAuthority = sceneY == null ? null : CIVIL_GROUND_AUTHORITY.TERRAIN;
        let ownerId = sceneY == null
            ? null
            : replacementTerrainY == null
                ? 'terrain-datum'
                : this._terrainReplacement.id;
        const stages = [{
            authority: CIVIL_GROUND_AUTHORITY.TERRAIN,
            ownerId,
            registered: true,
            claimed: sceneY != null,
            inputSceneY: null,
            sceneY,
        }];
        for (let index = 1; index <= target.index; index += 1) {
            const authority = CIVIL_GROUND_AUTHORITY_ORDER[index];
            const provider = this._providers.get(authority);
            if (!provider) {
                stages.push({
                    authority,
                    ownerId: null,
                    registered: false,
                    claimed: false,
                    inputSceneY: sceneY,
                    sceneY,
                });
                continue;
            }
            const inputSceneY = sceneY;
            const candidate = finiteOrNull(provider.sampleSceneYAtLocal(localX, localZ, {
                authority,
                inputSceneY,
            }));
            const claimed = candidate != null;
            if (claimed) {
                sceneY = candidate;
                ownerAuthority = authority;
                ownerId = provider.id;
            }
            stages.push({
                authority,
                ownerId: provider.id,
                registered: true,
                claimed,
                inputSceneY,
                sceneY,
            });
        }
        return { sceneY, ownerAuthority, ownerId, stages };
    }

    // Hot geometry path: no diagnostic stage array/object allocation. A road
    // profile can call this for every sampled vertex; resolveAtLocal is the
    // deliberately richer, click-time inspector path.
    _sceneYThroughIndex(x, z, targetIndex) {
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        if (localX == null || localZ == null) return null;
        let sceneY = this._terrainValueAtLocal(localX, localZ);
        for (let index = 1; index <= targetIndex; index += 1) {
            const authority = CIVIL_GROUND_AUTHORITY_ORDER[index];
            const provider = this._providers.get(authority);
            if (!provider) continue;
            const candidate = finiteOrNull(provider.sampleSceneYAtLocal(localX, localZ, {
                authority,
                inputSceneY: sceneY,
            }));
            if (candidate != null) sceneY = candidate;
        }
        return sceneY;
    }

    _evidenceSceneYThroughIndex(x, z, targetIndex) {
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        if (localX == null || localZ == null) return null;
        let sceneY = this._terrainValueAtLocal(localX, localZ, { evidence: true });
        for (let index = 1; index <= targetIndex; index += 1) {
            const authority = CIVIL_GROUND_AUTHORITY_ORDER[index];
            const provider = this._providers.get(authority);
            // A civil owner participates in the evidence stack only when it
            // explicitly says its published result is evidence-backed.
            if (typeof provider?.sampleEvidenceSceneYAtLocal !== 'function') continue;
            const candidate = finiteOrNull(provider.sampleEvidenceSceneYAtLocal(
                localX,
                localZ,
                { authority, inputSceneY: sceneY },
            ));
            if (candidate != null) sceneY = candidate;
        }
        return sceneY;
    }

    sceneYAtLocal(x, z, {
        throughAuthority = CIVIL_GROUND_AUTHORITY.BUILDING,
    } = {}) {
        return this._sceneYThroughIndex(x, z, requireAuthority(throughAuthority).index);
    }

    evidenceSceneYAtLocal(x, z, {
        throughAuthority = CIVIL_GROUND_AUTHORITY.BUILDING,
    } = {}) {
        return this._evidenceSceneYThroughIndex(
            x,
            z,
            requireAuthority(throughAuthority).index,
        );
    }

    // The owner receives the accumulated output of every authority before it,
    // never its own result or that of a later surface.
    inputSceneYAtLocal(authority, x, z) {
        const resolved = requireAuthority(authority);
        if (resolved.index === 0) return null;
        return this._sceneYThroughIndex(x, z, resolved.index - 1);
    }

    inputEvidenceSceneYAtLocal(authority, x, z) {
        const resolved = requireAuthority(authority);
        if (resolved.index === 0) return null;
        return this._evidenceSceneYThroughIndex(x, z, resolved.index - 1);
    }

    // Ownership twin of inputSceneYAtLocal. Geometry builders use this hot
    // path when the numeric height alone is ambiguous: a road may replace bare
    // terrain, but the same height supplied by an earlier rail earthwork still
    // belongs to rail. Keep this free of diagnostic trace allocations instead
    // of routing high-rate sampling through resolveAtLocal.
    inputOwnerAuthorityAtLocal(authority, x, z) {
        const resolved = requireAuthority(authority);
        if (resolved.index === 0) return null;
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        if (localX == null || localZ == null) return null;
        let sceneY = this._terrainValueAtLocal(localX, localZ);
        let ownerAuthority = sceneY == null ? null : CIVIL_GROUND_AUTHORITY.TERRAIN;
        for (let index = 1; index < resolved.index; index += 1) {
            const authorityId = CIVIL_GROUND_AUTHORITY_ORDER[index];
            const provider = this._providers.get(authorityId);
            if (!provider) continue;
            const candidate = finiteOrNull(provider.sampleSceneYAtLocal(localX, localZ, {
                authority: authorityId,
                inputSceneY: sceneY,
            }));
            if (candidate == null) continue;
            sceneY = candidate;
            ownerAuthority = authorityId;
        }
        return ownerAuthority;
    }

    // Returns the accumulated input height only when its final semantic owner
    // matches `ownerAuthority`. This avoids asking the same upstream providers
    // twice when geometry needs both provenance and height (road terrain-mask
    // sampling is the main caller).
    inputSceneYOwnedByAtLocal(authority, ownerAuthority, x, z) {
        const resolved = requireAuthority(authority);
        const requiredOwner = requireAuthority(ownerAuthority).authority;
        if (resolved.index === 0) return null;
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        if (localX == null || localZ == null) return null;
        let sceneY = this._terrainValueAtLocal(localX, localZ);
        let owner = sceneY == null ? null : CIVIL_GROUND_AUTHORITY.TERRAIN;
        for (let index = 1; index < resolved.index; index += 1) {
            const authorityId = CIVIL_GROUND_AUTHORITY_ORDER[index];
            const provider = this._providers.get(authorityId);
            if (!provider) continue;
            const candidate = finiteOrNull(provider.sampleSceneYAtLocal(localX, localZ, {
                authority: authorityId,
                inputSceneY: sceneY,
            }));
            if (candidate == null) continue;
            sceneY = candidate;
            owner = authorityId;
        }
        return owner === requiredOwner ? sceneY : null;
    }

    dependencySnapshotBefore(authority) {
        const resolved = requireAuthority(authority);
        // Collect the inputs first so an unchanged frame can reuse the last
        // composed result. `inputs` interleaves provider and snapshot identity,
        // so swapping an owner or dropping one is a miss even if some other
        // provider's snapshot object happens to be unchanged.
        const inputs = [];
        const snapshots = [];
        const terrainReplacement = this._terrainReplacement;
        if (resolved.index > 0 && terrainReplacement?.dependencySnapshot) {
            const snapshot = terrainReplacement.dependencySnapshot() || {};
            inputs.push(CIVIL_GROUND_AUTHORITY.TERRAIN, terrainReplacement, snapshot);
            snapshots.push({
                authorityId: CIVIL_GROUND_AUTHORITY.TERRAIN,
                provider: terrainReplacement,
                snapshot,
            });
        }
        for (let index = 1; index < resolved.index; index += 1) {
            const authorityId = CIVIL_GROUND_AUTHORITY_ORDER[index];
            const provider = this._providers.get(authorityId);
            if (!provider?.dependencySnapshot) continue;
            const snapshot = provider.dependencySnapshot() || {};
            inputs.push(authorityId, provider, snapshot);
            snapshots.push({ authorityId, provider, snapshot });
        }
        const cached = this._snapshotCache.get(resolved.authority);
        if (cached && cached.inputs.length === inputs.length
            && cached.inputs.every((value, index) => value === inputs[index])) {
            return cached.result;
        }
        const result = this._composeDependencySnapshot(snapshots);
        // Only a successful composition is cached: a provider that published an
        // unbounded dependency throws above, and must throw again next frame.
        this._snapshotCache.set(resolved.authority, { inputs, result });
        return result;
    }

    captureReadSnapshot(options) {
        return captureReadSnapshot.call(this, options);
    }

    hasGroundAuthority(authority) {
        const resolved = requireAuthority(authority);
        return resolved.index === 0 || this._providers.has(resolved.authority);
    }

    _composeDependencySnapshot(snapshots) {
        const entries = [];
        for (const { authorityId, provider, snapshot } of snapshots) {
            for (const entry of snapshot.entries || []) {
                if (!validBounds(entry?.bounds)) {
                    throw new Error(
                        `Civil-ground owner '${provider.id}' published an unbounded dependency`,
                    );
                }
                const signature = [
                    authorityId,
                    provider.id,
                    String(entry.signature || ''),
                ].join(':');
                const changeBounds = Array.isArray(entry.changeBounds)
                    ? entry.changeBounds.map((bounds) => {
                        if (!validBounds(bounds)) {
                            throw new Error(
                                `Civil-ground owner '${provider.id}' published an invalid change region`,
                            );
                        }
                        return cloneBounds(bounds);
                    })
                    : undefined;
                entries.push({
                    signature,
                    bounds: cloneBounds(entry.bounds),
                    ...(changeBounds ? { changeBounds } : {}),
                });
            }
        }
        return {
            entries,
            bounds: entries.map(entry => cloneBounds(entry.bounds)),
            signature: entries.map(entry => entry.signature).sort().join(','),
        };
    }
}

// Freeze the semantic inputs for an off-scene candidate. The callbacks are
// supplied explicitly by the caller; this method never reaches the live
// composition's terrain/provider closures while constructing the snapshot.
function captureReadSnapshot({
    beforeAuthority,
    terrainSceneYAtLocal,
    terrainEvidenceSceneYAtLocal,
    terrainReplacement = null,
    preparedTerrainReplacement = undefined,
    providers = new Map(),
} = {}) {
    const target = requireAuthority(beforeAuthority);
    if (target.index === 0) throw new TypeError('A civil snapshot must include terrain before its consumer');
    if (typeof terrainSceneYAtLocal !== 'function' || typeof terrainEvidenceSceneYAtLocal !== 'function') {
        throw new TypeError('Civil-ground snapshot requires explicit terrain samplers');
    }
    if (!(providers instanceof Map)) throw new TypeError('Civil-ground snapshot providers must be a Map');
    const expected = CIVIL_GROUND_AUTHORITY_ORDER.slice(1, target.index)
        .filter(authority => this._providers.has(authority));
    const copyProvider = (live, captured, name) => {
        if (!captured || captured.id !== live.id
            || typeof captured.sampleSceneYAtLocal !== 'function'
            || (typeof live.sampleEvidenceSceneYAtLocal === 'function')
                !== (typeof captured.sampleEvidenceSceneYAtLocal === 'function')) {
            throw new Error(`Civil-ground snapshot missing or mismatched provider ${name}`);
        }
        return { id: live.id, sampleSceneYAtLocal: captured.sampleSceneYAtLocal,
            sampleEvidenceSceneYAtLocal: captured.sampleEvidenceSceneYAtLocal || null };
    };
    for (const authority of providers.keys()) if (!expected.includes(authority)) {
        throw new Error(`Civil-ground snapshot has extra provider ${authority}`);
    }
    const liveReplacement = this._terrainReplacement;
    const prepared = preparedTerrainReplacement !== undefined;
    const replacement = prepared ? preparedTerrainReplacement : terrainReplacement;
    if (prepared && replacement !== null && (typeof replacement !== 'object' || !Object.isFrozen(replacement))) {
        throw new TypeError('Prepared terrain replacement requires an immutable read');
    }
    if (!prepared && !!liveReplacement !== !!replacement) {
        throw new Error('Civil-ground snapshot terrain replacement mismatch');
    }
    if (liveReplacement && replacement && liveReplacement.id !== replacement.id) {
        throw new Error('Civil-ground snapshot terrain replacement owner mismatch');
    }
    const snapshot = new CivilGroundComposition({ terrainSceneYAtLocal, terrainEvidenceSceneYAtLocal });
    if (replacement) snapshot.setTerrainReplacement(copyProvider(prepared ? replacement : liveReplacement, replacement, 'terrain replacement'));
    for (const authority of expected) {
        snapshot.setGroundAuthority(authority, copyProvider(this._providers.get(authority), providers.get(authority), authority));
    }
    const facade = { contract: 'station3d-civil-ground-read-snapshot-v1', beforeAuthority: target.authority };
    const through = options => {
        const authority = options?.throughAuthority ?? CIVIL_GROUND_AUTHORITY_ORDER[target.index - 1];
        if (requireAuthority(authority).index >= target.index) {
            throw new RangeError('Civil-ground query exceeds its captured authority prefix');
        }
        return { ...options, throughAuthority: authority };
    };
    for (const name of ['resolveAtLocal', 'sceneYAtLocal', 'evidenceSceneYAtLocal']) {
        facade[name] = (x, z, options) => snapshot[name](x, z, through(options));
    }
    for (const name of ['inputSceneYAtLocal', 'inputEvidenceSceneYAtLocal',
        'inputOwnerAuthorityAtLocal', 'inputSceneYOwnedByAtLocal']) {
        facade[name] = (authority, ...args) => {
            if (requireAuthority(authority).index > target.index) {
                throw new RangeError('Civil-ground input query exceeds its captured authority prefix');
            }
            return snapshot[name](authority, ...args);
        };
    }
    facade.terrainReplacementOwnsAtLocal = (x, z) => snapshot.terrainReplacementOwnsAtLocal(x, z);
    return Object.freeze(facade);
}
