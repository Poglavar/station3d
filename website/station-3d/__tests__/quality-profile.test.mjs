import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assessWebGlCompatibility,
    createAutoDprGovernor,
    createRenderQualityWindow,
    probeQualityProfile,
    resolveQualityProfile,
    STATION3D_QUALITY_PROFILES,
} from '../core/quality-profile.js';

test('quality sampling pairs completed periods with their work without requiring an overlay', () => {
    const window = createRenderQualityWindow(1000);
    window.reset(100);
    window.addFrame({ hooksMs: 2, renderMs: 6, skyMs: 1 }, 16);
    window.addFrame({ hooksMs: 40, renderMs: 8, skyMs: 2 }, 80, 51);
    assert.equal(window.takeSample(1099), null);
    assert.deepEqual(window.takeSample(1100), {
        frameAvgMs: 48, hooksMs: 21, renderMs: 7, stallMs: 18.5,
        peakFrameMs: 80, longTaskMs: 51, stuttered: true,
    });
    assert.equal(window.takeSample(2100), null);
    window.addFrame({ hooksMs: 1, renderMs: 3, skyMs: 1 }, 10);
    assert.deepEqual(window.takeSample(2100), {
        frameAvgMs: 10, hooksMs: 1, renderMs: 3, stallMs: 5,
        peakFrameMs: 10, longTaskMs: 0, stuttered: false,
    });
});

test('quality profiles preserve the published DPR, shadow, and thin-feature budgets', () => {
    assert.equal(STATION3D_QUALITY_PROFILES.high.dprCap, 1.5);
    assert.equal(STATION3D_QUALITY_PROFILES.high.shadowMapSize, 2048);
    assert.equal(STATION3D_QUALITY_PROFILES.medium.dprCap, 1);
    assert.equal(STATION3D_QUALITY_PROFILES.medium.shadowCasterDistanceM, 60);
    assert.equal(STATION3D_QUALITY_PROFILES.medium.thinFeatureDistanceM, 600);
    assert.equal(STATION3D_QUALITY_PROFILES.low.antialias, false);
    assert.equal(STATION3D_QUALITY_PROFILES.low.thinFeatureDistanceM, 400);
});

test('auto capability probe selects a conservative initial profile', () => {
    assert.equal(probeQualityProfile({ maxTextureSize: 4096, hardwareConcurrency: 8 }), 'low');
    assert.equal(probeQualityProfile({ maxTextureSize: 16384, deviceMemoryGb: 8 }), 'medium');
    assert.equal(probeQualityProfile({ maxTextureSize: 16384, deviceMemoryGb: 16, maxSamples: 8 }), 'high');
    assert.deepEqual(resolveQualityProfile('low').profile, STATION3D_QUALITY_PROFILES.low);
});

test('compatibility preflight rejects missing required WebGL features and degrades weak devices', () => {
    assert.deepEqual(assessWebGlCompatibility({ webgl2: false }), {
        supported: false, constrained: false, reasons: ['webgl2-unavailable'],
    });
    assert.deepEqual(assessWebGlCompatibility({
        webgl2: true, maxTextureSize: 1024, stencilBits: 0,
    }), {
        supported: false,
        constrained: false,
        reasons: ['texture-size', 'stencil-unavailable'],
    });
    assert.equal(assessWebGlCompatibility({
        webgl2: true, maxTextureSize: 8192, stencilBits: 8, hardwareConcurrency: 4,
    }).constrained, true);
    assert.equal(probeQualityProfile({
        webgl2: true, maxTextureSize: 8192, stencilBits: 8, hardwareConcurrency: 4,
    }), 'low');
    assert.equal(probeQualityProfile({
        webgl2: true, maxTextureSize: 16384, stencilBits: 8, mobile: true,
    }), 'medium');
});

