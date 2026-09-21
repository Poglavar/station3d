// Pure spatial partition of solved rail trackbed segments into render cells,
// with per-cell content signatures, dirty-cell diffing and distance-ranked
// selection. The global chord solve (join vectors, welds, junction endpoint
// lifts) stays whole-network in world/rails.js; cells only decide which subset
// of already-solved chords each render chunk owns, so chunk swaps can never
// reintroduce the cross-chunk seams the global solve exists to kill.
//
// Signatures follow core/electrification-cells.js: object identity is
// deliberately irrelevant, because rail streaming republishes equivalent
// segment objects while terrain settles. Every geometric field any trackbed
// mesh builder consumes is included, so a real shape change still rebuilds
// exactly the cells it touches — and an identical redelivery rebuilds nothing.

import { cellKeyAt, cellCenter } from './electrification-cells.js';
import { finiteOrNull } from './math.js';

export const RAIL_RENDER_CELL_M = 600;
// Hysteresis: cells stay built this far beyond the active radius so walking
// back and forth across a cell boundary cannot thrash build/evict.
export const RAIL_RENDER_CELL_EVICT_PAD_M = 600;
// A 600 m cell is the atomic publication/culling unit, not a CPU work unit.
// Dense heavy-rail cells can contain nearly a thousand sleepers plus several
// material variants, so their geometry is assembled from smaller detached
// batches and the complete parent is still published once.
export const RAIL_RENDER_BATCH_MAX_SEGMENTS = 24;
export const RAIL_RENDER_BATCH_MAX_SEGMENT_M = 80;

function interpolateNumber(start, end, t) {
    return Number(start) + (Number(end) - Number(start)) * t;
}

function interpolateArray(start, end, t) {
    const a = Array.isArray(start) ? start : [];
    const b = Array.isArray(end) ? end : a;
    const count = Math.min(a.length, b.length);
    return Array.from({ length: count }, (_unused, index) => (
        interpolateNumber(a[index], b[index], t)
    ));
}

// Split only the detached RENDER copy. Cell signatures, invalidation ownership
// and complete junction incidents continue to use the original solved chord.
// Intermediate joins use the chord normal; original endpoint miters remain on
// the first/last piece, so the visible strip is byte-for-byte continuous.
export function splitRailRenderSegment(segment, maxSegmentM = RAIL_RENDER_BATCH_MAX_SEGMENT_M) {
    const steps = splitRailRenderSegmentSteps(segment, maxSegmentM);
    let next; do { next = steps.next(); } while (!next.done);
    return next.value;
}

