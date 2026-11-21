// Every 3D session asks before it is closed: Escape, the × button and the
// backdrop go through one guarded request, and the campaign menu's own exit
// asks in its card. Only the public Station3D.close() API closes at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shouldConfirmSessionExit } from '../core/session-exit-policy.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('every live or loading simulation requires an exit confirmation; an empty modal does not', () => {
    for (const preset of ['walk', 'gta', 'cab', 'tram', 'campaign', '']) {
        assert.equal(shouldConfirmSessionExit({ sessionPresetId: preset }), true, `${preset || 'unnamed'} session`);
    }
    assert.equal(shouldConfirmSessionExit(null), false, 'nothing running: the campaign menu alone closes freely');
    for (const mode of ['walk', 'gta', 'cab']) {
        assert.equal(shouldConfirmSessionExit(null, mode), true, `a loading ${mode} session is protected`);
    }
    assert.equal(shouldConfirmSessionExit({ sessionPresetId: 'walk' }, 'static'), false,
        'the station preview replaces the session and is not a simulation');
});

test('Escape, the top-right close button and the backdrop share the guarded close request', () => {
    const modal = read('../ui/modal.js');
    const index = read('../index.js');

    assert.match(index, /ensureModalDom\(requestHostExit, \{\s*shouldConfirmClose: \(\) => shouldConfirmSessionExit\(state\.cabState, pendingOpenMode\)/);
    assert.match(index, /pendingOpenMode = method === 'openWalk' \? 'walk'/);
    assert.match(modal, /closeBtnEl\.addEventListener\('click', requestModalClose\)/);
    assert.match(modal, /if \(e\.target === modalEl\) requestModalClose\(\)/);
    assert.match(modal, /const embedded = [^;]+;\s*if \(!embedded\) \{[\s\S]*?requestModalClose\(\)/);
    assert.match(modal, /if \(await askToLeaveSession\(\)\) onCloseRequested\?\.\(\)/);
    assert.doesNotMatch(modal, /window\.confirm|\bconfirm\(/);
    // Direct callers still own deliberate lifecycle shutdown without a UI prompt.
    assert.match(index, /open, openCab, openWalk, openGta, close,/);
});

test('the question sits above every campaign cover, is accessible, safe by default and bilingual', () => {
    const modal = read('../ui/modal.js');
    const i18n = read('../core/i18n.js');
    const css = read('../ui/shell.css');

    assert.match(modal, /document\.body\.appendChild\(exitConfirmEl\)/, 'on <body>, outside the modal stacking context');
    assert.match(css, /\.station-3d-exit-confirm \{[^}]*position: fixed;[^}]*z-index: 4400;/);
    assert.match(css, /\.station-3d-campaign-curtain \{[^}]*z-index: 4200;/, 'the cover it must clear');
    assert.match(modal, /card\.setAttribute\('role', 'dialog'\)/);
    assert.match(modal, /card\.setAttribute\('aria-modal', 'true'\)/);
    assert.match(modal, /exitConfirmNoEl\.focus\(\)/);
    assert.match(modal, /event\.key !== 'Tab'/);
    assert.match(modal, /if \(exitConfirmPromise\) \{[\s\S]*?finishExitConfirmation\(false\)/);

    for (const key of [
        'session.exitConfirmTitle',
        'session.exitConfirmMessage',
        'session.exitNo',
        'session.exitYes',
        'campaign.exitConfirm',
    ]) {
        const uses = i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || [];
        assert.equal(uses.length, 2, `${key} needs an English and a Croatian string`);
    }
    assert.doesNotMatch(i18n, /'walk\.exitConfirm/, 'the walk-only copy is gone');
});

test('the campaign menu and the failure card ask before exiting to the map', () => {
    const ui = read('../ui/campaign-ui.js');
    assert.match(ui, /confirmingExitId = definition\.id;\s*render\(\);/, 'the menu Exit button only arms the question');
    assert.match(ui, /if \(confirmingExitId === definition\.id\) \{[\s\S]*?t\('campaign\.exitConfirm'\)[\s\S]*?closeOverlay\('exit'\);\s*await input\.exit\(\);/);
    assert.match(ui, /if \(confirmingRestartId \|\| confirmingExitId\) return;/);
    const failure = ui.slice(ui.indexOf('function showFailure('));
    const question = failure.indexOf("t('campaign.exitConfirm')");
    assert.ok(question > 0, 'the failure card asks too');
    assert.doesNotMatch(failure.slice(0, question), /closeOverlay\('exit'\)/, 'no direct exit before the question');
    assert.match(failure.slice(question), /closeOverlay\('exit'\);\s*await input\.exit\?\.\(\);/);
});
