// Audit the geometry that THREE actually draws, including merged owner ranges.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { collectAuditSurfaces, surfaceAuditClaimForFace, installSurfaceAudit, runSurfaceAudit } from '../debug/surface-audit.js';
import { createGeometryBatcher, ownerRangeForFace } from '../core/geometry-batch.js';
import { buildPlanTriangleIndex, planTriangleHitsAt, classifySurfaceStack } from '../core/surface-audit.js';
import { createTerrainTileGeometryTask } from '../core/terrain-tile-geometry.js';
import { compileSurfaceClaim, reviseSurfaceClaim, SURFACE_CLASS } from '../core/surface-hierarchy.js';
const claim = surfaceClass => compileSurfaceClaim({ surfaceClass, coverageState: 'published', verticalBand: 'ground', verticalRelation: 'same-level' });
const bounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
const triangle = [0, 0, 0, 0, 0, 4, 4, 0, 0];
function geometry(positions) {
    return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
}

test('audit observes actual compiled terrain faces instead of concealing them with an analytic cut',()=>{
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1,.1,1000);
    const material=new THREE.MeshBasicMaterial();material.userData.surfaceClaim=claim(SURFACE_CLASS.TERRAIN);
    const mesh=new THREE.Mesh(geometry(triangle),material);scene.add(mesh);
    const ring=[{x:-1,z:-1},{x:5,z:-1},{x:5,z:5},{x:-1,z:5}];
    installSurfaceAudit({scene,camera,getTerrain:()=>({hasLoadedCoreCoverageAtLocal:()=>true,evidenceSceneYAtLocal:()=>0}),
        getFormationModels:()=>[{getReplacementTerrainCutoutRegions:()=>[{cutoutRing:ring}]}]});
    const run=()=>runSurfaceAudit({centerX:1,centerZ:1,radiusM:.25,stepM:.25,showOverlay:false,log:false});
    try {
        const masked=run();assert.equal(masked.coverage.visibleGroundSamples,0);
        const signature=collectAuditSurfaces(scene,bounds).contentSignature;
        material.userData.terrainExactFormationCutouts=true;
        const exact=run();assert.equal(exact.coverage.visibleGroundSamples,4);
        assert.notEqual(collectAuditSurfaces(scene,bounds).contentSignature,signature);
        // Removing the actual receiver triangle must then remove coverage.
        mesh.geometry.setDrawRange(0,0);assert.equal(run().coverage.visibleGroundSamples,0);
    } finally {installSurfaceAudit(null);mesh.geometry.dispose();material.dispose();}
});

test('actual terrain and paving with opposite diagonals disagree despite equal corner samples', () => {
    const terrain = createTerrainTileGeometryTask({ tileX: 0, tileZ: 0, tileM: 4, segments: 1,
        uvPerM: 1, sceneYAtLocal: (x, z) => x === z ? 0 : 1 });
    terrain.step(Infinity);
    const data = terrain.result();
    const paving = new Float32Array(data.positions);
    for (let index = 1; index < paving.length; index += 3) paving[index] += 0.043;
    const groundY = planTriangleHitsAt(buildPlanTriangleIndex({ positions: data.positions, index: data.indices }), 2, 2)[0].y;
    const pavingY = planTriangleHitsAt(buildPlanTriangleIndex({ positions: paving, index: [0, 2, 3, 0, 3, 1] }), 2, 2)[0].y;
    assert.equal(groundY, 1);
    assert.ok(Math.abs(pavingY - 0.043) < 1e-7);
    const verdict = classifySurfaceStack([{ y: groundY, claim: claim(SURFACE_CLASS.TERRAIN) },
        { y: pavingY, claim: claim(SURFACE_CLASS.SIDEWALK) }]);
    assert.equal(verdict.violations[0].gapM, 0.957);
});

