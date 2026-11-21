import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import { beginWorldBuild, forceWorldReady, _resetWorldReady } from '../core/world-ready.js';
import { getFrameChunkSequence, noteFrameChunkObserver } from '../core/frame-chunk-queue.js';

const prewarmPrograms = new WeakMap();
const prewarmProperties = { get: material => {
    let program = prewarmPrograms.get(material);
    if (!program) {
        program = { isReady: () => true, getUniforms() {}, getAttributes() {} };
        prewarmPrograms.set(material, program);
    }
    return { programs: new Map([['default', program]]) };
} };

const source = readFileSync(
    new URL('../core/detached-gpu-prewarm.js', import.meta.url),
    'utf8',
);
const railsSource = readFileSync(
    new URL('../world/rails.js', import.meta.url),
    'utf8',
);
const farBuildingsSource = readFileSync(
    new URL('../world/buildings-far.js', import.meta.url),
    'utf8',
);
const roadsSource = readFileSync(
    new URL('../world/roads.js', import.meta.url),
    'utf8',
);
const curbsSource = readFileSync(
    new URL('../world/curbs.js', import.meta.url),
    'utf8',
);
const roadStructuresSource = readFileSync(
    new URL('../world/road-grade-separations.js', import.meta.url),
    'utf8',
);

test('detached GPU prewarm compiles against the live scene and bounds uploads', () => {
    assert.match(source, /renderer\.compileAsync\(shaderRoot, camera, targetScene\)/);
    assert.match(source, /new THREE\.WebGLRenderTarget\(1, 1/);
    assert.match(source, /const batchSize = Math\.max\(1, uploadBatch\)/);
    assert.match(source, /yield \{[\s\S]*phase: `\$\{label\}:geometry`/);
    assert.match(source, /rendererPrewarmState = new WeakMap\(\)/);
});

test('prewarm never attaches the candidate root to the visible scene', () => {
    assert.doesNotMatch(source, /targetScene\.add\(root\)/);
    assert.match(source, /prewarmScene\.add\(batch\)/);
    assert.match(source, /renderer\.setRenderTarget\(renderTarget\)/);
    assert.match(source, /batch\.parent\?\.remove\(batch\)/);
});

test('material-only prewarm compiles shaders without forcing an offscreen draw', () => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material));
    let compileCalls = 0;
    let renderCalls = 0;
    const renderer = { properties: prewarmProperties,
        compile() { compileCalls += 1; },
        initTexture() {},
        render() { renderCalls += 1; },
        shadowMap: { enabled: true, autoUpdate: true },
    };
    const iterator = prewarmDetachedObject(root, {
        renderer,
        camera: new THREE.PerspectiveCamera(),
        targetScene: new THREE.Scene(),
        asyncShaders: false,
        uploadGeometry: false,
    });
    for (let outcome = iterator.next(); !outcome.done; outcome = iterator.next()) {}
    assert.equal(compileCalls, 1);
    assert.equal(renderCalls, 0);
    geometry.dispose();
    material.dispose();
});

test('async shader prewarm starts at most one material family per step', async () => {
    const root = new THREE.Group();
    const materials = Array.from({ length: 5 }, () => new THREE.MeshStandardMaterial());
    const geometries = materials.map(() => new THREE.PlaneGeometry(1, 1));
    materials.forEach((material, index) => root.add(new THREE.Mesh(geometries[index], material)));
    const compileWidths = [];
    const renderer = { properties: prewarmProperties,
        compileAsync(shaderRoot) {
            compileWidths.push(shaderRoot.children.length);
            return Promise.resolve();
        },
        initTexture() {},
        shadowMap: { enabled: true, autoUpdate: true },
    };
    const iterator = prewarmDetachedObject(root, {
        renderer,
        camera: new THREE.PerspectiveCamera(),
        targetScene: new THREE.Scene(),
        asyncShaders: true,
        uploadGeometry: false,
    });
    let outcome = iterator.next();
    while (!outcome.done) {
        await Promise.resolve();
        outcome = iterator.next();
    }
    assert.deepEqual(compileWidths, [1, 1, 1, 1, 1]);
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
});

