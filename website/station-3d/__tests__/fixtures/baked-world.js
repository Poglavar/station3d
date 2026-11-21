// Real-GPU, independent direct-v-decoded render and picking checks at a 2x2 seam.
import * as THREE from 'three';
import { geoToLocal, localToGeo, EARTH_RADIUS_M } from '../../core/math.js';
import { worldTileAt, worldTileFrame } from '../../core/world-tile-placement.js';
import { applyWorldTilePlacement } from '../../core/world-tile-three.js';
import { compileFarBuildingRenderPacket } from '../../core/compilers/far-building-render-packet.js';
import { createFarBuildingPacketUploadTask } from '../../core/far-building-packet-three.js';
import { BAKED_WORLD_TILE_CONTRACT, encodeBakedWorldTile, bakedWorldTileChecksum } from '../../core/baked-world-tile.js';
import { setSceneRenderOrigin, applyRenderOriginForRender, resetSceneRenderOrigin } from '../../core/render-origin.js';

const evidence = window.auditResult = { done: false, cases: [], errors: [] };
addEventListener('error', event => evidence.errors.push(event.message));
addEventListener('unhandledrejection', event => evidence.errors.push(String(event.reason)));
const logError = console.error.bind(console);
console.error = (...args) => { evidence.errors.push(args.map(String).join(' ')); logError(...args); };
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(384, 320);
const referenceCanvas = document.createElement('canvas'); referenceCanvas.width = 384; referenceCanvas.height = 320;
document.querySelector('#views').append(referenceCanvas, renderer.domElement);
const gl = renderer.getContext();
const debug = gl.getExtension('WEBGL_debug_renderer_info');
evidence.renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
const material = new THREE.MeshStandardMaterial({ roughness: 0.85 });

function decodeInWorker(bytes, expected) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./baked-world-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
            worker.terminate();
            if (data.error) reject(new Error(data.error.message)); else resolve(data.tile);
        };
        worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
        worker.postMessage({ bytes, expected }, [bytes]);
    });
}
const tile0 = worldTileFrame(worldTileAt(15.97, 45.81, 15));
const center = worldTileFrame({ ...tile0, x: tile0.x + 1, y: tile0.y + 1 });
const shapes = [
    [-32, -30, -2, -2, 19, 0xa9c98d], [2, -30, 27, -2, 32, 0xc8a789],
    [-32, 2, -2, 25, 12, 0x93b7d5], [2, 2, 27, 25, 24, 0xd4c089],
];
const fixtures = shapes.map(([west, north, east, south, heightM, color], index) => {
    const tile = worldTileFrame({ ...tile0, x: tile0.x + index % 2, y: tile0.y + Math.floor(index / 2) });
    const ring = [[west, north], [east, north], [east, south], [west, south], [west, north]]
        .map(([x, z]) => { const p = localToGeo(x, z, center.originLon, center.originLat); return [p.lon, p.lat]; });
    const feature = { geometry: { type: 'Polygon', coordinates: [ring] }, heightM, baseY: 0, color, entityId: `fixture:${index}`, objectId: `fixture:${index}` };
    const packet = compileFarBuildingRenderPacket({ sourceRevision: 'synthetic-1', generation: 0, tile, inputs: {
        anchorLon: tile.originLon, anchorLat: tile.originLat, tileOriginX: 0, tileOriginZ: 0, features: [feature],
    } });
    return { tile, feature, centroid: localToGeo((west + east) / 2, (north + south) / 2, center.originLon, center.originLat), baked: {
        contract: BAKED_WORLD_TILE_CONTRACT, schemaVersion: 1, layer: 'far-buildings', revision: 'synthetic-1', sourceRevision: 'synthetic-1',
        lod: 1, state: 'ready', tile, packet,
        frame: { projection: 'station3d-equirectangular-v1', units: 'metres', axes: 'east-up-south', earthRadiusM: EARTH_RADIUS_M,
            vertical: { mode: 'foundation-relative', datum: null, originHeightM: 0 } },
        materials: { 'far-buildings': { profile: 'far-buildings-v1' } },
        entities: [{ entityId: feature.entityId, objectId: feature.objectId }],
    } };
});

