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

test('auto DPR ignores compiler/stall frames and uses hysteresis for stable GPU pressure', () => {
    const governor = createAutoDprGovernor({
        initialDpr: 1.2,
        minDpr: 0.8,
        maxDpr: 1.5,
        downWindows: 3,
        upWindows: 3,
    });
    for (let index = 0; index < 10; index++) {
        governor.observe({
            frameAvgMs: 40,
            renderMs: 4,
            hooksMs: 2,
            stallMs: 34,
            peakFrameMs: 120,
            compilerPending: true,
        });
    }
    assert.equal(governor.snapshot().dpr, 1.2);
    const slow = {
        frameAvgMs: 22,
        renderMs: 16,
        hooksMs: 2,
        stallMs: 3,
        peakFrameMs: 24,
    };
    governor.observe(slow);
    governor.observe(slow);
    assert.equal(governor.observe(slow).changed, true);
    assert.equal(governor.snapshot().dpr, 1.1);
    const fast = {
        frameAvgMs: 12,
        renderMs: 7.5,
        hooksMs: 2,
        stallMs: 2,
        peakFrameMs: 14,
    };
    governor.observe(fast);
    governor.observe(fast);
    assert.equal(governor.observe(fast).changed, true);
    assert.equal(governor.snapshot().dpr, 1.2);
});
