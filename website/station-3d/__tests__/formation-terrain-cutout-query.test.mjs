// Locks physics terrain to the same formation-cut, restoration and replacement
// ordering used by the visible terrain mask.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildFormationTerrainCutoutQuery,
    replaceTerrainCutoutLayerSources,
    triangleInsideTerrainCutout,
    triangleTouchesTerrainCutout,
} from '../core/formation-terrain-cutout-query.js';
import {
    activateViaductTerrainCutoutRegions,
    buildViaductTerrainCutoutRegions,
    createRenderedRailSurfaceMaskModelFromRegions,
} from '../core/rendered-rail-surface.js';
import {
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
} from '../core/surface-hierarchy.js';

function square(minX, minZ, maxX, maxZ) {
    return [
        { x: minX, z: minZ },
        { x: maxX, z: minZ },
        { x: maxX, z: maxZ },
        { x: minX, z: maxZ },
    ];
}

test('replacement clear rings restore terrain before final openings cut it again', () => {
    const profile = {
        innerRing: square(-10, -10, 10, 10),
        formationDressingDisabled: true,
        terrainCutoutDisabled: false,
    };
    const model = {
        surfaceProfilesNear: () => [profile],
        getReplacementTerrainCutoutRegions: () => [{
            clearRing: square(-6, -6, 6, 6),
            cutoutRing: square(-2, -2, 2, 2),
        }],
    };
    const query = buildFormationTerrainCutoutQuery({
        models: [model],
        centerX: 0,
        centerZ: 0,
        radiusM: 40,
    });
    assert.equal(query.contains(8, 0), true, 'ordinary formation remains cut');
    assert.equal(query.contains(4, 0), false, 'protective clear restores the roof');
    assert.equal(query.contains(0, 0), true, 'final tunnel opening wins over clear');
    assert.equal(query.formationRingCount, 1);
    assert.equal(query.clearRingCount, 1);
    assert.equal(query.replacementRingCount, 1);
});

test('a tunnel portal aperture wins over a broad terrain-roof restoration', () => {
    const model = {
        surfaceProfilesNear: () => [],
        getTunnelPortalTerrainOpenings: () => [{
            ring: square(-3, -2, 3, 2),
        }],
        getReplacementTerrainCutoutRegions: () => [{
            clearRing: square(-8, -8, 8, 8),
        }],
    };
    const query = buildFormationTerrainCutoutQuery({
        models: [model],
        centerX: 0,
        centerZ: 0,
        radiusM: 40,
    });
    assert.equal(query.contains(0, 0), true,
        'the physical portal remains open after neighbouring roof protection');
    assert.equal(query.contains(5, 0), false,
        'the tunnel hill remains intact outside the short aperture');
    assert.equal(query.portalOpeningRingCount, 1);
});

test('a replacement clear cannot restore DGU terrain through upper asphalt', () => {
    const pavedRing = square(-10, -10, 10, 10);
    const profile = {
        innerRing: pavedRing,
        formationDressingDisabled: false,
        terrainCutoutDisabled: false,
        terrainExcavationRegions: [{
            ring: square(-12, -12, 12, 12),
            clipToPavedSurface: true,
        }],
    };
    const model = {
        surfaceProfilesNear: () => [profile],
        getReplacementTerrainCutoutRegions: () => [{
            clearRing: square(-6, -6, 6, 6),
        }],
    };
    const query = buildFormationTerrainCutoutQuery({
        models: [model],
        centerX: 0,
        centerZ: 0,
        radiusM: 40,
    });

    assert.equal(query.contains(0, 0), true, 'asphalt correction wins over roof restoration');
    assert.equal(query.contains(11, 0), false, 'correction remains clipped to the paved ring');
});

test('physics callers can query the last published formation generation', () => {
    let optionsSeen = null;
    buildFormationTerrainCutoutQuery({
        models: [{
            surfaceProfilesNear(_x, _z, _radius, options) {
                optionsSeen = options;
                return [];
            },
        }],
        centerX: 0,
        centerZ: 0,
        radiusM: 40,
        allowStale: true,
    });
    assert.deepEqual(optionsSeen, { allowStale: true });
});

test('terrain triangles touching a narrow opening remain waterproof', () => {
    const query = buildFormationTerrainCutoutQuery({
        models: [{
            surfaceProfilesNear: () => [{
                innerRing: square(-0.4, -4, 0.4, 4),
                formationDressingDisabled: true,
                terrainCutoutDisabled: false,
            }],
        }],
        centerX: 0,
        centerZ: 0,
        radiusM: 20,
    });
    assert.equal(triangleTouchesTerrainCutout(
        query,
        { x: -3, z: -3 },
        { x: 3, z: -3 },
        { x: 3, z: 3 },
    ), true);
    assert.equal(triangleInsideTerrainCutout(
        query,
        { x: -3, z: -3 },
        { x: 3, z: -3 },
        { x: 3, z: 3 },
    ), false, 'an edge touch must not enlarge the physics hole to a whole triangle');
    assert.equal(triangleInsideTerrainCutout(
        query,
        { x: -0.3, z: -2 },
        { x: 0.3, z: -2 },
        { x: 0, z: 2 },
    ), true, 'a fully covered triangle belongs to the engineered opening');
    assert.equal(triangleTouchesTerrainCutout(
        query,
        { x: 5, z: 5 },
        { x: 8, z: 5 },
        { x: 8, z: 8 },
    ), false);
});