test('prewarm caches object shader variants separately and preserves instance colors', () => {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true });
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, material);
    const instances = new THREE.InstancedMesh(geometry, material, 2);
    instances.setColorAt(0, new THREE.Color(0xff0000));
    root.add(mesh, instances);
    const compiled = [];
    const renderer = { properties: prewarmProperties, compile(group) {
        compiled.push(...group.children.map(object => ({
            instanced: !!object.isInstancedMesh, color: !!object.instanceColor,
        })));
    } };
    const drain = () => {
        const steps = prewarmDetachedObject(root, {
            renderer, camera: new THREE.PerspectiveCamera(), targetScene: new THREE.Scene(),
            asyncShaders: false, uploadGeometry: false,
        });
        for (let step = steps.next(); !step.done; step = steps.next()) {}
    };
    drain();
    assert.deepEqual(compiled, [
        { instanced: false, color: false }, { instanced: true, color: true },
    ]);
    drain();
    assert.equal(compiled.length, 2, 'unchanged schemas reuse their warm program');
    material.needsUpdate = true;
    drain();
    assert.equal(compiled.length, 4, 'a material revision must warm both schemas again');
    instances.dispose();
    geometry.dispose();
    material.dispose();
});

test('pending shader work tells synchronous drainers that an event-loop turn is required', async () => {
    const material = new THREE.MeshBasicMaterial();
    const geometry = new THREE.PlaneGeometry(1, 1);
    const root = new THREE.Mesh(geometry, material);
    let ready;
    const pendingProgram = { linked: false, isReady() { return this.linked; }, getUniforms() {}, getAttributes() {} };
    const renderer = {
        properties: { get: () => ({ programs: new Map([['pending', pendingProgram]]) }) },
        compileAsync: () => new Promise(resolve => { ready = () => { pendingProgram.linked = true; resolve(); }; }),
    };
    const iterator = prewarmDetachedObject(root, {
        renderer, camera: new THREE.PerspectiveCamera(), targetScene: new THREE.Scene(),
        asyncShaders: true, uploadGeometry: false,
    });
    assert.equal(iterator.next().value.waiting, true);
    assert.equal(iterator.next().value.waiting, true);
    ready();
    await Promise.resolve();
    const bindings = iterator.next();
    assert.match(bindings.value?.phase || '', /:shader-wait$/);
    let next = iterator.next();
    for (let i = 0; i < 8 && !next.done; i++) {
        if (next.value?.ready) await next.value.ready;
        await Promise.resolve();
        next = iterator.next();
    }
    assert.equal(next.done, true);
    geometry.dispose();
    material.dispose();
});

test('prewarm compiles a safe BatchedMesh proxy without reparenting the candidate', () => {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const sourceGeometry = new THREE.BoxGeometry(1, 1, 1);
    const batch = new THREE.BatchedMesh(
        1,
        sourceGeometry.getAttribute('position').count,
        sourceGeometry.getIndex().count,
        material,
    );
    const geometryId = batch.addGeometry(sourceGeometry);
    batch.addInstance(geometryId);
    batch.setColorAt(0, new THREE.Color(0xff8844));
    batch.layers.set(7);
    batch.castShadow = true;
    const sibling = new THREE.Group();
    const root = new THREE.Group();
    root.add(batch, sibling);

    let compiledBatchProxy = null;
    let renderCalls = 0;
    const renderer = { properties: prewarmProperties,
        shadowMap: { enabled: true, autoUpdate: true },
        compile(shaderRoot) {
            compiledBatchProxy = shaderRoot.children.find(child => child.isBatchedMesh) || null;
            assert.equal(batch.parent, root, 'the candidate remains in its detached transaction');
        },
        getRenderTarget: () => null,
        setRenderTarget() {},
        clear() {},
        render() { renderCalls += 1; },
    };
    const steps = prewarmDetachedObject(root, {
        renderer,
        camera: new THREE.PerspectiveCamera(),
        targetScene: new THREE.Scene(),
        asyncShaders: false,
        uploadBatch: 1,
    });
    let outcome = steps.next();
    while (!outcome.done) outcome = steps.next();

    assert.ok(compiledBatchProxy?.isBatchedMesh, 'compile uses the batching shader variant');
    assert.notEqual(compiledBatchProxy, batch, 'compile never borrows the live candidate');
    assert.equal(renderCalls, 0, 'large BatchedMesh buffers are not uploaded atomically offscreen');
    assert.deepEqual(root.children, [batch, sibling]);
    assert.equal(batch.parent, root);
    assert.equal(batch.layers.mask, 1 << 7);
    assert.equal(batch.castShadow, true);
    batch.dispose();
    sourceGeometry.dispose();
    material.dispose();
});

