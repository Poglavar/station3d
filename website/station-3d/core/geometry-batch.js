// Owner-keyed geometry batching: many small static meshes that share a material
// become ONE merged mesh per bucket, rebuilt from cached parts when owners come
// and go.
//
// Why: the render floor is per-OBJECT cost. A census of a project-96 ride found
// 12,578 visible meshes for 2,362 draw calls — 4,267 of them road pieces
// (2,403 individual bike-lane quads) over ~4 shared materials, and render was
// 36 ms at only 743 calls on prod. three.js walks, frustum-tests, sorts and
// submits every mesh every frame; merging is the lever that shrinks the walk.
//
// The contract, shaped by how roads stream:
//   - An OWNER is the unit of lifecycle (a road feature, refcounted across the
//     tiles that reference it; later a building). Owners add PARTS — raw
//     geometry arrays — and are removed whole when their last reference drops.
//   - A BUCKET is the unit of rendering (one material + render flags). Owners
//     contribute parts to several buckets; a bucket assembles into one mesh.
//   - Assembly is a concatenation with index rebasing. Callers may drain it
//     synchronously for small/forced publications or cooperatively when one
//     dense bucket must not monopolise a frame.
//   - Each owner's contribution is recorded as a contiguous RANGE in the merged
//     buffers, so picking can resolve a ray hit's face back to the owner and a
//     highlight can be built for just that slice. This is what per-mesh
//     userData did before merging; ranges are its replacement.
//
// Pure data in, pure data out: no THREE, no DOM, headless-testable. The caller
// turns assembled arrays into BufferGeometry/BufferAttribute objects.

// Attribute layout is fixed by the first part. Index representation belongs to
// each publication: if any part has indices, assemble one indexed output and
// emit sequential indices for its implicit neighbours. Clipping can therefore
// change a part's tessellation without splitting a material into more draws.
const ATTRIBUTE_ITEM_SIZES = { position: 3, normal: 3, uv: 2, color: 3 };
const DEFAULT_ASSEMBLY_VALUES_PER_STAGE = 16384;
const DEFAULT_ASSEMBLY_PARTS_PER_STAGE = 128;

