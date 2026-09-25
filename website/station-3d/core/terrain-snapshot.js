// Structured-clone representation of immutable terrain sampling state. One
// snapshot is sent per TerrainReference revision and reconstructed in the
// render Worker; formation masks deliberately remain main-thread state.

import {
    CompositeTerrainGrid,
    MosaicTerrainGrid,
    TerrainGrid,
    TerrainReference,
} from './terrain-grid.js';

import { createGroundChangeSet } from './ground-read-evidence.js';

export const TERRAIN_SNAPSHOT_SCHEMA_VERSION = 2;
export const TERRAIN_SNAPSHOT_VALUES_PER_STEP = 16384;

function clonePlain(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function* copyTypedBufferSteps(values, Type) {
    // Allocation remains one atomic operation; copying/touching a large source
    // does not. Live terrain buffers are immutable and are never transferred.
    const copy = new Type(values.length);
    yield { phase: 'snapshot-allocate' };
    for (let offset = 0; offset < values.length; offset += TERRAIN_SNAPSHOT_VALUES_PER_STEP) {
        const end = Math.min(values.length, offset + TERRAIN_SNAPSHOT_VALUES_PER_STEP);
        copy.set(values.subarray(offset, end), offset);
        yield { phase: 'snapshot-copy', copiedValues: end - offset };
    }
    return copy.buffer;
}

function* serializeTerrainGridSteps(grid) {
    // A hierarchy visit is also a step, so many small grids cannot turn the
    // final visit into an unbounded descriptor/array walk.
    yield { phase: 'snapshot-grid' };
    if (grid instanceof TerrainGrid) {
        return {
            kind: 'grid',
            metadata: clonePlain(grid.metadata),
            values: yield* copyTypedBufferSteps(grid.values, Uint16Array),
            sourceValues: grid.sourceValues
                ? yield* copyTypedBufferSteps(grid.sourceValues, Uint8Array)
                : null,
        };
    }
    if (grid instanceof MosaicTerrainGrid) {
        const items = [];
        for (const item of grid.items) {
            items.push({
                key: item.key,
                coreBounds: clonePlain(item.coreBounds),
                grid: yield* serializeTerrainGridSteps(item.grid),
            });
        }
        return { kind: 'mosaic', items };
    }
    if (grid instanceof CompositeTerrainGrid) {
        const base = yield* serializeTerrainGridSteps(grid.base);
        const details = [];
        for (const gridDetail of grid.details) details.push(yield* serializeTerrainGridSteps(gridDetail));
        return {
            kind: 'composite',
            base,
            details,
            options: {
                blendMarginM: grid.blendMarginM,
                sourceBlendMarginM: grid.sourceBlendMarginM,
            },
        };
    }
    throw new TypeError('Unsupported terrain grid snapshot source');
}

function drain(iterator) {
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
}

export function serializeTerrainGrid(grid) {
    return drain(serializeTerrainGridSteps(grid));
}

export function deserializeTerrainGrid(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        throw new TypeError('Terrain grid snapshot is required');
    }
    if (snapshot.kind === 'grid') {
        return new TerrainGrid(snapshot.metadata, snapshot.values, {
            sourceArrayBuffer: snapshot.sourceValues,
        });
    }
    if (snapshot.kind === 'mosaic') {
        return new MosaicTerrainGrid((snapshot.items || []).map(item => ({
            key: item.key,
            coreBounds: item.coreBounds,
            grid: deserializeTerrainGrid(item.grid),
        })));
    }
    if (snapshot.kind === 'composite') {
        return new CompositeTerrainGrid(
            deserializeTerrainGrid(snapshot.base),
            (snapshot.details || []).map(deserializeTerrainGrid),
            snapshot.options || {},
        );
    }
    throw new Error(`Unsupported terrain grid snapshot kind: ${snapshot.kind}`);
}