test('bounded owners can opt into one real detached BatchedMesh upload per step', () => {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const sourceGeometry = new THREE.BoxGeometry(1, 1, 1);
    const batch = new THREE.BatchedMesh(
        1,
        sourceGeometry.getAttribute('position').count,
        sourceGeometry.getIndex().count,
        material,
    );
    const geometryId = batch.addGeometry(sourceGeometry);
    batch.addInstance(geometryId);
    batch.setColorAt(0, new THREE.Color(0xff8844));
    const root = new THREE.Group();
    root.add(batch);
    let uploadedCandidate = false;
    const renderer = { properties: prewarmProperties,
        shadowMap: { enabled: true, autoUpdate: true },
        compile() {},
        getRenderTarget: () => null,
        setRenderTarget() {},
        clear() {},
        render(prewarmScene) {
            uploadedCandidate = !!prewarmScene.getObjectById(batch.id);
        },
    };
    const steps = prewarmDetachedObject(root, {
        renderer,
        camera: new THREE.PerspectiveCamera(),
        targetScene: new THREE.Scene(),
        asyncShaders: false,
        uploadBatch: 1,
        uploadBatchedGeometry: true,
    });
    let geometrySteps = 0;
    for (let outcome = steps.next(); !outcome.done; outcome = steps.next()) {
        if (outcome.value?.phase?.endsWith(':geometry')) geometrySteps += 1;
    }
    assert.equal(uploadedCandidate, true);
    assert.equal(geometrySteps, 1);
    assert.equal(batch.parent, root, 'the detached transaction is restored after upload');
    batch.dispose();
    sourceGeometry.dispose();
    material.dispose();
});

test('loading shares bounded upload batches across roots and restores one-frame deferrals on reveal', async () => {
    const material = new THREE.MeshBasicMaterial(), geometries = [], frames = new Map();
    const renderer = { properties: prewarmProperties, shadowMap: { enabled: true, autoUpdate: true }, compileAsync: () => Promise.resolve(),
        getRenderTarget: () => null, setRenderTarget() {}, clear() {}, render() {} };
    const makeRoot = (count, floats = 9) => {
        const root = new THREE.Group();
        for (let i = 0; i < count; i++) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(floats), 3));
            geometries.push(geometry); root.add(new THREE.Mesh(geometry, material));
        }
        return root;
    };
    async function drain(root, loading) {
        const iterator = prewarmDetachedObject(root, { renderer, camera: new THREE.PerspectiveCamera(),
            targetScene: new THREE.Scene(), asyncShaders: true, uploadBatch: 1 });
        try {
            for (let visits = 0; visits < 1000; visits++) {
                const next = iterator.next(); if (next.done) return;
                if (next.value?.phase.endsWith(':geometry')) {
                    if (!loading) assert.equal(next.value.deferFrame, true, 'gameplay keeps its per-frame limit');
                    const frame = getFrameChunkSequence(), counts = frames.get(frame) || { batches: 0, bytes: 0 };
                    counts.batches++; counts.bytes += next.value.uploadBytes; frames.set(frame, counts);
                }
                if (next.value?.ready) await next.value.ready;
                if (next.value?.deferFrame) noteFrameChunkObserver(0, 0);
                await Promise.resolve();
            }
            assert.fail('upload budget did not resume on a new frame');
        } finally { iterator.return(); }
    }
    try {
        _resetWorldReady(); beginWorldBuild(); noteFrameChunkObserver(0, 0);
        await drain(makeRoot(10), true); await drain(makeRoot(10), true);
        assert.ok([...frames.values()].some(row => row.batches > 1), 'small uploads can share a loading frame');
        assert.ok([...frames.values()].every(row => row.batches <= 16), 'separate roots share the same limit');
        frames.clear(); noteFrameChunkObserver(0, 0);
        await drain(makeRoot(5, 3 * 65536), true);
        assert.ok([...frames.values()].every(row => row.bytes <= 2 * 1024 * 1024), 'a batch cannot overshoot the shared byte allowance');
        forceWorldReady(); await drain(makeRoot(3), false);
    } finally { _resetWorldReady(); geometries.forEach(g => g.dispose()); material.dispose(); }
});

test('detached uploads reuse one renderer-owned offscreen target', () => {
    const material = new THREE.MeshBasicMaterial();
    const firstGeometry = new THREE.BoxGeometry(1, 1, 1);
    const secondGeometry = new THREE.BoxGeometry(2, 2, 2);
    const targets = [];
    let currentTarget = null;
    const renderer = { properties: prewarmProperties,
        shadowMap: { enabled: true, autoUpdate: true },
        compile() {},
        getRenderTarget: () => null,
        setRenderTarget(target) { currentTarget = target; },
        clear() {},
        render(scene) { if (scene.name !== 'Station3DGpuUploadStatePrimer') targets.push(currentTarget); },
    };
    for (const geometry of [firstGeometry, secondGeometry]) {
        const root = new THREE.Group();
        root.add(new THREE.Mesh(geometry, material));
        const steps = prewarmDetachedObject(root, {
            renderer,
            camera: new THREE.PerspectiveCamera(),
            targetScene: new THREE.Scene(),
            asyncShaders: false,
        });
        for (let outcome = steps.next(); !outcome.done; outcome = steps.next()) {}
    }
    assert.equal(targets.length, 2);
    assert.ok(targets[0]?.isRenderTarget);
    assert.equal(targets[0], targets[1]);
    firstGeometry.dispose();
    secondGeometry.dispose();
    material.dispose();
});

