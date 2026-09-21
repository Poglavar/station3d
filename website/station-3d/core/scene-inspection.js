// Shared metadata, visibility, and report helpers for the Station3D scene
// inspector. Producers mark the objects they own here so diagnostics can name
// and temporarily hide layers without coupling the inspector to every module.

import { ownerRangeForFace } from './geometry-batch.js';

const META_KEY = 'station3dInspectionLayer';
const PREVIOUS_VISIBLE_KEY = 'station3dInspectionPreviousVisible';
const hiddenLayerIds = new Set();
const visibilityTouchedObjects = new Set();
const inspectionVisibilityListeners = new Set();
export const INSPECTION_COPY_SCHEMA = 'station3d-inspection-chat-v1';
export const INSPECTION_COPY_MAX_CHARACTERS = 60_000;
const INSPECTION_COPY_MAX_HITS = 12;
const INSPECTION_COPY_MAX_PUBLICATIONS = 24;

function notifyInspectionVisibilityChanged() {
    const hiddenIds = Object.freeze([...hiddenLayerIds]);
    for (const listener of inspectionVisibilityListeners) listener(hiddenIds);
}

export function subscribeInspectionLayerVisibility(listener) {
    if (typeof listener !== 'function') throw new TypeError('Inspection visibility listener must be a function');
    inspectionVisibilityListeners.add(listener);
    return () => inspectionVisibilityListeners.delete(listener);
}

