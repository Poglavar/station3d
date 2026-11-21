// Finishing the campaign used to be silent: the save flipped to completed, the
// tower world effect committed, and the screen went straight back to gameplay
// with a blank objective card. Also covers the two menu papercuts found in the
// same playthrough — a summary printed twice from two different strings, and a
// native browser confirm() behind Restart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('completing the campaign shows the player an end card', () => {
    const director = read('../core/campaign-director.js');
    assert.match(director, /case 'campaign\.complete':\s*\n\s*view\.showCompleted\(\{/);
    // A view that does not implement it must not throw the director's dispatch.
    assert.match(director, /showCompleted: noop,/);

    const ui = read('../ui/campaign-ui.js');
    assert.match(ui, /function showCompleted\(input\) \{/);
    assert.match(ui, /openOverlay\('completed'\)/);
    assert.match(ui, /^\s*showCompleted,$/m, 'showCompleted must be on the exported view');
    // Both ways out of the end card.
    assert.match(ui, /t\('campaign\.completed\.freeRoam'\)/);
    assert.match(ui, /t\('campaign\.restart'\)/);
});

test('the end card is written in both shipped languages', () => {
    const i18n = read('../core/i18n.js');
    for (const key of [
        'campaign.completed.eyebrow',
        'campaign.completed.title',
        'campaign.completed.body',
        'campaign.completed.freeRoam',
    ]) {
        const uses = i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}'`, 'g')) || [];
        assert.equal(uses.length, 2, `${key} needs an English and a Croatian string`);
    }
});

test('Restart asks inside the campaign overlay, not in a browser dialog', () => {
    const ui = read('../ui/campaign-ui.js');
    assert.doesNotMatch(ui, /window\.confirm/, 'a native confirm blocks the page and cannot be styled');
    assert.match(ui, /confirmingRestartId = definition\.id;/);
    assert.match(ui, /t\('campaign\.restartConfirm'\)/);
    // Reopening the menu must not resume a half-answered question.
    assert.match(ui, /if \(!openOverlay\('menu'\)\) return;\s*\n\s*confirmingRestartId = null;/);
    // And the confirmation owns the only Cancel while it is up.
    assert.match(ui, /if \(confirmingRestartId \|\| confirmingExitId\) return;\s*\n\s*const footer = actionRow\(card\);/);
});

test('the menu states the campaign summary once', () => {
    const ui = read('../ui/campaign-ui.js');
    const menu = ui.slice(ui.indexOf('function showMenu(input)'), ui.indexOf('function removeChapterTransition'));
    // The wrapper panel carries no body of its own outside the corrupt-save case.
    assert.match(menu, /input\.corruptError \? t\('campaign\.saveCorrupt'\) : ''/);
    const summaryUses = menu.match(/localized\(definition\.metadata\.summary\)/g) || [];
    assert.equal(summaryUses.length, 1, 'the summary belongs to the campaign card alone');
});

test('the objective card moves the minimap instead of covering it', () => {
    const ui = read('../ui/campaign-ui.js');
    assert.match(ui, /function markObjectiveVisible\(visible\) \{/);
    assert.match(ui, /classList\?\.toggle\('has-campaign-objective', !!visible\)/);
    // Shown when the card appears, cleared when it goes.
    assert.match(ui, /objectiveEl\.classList\.remove\('hidden'\);\s*\n\s*markObjectiveVisible\(true\);/);
    assert.match(ui, /objectiveEl\?\.classList\.add\('hidden'\);\s*\n\s*markObjectiveVisible\(false\);/);

    const minimap = read('../ui/minimap.js');
    assert.match(minimap, /'top:var\(--station3d-minimap-top, 12px\)'/);
    const css = read('../ui/shell.css');
    assert.match(css, /#station3DContainer\.has-campaign-objective \{\s*\n\s*--station3d-minimap-top:/);
});

test('the failure card speaks the player\'s language, never the adapter error text', () => {
    const ui = read('../ui/campaign-ui.js');
    const failure = ui.slice(ui.indexOf('function showFailure(input)'), ui.indexOf('function showCompleted(input)'));
    assert.doesNotMatch(failure, /error\??\.message/, 'developer error text must not reach the card');
    assert.match(failure, /input\.error \? 'campaign\.failure\.worldUnavailable' : 'campaign\.failure\.body'/);
    assert.match(failure, /const body = t\(failureKey\);/);
    assert.match(failure, /console\.error\('\[campaign\] scene failed to open', input\.error\)/, 'the cause still reaches the console');
    const i18n = read('../core/i18n.js');
    for (const key of ['campaign.failure.worldUnavailable', 'campaign.saveOutdated']) {
        const uses = i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}'`, 'g')) || [];
        assert.equal(uses.length, 2, `${key} needs an English and a Croatian string`);
    }
});

test('an outdated save is offered Restart in the menu instead of a dead Continue button', () => {
    const ui = read('../ui/campaign-ui.js');
    const menu = ui.slice(ui.indexOf('function showMenu(input)'), ui.indexOf('function removeChapterTransition'));
    assert.match(menu, /const outdated = !!run && Number\(run\.campaignVersion\) !== Number\(definition\.version\);/);
    assert.match(menu, /if \(!outdated\) row\.appendChild\(button\(\s*\n\s*t\(completed \? 'campaign\.menu\.freeRoam' : 'campaign\.continue'\),/);
    assert.match(menu, /notice\.textContent = t\('campaign\.saveOutdated'\)/);
    assert.match(ui, /const text = options\.key \? t\(options\.key\) : localized\(message\);/, 'toasts can carry an i18n key');
    const director = read('../core/campaign-director.js');
    assert.doesNotMatch(director, /save version is unsupported/, 'continue must not throw on a version bump');
    assert.match(director, /view\.showToast\('', \{ key: 'campaign\.saveOutdated' \}\);/);
    const css = read('../ui/shell.css');
    assert.match(css, /\.station-3d-campaign-menu-notice \{/);
});

test('a finished run is offered free roam instead of a Continue into a spent epilogue', () => {
    const ui = read('../ui/campaign-ui.js');
    const menu = ui.slice(
        ui.indexOf('function showMenu(input)'),
        ui.indexOf('function removeChapterTransition'),
    );
    assert.match(menu, /const completed = run\.completed === true;/);
    assert.match(menu, /t\(completed \? 'campaign\.menu\.freeRoam' : 'campaign\.continue'\)/);
    assert.match(menu, /t\('campaign\.restart'\)/, 'Restart stays available on a finished run');

    // …and Continue on such a run reopens the final world without rehydrating
    // the epilogue, which would replay a conversation the player already spent.
    const director = read('../core/campaign-director.js');
    assert.match(
        director,
        /if \(saved\.completed === true\) \{\s*\n\s*if \(await openScene\(activeRun\.currentSceneId\)\) \{[\s\S]*?view\.hideObjective\(\);/,
    );
    const continueBlock = director.slice(
        director.indexOf('async continue(campaignId)'),
        director.indexOf('async restart(campaignId)'),
    );
    const rehydrates = continueBlock.match(/await rehydrateScene\(\)/g) || [];
    assert.equal(rehydrates.length, 1, 'only the unfinished path rehydrates its scene');
});