async function upload(packet, key) {
    const task = createFarBuildingPacketUploadTask(packet, { material, replacementKey: key, chunkSize: 32 });
    while (!task.step(1)) await nextFrame();
    return task.result();
}
function scene() {
    const result = new THREE.Scene(); result.background = new THREE.Color('#243446');
    result.add(new THREE.AmbientLight(0xffffff, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(-30, 80, 50); result.add(sun);
    return result;
}
function render(view, anchor, origin, orbit) {
    const centerLocal = geoToLocal(center.originLon, center.originLat, anchor.lon, anchor.lat);
    const camera = new THREE.PerspectiveCamera(48, 384 / 320, 0.1, 500);
    camera.position.set(centerLocal.x + 93 * Math.cos(orbit), 92, centerLocal.z + 93 * Math.sin(orbit));
    camera.lookAt(centerLocal.x, 10, centerLocal.z);
    // Move lighting with the scene, so changing anchor does not change the light.
    view.children.find(child => child.isDirectionalLight).position.set(centerLocal.x - 30, 80, centerLocal.z + 50);
    const sun = view.children.find(child => child.isDirectionalLight);
    sun.target.position.set(centerLocal.x, 0, centerLocal.z); sun.target.updateMatrixWorld(true);
    setSceneRenderOrigin(view, origin); applyRenderOriginForRender(view, camera);
    renderer.render(view, camera);
    const pixels = new Uint8Array(384 * 320 * 4);
    gl.readPixels(0, 0, 384, 320, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    resetSceneRenderOrigin(view);
    return pixels;
}
function picks(view, anchor) {
    view.updateMatrixWorld(true);
    return fixtures.map(item => {
        const p = geoToLocal(item.centroid.lon, item.centroid.lat, anchor.lon, anchor.lat);
        const hits = new THREE.Raycaster(new THREE.Vector3(p.x, 100, p.z), new THREE.Vector3(0, -1, 0)).intersectObject(view, true);
        const hit = hits.find(entry => entry.object.isBatchedMesh);
        assert(hit, `No pick for ${item.feature.entityId}`);
        return { id: hit.object.userData.objectIdsByBatchId[hit.batchId], height: hit.point.y };
    });
}
function dispose(view) {
    view.traverse(child => { if (child.isBatchedMesh) child.dispose(); });
    view.clear();
}
async function run() {
    assert(!/SwiftShader|llvmpipe/i.test(evidence.renderer), 'A real headed GPU is required');
    for (const item of fixtures) {
        const bytes = encodeBakedWorldTile(item.baked);
        const checksum = await bakedWorldTileChecksum(bytes);
        item.decoded = await decodeInWorker(bytes, { checksum, revision: 'synthetic-1', tile: item.tile });
        assert(bytes.byteLength === 0, 'Worker input was not transferred');
    }
    for (const [label, anchor, origin] of [
        ['original anchor', { lon: 15.97, lat: 45.81 }, { x: 0, z: 0 }],
        ['different anchor', { lon: 16.05, lat: 46.15 }, { x: 0, z: 0 }],
        ['floating-origin rebase', { lon: 16.05, lat: 46.15 }, { x: -2300, z: 37000 }],
    ]) {
        const reference = scene(), decoded = scene();
        for (const item of fixtures) {
            const tileOrigin = geoToLocal(item.tile.originLon, item.tile.originLat, anchor.lon, anchor.lat);
            const direct = compileFarBuildingRenderPacket({ sourceRevision: 'synthetic-1', generation: 0, tile: item.tile,
                inputs: { anchorLon: anchor.lon, anchorLat: anchor.lat, tileOriginX: tileOrigin.x, tileOriginZ: tileOrigin.z, features: [item.feature] } });
            const directRoot = await upload(direct, `direct:${item.feature.entityId}`);
            directRoot.position.set(tileOrigin.x, 0, tileOrigin.z); directRoot.updateMatrix();
            reference.add(directRoot);
            decoded.add(applyWorldTilePlacement(await upload(item.decoded.packet, `decoded:${item.feature.entityId}`), item.tile, { anchor }));
        }
        let differingPixels = 0, maxChannelDelta = 0;
        for (const orbit of [0.55, 1.1, 2.25]) {
            await nextFrame();
            const a = render(reference, anchor, origin, orbit);
            referenceCanvas.getContext('2d').drawImage(renderer.domElement, 0, 0);
            const b = render(decoded, anchor, origin, orbit);
            for (let p = 0; p < a.length; p += 4) {
                let differs = false;
                for (let c = 0; c < 3; c++) { const d = Math.abs(a[p+c] - b[p+c]); maxChannelDelta = Math.max(maxChannelDelta, d); if (d > 1) differs = true; }
                if (differs) differingPixels++;
            }
        }
        const aPicks = picks(reference, anchor), bPicks = picks(decoded, anchor);
        for (let i = 0; i < fixtures.length; i++) {
            assert(aPicks[i].id === fixtures[i].feature.entityId && bPicks[i].id === aPicks[i].id, `Picking identity mismatch ${label}`);
            assert(Math.abs(aPicks[i].height - bPicks[i].height) < 0.001, `Picking height mismatch ${label}`);
        }
        // A scaled tile-local Float32 frame and direct projection can rasterize
        // a few boundary pixels differently. Picking/height remains independent.
        assert(differingPixels < 100, `Unexpected visual drift ${label}: ${differingPixels} pixels`);
        evidence.cases.push({ label, differingPixels, maxChannelDelta, picks: bPicks, passed: true });
        dispose(reference); dispose(decoded);
    }
    const malformed = encodeBakedWorldTile(fixtures[0].baked);
    new Uint8Array(malformed)[0] = 0;
    let rejected = false;
    try { await decodeInWorker(malformed, {}); } catch (error) { rejected = /magic/i.test(error.message); }
    assert(rejected, 'Malformed Worker input must fail before upload');
    evidence.cases.push({ label: 'malformed packet rejected before upload', passed: rejected });
    evidence.glError = gl.getError(); assert(evidence.glError === gl.NO_ERROR, 'WebGL error');
    evidence.passed = evidence.errors.length === 0;
}
try { await run(); } catch (error) { evidence.errors.push(error.stack || String(error)); evidence.passed = false; }
finally {
    evidence.done = true;
    document.querySelector('#result').textContent = JSON.stringify(evidence, null, 2);
}
