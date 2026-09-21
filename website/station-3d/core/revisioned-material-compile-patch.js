// Composable, revisioned onBeforeCompile patches for streamed materials.
//
// Three.js deliberately does not copy shader callbacks when Material.clone()
// or Material.copy() is used, but it does JSON-copy userData. Consequently a
// userData boolean is not proof that a material still owns its shader patch.
// Function identity is the authority here; userData is diagnostics only.

const materialStates = new WeakMap();

const COMPILE_ID = '__station3dCompilePatchId';
const COMPILE_REVISION = '__station3dCompilePatchRevision';
const COMPILE_BASE = '__station3dCompilePatchBase';
const CACHE_ID = '__station3dCachePatchId';
const CACHE_REVISION = '__station3dCachePatchRevision';
const CACHE_BASE = '__station3dCachePatchBase';

function unwrapOwnPatch(callback, id, idKey, baseKey) {
    let current = callback;
    const seen = new Set();
    while (typeof current === 'function'
        && current[idKey] === id
        && !seen.has(current)) {
        seen.add(current);
        current = current[baseKey];
    }
    return current;
}

function isInstalled(material, id, revision) {
    if (!material) return false;
    const compile = material.onBeforeCompile;
    const cacheKey = material.customProgramCacheKey;
    const callbacksMatch = typeof compile === 'function'
        && compile[COMPILE_ID] === id
        && compile[COMPILE_REVISION] === revision
        && typeof cacheKey === 'function'
        && cacheKey[CACHE_ID] === id
        && cacheKey[CACHE_REVISION] === revision;
    const state = materialStates.get(material);
    return callbacksMatch && (!state || (
        state.id === id
        && state.revision === revision
        && state.compile === compile
        && state.cacheKey === cacheKey
    ));
}

export function hasRevisionedMaterialCompilePatch(material, {
    id,
    revision,
} = {}) {
    return isInstalled(material, String(id || ''), String(revision || ''));
}

export function installRevisionedMaterialCompilePatch(material, {
    id,
    revision,
    apply,
} = {}) {
    if (!material || typeof apply !== 'function') return false;
    const patchId = String(id || '');
    const patchRevision = String(revision || '');
    if (!patchId || !patchRevision) {
        throw new Error('A revisioned material patch requires non-empty id and revision');
    }
    if (isInstalled(material, patchId, patchRevision)) return false;

    const baseCompile = unwrapOwnPatch(
        material.onBeforeCompile,
        patchId,
        COMPILE_ID,
        COMPILE_BASE,
    );
    const baseCacheKey = unwrapOwnPatch(
        material.customProgramCacheKey,
        patchId,
        CACHE_ID,
        CACHE_BASE,
    );

    const compile = function station3dRevisionedCompilePatch(shader, renderer) {
        if (typeof baseCompile === 'function') {
            baseCompile.call(this, shader, renderer);
        }
        apply.call(this, shader, renderer);
        compile.__station3dCompilePatchVerifiedRevision = patchRevision;
    };
    compile[COMPILE_ID] = patchId;
    compile[COMPILE_REVISION] = patchRevision;
    compile[COMPILE_BASE] = baseCompile;

    const cacheKey = function station3dRevisionedCacheKey() {
        const base = typeof baseCacheKey === 'function'
            ? String(baseCacheKey.call(this) || '')
            : '';
        return `${base}|${patchId}@${patchRevision}`;
    };
    cacheKey[CACHE_ID] = patchId;
    cacheKey[CACHE_REVISION] = patchRevision;
    cacheKey[CACHE_BASE] = baseCacheKey;

    material.onBeforeCompile = compile;
    material.customProgramCacheKey = cacheKey;
    material.userData ||= {};
    // Remove the legacy boolean whose JSON-cloned value could lie about the
    // callback actually present on a material clone.
    delete material.userData.__corridorPatched;
    material.userData.__station3dCompilePatch = {
        id: patchId,
        revision: patchRevision,
    };
    material.needsUpdate = true;
    materialStates.set(material, {
        id: patchId,
        revision: patchRevision,
        compile,
        cacheKey,
    });
    return true;
}