export function captureTerrainSnapshotSource(reference) {
    if (!(reference instanceof TerrainReference)) {
        throw new TypeError('TerrainReference is required');
    }
    return {
        schemaVersion: TERRAIN_SNAPSHOT_SCHEMA_VERSION,
        revision: Number(reference.revision) || 0,
        // Replacements publish a new grid wrapper; the old grids and their
        // samples remain immutable. Capture that revision before any yield.
        grid: reference.grid,
        anchorLon: reference.anchorLon,
        anchorLat: reference.anchorLat,
        // A streamed detail grid may report a different height at the session
        // anchor. The live reference deliberately keeps the original datum so
        // every already-published world layer remains in one scene frame; the
        // Worker must use that same datum rather than deriving a new one from
        // the replacement grid.
        anchorHeightM: reference.anchorHeightM,
        fallbackHeightM: reference.fallbackHeightM,
        surfaceStepM: reference.surfaceStepM,
        detail: clonePlain(reference.detail),
    };
}

const READ_METHODS = [
    'heightAt', 'absoluteToSceneY', 'sourceSceneYAt', 'sourceSceneYAtLocal',
    'sceneYAt', 'sceneYAtLocal', 'evidenceSceneYAt', 'evidenceSceneYAtLocal',
    'hasLoadedCoreCoverageAt', 'hasLoadedCoreCoverageAtLocal', 'lonLatAtLocal',
    'hasEvidenceAtLocal', 'evidenceReadyForLocalPoints', 'evidenceWithheldAtLocal',
    'sampleStepMAtLocal', 'sampleStepMForBounds', 'isFineTile', 'normalAtLocal', 'evidenceNormalAtLocal',
    'slopeAlongHeadingDeg', 'evidenceSlopeAlongHeadingDeg',
    'foundationSceneY', 'evidenceFoundationSceneY',
];

function freezePlain(value) {
    if (!value || typeof value !== 'object') return value;
    for (const child of Object.values(value)) freezePlain(child);
    return Object.freeze(value);
}

// A same-thread build candidate shares immutable decoded buffers, but never
// shares the live reference's mutable sampler caches, detail rects or datum.
// Keep the sampler private: exposing a TerrainReference would let a builder
// replace its grid or attach an evolving formation to an alleged snapshot.
// `source` feeds the existing cooperative Worker serializer; no second format.
export function captureTerrainReadSnapshot(reference) {
    const source = captureTerrainSnapshotSource(reference);
    source.detail = freezePlain(source.detail);
    Object.freeze(source);
    const sampler = new TerrainReference(source.grid, source.anchorLon, source.anchorLat, {
        fallbackHeightM: source.fallbackHeightM,
        surfaceStepM: source.surfaceStepM,
        detail: source.detail,
    });
    sampler.anchorHeightM = source.anchorHeightM;
    sampler.revision = source.revision;
    sampler.setPendingDetailWindow(reference.pendingDetailWindow);
    const snapshot = {
        contract: 'station3d-terrain-read-snapshot-v1',
        source,
        revision: source.revision,
        anchorLon: source.anchorLon,
        anchorLat: source.anchorLat,
        anchorHeightM: source.anchorHeightM,
        fallbackHeightM: source.fallbackHeightM,
        metresPerDegreeLon: sampler.metresPerDegreeLon,
        metresPerDegreeLat: sampler.metresPerDegreeLat,
        surfaceStepM: sampler.surfaceStepM,
        detail: freezePlain(clonePlain(sampler.detail)),
        pendingDetailWindow: freezePlain(clonePlain(sampler.pendingDetailWindow)),
    };
    for (const name of READ_METHODS) snapshot[name] = sampler[name].bind(sampler);
    return Object.freeze(snapshot);
}

// Geometry builders accept both the streamed DTM and immutable published
// triangle packs. A non-DTM provider must explicitly implement capture; merely
// binding its current methods would preserve callbacks into changing state.
export function captureGroundReadSnapshot(reference, owner) {
    if (reference instanceof TerrainReference) return captureTerrainReadSnapshot(reference);
    const snapshot = reference?.captureReadSnapshot?.(owner);
    if (!snapshot || !Object.isFrozen(snapshot)
        || snapshot.contract !== 'station3d-ground-read-snapshot-v1'
        || typeof snapshot.evidenceSceneYAtLocal !== 'function'
        || typeof snapshot.absoluteToSceneY !== 'function') {
        throw new TypeError('Ground provider must capture an immutable query snapshot');
    }
    return snapshot;
}

