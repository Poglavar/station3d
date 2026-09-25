// What a receiver compile actually read from the shared ground models, and
// whether a later change can have altered any of it. Road receivers used to
// recompile whenever their padded source box touched a changed road profile's
// box; 93–98 % of those recompiles reproduced identical geometry (2026-09-23),
// while changes that bypass surface profiles (centreline grades read through a
// nearby carriageway) were missed. Sources record reads here as they answer
// them, and publish complete change sets; a receiver is stale exactly when its
// evidence meets a change.
//
// Sources: terrain samples (TerrainReference), road formation queries,
// vertical alignments and structure publications.
//
// Evidence has three parts:
//   discs — a query at (x, z) whose answer can depend on anything within
//           `reach` metres. Stored on an 8 m grid with the largest reach per
//           cell, so a disc is tested as its cell's square grown by reach.
//   ids   — reads keyed by an OSM id (a road's own centreline, profiles or
//           alignment), independent of where the query point lies.
//   keys  — reads of a named whole-source input (alignment cut-outs, one
//           structure publication), or UNBOUNDED for a read of everything.
// A change set lists changed ids and keys, and boxes covering the old and new
// influence of every changed entity. `full` depends everything on it.

export const GROUND_READ_UNBOUNDED = '*';
// Alignment replacement cut-outs are read as one list.
export const ROAD_ALIGNMENT_CUTOUTS_READ_KEY = 'road-alignment:cutouts';
export const roadStructurePublicationReadKey = alignmentId => `road-structure:${alignmentId}`;

const CELL_M = 8;
const CELL_OFFSET = 1 << 20;
const CELL_SPAN = 1 << 21;
const INDEX_CELL_M = 64;

let active = null;

export function createGroundReadEvidence() {
    // lastKey/lastReach: consecutive samples usually share a cell; skip the map.
    return { cells: new Map(), ids: new Set(), keys: new Set(), lastKey: NaN, lastReach: -1 };
}

// Runs `callback` with `evidence` as the recording target. Nested scopes
// restore the outer target, so one compile can never record into another.
export function withGroundReadEvidence(evidence, callback) {
    const previous = active;
    active = evidence;
    try { return callback(); } finally { active = previous; }
}

export function recordGroundReadDisc(x, z, reach = 0) {
    if (!active) return;
    const px = Number(x), pz = Number(z), r = Math.max(0, Number(reach) || 0);
    if (!Number.isFinite(px) || !Number.isFinite(pz) || !Number.isFinite(r)) {
        active.keys.add(GROUND_READ_UNBOUNDED);
        return;
    }
    const cx = Math.floor(px / CELL_M), cz = Math.floor(pz / CELL_M);
    if (Math.abs(cx) >= CELL_OFFSET || Math.abs(cz) >= CELL_OFFSET) {
        active.keys.add(GROUND_READ_UNBOUNDED);
        return;
    }
    const key = (cx + CELL_OFFSET) * CELL_SPAN + (cz + CELL_OFFSET);
    if (key === active.lastKey && r <= active.lastReach) return;
    const previous = active.cells.get(key);
    const reachInCell = previous === undefined || r > previous ? r : previous;
    if (reachInCell !== previous) active.cells.set(key, reachInCell);
    active.lastKey = key; active.lastReach = reachInCell;
}

export function recordGroundReadId(id) {
    if (!active || id == null) return;
    active.ids.add(String(id));
}

export function recordGroundReadKey(key) {
    if (!active) return;
    active.keys.add(String(key));
}

export function groundReadEvidenceActive() {
    return active !== null;
}

// Compact, immutable form retained on a published receiver. Cell indices
// (below 2^21) and reaches are exact in single precision.
export function freezeGroundReadEvidence(evidence) {
    const cells = new Float32Array(evidence.cells.size * 3);
    let index = 0;
    for (const [key, reach] of evidence.cells) {
        const cx = Math.floor(key / CELL_SPAN) - CELL_OFFSET;
        const cz = key - (cx + CELL_OFFSET) * CELL_SPAN - CELL_OFFSET;
        // Round the reach up, never down, when narrowing to single precision.
        cells[index++] = cx; cells[index++] = cz; cells[index++] = reach + 1e-3;
    }
    return Object.freeze({ cells, ids: Object.freeze([...evidence.ids]), keys: Object.freeze([...evidence.keys]) });
}

function validBox(box) {
    return box && [box.minX, box.minZ, box.maxX, box.maxZ].every(Number.isFinite)
        && box.minX <= box.maxX && box.minZ <= box.maxZ;
}