function* splitRailRenderSegmentSteps(segment, maxSegmentM = RAIL_RENDER_BATCH_MAX_SEGMENT_M,
    { now = () => performance.now(), isCurrent = () => true } = {}) {
    let started = now();
    if (!isCurrent()) return null;
    const lengthM = Math.max(0, Number(segment?.len) || Math.hypot(
        Number(segment?.x2) - Number(segment?.x1),
        Number(segment?.z2) - Number(segment?.z1),
    ));
    const limitM = Math.max(1, Number(maxSegmentM) || RAIL_RENDER_BATCH_MAX_SEGMENT_M);
    const partCount = Math.max(1, Math.ceil(lengthM / limitM));
    if (partCount === 1) return [segment];
    const segmentNormalX = finiteOrNull(segment?.px);
    const segmentNormalZ = finiteOrNull(segment?.pz);
    const normalX = segmentNormalX != null
        ? segmentNormalX
        : (Number(segment.z2) - Number(segment.z1)) / lengthM;
    const normalZ = segmentNormalZ != null
        ? segmentNormalZ
        : -(Number(segment.x2) - Number(segment.x1)) / lengthM;
    const interpolateField = (field, t) => interpolateNumber(
        segment[`start${field}`],
        segment[`end${field}`],
        t,
    );
    const pieces = [];
    for (let part = 0; part < partCount; part++) {
        if (!isCurrent()) return null;
        if (now() - started >= .5) {
            yield { phase: 'rail-segment-split' }; started = now();
            if (!isCurrent()) return null;
        }
        const t0 = part / partCount;
        const t1 = (part + 1) / partCount;
        const pieceLengthM = lengthM * (t1 - t0);
        const x1 = interpolateNumber(segment.x1, segment.x2, t0);
        const z1 = interpolateNumber(segment.z1, segment.z2, t0);
        const x2 = interpolateNumber(segment.x1, segment.x2, t1);
        const z2 = interpolateNumber(segment.z1, segment.z2, t1);
        pieces.push({
            ...segment,
            x1, z1, x2, z2,
            cx: (x1 + x2) * 0.5,
            cz: (z1 + z2) * 0.5,
            len: pieceLengthM,
            uStart: Number(segment.uStart) + lengthM * t0,
            yStart: interpolateNumber(segment.yStart, segment.yEnd, t0),
            yEnd: interpolateNumber(segment.yStart, segment.yEnd, t1),
            relativeYStart: interpolateNumber(segment.relativeYStart, segment.relativeYEnd, t0),
            relativeYEnd: interpolateNumber(segment.relativeYStart, segment.relativeYEnd, t1),
            startJoinX: part === 0 ? segment.startJoinX : normalX,
            startJoinZ: part === 0 ? segment.startJoinZ : normalZ,
            endJoinX: part === partCount - 1 ? segment.endJoinX : normalX,
            endJoinZ: part === partCount - 1 ? segment.endJoinZ : normalZ,
            startTrackCenterOffsetsM: interpolateArray(
                segment.startTrackCenterOffsetsM,
                segment.endTrackCenterOffsetsM,
                t0,
            ),
            endTrackCenterOffsetsM: interpolateArray(
                segment.startTrackCenterOffsetsM,
                segment.endTrackCenterOffsetsM,
                t1,
            ),
            startTrackbedHalfWidthM: interpolateField('TrackbedHalfWidthM', t0),
            endTrackbedHalfWidthM: interpolateField('TrackbedHalfWidthM', t1),
            startTrackbedInnerEdgeM: interpolateField('TrackbedInnerEdgeM', t0),
            endTrackbedInnerEdgeM: interpolateField('TrackbedInnerEdgeM', t1),
            startKey: part === 0 ? segment.startKey : `${segment.sortKey}:render:${part}`,
            endKey: part === partCount - 1
                ? segment.endKey
                : `${segment.sortKey}:render:${part + 1}`,
            sortKey: `${segment.sortKey}:render:${part}`,
        });
    }
    return isCurrent() ? pieces : null;
}

export function railRenderSegmentBatches(segments, options) {
    const steps = railRenderSegmentBatchesSteps(segments, options);
    let next; do { next = steps.next(); } while (!next.done);
    return next.value;
}

export function* railRenderSegmentBatchesSteps(segments, {
    maxSegments = RAIL_RENDER_BATCH_MAX_SEGMENTS,
    maxSegmentM = RAIL_RENDER_BATCH_MAX_SEGMENT_M,
    now = () => performance.now(), isCurrent = () => true,
} = {}) {
    let started = now();
    if (!isCurrent()) return null;
    const limit = Math.max(1, Math.floor(Number(maxSegments) || 1));
    const batches = [];
    let batch = [];
    for (const segment of segments || []) {
        const pieces = yield* splitRailRenderSegmentSteps(segment, maxSegmentM, { now, isCurrent });
        if (!pieces) return null;
        for (const piece of pieces) {
            if (!isCurrent()) return null;
            batch.push(piece);
            if (batch.length >= limit) { batches.push(batch); batch = []; }
            if (now() - started >= .5) {
                yield { phase: 'rail-segment-batches' }; started = now();
                if (!isCurrent()) return null;
            }
        }
    }
    if (batch.length) batches.push(batch);
    return isCurrent() ? batches : null;
}

// Cell diffing runs in the render hook after every solved rail refresh. The
// former signature materialised ~two dozen fixed-decimal strings per chord,
// then joined and sorted those large strings; a Zagreb tram refresh spent
// 50-69 ms here even when only a few cells changed. Preserve the exact same
// six-decimal content contract in a compact two-lane integer hash. Two lanes
// keep accidental collision risk negligible while avoiding BigInt and its
// allocation cost in this hot path.
const SIGNATURE_SCALE = 1_000_000;
const UINT32_RANGE = 0x1_0000_0000;

function signatureHash() {
    return { a: 0x811c9dc5, b: 0x9e3779b9 };
}

function mixSignatureWord(hash, value) {
    const word = Number(value) >>> 0;
    hash.a = Math.imul(hash.a ^ word, 0x01000193) >>> 0;
    hash.b = Math.imul(hash.b ^ ((word + 0x9e3779b9) >>> 0), 0x85ebca6b) >>> 0;
}