// Model the public compile/render inputs, not elapsed time: deleting the upload
// compile or changing its target/material makes the first draw fail this contract.
function uploadContractRenderer() {
    let target = null;
    let clippingCount = 2;
    const compiled = new Set();
    const calls = { uploads: [], uploadCompiles: [], primers: 0 };
    const key = (object, material, scene, camera, renderer) => JSON.stringify([
        material.uuid, object.type, !!object.instanceColor, !!object._colorsTexture,
        target?.uuid, renderer.shadowMap.enabled, scene.fog?.uuid || null,
        scene.environment?.uuid || null, camera.layers.mask,
        // Raw shader keys do not depend on the renderer's retained clipping
        // state. Built-in materials do, until a real draw initializes it.
        material.isRawShaderMaterial ? 0 : clippingCount,
    ]);
    const properties = new WeakMap();
    const renderer = { properties: { get: material => properties.get(material) },
        shadowMap: { enabled: true, autoUpdate: true },
        clippingPlanes: [new THREE.Plane(new THREE.Vector3(1, 0, 0), 1)],
        localClippingEnabled: true,
        getRenderTarget: () => target,
        setRenderTarget(value) { target = value; },
        clear() {},
        compile(root, camera, scene) {
            root.traverse(object => {
                if (!object.material) return;
                if (target && !object.material.isRawShaderMaterial) calls.uploadCompiles.push(object.material);
                const programKey = key(object, object.material, scene, camera, this);
                compiled.add(programKey);
                let state = properties.get(object.material);
                if (!state) { state = { programs: new Map() }; properties.set(object.material, state); }
                if (!state.programs.has(programKey)) state.programs.set(programKey, {
                    bound: false, isReady: () => true,
                    getUniforms() { this.bound = true; },
                    getAttributes() { assert.equal(this.bound, true); },
                });
            });
        },
        render(scene, camera) {
            assert.equal(this.localClippingEnabled, false);
            assert.deepEqual(this.clippingPlanes, []);
            clippingCount = 0;
            scene.traverse(object => {
                if (!object.material) return;
                const material = object.material;
                const program = properties.get(material)?.programs.get(key(object, material, scene, camera, this));
                assert.equal(program?.bound, true, 'the exact upload program must finish first-use bindings before drawing');
                if (material.isRawShaderMaterial) {
                    assert.ok(compiled.has(key(object, material, scene, camera, this)), 'the state-reset draw must also be prepared');
                    calls.primers++;
                    return;
                }
                assert.ok(material.isMeshBasicMaterial, 'uploads must not select the visible material');
                assert.equal(material.toneMapped, false);
                assert.equal(material.fog, false);
                assert.equal(scene.environment, null);
                assert.equal(scene.fog, null);
                assert.ok(compiled.has(key(object, material, scene, camera, this)),
                    'the exact offscreen variant must be ready before drawing');
                calls.uploads.push({ object, material });
            });
        },
    };
    return { renderer, calls };
}

test('CPU scans and cached objects need no extra frames while GPU starts remain bounded', async () => {
    const { renderer, calls } = uploadContractRenderer();
    const compile = renderer.compile.bind(renderer);
    let compiles = 0;
    renderer.compileAsync = (...args) => { compiles++; compile(...args); return Promise.resolve(); };
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    for (let i = 0; i < 128; i++) root.add(new THREE.Mesh(geometry, material));
    const options = { renderer, camera: new THREE.PerspectiveCamera(), targetScene: new THREE.Scene(), scanChunk: 1 };
    async function prepare() {
        let scans = 0, frames = 0;
        for (const step of prewarmDetachedObject(root, options)) {
            if (step.phase.endsWith(':scan')) { scans++; assert.equal(step.deferFrame, undefined); }
            if (step.deferFrame) frames++;
            if (step.ready) await step.ready;
            assert.ok(compiles + calls.uploads.length <= frames,
                'every shader start and geometry upload requires its own frame');
        }
        return { scans, frames };
    }
    const cold = await prepare();
    assert.equal(cold.scans, 129);
    assert.equal(cold.frames, 7, 'three program preparations, three binding preparations, and one geometry upload');
    assert.equal(calls.uploads.length, 1, 'shared geometry uploads only once');
    const before = compiles;
    compiles = 0; calls.uploads.length = 0;
    assert.deepEqual(await prepare(), { scans: 129, frames: 0 }, 'cached scans do not consume 129 frames');
    assert.equal(before, 3);
    geometry.dispose(); material.dispose();
});

