// Uniform grid over anything carrying a `bounds` rectangle, so a point or edge
// query visits the few items near it instead of every item there is.
//
// Written for curb suppression, which asks "is this piece inside any no-curb /
// tram / parking mask?" a few times per sampled piece, and subdivides a road
// ring into a piece every couple of metres. Scanning the whole mask list per
// question made one road feature cost 98 ms — the same shape as the corridor
// scan that a uniform grid removed from the top of a profile entirely.
//
// Pure: no THREE, no DOM, no coordinate assumptions beyond a flat x/z plane.

import { finiteOrNull } from './math.js';

const DEFAULT_CELL_M = 24;
// An item whose bounds span more cells than this is registered once in an
// always-checked list rather than stamped into hundreds of cells. Without it a
// single citywide polygon makes building the index cost more than the scan it
// replaces — and the failure would be silent, because the answers stay correct.
const MAX_CELLS_PER_ITEM = 64;

const cellOf = (value, cellM) => Math.floor(value / cellM);
const key = (cx, cz) => `${cx}_${cz}`;

export function createBoundsGrid(items, options) {
    const steps = createBoundsGridSteps(items, options);
    let next;
    do { next = steps.next(); } while (!next.done);
    return next.value;
}

export function* createBoundsGridSteps(items, { cellM = DEFAULT_CELL_M, now = () => performance.now(),
    maxPointCandidates = Infinity, maxIndexEntries = Infinity } = {}) {
    if (!(Number.isFinite(cellM) && cellM > 0)
        || ![maxPointCandidates, maxIndexEntries].every(value => value === Infinity
            || Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('Bounds grid requires positive cell size and capacities');
    }
    const list = Array.isArray(items) ? items : [];
    const cells = new Map();
    const oversized = [];
    let largestBucket = 0, indexEntries = 0;
    const checkCapacity = () => {
        if (largestBucket + oversized.length > maxPointCandidates || ++indexEntries > maxIndexEntries) {
            throw Object.assign(new RangeError('Bounds grid exceeds its query or index capacity'),
                { code: 'ground-generation-capacity' });
        }
    };

    let deadline = now() + 0.5;
    for (const item of list) {
        if (now() >= deadline) {
            yield { phase: 'bounds-grid-index' };
            deadline = now() + 0.5;
        }
        const bounds = item?.bounds;
        if (!bounds
            || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)
            || !Number.isFinite(bounds.minZ) || !Number.isFinite(bounds.maxZ)) {
            // No usable bounds means no way to exclude it — it must be checked
            // by every query or the grid would silently drop a real mask.
            oversized.push(item);
            checkCapacity();
            continue;
        }
        const minCx = cellOf(bounds.minX, cellM);
        const maxCx = cellOf(bounds.maxX, cellM);
        const minCz = cellOf(bounds.minZ, cellM);
        const maxCz = cellOf(bounds.maxZ, cellM);
        if ((maxCx - minCx + 1) * (maxCz - minCz + 1) > MAX_CELLS_PER_ITEM) {
            oversized.push(item);
            checkCapacity();
            continue;
        }
        for (let cz = minCz; cz <= maxCz; cz++) {
            for (let cx = minCx; cx <= maxCx; cx++) {
                if (now() >= deadline) {
                    yield { phase: 'bounds-grid-index' };
                    deadline = now() + 0.5;
                }
                const k = key(cx, cz);
                const bucket = cells.get(k);
                if (bucket) bucket.push(item);
                else cells.set(k, [item]);
                largestBucket = Math.max(largestBucket, bucket ? bucket.length : 1);
                checkCapacity();
            }
        }
    }

    // Reused across queries: results are read and discarded within one call, and
    // allocating a fresh array per sampled piece is exactly the kind of garbage
    // that turns into a GC pause in the middle of a build.
    //
    // The contract this buys is narrow and worth stating: the returned array is
    // valid only until the NEXT query on the same grid. A caller that holds one
    // across a second query — or nests two queries on one grid — reads the
    // second result thinking it is the first, with no error anywhere. Callers
    // here iterate immediately; `candidatesCopy` exists for anyone who cannot.
    const scratch = [];

    function collect(minCx, minCz, maxCx, maxCz) {
        scratch.length = 0;
        for (let index = 0; index < oversized.length; index++) scratch.push(oversized[index]);
        // Small spans are the norm (a point is one cell); a Set would cost more
        // than the duplicate work it saves, so dedupe only when the box spans
        // more than one cell.
        const single = minCx === maxCx && minCz === maxCz;
        if (single) {
            const bucket = cells.get(key(minCx, minCz));
            if (bucket) for (let index = 0; index < bucket.length; index++) scratch.push(bucket[index]);
            return scratch;
        }
        const seen = new Set(scratch);
        for (let cz = minCz; cz <= maxCz; cz++) {
            for (let cx = minCx; cx <= maxCx; cx++) {
                const bucket = cells.get(key(cx, cz));
                if (!bucket) continue;
                for (const item of bucket) {
                    if (seen.has(item)) continue;
                    seen.add(item);
                    scratch.push(item);
                }
            }
        }
        return scratch;
    }

    return {
        // Stable iteration for cooperative readers. It neither copies the
        // bucket nor uses the synchronous query scratch array across a yield.
        *candidateItemsAt(x, z) {
            yield* oversized;
            const bucket = cells.get(key(cellOf(x, cellM), cellOf(z, cellM)));
            if (bucket) yield* bucket;
        },
        // Cooperative callers may hold this iterator across yields and other
        // lookups. Multi-cell results can repeat an item; deduplicate in the
        // caller's budgeted loop. A large query scans each source once instead
        // of traversing an unbounded number of empty cells.
        *candidateItemsInBox(minX, minZ, maxX, maxZ) {
            const minCx=cellOf(Math.min(minX,maxX),cellM), maxCx=cellOf(Math.max(minX,maxX),cellM);
            const minCz=cellOf(Math.min(minZ,maxZ),cellM), maxCz=cellOf(Math.max(minZ,maxZ),cellM);
            if((maxCx-minCx+1)*(maxCz-minCz+1)>MAX_CELLS_PER_ITEM){yield* list;return;}
            yield* oversized;
            for(let cz=minCz;cz<=maxCz;cz++)for(let cx=minCx;cx<=maxCx;cx++) {
                const bucket=cells.get(key(cx,cz));
                if(bucket)yield* bucket;
            }
        },
        // Items whose cell contains (x, z). The caller still does its own exact
        // test — this only narrows the candidates.
        candidatesAt(x, z) {
            const cx = cellOf(x, cellM);
            const cz = cellOf(z, cellM);
            return collect(cx, cz, cx, cz);
        },
        candidatesInBox(minX, minZ, maxX, maxZ) {
            return collect(
                cellOf(Math.min(minX, maxX), cellM),
                cellOf(Math.min(minZ, maxZ), cellM),
                cellOf(Math.max(minX, maxX), cellM),
                cellOf(Math.max(minZ, maxZ), cellM),
            );
        },
        // A snapshot that survives the next query, for a caller that needs to
        // hold the candidates (nested queries, or keeping them past a yield).
        candidatesCopy(x, z) {
            return this.candidatesAt(x, z).slice();
        },
        // Diagnostics: how much the index actually narrows things.
        stats: () => ({ items: list.length, cells: cells.size, oversized: oversized.length,
            indexEntries, maxPointCandidates: largestBucket + oversized.length }),
    };
}

