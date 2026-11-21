import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { localFileResolver, loadProceduralModule, createModelImporter } from '../viewers/model-import.js';
import { cameraNearPlane, copyModelPreview, disposePreview, normalizePreview, fitCamera, inspectModel } from '../viewers/model-viewer-core.js';

const file = (name, path = name) => ({ name, webkitRelativePath: path });

test('local companion resolver preserves paths and rejects missing or ambiguous basenames', () => {
    const urls = []; const resolver = localFileResolver([file('a.bin', 'one/a.bin'), file('a.bin', 'two/a.bin')], f => { const u = `blob:${f.webkitRelativePath}`; urls.push(u); return u; });
    assert.equal(resolver.resolve('https://x/one/a.bin'), 'blob:one/a.bin');
    assert.throws(() => resolver.resolve('a.bin'), /Missing or ambiguous/);
    assert.throws(() => resolver.resolve('missing.bin'), /Missing or ambiguous/);
    resolver.dispose(); assert.equal(urls.length, 1);
});

test('procedural loader selects exports and passes positional parameters', async () => {
    const group = new THREE.Group();
    const loaded = await loadProceduralModule('virtual', { exportName: 'make', parameters: [3, 'x'], importer: async () => ({ make: (n, s) => { group.userData.args = [n, s]; return group; } }) });
    assert.equal(loaded.object, group); assert.deepEqual(group.userData.args, [3, 'x']);
    await assert.rejects(() => loadProceduralModule('virtual', { importer: async () => ({ a: () => group, b: () => group }) }), /Choose a module export/);
});

test('normalization accepts geometry, scenes and wrapper animations', () => {
    const geometry = new THREE.BoxGeometry(1, 2, 3);
    assert.equal(normalizePreview(geometry).object.isMesh, true);
    const scene = new THREE.Scene(); assert.equal(normalizePreview(scene).object, scene);
    const clip = new THREE.AnimationClip('move', 1, []); const root = new THREE.Group(); root.animations = [clip];
    assert.deepEqual(normalizePreview({ root }).animations, [clip]);
    assert.throws(() => normalizePreview({ nope: true }), /must return/);
});

test('headless importer parses JSON object, BufferGeometry, OBJ, STL and PLY', async () => {
    const importer = await createModelImporter(null, { decoderBase: 'http://localhost/vendor/' });
    const object = await importer.parse(JSON.stringify({ object: { uuid: 'r', type: 'Group', children: [{ uuid: 'm', type: 'Mesh', geometry: 'g', material: 'mat' }], matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, geometries: [{ uuid: 'g', type: 'BoxGeometry', width: 1, height: 1, depth: 1 }], materials: [{ uuid: 'mat', type: 'MeshStandardMaterial', color: 16777215 }], metadata: { version: 4.6, type: 'Object' }}), 'json');
    assert.ok(inspectModel(object.object).triangles > 0);
    const geo = await importer.parse(JSON.stringify({ metadata: { version: 4.6, type: 'BufferGeometry' }, data: { attributes: { position: { itemSize: 3, type: 'Float32Array', array: [0, 0, 0, 1, 0, 0, 0, 1, 0] }, normal: { itemSize: 3, type: 'Float32Array', array: [0, 0, 1, 0, 0, 1, 0, 0, 1] } }, index: { type: 'Uint16Array', array: [0, 1, 2] } } }), 'json');
    assert.equal(inspectModel(geo.object).triangles, 1);
    const obj = await importer.parse('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', 'obj'); assert.equal(inspectModel(obj.object).triangles, 1);
    const stl = await importer.parse('solid x\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\nendsolid x', 'stl'); assert.equal(inspectModel(stl.object).triangles, 1);
    const ply = await importer.parse('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n', 'ply'); assert.equal(inspectModel(ply.object).triangles, 1);
    importer.dispose();
});

test('camera depth precision separates thin paint from the skin at inspection distances', () => {
    for (const distance of [.02, .3, 1, 5, 20, 40]) {
        const near = cameraNearPlane(distance), far = 1000;
        const camera = new THREE.PerspectiveCamera(38, 1, near, far);
        const skin = new THREE.Vector3(0, 0, -distance).project(camera).z;
        const paint = new THREE.Vector3(0, 0, -distance + .0012).project(camera).z;
        const depthSteps = Math.abs(skin - paint) / 2 * (2 ** 24 - 1);
        assert.ok(depthSteps > 4, `1.2 mm paint remains separated at ${distance} m (${depthSteps} depth levels)`);
        assert.ok(near < distance * .02, 'the near plane stays clear of close inspection targets');
    }
});

test('fitCamera frames every corner of wide and tall bounds at both aspect ratios', () => {
    for (const bounds of [new THREE.Box3(new THREE.Vector3(-5, -.5, -.5), new THREE.Vector3(5, .5, .5)), new THREE.Box3(new THREE.Vector3(-.5, -5, -.5), new THREE.Vector3(.5, 5, .5))]) {
        for (const aspect of [0.6, 2]) {
            const frame = fitCamera(bounds, aspect);
            const camera = new THREE.PerspectiveCamera(frame.fov, aspect, frame.near, frame.far);
            camera.position.copy(frame.position); camera.lookAt(frame.target); camera.updateMatrixWorld(true);
            for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
                const point = new THREE.Vector3(x, y, z).project(camera);
                assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && Math.abs(point.z) < 1);
            }
        }
    }
});

