// A tunnel-tagged path that no solver has modelled must not publish a surface;
// one that follows a compiled alignment, or is engineered, keeps its ribbon.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
    isTunnelPathSurface,
    isUnmodelledTunnelPathSurface,
    tunnelPathSurfaceAboveGround,
} from '../core/unmodelled-tunnel-path.js';

const tomicevaPassage = {
    osm_id: '482988746',
    highway_type: 'footway',
    tags: { highway: 'footway', tunnel: 'yes', layer: '-1', surface: 'asphalt' },
};

test('the unmodelled Tomićeva passage publishes no surface', () => {
    assert.equal(isUnmodelledTunnelPathSurface({
        properties: tomicevaPassage, type: 'footway',
    }), true);
    assert.equal(isUnmodelledTunnelPathSurface({
        properties: { tunnel: 'yes' }, type: 'steps',
    }), true);
    assert.equal(isUnmodelledTunnelPathSurface({
        properties: { osm_tunnel: 'culvert' }, type: 'path',
    }), true);
});

test('a compiled alignment or an engineered formation keeps the ribbon', () => {
    assert.equal(isUnmodelledTunnelPathSurface({
        properties: tomicevaPassage, type: 'footway', followsVerticalAlignment: true,
    }), false);
    assert.equal(isUnmodelledTunnelPathSurface({
        properties: tomicevaPassage, type: 'footway', engineered: true,
    }), false);
});

test('only real bores on sidewalk-level ways count', () => {
    // a sunken path under a bridge is at ground level, not underground
    assert.equal(isUnmodelledTunnelPathSurface({
        properties: { tags: { layer: '-1' } }, type: 'footway',
    }), false);
    assert.equal(isUnmodelledTunnelPathSurface({
        properties: { tunnel: 'building_passage' }, type: 'footway',
    }), false);
    assert.equal(isUnmodelledTunnelPathSurface({
        properties: { tunnel: 'no' }, type: 'footway',
    }), false);
    // carriageway tunnels keep their backstop polygon; this rule is not for them
    assert.equal(isUnmodelledTunnelPathSurface({
        properties: { tunnel: 'yes' }, type: 'primary',
    }), false);
    assert.equal(isUnmodelledTunnelPathSurface({ properties: {}, type: 'footway' }), false);
});

test('a solved alignment may not lift a tunnel path above the terrain evidence', () => {
    assert.equal(isTunnelPathSurface({ properties: tomicevaPassage, type: 'footway' }), true);
    assert.equal(isTunnelPathSurface({ properties: { tunnel: 'yes' }, type: 'primary' }), false);
    // the Tomićeva passage: solver put the strip 5.75 m over the ground it runs under
    assert.equal(tunnelPathSurfaceAboveGround(18.958, 13.203), true);
    // a portal ramp the LiDAR already sees may sit a little proud of the evidence
    assert.equal(tunnelPathSurfaceAboveGround(-6.606, -7.247), false);
    // inside the bore the floor is below ground, and unknown terrain is no verdict
    assert.equal(tunnelPathSurfaceAboveGround(-6.606, -3.206), false);
    assert.equal(tunnelPathSurfaceAboveGround(18.958, null), false);
    assert.equal(tunnelPathSurfaceAboveGround(NaN, 13.203), false);
});

test('roads.js consults the rule before draping a path on composed civil ground', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(resolve(here, '../world/roads.js'), 'utf8');
    const guard = source.indexOf('isUnmodelledTunnelPathSurface({');
    const drape = source.indexOf('const usesComposedCivilGround');
    assert.ok(guard > 0, 'roads.js must call isUnmodelledTunnelPathSurface');
    assert.ok(drape > guard, 'the guard must run before the composed-ground drape decision');
    // and a solved alignment is checked against the terrain evidence per sample
    const check = source.indexOf('tunnelPathSurfaceAboveGround(');
    const sample = source.indexOf("positions[sampleIndex * 3 + 1] = groundY + y;");
    assert.ok(check > 0 && check < sample, 'the above-ground check must precede the vertex write');
    assert.ok(source.includes('ctx.tunnelPathSurface,'), 'the flag must reach the ring task');
});