// Retired streamed roots must not be retained by diagnostic visibility state.
// Keep the category choice so the replacement inherits it when annotated.
export function releaseInspectionLayerObjects(root) {
    root?.traverse?.(object => restoreInspectionObject(object));
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

// A floating render origin translates the scene root only for drawing. Three's
// cached matrixWorld values remain translated until the next render update, so
// an event-time raycast reports render-relative X/Z even though every terrain,
// road, and geodetic query expects absolute session-local metres.
export function absoluteInspectionPoint(point, renderOrigin = null) {
    const x = typeof point?.x === 'number' && Number.isFinite(point.x) ? point.x : null;
    const z = typeof point?.z === 'number' && Number.isFinite(point.z) ? point.z : null;
    if (x === null || z === null) return null;
    const originX = typeof renderOrigin?.x === 'number' && Number.isFinite(renderOrigin.x)
        ? renderOrigin.x
        : 0;
    const originZ = typeof renderOrigin?.z === 'number' && Number.isFinite(renderOrigin.z)
        ? renderOrigin.z
        : 0;
    return {
        x: x + originX,
        y: typeof point?.y === 'number' && Number.isFinite(point.y) ? point.y : null,
        z: z + originZ,
    };
}

function normalizedMetadata(spec = {}) {
    const id = String(spec.id || '').trim();
    if (!id) throw new Error('Inspection layers require a stable id');
    const order = finiteNumber(spec.order);
    return {
        id,
        label: String(spec.label || id).trim() || id,
        source: String(spec.source || 'unregistered producer').trim(),
        category: String(spec.category || 'Other').trim(),
        description: String(spec.description || '').trim(),
        order: order ?? 1000,
        containerOnly: spec.containerOnly === true,
    };
}

function ownMetadata(object) {
    return object?.userData?.[META_KEY] || null;
}

function nearestMetadataAncestor(object) {
    for (let node = object?.parent; node; node = node.parent) {
        const metadata = ownMetadata(node);
        if (metadata) return metadata;
    }
    return null;
}

function hideInspectionObject(object) {
    if (!object?.userData) return;
    if (!Object.prototype.hasOwnProperty.call(object.userData, PREVIOUS_VISIBLE_KEY)) {
        object.userData[PREVIOUS_VISIBLE_KEY] = object.visible !== false;
    }
    visibilityTouchedObjects.add(object);
    object.visible = false;
}

function restoreInspectionObject(object) {
    if (!object?.userData
        || !Object.prototype.hasOwnProperty.call(object.userData, PREVIOUS_VISIBLE_KEY)) return;
    object.visible = object.userData[PREVIOUS_VISIBLE_KEY] !== false;
    delete object.userData[PREVIOUS_VISIBLE_KEY];
    visibilityTouchedObjects.delete(object);
}

export function markInspectionLayer(object, spec) {
    if (!object) return object;
    object.userData ||= {};
    object.userData[META_KEY] = normalizedMetadata({
        ...(object.userData[META_KEY] || {}),
        ...(spec || {}),
    });
    if (hiddenLayerIds.has(object.userData[META_KEY].id)) hideInspectionObject(object);
    return object;
}

export function inspectionLayerForObject(object) {
    for (let node = object; node; node = node.parent) {
        const metadata = ownMetadata(node);
        if (metadata) return { ...metadata, root: node };
    }
    return null;
}

export function isInspectionOverlay(object) {
    return !!(object?.userData?.station3dInspectorOverlay
        || object?.userData?.entityHighlightOverlay
        || object?.userData?.terrainInspectionOverlay);
}

export function isEffectivelyVisible(object) {
    for (let node = object; node; node = node.parent) {
        if (node.visible === false) return false;
    }
    return true;
}

function hasRenderableDescendant(root) {
    let found = false;
    root?.traverse?.((object) => {
        if (!found && !isInspectionOverlay(object)
            && (object?.isMesh || object?.isLine || object?.isPoints)) found = true;
    });
    return found;
}

// Legacy and one-off scene roots remain inspectable even before their producer
// adopts explicit metadata. Naming these as unregistered is deliberate: the
// panel still works and also tells us exactly where ownership metadata is due.
export function markUnregisteredSceneRoots(scene) {
    for (const child of scene?.children || []) {
        if (ownMetadata(child) || isInspectionOverlay(child) || !hasRenderableDescendant(child)) continue;
        const label = String(child.name || child.type || 'Scene object').trim();
        markInspectionLayer(child, {
            id: `unregistered:${child.uuid || child.id || label}`,
            label,
            source: 'unregistered scene root',
            category: 'Unregistered',
            order: 9000,
        });
    }
}

export function collectInspectionLayers(scene) {
    markUnregisteredSceneRoots(scene);
    const byId = new Map();
    scene?.traverse?.((object) => {
        const metadata = ownMetadata(object);
        if (!metadata || metadata.containerOnly || isInspectionOverlay(object)) return;
        if (nearestMetadataAncestor(object)?.id === metadata.id) return;
        let entry = byId.get(metadata.id);
        if (!entry) {
            entry = { ...metadata, objects: [] };
            byId.set(metadata.id, entry);
        }
        entry.objects.push(object);
    });
    return Array.from(byId.values(), entry => ({
        ...entry,
        enabled: !hiddenLayerIds.has(entry.id),
        objectCount: entry.objects.length,
        visibleObjectCount: entry.objects.filter(isEffectivelyVisible).length,
    })).sort((a, b) => (
        a.order - b.order
        || a.category.localeCompare(b.category)
        || a.label.localeCompare(b.label)
    ));
}

// Keep topic shaping outside the DOM layer so bulk-toggle state and ordering
// remain deterministic and cheap to test. Producer categories are the public
// topic contract; new categories automatically become new inspector groups.
export function groupInspectionLayers(layers) {
    const byCategory = new Map();
    for (const layer of layers || []) {
        if (!layer) continue;
        const category = String(layer.category || 'Other').trim() || 'Other';
        let topic = byCategory.get(category);
        if (!topic) {
            topic = { category, layers: [] };
            byCategory.set(category, topic);
        }
        topic.layers.push(layer);
    }
    return Array.from(byCategory.values(), topic => {
        const enabledCount = topic.layers.filter(layer => layer.enabled !== false).length;
        return {
            ...topic,
            enabledCount,
            allEnabled: enabledCount === topic.layers.length,
            partiallyEnabled: enabledCount > 0 && enabledCount < topic.layers.length,
        };
    });
}

export function setInspectionLayerVisible(scene, layerId, visible) {
    const id = String(layerId || '');
    if (!id) return 0;
    const wasHidden = hiddenLayerIds.has(id);
    if (visible) hiddenLayerIds.delete(id);
    else hiddenLayerIds.add(id);
    const targets = new Set();
    scene?.traverse?.((object) => {
        if (ownMetadata(object)?.id !== id) return;
        targets.add(object);
    });
    for (const object of visibilityTouchedObjects) {
        if (ownMetadata(object)?.id === id) targets.add(object);
    }
    for (const object of targets) {
        if (visible) restoreInspectionObject(object);
        else hideInspectionObject(object);
    }
    if (wasHidden !== hiddenLayerIds.has(id)) notifyInspectionVisibilityChanged();
    return targets.size;
}

export function setInspectionLayersVisible(scene, layerIds, visible) {
    const ids = new Set(Array.from(layerIds || [], id => String(id || '')).filter(Boolean));
    if (ids.size === 0) return 0;
    const previous = new Set(hiddenLayerIds);
    for (const id of ids) {
        if (visible) hiddenLayerIds.delete(id);
        else hiddenLayerIds.add(id);
    }
    // A topic may contain many layers in a very large streamed world. Traverse
    // it once for the whole bulk operation, not once per layer checkbox.
    const targets = new Set();
    scene?.traverse?.((object) => {
        if (ids.has(ownMetadata(object)?.id)) targets.add(object);
    });
    for (const object of visibilityTouchedObjects) {
        if (ids.has(ownMetadata(object)?.id)) targets.add(object);
    }
    for (const object of targets) {
        if (visible) restoreInspectionObject(object);
        else hideInspectionObject(object);
    }
    let changed = previous.size !== hiddenLayerIds.size;
    if (!changed) for (const id of previous) {
        if (!hiddenLayerIds.has(id)) { changed = true; break; }
    }
    if (changed) notifyInspectionVisibilityChanged();
    return targets.size;
}

export function resetInspectionLayerVisibility(_scene) {
    const changed = hiddenLayerIds.size > 0;
    hiddenLayerIds.clear();
    const targets = [...visibilityTouchedObjects];
    for (const object of targets) {
        restoreInspectionObject(object);
    }
    if (changed) notifyInspectionVisibilityChanged();
    return targets.length;
}

// Render-loop enforcement is O(number of objects hidden by the inspector), not
// O(scene size). It prevents an unrelated producer visibility refresh (photo
// reveal, proposal display toggle, streamed LOD swap) from defeating a checked-
// off diagnostic layer while the panel is open.
export function enforceInspectionLayerVisibility() {
    let enforced = 0;
    for (const object of visibilityTouchedObjects) {
        if (!hiddenLayerIds.has(ownMetadata(object)?.id) || object.visible === false) continue;
        // The producer requested visibility while diagnostics suppressed it;
        // restore that latest legitimate state when the layer is re-enabled.
        object.userData[PREVIOUS_VISIBLE_KEY] = true;
        object.visible = false;
        enforced += 1;
    }
    return enforced;
}

export function hiddenInspectionLayerIds() {
    return new Set(hiddenLayerIds);
}

function hitObjectKey(hit) {
    const object = hit?.object;
    const objectKey = object?.uuid ?? object?.id ?? object?.name ?? 'unknown';
    const batchKey = Number.isInteger(hit?.batchId) ? `b${hit.batchId}` : '';
    const instanceKey = Number.isInteger(hit?.instanceId) ? `i${hit.instanceId}` : '';
    const range = ownerRangeForFace(object?.userData?.entityRanges, hit?.faceIndex);
    const ownerKey = range?.key == null ? '' : `o${String(range.key)}`;
    const materialKey = Number.isInteger(hit?.face?.materialIndex)
        ? `m${hit.face.materialIndex}`
        : '';
    return `${objectKey}:${batchKey}:${instanceKey}:${ownerKey}:${materialKey}`;
}

export function distinctInspectionHits(hits, {
    measure = 'distance',
    epsilonM = 0.015,
    includeHidden = false,
} = {}) {
    const accepted = [];
    const acceptedMeasurements = [];
    for (const hit of hits || []) {
        if (!hit?.object || isInspectionOverlay(hit.object)) continue;
        if (!includeHidden && !isEffectivelyVisible(hit.object)) continue;
        const measurement = measure === 'height'
            ? finiteNumber(hit.point?.y)
            : finiteNumber(hit.distance);
        if (measurement === null) continue;
        const key = hitObjectKey(hit);
        const duplicate = acceptedMeasurements.some(candidate => (
            candidate.key === key
            && Math.abs(candidate.measurement - measurement) <= epsilonM
        ));
        if (duplicate) continue;
        accepted.push(hit);
        acceptedMeasurements.push({ key, measurement });
    }
    return accepted;
}

function summarizeValue(value, depth, ancestors) {
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (ArrayBuffer.isView(value)) return `[${value.constructor?.name || 'TypedArray'} ${value.length}]`;
    if (Array.isArray(value)) {
        if (ancestors.has(value)) return '[circular Array]';
        if (depth <= 0) return `[array ${value.length}]`;
        ancestors.add(value);
        const output = value.slice(0, 24).map(item => summarizeValue(item, depth - 1, ancestors));
        ancestors.delete(value);
        return output;
    }
    if (value instanceof Map) return `[Map ${value.size}]`;
    if (value instanceof Set) return `[Set ${value.size}]`;
    if (value?.isObject3D) return `[${value.type || 'Object3D'} ${value.name || value.uuid || ''}]`;
    if (typeof value === 'object') {
        if (ancestors.has(value)) return `[circular ${value.constructor?.name || 'Object'}]`;
        if (depth <= 0) return `[${value.constructor?.name || 'Object'}]`;
        ancestors.add(value);
        const output = {};
        for (const key of Object.keys(value).slice(0, 32)) {
            if (key === META_KEY || key === PREVIOUS_VISIBLE_KEY) continue;
            output[key] = summarizeValue(value[key], depth - 1, ancestors);
        }
        ancestors.delete(value);
        return output;
    }
    return String(value);
}

export function summarizeInspectionUserData(userData) {
    return summarizeValue(userData || {}, 2, new WeakSet());
}

function boundedCopyString(value, maxLength = 1_000) {
    const text = String(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}… [${text.length - maxLength} chars omitted]`;
}

function compactCopyValue(value, depth = 5, ancestors = new WeakSet()) {
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return boundedCopyString(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value !== 'object') return boundedCopyString(value);
    if (ancestors.has(value)) return '[circular]';
    if (depth <= 0) return Array.isArray(value)
        ? `[array ${value.length}]`
        : '[Object]';
    ancestors.add(value);
    if (Array.isArray(value)) {
        const output = value.slice(0, 24).map(item => (
            compactCopyValue(item, depth - 1, ancestors)
        ));
        if (value.length > output.length) {
            output.push(`[${value.length - output.length} items omitted]`);
        }
        ancestors.delete(value);
        return output;
    }
    const output = {};
    const entries = Object.entries(value).slice(0, 40);
    for (const [key, item] of entries) {
        if (item === undefined) continue;
        output[key] = compactCopyValue(item, depth - 1, ancestors);
    }
    if (Object.keys(value).length > entries.length) {
        output.__omittedKeys = Object.keys(value).length - entries.length;
    }
    ancestors.delete(value);
    return output;
}

function compactInspectionHit(hit, {
    includeMetadata = true,
    includeDiagnostics = true,
} = {}) {
    if (!hit) return null;
    const material = hit.material ? {
        type: hit.material.type ?? null,
        name: hit.material.name ?? null,
        color: hit.material.color ?? null,
        map: hit.material.map ?? null,
        opacity: hit.material.opacity ?? null,
        transparent: hit.material.transparent === true,
        visible: hit.material.visible !== false,
        colorWrite: hit.material.colorWrite !== false,
        depthTest: hit.material.depthTest !== false,
        depthWrite: hit.material.depthWrite !== false,
        stencilWrite: hit.material.stencilWrite === true,
        surfaceRenderContract: hit.material.surfaceRenderContract ? {
            stencilMode: hit.material.surfaceRenderContract.stencilMode ?? null,
            groundRemovalChannels:
                hit.material.surfaceRenderContract.groundRemovalChannels ?? null,
            plannerCutoutMode: hit.material.surfaceRenderContract.plannerCutoutMode ?? null,
            groundHoleTarget: hit.material.surfaceRenderContract.groundHoleTarget === true,
            urbanGroundEligible:
                hit.material.surfaceRenderContract.urbanGroundEligible === true,
            disabledReason: hit.material.surfaceRenderContract.disabledReason ?? null,
        } : null,
        surfaceStencilContract: hit.material.surfaceStencilContract ? {
            enabled: hit.material.surfaceStencilContract.enabled === true,
            ref: hit.material.surfaceStencilContract.ref ?? null,
            funcMask: hit.material.surfaceStencilContract.funcMask ?? null,
            writeMask: hit.material.surfaceStencilContract.writeMask ?? null,
            compare: hit.material.surfaceStencilContract.compare ?? null,
            zPass: hit.material.surfaceStencilContract.zPass ?? null,
        } : null,
        shaderHooks: hit.material.shaderHooks ? {
            groundRemovalChannels: hit.material.shaderHooks.groundRemovalChannels,
            groundHoleMask: hit.material.shaderHooks.groundHoleMask,
            groundWaterMask: hit.material.shaderHooks.groundWaterMask,
            plannerSurfaceCutout: hit.material.shaderHooks.plannerSurfaceCutout,
            corridorPatched: hit.material.shaderHooks.corridorPatched,
            urbanGroundSurface: hit.material.shaderHooks.urbanGroundSurface,
        } : null,
        polygonOffset: hit.material.polygonOffset ?? null,
    } : null;
    return compactCopyValue({
        index: hit.index ?? null,
        layer: hit.layer ? {
            id: hit.layer.id ?? null,
            label: hit.layer.label ?? null,
            category: hit.layer.category ?? null,
            source: hit.layer.source ?? null,
        } : null,
        object: hit.object ? {
            name: hit.object.name ?? null,
            type: hit.object.type ?? null,
            path: hit.object.path ?? null,
            visible: hit.object.visible !== false,
            renderOrder: hit.object.renderOrder ?? null,
        } : null,
        feature: hit.feature ? {
            key: hit.feature.key ?? null,
            objectId: hit.feature.objectId ?? null,
            batchId: hit.feature.batchId ?? null,
            instanceId: hit.feature.instanceId ?? null,
            metadata: includeMetadata ? hit.feature.metadata ?? null : undefined,
        } : null,
        surface: hit.surface ?? null,
        roadVerticalAlignment: hit.roadVerticalAlignment ?? null,
        material,
        surfaceClaim: hit.surfaceClaim ?? null,
        surfacePublication: hit.surfacePublication ?? null,
        renderRole: hit.renderRole ?? null,
        renderDiagnostic: includeDiagnostics ? hit.renderDiagnostic ?? null : undefined,
    }, 6);
}

function inspectionReportHits(report) {
    return [
        ...(report?.cameraRayHits || []),
        ...(report?.verticalSurfaceStack || []),
        report?.selectedSurface,
    ].filter(Boolean);
}

function compactPublicationSnapshot(snapshot, hits, maxPublications) {
    if (!snapshot) return null;
    const replacementKeys = new Set();
    const ownerIds = new Set();
    for (const hit of hits) {
        const publicationKey = hit?.surfacePublication?.key;
        const replacementKey = hit?.surfaceClaim?.replacementKey;
        const ownerId = hit?.surfaceClaim?.ownerId;
        if (publicationKey) replacementKeys.add(String(publicationKey));
        if (replacementKey) replacementKeys.add(String(replacementKey));
        if (ownerId) ownerIds.add(String(ownerId));
    }
    const active = Array.isArray(snapshot.active) ? snapshot.active : [];
    const matching = active.filter(record => (
        replacementKeys.has(String(record?.key || ''))
        || (record?.ownerIds || []).some(ownerId => ownerIds.has(String(ownerId)))
    ));
    const included = matching.slice(0, maxPublications);
    return compactCopyValue({
        contract: snapshot.contract ?? null,
        activeCount: snapshot.activeCount ?? active.length,
        pendingCount: snapshot.pendingCount ?? null,
        matchingActiveCount: matching.length,
        activeIncludedCount: included.length,
        activeOmittedCount: Math.max(0, active.length - included.length),
        active: included,
        counters: snapshot.counters ?? null,
        recentProblems: snapshot.recentProblems ?? [],
    }, 6);
}

function compactInspectionLayers(report, hits) {
    const relevantIds = new Set(hits.map(hit => hit?.layer?.id).filter(Boolean));
    for (const id of report?.hiddenLayerIds || []) relevantIds.add(id);
    return (report?.layers || [])
        .filter(layer => (
            relevantIds.has(layer?.id)
            || layer?.enabled === false
            // Transport/terrain inventory remains useful when the reported
            // failure is precisely that a road or rail surface produced no hit.
            || /^(terrain|ground|road|rail|sidewalk|bike|curb|lane|level-crossing)/
                .test(String(layer?.id || ''))
        ))
        .map(layer => compactCopyValue({
            id: layer.id ?? null,
            label: layer.label ?? null,
            category: layer.category ?? null,
            source: layer.source ?? null,
            enabled: layer.enabled !== false,
            objectCount: layer.objectCount ?? null,
            visibleObjectCount: layer.visibleObjectCount ?? null,
        }, 3));
}

export function compactInspectionReport(report = {}, {
    maxHits = INSPECTION_COPY_MAX_HITS,
    maxPublications = INSPECTION_COPY_MAX_PUBLICATIONS,
    includeMetadata = true,
    includeDiagnostics = true,
} = {}) {
    report = report && typeof report === 'object' ? report : {};
    const allHits = inspectionReportHits(report);
    const rayHits = (report.cameraRayHits || []).slice(0, maxHits).map(hit => (
        compactInspectionHit(hit, { includeMetadata, includeDiagnostics })
    ));
    const verticalHits = (report.verticalSurfaceStack || []).slice(0, maxHits).map(hit => (
        compactInspectionHit(hit, { includeMetadata, includeDiagnostics })
    ));
    const layers = compactInspectionLayers(report, allHits);
    const publications = compactPublicationSnapshot(
        report.surfacePublications,
        allHits,
        maxPublications,
    );
    return {
        reportSchema: INSPECTION_COPY_SCHEMA,
        generatedAt: report.generatedAt ?? null,
        copySummary: {
            characters: 0,
            maxCharacters: INSPECTION_COPY_MAX_CHARACTERS,
            truncatedForBudget: false,
            original: {
                cameraRayHits: report.cameraRayHits?.length || 0,
                verticalSurfaceStack: report.verticalSurfaceStack?.length || 0,
                activeSurfacePublications: report.surfacePublications?.active?.length || 0,
                layers: report.layers?.length || 0,
            },
            included: {
                cameraRayHits: rayHits.length,
                verticalSurfaceStack: verticalHits.length,
                activeSurfacePublications: publications?.active?.length || 0,
                layers: layers.length,
            },
        },
        selectedPoint: compactCopyValue(report.selectedPoint ?? null, 6),
        cameraRayHits: rayHits,
        verticalSurfaceStack: verticalHits,
        selectedSurface: compactInspectionHit(report.selectedSurface, {
            includeMetadata,
            includeDiagnostics,
        }),
        selectedSurfaceDiagnostics: includeDiagnostics
            ? compactCopyValue(report.selectedSurfaceDiagnostics ?? null, 5)
            : null,
        groundOwnershipMask: includeDiagnostics
            ? compactCopyValue(report.groundOwnershipMask ?? null, 5)
            : null,
        surfacePublications: publications,
        layers,
        hiddenLayerIds: compactCopyValue(report.hiddenLayerIds || [], 2),
    };
}

function stringifyInspectionCopy(report) {
    let text = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
        text = JSON.stringify(report, null, 2);
        if (!report.copySummary || report.copySummary.characters === text.length) break;
        report.copySummary.characters = text.length;
    }
    return JSON.stringify(report, null, 2);
}

function minimalInspectionReport(report, maxCharacters) {
    const selected = compactInspectionHit(report?.selectedSurface, {
        includeMetadata: false,
        includeDiagnostics: false,
    });
    return {
        reportSchema: INSPECTION_COPY_SCHEMA,
        generatedAt: boundedCopyString(report?.generatedAt ?? '', 100),
        copySummary: {
            characters: 0,
            maxCharacters,
            truncatedForBudget: true,
            note: 'Only the selected point and selected surface fit the copy budget.',
        },
        selectedPoint: compactCopyValue(report?.selectedPoint ?? null, 3),
        selectedSurface: selected ? {
            index: selected.index,
            layer: selected.layer,
            object: selected.object,
            feature: selected.feature ? {
                key: selected.feature.key,
                objectId: selected.feature.objectId,
            } : null,
            surface: selected.surface,
            roadVerticalAlignment: selected.roadVerticalAlignment,
            surfaceClaim: selected.surfaceClaim,
            surfacePublication: selected.surfacePublication,
        } : null,
    };
}

export function formatInspectionReport(report, {
    maxCharacters = INSPECTION_COPY_MAX_CHARACTERS,
} = {}) {
    const budget = Math.max(2_000, Number(maxCharacters) || INSPECTION_COPY_MAX_CHARACTERS);
    let compact = compactInspectionReport(report);
    compact.copySummary.maxCharacters = budget;
    let text = stringifyInspectionCopy(compact);
    if (text.length <= budget) return text;

    compact = compactInspectionReport(report, {
        maxHits: 4,
        maxPublications: 8,
        includeMetadata: false,
        includeDiagnostics: false,
    });
    compact.copySummary.maxCharacters = budget;
    compact.copySummary.truncatedForBudget = true;
    text = stringifyInspectionCopy(compact);
    if (text.length <= budget) return text;

    compact = minimalInspectionReport(report, budget);
    text = stringifyInspectionCopy(compact);
    if (text.length <= budget) return text;

    compact.selectedPoint = null;
    compact.selectedSurface = null;
    compact.copySummary.note = 'Selected diagnostics exceeded the copy budget.';
    return stringifyInspectionCopy(compact);
}
