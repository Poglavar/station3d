// The bake indicator exists so a twenty-minute settlement wait is visibly a
// wait and not a stall: every phase names itself, the elapsed clock ticks, and
// whatever is still blocking settlement is listed with its count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { campaignBakeStatus, formatBakeElapsed, CAMPAIGN_BAKE_PHASES } from '../core/campaign-bake-status.js';

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('elapsed reads as m:ss and never goes backwards on bad input', () => {
    assert.equal(formatBakeElapsed(0), '0:00');
    assert.equal(formatBakeElapsed(65_000), '1:05');
    assert.equal(formatBakeElapsed(3_601_000), '60:01');
    assert.equal(formatBakeElapsed(-5), '0:00');
    assert.equal(formatBakeElapsed(NaN), '0:00');
});

test('every phase is a known phase and the blocking list is summarised with counts', () => {
    const status = campaignBakeStatus({
        phase: 'settling',
        elapsedMs: 754_000,
        blocking: [
            { label: 'curbs', pending: 249 },
            { label: 'roads', pending: 139 },
            { label: 'surface publications', pending: 1 },
        ],
    });
    assert.equal(status.phase, 'settling');
    assert.equal(status.elapsed, '12:34');
    assert.equal(status.detail, 'curbs 249 · roads 139 · surface publications 1');
    assert.ok(CAMPAIGN_BAKE_PHASES.includes('settling'));
    for (const phase of ['corridor', 'ready', 'settling', 'fixed-point', 'capturing', 'encoding', 'done', 'failed']) {
        assert.ok(CAMPAIGN_BAKE_PHASES.includes(phase), phase);
    }
    assert.equal(campaignBakeStatus({ phase: 'nonsense', elapsedMs: 0 }).phase, 'corridor', 'an unknown phase reads as the first one rather than nothing');
});

test('a free-text detail wins over the blocking list, and an empty list yields no detail', () => {
    assert.equal(campaignBakeStatus({ phase: 'done', elapsedMs: 1000, detail: 'pack.s3pack · 171 MB' }).detail, 'pack.s3pack · 171 MB');
    assert.equal(campaignBakeStatus({ phase: 'ready', elapsedMs: 1000, blocking: [] }).detail, '');
    assert.equal(campaignBakeStatus({ phase: 'failed', elapsedMs: 1000, detail: 'boom', blocking: [{ label: 'x', pending: 1 }] }).detail, 'boom');
    // A wedged item is named on its queue, because that is the only line that
    // tells a wedge from a slow drain.
    assert.equal(campaignBakeStatus({ phase: 'settling', elapsedMs: 0, blocking: [{ label: 'roads', pending: 1, stalled: 'road tile 3_-2 ×1412' }] }).detail, 'roads 1 ⚠ road tile 3_-2 ×1412');
    // A long blocking list stays a pill: the six heaviest, then a count.
    const many = Array.from({ length: 13 }, (_, index) => ({ label: `q${index}`, pending: 13 - index }));
    assert.equal(campaignBakeStatus({ phase: 'settling', elapsedMs: 0, blocking: many }).detail, 'q0 13 · q1 12 · q2 11 · q3 10 · q4 9 · q5 8 · +7');
});

test('the cab drives the indicator through every phase and the dashboard renders it as a pill', () => {
    const cab = read('../modes/cab.js');
    // The corridor phase is the one the indicator is born in; every later
    // phase is an explicit update.
    assert.match(cab, /function beginCampaignBakeStatus[\s\S]*phase: 'corridor'/);
    for (const phase of ['ready', 'settling', 'fixed-point', 'capturing', 'encoding', 'done', 'failed']) {
        assert.match(cab, new RegExp(`updateCampaignBakeStatus\\([^)]*'${phase}'`), `cab reports the ${phase} phase`);
    }
    assert.match(cab, /campaignPackBake: sessionParams\.has\('campaignPackBake'\)/);
    assert.match(cab, /if \(ctx\.campaignPackBake\) beginCampaignBakeStatus\(cabState\);/);
    assert.match(cab, /export function closeCab\(\) \{[\s\S]*endCampaignBakeStatus\(/);
    const dashboard = read('../ui/dashboard.js');
    assert.match(dashboard, /export function setCampaignBakeStatus\(status\)/);
    assert.match(dashboard, /station-3d-bake-status/);
    // The chapter curtain (z 4200, on <body>) covers the modal for the whole
    // build; the pill mounts on <body> above it or nobody sees it.
    assert.match(dashboard, /bakeStatusEl\.className = 'station-3d-photo-loading station-3d-bake-status';[\s\S]{0,400}?document\.body\.appendChild\(bakeStatusEl\)/);
    const css = read('../ui/shell.css');
    assert.match(css, /\.station-3d-bake-status \{[^}]*position: fixed;[^}]*z-index: 4300;/);
    assert.match(css, /\.station-3d-campaign-curtain \{[^}]*z-index: 4200;/);
    const i18n = read('../core/i18n.js');
    for (const key of ['bake.corridor', 'bake.settling', 'bake.capturing', 'bake.done', 'bake.failed']) {
        assert.equal((i18n.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) || []).length, 2, `${key} in en and hr`);
    }
});
