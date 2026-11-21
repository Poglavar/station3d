// Locks the composition seam that transfers one ambient tram mesh from bounded
// fleet traffic to the rail controller without ever creating a road chassis.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cabSource = await readFile(new URL('../modes/cab.js', import.meta.url), 'utf8');
const tramSource = await readFile(new URL('../vehicles/tram.js', import.meta.url), 'utf8');
const railsSource = await readFile(new URL('../world/rails.js', import.meta.url), 'utf8');
const i18nSource = await readFile(new URL('../core/i18n.js', import.meta.url), 'utf8');

function functionBody(source, name, nextName) {
    const start = source.indexOf(`function ${name}`);
    const end = source.indexOf(`function ${nextName}`, start + 1);
    return source.slice(start, end < 0 ? source.length : end);
}

test('boarding claims the existing mesh into the rail solver, never Rapier', () => {
    const boarding = functionBody(cabSource, 'beginAmbientTramControl', 'ambientTramExitCandidate');
    assert.match(boarding, /provider\.claim\(candidate\.id, local\)/);
    assert.match(boarding, /createDriverState\(snap, claimed\.currentSpeedMps\)/);
    assert.match(boarding, /cabState\.playerTramMesh = claimed\.mesh/);
    assert.doesNotMatch(boarding, /createControlledVehicle|Rapier|chassis/);
});

test('the claimed mesh stays in the ambient obstacle publication exactly once', () => {
    assert.match(cabSource, /!!cabState\.walkMode \|\| cabState\.playerTramMeshBorrowed/);
    assert.match(cabSource, /ambientTramClaim\.provider\.sync/);
    assert.match(tramSource, /mesh\.userData\.controlledTram = true/);
    assert.match(tramSource, /for \(const mesh of instances\.values\(\)\)/);
});

test('streamed rail replacement and teardown are revision- and provider-owned', () => {
    assert.match(cabSource, /source\.revision === claim\.lastAttemptedRailRevision/);
    assert.match(cabSource, /resnapDriverState\(/);
    assert.match(cabSource, /ambientTramClaim\.provider\.release/);
    assert.match(tramSource, /gtaAmbientProvider\?\.dispose\(\)/);
});

test('trains are a second fleet on the same contract: heavy rail, chained runs, own prompts, and the same boarding path', () => {
    assert.match(tramSource, /createAmbientTramProvider\(\{[\s\S]*?id: 'trains',[\s\S]*?kind: 'train',[\s\S]*?idPrefix: 'gta-train',[\s\S]*?policy: AMBIENT_TRAIN_POLICY,[\s\S]*?stationService: ambientTrainStationServiceForAnchor\(lat, lon\),[\s\S]*?\.\.\.AMBIENT_TRAIN_CRUISE,/);
    assert.match(tramSource, /accept: feature => isAmbientTrainFeature\(feature, \{ solvedOnly: source\?\.mode === 'solved' \}\),\s*chain: true,/);
    assert.match(tramSource, /for \(const fleet of \[tramFleet, trainFleet\]\)/);
    assert.match(tramSource, /return String\(id \|\| ''\)\.startsWith\('gta-train:'\) \? gtaAmbientTrainProvider : gtaAmbientProvider;/);
    assert.match(tramSource, /gtaAmbientTrainProvider\?\.dispose\(\)/);
    assert.match(railsSource, /mode: streamedRailProfileMode,/, 'the source says which rails are drivable');
    const boarding = functionBody(cabSource, 'beginAmbientTramControl', 'ambientTramExitCandidate');
    assert.match(boarding, /const kind = candidate\.kind === 'train' \? 'train' : 'tram';/);
    assert.match(boarding, /streamedAmbientRailFeatures\(source, kind\)/);
    assert.match(boarding, /showCabToast\(t\(ambientPromptKey\(kind, 'Entered'\)\), 3000\)/);
    assert.match(cabSource, /isAmbientTrainFeature\(feature, \{ solvedOnly: source\?\.mode === 'solved' \}\)/, 'the cab drives exactly the rails the fleet rides');
    assert.match(cabSource, /ambientPromptKey\(tram\.kind, tram\.ready \? 'BoardPrompt' : 'RequestPrompt'\)/);
    assert.match(cabSource, /if \(tramCandidate\.ready && tramCandidate\.distanceM <= 3\.2\) \{\s*return beginAmbientTramControl/,
        'a train already dwelling with open doors boards directly');
    assert.match(cabSource, /train: cabState\.ambientTramClaim\?\.kind === 'train'/);
    assert.match(cabSource, /collisionHalfWidthM\) \|\| TRAM_HALF_WIDTH_M/, 'a train is left beside its own body');
    for (const key of ['RequestPrompt', 'StoppingPrompt', 'BoardPrompt', 'ExitPrompt', 'StopToExitPrompt', 'Stopping', 'MoveCloser', 'Entered', 'StopToExit', 'DoorsOpening']) {
        assert.equal(i18nSource.match(new RegExp(`'gta\\.train${key}': '`, 'g'))?.length, 2, `gta.train${key} in both languages`);
    }
});
