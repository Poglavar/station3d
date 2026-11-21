// Physical reads must match actual transformed/instanced faces without moving
// the source root, and reject incomplete or oversized replacement support.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { buildCurbSurfaceTrimeshData } from '../core/gta-curb-surface.js';

const run = steps => { let next; do { next = steps.next(); } while (!next.done); return next.value; };
const limits = { revision: 1, maxObjects: 10, maxVertices: 1000, maxTriangles: 1000, include: () => true };

test('private transformed instance support matches rendered boxes and preserves the active root', () => {
    const root = new THREE.Group(), geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshBasicMaterial();
    const boxes = new THREE.InstancedMesh(geometry, material, 2); root.add(boxes); root.position.y = 2;
    boxes.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-3, 0, 0));
    boxes.setMatrixAt(1, new THREE.Matrix4().compose(new THREE.Vector3(3, 1, 0),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .5), new THREE.Vector3(-1, 2, 1)));
    const before = [...boxes.instanceMatrix.array], activeMatrix = [...root.matrix.elements];
    const read = run(captureReceiverMeshReadSteps({ ...limits, root, maxObjects: 4,
        rootTransform: new THREE.Matrix4().makeTranslation(0, 10, 0) }));
    try {
        assert.equal(root.position.y, 2); assert.deepEqual([...root.matrix.elements], activeMatrix);
        assert.deepEqual([...boxes.instanceMatrix.array], before); assert.equal(read.surfaces.length, 2);
        assert.equal(read.surfacesNear(-3, 0, .1).length, 1); assert.equal(read.surfacesNear(100, 100, 1).length, 0);
        const data = buildCurbSurfaceTrimeshData({ surfaces: read.surfaces, centerX: 0, centerZ: 0, radiusM: 20 });
        assert.equal(data.triangleCount, 24);
        const actual = new THREE.BufferGeometry();
        actual.setAttribute('position', new THREE.BufferAttribute(data.vertices, 3));
        actual.setIndex(new THREE.BufferAttribute(data.indices, 1));
        const captured = new THREE.Mesh(actual, material), expected = boxes.clone();
        expected.position.y = 10;
        for (const x of [-3, 3]) {
            const ray = new THREE.Raycaster(new THREE.Vector3(x, 20, 0), new THREE.Vector3(0, -1, 0));
            captured.updateWorldMatrix(true, true); expected.updateWorldMatrix(true, true);
            assert.ok(Math.abs(ray.intersectObject(captured)[0].point.y - ray.intersectObject(expected)[0].point.y) < .001);
        }
        actual.dispose();
    } finally { geometry.dispose(); material.dispose(); }
});

test('complete receiver capacities, cancellation and singular or imprecise transforms reject before publication', () => {
    const root = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    try {
        assert.equal(run(captureReceiverMeshReadSteps({ ...limits, root, maxObjects: 1 })).surfaces.length, 1);
        for (const capacity of [{ maxVertices: 23 }, { maxTriangles: 11 }]) {
            assert.throws(() => run(captureReceiverMeshReadSteps({ ...limits, root, ...capacity })), { code: 'ground-generation-capacity' });
        }
        let clock = 0, current = true;
        const cancelled = captureReceiverMeshReadSteps({ ...limits, root, now: () => clock++, isCurrent: () => current });
        assert.equal(cancelled.next().done, false); current = false;
        assert.throws(() => run(cancelled), { code: 'ground-generation-stale' });
        assert.throws(() => run(captureReceiverMeshReadSteps({ ...limits, root,
            rootTransform: new THREE.Matrix4().makeScale(0, 1, 1) })), { code: 'ground-backstop-unavailable' });
        assert.throws(() => run(captureReceiverMeshReadSteps({ ...limits, root,
            rootTransform: new THREE.Matrix4().makeScale(1e9 + .1, 1, 1) })), { code: 'ground-receiver-precision' });
        assert.equal(run(captureReceiverMeshReadSteps({ ...limits, root, include: () => false })).surfaces.length, 0);
    } finally { root.geometry.dispose(); root.material.dispose(); }
});

test('captured physical indices cannot change when the source mesh is edited', () => {
    const root=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),new THREE.MeshBasicMaterial());
    try {
        const read=run(captureReceiverMeshReadSteps({...limits,root})),indices=read.surfaces[0].indices.slice();
        assert.notEqual(read.surfaces[0].indices,root.geometry.index.array);
        root.geometry.index.array.fill(0);root.geometry.attributes.position.array.fill(100);
        assert.deepEqual(read.surfaces[0].indices,indices);
        const data=buildCurbSurfaceTrimeshData({surfaces:read.surfaces,centerX:0,centerZ:0,radiusM:5});
        assert.equal(data.triangleCount,12);
        const actual=meshFromSurface(read.surfaces[0],root.material);
        assert.equal(new THREE.Raycaster(new THREE.Vector3(0,5,0),new THREE.Vector3(0,-1,0)).intersectObject(actual)[0].point.y,1);
        actual.geometry.dispose();
    } finally {root.geometry.dispose();root.material.dispose();}
});

function meshFromSurface(surface,material) {
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(surface.positions,3));
    if(surface.indices)geometry.setIndex(new THREE.BufferAttribute(surface.indices,1));
    const mesh=new THREE.Mesh(geometry,material);mesh.position.set(surface.originX,0,surface.originZ);mesh.updateMatrixWorld(true);return mesh;
}