export function* serializeTerrainSnapshotSteps(source) {
    return { ...source, grid: yield* serializeTerrainGridSteps(source.grid) };
}

export function serializeTerrainReference(reference) {
    // Explicit offline/test callers drain the very same implementation.
    return drain(serializeTerrainSnapshotSteps(captureTerrainSnapshotSource(reference)));
}

export function deserializeTerrainReference(snapshot) {
    if (snapshot?.schemaVersion !== TERRAIN_SNAPSHOT_SCHEMA_VERSION) {
        throw new Error(
            `Unsupported terrain snapshot schema: ${snapshot?.schemaVersion ?? 'missing'}`,
        );
    }
    const reference = new TerrainReference(
        deserializeTerrainGrid(snapshot.grid),
        snapshot.anchorLon,
        snapshot.anchorLat,
        {
            fallbackHeightM: snapshot.fallbackHeightM,
            surfaceStepM: snapshot.surfaceStepM,
            detail: snapshot.detail,
        },
    );
    const anchorHeightM = Number(snapshot.anchorHeightM);
    if (!Number.isFinite(anchorHeightM)) {
        throw new Error('Terrain snapshot requires a finite session anchor height');
    }
    reference.anchorHeightM = anchorHeightM;
    reference.revision = Number(snapshot.revision) || 0;
    return reference;
}

function collectBuffers(value, output, seen) {
    if (value instanceof ArrayBuffer) {
        if (!seen.has(value)) {
            seen.add(value);
            output.push(value);
        }
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
        collectBuffers(child, output, seen);
    }
}

export function terrainSnapshotTransferables(snapshot) {
    const buffers = [];
    collectBuffers(snapshot, buffers, new Set());
    return buffers;
}

// Geographic extent of any grid in the hierarchy, or null for an unknown kind.
function terrainGridExtent(grid) {
    if (grid instanceof TerrainGrid) return { west: grid.west, east: grid.east, south: grid.south, north: grid.north };
    const parts = grid instanceof MosaicTerrainGrid ? grid.grids
        : grid instanceof CompositeTerrainGrid ? [grid.base, ...grid.details] : null;
    if (!parts) return null;
    let extent = null;
    for (const part of parts) {
        const next = terrainGridExtent(part);
        if (!next) return null;
        extent = extent ? { west: Math.min(extent.west, next.west), east: Math.max(extent.east, next.east),
            south: Math.min(extent.south, next.south), north: Math.max(extent.north, next.north) } : next;
    }
    return extent;
}

const sameBounds = (a, b) => a === b || (!!a && !!b
    && ['west', 'east', 'south', 'north'].every(key => Number(a[key]) === Number(b[key])));
const sameRect = (a, b) => a === b || (!!a && !!b
    && ['minX', 'minZ', 'maxX', 'maxZ'].every(key => Number(a[key]) === Number(b[key])));

// Collects the extents of every grid whose samples can differ between two
// hierarchies, each with the margin by which its change reaches neighbours.
// Returns false when the structures cannot be compared.
function collectTerrainGridChanges(before, after, changed, marginM) {
    if (before === after) return true;
    // Outside its details a composite samples exactly like its base, so a
    // detail layer appearing over (or leaving) an unchanged base changes only
    // the details' extents.
    if ((before instanceof CompositeTerrainGrid) !== (after instanceof CompositeTerrainGrid)) {
        const composite = before instanceof CompositeTerrainGrid ? before : after;
        const plain = composite === before ? after : before;
        const baseMargin = Math.max(marginM, composite.sourceBlendMarginM + 8);
        if (!collectTerrainGridChanges(composite === before ? composite.base : plain,
            composite === before ? plain : composite.base, changed, baseMargin)) return false;
        for (const detail of composite.details) changed.push([detail, marginM]);
        return true;
    }
    if (before instanceof CompositeTerrainGrid && after instanceof CompositeTerrainGrid
        && before.blendMarginM === after.blendMarginM && before.sourceBlendMarginM === after.sourceBlendMarginM) {
        // Detail source-boundary corrections sample the base up to the source
        // blend band (plus the correction radius) inside a detail.
        const baseMargin = Math.max(marginM, before.sourceBlendMarginM + 8);
        if (!collectTerrainGridChanges(before.base, after.base, changed, baseMargin)) return false;
        const start = changed.length;
        const kept = new Set(after.details);
        for (const detail of before.details) if (!kept.has(detail)) changed.push([detail, marginM]);
        const old = new Set(before.details);
        for (const detail of after.details) if (!old.has(detail)) changed.push([detail, marginM]);
        // Among overlapping details the order decides nothing but ties; any
        // reorder of the same set is treated as a change of every member.
        if (changed.length === start && before.details.some((detail, index) => after.details[index] !== detail)) {
            for (const detail of after.details) changed.push([detail, marginM]);
        }
        return true;
    }
    if (before instanceof MosaicTerrainGrid && after instanceof MosaicTerrainGrid) {
        const byKey = items => new Map(items.map(item => [item.key, item]));
        const a = byKey(before.items), b = byKey(after.items);
        for (const key of new Set([...a.keys(), ...b.keys()])) {
            const left = a.get(key), right = b.get(key);
            if (left && right && left.grid === right.grid && sameBounds(left.coreBounds, right.coreBounds)) continue;
            if (left) changed.push([left.grid, marginM]);
            if (right) changed.push([right.grid, marginM]);
        }
        return true;
    }
    changed.push([before, marginM], [after, marginM]);
    return true;
}

