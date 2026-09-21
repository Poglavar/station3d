// The one loading screen shows its per-layer diagnostics only when ?stats=1 asks for
// them, and a free-roam start names itself as mode over place.
import test from 'node:test';
import assert from 'node:assert/strict';

import { freeRoamLoadingHeading, loadingDiagnosticsAllowed } from '../core/loading-curtain-policy.js';

test('the layer breakdown stays hidden everywhere, localhost included, unless ?stats=1 asks for it', () => {
    assert.equal(loadingDiagnosticsAllowed({ search: '?lang=hr&heading=105&elevation=1' }), false);
    assert.equal(loadingDiagnosticsAllowed({ search: '' }), false);
    assert.equal(loadingDiagnosticsAllowed({ search: '?stats=1' }), true);
    assert.equal(loadingDiagnosticsAllowed({ search: '?lang=hr&stats=1' }), true);
    assert.equal(loadingDiagnosticsAllowed({ search: '?stats=0' }), false);
    assert.equal(loadingDiagnosticsAllowed(), false);
});

test('a free-roam start reads as mode over place, falling back to the start-point name', () => {
    assert.deepEqual(freeRoamLoadingHeading({ modeLabel: 'Sloboda', placeLabel: 'Zagreb', fallbackPlace: 'Tvoja početna točka' }),
        { eyebrow: 'Sloboda', headline: 'Zagreb' });
    assert.deepEqual(freeRoamLoadingHeading({ modeLabel: 'Sloboda', placeLabel: '', fallbackPlace: 'Tvoja početna točka' }),
        { eyebrow: 'Sloboda', headline: 'Tvoja početna točka' });
    assert.deepEqual(freeRoamLoadingHeading(), { eyebrow: '', headline: '' });
});