test('translated support stays local through query and physics-origin conversion', () => {
    const root = new THREE.Mesh(new THREE.PlaneGeometry(6,6), new THREE.MeshBasicMaterial());
    root.geometry.rotateX(-Math.PI/2);
    const position = root.geometry.attributes.position;
    for (let i=0; i<position.count; i++) position.setY(i, position.getX(i)*.2+position.getZ(i)*.3);
    root.position.set(100000.321, 4, -100000.654); root.rotation.y=.4; root.scale.set(1.3,1.2,.8);
    try {
        const read = run(captureReceiverMeshReadSteps({ ...limits, root }));
        const surface = read.surfaces[0];
        assert.equal(surface.originX,root.position.x); assert.equal(surface.originZ,root.position.z);
        assert.ok(surface.positions.every(value => Math.abs(value) < 10));
        const physicsOrigin = { x: root.position.x+50, z: root.position.z-30 };
        const data = buildCurbSurfaceTrimeshData({ surfaces: read.surfaces, centerX: root.position.x,
            centerZ: root.position.z, radiusM: 20, physicsOrigin, maxTriangles: 2 });
        assert.equal(data.triangleCount,2); assert.equal(data.truncated,false);
        const collider = meshFromSurface({ positions: data.vertices, indices: data.indices,
            originX: physicsOrigin.x, originZ: physicsOrigin.z }, root.material);
        root.updateMatrixWorld(true);
        for (const dx of [-.7,0,.7]) for (const dz of [-.8,0,.8]) {
            const x=root.position.x+dx,z=root.position.z+dz;
            const ray = new THREE.Raycaster(new THREE.Vector3(x,20,z),new THREE.Vector3(0,-1,0));
            const expected = ray.intersectObject(root)[0].point.y;
            assert.ok(Math.abs(read.supportYAt(x,z)-expected)<1e-6);
            assert.ok(Math.abs(ray.intersectObject(collider)[0].point.y-expected)<1e-5);
        }
        collider.geometry.dispose();
    } finally { root.geometry.dispose(); root.material.dispose(); }
});

test('a receiver without an override captures the actual ancestor transform without updating the live tree', () => {
    const parent=new THREE.Group(),root=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),new THREE.MeshBasicMaterial());
    parent.position.set(8,3,-4);parent.rotation.y=.35;parent.scale.set(2,1.5,.5);parent.add(root);root.position.y=2;
    const matrices=[...parent.matrix.elements,...root.matrix.elements];
    try {
        const read=run(captureReceiverMeshReadSteps({...limits,root}));
        assert.deepEqual([...parent.matrix.elements,...root.matrix.elements],matrices,'capture never updates live transforms');
        const captured=meshFromSurface(read.surfaces[0],root.material);
        parent.updateMatrixWorld(true);
        const ray=new THREE.Raycaster(new THREE.Vector3(8,20,-4),new THREE.Vector3(0,-1,0));
        assert.ok(Math.abs(ray.intersectObject(captured)[0].point.y-ray.intersectObject(root)[0].point.y)<.001);
        captured.geometry.dispose();
        const privateRead=run(captureReceiverMeshReadSteps({...limits,root,rootTransform:new THREE.Matrix4().makeTranslation(0,10,0)}));
        const privateMesh=meshFromSurface(privateRead.surfaces[0],root.material);
        assert.equal(new THREE.Raycaster(new THREE.Vector3(0,20,0),new THREE.Vector3(0,-1,0)).intersectObject(privateMesh)[0].point.y,11,
            'an explicit root transform is a complete world pose');
        privateMesh.geometry.dispose();
    } finally {root.geometry.dispose();root.material.dispose();}
});

test('invalid physical indices reject the complete capture before a collider can omit their faces', () => {
    const root=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial());
    root.geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,0,0,1,1,0,0],3));
    try {
        for(const invalid of[-1,.5,3,NaN,Infinity]) {
            root.geometry.setIndex(new THREE.BufferAttribute(new Float32Array([0,1,invalid]),1));
            assert.throws(()=>run(captureReceiverMeshReadSteps({...limits,root})),/vertex index/);
        }
    } finally {root.geometry.dispose();root.material.dispose();}
});

test('index copying remains cancellable after position capture', () => {
    const root=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial());
    const before=root.geometry.index.array.slice();let current=true,time=0;
    try {
        const steps=captureReceiverMeshReadSteps({...limits,root,now:()=>time++,isCurrent:()=>current});
        for(;;){const next=steps.next();assert.equal(next.done,false);if(next.value.phase==='receiver-support-indices')break;}
        current=false;assert.throws(()=>run(steps),{code:'ground-generation-stale'});
        assert.deepEqual(root.geometry.index.array,before);
    } finally {root.geometry.dispose();root.material.dispose();}
});

test('an empty index or zero-area faces cannot masquerade as physical replacement support', () => {
    const root=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial());
    root.geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,0,0,1,1,0,0],3));
    try {
        for(const indices of[[],[0,0,1]]) {
            root.geometry.setIndex(indices);
            assert.equal(run(captureReceiverMeshReadSteps({...limits,root})).surfaces.length,0);
        }
    } finally {root.geometry.dispose();root.material.dispose();}
});
