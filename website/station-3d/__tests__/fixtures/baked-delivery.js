// Real headed HTTP contract gate. Publication is deliberately not an HTTP/browser operation.
import * as THREE from 'three';
import { validateWorldManifest } from '../../core/baked-world-manifest.js';
import { createFarBuildingPacketUploadTask } from '../../core/far-building-packet-three.js';
import { applyFarBuildingTint } from '../../world/far-building-color.js';
import { FAR_SHADOW_COMPATIBILITY } from '../../core/baked-world-shadow-session.js';

const api = 'http://localhost:8198';
const report = window.auditResult = { phase: 'loading', done: false, cases: [], errors: [], workerCount: 0 };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const show = () => { document.querySelector('#result').textContent = JSON.stringify(report, null, 2); };
const fail = error => { report.errors.push(error.stack || String(error)); report.done = true; report.passed = false; show(); };
addEventListener('error', event => fail(new Error(event.message)));
addEventListener('unhandledrejection', event => fail(event.reason));
const compatibility = FAR_SHADOW_COMPATIBILITY;

async function manifest(location, release = null, layers = compatibility) {
    const path = `/api/station3d/manifest?location=${location}` + (release ? `&release=${release}` : '');
    const response = await fetch(api + path, { cache: 'no-store' });
    assert(response.ok, `Manifest HTTP ${response.status}`);
    const value = validateWorldManifest(await response.json(), { location, releaseId: release, layers });
    return { value, etag: response.headers.get('etag'), cache: response.headers.get('cache-control') };
}
function decode(bytes, descriptor) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./baked-world-worker.js', import.meta.url), { type: 'module' });
        report.workerCount++;
        const finish = () => { worker.terminate(); report.workerCount--; };
        worker.onmessage = ({ data }) => { finish(); data.error ? reject(new Error(data.error.message)) : resolve(data.tile); };
        worker.onerror = event => { finish(); reject(new Error(event.message)); };
        worker.postMessage({ bytes, expected: { ...descriptor, checksum: descriptor.sha256 } }, [bytes]);
        assert(bytes.byteLength === 0, 'Tile bytes were copied instead of transferred into the Worker');
    });
}
async function draw(tile) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1); renderer.setSize(720, 520); document.querySelector('#views').append(renderer.domElement);
    const gl = renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    report.renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    assert(!/SwiftShader|llvmpipe/i.test(report.renderer), 'Headed real GPU required');
    const material = new THREE.MeshLambertMaterial();
    const task = createFarBuildingPacketUploadTask(tile.packet, { material, replacementKey: 'http-pilot', chunkSize: 32,
        colorForEntity: identity => applyFarBuildingTint(new THREE.Color(), identity.metadata.color, identity.objectId) });
    let uploadFrames = 0;
    while (!task.done) {
        const start = performance.now(); let count = 0;
        do { task.step(1); count++; } while (!task.done && count < 24 && performance.now() - start < 4);
        uploadFrames++; await nextFrame();
    }
    const root = task.result(), scene = new THREE.Scene(); scene.background = new THREE.Color('#243446');
    scene.add(root, new THREE.AmbientLight(0xffffff, 2.4));
    const bounds = new THREE.Box3().setFromObject(root), center = bounds.getCenter(new THREE.Vector3());
    const camera = new THREE.PerspectiveCamera(47, 720 / 520, 0.1, 5000);
    camera.position.copy(center).add(new THREE.Vector3(700, 950, 850)); camera.lookAt(center);
    renderer.render(scene, camera); await nextFrame(); renderer.render(scene, camera);
    const pixels = new Uint8Array(720 * 520 * 4); gl.readPixels(0, 0, 720, 520, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let visiblePixels = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] !== pixels[0] || pixels[i+1] !== pixels[1] || pixels[i+2] !== pixels[2]) visiblePixels++;
    assert(visiblePixels > 1000, 'Uploaded scene is empty/hidden');
    const refs = root.children.flatMap(batch => batch.userData.lodRefs);
    assert(refs.length === tile.packet.primitives.length, 'HTTP upload lost a building');
    const hnk = tile.entities.filter(entity => entity.parentId === 'landmark:hnk');
    assert(hnk.length === 5 && hnk.every(entity => refs.some(ref => ref.objectId === entity.objectId)), 'HNK material parts missing after delivery');
    report.gpu = { visiblePixels, identities: refs.length, uploadFrames, glError: gl.getError() };
    assert(report.gpu.glError === 0, 'GPU upload/render error');
    return { renderer, root, material };
}

