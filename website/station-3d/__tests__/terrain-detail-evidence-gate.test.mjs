// Where LiDAR exists, the 20 m base is never evidence for infrastructure: the
// 1 m anchor window loads with the base, and a moving 1 m window withholds base
// evidence inside its bounds until it merges, so roads, rails and buildings
// publish once, on the fine surface, instead of on the coarse one and again
// when the fine window lands.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { TerrainReference } from '../core/terrain-grid.js';

const grid = { sampleHeight: () => 100 };
const ANCHOR = [15.87, 43.75];

test('a pending fine window withholds base evidence inside it, except where fine detail is already loaded', () => {
    const terrain = new TerrainReference(grid, ...ANCHOR, {
        surfaceStepM: 20,
        detail: { stepM: 1, tileM: 400, rects: [{ minX: -400, maxX: 400, minZ: -400, maxZ: 400 }] },
    });
    assert.equal(typeof terrain.evidenceSceneYAtLocal(1000, 1000), 'number', 'base evidence before any pending window');
    terrain.setPendingDetailWindow({ minX: 500, maxX: 1600, minZ: 500, maxZ: 1600 });
    assert.equal(terrain.evidenceSceneYAtLocal(1000, 1000), null, 'inside the pending window the base is not evidence');
    assert.equal(terrain.hasEvidenceAtLocal(1000, 1000), false);
    assert.equal(typeof terrain.evidenceSceneYAtLocal(2000, 2000), 'number', 'outside it the base still is');
    assert.equal(typeof terrain.evidenceSceneYAtLocal(0, 0), 'number', 'loaded fine detail is evidence regardless');
    // The visible surface is deliberately not gated: it is the no-void backstop.
    assert.equal(typeof terrain.sceneYAtLocal(1000, 1000), 'number');
});

test('releasing the window announces a revision over it, unless a grid replacement announces itself', () => {
    const terrain = new TerrainReference(grid, ...ANCHOR, { surfaceStepM: 20 });
    const events = [];
    terrain.onChange((revision, event) => events.push({ revision, ...event }));
    assert.equal(terrain.clearPendingDetailWindow(), false, 'nothing pending, nothing announced');
    terrain.setPendingDetailWindow({ minX: -10, maxX: 10, minZ: -10, maxZ: 10 });
    assert.equal(terrain.evidenceSceneYAtLocal(0, 0), null);
    assert.equal(terrain.clearPendingDetailWindow({ reason: 'detail-window-settled' }), true);
    assert.equal(terrain.pendingDetailWindow, null);
    assert.equal(typeof terrain.evidenceSceneYAtLocal(0, 0), 'number');
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'detail-window-settled');
    assert.equal(events[0].revision, 1);
    assert.deepEqual(events[0].bounds, [{ minX: -10, maxX: 10, minZ: -10, maxZ: 10 }]);

    terrain.setPendingDetailWindow({ minX: -10, maxX: 10, minZ: -10, maxZ: 10 });
    terrain.clearPendingDetailWindow({ notify: false });
    assert.equal(events.length, 1, 'a silent release announces nothing');
    terrain.replaceGrid(grid, { reason: 'moving-detail-window', changedBounds: [{ minX: 0, maxX: 1, minZ: 0, maxZ: 1 }] });
    assert.equal(events.length, 2);
    assert.equal(events[1].revision, 2);
    assert.equal(events[1].reason, 'moving-detail-window');
    // A new window replaces the old one; a malformed one clears it.
    terrain.setPendingDetailWindow({ minX: 0, maxX: 5, minZ: 0, maxZ: 5 });
    terrain.setPendingDetailWindow({ minX: 100, maxX: 105, minZ: 100, maxZ: 105 });
    assert.equal(terrain.evidenceSceneYAtLocal(2, 2) !== null, true);
    assert.equal(terrain.evidenceSceneYAtLocal(102, 102), null);
    assert.equal(terrain.setPendingDetailWindow({ minX: 5, maxX: 0 }), null);
    assert.equal(terrain.evidenceSceneYAtLocal(102, 102) !== null, true);
});