function defaultNow() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function positiveIntegerOr(value, fallback) {
    const numeric = Math.floor(Number(value));
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function schemaOf(part) {
    const names = Object.keys(part.attributes || {}).sort();
    if (!names.includes('position')) {
        throw new Error('geometry-batch: a part must at least carry positions');
    }
    return { names };
}

function schemasMatch(a, b) {
    return a.names.length === b.names.length
        && a.names.every((name, i) => name === b.names[i]);
}

function vertexCountOf(part) {
    return (part.attributes.position.length / 3) | 0;
}

function indexCountOf(part) {
    return part.index?.length ?? vertexCountOf(part);
}

function validatePart(bucketKey, bucketSchema, part) {
    const schema = schemaOf(part);
    if (!schemasMatch(bucketSchema, schema)) {
        throw new Error(`geometry-batch: part schema mismatch in bucket "${bucketKey}" `
            + `(bucket [${bucketSchema.names}], part [${schema.names}])`);
    }
    for (const name of schema.names) {
        const itemSize = ATTRIBUTE_ITEM_SIZES[name];
        if (!itemSize) throw new Error(`geometry-batch: unknown attribute "${name}"`);
        const expected = vertexCountOf(part) * itemSize;
        if (part.attributes[name].length !== expected) {
            throw new Error(`geometry-batch: "${name}" length ${part.attributes[name].length} `
                + `does not match ${vertexCountOf(part)} vertices in bucket "${bucketKey}"`);
        }
    }
}

export function createGeometryBatcher() {
    // bucketKey -> { schema, owners: Map<ownerKey, {parts: [], entity}> }
    const buckets = new Map();
    const dirty = new Set();
    let pendingReplacement = null;

    function bucketFor(bucketKey, part) {
        let bucket = buckets.get(bucketKey);
        if (!bucket) {
            bucket = { schema: schemaOf(part), owners: new Map(), revision: 0 };
            buckets.set(bucketKey, bucket);
        }
        return bucket;
    }

    // Snapshot a bucket's immutable parts, then copy them into one publication
    // buffer over bounded stages. A caller may retain its old rendered geometry
    // until this task is complete. If an owner arrives or leaves meanwhile,
    // isCurrent() rejects the staged generation rather than publishing a
    // mixture of revisions.
    function beginBucketAssembly(bucketKey, bucket, current, {
        valuesPerStage = DEFAULT_ASSEMBLY_VALUES_PER_STAGE,
        partsPerStage = DEFAULT_ASSEMBLY_PARTS_PER_STAGE,
        includeBounds = false,
        includeOwnerBounds = false,
        now = defaultNow,
        admitBytes = null,
    } = {}) {
        const revision = bucket?.revision ?? -1;
        const schema = bucket?.schema || null;
        const valueChunk = positiveIntegerOr(
            valuesPerStage,
            DEFAULT_ASSEMBLY_VALUES_PER_STAGE,
        );
        const partChunk = positiveIntegerOr(
            partsPerStage,
            DEFAULT_ASSEMBLY_PARTS_PER_STAGE,
        );
        let complete = false;
        let assembled;
        let lastPhase = null;
        let cancelled = false;

        function* assemblySteps() {
            if (!bucket || !schema) return null;
            const owners = [];
            let vertexTotal = 0;
            let indexTotal = 0;
            let indexed = false;
            let snapshottedParts = 0;
            for (const [ownerKey, owner] of bucket.owners) {
                const snapshot = {
                    ownerKey,
                    entity: owner.entity,
                    parts: [],
                };
                for (const part of owner.parts) {
                    snapshot.parts.push(part);
                    vertexTotal += vertexCountOf(part);
                    indexed ||= part.index != null;
                    indexTotal += indexCountOf(part);
                    snapshottedParts += 1;
                    if (snapshottedParts >= partChunk) {
                        snapshottedParts = 0;
                        yield { phase: 'snapshot' };
                    }
                }
                owners.push(snapshot);
            }
            if (owners.length === 0 || vertexTotal === 0) return null;
            if (!indexed) indexTotal = 0;

            const bytes = (schema.names.reduce((sum, name) =>
                sum + vertexTotal * ATTRIBUTE_ITEM_SIZES[name], 0) + indexTotal) * 4;
            // Admission precedes the FIRST output allocation, not merely the
            // later Three.js wrapper. A denied reservation yields a new turn,
            // even for callers otherwise draining with an infinite CPU budget.
            while (admitBytes && !admitBytes(bytes)) yield { phase: 'memory-wait', waiting: true };

            const attributes = {};
            for (const name of schema.names) {
                attributes[name] = new Float32Array(
                    vertexTotal * ATTRIBUTE_ITEM_SIZES[name],
                );
                yield { phase: 'allocate' };
            }
            const index = indexed ? new Uint32Array(indexTotal) : null;
            if (index) yield { phase: 'allocate' };

            const bounds = includeBounds ? {
                minX: Infinity,
                minY: Infinity,
                minZ: Infinity,
                maxX: -Infinity,
                maxY: -Infinity,
                maxZ: -Infinity,
            } : null;
            const ranges = [];
            const surfaceAuditRanges = [];
            const hasSurfaceAuditClaims = owners.some(owner => owner.parts.some(part =>
                Object.prototype.hasOwnProperty.call(part, 'surfaceClaim')));
            let vertexAt = 0;
            let indexAt = 0;
            for (const owner of owners) {
                const start = indexed ? indexAt : vertexAt;
                const ownerBox = includeOwnerBounds ? {
                    minX: Infinity, minY: Infinity, minZ: Infinity,
                    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
                } : null;
                for (const part of owner.parts) {
                    const partStart = indexed ? indexAt : vertexAt;
                    for (const name of schema.names) {
                        const source = part.attributes[name];
                        const itemSize = ATTRIBUTE_ITEM_SIZES[name];
                        const target = attributes[name];
                        const targetOffset = vertexAt * itemSize;
                        const alignedChunk = Math.max(
                            itemSize,
                            Math.floor(valueChunk / itemSize) * itemSize,
                        );
                        for (let sourceAt = 0; sourceAt < source.length;) {
                            const sourceEnd = Math.min(source.length, sourceAt + alignedChunk);
                            if (typeof source.subarray === 'function') {
                                target.set(
                                    source.subarray(sourceAt, sourceEnd),
                                    targetOffset + sourceAt,
                                );
                            } else {
                                for (let cursor = sourceAt; cursor < sourceEnd; cursor++) {
                                    target[targetOffset + cursor] = source[cursor];
                                }
                            }
                            if ((bounds || ownerBox) && name === 'position') {
                                for (let cursor = sourceAt; cursor < sourceEnd; cursor += 3) {
                                    const x = Number(target[targetOffset + cursor]);
                                    const y = Number(target[targetOffset + cursor + 1]);
                                    const z = Number(target[targetOffset + cursor + 2]);
                                    if (!Number.isFinite(x)
                                        || !Number.isFinite(y)
                                        || !Number.isFinite(z)) continue;
                                    if (bounds) {
                                        if (x < bounds.minX) bounds.minX = x;
                                        if (y < bounds.minY) bounds.minY = y;
                                        if (z < bounds.minZ) bounds.minZ = z;
                                        if (x > bounds.maxX) bounds.maxX = x;
                                        if (y > bounds.maxY) bounds.maxY = y;
                                        if (z > bounds.maxZ) bounds.maxZ = z;
                                    }
                                    if (ownerBox) {
                                        if (x < ownerBox.minX) ownerBox.minX = x;
                                        if (y < ownerBox.minY) ownerBox.minY = y;
                                        if (z < ownerBox.minZ) ownerBox.minZ = z;
                                        if (x > ownerBox.maxX) ownerBox.maxX = x;
                                        if (y > ownerBox.maxY) ownerBox.maxY = y;
                                        if (z > ownerBox.maxZ) ownerBox.maxZ = z;
                                    }
                                }
                            }
                            sourceAt = sourceEnd;
                            yield { phase: `copy-${name}` };
                        }
                    }
                    if (indexed) {
                        const sourceIndex = part.index;
                        const sourceLength = indexCountOf(part);
                        for (let sourceAt = 0; sourceAt < sourceLength;) {
                            const sourceEnd = Math.min(
                                sourceLength,
                                sourceAt + valueChunk,
                            );
                            for (let cursor = sourceAt; cursor < sourceEnd; cursor++) {
                                index[indexAt + cursor] = (sourceIndex ? sourceIndex[cursor] : cursor) + vertexAt;
                            }
                            sourceAt = sourceEnd;
                            yield { phase: 'copy-index' };
                        }
                        indexAt += sourceLength;
                    }
                    vertexAt += vertexCountOf(part);
                    const partEnd = indexed ? indexAt : vertexAt;
                    if (hasSurfaceAuditClaims && partEnd > partStart) {
                        surfaceAuditRanges.push({
                            ownerKey: owner.ownerKey,
                            claim: Object.prototype.hasOwnProperty.call(part, 'surfaceClaim')
                                ? part.surfaceClaim : null,
                            start: partStart,
                            count: partEnd - partStart,
                        });
                    }
                }
                const end = indexed ? indexAt : vertexAt;
                if (end > start) {
                    const range = {
                        ownerKey: owner.ownerKey,
                        entity: owner.entity,
                        start,
                        count: end - start,
                    };
                    if (ownerBox) {
                        const finiteOwnerBox = Object.values(ownerBox).every(Number.isFinite)
                            ? ownerBox : null;
                        if (finiteOwnerBox) range.bounds = finiteOwnerBox;
                    }
                    ranges.push(range);
                }
                yield { phase: 'range' };
            }
            const finiteBounds = bounds && Object.values(bounds).every(Number.isFinite)
                ? bounds
                : null;
            return {
                attributes,
                index,
                ranges,
                ...(hasSurfaceAuditClaims ? { surfaceAuditRanges } : {}),
                bounds: finiteBounds,
                vertexCount: vertexTotal,
                indexed,
            };
        }

        const iterator = assemblySteps();
        return {
            bucketKey,
            revision,
            step(budgetMs = 2) {
                if (cancelled) throw new Error('Geometry assembly was cancelled');
                if (complete) return true;
                const numericBudget = Number(budgetMs);
                const deadline = numericBudget === Infinity
                    ? Infinity
                    : Number(now()) + Math.max(0.1, numericBudget || 0);
                do {
                    const next = iterator.next();
                    if (next.done) {
                        assembled = next.value;
                        complete = true;
                        return true;
                    }
                    lastPhase = next.value?.phase || null;
                    if (next.value?.waiting) return false;
                } while (Number(now()) < deadline);
                return false;
            },
            lastPhase() {
                return lastPhase;
            },
            isCurrent() {
                return !cancelled && current();
            },
            result() {
                return complete ? assembled : undefined;
            },
            cancel() {
                if (cancelled) return;
                cancelled = true;
                iterator.return();
                assembled = undefined;
            },
        };
    }

    function beginAssembly(bucketKey, options) {
        const bucket = buckets.get(bucketKey) || null;
        const revision = bucket?.revision;
        return beginBucketAssembly(bucketKey, bucket,
            () => (buckets.get(bucketKey) || null) === bucket && bucket?.revision === revision, options);
    }

    // Prepare only the affected material/region buckets. Unchanged input
    // buffers are retained by reference; output assembly uses the SAME bounded
    // compiler as ordinary streaming. Neither owners nor dirty flags change
    // until all replacement outputs are ready for their scene transaction.
    function* prepareReplacementSteps(replacements, { maxBuckets, maxOwners, maxParts, maxOutputBytes } = {}) {
        for (const [name, value] of Object.entries({ maxBuckets, maxOwners, maxParts, maxOutputBytes })) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid geometry replacement limit ${name}`);
        }
        if (pendingReplacement) throw new Error('Geometry replacement is already pending');
        if (!Array.isArray(replacements) || !replacements.length || replacements.length > maxOwners) {
            throw new Error('Geometry replacement owner capacity exceeded');
        }
        const token = {}; pendingReplacement = token;
        const previous = new Map(), revisions = new Map(), staged = new Map(), changes = new Map();
        const assemblies = new Map(), priorDirty = new Map();
        let phase = 'preparing', handedOff = false, partCount = 0, outputBytes = 0;
        const inputsCurrent = () => {
            if (pendingReplacement !== token) return false;
            for (const key of previous.keys()) {
                const bucket = previous.get(key);
                if ((buckets.get(key) || null) !== bucket || bucket?.revision !== revisions.get(key)) return false;
            }
            return true;
        };
        const release = () => {
            for (const task of assemblies.values()) task.cancel();
            assemblies.clear(); previous.clear(); revisions.clear(); staged.clear(); changes.clear(); priorDirty.clear();
            if (pendingReplacement === token) pendingReplacement = null;
        };
        try {
            for (const row of replacements) {
                if (!row || typeof row.bucketKey !== 'string' || !row.bucketKey
                    || row.ownerKey == null || !Array.isArray(row.parts)) throw new TypeError('Invalid geometry replacement');
                let owners = changes.get(row.bucketKey);
                if (!owners) {
                    if (changes.size >= maxBuckets) throw new Error('Geometry replacement bucket capacity exceeded');
                    changes.set(row.bucketKey, owners = new Map());
                    const bucket = buckets.get(row.bucketKey) || null;
                    previous.set(row.bucketKey, bucket); revisions.set(row.bucketKey, bucket?.revision);
                }
                if (owners.has(row.ownerKey)) throw new Error('Duplicate geometry replacement owner');
                const parts = [];
                for (const part of row.parts) {
                    if (++partCount > maxParts) throw new Error('Geometry replacement part capacity exceeded');
                    parts.push(part);
                    yield { phase: 'replacement-input' };
                }
                owners.set(row.ownerKey, parts);
                yield { phase: 'replacement-owner' };
            }
            for (const [key, ownerChanges] of changes) {
                if (!inputsCurrent()) throw new Error('Geometry replacement inputs became stale');
                const old = previous.get(key);
                const next = { schema: old?.schema || null, owners: new Map(), revision: (old?.revision || 0) + 1 };
                let changed = false;
                for (const [ownerKey, owner] of old?.owners || []) {
                    if (ownerChanges.has(ownerKey)) {
                        // Preserve ordering without copying parts which this
                        // candidate already replaces or removes below.
                        next.owners.set(ownerKey, owner);
                        yield { phase: 'replacement-owner-slot' };
                        continue;
                    }
                    const parts = [];
                    for (const part of owner.parts) {
                        if (++partCount > maxParts) throw new Error('Geometry replacement part capacity exceeded');
                        parts.push(part); yield { phase: 'replacement-retain' };
                    }
                    next.owners.set(ownerKey, { entity: owner.entity, parts });
                }
                for (const [ownerKey, parts] of ownerChanges) {
                    const owner = old?.owners.get(ownerKey);
                    if (owner && owner.parts.length === parts.length && owner.parts.every((part, index) => part === parts[index])) {
                        next.owners.set(ownerKey, { entity: owner.entity, parts });
                        continue;
                    }
                    if (!parts.length) { changed = next.owners.delete(ownerKey) || changed; continue; }
                    const replacement = { parts, entity: null };
                    for (const part of parts) {
                        next.schema ||= schemaOf(part);
                        validatePart(key, next.schema, part);
                        if (!replacement.entity && part.entity) replacement.entity = part.entity;
                        yield { phase: 'replacement-validate' };
                    }
                    next.owners.set(ownerKey, replacement); changed = true;
                }
                if (!changed) continue;
                let indexElements = 0, indexed = false;
                for (const owner of next.owners.values()) for (const part of owner.parts) {
                    indexed ||= part.index != null;
                    indexElements += indexCountOf(part);
                    outputBytes += Object.values(part.attributes).reduce((sum, values) => sum + values.length, 0) * 4;
                    if (!Number.isSafeInteger(outputBytes) || outputBytes > maxOutputBytes) {
                        throw Object.assign(new RangeError(`Geometry replacement output capacity exceeded (${outputBytes} > ${maxOutputBytes} bytes): ${key}`),
                            { code: 'geometry-replacement-capacity', details: { outputBytes, maxOutputBytes, bucketKey: key } });
                    }
                    yield { phase: 'replacement-budget' };
                }
                if (indexed) outputBytes += indexElements * 4;
                if (!Number.isSafeInteger(outputBytes) || outputBytes > maxOutputBytes) {
                    throw Object.assign(new RangeError(`Geometry replacement output capacity exceeded (${outputBytes} > ${maxOutputBytes} bytes): ${key}`),
                        { code: 'geometry-replacement-capacity', details: { outputBytes, maxOutputBytes, bucketKey: key } });
                }
                staged.set(key, next);
                yield { phase: 'replacement-bucket' };
            }
            if (!inputsCurrent()) throw new Error('Geometry replacement inputs became stale');
            phase = 'prepared'; handedOff = true;
            return {
                bucketKeys: Object.freeze([...staged.keys()]), outputBytes,
                isCurrent: () => phase === 'prepared' && inputsCurrent(),
                beginAssembly(key, options) {
                    if (phase !== 'prepared' || !staged.has(key) || assemblies.has(key)) throw new Error('Invalid staged geometry assembly');
                    const task = beginBucketAssembly(key, staged.get(key), () => phase === 'prepared' && inputsCurrent(), options);
                    assemblies.set(key, task); return task;
                },
                commit() {
                    if (phase !== 'prepared' || !inputsCurrent() || assemblies.size !== staged.size
                        || [...assemblies.values()].some(task => !task.isCurrent() || task.result() === undefined)) return false;
                    for (const [key, bucket] of staged) {
                        priorDirty.set(key, dirty.has(key)); buckets.set(key, bucket); dirty.delete(key);
                    }
                    phase = 'committed'; return true;
                },
                rollback() {
                    if (phase !== 'committed') return false;
                    for (const key of staged.keys()) {
                        const old = previous.get(key);
                        if (old) buckets.set(key, old); else buckets.delete(key);
                        if (priorDirty.get(key)) dirty.add(key); else dirty.delete(key);
                    }
                    phase = 'prepared'; return true;
                },
                discard() {
                    if (phase === 'committed') throw new Error('Rollback geometry replacement before discarding');
                    if (phase !== 'prepared') return false;
                    phase = 'discarded'; release(); return true;
                },
                finalize() {
                    if (phase !== 'committed') return false;
                    phase = 'finalized'; release(); return true;
                },
            };
        } finally {
            if (!handedOff) { phase = 'discarded'; release(); }
        }
    }

    return {
        // part: { attributes: {position, uv?, normal?, color?}, index?, entity?, surfaceClaim? }
        // Arrays may be typed arrays or plain arrays; they are copied into the
        // merged output at assemble time, not now, so the caller may hand over
        // a geometry's live attribute arrays without cloning.
        addPart(bucketKey, ownerKey, part) {
            const bucket = bucketFor(bucketKey, part);
            validatePart(bucketKey, bucket.schema, part);
            let owner = bucket.owners.get(ownerKey);
            if (!owner) {
                owner = { parts: [], entity: null };
                bucket.owners.set(ownerKey, owner);
            }
            if (part.entity && !owner.entity) owner.entity = part.entity;
            owner.parts.push(part);
            bucket.revision += 1;
            dirty.add(bucketKey);
        },

        // Drop every part this owner contributed to the bucket. True when
        // something was actually removed — the caller's signal to re-assemble.
        removeOwner(bucketKey, ownerKey) {
            const bucket = buckets.get(bucketKey);
            if (!bucket || !bucket.owners.delete(ownerKey)) return false;
            bucket.revision += 1;
            dirty.add(bucketKey);
            // An emptied bucket keeps its schema: road buckets refill with the
            // same creators, and forgetting the schema here would let the first
            // part after a full evict redefine it silently.
            return true;
        },

        // Roads dispose a feature in one call without knowing which buckets it
        // reached. Returns the bucket keys that actually changed.
        removeOwnerEverywhere(ownerKey) {
            const touched = [];
            for (const [bucketKey, bucket] of buckets) {
                if (bucket.owners.delete(ownerKey)) {
                    bucket.revision += 1;
                    dirty.add(bucketKey);
                    touched.push(bucketKey);
                }
            }
            return touched;
        },

        hasOwner(bucketKey, ownerKey) {
            return buckets.get(bucketKey)?.owners.has(ownerKey) || false;
        },

        // Remove a bucket outright, schema included. For buckets whose key is
        // scoped to a streamed tile the tile's eviction IS the bucket's death —
        // walking owners one by one would be ceremony around a Map.delete.
        dropBucket(bucketKey) {
            if (!buckets.delete(bucketKey)) return false;
            dirty.delete(bucketKey);
            return true;
        },

        // Buckets changed since the last drain. The caller assembles these on
        // its own settle cadence.
        // Buckets whose contents changed since the last take, and forget them.
        //
        // `only` restricts the take to a subset (a region's buckets, say) and
        // leaves the rest marked. Callers are regional: taking the WHOLE set
        // would clear dirt belonging to a region whose own tile has not
        // completed yet, and that region would then believe its geometry was
        // already assembled.
        takeDirtyBuckets(only = null) {
            if (!only) {
                const keys = [...dirty];
                dirty.clear();
                return keys;
            }
            const keys = [];
            for (const key of only) {
                if (dirty.delete(key)) keys.push(key);
            }
            return keys;
        },

        // One merged geometry for the bucket, or null when it is empty.
        //   attributes: name -> Float32Array   (concatenated in owner order)
        //   index: Uint32Array | null          (rebased)
        //   ranges: [{ownerKey, entity, start, count}] — units are INDEX entries
        //           for indexed buckets, VERTICES otherwise; contiguous, sorted
        //           by start, covering the whole buffer.
        beginAssembly,
        prepareReplacementSteps,

        assemble(bucketKey) {
            const task = beginAssembly(bucketKey);
            task.step(Infinity);
            return task.result();
        },

        stats() {
            const out = {};
            for (const [bucketKey, bucket] of buckets) {
                let parts = 0;
                for (const owner of bucket.owners.values()) parts += owner.parts.length;
                out[bucketKey] = { owners: bucket.owners.size, parts };
            }
            return out;
        },

        clear() {
            buckets.clear();
            dirty.clear();
            pendingReplacement = null;
        },
    };
}

// A ray hit reports a face; the owner whose range covers it is the entity that
// was really picked. `faceIndex` is three.js's triangle index into the DRAWN
// order — element `faceIndex*3` of the index for indexed geometry, vertex
// `faceIndex*3` otherwise — which is the same unit the ranges are recorded in.
export function ownerRangeForFace(ranges, faceIndex) {
    if (!Array.isArray(ranges) || !Number.isInteger(faceIndex) || faceIndex < 0) return null;
    const offset = faceIndex * 3;
    // Ranges are sorted and contiguous; binary search by start.
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const range = ranges[mid];
        if (offset < range.start) hi = mid - 1;
        else if (offset >= range.start + range.count) lo = mid + 1;
        else return range;
    }
    return null;
}
