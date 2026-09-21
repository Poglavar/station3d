// Prepares a detached Object3D generation before atomic publication. Shader
// variants compile against the real scene's lights/fog, textures initialize one
// at a time, and geometry buffers are touched through a 1×1 offscreen render in
// bounded batches with separately prepared upload materials. The candidate
// itself never enters the visible scene.

import * as THREE from 'three';
import { getFrameChunkSequence } from './frame-chunk-queue.js';
import { isWorldBuilding } from './world-ready.js';

const PREWARM_LAYER = 31;
const DEFAULT_SCAN_CHUNK = 48;
const DEFAULT_UPLOAD_BATCH = 1;
const DEFAULT_SLICE_MS = 4;
const NO_CLIPPING_PLANES = [];
const rendererPrewarmState = new WeakMap();
const LOADING_UPLOAD_BYTES = 2 * 1024 * 1024;
const LOADING_UPLOAD_BATCHES = 16;
const LOADING_UPLOAD_MS = 4;

function loadingUploadBudget(state) {
    const frame = getFrameChunkSequence();
    if (state.loadingUploads?.frame !== frame) {
        state.loadingUploads = { frame, bytes: 0, batches: 0, ms: 0 };
    }
    return state.loadingUploads;
}

function uploadBudgetExhausted(budget) {
    return budget.bytes >= LOADING_UPLOAD_BYTES || budget.batches >= LOADING_UPLOAD_BATCHES
        || budget.ms >= LOADING_UPLOAD_MS;
}

function prewarmStateFor(renderer) {
    let state = rendererPrewarmState.get(renderer);
    if (!state) {
        state = {
            materials: new WeakMap(),
            programs: new WeakSet(),
            geometries: new WeakSet(),
            textures: new WeakSet(),
            uploadVariants: new Map(),
            uploadPrimer: null,
            // Creating and first-binding a WebGLRenderTarget can itself block
            // the driver for tens of milliseconds. One renderer-wide 1×1
            // target is sufficient for every detached upload and keeps that
            // one-time allocation in startup instead of repeating per packet.
            renderTarget: null,
        };
        rendererPrewarmState.set(renderer, state);
    }
    return state;
}

function uploadVariantFor(state, object) {
    const key = materialVariantKey(object);
    let variant = state.uploadVariants.get(key);
    if (!variant) {
        // Uploads need buffers, not a second lighting/shadow/tone-mapping
        // variant of every visible material. Keep one unlit material per
        // object schema alive for the renderer's lifetime, including while a
        // cancelled job's compileAsync still polls its current program.
        const material = new THREE.MeshBasicMaterial({
            toneMapped: false, fog: false,
            colorWrite: false, depthWrite: false, depthTest: false,
        });
        material.name = 'Station3DGpuUploadMaterial';
        variant = { material, ready: false };
        state.uploadVariants.set(key, variant);
    }
    return variant;
}

function uploadPrimerFor(state) {
    if (!state.uploadPrimer) {
        // WebGLRenderer.compile does not initialize its clipping state. Even
        // an empty render leaves the previous material's clipIntersection
        // count behind. One already-compiled, three-vertex draw resets that
        // state through the renderer's public path before compiling uploads.
        // RawShaderMaterial's program key is independent of those stale
        // clipping/light counts, so the reset draw cannot compile a new variant.
        const material = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: 'in vec3 position; void main() { gl_Position = vec4(position, 1.0); }',
            fragmentShader: 'precision highp float; out vec4 color; void main() { color = vec4(0.0); }',
            colorWrite: false, depthWrite: false, depthTest: false,
            toneMapped: false, fog: false,
        });
        material.name = 'Station3DGpuUploadStatePrimer';
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.layers.set(PREWARM_LAYER);
        mesh.frustumCulled = false;
        const scene = createOffscreenScene();
        scene.name = 'Station3DGpuUploadStatePrimer';
        scene.add(mesh);
        state.uploadPrimer = { scene, ready: false };
    }
    return state.uploadPrimer;
}