test('building quality bounds ordinary atlas texels and optional close owners', () => {
    for (const [id, pixels, owners] of [['high', 192, 8], ['medium', 128, 3], ['low', 96, 0]]) {
        const budget = resolveQualityProfile(id).profile.buildings;
        assert.deepEqual(budget, { facadeAtlasMaxEntrySize: pixels, closeFacadeMaxOwners: owners });
        assert.ok(Object.isFrozen(budget));
    }
    assert.equal(resolveQualityProfile('auto', { deviceMemoryGb: 8 }).profile.buildings,
        STATION3D_QUALITY_PROFILES.medium.buildings);
});

test('auto DPR acts only on GPU evidence and steps down under sustained GPU pressure', () => {
    const governor = createAutoDprGovernor({ initialDpr: 1.5, minDpr: 1, maxDpr: 1.5, downWindows: 3 });
    // The 2026-09-23 walk: render-call CPU time ~3.6 ms, background always pending. Without a GPU
    // timer result the window says nothing, however slow the frames.
    for (let index = 0; index < 10; index++) {
        assert.equal(governor.observe({ frameAvgMs: 24, renderMs: 3.6, gpuMs: null, backgroundPending: true }).changed, false);
    }
    assert.equal(governor.snapshot().ignoredWindows, 10);
    const pressure = { frameAvgMs: 21, gpuMs: 19 };
    governor.observe(pressure);
    // A window without evidence between pressure windows neither confirms nor resets the trend.
    governor.observe({ frameAvgMs: 21, gpuMs: null });
    governor.observe(pressure);
    assert.deepEqual(governor.observe(pressure), { changed: true, dpr: 1.4, reason: 'gpu-pressure' });
    // GPU busy but frames still meeting 60 fps is not pressure.
    for (let index = 0; index < 5; index++) governor.observe({ frameAvgMs: 16.7, gpuMs: 15 });
    assert.equal(governor.snapshot().dpr, 1.4);
    for (let index = 0; index < 20; index++) governor.observe(pressure);
    assert.equal(governor.snapshot().dpr, 1, 'never below the profile minimum');
});

test('auto DPR steps up on predicted headroom and probes past DVFS-inflated GPU time', () => {
    const governor = createAutoDprGovernor({
        initialDpr: 1, minDpr: 1, maxDpr: 1.5, downWindows: 3, upWindows: 4, probeWindows: 6, maxProbeWindows: 24,
    });
    // 6 ms at DPR 1 predicts 7.3 ms at 1.1: comfortably inside 60 fps.
    for (let index = 0; index < 3; index++) governor.observe({ frameAvgMs: 8.3, gpuMs: 6 });
    assert.deepEqual(governor.observe({ frameAvgMs: 8.3, gpuMs: 6 }), { changed: true, dpr: 1.1, reason: 'gpu-headroom' });

    // Frames on time but the downclocked GPU reports 13 ms: no predicted headroom, so after the
    // quiet stretch it probes one step up.
    const quiet = { frameAvgMs: 16.7, gpuMs: 13 };
    for (let index = 0; index < 5; index++) assert.equal(governor.observe(quiet).changed, false);
    assert.deepEqual(governor.observe(quiet), { changed: true, dpr: 1.2, reason: 'probe-up' });
    // The probe brings GPU pressure back: return, and wait twice as long before the next probe.
    assert.deepEqual(governor.observe({ frameAvgMs: 22, gpuMs: 18 }), { changed: true, dpr: 1.1, reason: 'probe-rejected' });
    assert.equal(governor.snapshot().probeWait, 12);
    for (let index = 0; index < 11; index++) assert.equal(governor.observe(quiet).changed, false);
    assert.equal(governor.observe(quiet).reason, 'probe-up');
    // A probe that survives its trial windows is kept, and the probe wait resets.
    for (let index = 0; index < 3; index++) governor.observe(quiet);
    assert.equal(governor.snapshot().dpr, 1.2);
    assert.equal(governor.snapshot().probing, false);
    assert.equal(governor.snapshot().probeWait, 6);
});