test('small geometry shares bounded upload batches while a large geometry uploads alone', () => {
    const { renderer, calls } = uploadContractRenderer();
    const draw = renderer.render.bind(renderer), batches = [];
    renderer.render = (...args) => {
        const before = calls.uploads.length;
        draw(...args);
        if (calls.uploads.length > before) batches.push(calls.uploads.length - before);
    };
    const material = new THREE.MeshStandardMaterial();
    const geometries = [new THREE.BoxGeometry(), new THREE.BoxGeometry(),
        new THREE.PlaneGeometry(1, 1, 64, 64), new THREE.BoxGeometry(), new THREE.BoxGeometry(), new THREE.BoxGeometry()];
    const root = new THREE.Group();
    geometries.forEach(geometry => root.add(new THREE.Mesh(geometry, material)));
    // A BoxGeometry has 24 position/normal/UV vertices and 36 uint16 indices:
    // 24 * (3 + 3 + 2) * 4 + 36 * 2 = 840 bytes.
    const uploads = [...prewarmDetachedObject(root, {
        renderer, camera: new THREE.PerspectiveCamera(), targetScene: new THREE.Scene(),
        asyncShaders: false, uploadBatch: 8, maxUploadBytes: 1680,
    })].filter(step => step.phase.endsWith(':geometry'));
    assert.deepEqual(batches, [2, 1, 2, 1]);
    assert.deepEqual(uploads.map(step => step.uploaded), [2, 3, 5, 6]);
    assert.deepEqual(uploads.map(step => step.uploadBytes <= 1680), [true, false, true, true]);
    assert.ok(uploads.every(step => step.deferFrame), 'each bounded batch retains a frame barrier');
    assert.equal(calls.uploads.length, geometries.length);
    geometries.forEach(geometry => geometry.dispose()); material.dispose();
});

test('geometry upload uses a prepared neutral variant and restores the visible material', () => {
    const { renderer, calls } = uploadContractRenderer();
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xffffff, 1, 100);
    scene.add(new THREE.DirectionalLight());
    const material = new THREE.MeshStandardMaterial({ color: 0xff0044 });
    const geometry = new THREE.BoxGeometry();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.layers.set(4);
    const root = new THREE.Group();
    root.add(mesh);
    const steps = prewarmDetachedObject(root, {
        renderer, camera: new THREE.PerspectiveCamera(), targetScene: scene,
        asyncShaders: false,
    });
    for (let outcome = steps.next(); !outcome.done; outcome = steps.next()) {
        assert.equal(renderer.getRenderTarget(), null, 'no offscreen state survives a yield');
        assert.equal(renderer.shadowMap.enabled, true);
        assert.equal(renderer.shadowMap.autoUpdate, true);
        assert.equal(renderer.localClippingEnabled, true);
        assert.equal(renderer.clippingPlanes.length, 1);
        assert.equal(mesh.material, material);
        assert.equal(mesh.parent, root);
    }
    assert.equal(calls.uploadCompiles.length, 1);
    assert.equal(calls.uploads.length, 1);
    assert.equal(calls.primers, 1, 'a real bounded draw clears stale renderer clipping state');
    assert.equal(mesh.layers.mask, 1 << 4);
    assert.equal(mesh.castShadow, true);
    assert.equal(material.color.getHex(), 0xff0044);
    geometry.dispose();
    material.dispose();
});

test('upload shaders are reused across different visible materials with the same object schema', () => {
    const { renderer, calls } = uploadContractRenderer();
    for (let index = 0; index < 2; index += 1) {
        const material = new THREE.MeshStandardMaterial({ roughness: index });
        const geometry = new THREE.BoxGeometry(1 + index, 1, 1);
        const steps = prewarmDetachedObject(new THREE.Mesh(geometry, material), {
            renderer, camera: new THREE.PerspectiveCamera(), targetScene: new THREE.Scene(),
            asyncShaders: false,
        });
        for (let outcome = steps.next(); !outcome.done; outcome = steps.next()) {}
        geometry.dispose();
        material.dispose();
    }
    assert.equal(calls.uploadCompiles.length, 1, 'not another upload shader per visible material');
    assert.equal(calls.uploads.length, 2);
    assert.equal(calls.primers, 1, 'no redundant state-primer draw for an already prepared upload shader');
    assert.equal(calls.uploads[0].material, calls.uploads[1].material);
});