test('the terrain layer loads the 1 m anchor window with the base and gates the moving window', async () => {
    const source = await readFile(new URL('../world/terrain.js', import.meta.url), 'utf8');
    const startupAt = source.indexOf("const campaignDriveSurfacePreload = ctx.campaignDriveSurfacePreload || null;");
    const startup = source.slice(startupAt, source.indexOf("noteWorldPhase('terrain-data-ready');", startupAt));
    // The window is whichever one the session resolved: the location's own,
    // or the bake-only one a campaign pack brings (core/terrain-detail-config.js).
    assert.match(startup, /const initialDetailPayloads = detailConfig\s*\? fetchDetailGrids\(ctx, detailSourceConfig, signal\)/, 'the fine window is requested for every session, alongside the base cells');
    assert.doesNotMatch(startup, /if \(campaignDriveSurfacePreload && detailConfig\)/, 'no longer a campaign-only path');
    assert.match(startup, /const detailPayloads = await initialDetailPayloads;[\s\S]{0,200}preparedDetail = await prepareTerrainDetailWindow\(/);
    assert.match(source, /if \(!streamState\.detailPinned && initialDetailOutcome === 'failed'\) \{\s*beginStreamedTerrainDetailRefresh\(/, 'only a failed initial attempt retries at once');
    const moving = source.slice(source.indexOf('function beginStreamedTerrainDetailRefresh('), source.indexOf('function clearTerrain()'));
    assert.match(moving, /const target = detailRefreshTarget\(pose, local\);/);
    assert.match(moving, /reference\.setPendingDetailWindow\(detailWindowBounds\(target, state\.detailConfig\)\);\s*state\.detailGateSinceMs = now;\s*\}\s*fetchDetailGrids\(requestCtx/, 'evidence is withheld before the request goes out');
    assert.match(moving, /if \(detailChange\.noOp\) \{\s*[\s\S]{0,300}reference\.clearPendingDetailWindow\(\{ reason: 'detail-window-settled' \}\);\s*return;/);
    assert.match(moving, /reference\.clearPendingDetailWindow\(\{ notify: false \}\);\s*reference\.replaceGrid\(/);
    assert.match(moving, /requestToken === state\.detailRequestToken\) \{[\s\S]{0,400}reference\.clearPendingDetailWindow\(\{ reason: 'detail-window-failed' \}\);/);
    assert.match(source, /function detailRefreshTarget\(pose, local\) \{\s*const focus = pose\?\.surfaceStreamingFocus;/);
});

test('the gate is bounded: a fresh request arms it, a superseding one never re-arms it, expiry and failure disarm it', async () => {
    const { planDetailEvidenceGate, DETAIL_EVIDENCE_GATE_MAX_MS } = await import('../core/terrain-detail-change.js');
    assert.equal(DETAIL_EVIDENCE_GATE_MAX_MS, 8000);
    assert.deepEqual(planDetailEvidenceGate({ action: 'start', armed: true, pendingSinceMs: null, nowMs: 1000 }), { gate: 'set' });
    assert.deepEqual(planDetailEvidenceGate({ action: 'replace', armed: true, pendingSinceMs: null, nowMs: 1000 }), { gate: 'none' }, 'a superseding request runs without a gate');
    assert.deepEqual(planDetailEvidenceGate({ action: 'start', armed: false, pendingSinceMs: null, nowMs: 1000 }), { gate: 'none' }, 'disarmed after a failure or an expiry');
    assert.deepEqual(planDetailEvidenceGate({ action: 'replace', armed: true, pendingSinceMs: 1000, nowMs: 5000 }), { gate: 'keep' }, 'an existing gate outlives the request it came with');
    assert.deepEqual(planDetailEvidenceGate({ action: 'none', armed: true, pendingSinceMs: 1000, nowMs: 9000 }),
        { gate: 'release', reason: 'detail-window-timeout', disarm: true }, 'the base is evidence again after the allowance');
    assert.deepEqual(planDetailEvidenceGate({ action: 'start', armed: true, pendingSinceMs: 1000, nowMs: 9001 }).gate, 'release');
    assert.deepEqual(planDetailEvidenceGate(), { gate: 'none' });
    // The allowance shrinks with speed and vanishes at highway speed.
    const { detailEvidenceGateAllowanceMs } = await import('../core/terrain-detail-change.js');
    assert.equal(detailEvidenceGateAllowanceMs('stationary'), 8000);
    assert.equal(detailEvidenceGateAllowanceMs('slow'), 8000);
    assert.equal(detailEvidenceGateAllowanceMs('transit'), 2500);
    assert.equal(detailEvidenceGateAllowanceMs('fast'), 0);
    assert.equal(detailEvidenceGateAllowanceMs('nonsense'), 8000);
    assert.deepEqual(planDetailEvidenceGate({ action: 'start', armed: true, pendingSinceMs: null, nowMs: 1000, maxMs: 0 }), { gate: 'none' }, 'never armed at highway speed');
    assert.equal(planDetailEvidenceGate({ action: 'none', armed: true, pendingSinceMs: 1000, nowMs: 3600, maxMs: 2500 }).gate, 'release', 'accelerating shortens an open gate');
    assert.equal(planDetailEvidenceGate({ action: 'none', armed: true, pendingSinceMs: 1000, nowMs: 3400, maxMs: 2500 }).gate, 'keep');

    const source = await readFile(new URL('../world/terrain.js', import.meta.url), 'utf8');
    const moving = source.slice(source.indexOf('function beginStreamedTerrainDetailRefresh('), source.indexOf('function clearTerrain()'));
    assert.match(moving, /const gatePlan = planDetailEvidenceGate\(\{\s*action: refreshPlan\.action,\s*armed: state\.detailGateArmed,\s*pendingSinceMs: state\.detailGateSinceMs,\s*nowMs: now,\s*maxMs: detailEvidenceGateAllowanceMs\(getFrameChunkWorkMotionState\(\)\),\s*\}\);\s*if \(gatePlan\.gate === 'set'\) \{\s*reference\.setPendingDetailWindow\(/);
    assert.match(source, /function releaseExpiredDetailEvidenceGate\(state\) \{[\s\S]{0,500}maxMs: detailEvidenceGateAllowanceMs\(getFrameChunkWorkMotionState\(\)\),/, 'the valve uses the same speed-scaled allowance');
    assert.match(moving, /state\.detailGateArmed = true;\s*state\.detailGateSinceMs = null;\s*if \(detailChange\.noOp\) \{/, 'a landed window re-arms the gate');
    assert.match(moving, /state\.detailGateArmed = false;\s*state\.detailGateSinceMs = null;\s*reference\.clearPendingDetailWindow\(\{ reason: 'detail-window-failed' \}\);/);
    assert.match(source, /function releaseExpiredDetailEvidenceGate\(state\) \{[\s\S]{0,700}reference\.clearPendingDetailWindow\(\{ reason: plan\.reason \}\);/);
    assert.match(source, /releaseExpiredDetailEvidenceGate\(terrainGridStreamState\);\s*beginStreamedTerrainDetailRefresh\(terrainGridStreamState, pose, local\);/, 'the valve runs every frame before a refresh is planned');
    assert.match(source, /if \(initialDetailOutcome === 'failed'\) streamState\.detailGateArmed = false;/);
});
