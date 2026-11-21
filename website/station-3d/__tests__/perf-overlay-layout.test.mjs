// Locks the equal-height, independently scrolling halves of the developer
// performance overlay and their shared dark scrollbar treatment.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const view = await readFile(new URL('../ui/perf-overlay-view.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../ui/shell.css', import.meta.url), 'utf8');
const animate = await readFile(new URL('../scene/animate.js', import.meta.url), 'utf8');

test('both performance panes have equal stable flex height', () => {
    assert.match(view, /liveEl\.style\.cssText = 'flex:1 1 0;height:0;/);
    assert.match(view, /logPane\.style\.cssText = 'flex:1 1 0;height:0;/);
    assert.match(view, /logPane\.append\(logHeader, logEl\)/);
    assert.match(
        view,
        /setVisible\(visible\) \{ root\.style\.display = visible \? 'flex' : 'none'; \}/,
        'showing the overlay must restore its flex layout instead of block',
    );
});

test('both performance scroll panes use the dark themed scrollbar', () => {
    assert.equal((view.match(/station3d-perf-scroll-pane/g) || []).length, 2);
    assert.match(css, /\.station3d-perf-scroll-pane\s*\{[^}]*scrollbar-color:\s*#55616b #171b1f/s);
    assert.match(css, /\.station3d-perf-scroll-pane::\-webkit-scrollbar-thumb/);
});

test('performance diagnostics mount before the first world frame can stall', () => {
    assert.match(
        animate,
        /export function startLoop\(\) \{[\s\S]*?maybeInitStats\(\);\s*\/\/[^]*?maybeInitPerfOverlay\(\);\s*const loop/,
    );
});

test('hiding diagnostics survives a Station3D scene replacement', () => {
    assert.match(animate, /stats\.dom\.style\.display = overlaysHidden \? 'none' : '';/);
    const stopLoop = animate.slice(animate.indexOf('export function stopLoop()'));
    assert.doesNotMatch(
        stopLoop,
        /overlaysHidden = false;/,
        'closing one campaign scene must not discard the player\'s F-key choice',
    );
});

test('disabled production diagnostics do not allocate full activity snapshots per frame', () => {
    assert.match(animate, /const frameBackground = perfOverlay \? describeBackgroundPressure\(\) : ''/);
    assert.match(animate, /background: frameBackground/);
    assert.match(animate, /layers: perfOverlay \? describeFrameLayers\(perfLayerThisFrame\) : ''/);
    assert.match(animate, /stationary: getFrameChunkMotionState\(\) === 'stationary'/);
    assert.doesNotMatch(
        animate,
        /stationary: getFrameChunkSchedulerSnapshot\(\)\.motionState/,
    );
});

test('the sticky stutter log does not force a synchronous height layout', () => {
    assert.match(view, /const heightBefore = stickToTop \? 0 : logEl\.scrollHeight/);
    assert.match(view, /if \(stickToTop\) logEl\.scrollTop = 0;/);
    assert.match(view, /else logEl\.scrollTop \+= logEl\.scrollHeight - heightBefore;/);
    assert.match(view, /const STUTTER_ROWS_PER_UPDATE = 4/);
    assert.match(view, /fresh\.slice\(0, STUTTER_ROWS_PER_UPDATE\)/);
    assert.match(view, /renderedAtMs = renderFresh\.at\(-1\)\?\.atMs \?\? newestAtMs/);
});

test('performance panes are never blank and live updates patch stable nodes', () => {
    assert.match(view, /warming up · waiting for first complete 1 s window/);
    assert.match(view, /STUTTERS[^]*waiting for first complete window/);
    assert.match(view, /function patchSegments\(/);
    assert.match(view, /let liveBlocks = \[\]/);
    assert.match(view, /if \(span\.textContent !== text\) span\.textContent = text/);
    assert.doesNotMatch(view, /document\.createDocumentFragment\(\)/);
    assert.doesNotMatch(view, /function renderLive\(sections\) \{\s*liveEl\.textContent = ''/);
});
