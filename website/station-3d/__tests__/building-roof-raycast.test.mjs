import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { collectVisibleRayHits } from '../core/visible-raycast.js';
import { createOwnerRangeRaycast } from '../core/owner-range-raycast.js';

const ray = (x = 0, z = 0) => new THREE.Raycaster(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
function roof(y) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 4), new THREE.MeshBasicMaterial());
    mesh.position.y = y - 0.5;
    return mesh;
}
function visible(object) {
    for (let node = object; node; node = node.parent) if (!node.visible) return false;
    return true;
}

test('visible roof rays match recursive hit filtering while skipping hidden replacement geometry', () => {
    const root = new THREE.Group(), hidden = new THREE.Group();
    hidden.visible = false;
    const old = roof(10), staged = roof(20);
    root.add(old, hidden); hidden.add(staged); root.updateMatrixWorld(true);
    let stagedRaycasts = 0;
    const original = staged.raycast;
    staged.raycast = function (...args) { stagedRaycasts++; return original.apply(this, args); };
    const expected = ray().intersectObject(root, true).filter(hit => visible(hit.object));
    assert.equal(stagedRaycasts, 1, 'ordinary recursive rays test hidden replacement triangles');
    stagedRaycasts = 0;
    const actual = collectVisibleRayHits(ray(), root);
    assert.deepEqual(actual.map(hit => hit.point.y).sort(), expected.map(hit => hit.point.y).sort());
    assert.equal(stagedRaycasts, 0);
    hidden.visible = true;
    assert.equal(Math.max(...collectVisibleRayHits(ray(), root).map(hit => hit.point.y)), 20);
    root.visible = false;
    assert.deepEqual(collectVisibleRayHits(ray(), staged), [], 'a hidden ancestor outside the query root still excludes it');
});

test('visible traversal keeps layers and custom raycast recursion behavior', () => {
    const root = new THREE.Group(), layerExcluded = new THREE.Group(), stopped = new THREE.Group();
    root.add(layerExcluded, stopped);
    layerExcluded.layers.set(1); layerExcluded.add(roof(10));
    stopped.add(roof(20)); stopped.raycast = () => false;
    root.updateMatrixWorld(true);
    const expected = ray().intersectObject(root, true);
    const actual = collectVisibleRayHits(ray(), root);
    assert.deepEqual(actual.map(hit => hit.point.y), expected.map(hit => hit.point.y));
    assert.equal(Math.max(...actual.map(hit => hit.point.y)), 10, 'excluded parent layer does not exclude matching child layers');
});

test('actual aggregate factory uses prepared bounds to reject street rays before triangle work', () => {
    const source = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');
    const start = source.indexOf('function buildOvertureAggregateMesh(');
    const end = source.indexOf('\nfunction queueOvertureBucket(', start);
    assert.ok(start >= 0 && end > start);
    const context = vm.createContext({ THREE, createOwnerRangeRaycast, bindGeometryMemory() {}, setPassageAwareMaterial() {},
        markSurfaceClaim() {}, isProposalBuildingBucketKey: () => false,
        SURFACE_CLASS: { BUILDING: 'building' }, SURFACE_COVERAGE_STATE: { PUBLISHED: 'published' },
        SURFACE_VERTICAL_RELATION: { UNKNOWN: 'unknown' } });
    const makeMesh = vm.runInContext(`(${source.slice(start, end)})`, context);
    const mesh = makeMesh({ bucketKey: 'test', descriptor: { material: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }) },
        assembled: { attributes: { position: new Float32Array([0,10,0, 0,10,2, 2,10,0]) },
            ranges: [{ ownerKey: 'roof', start: 0, count: 3,
                bounds: { minX: 0, maxX: 2, minY: 10, maxY: 10, minZ: 0, maxZ: 2 } }],
            bounds: { minX: 0, maxX: 2, minY: 10, maxY: 10, minZ: 0, maxZ: 2 } } });
    mesh.updateMatrixWorld(true);
    let triangleVisits = 0;
    const original = mesh._computeIntersections;
    mesh._computeIntersections = function (...args) { triangleVisits++; return original.apply(this, args); };
    assert.equal(ray(2.2, 1).intersectObject(mesh).length, 0);
    assert.equal(triangleVisits, 0, 'inside the sphere but outside the prepared box needs no triangle loop');
    assert.equal(ray(.5, .5).intersectObject(mesh)[0].point.y, 10, 'the modeled roof remains exact support');
    assert.equal(triangleVisits, 1);
});

test('actual roof support uses visible traversal and retains passage, water and ghost exclusions', () => {
    const source = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');
    const start = source.indexOf('function getBuildingRoofY('), end = source.indexOf('\nfunction getRooftopY(', start);
    const group = new THREE.Group(), floor = roof(10), water = roof(20), ghost = roof(30), passage = roof(40);
    water.material.userData.walkSupport = false;
    ghost.userData.proposalTrackDemolitionGhost = true;
    group.add(floor, water, ghost, passage); group.updateMatrixWorld(true);
    const context = vm.createContext({ _walkRayOrigin: new THREE.Vector3(), _walkRayDir: new THREE.Vector3(0,-1,0),
        _walkRaycaster: ray(), collectVisibleRayHits, getBuildingsGroup: () => group,
        getProposalsBuildingsGroup: () => null, isEffectivelyVisible: visible,
        isPointInsideBuildingPassageVolume: (_x,y) => y > 35 });
    assert.ok(start >= 0 && end > start);
    const getRoofY = vm.runInContext(`(${source.slice(start, end)})`, context);
    assert.equal(getRoofY(0, 0), 10);
    floor.visible = false;
    assert.equal(getRoofY(0, 0), null);
});
