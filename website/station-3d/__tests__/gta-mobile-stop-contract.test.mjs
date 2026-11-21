// Locks the GTA stop/exit interaction so the touch Stop control cannot regress
// into a momentary rear handbrake that neither stops the car nor enables exit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the mobile Stop button requests a latched service stop', async () => {
    const source = await readFile(new URL('../ui/walk-controls.js', import.meta.url), 'utf8');
    assert.match(source, /gtaStopBtnEl/);
    assert.match(source, /bindActivateControl\(gtaStopBtn, \(\) => gtaHandlers\.onStop\?\.\(\)\)/);
    assert.doesNotMatch(source, /bindHoldControl\(gtaStopBtn,\s*' '\)/);
    assert.match(source, /t\('gta\.mobile\.stop'\)/);
});

test('cab and GTA session wire Stop to braking and moving exit requests it', async () => {
    const [cabSource, gtaSource] = await Promise.all([
        readFile(new URL('../modes/cab.js', import.meta.url), 'utf8'),
        readFile(new URL('../modes/gta.js', import.meta.url), 'utf8'),
    ]);
    assert.match(cabSource, /onStop:\s*\(\) => state\.cabState\?\.controllerRouter\?\.requestStop\?\.\(\)/);
    assert.match(gtaSource, /function requestStop\(\)/);
    assert.match(gtaSource, /occupant\.lastFailure === 'vehicle-moving'[\s\S]{0,260}requestStop\(\)/);
    assert.match(gtaSource, /pendingExitWalkState = walkState \|\| null;[\s\S]{0,120}requestStop\(\)/);
    assert.match(gtaSource, /function completePendingExitIfStopped\(pose\)/);
    assert.match(gtaSource, /completePendingExitIfStopped\(pose\) \? null : pose/);
    assert.match(gtaSource, /requestStop,/);
    assert.match(gtaSource, /shouldReleaseLatchedStopOnKeyDown\(key,\s*\{\s*repeat\s*\}\)/);
    assert.doesNotMatch(
        gtaSource,
        /\['w', 's', 'arrowup', 'arrowdown'\]\.includes\(key\)\s*&&\s*!controls\.has\(key\)/,
        'a stale held-key set must not veto a new physical throttle press',
    );
    assert.match(
        cabSource,
        /handleKeyDown\?\.\(key,\s*\{\s*repeat:\s*phase === 'repeat'\s*\}\)/,
        'semantic action phases must preserve physical repeat metadata for the latched-stop policy',
    );
    assert.match(cabSource, /e\.repeat \? 'repeat' : 'press'/);
    assert.match(cabSource, /onAutomaticExit:\s*\(\) => \{[\s\S]{0,180}completeGtaVehicleExit\(cabState, 'vehicle-auto-exit'\)/);
    assert.match(
        cabSource,
        /shouldHandleVehicleResetKeyDown\(k,\s*e\)/,
        'Ctrl/Cmd/modified R must reach the browser instead of resetting the car',
    );
});