async function run() {
    const active = await manifest('zagreb-clean-bake-pilot');
    assert(active.value.releaseId === 'zagreb-clean-live-v3-b', 'Start this gate with isolated release B active');
    assert(active.cache === 'no-cache', 'Active manifest must revalidate');
    const pinnedA = await manifest('zagreb-clean-bake-pilot', 'zagreb-clean-live-v3-a');
    assert(pinnedA.cache.includes('immutable'), 'Retained pinned manifest must be immutable');
    const descriptor = active.value.tiles[0], url = api + descriptor.url;
    const cold = await fetch(url, { cache: 'reload' });
    assert(cold.status === 200 && cold.headers.get('content-encoding') === 'gzip', 'Browser did not receive stored gzip bytes');
    assert(Number(cold.headers.get('content-length')) === descriptor.gzip.byteLength, 'Wrong transferred representation length');
    assert(cold.headers.get('etag') === `"${descriptor.gzip.sha256}"`, 'Gzip ETag mismatch');
    const coldBytes = await cold.arrayBuffer();
    assert(coldBytes.byteLength === descriptor.byteLength, 'Browser gzip decoding changed canonical byte length');
    const badBytes = coldBytes.slice(0); new Uint8Array(badBytes)[badBytes.byteLength - 1] ^= 1;
    let corruptRejected = false;
    try { await decode(badBytes, descriptor); } catch (error) { corruptRejected = /checksum/i.test(error.message); }
    assert(corruptRejected, 'Corrupt bytes reached geometry publication');
    const tile = await decode(coldBytes, descriptor);
    const warm = await fetch(url, { cache: 'force-cache' });
    const warmTile = await decode(await warm.arrayBuffer(), descriptor);
    assert(warmTile.entities.length === tile.entities.length, 'Warm-cache identity mismatch');
    report.cases.push({ name: 'cold and warm immutable delivery', releaseId: active.value.releaseId, pinnedReleaseId: pinnedA.value.releaseId,
        decodedBytes: descriptor.byteLength, gzipBytes: descriptor.gzip.byteLength, sha256: descriptor.sha256, passed: true });
    const conditional = await fetch(url, { cache: 'no-store', headers: { 'If-None-Match': cold.headers.get('etag') } });
    assert(conditional.status === 304, `Conditional request did not return 304 (${conditional.status})`);
    const missing = await fetch(api + '/api/station3d/tiles/far-buildings/missing-revision/1/15/17837/11682.bin', { cache: 'no-store' });
    assert(missing.status === 404 && missing.headers.get('cache-control') === 'no-store', 'Missing tile became cached empty success');
    // Retained explicit-empty v1 fixture also proves old published bytes remain readable.
    const emptyManifest = await manifest('bake-empty-fixture', null, {
        'far-buildings': { ...compatibility['far-buildings'], bakeVersion: '1.1.0' },
    });
    const emptyDescriptor = emptyManifest.value.tiles[0];
    const emptyResponse = await fetch(api + emptyDescriptor.url, { cache: 'reload' });
    const empty = await decode(await emptyResponse.arrayBuffer(), emptyDescriptor);
    assert(empty.state === 'empty' && empty.packet.primitives.length === 0, 'Explicit empty tile did not survive delivery');
    report.cases.push({ name: 'conditional, missing, corrupt and explicit empty contracts', conditional: 304, missing: 404,
        corruptRejected, syntheticEmptyFixture: true, passed: true });
    await draw(tile);
    assert(report.workerCount === 0, 'Decode Worker leaked');
    report.phase = 'awaiting-rollback'; show();
    document.querySelector('#rollback').disabled = false;
    document.querySelector('#rollback').onclick = async () => {
        try {
            const current = await manifest('zagreb-clean-bake-pilot');
            assert(current.value.releaseId === 'zagreb-clean-live-v3-a', 'Isolated rollback did not restore release A');
            const retainedB = await manifest('zagreb-clean-bake-pilot', 'zagreb-clean-live-v3-b');
            const response = await fetch(api + retainedB.value.tiles[0].url, { cache: 'reload' });
            const retained = await decode(await response.arrayBuffer(), retainedB.value.tiles[0]);
            assert(retained.packet.primitives.length === descriptor.primitives, 'Pinned B stopped serving after rollback');
            report.cases.push({ name: 'atomic rollback with retained pinned release', active: current.value.releaseId,
                retained: retainedB.value.releaseId, retainedPrimitives: retained.packet.primitives.length, passed: true });
            report.done = true; report.phase = 'complete'; report.passed = report.errors.length === 0 && report.workerCount === 0;
            document.querySelector('#rollback').disabled = true; show();
        } catch (error) { fail(error); }
    };
}
try { await run(); } catch (error) { fail(error); }