function mixSignatureNumber(hash, value) {
    const numeric = finiteOrNull(value);
    if (numeric == null) {
        mixSignatureWord(hash, 0x7fc00000);
        mixSignatureWord(hash, 0);
        return;
    }
    const quantized = Math.round(numeric * SIGNATURE_SCALE);
    mixSignatureWord(hash, quantized);
    mixSignatureWord(hash, Math.floor(quantized / UINT32_RANGE));
}

function mixSignatureNumberArray(hash, values) {
    if (!Array.isArray(values)) {
        mixSignatureWord(hash, 0xffffffff);
        return;
    }
    mixSignatureWord(hash, values.length);
    for (const value of values) mixSignatureNumber(hash, value);
}

function signatureDigest(hash) {
    return `${hash.a.toString(16).padStart(8, '0')}${hash.b.toString(16).padStart(8, '0')}`;
}

// Solved render segments are immutable after their final junction lifts. Cell
// refreshes deliberately reuse the object for every chord whose rendered
// height stayed equal, so a correctness fallback that must diff the full rail
// window can reuse its numeric digest instead of hashing two dozen fields on
// thousands of unchanged chords again.
const segmentSignatureCache = new WeakMap();

function segmentSignatureDigest(segment) {
    const cached = segment && typeof segment === 'object'
        ? segmentSignatureCache.get(segment)
        : null;
    if (cached) return cached;
    const hash = signatureHash();
    for (const value of [
        segment.x1, segment.z1, segment.x2, segment.z2,
        segment.yStart, segment.yEnd,
        segment.startJoinX, segment.startJoinZ,
        segment.endJoinX, segment.endJoinZ,
        segment.gaugeM, segment.uStart, segment.len,
    ]) mixSignatureNumber(hash, value);
    mixSignatureNumberArray(hash, segment.startTrackCenterOffsetsM);
    mixSignatureNumberArray(hash, segment.endTrackCenterOffsetsM);
    mixSignatureWord(hash, segment.ownsCivilGround === true ? 1 : 0);
    mixSignatureWord(hash, segment.heavyRail === true ? 1 : 0);
    for (const value of [
        segment.startTrackbedHalfWidthM,
        segment.endTrackbedHalfWidthM,
        segment.startTrackbedInnerEdgeM,
        segment.endTrackbedInnerEdgeM,
    ]) mixSignatureNumber(hash, value);
    // Keep topology keys exact. Hashing them character-by-character in JS is
    // slower than retaining these already-compact strings, while the numeric
    // digest still removes the large fixed-decimal payload.
    const digest = `${String(segment.startKey ?? '-')}/${String(segment.endKey ?? '-')}`
        + `/${signatureDigest(hash)}`;
    if (segment && typeof segment === 'object') {
        segmentSignatureCache.set(segment, digest);
    }
    return digest;
}

function incidentSignatureDigest(incident) {
    const hash = signatureHash();
    mixSignatureNumber(hash, incident.x);
    mixSignatureNumber(hash, incident.z);
    mixSignatureNumber(hash, incident.ySeg);
    mixSignatureNumber(hash, incident.halfWidth);
    mixSignatureWord(hash, incident.ownsCivilGround === true ? 1 : 0);
    mixSignatureWord(hash, incident.heavyRail === true ? 1 : 0);
    return signatureDigest(hash);
}

export function railRenderCellCenter(key, cellM = RAIL_RENDER_CELL_M) {
    return cellCenter(key, cellM);
}

// Does any change rect (padded) touch any solved chord's AABB? This is the
// terrain-refresh gate: a terrain revision whose bounds miss every chord (and
// every formation profile, checked separately by the caller) cannot change
// anything rail renders, so the whole resolve→formation→rebuild pipeline is
// skipped. O(chords × rects) plain AABB tests, run only on terrain events.
function normalizedRailChangeBounds(bounds) {
    return (Array.isArray(bounds) ? bounds : [])
        .map((b) => b && {
            minX: finiteOrNull(b.minX),
            maxX: finiteOrNull(b.maxX),
            minZ: finiteOrNull(b.minZ),
            maxZ: finiteOrNull(b.maxZ),
        })
        .filter((b) => b
            && b.minX != null && b.maxX != null && b.minZ != null && b.maxZ != null
            && b.maxX >= b.minX && b.maxZ >= b.minZ);
}

