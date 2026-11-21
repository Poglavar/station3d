// Exercise the production road compiler's top-face orientation after the XY→XZ
// conversion, including slopes and physical decks that must not receive ground paint.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
import { densifyClosedLocalRing, refineTriangulatedSurface } from '../core/road-formation.js';
import { drapeEdgeMForTriangulation } from '../core/proposal-ground.js';
import { isPermanentTerrainGap } from '../core/terrain-evidence-gap.js';
import { bindGroundPaintMaterial } from '../core/ground-paint-material.js';
import { groundPaintAuditHits } from '../core/ground-paint-inspection.js';
import { compileSurfaceClaim } from '../core/surface-hierarchy.js';

const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const runtime = vm.createContext({ THREE, DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull, isPermanentTerrainGap,
    densifyClosedLocalRing, refineTriangulatedSurface, drapeEdgeMForTriangulation,
    startupTrace: { enabled: false }, profNow: () => 0, profAdd() {},
});
const constants = [...source.matchAll(/^const (?:ENGINEERED_SURFACE_MAX_\w+|DRAPED_SURFACE_MAX_\w+|VERTICAL_ALIGNMENT_SURFACE_MAX_\w+|ROAD_TERRAIN_SAMPLE_POINTS_PER_STEP) = [^;]+;/gm)]
    .map(match => match[0]).join('\n');
vm.runInContext(constants + '\nconst ASPHALT_UV_PER_M = 1 / 16;\n'
    + section('function localRoadRing(', '// Aggregated per-sub-step timing')
    + section('function createTerrainConformingRoadGeometryTask(', 'function centerlineLocalPoints('), runtime);

const anchorLat = 45.8, anchorLon = 16;
const scale = DEG_TO_RAD * EARTH_RADIUS_M;
const ring = [[-8, -3], [8, -3], [8, 3], [-8, 3]];
const toGeo = ([x, z]) => [anchorLon + x / (scale * Math.cos(anchorLat * DEG_TO_RAD)), anchorLat - z / scale];
const receiver = { key: 'ordinary-ground:test', verticalBand: 'ground', coverageRevision: 'r1' };
const claim = compileSurfaceClaim({ surfaceClass: 'buffered-sidewalk', verticalBand: 'ground',
    verticalRelation: 'same-level', coverageState: 'published', supportReady: true });
const paint = { key: 'plaza', receiver, claim: compileSurfaceClaim({ surfaceClass: 'sidewalk',
    verticalBand: 'ground', verticalRelation: 'same-level', coverageState: 'published',
    paintsColor: true, supportReady: false }) };

test('orientation preserves the existing tessellation and sampled relief exactly', () => {
    const before = JSON.parse(readFileSync(new URL('./fixtures/road-top-before-orientation.json', import.meta.url)));
    const sample = (x, z) => 3 + .2 * x - .1 * z + Math.sin(x * .7) * Math.cos(z * .9);
    const task = runtime.createRoadPolygonGeometryTask(before.localRing.map(toGeo), anchorLon, anchorLat,
        before.offset, 'mapped-way', false, null, false, null, false, false,
        { terrain: { evidenceSceneYAtLocal: sample, sampleStepMAtLocal: () => 4 } });
    try {
        for (let n = 0; n < 1000; n++) {
            if (task.step() === 'done') break;
            assert.ok(n < 999);
        }
        const geometry = task.geometry();
        assert.deepEqual([...geometry.attributes.position.array], before.positions);
        assert.deepEqual([...geometry.attributes.uv.array], before.uvs);
        const expected = before.indices.slice();
        for (let i = 0; i < expected.length; i += 3) [expected[i + 1], expected[i + 2]] = [expected[i + 2], expected[i + 1]];
        assert.deepEqual([...geometry.index.array], expected);
    } finally { task.dispose(); }
});

for (const mode of ['flat', 'terrain', 'engineered', 'aligned']) {
    test(`actual ${mode} road tops face up for both source ring orders, retaining heights and UVs`, () => {
        const sample = mode === 'flat' ? () => 0 : (x, z) => 3 + .2 * x - .1 * z;
        for (const points of [ring, [...ring].reverse()]) {
            const ground = { terrain: mode === 'flat' ? null : { evidenceSceneYAtLocal: sample, sampleStepMAtLocal: () => 4 },
                roadFormation: { sceneYAtLocal: sample }, verticalAlignments: mode === 'aligned'
                    ? { getAlignmentForOsmId: () => ({}), roadYAtLocal: sample } : null };
            const task = runtime.createRoadPolygonGeometryTask(points.map(toGeo), anchorLon, anchorLat,
                .043, 'mapped-way', mode === 'engineered', null, false, null, false, false, ground);
            for (let n = 0; n < 1000; n++) {
                const status = task.step();
                if (status === 'done') break;
                assert.equal(status, 'more');
                assert.ok(n < 999, 'bounded compiler finishes');
            }
            const geometry = task.geometry(), material = new THREE.MeshStandardMaterial();
            const mesh = new THREE.Mesh(geometry, material);
            try {
                const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
                for (let i = 0; i < position.count; i++) {
                    const x = position.getX(i), z = position.getZ(i);
                    assert.ok(Math.abs(position.getY(i) - sample(x, z) - .043) < 1e-6);
                    assert.ok(Math.abs(uv.getX(i) - x / 16) < 1e-6);
                    assert.ok(Math.abs(uv.getY(i) - z / 16) < 1e-6);
                    assert.ok(geometry.getAttribute('normal').getY(i) > .9, 'shading normal points above the top');
                }
                mesh.updateMatrixWorld(true);
                const ray = new THREE.Raycaster(new THREE.Vector3(1, 20, 0), new THREE.Vector3(0, -1, 0));
                const top = ray.intersectObject(mesh)[0];
                assert.ok(top, 'a FrontSide top is visible from above without DoubleSide masking its orientation');
                assert.ok(top.face.normal.y > .9, 'geometric winding agrees with shading normals');
                assert.ok(Math.abs(top.point.y - sample(1, 0) - .043) < 1e-6);
                ray.set(new THREE.Vector3(1, -20, 0), new THREE.Vector3(0, 1, 0));
                assert.equal(ray.intersectObject(mesh).length, 0, 'the same top is not an underside');
                const binding = bindGroundPaintMaterial(material, { receiver, minimumRank: claim.rank });
                const observed = groundPaintAuditHits({ y: top.point.y, claim, objectName: 'RoadSurface' }, {
                    receiver: mode === 'aligned' ? { ...binding.receiver, key: 'deck' } : binding.receiver,
                    normalY: top.face.normal.y, visible: paint, expected: paint,
                });
                assert.equal(observed.hits.some(hit => hit.paintKey === 'plaza'), mode !== 'aligned');
            } finally { task.dispose(); material.dispose(); }
        }
    });
}