test('glTF and GLB retain animation tracks and reach the same sampled pose', async () => {
    const importer = await createModelImporter(null);
    const binary = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 2, 0, 0]).buffer);
    const gltf = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
        nodes: [{ name: 'AnimatedTriangle', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        buffers: [{ byteLength: binary.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 8 }, { buffer: 0, byteOffset: 44, byteLength: 24 }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
            { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
            { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
        ],
        animations: [{ name: 'Slide', samplers: [{ input: 1, output: 2 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }],
    };
    const jsonBytes = Buffer.from(JSON.stringify(gltf));
    const padded = Buffer.alloc(Math.ceil(jsonBytes.length / 4) * 4, 32); jsonBytes.copy(padded);
    const glb = Buffer.alloc(12 + 8 + padded.length + 8 + binary.length);
    glb.write('glTF', 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
    glb.writeUInt32LE(binary.length, 20 + padded.length); glb.writeUInt32LE(0x004e4942, 24 + padded.length); binary.copy(glb, 28 + padded.length);
    gltf.buffers[0].uri = 'data:application/octet-stream;base64,' + binary.toString('base64');
    globalThis.ProgressEvent ??= class { constructor(type, values) { this.type = type; Object.assign(this, values); } };
    for (const [data, format] of [[JSON.stringify(gltf), 'gltf'], [glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), 'glb']]) {
        const preview = await importer.parse(data, format);
        assert.equal(inspectModel(preview.object).triangles, 1);
        assert.equal(preview.animations[0].name, 'Slide');
        const mixer = new THREE.AnimationMixer(preview.object);
        mixer.clipAction(preview.animations[0]).play(); mixer.setTime(.5);
        assert.equal(preview.object.getObjectByName('AnimatedTriangle').position.x, 1);
    }
    importer.dispose();
});

test('Three.js JSON animations remain playable after import', async () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.name = 'Box';
    mesh.animations = [new THREE.AnimationClip('Lift', 1, [new THREE.NumberKeyframeTrack('.position[y]', [0, 1], [0, 4])])];
    const importer = await createModelImporter(null);
    const preview = await importer.parse(JSON.stringify(mesh.toJSON()), 'json');
    const mixer = new THREE.AnimationMixer(preview.object);
    mixer.clipAction(preview.animations[0]).play(); mixer.setTime(.5);
    assert.equal(preview.object.position.y, 2);
});

test('in-memory meshes remain reusable after another preview is disposed', async () => {
    let sourceDisposals = 0, imageCloses = 0;
    const texture = new THREE.Texture({ close() { imageCloses++; } });
    const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: texture }));
    for (const resource of [source.geometry, source.material, texture]) resource.addEventListener('dispose', () => sourceDisposals++);
    const first = copyModelPreview(source);
    const second = await loadProceduralModule('virtual', { importer: async () => ({ default: source }) });
    assert.notEqual(first.object, source);
    assert.notEqual(first.object.geometry, second.object.geometry);
    assert.notEqual(first.object.material.map, texture);
    assert.equal(first.object.material.map.image, texture.image);
    first.object.position.x = 9;
    disposePreview(first);
    assert.equal(sourceDisposals, 0);
    assert.equal(imageCloses, 0);
    assert.equal(second.object.position.x, 0);
    assert.equal(inspectModel(second.object).triangles, 12);
    disposePreview(second);
    assert.throws(() => copyModelPreview({ object: source, seek() {} }), /factory function/);
});