function railSegmentIntersectsRects(segment, rects, padM) {
    if (!segment) return false;
    const minX = Math.min(segment.x1, segment.x2) - padM;
    const maxX = Math.max(segment.x1, segment.x2) + padM;
    const minZ = Math.min(segment.z1, segment.z2) - padM;
    const maxZ = Math.max(segment.z1, segment.z2) + padM;
    for (const rect of rects) {
        if (maxX >= rect.minX && minX <= rect.maxX
            && maxZ >= rect.minZ && minZ <= rect.maxZ) {
            return true;
        }
    }
    return false;
}

export function boundsIntersectAnyRailSegment(segments, bounds, padM = 0) {
    const rects = normalizedRailChangeBounds(bounds);
    if (rects.length === 0) return false;
    for (const segment of segments || []) {
        if (railSegmentIntersectsRects(segment, rects, padM)) return true;
    }
    return false;
}

// Return only solved chords whose immutable XZ footprint can consume a bounded
// streamed change. Terrain and OSM tiles never mutate after publication during
// a session; downstream height ownership can therefore be recomputed for this
// append/evict delta instead of rescanning the complete visible rail window.
export function railSegmentsIntersectingBounds(segments, bounds, padM = 0) {
    const rects = normalizedRailChangeBounds(bounds);
    if (rects.length === 0) return [];
    return (segments || []).filter(segment => (
        railSegmentIntersectsRects(segment, rects, padM)
    ));
}

export function railSegmentMidpointCellKey(segment, cellM = RAIL_RENDER_CELL_M) {
    return cellKeyAt(
        (Number(segment?.x1) + Number(segment?.x2)) / 2,
        (Number(segment?.z1) + Number(segment?.z2)) / 2,
        cellM,
    );
}

// Node-keyed junction incidents for a segment set: every chord contributes its
// two endpoints. This is the exact input the switch-throat fan builder needs;
// the unchunked embedded/structural batches consume it whole, and the cell
// partition below distributes the same entries by node position. Insertion
// order matches segment input order so the fan centre (first incident) is
// identical to the pre-partition build.
export function junctionIncidentsFromSegments(segments) {
    const incidents = new Map();
    const add = (nodeKey, incident) => {
        const list = incidents.get(nodeKey) || [];
        list.push(incident);
        incidents.set(nodeKey, list);
    };
    for (const segment of segments || []) {
        if (!segment) continue;
        add(segment.startKey, {
            x: segment.x1,
            z: segment.z1,
            ySeg: segment.yStart,
            halfWidth: segment.startTrackbedHalfWidthM,
            ownsCivilGround: segment.ownsCivilGround === true,
            heavyRail: segment.heavyRail === true,
        });
        add(segment.endKey, {
            x: segment.x2,
            z: segment.z2,
            ySeg: segment.yEnd,
            halfWidth: segment.endTrackbedHalfWidthM,
            ownsCivilGround: segment.ownsCivilGround === true,
            heavyRail: segment.heavyRail === true,
        });
    }
    return incidents;
}

// Partition solved chords into cells. Strip geometry (rail bars, bed, curbs)
// is assigned by chord midpoint. Junction fans are owned by the cell that
// contains the NODE, and the owning cell records the node's COMPLETE incident
// list — including incidents whose chords live in neighbouring cells — because
// a switch-throat fan built from half its arms is not a smaller fan, it is a
// hole.
//
// Returns Map<cellKey, { segments: [], junctionIncidents: Map<nodeKey, [
//   { x, z, ySeg, halfWidth } ]> }>.
export function partitionRailSegmentsIntoCells(
    segments,
    cellM = RAIL_RENDER_CELL_M,
    selectedKeys = null,
) {
    return drainPartition(partitionRailSegmentsIntoCellsSteps(segments, cellM, selectedKeys));
}

function drainPartition(iterator) { let step; do step = iterator.next(); while (!step.done); return step.value; }

