// Builds a bounded CPU query matching the terrain shader's formation-cutout
// ownership, so coarse physics terrain opens only where visible ground opens.

import { pointInRingNonZero } from './mask-query.js';
import { createBoundsGridSteps } from './bounds-grid.js';
import {
    FORMATION_MAX_CUTOUT_REACH_M,
    formationTerrainCutoutMaskRegions,
} from './road-formation.js';
import { renderedRailSurfaceRegionCutsTerrain } from './rendered-rail-surface.js';

function finiteNumberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundsDistanceSquared(bounds, x, z) {
    const dx = x < bounds.minX ? bounds.minX - x
        : x > bounds.maxX ? x - bounds.maxX : 0;
    const dz = z < bounds.minZ ? bounds.minZ - z
        : z > bounds.maxZ ? z - bounds.maxZ : 0;
    return dx * dx + dz * dz;
}

function contains(grid, x, z) {
    for (const entry of grid.candidatesAt(x, z)) {
        const bounds = entry.bounds;
        if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
        if (!pointInRingNonZero(x, z, entry.ring)) continue;
        if (entry.holeRings?.some(ring => pointInRingNonZero(x, z, ring))) continue;
        if (entry.clipRings.length === 0
            || entry.clipRings.some((ring) => pointInRingNonZero(x, z, ring))) return true;
    }
    return false;
}

export function buildFormationTerrainCutoutQuery(options) {
    const steps = buildFormationTerrainCutoutQuerySteps(options);
    let next;
    do { next = steps.next(); } while (!next.done);
    return next.value;
}

