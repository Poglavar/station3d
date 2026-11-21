import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildPositionShareUrl } from '../core/position-share.js';
const { parseExplorerUrl } = globalThis.__station3DLinks;

test('builds a stable walk inspection link from a rail-session position', () => {
    const result = new URL(buildPositionShareUrl({
        currentUrl: 'http://localhost:8000/transit.html?cab=1&line=5&loc=split&foo=kept',
        pose: { lat: 43.5063731, lon: 16.4422821, headingDeg: 350 },
        lookYawRad: 20 * Math.PI / 180,
        lookPitchRad: -75 * Math.PI / 180,
    }));

    assert.equal(result.searchParams.get('st3d'), 'walk');
    assert.equal(result.searchParams.get('lat'), '43.506373');
    assert.equal(result.searchParams.get('lon'), '16.442282');
    assert.equal(result.searchParams.get('heading'), '10.0');
    assert.equal(result.searchParams.get('pitch'), '-60.0');
    assert.equal(result.searchParams.get('foo'), 'kept');
    assert.equal(result.searchParams.has('cab'), false);
    assert.equal(result.searchParams.has('line'), false);
    assert.equal(result.searchParams.has('loc'), false);
});

test('preserves GTA mode and rejects incomplete positions', () => {
    const url = new URL(buildPositionShareUrl({
        currentUrl: 'https://example.test/transit.html',
        pose: { lat: 45.8, lon: 16, headingDeg: 15 },
        sessionPresetId: 'gta',
    }));
    assert.equal(url.pathname, '/sloboda/@45.8,16/');
    assert.equal(parseExplorerUrl(url.href).mode, 'gta');
    assert.equal(url.searchParams.has('st3d'), false);
    assert.equal(buildPositionShareUrl({
        currentUrl: 'https://example.test/transit.html',
        pose: { lat: null, lon: 16 },
    }), '');
});

test('preserves an explicit campaign checkpoint instead of degrading it to GTA free roam', () => {
    const url = new URL(buildPositionShareUrl({
        currentUrl: 'http://localhost:8092/transit.html?st3d=campaign&campaign=toranj-ljepote-snage-slobode&checkpoint=zagreb-before-chase&elevation=1',
        pose: { lat: 45.805624, lon: 15.979405, headingDeg: 73.5 },
        sessionPresetId: 'gta',
    }));

    const route = parseExplorerUrl(url.href);
    assert.equal(route.mode, 'campaign');
    assert.equal(route.campaignId, 'toranj-ljepote-snage-slobode');
    assert.equal(route.checkpointId, 'zagreb-before-chase');
    assert.equal(url.pathname, '/sloboda/kampanja/toranj/zagreb-before-chase/');
    assert.equal(url.searchParams.get('lat'), '45.805624');
    assert.equal(url.searchParams.get('lon'), '15.979405');
});

test('cab sessions install position sharing when no ride share provider exists', () => {
    const cabSource = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');
    const modalSource = readFileSync(new URL('../ui/modal.js', import.meta.url), 'utf8');
    // A ride with no explicit share URL still installs the position-share
    // fallback; a campaign deliberately installs none, because its address
    // is a checkpoint the story writes into the URL bar.
    assert.match(cabSource, /suppliedShareProvider \|\| \(inCampaign \|\| suppliedShareUrl \? null : \(\) =>/);
    assert.match(cabSource, /const inCampaign = !!\(options && \(options\.campaignScene \|\| options\.campaignDefinition\)\);/);
    assert.match(modalSource, /rideShareBtnEl\.style\.display = available \? 'inline-flex' : 'none'/);
    assert.match(modalSource, /toastFn\(t\('share\.unavailable'\)\)/);
});
