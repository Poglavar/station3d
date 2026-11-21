// Renderer program-state contract: linking is not first-use readiness. These
// fakes retain the lazy bindings and mutable currentProgram of Three r184.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';

function fixture({ holdLink = false, failBindings = false } = {}) {
    const events = [], properties = new WeakMap(), programs = new Map();
    const geometry = new THREE.PlaneGeometry(), material = new THREE.MeshStandardMaterial();
    const root = new THREE.Mesh(geometry, material);
    const camera = new THREE.PerspectiveCamera(), targetScene = new THREE.Scene();
    let release, fail = failBindings;
    const link = new Promise(resolve => { release = resolve; });
    function program(key) {
        if (!programs.has(key)) programs.set(key, {
            linked: !holdLink, bound: false,
            isReady() { return this.linked; },
            getUniforms() {
                assert.equal(this.linked, true, 'first-use queries must wait for this exact program');
                if (!this.bound) {
                    events.push('bindings:' + key);
                    if (fail) throw new Error('first-use binding failure');
                    this.bound = true;
                }
                return {};
            },
            getAttributes() { assert.equal(this.bound, true); return {}; },
        });
        return programs.get(key);
    }
    const renderer = {
        properties: { get: value => properties.get(value) },
        compile(shaderRoot) {
            shaderRoot.traverse(object => {
                if (!object.material) return;
                const key = object.geometry.morphAttributes.position ? 'morph' : 'ordinary';
                let state = properties.get(object.material);
                if (!state) properties.set(object.material, state = { programs: new Map() });
                state.currentProgram = program(key);
                state.programs.set(key, state.currentProgram);
                events.push('compile:' + key);
            });
        },
        compileAsync(shaderRoot) {
            this.compile(shaderRoot);
            // Model a different compilation changing currentProgram before
            // Three's polling callback sees the old material again.
            const state = properties.get(material);
            if (holdLink && state) state.currentProgram = { isReady: () => true };
            return Promise.resolve();
        },
    };
    link.then(() => { for (const value of programs.values()) value.linked = true; });
    return { renderer, root, material, geometry, events, programs, program, release,
        steps: (object = root, options = {}) => prewarmDetachedObject(object, {
            renderer, camera, targetScene, uploadGeometry: false, prewarmTextures: false, ...options,
        }),
        allowBindings() { fail = false; },
        close() { release(); geometry.dispose(); material.dispose(); },
    };
}

async function drain(iterator) {
    const steps = [];
    for (let value = iterator.next(); !value.done; value = iterator.next()) {
        steps.push(value.value);
        if (value.value.ready) await value.value.ready;
    }
    return steps;
}

function nextReadyStep(iterator) {
    for (let value = iterator.next(); !value.done; value = iterator.next()) {
        if (value.value?.ready) return value.value;
    }
    assert.fail('detached prewarm completed without a shader readiness fence');
}

test('detached readiness consumes lazy bindings before a first visible draw', async () => {
    const f = fixture();
    try {
        const steps = await drain(f.steps());
        assert.deepEqual(f.events, ['compile:ordinary', 'bindings:ordinary']);
        assert.equal(steps.filter(step => step.phase.endsWith(':bindings')).length, 1);
        assert.equal(steps.find(step => step.phase.endsWith(':bindings')).deferFrame, true);
        const before = f.events.length;
        f.programs.get('ordinary').getUniforms();
        f.programs.get('ordinary').getAttributes();
        assert.equal(f.events.length, before, 'the visible draw performs no lazy first-use work');
        assert.deepEqual(await drain(f.steps()), [], 'the unchanged material/schema stays ready');
    } finally { f.close(); }
});

test('readiness fences captured programs even if material.currentProgram changes', async () => {
    const f = fixture({ holdLink: true });
    try {
        const iterator = f.steps();
        const start = nextReadyStep(iterator);
        let completed = false;
        start.ready.then(() => { completed = true; });
        for (let i = 0; i < 6; i++) await Promise.resolve();
        assert.equal(completed, false, 'another ready variant cannot settle the original shader fence');
        assert.deepEqual(f.events, ['compile:ordinary']);
        assert.equal(iterator.next().value.waiting, true);
        f.release();
        await start.ready;
        await drain(iterator);
        assert.deepEqual(f.events, ['compile:ordinary', 'bindings:ordinary']);
    } finally { f.close(); }
});