test('upload-only jobs wait on the asynchronous shader fence before touching geometry', async () => {
    const { renderer, calls } = uploadContractRenderer();
    const compile = renderer.compile.bind(renderer);
    let ready;
    renderer.compileAsync = (...args) => {
        compile(...args);
        return new Promise(resolve => { ready = resolve; });
    };
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial();
    const steps = prewarmDetachedObject(new THREE.Mesh(geometry, material), {
        renderer, camera: new THREE.PerspectiveCamera(), targetScene: new THREE.Scene(),
        prewarmShaders: false,
    });
    let outcome = steps.next();
    while (!outcome.done && !outcome.value?.waiting) outcome = steps.next();
    assert.equal(outcome.value?.waiting, true, 'upload also has an explicit shader fence');
    assert.ok(outcome.value.ready instanceof Promise);
    assert.equal(renderer.getRenderTarget(), null);
    assert.equal(renderer.shadowMap.enabled, true);
    assert.equal(calls.uploads.length, 0);
    assert.equal(steps.next().value.waiting, true);
    ready();
    await outcome.value.ready;
    for (outcome = steps.next(); !outcome.done; outcome = steps.next()) {
        if (outcome.value?.ready) { ready(); await outcome.value.ready; }
    }
    assert.equal(calls.uploads.length, 1);
    geometry.dispose();
    material.dispose();
});

test('a failed bounded batch upload restores ownership and does not mark buffers uploaded', () => {
    const { renderer } = uploadContractRenderer();
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial();
    const batch = new THREE.BatchedMesh(1, geometry.attributes.position.count, geometry.index.count, material);
    batch.addInstance(batch.addGeometry(geometry));
    const root = new THREE.Group();
    const sibling = new THREE.Group();
    root.add(batch, sibling);
    batch.castShadow = true;
    batch.layers.set(5);
    const render = renderer.render.bind(renderer);
    let fail = true;
    let uploads = 0;
    renderer.render = (scene, camera) => {
        render(scene, camera);
        if (scene.name === 'Station3DGpuUploadStatePrimer') return;
        uploads += 1;
        if (fail) throw new Error('upload failed');
    };
    const drain = () => {
        const steps = prewarmDetachedObject(root, {
            renderer, camera: new THREE.PerspectiveCamera(), targetScene: new THREE.Scene(),
            asyncShaders: false, uploadBatchedGeometry: true,
        });
        for (let outcome = steps.next(); !outcome.done; outcome = steps.next()) {}
    };
    assert.throws(drain, /upload failed/);
    assert.deepEqual(root.children, [batch, sibling]);
    assert.equal(batch.material, material);
    assert.equal(batch.castShadow, true);
    assert.equal(batch.layers.mask, 1 << 5);
    assert.equal(renderer.getRenderTarget(), null);
    assert.equal(renderer.shadowMap.enabled, true);
    assert.equal(renderer.localClippingEnabled, true);
    assert.equal(renderer.clippingPlanes.length, 1);
    fail = false;
    drain();
    assert.equal(uploads, 2, 'a failed upload must be attempted again');
    batch.dispose();
    geometry.dispose();
    material.dispose();
});

test('cancelling an upload shader wait keeps the shared material alive and retries preparation', async () => {
    const { renderer, calls } = uploadContractRenderer();
    const compile = renderer.compile.bind(renderer);
    let ready;
    renderer.compileAsync = (...args) => {
        compile(...args);
        return new Promise(resolve => { ready = resolve; });
    };
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Mesh(geometry, material);
    const options = { renderer, camera: new THREE.PerspectiveCamera(), targetScene: new THREE.Scene(), prewarmShaders: false };
    const steps = prewarmDetachedObject(root, options);
    let outcome = steps.next();
    while (!outcome.done && !outcome.value?.phase.endsWith(':upload:shader-start')) {
        if (outcome.value?.ready) { ready(); await outcome.value.ready; }
        outcome = steps.next();
    }
    assert.equal(outcome.value?.waiting, true);
    const uploadMaterial = calls.uploadCompiles[0];
    let disposals = 0;
    uploadMaterial.addEventListener('dispose', () => { disposals++; });
    assert.equal(steps.return().done, true);
    assert.equal(disposals, 0, 'compileAsync may still poll this renderer-owned material');
    assert.equal(root.material, material);
    assert.equal(renderer.getRenderTarget(), null);
    assert.equal(renderer.localClippingEnabled, true);
    assert.equal(calls.uploads.length, 0);
    ready();
    await outcome.value.ready;

    const retry = prewarmDetachedObject(root, { ...options, asyncShaders: false });
    for (let next = retry.next(); !next.done; next = retry.next()) {}
    assert.equal(calls.uploadCompiles.length, 2, 'cancelled preparation is not recorded as complete');
    assert.equal(calls.uploadCompiles[1], uploadMaterial, 'the small upload material is safely reused');
    assert.equal(calls.uploads.length, 1, 'cancelled work does not mark source buffers as uploaded');
    geometry.dispose();
    material.dispose();
});

