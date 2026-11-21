import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../ui/shell.css', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../ui/dashboard.js', import.meta.url), 'utf8');

function rule(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] || '';
}

test('surroundings loading elements use fixed proportional grids on desktop and mobile', () => {
    const photo = rule('.station-3d-photo-loading');
    const photoTelemetry = rule('.station-3d-photo-loading-telemetry');
    const worldTelemetry = rule('.station-3d-campaign-curtain-telemetry');
    const components = rule('.station-3d-loading-segments');
    const componentLabel = rule('.station-3d-loading-seg-label');
    assert.match(photo, /flex-wrap:\s*wrap/);
    assert.match(photo, /max-width:\s*calc\(100vw\s*-\s*24px\)/);
    assert.match(photoTelemetry, /white-space:\s*nowrap/);
    assert.match(worldTelemetry, /font:[^;]*ui-monospace/);
    assert.match(components, /display:\s*grid/);
    assert.match(components, /repeat\(24,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(components, /width:\s*min\(640px,\s*calc\(100vw\s*-\s*24px\)\)/);
    assert.match(componentLabel, /white-space:\s*normal/);
    assert.match(componentLabel, /overflow-wrap:\s*anywhere/);
    assert.match(dashboard, /columns:\s*24,\s*targetRows:\s*4,\s*minimumSpan:\s*6/);
    assert.match(dashboard, /columns:\s*12,\s*targetRows:\s*5,\s*minimumSpan:\s*4/);
    assert.match(css, /@media\s*\(max-width:\s*480px\)[\s\S]*repeat\(12,\s*minmax\(0,\s*1fr\)\)/);
    assert.doesNotMatch(css, /station-3d-loading-seg[^}]*flex-grow/);
});