test('multi-material groups use their own claims and intersect the draw range', () => {
    const scene = new THREE.Scene();
    const geo = geometry([...triangle, ...triangle.map((value, index) => index % 3 === 1 ? value + 1 : value)]);
    geo.addGroup(0, 3, 0); geo.addGroup(3, 3, 1);
    const materials = [SURFACE_CLASS.TERRAIN, SURFACE_CLASS.SIDEWALK].map(type => {
        const material = new THREE.MeshBasicMaterial(); material.userData.surfaceClaim = claim(type); return material;
    });
    scene.add(new THREE.Mesh(geo, materials)); scene.updateMatrixWorld(true);
    let result = collectAuditSurfaces(scene, bounds);
    assert.deepEqual(result.surfaces.map(surface => surface.claim.surfaceClass), [SURFACE_CLASS.TERRAIN, SURFACE_CLASS.SIDEWALK]);
    assert.equal(result.triangleCount, 2);
    geo.setDrawRange(3, 3);
    result = collectAuditSurfaces(scene, bounds);
    assert.deepEqual(result.surfaces.map(surface => surface.claim.surfaceClass), [SURFACE_CLASS.SIDEWALK]);
});

test('coincident triangles in different entity ranges remain separate owners', () => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(geometry([...triangle, ...triangle]), new THREE.MeshBasicMaterial());
    mesh.userData.surfaceClaim = claim(SURFACE_CLASS.SIDEWALK);
    mesh.userData.entityRanges = [{ key: 'paving:a', start: 0, count: 3 }, { key: 'paving:b', start: 3, count: 3 }];
    scene.add(mesh); scene.updateMatrixWorld(true);
    const result = collectAuditSurfaces(scene, bounds);
    const hits = planTriangleHitsAt(result.surfaces[0].plan, 1, 1);
    assert.deepEqual(hits.map(hit => hit.identity), ['paving:a', 'paving:b']);
    mesh.userData.entityRanges[1].key = 'paving:a';
    assert.equal(planTriangleHitsAt(collectAuditSurfaces(scene, bounds).surfaces[0].plan, 1, 1).length, 1);
});

test('batched per-part claims reach audit and null parts do not inherit', () => {
    const batcher = createGeometryBatcher();
    const a = reviseSurfaceClaim(claim(SURFACE_CLASS.SIDEWALK), { featureId: 'osm:way:123' });
    const b = reviseSurfaceClaim(a, { featureId: '-1493356001' });
    const c = reviseSurfaceClaim(a, { featureId: '-20770250001' });
    const part = (surfaceClaim, entity) => ({
        // Two adjacent triangles share the diagonal at the query point.
        attributes: { position: Float32Array.from([0, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0, 0, 2, 2, 0, 2]) },
        ...(entity ? { entity } : {}),
        ...(surfaceClaim === undefined ? {} : { surfaceClaim }),
    });
    batcher.addPart('surface', 'positive', part(a, { key: a.featureId }));
    batcher.addPart('surface', 'negative-a', part(b));
    batcher.addPart('surface', 'negative-b', part(c));
    batcher.addPart('surface', 'negative-copy', part(b));
    batcher.addPart('surface', 'unclaimed', part());
    const assembled = batcher.assemble('surface');
    const mesh = new THREE.Mesh(geometry(assembled.attributes.position), new THREE.MeshBasicMaterial());
    mesh.userData.surfaceClaim = a;
    mesh.userData.surfaceAuditRanges = assembled.surfaceAuditRanges;
    mesh.userData.entityRanges = assembled.ranges.filter(range => range.entity).map(range => ({ ...range, key: range.entity.key }));
    mesh.updateMatrixWorld(true);
    const scene = new THREE.Scene(); scene.add(mesh); scene.updateMatrixWorld(true);
    const result = collectAuditSurfaces(scene, { minX: -1, maxX: 10, minZ: -1, maxZ: 2 });
    const surface = result.surfaces[0];
    const hits = planTriangleHitsAt(surface.plan, 1, 1);
    assert.equal(hits.length, 5, 'collapse adjacent triangles, retain independent overlapping owners');
    const resolved = hits.map(hit => surfaceAuditClaimForFace(surface.surfaceAuditRanges, hit.faceIndex));
    assert.deepEqual(resolved.map(item => item?.featureId ?? null), [a.featureId, b.featureId, c.featureId, b.featureId, null]);
    const verdict = classifySurfaceStack(hits.map((hit, index) => ({
        y: hit.y, claim: resolved[index], publicationKey: 'same-aggregate',
        ownerKey: ownerRangeForFace(surface.surfaceAuditRanges, hit.faceIndex).ownerKey,
    })).filter(hit => hit.claim));
    const duplicate = verdict.violations.find(item => item.type === 'duplicate');
    assert.deepEqual(duplicate.ownerKeys.sort(), ['negative-a', 'negative-copy']);
    assert.equal(duplicate.copies, 2);
    const before = result.contentSignature;
    mesh.userData.surfaceAuditRanges[1].claim = claim(SURFACE_CLASS.ROAD_MARKING);
    assert.notEqual(collectAuditSurfaces(scene, { minX: -1, maxX: 10, minZ: -1, maxZ: 2 }).contentSignature, before);
});

