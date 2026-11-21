import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { GTA_OBSTACLE_POLICY } from '../core/gta-config.js';

const CAB_SOURCE = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');

test('GTA starts ambient people visible and lets H toggle them', () => {
    assert.match(
        CAB_SOURCE,
        /cabState\.walkPedestriansEnabled = sessionCapabilityEnabled\([\s\S]{0,160}SESSION_CAPABILITY\.AMBIENT_PEDESTRIANS/,
    );
    assert.match(CAB_SOURCE, /if \(k === 'h' && cabState\.walkMode\)/);
    assert.match(
        CAB_SOURCE,
        /arePedestriansEnabled: \(\) => !cabState\.walkMode\s*\|\| cabState\.walkPedestriansEnabled,/,
    );
});

test('GTA ambient people remain non-colliding and non-destructible', () => {
    assert.deepEqual(GTA_OBSTACLE_POLICY.person, {
        class: 'non-interactive-person',
        destructive: false,
        collision: false,
    });
});