// Complete change set between two captured terrain read snapshots, in local
// metres: every grid whose samples can differ, detail-rect and pending-window
// changes, and full for datum or lattice changes. Receivers record the points
// they sampled (see TerrainReference) and are compared with it.
export function terrainReadChanges(previous, next) {
    if (previous === next) return createGroundChangeSet();
    const a = previous?.source, b = next?.source;
    if (!a || !b) return createGroundChangeSet({ full: true, reason: 'terrain-provider' });
    if (a.anchorLon !== b.anchorLon || a.anchorLat !== b.anchorLat || a.anchorHeightM !== b.anchorHeightM
        || a.fallbackHeightM !== b.fallbackHeightM || a.surfaceStepM !== b.surfaceStepM
        // A fine lattice appearing or disappearing is bounded by its rects
        // (compared below); only a different lattice on both sides is global.
        || (previous.detail && next.detail
            && (previous.detail.stepM !== next.detail.stepM || previous.detail.tileM !== next.detail.tileM))) {
        return createGroundChangeSet({ full: true, reason: 'terrain-datum' });
    }
    const toLocal = ({ west, east, south, north }, marginM) => ({
        minX: (west - a.anchorLon) * previous.metresPerDegreeLon - marginM,
        maxX: (east - a.anchorLon) * previous.metresPerDegreeLon + marginM,
        minZ: -(north - a.anchorLat) * previous.metresPerDegreeLat - marginM,
        maxZ: -(south - a.anchorLat) * previous.metresPerDegreeLat + marginM,
    });
    const boxes = [];
    const changed = [];
    // One coarse step covers the planar corner a sample interpolates from.
    const margin = (Number(a.surfaceStepM) || 0) + 1;
    if (!collectTerrainGridChanges(a.grid, b.grid, changed, margin)) {
        return createGroundChangeSet({ full: true, reason: 'terrain-structure' });
    }
    for (const [grid, marginM] of changed) {
        const extent = terrainGridExtent(grid);
        if (!extent) return createGroundChangeSet({ full: true, reason: 'terrain-structure' });
        boxes.push(toLocal(extent, marginM));
    }
    const rectsBefore = previous.detail?.rects || [], rectsAfter = next.detail?.rects || [];
    for (const [rects, others] of [[rectsBefore, rectsAfter], [rectsAfter, rectsBefore]]) {
        for (const rect of rects) if (!others.some(other => sameRect(rect, other))) {
            boxes.push({ minX: rect.minX - margin, minZ: rect.minZ - margin, maxX: rect.maxX + margin, maxZ: rect.maxZ + margin });
        }
    }
    if (!sameRect(previous.pendingDetailWindow, next.pendingDetailWindow)) {
        for (const rect of [previous.pendingDetailWindow, next.pendingDetailWindow]) if (rect) boxes.push({ ...rect });
    }
    return createGroundChangeSet({ boxes });
}