test('rail fill preserves terrain while a measured cut opens only inside its collar', () => {
    const profile = {
        innerRing: square(-2, -10, 2, 10),
        formationDressingDisabled: true,
        terrainCutoutDisabled: false,
        terrainExcavationRegions: [],
    };
    const model = { surfaceProfilesNear: () => [profile] };
    let query = buildFormationTerrainCutoutQuery({
        models: [model],
        centerX: 0,
        centerZ: 0,
        radiusM: 40,
    });
    assert.equal(query.contains(0, 0), false, 'fill must keep supplied terrain underneath');

    profile.terrainExcavationRegions = [{
        ring: square(-8, -4, 8, 4),
    }];
    query = buildFormationTerrainCutoutQuery({
        models: [model],
        centerX: 0,
        centerZ: 0,
        radiusM: 40,
    });
    assert.equal(query.contains(0, 0), true, 'measured cut removes terrain under the bed');
    assert.equal(query.contains(5, 0), false, 'wide cut evidence is clipped to civil coverage');
});

test('an ordinary rendered tram surface cuts an intrusive terrain lid without a formation', () => {
    const surfaceRing = [
        { x: -2, y: 1, z: -1 },
        { x: 2, y: 1, z: -1 },
        { x: 2, y: 1, z: 1 },
        { x: -2, y: 1, z: 1 },
    ];
    const model = {
        getTerrainSurfaceRegions: () => [{
            ring: surfaceRing,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        }],
        getReplacementTerrainCutoutRegions: () => [{
            clearRing: square(-5, -5, 5, 5),
        }],
    };
    const query = buildFormationTerrainCutoutQuery({
        models: [model],
        centerX: 0,
        centerZ: 0,
        radiusM: 20,
        terrainSceneYAtLocal: () => 1.5,
    });
    assert.equal(query.contains(0, 0), true,
        'the exact visible trackbed is reapplied after a broad roof restoration');
    assert.equal(query.contains(4, 0), false,
        'the cut never expands beyond the rendered surface strip');
});

test('an opaque viaduct deck cuts only its height-tested replacement footprint', () => {
    const runs = [{
        alignment: { halfWidthM: 2 },
        samples: [
            { station: 0, x: -5, z: 0, railY: 20.274 },
            { station: 10, x: 5, z: 0, railY: 20.274 },
        ],
    }];
    const inactiveModel = createRenderedRailSurfaceMaskModelFromRegions([], {
        viaductTerrainCutoutRegions: activateViaductTerrainCutoutRegions(
            buildViaductTerrainCutoutRegions(runs),
            () => 20.35,
        ),
        viaductTerrainCutoutRevision: 1,
    });
    let query = buildFormationTerrainCutoutQuery({
        models: [inactiveModel],
        centerX: 0,
        centerZ: 0,
        radiusM: 30,
        terrainSceneYAtLocal: () => 20.35,
    });
    assert.equal(query.contains(0, 0), false,
        'a flush terrain/deck discrepancy remains intact');

    const activeModel = createRenderedRailSurfaceMaskModelFromRegions([], {
        viaductTerrainCutoutRegions: activateViaductTerrainCutoutRegions(
            buildViaductTerrainCutoutRegions(runs),
            () => 20.714,
        ),
        viaductTerrainCutoutRevision: 2,
    });
    query = buildFormationTerrainCutoutQuery({
        models: [activeModel],
        centerX: 0,
        centerZ: 0,
        radiusM: 30,
        terrainSceneYAtLocal: () => 20.714,
    });
    assert.equal(query.contains(0, 0), true,
        'the exact concrete slab replaces the intrusive DGU lid');
    assert.equal(query.contains(0, 3.3), true,
        'the footprint includes the deck walkway beside the trackbed');
    assert.equal(query.contains(0, 3.5), false,
        'terrain outside the opaque slab is never opened');
});

test('a moving window replaces only tagged rail cutouts in canonical Boolean order', () => {
    const region = source => Object.freeze({ source, ring: square(0, 0, 1, 1) });
    const base = Object.freeze([
        Object.freeze({ stage: 'formation', operation: 'subtract',
            regions: Object.freeze([region('road-formation'), region('rail-formation')]) }),
        Object.freeze({ stage: 'restoration', operation: 'restore',
            regions: Object.freeze([region('road-formation'), region('rail-formation')]) }),
        Object.freeze({ operation: 'subtract', regions: Object.freeze([region('authored')]) }),
    ]);
    const replacement = Object.freeze([
        Object.freeze({ stage: 'formation', operation: 'subtract',
            regions: Object.freeze([region('rail-formation')]) }),
        Object.freeze({ stage: 'restoration', operation: 'restore',
            regions: Object.freeze([region('rail-formation')]) }),
        Object.freeze({ stage: 'portal-opening', operation: 'subtract',
            regions: Object.freeze([region('rail-rendered')]) }),
    ]);

    const layers = replaceTerrainCutoutLayerSources(
        base,
        replacement,
        ['rail-formation', 'rail-rendered'],
    );

    assert.deepEqual(layers.map(layer => layer.stage || 'authored'), [
        'formation', 'restoration', 'authored', 'portal-opening',
    ]);
    assert.deepEqual(layers[0].regions.map(item => item.source), ['road-formation', 'rail-formation']);
    assert.deepEqual(layers[1].regions.map(item => item.source), ['road-formation', 'rail-formation']);
    assert.equal(layers[2], base[2], 'untagged authored layers remain intact');
    assert.deepEqual(layers[3].regions.map(item => item.source), ['rail-rendered']);
    assert.equal(Object.isFrozen(layers), true);
});