export function* buildFormationTerrainCutoutQuerySteps({
    models = [],
    modelSources = [],
    receiverRegions = [],
    receiverRegionSource = null,
    centerX,
    centerZ,
    radiusM,
    terrainSceneYAtLocal = null,
    allowStale = false,
    now = () => performance.now(),
} = {}) {
    const x = finiteNumberOrNull(centerX);
    const z = finiteNumberOrNull(centerZ);
    const radius = finiteNumberOrNull(radiusM);
    if (x === null || z === null || radius === null || radius <= 0) {
        return {
            formationRingCount: 0,
            portalOpeningRingCount: 0,
            clearRingCount: 0,
            replacementRingCount: 0,
            layers: Object.freeze([]),
            contains: () => false,
        };
    }
    const radiusSquared = radius * radius;
    let deadline = now() + 0.5;
    // Detach rings as well as the profile flags that selected them. The query
    // survives yields and must not retain mutable live cutout coordinates.
    const ringCopies = new WeakMap();
    function* copyRing(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return null;
        if (ringCopies.has(ring)) return ringCopies.get(ring);
        const copy = [], bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
        for (const point of ring) {
            const px = finiteNumberOrNull(point?.x), pz = finiteNumberOrNull(point?.z);
            if (px === null || pz === null) { ringCopies.set(ring, null); return null; }
            copy.push(Object.freeze({ x: px, z: pz }));
            bounds.minX = Math.min(bounds.minX, px); bounds.maxX = Math.max(bounds.maxX, px);
            bounds.minZ = Math.min(bounds.minZ, pz); bounds.maxZ = Math.max(bounds.maxZ, pz);
            if (now() >= deadline) {
                yield { phase: 'ground-terrain-cutout-ring' };
                deadline = now() + 0.5;
            }
        }
        const result = Object.freeze({ ring: Object.freeze(copy), bounds: Object.freeze(bounds) });
        ringCopies.set(ring, result);
        return result;
    }
    function* ringEntry(ring, clipRings = [], holeRings = [], source = null) {
        const copy = yield* copyRing(ring);
        if (!copy || boundsDistanceSquared(copy.bounds, x, z) > radiusSquared) return null;
        const clips = [];
        for (const clip of clipRings) {
            const result = yield* copyRing(clip);
            if (result) clips.push(result.ring);
        }
        if (clipRings.length && !clips.length) return null;
        const holes = [];
        for (const hole of holeRings) {
            const result = yield* copyRing(hole);
            if (!result) throw new TypeError('Receiver terrain cut contains an invalid hole');
            holes.push(result.ring);
        }
        return Object.freeze({ ...copy, clipRings: Object.freeze(clips), holeRings: Object.freeze(holes),
            ...(source == null ? {} : { source: String(source) }) });
    }
    const formationRings = [];
    const portalOpeningRings = [];
    const surfaceCorrectionRings = [];
    const clearRings = [];
    const replacementRings = [];
    const finalReceiverRings = [];
    for (const [modelIndex, model] of (Array.isArray(models) ? models : []).entries()) {
        if (!model) continue;
        const source = modelSources[modelIndex] ?? null;
        const profiles = typeof model.surfaceProfilesNear === 'function'
            ? model.surfaceProfilesNear(
                x,
                z,
                radius + FORMATION_MAX_CUTOUT_REACH_M,
                { allowStale },
            )
            : model.getSurfaceProfiles?.() || [];
        for (const profile of profiles) {
            for (const region of formationTerrainCutoutMaskRegions(profile)) {
                const entry = yield* ringEntry(
                    region.ring,
                    region.clipRings,
                    [],
                    source,
                );
                if (entry) {
                    formationRings.push(entry);
                    if (region.reapplyAfterReplacementClear) {
                        surfaceCorrectionRings.push(entry);
                    }
                }
            }
            if (now() >= deadline) {
                yield { phase: 'ground-terrain-cutout-profile' };
                deadline = now() + 0.5;
            }
        }
        const surfaceRegions = typeof model.terrainSurfaceRegionsNear === 'function'
            ? model.terrainSurfaceRegionsNear(x, z, radius)
            : model.getTerrainSurfaceRegions?.() || [];
        for (const region of surfaceRegions) {
            if (now() >= deadline) {
                yield { phase: 'ground-terrain-cutout-surface' };
                deadline = now() + 0.5;
            }
            if (!renderedRailSurfaceRegionCutsTerrain(
                region,
                terrainSceneYAtLocal,
            )) continue;
            const entry = yield* ringEntry(region?.ring, [], [], source);
            if (!entry) continue;
            formationRings.push(entry);
            // Exact rendered trackbed remains final after any broad structural
            // terrain-roof restoration, matching world/terrain.js ordering.
            surfaceCorrectionRings.push(entry);
        }
        for (const region of model.getTunnelPortalTerrainOpenings?.() || []) {
            if (now() >= deadline) {
                yield { phase: 'ground-terrain-cutout-portal' };
                deadline = now() + 0.5;
            }
            const entry = yield* ringEntry(region?.ring, [], [], source);
            if (entry) {
                formationRings.push(entry);
                portalOpeningRings.push(entry);
            }
        }
        for (const region of model.getReplacementTerrainCutoutRegions?.() || []) {
            if (now() >= deadline) {
                yield { phase: 'ground-terrain-cutout-replacement' };
                deadline = now() + 0.5;
            }
            const clear = yield* ringEntry(region?.clearRing, [], [], source);
            if (clear) clearRings.push(clear);
            const replacement = yield* ringEntry(region?.cutoutRing, [], [], source);
            if (replacement) replacementRings.push(replacement);
        }
    }
    for (const region of receiverRegions) {
        const entry = yield* ringEntry(region.ring, region.clipRings || [], region.holeRings || [], receiverRegionSource);
        if (entry) finalReceiverRings.push(entry);
        yield { phase: 'ground-terrain-receiver-boundary' };
    }
    const receiverGrid = yield* createBoundsGridSteps(finalReceiverRings, { now });
    const formationGrid = yield* createBoundsGridSteps(formationRings, { now });
    const portalOpeningGrid = yield* createBoundsGridSteps(portalOpeningRings, { now });
    const surfaceCorrectionGrid = yield* createBoundsGridSteps(surfaceCorrectionRings, { now });
    const clearGrid = yield* createBoundsGridSteps(clearRings, { now });
    const replacementGrid = yield* createBoundsGridSteps(replacementRings, { now });
    return {
        formationRingCount: formationRings.length,
        portalOpeningRingCount: portalOpeningRings.length,
        clearRingCount: clearRings.length,
        replacementRingCount: replacementRings.length,
        receiverRingCount: finalReceiverRings.length,
        // Geometry and point consumers receive the same captured order. A
        // clearance restores source terrain only until a later actual opening.
        layers: Object.freeze([
            Object.freeze({ stage: 'formation', operation: 'subtract', regions: Object.freeze(formationRings) }),
            Object.freeze({ stage: 'restoration', operation: 'restore', regions: Object.freeze(clearRings) }),
            Object.freeze({ stage: 'surface-correction', operation: 'subtract', regions: Object.freeze(surfaceCorrectionRings) }),
            Object.freeze({ stage: 'portal-opening', operation: 'subtract', regions: Object.freeze(portalOpeningRings) }),
            Object.freeze({ stage: 'replacement-opening', operation: 'subtract', regions: Object.freeze(replacementRings) }),
            Object.freeze({ stage: 'receiver-opening', operation: 'subtract', regions: Object.freeze(finalReceiverRings) }),
        ]),
        contains(localX, localZ) {
            const queryX = finiteNumberOrNull(localX);
            const queryZ = finiteNumberOrNull(localZ);
            if (queryX === null || queryZ === null) return false;
            let cut = contains(formationGrid, queryX, queryZ);
            if (contains(clearGrid, queryX, queryZ)) cut = false;
            // A boxed underpass restores its terrain roof, but the upper
            // carriageway still owns its exact asphalt footprint. Match the
            // visible mask ordering so physics never restores rough terrain
            // through a firm, rendered road surface.
            if (contains(surfaceCorrectionGrid, queryX, queryZ)) cut = true;
            // Match the visible-mask order: an actual tunnel mouth remains
            // open even if another structure's broad protection ring restored
            // terrain in the same neighbourhood.
            if (contains(portalOpeningGrid, queryX, queryZ)) cut = true;
            if (contains(replacementGrid, queryX, queryZ)) cut = true;
            if (contains(receiverGrid, queryX, queryZ)) cut = true;
            return cut;
        },
    };
}

