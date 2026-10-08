import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as THREE from 'three';
import { bindGroundPaintMaterial } from '../core/ground-paint-material.js';
import { acceptanceDiagnosticSourceHash, captureAcceptanceDiagnostic, captureGroundPaintBindings } from '../../../tools/lib/perf-acceptance-diagnostic.mjs';

function makePage({ gpu = false, failRaf = false, metricsAvailable = true } = {}) {
    let now = 0;
    const toggles = [];
    const gl = { getExtension: () => gpu ? { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 } : null,
        getParameter: () => false, createQuery: () => ({}), beginQuery() {}, endQuery() {},
        getQueryParameter: () => false, deleteQuery() {} };
    const renderer = { renderCalls: 0, getContext: () => gl,
        render() { this.renderCalls++; } };
    const debug = { renderer, setGpuFrameTimerEnabled: value => toggles.push(value) };
    const context = vm.createContext({
        window: { __st3dDebug: debug },
        performance: { now: () => now },
        requestAnimationFrame(callback) {
            if (failRaf) throw new Error('RAF failed');
            renderer.render();
            now += 100;
            callback(now);
            return now;
        },
        cancelAnimationFrame() {},
    });
    const metricRows = [
        { name: 'TaskDuration', value: 1 }, { name: 'ScriptDuration', value: 0.4 },
        { name: 'LayoutDuration', value: 0.1 }, { name: 'RecalcStyleDuration', value: 0.05 },
    ];
    const calls = [];
    const cdp = { async send(name) {
        calls.push(name);
        if (name === 'Performance.getMetrics') return { metrics: metricsAvailable ? metricRows : [] };
        if (name === 'Profiler.stop') return { profile: { nodes: [], samples: [] } };
        return {};
    }, async detach() { calls.push('detach'); } };
    const page = { context: () => ({ newCDPSession: async () => cdp }),
        evaluate: source => vm.runInContext(source, context) };
    return { page, renderer, toggles, calls };
}

test('stationary diagnostic restores render and timer state when GPU timing is unavailable', async () => {
    const env = makePage();
    const originalRender = env.renderer.render;
    const result = await captureAcceptanceDiagnostic(env.page, { seconds: 0.25 });
    assert.equal(result.diagnostic, true);
    assert.equal(result.gpu.available, false);
    assert.equal(result.gpu.windows.length, 0);
    assert.equal(result.gpu.frames, 0);
    assert.equal(result.gpu.medianWindowMs, null);
    assert.ok(result.renderCPU.n > 0);
    assert.equal(env.renderer.render, originalRender);
    assert.deepEqual(env.toggles, [false, true]);
    assert.equal(result.taskMetrics.deltaMs.TaskDuration, 0);
    assert.equal(result.approximateNonTaskFraction, 1);
    assert.match(acceptanceDiagnosticSourceHash(1), /^[a-f0-9]{64}$/);
    assert.ok(env.calls.includes('detach'));
});

test('diagnostic restores renderer and engine timer after browser capture failure', async () => {
    const env = makePage({ failRaf: true });
    const originalRender = env.renderer.render;
    await assert.rejects(captureAcceptanceDiagnostic(env.page, { seconds: 1 }), /RAF failed/);
    assert.equal(env.renderer.render, originalRender);
    assert.deepEqual(env.toggles, [false, true]);
    assert.ok(env.calls.includes('detach'));
});

test('missing CDP metrics stay null and an explicit profile is saved', async () => {
    const env = makePage({ metricsAvailable: false });
    const dir = await mkdtemp(join(tmpdir(), 'st3d-diagnostic-'));
    const outputProfile = join(dir, 'profile.json');
    try {
        const result = await captureAcceptanceDiagnostic(env.page, { seconds: 0.1, outputProfile });
        assert.equal(result.taskMetrics.before.TaskDuration, null);
        assert.equal(result.taskMetrics.deltaMs.ScriptDuration, null);
        assert.equal(result.approximateNonTaskFraction, null);
        assert.equal(result.profilePath, outputProfile);
        assert.deepEqual(JSON.parse(await readFile(outputProfile, 'utf8')), { nodes: [], samples: [] });
        assert.ok(env.calls.includes('Profiler.start'));
        assert.ok(env.calls.includes('Profiler.stop'));
        assert.ok(env.calls.includes('Profiler.disable'));
        assert.ok(env.calls.includes('detach'));
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('binding diagnostic detects cached uniforms from a retired receiver', async () => {
    const material = new THREE.MeshStandardMaterial();
    const first = bindGroundPaintMaterial(material, { receiver: { key: 'first', verticalBand: 'ground', coverageRevision: 'v1' } });
    const standard = THREE.ShaderLib.standard;
    const previousShader = { vertexShader: standard.vertexShader, fragmentShader: standard.fragmentShader,
        uniforms: THREE.UniformsUtils.clone(standard.uniforms) };
    material.onBeforeCompile(previousShader, {});
    first.dispose();
    const second = bindGroundPaintMaterial(material, { receiver: { key: 'second', verticalBand: 'ground', coverageRevision: 'v1' } });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BufferGeometry(), material));
    const properties = { uniforms: previousShader.uniforms };
    const debug = { THREE, scene, state: { cabState: { groundPaint: { receiver: second.receiver } } },
        renderer: { properties: { has: () => true, get: () => properties } } };
    const context = vm.createContext({ window: { __st3dDebug: debug } });
    const page = { evaluate: source => vm.runInContext(source, context) };
    try {
        const stale = await captureGroundPaintBindings(page);
        assert.equal(stale.compiledMaterials, 1);
        assert.equal(stale.mismatches.length, 1);
        assert.notEqual(stale.mismatches[0].actualTable, stale.mismatches[0].expectedTable);

        const currentShader = { vertexShader: standard.vertexShader, fragmentShader: standard.fragmentShader,
            uniforms: THREE.UniformsUtils.clone(standard.uniforms) };
        material.onBeforeCompile(currentShader, {});
        properties.uniforms = currentShader.uniforms;
        const fresh = await captureGroundPaintBindings(page);
        assert.equal(fresh.compiledMaterials, 1);
        assert.equal(fresh.mismatches.length, 0);
        assert.equal(fresh.tables.length, 1);
    } finally {
        second.dispose(); material.dispose(); scene.children[0].geometry.dispose();
    }
});
