// Session-owned ordinary-ground material coverage. Roads stage source records;
// their physical dependency group publishes the prepared paint entry with them.
import { createGroundPaintCache } from '../core/ground-paint-cache.js';
import { createGroundCompositePlanSteps } from '../core/ground-composite-plan.js';
import { combineGroundPaintSourcePlansSteps, groundPaintCapacity } from '../core/ground-paint-source-plans.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { bindGroundPaintMaterial } from '../core/ground-paint-material.js';
import { groundPaintReceiverMaterialPolicy } from '../core/ground-paint-receiver-claim.js';
import { EARTH_RADIUS_M } from '../core/math.js';

const REGION_LIMITS = Object.freeze({ records: 2048, vertices: 131072, verticesPerRecord: 8192, oversized: 128 });
const SOURCE_LIMITS = GROUND_GENERATION_LIMITS.paintSources;
const MAX_OWNER_RECORDS = 8;
let sessionSequence = 0;

function validateOwnerRecords(records) {
    if (records === null) return;
    if (!Array.isArray(records) || !records.length) {
        throw new TypeError('Ground paint requires a nonempty immutable owner record array');
    }
    if (records.length > MAX_OWNER_RECORDS) throw groundPaintCapacity('Ground paint owner record capacity exceeded');
    if (!Object.isFrozen(records)
        || records.some(record => !record || typeof record !== 'object' || !Object.isFrozen(record))) {
        throw new TypeError('Ground paint requires a nonempty immutable owner record array');
    }
}

