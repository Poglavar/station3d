// Locks the model-world tunnel ownership split without importing Three.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../world/rails.js', import.meta.url), 'utf8');

test('the buried shell is interior-only while the one portal facade is two-sided', () => {
    assert.match(source, /tunnelMaterial\(THREE\.FrontSide\)[\s\S]*mesh\.name = 'ProposalRailTunnel'/);
    assert.match(source, /portalMesh\.name = 'ProposalRailTunnelPortals'/);
    assert.match(source, /tunnelMaterial\(THREE\.DoubleSide\)/);
    assert.match(source, /dedupeRailTunnelPortalMouths\(portalMouths\)/);
});

test('the terrain aperture is sealed by a local cap in the existing portal batch', () => {
    assert.match(source, /buildTunnelPortalRoofCapFootprint\(/);
    assert.match(source, /portalHasTerrainOpening/);
    assert.match(source, /section\.portalTerrainOpeningInsideM/);
    assert.doesNotMatch(source, /ProposalRailTunnelPortalRoof/,
        'the cap must not introduce another mesh or draw call');
});

test('the renderer consumes the shared bore axis and bounded local portal crown', () => {
    assert.match(source, /const samples = run\.boreSamples \|\| run\.samples/);
    assert.match(source, /TUNNEL_PORTAL_MAX_CROWN_M/);
    assert.doesNotMatch(source, /Math\.max\([\s\S]{0,120}retainedY[\s\S]{0,120}TUNNEL_PORTAL_MIN_CROWN_M/);
    assert.match(source, /portalRetainedBenchM\?\.negativeNormalM/);
    assert.match(source, /portalRetainedBenchM\?\.positiveNormalM/);
    assert.match(source, /Math\.max\(\s*TUNNEL_PORTAL_WING_M/,
        'a reviewed asymmetric retained approach extends, rather than shrinks, a portal jamb');
});
