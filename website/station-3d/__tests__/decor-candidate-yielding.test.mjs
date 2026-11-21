import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
    fileURLToPath(new URL('../world/decor.js', import.meta.url)),
    'utf8',
);

test('crossing candidate filtering yields rejected square-bound entries', () => {
    const crossings = SRC.slice(
        SRC.indexOf('async function buildCrossingsGroup'),
        SRC.indexOf('// Fringe colour'),
    );
    const filterLoop = crossings.slice(
        crossings.indexOf('for (const entry of candidates)'),
        crossings.indexOf('if (nearbyCandidates.length === 0)'),
    );

    assert.doesNotMatch(filterLoop, /\bcontinue;/,
        'a rejected circular-window candidate must not bypass the scheduler');
    assert.match(
        filterLoop,
        /if \(\(offsetX \* offsetX \+ offsetZ \* offsetZ\) <= RADIUS_M \* RADIUS_M\)[\s\S]*?nearbyCandidates\.push[\s\S]*?await maybeYieldBuild\(yieldState, shouldCancel, 'crossings'\)/,
    );
    assert.match(
        crossings,
        /await waitForPublishedRoadFormation\([\s\S]*?\)\)\) return null;\s*resetBuildYieldState\(yieldState\);\s*const nearby = \[\];/,
        'terrain evidence starts a fresh timing slice after the dependency wait',
    );
});

test('Dalmatian natural-prop rejection paths still reach the scheduler', () => {
    const dalmatian = SRC.slice(
        SRC.indexOf('async function buildDalmatianNaturalProps'),
        SRC.indexOf('const group = new THREE.Group()',
            SRC.indexOf('async function buildDalmatianNaturalProps')),
    );

    assert.match(dalmatian, /candidatePlacement:\s*\{/,
        'candidate work has one exit that cannot skip the scheduler');
    assert.ok(
        (dalmatian.match(/break candidatePlacement;/g) || []).length >= 7,
        'sea, mask, corridor, road, building, slope, and evidence rejects use the bounded exit',
    );
    assert.match(
        dalmatian,
        /\n        \}\n        if \(!\(await maybeYieldBuild\(yieldState, shouldCancel, 'dalmatian'\)\)\) return null;\n    \}/,
        'the scheduler visit is outside the labelled placement block',
    );
});

test('decor scheduler attributes CPU rather than Promise continuation wall time', () => {
    const scheduler = SRC.slice(
        SRC.indexOf('function resetBuildYieldState'),
        SRC.indexOf('function indexCell'),
    );
    assert.match(scheduler, /yieldState\.cpuSliceMs \+= stepMs/);
    assert.match(
        scheduler,
        /function resetBuildStepClockBeforeContinuation[\s\S]*?queueMicrotask\(reset\)/,
        'an immediate async return excludes intervening microtask work from the next step',
    );
    assert.match(
        scheduler,
        /reportOutOfLoopWork\(`decor:\$\{label\}`, yieldState\.cpuSliceMs\)/,
        'reported outside work is accumulated synchronous CPU',
    );
    assert.doesNotMatch(
        scheduler,
        /reportOutOfLoopWork\(`decor:\$\{label\}`, nowMs\(\) - yieldState\.frameStartMs\)/,
        'wall time across animation-frame waits is never reported as decor work',
    );
});