export function createWorldGroundPaint({ renderer, registry, boundary, qualityProfileId = 'high', cacheFactory = createGroundPaintCache }) {
    // Local tangent coordinates remain inside this finite geographical domain
    // for legal longitude/latitude inputs. A material binding, never this box,
    // establishes actual physical receiver coverage.
    const extent = 2 * Math.PI * EARTH_RADIUS_M;
    const receiver = Object.freeze({ key: `ordinary-ground:${++sessionSequence}`, verticalBand: 'ground',
        coverageRevision: 'ordinary-ground-v1',
        bounds: Object.freeze({ minX: -extent, minZ: -extent, maxX: extent, maxZ: extent }) });
    // Four R8 ownership layers: 16 MiB high, 4 MiB medium/low. Repeating
    // materials and their mipmaps have a separate bounded library.
    const size = qualityProfileId === 'high' ? 2048 : 1024;
    const textures = new Map(), recipes = new Map(), desired = new Map(), desiredVersions = new WeakMap();
    const bindings = new WeakMap(), sourceRecordCounts = new WeakMap();
    let published = new Map(), publishedPlan = null, closed = false, generation = 0, sourceTurn = null;
    let restoreGroundMaterial = null;
    const cache = cacheFactory({ renderer, receiver, registry, boundary, size,
        widthsM: [128, 1024, 4096], blockSize: 256, maxTextureBytes: size * size * 4,
        packetLimits: { pixels: size * size, draws: 4096, verticesPerPolygon: 8192,
            geometryBytes: 16 * 1024 * 1024, submissions: 32768 },
        resolveAlbedoMap: (key, revision) => {
            const source = textures.get(key);
            return source?.revision === revision ? source.texture : null;
        } });

    function bindMaterial(material, claim) {
        const policy = groundPaintReceiverMaterialPolicy(receiver, claim);
        if (closed || !material?.isMeshStandardMaterial || bindings.has(material)
            || !policy) return null;
        const handle = bindGroundPaintMaterial(material, { state: cache.materialState, ...policy });
        bindings.set(material, handle);
        return handle;
    }
    function registerStyle(key, recipe, texture = null) {
        if (closed) throw new Error('Ground paint session is closed');
        if (recipes.has(key)) return;
        if (recipe.albedoMap) {
            if (!texture?.isTexture) throw new TypeError('Ground paint recipe requires its source texture');
            textures.set(recipe.albedoMap.key, { texture, revision: recipe.albedoMap.revision });
        }
        recipes.set(key, Object.freeze(recipe));
    }
    function stage(bucketKey, owner, recordsOrNull) {
        if (closed) throw new Error('Ground paint session is closed');
        validateOwnerRecords(recordsOrNull);
        let records = desired.get(bucketKey);
        const next = recordsOrNull;
        if (records?.get(owner) === next || (!next && !records?.has(owner))) return;
        const count = (sourceRecordCounts.get(records) || 0) - (records?.get(owner)?.length || 0) + (next?.length || 0);
        if (count > REGION_LIMITS.records) throw groundPaintCapacity('Ground paint region record capacity exceeded');
        if (!records) desired.set(bucketKey, records = new Map());
        if (next) records.set(owner, next); else records.delete(owner);
        sourceRecordCounts.set(records, count);
        desiredVersions.set(records, (desiredVersions.get(records) || 0) + 1);
    }

    function captureDesired(keys) {
        if (keys.length > SOURCE_LIMITS.maxChangedRegions) throw groundPaintCapacity('Ground paint changed region capacity exceeded');
        return new Map(keys.map(key => {
            const records = desired.get(key);
            return [key, { records, version: records ? desiredVersions.get(records) || 0 : 0 }];
        }));
    }
    const desiredCurrent = captured => [...captured].every(([key, row]) => desired.get(key) === row.records
        && (!row.records || (desiredVersions.get(row.records) || 0) === row.version));

    function* copyRecordsSteps(records, current) {
        const copy = new Map();
        let count = 0;
        for (const [owner, ownerRecords] of records || []) {
            if (!current()) return null;
            count += ownerRecords.length;
            if (count > REGION_LIMITS.records) throw groundPaintCapacity('Ground paint region record capacity exceeded');
            copy.set(owner, ownerRecords);
            yield { phase: 'paint-source-owners' };
        }
        sourceRecordCounts.set(copy, count);
        return copy;
    }

    // Both ordinary bucket delivery and a complete ground candidate use this
    // compiler. Candidate owner maps remain private until their geometry group
    // commits; cancellation cannot leave speculative paint in a later bucket.
    function* prepareRecordsSteps(recordsByBucket, captured, isCurrent, replaceDesired) {
        // Roads and decor share one bounded staging texture. Wait before
        // capturing published state, so a successor includes the preceding
        // producer's commit instead of replacing it with an older source map.
        while (sourceTurn) {
            if (closed || !desiredCurrent(captured) || !isCurrent()) return null;
            yield { phase: 'paint-source-owner-slot', deferFrame: true, waitingForDependency: true };
        }
        if (closed || !desiredCurrent(captured) || !isCurrent()) return null;
        const turn = {}; sourceTurn = turn;
        const releaseTurn = () => { if (sourceTurn === turn) sourceTurn = null; };
        const before = published, beforePlan = publishedPlan, next = new Map(before);
        const localCurrent = () => !closed && published === before && desiredCurrent(captured);
        const current = () => localCurrent() && isCurrent();
        let paint = null, metadataTicket = null, handedOff = false, committed = false, settled = false;
        const discard = () => {
            if (settled || committed) return false;
            settled = true;
            if (metadataTicket?.state === 'pending') metadataTicket.discard();
            paint?.discard();
            releaseTurn();
            return true;
        };
        try {
            if (!current()) return null;
            for (const [key, source] of recordsByBucket) {
                const records = [];
                for (const ownerRecords of source.values()) {
                    for (const record of ownerRecords) {
                        if (!current()) return null;
                        if (records.length >= REGION_LIMITS.records) throw groundPaintCapacity('Ground paint region record capacity exceeded');
                        records.push(record);
                        yield { phase: 'paint-source-records' };
                    }
                }
                if (records.length) next.set(key, yield* createGroundCompositePlanSteps({ receiver, records, limits: REGION_LIMITS }));
                else next.delete(key);
                if (!current()) return null;
            }
            const plan = yield* combineGroundPaintSourcePlansSteps({ receiver, plans: next });
            if (!current()) return null;
            paint = yield* cache.prepareSourceSteps({ plan, styles: recipes,
                isCurrent: current });
            if (!current()) return null;
            // A source can move between regional buckets without changing a
            // pixel. Publish that ownership move even when the cache is a no-op.
            metadataTicket = paint ? null : registry.begin({ key: `ground-paint:${receiver.key}:regions`, generation: ++generation });
            const entry = { ...(paint?.entry || { ticket: metadataTicket, clear: true }),
                isCurrent: () => !settled && !committed && current() && (!paint || paint.entry.isCurrent()),
                commit() {
                    if (settled || committed || !localCurrent()) return false;
                    if (paint && !paint.entry.commit()) return false;
                    if (replaceDesired) for (const [key, records] of recordsByBucket) desired.set(key, records);
                    published = next; publishedPlan = plan; committed = true; return true;
                },
                rollback() {
                    if (!committed || settled) return false;
                    if (replaceDesired) for (const [key, row] of captured) {
                        if (row.records) desired.set(key, row.records); else desired.delete(key);
                    }
                    published = before; publishedPlan = beforePlan; committed = false;
                    paint?.entry.rollback();
                    return true;
                },
                discard,
            };
            handedOff = true;
            return { entry, finalize() {
                if (settled || !committed) return false;
                settled = true;
                for (const key of recordsByBucket.keys()) if (desired.get(key)?.size === 0) desired.delete(key);
                try { return paint?.finalize() ?? true; } finally { releaseTurn(); }
            }, discard };
        } finally { if (!handedOff) discard(); }
    }

    function* prepareBucketsSteps(bucketKeys, isCurrent) {
        const changed = [...new Set(bucketKeys)].filter(key => desired.has(key) || published.has(key));
        if (!changed.length) return null;
        const captured = captureDesired(changed), records = new Map();
        const current = () => !closed && desiredCurrent(captured) && isCurrent();
        for (const [key, row] of captured) {
            const copy = yield* copyRecordsSteps(row.records, current);
            if (!copy || !current()) return null;
            records.set(key, copy);
        }
        return yield* prepareRecordsSteps(records, captured, isCurrent, false);
    }

    function* prepareReplacementsSteps(replacements, isCurrent) {
        if (!Array.isArray(replacements) || !Object.isFrozen(replacements)
            || typeof isCurrent !== 'function') throw new TypeError('Ground paint requires captured owner replacements');
        if (replacements.length > SOURCE_LIMITS.maxReplacements) throw groundPaintCapacity('Ground paint replacement capacity exceeded');
        const rows = new Map();
        for (const [index, row] of replacements.entries()) {
            if (index % 64 === 0) {
                if (closed || !isCurrent()) return null;
                if (index) yield { phase: 'paint-source-admission' };
            }
            if (!row || !Object.isFrozen(row) || typeof row.bucketKey !== 'string' || !row.bucketKey || row.owner == null) {
                throw new TypeError('Ground paint requires immutable replacement records');
            }
            validateOwnerRecords(row.records);
            if (!rows.has(row.bucketKey)) rows.set(row.bucketKey, new Map());
            if (rows.size > SOURCE_LIMITS.maxChangedRegions) throw groundPaintCapacity('Ground paint changed region capacity exceeded');
            const owners = rows.get(row.bucketKey);
            if (owners.has(row.owner)) throw new TypeError('Duplicate ground paint replacement owner');
            owners.set(row.owner, row.records);
        }
        if (!rows.size) return null;
        const captured = captureDesired([...rows.keys()]), records = new Map();
        const current = () => !closed && desiredCurrent(captured) && isCurrent();
        for (const [key, changes] of rows) {
            const copy = yield* copyRecordsSteps(captured.get(key).records, current);
            if (!copy || !current()) return null;
            let count = sourceRecordCounts.get(copy) || 0;
            for (const [owner, ownerRecords] of changes) {
                count += (ownerRecords?.length || 0) - (copy.get(owner)?.length || 0);
                yield { phase: 'paint-source-capacity' };
                if (!current()) return null;
            }
            // Admit the complete replacement, including removals, independent
            // of row order. Nothing becomes visible until the batch commits.
            if (count > REGION_LIMITS.records) throw groundPaintCapacity('Ground paint region record capacity exceeded');
            for (const [owner, ownerRecords] of changes) {
                if (ownerRecords) copy.set(owner, ownerRecords); else copy.delete(owner);
                yield { phase: 'paint-source-replacements' };
                if (!current()) return null;
            }
            sourceRecordCounts.set(copy, count);
            records.set(key, copy);
        }
        return yield* prepareRecordsSteps(records, captured, isCurrent, true);
    }
    return Object.freeze({ receiver, bindMaterial, registerStyle, stage, prepareBucketsSteps, prepareReplacementsSteps,
        attachGroundMesh(mesh) {
            if (!mesh || restoreGroundMaterial) throw new Error('Ground paint requires one session ground mesh');
            const previous = mesh.material, material = previous.clone();
            // Material.clone does not copy custom shader callbacks. Preserve
            // the base world hooks and keep this session's paint binding local.
            material.onBeforeCompile = previous.onBeforeCompile;
            material.customProgramCacheKey = previous.customProgramCacheKey;
            material.onBeforeRender = previous.onBeforeRender;
            bindMaterial(material, previous.userData.surfaceClaim);
            mesh.material = material;
            restoreGroundMaterial = () => { if (mesh.material === material) mesh.material = previous; material.dispose(); };
        },
        bindRoot(root) { root?.traverse?.(object => {
            if (!object.isMesh) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) bindMaterial(material,
                object.userData?.surfaceClaim || material?.userData?.surfaceClaim);
        }); },
        onFrame: (x, z) => cache.onFrame(x, z),
        paintAt: (x, z) => cache.paintAt(x, z, receiver),
        sourceAt: (x, z) => publishedPlan?.paintAt(x, z, receiver) || null,
        snapshot: () => ({ ...cache.snapshot(), receiver, sourceRegions: published.size,
            sourceRecords: [...published.values()].reduce((sum, plan) => sum + plan.commands.length, 0) }),
        dispose() {
            if (closed) return;
            closed = true; cache.dispose(); desired.clear(); published.clear(); recipes.clear(); textures.clear();
            sourceTurn = null;
            publishedPlan = null;
            restoreGroundMaterial?.(); restoreGroundMaterial = null;
        },
    });
}