test('unsupported geometry is counted and equal-count replacements change the settle signature', () => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(geometry(triangle), new THREE.MeshBasicMaterial());
    mesh.userData.surfaceClaim = claim(SURFACE_CLASS.TERRAIN);
    scene.add(mesh, new THREE.InstancedMesh(geometry(triangle), new THREE.MeshBasicMaterial(), 1));
    scene.updateMatrixWorld(true);
    const before = collectAuditSurfaces(scene, bounds);
    assert.equal(before.skipped['instanced-mesh'], 1);
    mesh.geometry.attributes.position.setY(0, 3);
    mesh.geometry.attributes.position.needsUpdate = true;
    const after = collectAuditSurfaces(scene, bounds);
    assert.equal(before.triangleCount, after.triangleCount);
    assert.notEqual(before.contentSignature, after.contentSignature);
});

test('unclaimed moving props do not prevent ground publication settlement', () => {
    const scene = new THREE.Scene();
    const prop = new THREE.Mesh(geometry(triangle), new THREE.MeshBasicMaterial());
    scene.add(prop); scene.updateMatrixWorld(true);
    const before = collectAuditSurfaces(scene, bounds).contentSignature;
    prop.position.x += 1; scene.updateMatrixWorld(true);
    assert.equal(collectAuditSurfaces(scene, bounds).contentSignature, before);
});

test('distant aggregate changes do not reset local settlement; local appearance still does', () => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(geometry([...triangle, ...triangle.map((value, index) => index % 3 === 0 ? value + 100 : value)]), new THREE.MeshBasicMaterial());
    mesh.userData.surfaceClaim = claim(SURFACE_CLASS.SIDEWALK);
    scene.add(mesh); scene.updateMatrixWorld(true);
    const before = collectAuditSurfaces(scene, bounds).contentSignature;
    mesh.geometry.attributes.position.setY(3, 5);
    mesh.geometry.attributes.position.needsUpdate = true;
    assert.equal(collectAuditSurfaces(scene, bounds).contentSignature, before);
    mesh.material.color.setHex(0x443322);
    assert.notEqual(collectAuditSurfaces(scene, bounds).contentSignature, before);
});

test('Three two-pass transparent material versions do not pretend the ground changed', () => {
    const scene = new THREE.Scene();
    const material = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry(triangle), material);
    mesh.userData.surfaceClaim = claim(SURFACE_CLASS.ROAD_MARKING);
    scene.add(mesh); scene.updateMatrixWorld(true);
    const before = collectAuditSurfaces(scene, bounds).contentSignature;
    // Match WebGLRenderer.renderObject's DoubleSide transparent branch.
    material.side = THREE.BackSide; material.needsUpdate = true;
    material.side = THREE.FrontSide; material.needsUpdate = true;
    material.side = THREE.DoubleSide;
    assert.equal(collectAuditSurfaces(scene, bounds).contentSignature, before);
    material.customProgramCacheKey = () => 'different-ground-shader';
    assert.notEqual(collectAuditSurfaces(scene, bounds).contentSignature, before);
});

