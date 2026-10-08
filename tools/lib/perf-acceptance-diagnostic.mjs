// Separate, profiler-on stationary diagnostic; never substitute these timings for acceptance phases.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createGpuFrameTimer } from '../../website/station-3d/core/gpu-frame-timer.js';
import { summarizeIntervals } from './perf-probe-summary.mjs';

const METRIC_NAMES = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];

// Run only outside timed phases. Compare the renderer's retained uniforms with
// the current binding hook; a shared material may still hold a retired session.
function inspectGroundPaintBindings() {
    const debug = window.__st3dDebug;
    const { renderer, scene, THREE } = debug || {};
    const receiver = debug?.state?.cabState?.groundPaint?.receiver;
    if (!renderer?.properties || !scene?.traverse || !THREE?.ShaderLib?.standard || !receiver?.key) {
        return { available: false, compiledMaterials: 0, mismatches: [] };
    }
    const materials = new Set(), tables = new Set(), mismatches = [];
    let compiledMaterials = 0;
    scene.traverse(object => {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (material?.userData?.groundPaintReceiver?.key === receiver.key) materials.add(material);
        }
    });
    for (const material of materials) {
        if (!renderer.properties.has(material)) continue;
        const actual = renderer.properties.get(material).uniforms;
        if (!actual) continue;
        compiledMaterials++;
        const standard = THREE.ShaderLib.standard;
        const shader = { vertexShader: standard.vertexShader, fragmentShader: standard.fragmentShader,
            uniforms: THREE.UniformsUtils.clone(standard.uniforms) };
        material.onBeforeCompile(shader, renderer);
        const expected = shader.uniforms;
        const actualTable = actual.uReceiverPaintStyles?.value?.uuid || null;
        const expectedTable = expected.uReceiverPaintStyles?.value?.uuid || null;
        if (actualTable) tables.add(actualTable);
        if (!actualTable || actual.uReceiverPaintStyles !== expected.uReceiverPaintStyles
            || actual.uReceiverPaintCount !== expected.uReceiverPaintCount) {
            mismatches.push({ material: material.uuid, name: material.name, actualTable, expectedTable,
                actualCount: actual.uReceiverPaintCount?.value ?? null,
                expectedCount: expected.uReceiverPaintCount?.value ?? null });
        }
    }
    return { available: true, receiver: receiver.key, boundMaterials: materials.size,
        compiledMaterials, tables: [...tables], mismatches };
}

export async function captureGroundPaintBindings(page) {
    return page.evaluate(`(${inspectGroundPaintBindings.toString()})()`);
}

async function diagnosticInPage(seconds, timerFactory) {
    const debug = window.__st3dDebug;
    const renderer = debug?.renderer;
    if (!renderer || typeof renderer.render !== 'function' || typeof debug.setGpuFrameTimerEnabled !== 'function') {
        throw new Error('Station3D diagnostic renderer is unavailable');
    }
    const originalRender = renderer.render;
    const cpu = [];
    const windows = [];
    let timer = null;
    let started = 0;
    const durationMs = Math.max(0, Number(seconds) || 0) * 1000;
    const clock = () => performance.now();
    let wrapped = false;
    let rafId = null;
    try {
        debug.setGpuFrameTimerEnabled(false);
        timer = timerFactory(renderer.getContext());
        renderer.render = function (...args) {
            const before = clock();
            timer.begin();
            try { return originalRender.apply(this, args); }
            finally {
                timer.end();
                cpu.push(clock() - before);
            }
        };
        wrapped = true;
        started = clock();
        return await new Promise((resolve, reject) => {
            const tick = () => {
                try {
                    const sample = timer.takeWindow();
                    if (sample) windows.push(sample);
                    if (clock() - started >= durationMs) {
                        const tail = timer.takeWindow();
                        if (tail) windows.push(tail);
                        resolve({ durationMs: clock() - started, renderCpuMs: cpu,
                            gpu: { available: timer.available === true, windows, frames: windows.reduce((n, row) => n + row.frames, 0) } });
                    } else rafId = requestAnimationFrame(tick);
                } catch (error) { reject(error); }
            };
            rafId = requestAnimationFrame(tick);
        });
    } finally {
        try {
            if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
        } finally {
            try { if (wrapped) renderer.render = originalRender; }
            finally {
                try { timer?.dispose(); }
                finally { debug.setGpuFrameTimerEnabled(true); }
            }
        }
    }
}

function browserSource(seconds) {
    return `(${diagnosticInPage.toString()})(${JSON.stringify(seconds)}, (${createGpuFrameTimer.toString()}))`;
}

function median(values) {
    const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function readMetrics(rows) {
    const values = Object.fromEntries(METRIC_NAMES.map(name => {
        const value = rows.find(row => row.name === name)?.value;
        return [name, Number.isFinite(value) ? value * 1000 : null];
    }));
    return values;
}

export function acceptanceDiagnosticSource(seconds = 10) {
    return browserSource(seconds);
}

export function acceptanceDiagnosticSourceHash(seconds = 10) {
    return createHash('sha256').update(acceptanceDiagnosticSource(seconds)).digest('hex');
}

export async function captureAcceptanceDiagnostic(page, { seconds = 10, outputProfile = null } = {}) {
    if (!page || typeof page.evaluate !== 'function') throw new TypeError('page.evaluate is required');
    if (!Number.isFinite(seconds) || seconds <= 0) throw new TypeError('seconds must be a finite positive number');
    const cdp = await page.context().newCDPSession(page);
    let profilerEnabled = false;
    let profilerStarted = false;
    let profile = null;
    try {
        await cdp.send('Performance.enable');
        const before = readMetrics((await cdp.send('Performance.getMetrics')).metrics || []);
        if (outputProfile) {
            await cdp.send('Profiler.enable'); profilerEnabled = true;
            await cdp.send('Profiler.start'); profilerStarted = true;
        }
        const captured = await page.evaluate(acceptanceDiagnosticSource(seconds));
        const after = readMetrics((await cdp.send('Performance.getMetrics')).metrics || []);
        if (profilerStarted) {
            profile = (await cdp.send('Profiler.stop')).profile;
            profilerStarted = false;
            await writeFile(outputProfile, JSON.stringify(profile));
        }
        const deltaMs = Object.fromEntries(METRIC_NAMES.map(name => [name,
            before[name] !== null && after[name] !== null && after[name] >= before[name] ? after[name] - before[name] : null]));
        const taskMs = deltaMs.TaskDuration;
        const nonTask = taskMs !== null && captured?.durationMs > 0
            ? Math.max(0, Math.min(1, 1 - taskMs / captured.durationMs)) : null;
        const gpu = captured?.gpu || { available: false, windows: [], frames: 0 };
        const gpuWindows = Array.isArray(gpu.windows) ? gpu.windows : [];
        return { diagnostic: true, durationMs: captured?.durationMs ?? null,
            renderCPU: summarizeIntervals(captured?.renderCpuMs),
            gpu: { available: gpu.available === true,
                windows: gpuWindows,
                frames: Number.isInteger(gpu.frames) ? gpu.frames : 0,
                medianWindowMs: median(gpuWindows.map(row => row?.medianMs)) },
            taskMetrics: { before, after, deltaMs },
            approximateNonTaskFraction: nonTask,
            profilePath: outputProfile || null };
    } finally {
        if (profilerStarted) {
            try { await cdp.send('Profiler.stop'); } catch {}
        }
        if (profilerEnabled) {
            try { await cdp.send('Profiler.disable'); } catch {}
        }
        await cdp.detach();
    }
}