function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function shaderFailureMessage(program, label) {
    const diagnostics = program?.diagnostics;
    const details = [
        diagnostics?.programLog,
        diagnostics?.vertexShader?.log,
        diagnostics?.fragmentShader?.log,
    ].filter(Boolean).map(value => String(value).replace(/\s+/g, ' ').trim()).filter(Boolean);
    const suffix = details.length ? `: ${details.join(' | ').slice(0, 1200)}` : '';
    return `Shader program failed: ${program?.name || label}${suffix}`;
}

function materialList(material) {
    if (Array.isArray(material)) return material.filter(Boolean);
    return material ? [material] : [];
}

// One material may be used by ordinary, instanced and batched geometry. Those
// are different programs, as are vertex-alpha/morph attribute schemas. Warming
// the first object must not mark every other use of the material as ready.
function materialVariantKey(object) {
    const geometry = object.geometry;
    return JSON.stringify([
        object.isBatchedMesh ? 'batch' : object.isInstancedMesh ? 'instance' : object.type,
        !!object._colorsTexture, !!object.instanceColor, !!object.morphTexture,
        Object.entries(geometry?.attributes || {}).map(([name, attribute]) => (
            [name, attribute.itemSize, attribute.normalized]
        )).sort(([a], [b]) => a.localeCompare(b)),
        Object.entries(geometry?.morphAttributes || {}).map(([name, attributes]) => (
            [name, attributes.length]
        )).sort(([a], [b]) => a.localeCompare(b)),
    ]);
}

function textureValues(value, textures, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.isTexture) {
        textures.add(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) textureValues(item, textures, seen);
        return;
    }
    // Shader uniforms can wrap textures in { value }, while built-in
    // materials expose them as direct enumerable map-like properties.
    for (const child of Object.values(value)) {
        if (child?.isTexture || child?.value?.isTexture) {
            textureValues(child?.isTexture ? child : child.value, textures, seen);
        }
    }
}

function representativeFor(object, material) {
    const geometry = object?.geometry;
    if (!geometry || !material) return null;
    let representative;
    if (object.isBatchedMesh) {
        // BatchedMesh has its own shader defines and indirect/matrix/color
        // textures. A plain Mesh proxy warms the wrong program. Build a tiny
        // schema-compatible batch instead of cloning or reparenting the real
        // multi-megabyte candidate; compileAsync may retain its input while the
        // parallel driver finishes, so borrowing a live candidate is unsafe.
        const proxyGeometry = new THREE.BufferGeometry();
        for (const [name, attribute] of Object.entries(geometry.attributes || {})) {
            const values = new attribute.array.constructor(attribute.itemSize * 3);
            if (name === 'position' && attribute.itemSize >= 3) {
                values[0] = -0.5;
                values[attribute.itemSize] = 0.5;
                values[attribute.itemSize * 2 + 1] = 0.5;
            } else if (name === 'normal' && attribute.itemSize >= 3) {
                values[1] = values[attribute.itemSize + 1]
                    = values[attribute.itemSize * 2 + 1] = 1;
            }
            proxyGeometry.setAttribute(
                name,
                new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized),
            );
        }
        if (geometry.index) proxyGeometry.setIndex([0, 1, 2]);
        representative = new THREE.BatchedMesh(
            1,
            3,
            geometry.index ? 3 : 6,
            material,
        );
        const geometryId = representative.addGeometry(proxyGeometry);
        const instanceId = representative.addInstance(geometryId);
        if (object._colorsTexture) {
            representative.setColorAt(instanceId, new THREE.Color(0xffffff));
        }
        representative.userData.station3dDisposablePrewarmProxy = true;
        proxyGeometry.dispose();
    } else if (object.isInstancedMesh) {
        representative = new THREE.InstancedMesh(geometry, material, 1);
        representative.userData.station3dDisposablePrewarmProxy = true;
        if (object.instanceColor) representative.setColorAt(0, new THREE.Color(0xffffff));
        // The one-instance proxy only compiles this schema; it does not own the
        // source's morph texture and must not dispose it.
        if (object.morphTexture) representative.morphTexture = object.morphTexture;
    } else if (object.isPoints) {
        representative = new THREE.Points(geometry, material);
    } else if (object.isLineSegments) {
        representative = new THREE.LineSegments(geometry, material);
    } else if (object.isLine) {
        representative = new THREE.Line(geometry, material);
    } else if (object.isMesh && !object.isBatchedMesh && !object.isSkinnedMesh) {
        representative = new THREE.Mesh(geometry, material);
    } else {
        return null;
    }
    representative.name = 'Station3DGpuPrewarmRepresentative';
    representative.frustumCulled = false;
    representative.castShadow = false;
    representative.receiveShadow = object.receiveShadow === true;
    representative.layers.set(PREWARM_LAYER);
    return representative;
}