test('unsupported inventory is scoped by recomputed world bounds', () => {
    const scene = new THREE.Scene();
    const base = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    const instances = new THREE.InstancedMesh(base, material, 1);
    instances.name = 'outside-instance';
    instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(100, 0, 100));
    scene.add(instances);
    scene.updateMatrixWorld(true);
    let result = collectAuditSurfaces(scene, bounds);
    assert.equal(result.skipped['instanced-mesh'] || 0, 0);
    assert.equal(result.skippedInventory[0].scope, 'outside');
    instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(1, 0, 1));
    instances.instanceMatrix.needsUpdate = true;
    result = collectAuditSurfaces(scene, bounds);
    assert.equal(result.skipped['instanced-mesh'], 1);
    assert.equal(result.skippedInventory[0].scope, 'intersecting');
    instances.userData.surfaceClaim = claim(SURFACE_CLASS.SIDEWALK);
    assert.deepEqual(collectAuditSurfaces(scene, bounds).skippedInventory[0].claim, instances.userData.surfaceClaim);
    const parent = new THREE.Group(); parent.position.set(-100, 0, -100);
    parent.add(instances); scene.add(parent); scene.updateMatrixWorld(true);
    assert.equal(collectAuditSurfaces(scene, bounds).skippedInventory[0].scope, 'outside');
    scene.position.set(100, 0, 100); scene.updateMatrixWorld(true);
    assert.equal(collectAuditSurfaces(scene, bounds).skippedInventory[0].scope, 'intersecting');
});

test('batch transforms and current skinned pose use object bounds, not source geometry bounds', () => {
    const scene = new THREE.Scene();
    const batch = new THREE.BatchedMesh(2, 6, 0, new THREE.MeshBasicMaterial());
    const id = batch.addInstance(batch.addGeometry(geometry(triangle)));
    batch.setMatrixAt(id, new THREE.Matrix4().makeTranslation(100, 0, 100));
    const skinGeo = geometry(triangle);
    skinGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
    skinGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    const skin = new THREE.SkinnedMesh(skinGeo, new THREE.MeshBasicMaterial());
    const bone = new THREE.Bone(); skin.add(bone); skin.bind(new THREE.Skeleton([bone]));
    bone.position.set(100, 0, 100);
    scene.add(batch, skin); scene.updateMatrixWorld(true);
    let result = collectAuditSurfaces(scene, bounds);
    assert.deepEqual(result.skipped, {});
    assert.deepEqual(result.skippedInventory.map(item => item.scope), ['outside', 'outside']);
    batch.setMatrixAt(id, new THREE.Matrix4()); bone.position.set(0, 0, 0);
    scene.updateMatrixWorld(true);
    result = collectAuditSurfaces(scene, bounds);
    assert.deepEqual(result.skipped, { 'batched-mesh': 1, 'skinned-mesh': 1 });
    assert.deepEqual(result.skippedInventory.map(item => item.bounds), [
        { minX: 0, maxX: 4, minZ: 0, maxZ: 4 }, { minX: 0, maxX: 4, minZ: 0, maxZ: 4 },
    ]);
});

test('unsupported objects with malformed bounds remain unknown inventory', () => {
    const scene = new THREE.Scene();
    const object = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    object.isInstancedMesh = true;
    object.computeBoundingBox = () => { throw new Error('malformed'); };
    object.name = 'unknown-instance';
    scene.add(object);
    scene.updateMatrixWorld(true);
    const result = collectAuditSurfaces(scene, bounds);
    assert.equal(result.skipped['instanced-mesh'], 1);
    assert.equal(result.skippedInventory[0].scope, 'unknown');
});