export function* partitionRailSegmentsIntoCellsSteps(
    segments,
    cellM = RAIL_RENDER_CELL_M,
    selectedKeys = null,
    { now = () => performance.now(), isCurrent = () => true } = {},
) {
    if (!isCurrent()) return null;
    const selection = selectedKeys == null ? null : new Set(selectedKeys);
    const cells = new Map();
    const ensure = (key) => {
        let cell = cells.get(key);
        if (!cell) {
            cell = { segments: [], junctionIncidents: new Map() };
            cells.set(key, cell);
        }
        return cell;
    };
    let started = now();
    for (const segment of segments || []) {
        if (now() - started >= .5) { yield { phase: 'rail-cell-partition' }; started = now(); }
        if (!isCurrent()) return null;
        if (!segment) continue;
        const key = railSegmentMidpointCellKey(segment, cellM);
        if (!selection || selection.has(key)) ensure(key).segments.push(segment);
    }
    const allIncidents = new Map();
    const addIncident = (nodeKey, incident) => {
        if (selection) {
            // A partial vertical refresh needs complete fans only in the cells its
            // changed endpoints touch. Build those lists directly instead of
            // allocating incidents for every unchanged node in the rail window.
            const key = cellKeyAt(incident.x, incident.z, cellM);
            if (!selection.has(key)) return;
            const incidents = ensure(key).junctionIncidents.get(nodeKey) || [];
            incidents.push(incident);
            ensure(key).junctionIncidents.set(nodeKey, incidents);
        } else {
            const incidents = allIncidents.get(nodeKey) || [];
            incidents.push(incident); allIncidents.set(nodeKey, incidents);
        }
    };
    for (const segment of segments || []) {
        if (now() - started >= .5) { yield { phase: 'rail-cell-incidents' }; started = now(); }
        if (!isCurrent()) return null;
        if (!segment) continue;
        addIncident(segment.startKey, { x: segment.x1, z: segment.z1, ySeg: segment.yStart,
            halfWidth: segment.startTrackbedHalfWidthM, ownsCivilGround: segment.ownsCivilGround === true,
            heavyRail: segment.heavyRail === true });
        addIncident(segment.endKey, { x: segment.x2, z: segment.z2, ySeg: segment.yEnd,
            halfWidth: segment.endTrackbedHalfWidthM, ownsCivilGround: segment.ownsCivilGround === true,
            heavyRail: segment.heavyRail === true });
    }
    for (const [nodeKey, incidents] of allIncidents) {
        if (now() - started >= .5) { yield { phase: 'rail-cell-junction-owners' }; started = now(); }
        if (!isCurrent()) return null;
        const [first] = incidents;
        ensure(cellKeyAt(first.x, first.z, cellM)).junctionIncidents.set(nodeKey, incidents);
    }
    return isCurrent() ? cells : null;
}

function addSegmentOwnedCellKeys(keys, segment, cellM) {
    if (!segment) return;
    keys.add(railSegmentMidpointCellKey(segment, cellM));
    keys.add(cellKeyAt(Number(segment.x1), Number(segment.z1), cellM));
    keys.add(cellKeyAt(Number(segment.x2), Number(segment.z2), cellM));
}

// Every render cell whose atomic geometry can depend on one chord. The midpoint
// cell owns its strips; the endpoint cells own the complete junction fans. If
// either endpoint lacks terrain evidence, all three owners must retain their
// previous generation rather than publishing a fan with one arm missing.
export function railSegmentOwnedCellKeys(
    segment,
    cellM = RAIL_RENDER_CELL_M,
) {
    const keys = new Set();
    addSegmentOwnedCellKeys(keys, segment, cellM);
    return keys;
}

// Cells whose strip or complete junction fan can differ between two solved
// segment generations. A height-only embedded-tram refresh retains every
// other cell byte-for-byte, so hashing the whole citywide partition again is
// pure overhead. Segment sortKey is the solver's stable chord identity.
export function changedRailSegmentRenderCellKeys(
    previousSegments = [],
    nextSegments = [],
    cellM = RAIL_RENDER_CELL_M,
) {
    const byKey = (segments) => new Map((segments || []).map((segment, index) => [
        String(segment?.sortKey ?? `index:${index}`),
        segment,
    ]));
    const previous = byKey(previousSegments);
    const next = byKey(nextSegments);
    const changed = new Set();
    for (const key of new Set([...previous.keys(), ...next.keys()])) {
        const before = previous.get(key);
        const after = next.get(key);
        if (before === after) continue;
        if (before && after
            && segmentSignatureDigest(before) === segmentSignatureDigest(after)) continue;
        addSegmentOwnedCellKeys(changed, before, cellM);
        addSegmentOwnedCellKeys(changed, after, cellM);
    }
    return changed;
}

