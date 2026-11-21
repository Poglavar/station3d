import test from 'node:test';
import assert from 'node:assert/strict';

import {
    gtaTireEffectTargets,
    skidMarkQuad,
} from '../core/gta-tire-effects.js';

test('ordinary rolling is quiet and cannot paint braking tracks', () => {
    const targets = gtaTireEffectTargets({
        speedMps: 20,
        contactCount: 4,
        maxForwardImpulseNs: 5,
        maxSideImpulseNs: 3,
    });
    assert.equal(targets.braking, 0);
    assert.equal(targets.cornering, 0);
    assert.equal(targets.squeal, 0);
});

test('high-speed service braking and handbraking produce bounded tire feedback', () => {
    const service = gtaTireEffectTargets({
        speedMps: 80 / 3.6,
        serviceBraking: true,
        maxForwardImpulseNs: 42,
        contactCount: 4,
    });
    const handbrake = gtaTireEffectTargets({
        speedMps: 80 / 3.6,
        handbrake: true,
        maxForwardImpulseNs: 32,
        contactCount: 4,
    });
    assert.ok(service.braking > 0.65);
    assert.ok(handbrake.braking >= service.braking);
    assert.ok(service.squeal > 0.65 && service.squeal <= 1);
    assert.ok(handbrake.squeal <= 1);
});

test('low-speed braking does not squeal or stamp a visible mark', () => {
    const targets = gtaTireEffectTargets({
        speedMps: 1.5,
        serviceBraking: true,
        maxForwardImpulseNs: 42,
        contactCount: 4,
    });
    assert.equal(targets.braking, 0);
    assert.equal(targets.squeal, 0);
});

test('urban-speed hard inputs stay quiet below the tyre-squeal threshold', () => {
    const targets = gtaTireEffectTargets({
        speedMps: 20 / 3.6,
        serviceBraking: true,
        handbrake: true,
        maxForwardImpulseNs: 60,
        maxSideImpulseNs: 60,
        contactCount: 4,
    });
    assert.equal(targets.speedFactor, 0);
    assert.equal(targets.braking, 0);
    assert.equal(targets.cornering, 0);
    assert.equal(targets.squeal, 0);
});

test('skid mark quads preserve both endpoint elevations and requested width', () => {
    const positions = skidMarkQuad(
        { x: 0, y: 2, z: 0 },
        { x: 0, y: 2.1, z: 1 },
        0.2,
        0.01,
    );
    assert.equal(positions.length, 18);
    assert.ok(Math.abs(Math.abs(positions[0] - positions[6]) - 0.2) < 1e-6);
    assert.ok(Math.abs(positions[1] - 2.01) < 1e-6);
    assert.ok(Math.abs(positions[4] - 2.11) < 1e-6);
});
