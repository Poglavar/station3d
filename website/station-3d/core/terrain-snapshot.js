// Structured-clone representation of immutable terrain sampling state. One
// snapshot is sent per TerrainReference revision and reconstructed in the
// render Worker; formation masks deliberately remain main-thread state.

import {
    CompositeTerrainGrid,
    MosaicTerrainGrid,
    TerrainGrid,
    TerrainReference,
} from './terrain-grid.js';

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
