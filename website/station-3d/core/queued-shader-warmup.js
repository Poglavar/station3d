// Warm a small detached family of shared primitive shaders before exposing
// actors. Compilation and first-use bindings advance once per frame; owned
// material clones keep programs alive and make cancellation safe during polling.
import { createFrameChunkQueue, FRAME_CHUNK_DEFER_ITEM } from './frame-chunk-queue.js';
import { prewarmDetachedObject } from './detached-gpu-prewarm.js';

export function createQueuedShaderWarmup(root, {
    renderer, camera, targetScene, label = 'actor-shader-warmup',
}) {
    if (root.parent) throw new Error('Shader warmup requires an owned, detached root');
    const materials = new Map();
    root.traverse(object => {
        if (!object.material) return;
        const own = original => {
            if (!materials.has(original)) {
                // Material.copy serializes userData. A compiled building material
                // stores live shaders/uniforms there, not an authoring JSON blob.
                // Copy through a read-only view, then borrow that metadata shallowly.
                const source = Object.create(original);
                source.userData = {};
                const clone = original.clone.call(source);
                clone.userData = { ...original.userData };
                // Material.clone() intentionally omits these executable hooks.
                // Preserve them on the owned copy so custom shader patches and
                // cache identity remain identical during the compile fence.
                clone.onBeforeCompile = original.onBeforeCompile;
                clone.customProgramCacheKey = original.customProgramCacheKey;
                materials.set(original, clone);
            }
            return materials.get(original);
        };
        object.material = Array.isArray(object.material)
            ? object.material.map(own) : own(object.material);
    });
    let complete;
    const completion = new Promise(resolve => { complete = resolve; });
    const state = { ready: false, error: null, closed: false, phase: 'prepare', completion, dispose };
    let shaderReady = null, cleanupPromise = null;
    const iterator = prepare();
    const queue = createFrameChunkQueue({
        label, frameBudgetMs: 2, preferAnimationFrame: true,
        pauseDuringMovement: false, trackWorldReady: true,
        activityDetails: () => ({ buildFailed: state.error ? 1 : 0 }),
    });
    queue.enqueue([root], () => {
        const outcome = iterator.next();
        shaderReady = outcome.value?.ready || null;
        state.phase = outcome.value?.phase || 'ready';
        return outcome.done ? undefined : FRAME_CHUNK_DEFER_ITEM;
    }, {
        maxItemsPerFrame: 1, maxItemsPerSettledFrame: 1,
        describeItem: () => state.phase,
        onComplete() {
            if (!state.closed) state.ready = true;
            complete(state);
            root.clear();
            queue.dispose();
        },
        onError(error) { state.error = error; complete(state); },
    });
    return state;

    function* prepare() {
        yield* prewarmDetachedObject(root, {
            renderer, camera, targetScene, label,
            asyncShaders: true, uploadGeometry: false, prewarmTextures: false,
        });
        // The shared prewarmer includes first-use bindings. Retain our cloned
        // materials until stop so an unused rare variant cannot be evicted.
    }

    function dispose() {
        if (state.closed) return cleanupPromise;
        state.closed = true;
        state.ready = false;
        complete(state);
        queue.dispose();
        const release = () => {
            iterator.return();
            root.clear();
            for (const material of materials.values()) material.dispose();
            materials.clear();
        };
        // Session teardown may dispose the original shared person assets now.
        // The compiler polls only these owned clones, which survive the fence.
        if (shaderReady) {
            cleanupPromise = shaderReady.then(release);
            cleanupPromise.catch(error => console.error(`[${label}] cleanup failed:`, error));
        } else {
            release();
            cleanupPromise = Promise.resolve();
        }
        return cleanupPromise;
    }
}