// `boxes` are the old and new influence regions of changed entities.
export function createGroundChangeSet({ full = false, reason = null, ids = [], keys = [], boxes = [] } = {}) {
    const index = new Map();
    const kept = [];
    let unindexable = null;
    for (const box of boxes) {
        if (!validBox(box)) { unindexable ||= 'invalid-region'; continue; }
        const entry = Object.freeze({ minX: box.minX, minZ: box.minZ, maxX: box.maxX, maxZ: box.maxZ });
        kept.push(entry);
        const minX = Math.floor(entry.minX / INDEX_CELL_M), maxX = Math.floor(entry.maxX / INDEX_CELL_M);
        const minZ = Math.floor(entry.minZ / INDEX_CELL_M), maxZ = Math.floor(entry.maxZ / INDEX_CELL_M);
        if ((maxX - minX + 1) * (maxZ - minZ + 1) > 4096) { unindexable ||= 'oversized-region'; continue; }
        for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
            const key = `${x}_${z}`;
            const list = index.get(key);
            if (list) list.push(entry); else index.set(key, [entry]);
        }
    }
    // An invalid or city-sized change region cannot be localised; treat the
    // whole set as full rather than silently dropping it.
    const changedIds = new Set([...ids].map(String)), changedKeys = new Set([...keys].map(String));
    const isFull = full === true || !!unindexable;
    return Object.freeze({
        full: isFull, fullReason: isFull ? (full === true ? reason || 'unspecified' : unindexable) : null,
        ids: changedIds, keys: changedKeys, boxes: Object.freeze(kept), index,
        empty: !isFull && kept.length === 0 && changedIds.size === 0 && changedKeys.size === 0,
    });
}

export function mergeGroundChangeSets(sets) {
    return createGroundChangeSet({
        full: sets.some(set => set.full),
        reason: sets.filter(set => set.full).map(set => set.fullReason).join(',') || null,
        ids: sets.flatMap(set => [...set.ids]),
        keys: sets.flatMap(set => [...set.keys]),
        boxes: sets.flatMap(set => set.boxes),
    });
}

function changeBoxesNear(changes, minX, minZ, maxX, maxZ) {
    const x0 = Math.floor(minX / INDEX_CELL_M), x1 = Math.floor(maxX / INDEX_CELL_M);
    const z0 = Math.floor(minZ / INDEX_CELL_M), z1 = Math.floor(maxZ / INDEX_CELL_M);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        for (const box of changes.index.get(`${x}_${z}`) || []) {
            if (box.minX <= maxX && box.maxX >= minX && box.minZ <= maxZ && box.maxZ >= minZ) return true;
        }
    }
    return false;
}

// Which recorded read a change can have altered: 'full', 'no-evidence',
// 'unbounded', 'key', 'id', 'region', or null when none.
export function groundReadEvidenceDependency(evidence, changes) {
    if (!changes || changes.full) return 'full';
    if (changes.empty) return null;
    if (!evidence) return 'no-evidence';
    for (const key of evidence.keys) {
        if (key === GROUND_READ_UNBOUNDED) return 'unbounded';
        if (changes.keys.has(key)) return 'key';
    }
    for (const id of evidence.ids) if (changes.ids.has(id)) return 'id';
    const cells = evidence.cells;
    for (let index = 0; index < cells.length; index += 3) {
        const reach = cells[index + 2];
        const minX = cells[index] * CELL_M - reach, minZ = cells[index + 1] * CELL_M - reach;
        const maxX = (cells[index] + 1) * CELL_M + reach, maxZ = (cells[index + 1] + 1) * CELL_M + reach;
        if (changeBoxesNear(changes, minX, minZ, maxX, maxZ)) return 'region';
    }
    return null;
}

// True when a change can have altered an answer recorded in `evidence`.
export function groundReadEvidenceDependsOn(evidence, changes) {
    return groundReadEvidenceDependency(evidence, changes) !== null;
}

// Counts for generation usage reports.
export function summarizeGroundChangeSet(changes) {
    return Object.freeze({ full: !!changes?.full, fullReason: changes?.fullReason || null, ids: changes?.ids.size || 0, keys: [...(changes?.keys || [])].slice(0, 8),
        regions: changes?.boxes.length || 0 });
}

// Conservative test for a receiver without evidence (compiled before this
// contract, or by a path that does not record): overlap between its padded
// source boxes and any changed region. Sources give every changed id and key
// a box, so the boxes alone cover them.
export function groundBoundsDependOn(bounds, changes) {
    if (!changes || changes.full) return true;
    if (changes.empty) return false;
    return (bounds || []).some(box => validBox(box)
        && changeBoxesNear(changes, box.minX, box.minZ, box.maxX, box.maxZ));
}