function disposePrewarmProxy(representative) {
    if (!representative.userData?.station3dDisposablePrewarmProxy) return;
    // Instanced proxies borrow the source morph texture but own their tiny
    // matrix/color attributes; dispose only those owned upload buffers.
    if (representative.isInstancedMesh) representative.morphTexture = null;
    representative.dispose();
}

function attachRepresentatives(parent, representatives) {
    const states = [];
    for (const representative of representatives) {
        const originalParent = representative.parent || null;
        states.push({
            representative,
            parent: originalParent,
            childIndex: originalParent?.children?.indexOf(representative) ?? -1,
            layerMask: representative.layers.mask,
            frustumCulled: representative.frustumCulled,
            castShadow: representative.castShadow,
        });
        representative.layers.set(PREWARM_LAYER);
        representative.frustumCulled = false;
        representative.castShadow = false;
        parent.add(representative);
    }
    return states;
}

function restoreRepresentatives(states) {
    for (const state of states) {
        const { representative, parent, childIndex } = state;
        representative.parent?.remove(representative);
        representative.layers.mask = state.layerMask;
        representative.frustumCulled = state.frustumCulled;
        representative.castShadow = state.castShadow;
        if (!parent) continue;
        parent.add(representative);
        if (childIndex >= 0 && childIndex < parent.children.length - 1) {
            parent.children.pop();
            parent.children.splice(childIndex, 0, representative);
        }
    }
}

function createOffscreenScene() {
    const prewarmScene = new THREE.Scene();
    prewarmScene.name = 'Station3DGpuUploadScene';
    return prewarmScene;
}

function createOffscreenCamera(camera) {
    const prewarmCamera = camera?.clone?.() || new THREE.PerspectiveCamera(60, 1, 0.01, 1e7);
    prewarmCamera.layers.set(PREWARM_LAYER);
    prewarmCamera.aspect = 1;
    prewarmCamera.updateProjectionMatrix?.();
    prewarmCamera.updateMatrixWorld?.(true);
    return prewarmCamera;
}

function withOffscreenTarget(renderer, renderTarget, run) {
    const previousTarget = renderer.getRenderTarget?.() || null;
    const previousFace = renderer.getActiveCubeFace?.() || 0;
    const previousLevel = renderer.getActiveMipmapLevel?.() || 0;
    const shadowEnabled = renderer.shadowMap?.enabled;
    const shadowAutoUpdate = renderer.shadowMap?.autoUpdate;
    const clippingPlanes = renderer.clippingPlanes;
    const localClippingEnabled = renderer.localClippingEnabled;
    try {
        renderer.clippingPlanes = NO_CLIPPING_PLANES;
        renderer.localClippingEnabled = false;
        if (renderer.shadowMap) {
            renderer.shadowMap.enabled = false;
            renderer.shadowMap.autoUpdate = false;
        }
        renderer.setRenderTarget(renderTarget);
        return run();
    } finally {
        // compileAsync starts synchronously and then returns a readiness
        // promise. Restore here, before any generator yield / visible frame.
        renderer.setRenderTarget(previousTarget, previousFace, previousLevel);
        renderer.clippingPlanes = clippingPlanes;
        renderer.localClippingEnabled = localClippingEnabled;
        if (renderer.shadowMap) {
            renderer.shadowMap.enabled = shadowEnabled;
            renderer.shadowMap.autoUpdate = shadowAutoUpdate;
        }
    }
}