// Replace one ownership family's operands without disturbing the Boolean
// ordering shared by terrain rendering and collision. Untagged layers are
// retained for compatibility and for authored openings supplied by separate
// producers after the canonical formation stages.
export function replaceTerrainCutoutLayerSources(baseLayers, replacementLayers, sources) {
    const removed = new Set(Array.isArray(sources) ? sources.map(String) : []);
    const replacements = new Map();
    for (const layer of Array.isArray(replacementLayers) ? replacementLayers : []) {
        if (!layer?.stage || !Array.isArray(layer.regions)) continue;
        replacements.set(layer.stage, layer);
    }
    const seen = new Set(), result = [];
    for (const layer of Array.isArray(baseLayers) ? baseLayers : []) {
        if (!layer?.stage || !Array.isArray(layer.regions)) {
            result.push(layer);
            continue;
        }
        const replacement = seen.has(layer.stage) ? null : replacements.get(layer.stage);
        const regions = layer.regions.filter(region => !removed.has(String(region?.source ?? '')));
        if (replacement) {
            regions.push(...replacement.regions);
            seen.add(layer.stage);
        }
        result.push(Object.freeze({ ...layer, regions: Object.freeze(regions) }));
    }
    for (const layer of Array.isArray(replacementLayers) ? replacementLayers : []) {
        if (layer?.stage && !seen.has(layer.stage)) result.push(layer);
    }
    return Object.freeze(result);
}

export function triangleTouchesTerrainCutout(query, a, b, c) {
    if (typeof query?.contains !== 'function') return false;
    const samples = [
        a,
        b,
        c,
        { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 },
        { x: (b.x + c.x) * 0.5, z: (b.z + c.z) * 0.5 },
        { x: (c.x + a.x) * 0.5, z: (c.z + a.z) * 0.5 },
        { x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 },
    ];
    return samples.some(point => query.contains(point.x, point.z));
}

// Conservative sampling heuristic pending the shared topology-preserving
// receiver compiler: seven inside samples do not prove triangle containment.
// A narrow opening or protected island can fall between samples. Keep this
// limitation explicit; additional probes cannot establish exact cut topology.
export function triangleInsideTerrainCutout(query, a, b, c) {
    if (typeof query?.contains !== 'function') return false;
    const samples = [
        a,
        b,
        c,
        { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 },
        { x: (b.x + c.x) * 0.5, z: (b.z + c.z) * 0.5 },
        { x: (c.x + a.x) * 0.5, z: (c.z + a.z) * 0.5 },
        { x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 },
    ];
    return samples.every(point => query.contains(point.x, point.z));
}