test('far-building packets prewarm before atomic publication and close on cancellation', () => {
    assert.match(farBuildingsSource, /FAR_PACKET_PREWARM_ITEM/);
    assert.match(
        farBuildingsSource,
        /if \(frameChunkObserverIsMoving\(\)\) return FRAME_CHUNK_DEFER_ITEM;/,
        'far packet GPU work waits for a stationary frame',
    );
    assert.match(farBuildingsSource, /prewarmDetachedObject\(root, \{/);
    assert.match(farBuildingsSource, /label: 'far-building-gpu-prewarm'/);
    assert.match(farBuildingsSource, /const FAR_CHUNK = 32/);
    assert.match(farBuildingsSource, /uploadBatchedGeometry: true/);
    assert.match(farBuildingsSource, /if \(!outcome\.done\) return FRAME_CHUNK_REPEAT_ITEM/);
    const upload = farBuildingsSource.slice(
        farBuildingsSource.indexOf('const uploadPacket ='),
        farBuildingsSource.indexOf('job.compileHandle = renderCompiler.compile(request)'),
    );
    const prewarmIndex = upload.indexOf('job.prewarm.next()');
    const publicationIndex = upload.indexOf('publicationTicket.publish(root');
    assert.ok(
        prewarmIndex >= 0 && publicationIndex > prewarmIndex,
        'the detached packet must finish prewarming before it becomes visible',
    );
    assert.match(farBuildingsSource, /job\.prewarm\?\.return\?\.\(\)/);
});

test('expected far-building terrain rebuild cancellation is not reported as a page error', () => {
    assert.match(
        farBuildingsSource,
        /function isExpectedFarBuildCancellation\(error\)[\s\S]*'cancelled'[\s\S]*'superseded'/,
    );
    const rebuild = farBuildingsSource.slice(
        farBuildingsSource.indexOf('function drainTerrainFarRebuild'),
        farBuildingsSource.indexOf('// Centroid of the footprint'),
    );
    assert.match(rebuild, /if \(!isExpectedFarBuildCancellation\(error\)\)/);
});

test('rail cells forward CPU and shader waits and close suspended GPU work on cancellation', () => {
    let closed = false, retired = null;
    const ready = Promise.resolve();
    const runtime = vm.createContext({ THREE, performance, recordLayerFrameMs() {},
        *railRenderSegmentBatchesSteps() { return []; }, *smoothRailHeadNormalsSteps() {},
        addJunctionPatchMeshes: root => root.add(new THREE.Group()), annotateRailInspectionLayers() {},
        *createRailGpuPrewarm() {
            try {
                yield { phase: 'fixture:scan' };
                yield { phase: 'fixture:shader', deferFrame: true, ready };
            } finally { closed = true; }
        },
        stepRailGpuPrewarm: iterator => iterator.next(), getFrameChunkSequence: () => 1,
        cancelRailGpuPrewarm: iterator => iterator?.return(), cancelRailCellNormalSmoothing: iterator => iterator?.return(),
        enqueueRailRetirement: root => { retired = root; },
    });
    vm.runInContext(railsSource.slice(railsSource.indexOf('function* prepareRailCellGeometrySteps('),
        railsSource.indexOf('// One rail generation owns its visible cells')), runtime);
    const steps = runtime.prepareRailCellGeometrySteps(null, { segments: [] }, 1, () => true);
    let next;
    do { next = steps.next(); assert.equal(next.done, false); } while (next.value.phase !== 'fixture:scan');
    assert.equal(next.value.deferFrame, undefined);
    next = steps.next();
    assert.equal(next.value.ready, ready, 'a CPU scan must not consume the GPU frame slot');
    assert.equal(next.value.deferFrame, true);
    steps.return();
    assert.equal(closed, true);
    assert.ok(retired?.isGroup);
    assert.equal(retired.parent, null);
});

test('rail refresh uploads share the bounded delivery queue', () => {
    const helper = railsSource.slice(
        railsSource.indexOf('function ensureRailGpuUploadQueue'),
        railsSource.indexOf('function ensureRailCellQueue'),
    );
    assert.match(helper, /label:\s*'rail-gpu-upload'/);
    assert.match(helper, /workClass:\s*'delivery'/);
    assert.match(helper, /frameBudgetMs:\s*1/);
    assert.match(helper, /maxItemsPerFrame:\s*1/);
    assert.match(helper, /FRAME_CHUNK_REPEAT_ITEM/);
    const refresh = railsSource.slice(
        railsSource.indexOf('if (pendingRailVisualRefresh)'),
        railsSource.indexOf('if (nextBridgeLocationId'),
    );
    assert.match(refresh, /stepPendingRailVisualPreparation\(\)/);
    const preparation = railsSource.slice(
        railsSource.indexOf('function stepRailVisualPreparation('),
        railsSource.indexOf('function restartPendingRailVisualRefresh('),
    );
    assert.match(preparation, /stepRailVisualPreparation\(refresh\)/);
    assert.match(preparation, /enqueueRailGpuUploadStage\(refresh/);
    assert.doesNotMatch(preparation, /stepRailGpuPrewarm\(refresh\./);
    assert.doesNotMatch(refresh, /stepRailGpuPrewarm\(refresh\./);
});

test('road material families prewarm during readiness without uploading road aggregates', () => {
    const helper = roadsSource.slice(
        roadsSource.indexOf('function* createRoadMaterialPrewarm'),
        roadsSource.indexOf('function getRoadSurfaceY'),
    );
    assert.match(helper, /yield\* prewarmDetachedObject\(root, \{/);
    assert.match(helper, /label: ROAD_MATERIAL_PREWARM_READY_LABEL/);
    assert.match(helper, /uploadGeometry: false/);
    assert.match(helper, /return outcome\.done \? undefined : FRAME_CHUNK_DEFER_ITEM/);
    assert.match(helper, /state\.iterator\?\.return\?\.\(\)/);
    assert.match(helper, /state\.geometry\.dispose\(\)/);
    assert.doesNotMatch(helper, /roadAggregates/);

    const session = roadsSource.slice(
        roadsSource.indexOf('beginSession(ctx)'),
        roadsSource.indexOf('endSession()'),
    );
    assert.ok(
        session.indexOf('startRoadMaterialPrewarm()') < session.indexOf('tileSource ='),
        'material compilation starts before road tile streaming can publish new variants',
    );
    assert.match(helper, /noteWorldQueueActive\(ROAD_MATERIAL_PREWARM_READY_LABEL\)/);
    assert.match(helper, /noteWorldQueueIdle\(ROAD_MATERIAL_PREWARM_READY_LABEL\)/);
});

test('curb material families prewarm during readiness and close exactly once', () => {
    const helper = curbsSource.slice(
        curbsSource.indexOf('function* createCurbMaterialPrewarm'),
        curbsSource.indexOf('function lonLatToLocal'),
    );
    assert.match(helper, /getCurbMaterial/);
    assert.match(helper, /getRampMaterial/);
    assert.match(helper, /getGreenRampMaterial/);
    assert.match(helper, /getManholeMaterial/);
    assert.match(helper, /yield\* prewarmDetachedObject\(root, \{/);
    assert.match(helper, /uploadGeometry: false/);
    assert.match(helper, /FRAME_CHUNK_DEFER_ITEM/);
    assert.match(helper, /state\.iterator\?\.return\?\.\(\)/);
    assert.match(helper, /state\.geometry\.dispose\(\)/);
    assert.match(helper, /noteWorldQueueActive\(CURB_MATERIAL_PREWARM_READY_LABEL\)/);
    assert.match(helper, /noteWorldQueueIdle\(CURB_MATERIAL_PREWARM_READY_LABEL\)/);
});

test('road-structure material families prewarm without touching built alignments', () => {
    const helper = roadStructuresSource.slice(
        roadStructuresSource.indexOf('function* createRoadStructureMaterialPrewarm'),
        roadStructuresSource.indexOf('function retireAlignmentGroups'),
    );
    assert.match(helper, /Object\.entries\(materials \|\| \{\}\)/);
    assert.match(helper, /yield\* prewarmDetachedObject\(root, \{/);
    assert.match(helper, /uploadGeometry: false/);
    assert.match(helper, /FRAME_CHUNK_DEFER_ITEM/);
    assert.match(helper, /state\.iterator\?\.return\?\.\(\)/);
    assert.match(helper, /state\.geometry\.dispose\(\)/);
    assert.doesNotMatch(helper, /alignmentGroups/);
    assert.match(helper, /noteWorldQueueActive\(ROAD_STRUCTURE_MATERIAL_PREWARM_READY_LABEL\)/);
    assert.match(helper, /noteWorldQueueIdle\(ROAD_STRUCTURE_MATERIAL_PREWARM_READY_LABEL\)/);
});