function* compileShaderBatch(shaderRoot, {
    renderer, camera, targetScene, asyncShaders, label, renderTarget = null, beforeCompile = null,
}) {
    const programs = new Set();
    const priorPrograms = new Map();
    shaderRoot.traverse(object => {
        for (const material of materialList(object.material)) {
            if (priorPrograms.has(material)) continue;
            const state = renderer.properties.get(material);
            priorPrograms.set(material, new Set(state?.programs?.values?.() || []));
        }
    });
    const start = (run) => {
        const prepare = () => { beforeCompile?.(); return run(); };
        const result = renderTarget ? withOffscreenTarget(renderer, renderTarget, prepare) : prepare();
        // Capture immediately: another streamed object can change the shared
        // material's currentProgram before compileAsync's next polling visit.
        // Transparent double-sided materials can also have two real programs.
        shaderRoot.traverse(object => {
            for (const material of materialList(object.material)) {
                const state = renderer.properties.get(material);
                const before = priorPrograms.get(material) || new Set();
                for (const program of state?.programs?.values?.() || []) {
                    // Shared materials retain historical variants. A failed,
                    // noncurrent program from an earlier detached candidate
                    // must not poison every later generation. Validate every
                    // program created by this compile, its selected program,
                    // and any reusable program that is still runnable.
                    if (!before.has(program) || program === state.currentProgram
                        || program.diagnostics?.runnable !== false) programs.add(program);
                }
            }
        });
        return result;
    };
    if (asyncShaders && typeof renderer.compileAsync === 'function') {
        let state = 'pending';
        let failure = null;
        const ready = start(() => renderer.compileAsync(shaderRoot, camera, targetScene)).then(async () => {
            // The public compiler polls only material.currentProgram. Retain
            // the disposal fence until every captured variant has linked.
            while ([...programs].some(program => !program.isReady())) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }).then(
            () => { state = 'ready'; },
            error => { state = 'failed'; failure = error; },
        );
        // A cancelling async owner must wait on this fence before disposing
        // candidate materials. three.js polls their live currentProgram until
        // compileAsync settles; disposing it early makes that poll throw.
        yield { phase: `${label}:shader-start`, count: shaderRoot.children.length, waiting: true, ready, deferFrame: true };
        while (state === 'pending') yield { phase: `${label}:shader-wait`, waiting: true, ready, deferFrame: true };
        if (failure) throw failure;
    } else {
        start(() => renderer.compile(shaderRoot, camera, targetScene));
        yield { phase: `${label}:shader`, count: shaderRoot.children.length, deferFrame: true };
    }
    const initialized = prewarmStateFor(renderer).programs;
    for (const program of programs) {
        if (initialized.has(program)) continue;
        // Three r184 links asynchronously, but its lazy first-use path still
        // queries shader logs and discovers bindings synchronously. Complete
        // it before publication, one linked program per cooperative visit.
        // Keep diagnostics enabled; a failure must not enter the ready cache.
        program.getUniforms();
        program.getAttributes();
        if (program.diagnostics?.runnable === false) throw new Error(shaderFailureMessage(program, label));
        initialized.add(program);
        yield { phase: `${label}:bindings`, deferFrame: true };
    }
}

function renderOffscreenBatch(renderer, prewarmScene, camera, entries, renderTarget) {
    if (!renderer || !prewarmScene || entries.length === 0) return;
    const batch = new THREE.Group();
    batch.name = 'Station3DGpuPrewarmBatch';
    batch.layers.set(PREWARM_LAYER);
    const representativeStates = attachRepresentatives(batch, entries.map(entry => entry.representative));
    const materials = entries.map(({ representative }) => representative.material);
    try {
        // A bounded BatchedMesh upload borrows the real detached object only
        // for this synchronous draw, never across the asynchronous shader wait.
        entries.forEach(({ representative, variant }) => { representative.material = variant.material; });
        prewarmScene.add(batch);
        withOffscreenTarget(renderer, renderTarget, () => {
            renderer.clear(true, true, true);
            renderer.render(prewarmScene, camera);
        });
    } finally {
        entries.forEach(({ representative }, index) => { representative.material = materials[index]; });
        batch.parent?.remove(batch);
        restoreRepresentatives(representativeStates);
    }
}

function geometryUploadBytes(geometry) {
    const buffers = new Set();
    let bytes = 0;
    for (const attribute of [geometry?.index, ...Object.values(geometry?.attributes || {}),
        ...Object.values(geometry?.morphAttributes || {}).flat()]) {
        const buffer = attribute?.isInterleavedBufferAttribute ? attribute.data : attribute;
        if (!buffer || buffers.has(buffer)) continue;
        buffers.add(buffer); bytes += buffer.array?.byteLength || 0;
    }
    return bytes;
}