test('each actual shader variant initializes once, with a yield between program bindings', async () => {
    const f = fixture(), morph = f.geometry.clone();
    morph.morphAttributes.position = [morph.attributes.position.clone()];
    const root = new THREE.Group();
    root.add(f.root, new THREE.Mesh(morph, f.material));
    try {
        const steps = await drain(f.steps(root));
        assert.deepEqual(f.events, ['compile:ordinary', 'bindings:ordinary', 'compile:morph', 'bindings:morph']);
        assert.equal(steps.filter(step => step.phase.endsWith(':bindings')).length, 2);
        // A different owner of an existing linked program must not repeat its
        // first-use preparation or introduce another binding-frame delay.
        f.material.needsUpdate = true;
        const repeated = await drain(f.steps(root));
        assert.equal(repeated.filter(step => step.phase.endsWith(':bindings')).length, 0);
    } finally { morph.dispose(); f.close(); }
});

test('binding failure is observable and does not cache an unprepared material as ready', async () => {
    const f = fixture({ failBindings: true });
    try {
        await assert.rejects(drain(f.steps()), /first-use binding failure/);
        f.allowBindings();
        await drain(f.steps());
        assert.deepEqual(f.events, ['compile:ordinary', 'bindings:ordinary', 'compile:ordinary', 'bindings:ordinary']);
        assert.equal(f.programs.get('ordinary').bound, true);
    } finally { f.close(); }
});

test('cancelled work never marks a linked but unbound material ready', async () => {
    const f = fixture({ holdLink: true });
    try {
        const iterator = f.steps();
        const start = nextReadyStep(iterator);
        f.release();
        await start.ready;
        iterator.return();
        assert.deepEqual(f.events, ['compile:ordinary']);
        await drain(f.steps());
        assert.deepEqual(f.events, ['compile:ordinary', 'compile:ordinary', 'bindings:ordinary']);
    } finally { f.close(); }
});

test('both passes of a transparent material finish bindings in separate visits', async () => {
    const f = fixture();
    const compile = f.renderer.compile.bind(f.renderer);
    f.material.transparent = true;
    f.material.side = THREE.DoubleSide;
    f.renderer.compile = root => {
        compile(root);
        f.renderer.properties.get(f.material).programs.set('back', f.program('back'));
    };
    try {
        const steps = await drain(f.steps());
        assert.deepEqual(f.events, ['compile:ordinary', 'bindings:ordinary', 'bindings:back']);
        assert.equal(steps.filter(step => step.phase.endsWith(':bindings')).length, 2);
    } finally { f.close(); }
});

test('Three shader diagnostics cannot mark an invalid program ready without throwing', async () => {
    const f = fixture();
    f.program('ordinary').diagnostics = {
        runnable: false,
        programLog: 'link failed',
        vertexShader: { log: 'vertex failure' },
        fragmentShader: { log: '' },
    };
    try {
        await assert.rejects(drain(f.steps()), /Shader program failed: gpu-prewarm: link failed \| vertex failure/);
        f.program('ordinary').diagnostics.runnable = true;
        const steps = await drain(f.steps());
        assert.equal(steps.filter(step => step.phase.endsWith(':bindings')).length, 1);
    } finally { f.close(); }
});

test('a failed historical variant cannot poison a later valid detached compile', async () => {
    const f = fixture();
    try {
        f.renderer.compile(f.root);
        const stale = f.program('stale');
        stale.diagnostics = { runnable: false };
        f.renderer.properties.get(f.material).programs.set('stale', stale);
        f.events.length = 0;
        const steps = await drain(f.steps());
        assert.deepEqual(f.events, ['compile:ordinary', 'bindings:ordinary']);
        assert.equal(steps.filter(step => step.phase.endsWith(':bindings')).length, 1);
        assert.equal(stale.bound, false);
    } finally { f.close(); }
});