// Streaming layers cannot rebuild an immutable grid every time one object lands:
// buildings arrive a few at a time while pedestrians query the index every
// frame. This variant keeps the same candidate-only contract while making an
// object's cell membership replaceable by stable id.
export function createMutableBoundsGrid({
    cellM = DEFAULT_CELL_M,
    boundsOf = item => item?.bounds,
} = {}) {
    const parsedCellM = finiteOrNull(cellM);
    const resolvedCellM = parsedCellM !== null && parsedCellM > 0
        ? parsedCellM
        : DEFAULT_CELL_M;
    const resolveBounds = typeof boundsOf === 'function'
        ? boundsOf
        : item => item?.bounds;
    const cells = new Map();
    const oversized = new Map();
    const records = new Map();
    const scratch = [];

    function removeRecord(record) {
        if (!record) return false;
        oversized.delete(record.id);
        for (const cellKey of record.cellKeys) {
            const bucket = cells.get(cellKey);
            if (!bucket) continue;
            bucket.delete(record);
            if (bucket.size === 0) cells.delete(cellKey);
        }
        records.delete(record.id);
        return true;
    }

    function set(id, item) {
        removeRecord(records.get(id));
        const record = { id, item, cellKeys: [] };
        records.set(id, record);
        const bounds = resolveBounds(item);
        if (!bounds
            || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)
            || !Number.isFinite(bounds.minZ) || !Number.isFinite(bounds.maxZ)) {
            oversized.set(id, record);
            return item;
        }
        const minCx = cellOf(Math.min(bounds.minX, bounds.maxX), resolvedCellM);
        const maxCx = cellOf(Math.max(bounds.minX, bounds.maxX), resolvedCellM);
        const minCz = cellOf(Math.min(bounds.minZ, bounds.maxZ), resolvedCellM);
        const maxCz = cellOf(Math.max(bounds.minZ, bounds.maxZ), resolvedCellM);
        if ((maxCx - minCx + 1) * (maxCz - minCz + 1) > MAX_CELLS_PER_ITEM) {
            oversized.set(id, record);
            return item;
        }
        for (let cz = minCz; cz <= maxCz; cz++) {
            for (let cx = minCx; cx <= maxCx; cx++) {
                const cellKey = key(cx, cz);
                let bucket = cells.get(cellKey);
                if (!bucket) cells.set(cellKey, bucket = new Set());
                bucket.add(record);
                record.cellKeys.push(cellKey);
            }
        }
        return item;
    }

    function collect(minCx, minCz, maxCx, maxCz) {
        scratch.length = 0;
        const seen = new Set();
        for (const record of oversized.values()) {
            seen.add(record);
            scratch.push(record.item);
        }
        for (let cz = minCz; cz <= maxCz; cz++) {
            for (let cx = minCx; cx <= maxCx; cx++) {
                for (const record of cells.get(key(cx, cz)) || []) {
                    if (seen.has(record)) continue;
                    seen.add(record);
                    scratch.push(record.item);
                }
            }
        }
        return scratch;
    }

    return {
        set,
        delete(id) {
            return removeRecord(records.get(id));
        },
        clear() {
            records.clear();
            cells.clear();
            oversized.clear();
            scratch.length = 0;
        },
        candidatesAt(x, z) {
            const cx = cellOf(x, resolvedCellM);
            const cz = cellOf(z, resolvedCellM);
            return collect(cx, cz, cx, cz);
        },
        candidatesInBox(minX, minZ, maxX, maxZ) {
            return collect(
                cellOf(Math.min(minX, maxX), resolvedCellM),
                cellOf(Math.min(minZ, maxZ), resolvedCellM),
                cellOf(Math.max(minX, maxX), resolvedCellM),
                cellOf(Math.max(minZ, maxZ), resolvedCellM),
            );
        },
        candidatesCopy(x, z) {
            return this.candidatesAt(x, z).slice();
        },
        stats: () => ({
            items: records.size,
            cells: cells.size,
            oversized: oversized.size,
        }),
    };
}