/**
 * Cooperative generator. When GPU work returns deferFrame, wait for a new
 * frame before advancing again. Loading may upload several small batches
 * within a renderer-wide byte/time/count allowance. CPU scans use the caller's
 * time budget, and ready promises must settle before resuming shader work.
 * Initial hidden builds may drain it synchronously with asyncShaders=false.
 */
export function* prewarmDetachedObject(root, {
    renderer,
    camera,
    targetScene,
    asyncShaders = true,
    label = 'gpu-prewarm',
    scanChunk = DEFAULT_SCAN_CHUNK,
    uploadBatch = DEFAULT_UPLOAD_BATCH,
    maxUploadBytes = 256 * 1024,
    sliceMs = DEFAULT_SLICE_MS,
    uploadGeometry = true,
    uploadBatchedGeometry = false,
    prewarmShaders = true,
    prewarmTextures = true,
} = {}) {
    if (!root || !renderer || !camera || !targetScene) return root;

    const prewarmed = prewarmStateFor(renderer);
    const materialRepresentatives = new Map();
    const geometryRepresentatives = new Map();
    const textures = new Set();
    const pending = [root];
    let cursor = 0;
    let scanned = 0;
    let sliceStartedAt = nowMs();
    while (cursor < pending.length) {
        const object = pending[cursor++];
        pending.push(...(object.children || []));
        for (const material of materialList(object.material)) {
            if (prewarmTextures) textureValues(material, textures);
            const variantKey = prewarmShaders ? materialVariantKey(object) : null;
            let variants = materialRepresentatives.get(material);
            if (prewarmShaders
                && prewarmed.materials.get(material)?.get(variantKey) !== material.version
                && !variants?.has(variantKey)) {
                const representative = representativeFor(object, material);
                if (representative) {
                    if (!variants) materialRepresentatives.set(material, variants = new Map());
                    variants.set(variantKey, representative);
                }
            }
        }
        if (uploadGeometry
            && object.geometry
            && (uploadBatchedGeometry || !object.isBatchedMesh)
            && !prewarmed.geometries.has(object.geometry)
            && !geometryRepresentatives.has(object.geometry)) {
            // A completed detached BatchedMesh is safe to render directly only
            // when its owner has deliberately bounded its backing buffers. The
            // default remains the tiny schema proxy so generic callers cannot
            // accidentally upload a multi-megabyte batch in one queue visit.
            const representative = object.isBatchedMesh && uploadBatchedGeometry
                ? object
                : representativeFor(object, materialList(object.material)[0]);
            if (representative) geometryRepresentatives.set(object.geometry, {
                representative,
                variant: uploadVariantFor(prewarmed, object),
                uploadBytes: geometryUploadBytes(representative.geometry),
            });
        }
        scanned += 1;
        if (scanned % Math.max(1, scanChunk) === 0
            || nowMs() - sliceStartedAt >= Math.max(0.5, sliceMs)) {
            yield { phase: `${label}:scan`, count: scanned };
            sliceStartedAt = nowMs();
        }
    }

    for (const texture of textures) {
        if (prewarmed.textures.has(texture)) continue;
        renderer.initTexture?.(texture);
        prewarmed.textures.add(texture);
        yield { phase: `${label}:texture`, texture: texture.uuid, deferFrame: true };
    }

    const shaderRoot = new THREE.Group();
    shaderRoot.name = 'Station3DShaderPrewarm';
    const shaderEntries = [...materialRepresentatives.entries()].flatMap(([material, variants]) => (
        [...variants].map(([variantKey, representative]) => [material, representative, variantKey])
    ));
    if (shaderEntries.length > 0) {
        // compileAsync starts real driver work before returning its promise.
        // Passing every material family at once made that nominally
        // cooperative `next()` an 85 ms curb-prewarm item. Start one program
        // family per visit; the detached root and readiness contract remain
        // unchanged.
        const shaderBatches = asyncShaders && typeof renderer.compileAsync === 'function'
            ? shaderEntries.map(entry => [entry])
            : [shaderEntries];
        for (const shaderBatch of shaderBatches) {
            const shaderRepresentatives = shaderBatch.map(([_material, representative]) => (
                representative
            ));
            const representativeStates = attachRepresentatives(shaderRoot, shaderRepresentatives);
            try {
                yield* compileShaderBatch(shaderRoot, { renderer, camera, targetScene, asyncShaders, label });
            } finally {
                restoreRepresentatives(representativeStates);
                for (const representative of shaderRepresentatives) disposePrewarmProxy(representative);
            }
            for (const [material, _representative, variantKey] of shaderBatch) {
                let variants = prewarmed.materials.get(material);
                if (!variants) prewarmed.materials.set(material, variants = new Map());
                variants.set(variantKey, material.version);
            }
        }
    }

    const representatives = [...geometryRepresentatives.values()];
    let renderTarget = null;
    let prewarmScene = null;
    const prewarmCamera = createOffscreenCamera(camera);
    try {
        if (representatives.length > 0) {
            prewarmScene = createOffscreenScene();
            if (!prewarmed.renderTarget) {
                prewarmed.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
                    depthBuffer: true,
                    stencilBuffer: true,
                });
            }
            renderTarget = prewarmed.renderTarget;
        }
        for (const { representative, variant } of representatives) {
            if (variant.ready) continue;
            const primer = uploadPrimerFor(prewarmed);
            if (!primer.ready) {
                yield* compileShaderBatch(primer.scene, {
                    renderer, camera: prewarmCamera, targetScene: primer.scene,
                    asyncShaders, label: `${label}:upload-state`, renderTarget,
                });
                primer.ready = true;
            }
            const proxy = representativeFor(representative, variant.material);
            shaderRoot.add(proxy);
            try {
                yield* compileShaderBatch(shaderRoot, {
                    renderer, camera: prewarmCamera, targetScene: prewarmScene,
                    asyncShaders, label: `${label}:upload`, renderTarget,
                    beforeCompile: () => renderer.render(primer.scene, prewarmCamera),
                });
                variant.ready = true;
            } finally {
                shaderRoot.remove(proxy);
                disposePrewarmProxy(proxy);
            }
        }
        const batchSize = Math.max(1, uploadBatch);
        const batchBytes = Math.max(1, maxUploadBytes);
        for (let index = 0; index < representatives.length;) {
            const batch = [];
            let bytes = 0;
            while (index < representatives.length && batch.length < batchSize) {
                const entry = representatives[index];
                // An existing large geometry remains one indivisible upload.
                // Only smaller geometries can share its old per-frame slot.
                if (batch.length && bytes + entry.uploadBytes > batchBytes) break;
                batch.push(entry); bytes += entry.uploadBytes; index++;
            }
            // Interactive work keeps one upload batch per visit/frame. Behind
            // the opaque loading curtain, hundreds of tiny roots need not each
            // spend a display frame. Share the allowance across every producer
            // on this renderer, so many small roots cannot bypass the ceiling.
            // Explicit synchronous drains retain their existing behavior.
            let loadingBudget = null;
            while (asyncShaders && isWorldBuilding()) {
                loadingBudget = loadingUploadBudget(prewarmed);
                if (!uploadBudgetExhausted(loadingBudget)
                    && (!loadingBudget.batches || loadingBudget.bytes + bytes <= LOADING_UPLOAD_BYTES)) break;
                yield { phase: `${label}:geometry-budget`, deferFrame: true };
            }
            const uploadStarted = nowMs();
            renderOffscreenBatch(renderer, prewarmScene, prewarmCamera, batch, renderTarget);
            if (loadingBudget) {
                loadingBudget.bytes += bytes;
                loadingBudget.batches++;
                loadingBudget.ms += nowMs() - uploadStarted;
            }
            for (const { representative } of batch) {
                if (representative.geometry) prewarmed.geometries.add(representative.geometry);
            }
            yield {
                phase: `${label}:geometry`,
                deferFrame: !loadingBudget || !isWorldBuilding() || uploadBudgetExhausted(loadingBudget),
                uploaded: index,
                total: representatives.length,
                uploadBytes: bytes,
            };
        }
    } finally {
        shaderRoot.clear();
        for (const { representative } of representatives) disposePrewarmProxy(representative);
    }
    return root;
}
