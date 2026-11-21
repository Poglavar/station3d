// The thumb pads: touch-safe targets that stay out of the way of the world
// they sit on. Both clusters share one bottom edge, the action button is above
// the booster (the thumb rests on the action), and the idle pad is translucent
// so a live 3D scene reads through it until a finger lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../ui/walk-controls.js', import.meta.url), 'utf8');

const constant = name => {
    const match = source.match(new RegExp(`const ${name} = (\\d+);`));
    assert.ok(match, `${name} is declared`);
    return Number(match[1]);
};

test('every pad is a touch-safe target, sized from one set of constants', () => {
    assert.ok(constant('PAD_BUTTON_PX') >= 48, 'walk keys clear the 48 px touch minimum');
    assert.ok(constant('ACTION_BUTTON_PX') >= constant('PAD_BUTTON_PX'), 'the action keys are at least as big');
    // The sizes reach the buttons through the constants, not hand-typed pixels.
    assert.match(source, /`min-width:\$\{PAD_BUTTON_PX\}px`/);
    assert.match(source, /makeButton\('⚡', `width:\$\{ACTION_BUTTON_PX\}px/);
    assert.match(source, /makeButton\('E', `width:\$\{ACTION_BUTTON_PX\}px/);
    assert.doesNotMatch(source, /min-width:52px|min-height:64px/, 'no stale hand-typed pad sizes');
});

test('both clusters sit on the same bottom edge, action above booster', () => {
    const edge = constant('PAD_EDGE_PX');
    assert.ok(edge >= 12, 'the pads keep clear of the very screen edge');
    const bottoms = [...source.matchAll(/`bottom:\$\{PAD_EDGE_PX\}px`/g)];
    assert.equal(bottoms.length, 2, 'the d-pad and the action column share one baseline');
    assert.doesNotMatch(source, /'bottom:62px'|'82px'/, 'the action column no longer floats above the pads');
    // The runtime mode switch positions the column too: it must use the
    // same constant, or it silently undoes the layout above.
    assert.match(source, /containerEl\.right\.style\.bottom = `\$\{PAD_EDGE_PX\}px`;/);
    const order = ['gtaInteractBtn', 'jetpackBtn', 'boostBtn']
        .map(name => source.indexOf(`rightPanel.appendChild(${name})`));
    assert.ok(order.every(index => index > 0), 'every action button is in the column');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'E is appended first, the booster last');
});

test('an idle pad is translucent and its glyph stays legible over the scene', () => {
    const idle = source.match(/const PAD_IDLE_BG = 'rgba\(\d+,\d+,\d+,([\d.]+)\)';/);
    assert.ok(idle, 'the idle background is named');
    assert.ok(Number(idle[1]) < 0.5, `idle pads let the world through (alpha ${idle[1]})`);
    assert.match(source, /'text-shadow:0 1px 3px rgba\(0,0,0,0\.55\)'/);
    assert.match(source, /setHoldBackgrounds\(btn, PAD_IDLE_BG, PAD_PRESSED_BG\)/);
    assert.match(source, /display:flex;gap:4px;justify-content:center/, 'd-pad rows stay centred');
});
