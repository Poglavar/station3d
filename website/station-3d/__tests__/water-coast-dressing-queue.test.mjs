import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const WATER = await readFile(new URL('../world/water.js', import.meta.url), 'utf8');

test('terrain-driven shoreline rebuilds leave the frame hook for a bounded queue', () => {
    assert.match(WATER, /createFrameChunkQueue\(\{[\s\S]*?label: 'water-dressing'/);
    assert.match(WATER, /createCoastDressingBuildTask/);
    assert.match(WATER, /item\.geometryTask\.step\(\) === 'more'/);
    assert.match(WATER, /maxItemsPerFrame: 1/);
    const onFrame = WATER.slice(
        WATER.indexOf('onFrame(pose, local)'),
        WATER.indexOf('endSession()', WATER.indexOf('onFrame(pose, local)')),
    );
    assert.match(onFrame, /scheduleCoastDressingBuild/);
    assert.doesNotMatch(onFrame, /buildCoastDressingGroup/);
});

test('shoreline replacement is stale-safe, upload-bounded, and atomic', () => {
    const schedule = WATER.slice(
        WATER.indexOf('function scheduleCoastDressingBuild'),
        WATER.indexOf('// Fetch water + pavement'),
    );
    assert.match(schedule, /coastDressingBuildIsCurrent\(build\)/);
    assert.match(schedule, /prewarmDetachedObject/);
    assert.match(schedule, /frameChunkObserverIsMoving\(\)/);
    assert.match(schedule, /FRAME_CHUNK_DEFER_ITEM/);
    assert.match(schedule, /renderer\.initTexture\?\.\(item\.maskTexture\)/,
        'the recurring 2048px ownership mask uploads before publication');
    assert.match(schedule, /uploadGeometry: false/,
        'the pathological whole-infill offscreen upload stays disabled');
    const attach = schedule.indexOf('build.parent.add(build.candidate)');
    const retire = schedule.indexOf('disposeGroup(previous)', attach);
    assert.ok(attach >= 0 && retire > attach,
        'the previous complete generation retires only after candidate attachment');
    assert.match(WATER, /build\.candidate && !build\.published/,
        'a cancelled or stale detached candidate is disposed exactly once');
});

test('terrain revisions cancel in-flight shoreline work and teardown drains it', () => {
    const begin = WATER.slice(WATER.indexOf('beginSession(ctx)'), WATER.indexOf('onFrame(pose, local)'));
    const end = WATER.slice(WATER.indexOf('endSession() {'));
    assert.match(begin, /coastDressingRevision \+= 1;[\s\S]*?cancelCoastDressingBuild\(\)/);
    assert.match(begin, /terrainReference\?\.onChange\?\.\([\s\S]*?cancelCoastDressingBuild\(\)/);
    assert.match(end, /coastDressingRevision \+= 1;[\s\S]*?cancelCoastDressingBuild\(\)/);
    assert.match(end, /coastDressingQueue\.clear\(\)/);
});