// Every field consumed by the rail-bar sweep, the bed strips, the flat curbs
// or the junction fans. Sorted so input order cannot change the signature:
// none of the mesh builders' output depends on segment order (the fan centre
// uses the first INCIDENT, whose coordinates are the node's, shared by all).
export function railRenderCellSignature(cell) {
    if (!cell) return '';
    const segmentSignatures = (cell.segments || [])
        .map(segmentSignatureDigest)
        .sort();
    const nodeSignatures = [...(cell.junctionIncidents || new Map()).entries()]
        .map(([nodeKey, incidents]) => `${String(nodeKey)}/`
            + (incidents || []).map(incidentSignatureDigest).sort().join(';'))
        .sort();
    return `${segmentSignatures.join('|')}#${nodeSignatures.join('|')}`;
}

export function railRenderCellSignatures(cells) {
    const signatures = new Map();
    for (const [key, cell] of cells || new Map()) {
        signatures.set(key, railRenderCellSignature(cell));
    }
    return signatures;
}

export function changedRailRenderCellKeys(previous = new Map(), next = new Map()) {
    const keys = new Set([...previous.keys(), ...next.keys()]);
    return [...keys].filter((key) => (previous.get(key) || '') !== (next.get(key) || ''));
}

// Intersect KNOWN cell keys with change bounds (terrain revisions, formation
// changes). Iterating existing keys — never rasterising the rectangle — keeps
// a continent-sized bounds from fabricating millions of keys. An empty or
// invalid bounds list selects nothing; callers treat "no bounds at all" as
// full invalidation separately, exactly like world/roads.js does.
export function railRenderCellKeysIntersectingBounds(cellKeys, bounds, {
    cellM = RAIL_RENDER_CELL_M,
    padM = 0,
} = {}) {
    const rects = (Array.isArray(bounds) ? bounds : [])
        .map((b) => b && {
            minX: finiteOrNull(b.minX),
            maxX: finiteOrNull(b.maxX),
            minZ: finiteOrNull(b.minZ),
            maxZ: finiteOrNull(b.maxZ),
        })
        .filter((b) => b
            && b.minX != null && b.maxX != null && b.minZ != null && b.maxZ != null
            && b.maxX >= b.minX && b.maxZ >= b.minZ);
    const selected = new Set();
    if (rects.length === 0) return selected;
    const half = cellM / 2;
    for (const key of cellKeys || []) {
        const center = cellCenter(key, cellM);
        const cellMinX = center.x - half;
        const cellMaxX = center.x + half;
        const cellMinZ = center.z - half;
        const cellMaxZ = center.z + half;
        for (const rect of rects) {
            if (cellMaxX >= rect.minX - padM
                && cellMinX <= rect.maxX + padM
                && cellMaxZ >= rect.minZ - padM
                && cellMinZ <= rect.maxZ + padM) {
                selected.add(key);
                break;
            }
        }
    }
    return selected;
}

// Rank cells by distance from the observer and split into active (must be
// built and visible) and retain (already built, kept for hysteresis). The
// half-diagonal is added to the active radius so a cell whose CENTRE sits just
// outside the radius cannot drop geometry that lies inside it — the old
// citywide mesh never popped, and per-cell meshes must not start.
export function selectRailRenderCells(cellKeys, observer, {
    activeM,
    evictM = null,
    cellM = RAIL_RENDER_CELL_M,
} = {}) {
    const halfDiagonalM = (cellM * Math.SQRT2) / 2;
    const activeBaseM = finiteOrNull(activeM) ?? 0;
    const activeRadiusM = activeBaseM + halfDiagonalM;
    const evictRadiusM = (finiteOrNull(evictM)
        ?? activeBaseM + RAIL_RENDER_CELL_EVICT_PAD_M) + halfDiagonalM;
    const observerX = finiteOrNull(observer?.x) ?? 0;
    const observerZ = finiteOrNull(observer?.z) ?? 0;
    const ranked = [...(cellKeys || [])].map((key) => {
        const center = cellCenter(key, cellM);
        return {
            key,
            distanceM: Math.hypot(center.x - observerX, center.z - observerZ),
        };
    }).sort((left, right) => (
        left.distanceM - right.distanceM || left.key.localeCompare(right.key)
    ));
    return {
        ranked,
        active: new Set(ranked
            .filter((item) => item.distanceM <= activeRadiusM)
            .map((item) => item.key)),
        retain: new Set(ranked
            .filter((item) => item.distanceM <= evictRadiusM)
            .map((item) => item.key)),
    };
}
