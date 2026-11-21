// Same-input real tile parity, with runtime terrain seating, tint and detail ownership.
import * as THREE from 'three';
import { compileFarBuildingRenderPacket } from '../../core/compilers/far-building-render-packet.js';
import { bakedFarEntityPlacement, compileFarBuildingBake } from '../../core/compilers/far-building-bake.js';
import { createFarBuildingPacketUploadTask } from '../../core/far-building-packet-three.js';
import { applyWorldTilePlacement } from '../../core/world-tile-three.js';
import { worldTileBounds, worldTilePlacement } from '../../core/world-tile-placement.js';
import { geoToLocal } from '../../core/math.js';
import { outerRings, pickFarHeightForFeature } from '../../world/lod1-geometry.js';
import { farBuildingColorForUseClass } from '../../core/building-use-colors.js';
import { belongsInBuildingLayer } from '../../core/building-pipeline.js';
import { applyFarBuildingTint } from '../../world/far-building-color.js';
import { TerrainGrid, TerrainReference } from '../../core/terrain-grid.js';
import { isDetailed, isDetailedTile, onDetailedChange, setDetailed, resetDetailed } from '../../world/building-lod-registry.js';
import { setSceneRenderOrigin, applyRenderOriginForRender, resetSceneRenderOrigin } from '../../core/render-origin.js';
import { farBuildingSourceIdentity } from '../../core/far-building-source.js';
import { createFarBuildingLodIndex } from '../../core/far-building-lod-index.js';

const report = window.auditResult = { done: false, cases: [], errors: [] };
addEventListener('error', e => report.errors.push(e.message));
addEventListener('unhandledrejection', e => report.errors.push(String(e.reason)));
const previousError = console.error.bind(console);
console.error = (...args) => { report.errors.push(args.map(String).join(' ')); previousError(...args); };
const assert = (value, message) => { if (!value) throw new Error(message); };
const stableJson = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const material = new THREE.MeshLambertMaterial();
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(600, 460);
const left = document.createElement('canvas'); left.width = 600; left.height = 460;
document.querySelector('#views').append(left, renderer.domElement);
const gl = renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
report.renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
const prefix = '/baking-pilot/';
const tileFile = 'far-15-17837-11682-clean-live-v3.bin';
async function fetchFile(name, json = false) {
    const response = await fetch(prefix + name, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Fixture input ${name}: HTTP ${response.status}`);
    return json ? response.json() : response.arrayBuffer();
}
async function decode(bytes, expected) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./baked-world-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => { worker.terminate(); data.error ? reject(new Error(data.error.message)) : resolve(data.tile); };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); };
        worker.postMessage({ bytes, expected }, [bytes]);
    });
}
function terrainFor(baked, anchor) {
    const bounds = worldTileBounds(baked.tile);
    const metadata = { grid: { width: 3, height: 3,
        bounds: { west: bounds.west - 0.03, east: bounds.east + 0.03, south: bounds.south - 0.03, north: bounds.north + 0.03 } },
        encoding: { scaleM: 0.1, offsetM: 100, noDataValue: 65535 } };
    const grid = new TerrainGrid(metadata, new Uint16Array([0, 10, 20, 20, 30, 40, 40, 50, 60]).buffer);
    return new TerrainReference(grid, anchor.lon, anchor.lat, { surfaceStepM: 20 });
}
function makeScene(root) {
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#243446');
    scene.add(root, new THREE.AmbientLight(0xffffff, 2.4));
    return scene;
}
async function upload(packet, entities, placements, baked) {
    const task = createFarBuildingPacketUploadTask(packet, {
        material, replacementKey: baked ? 'offline' : 'direct', chunkSize: 32,
        colorForEntity: identity => applyFarBuildingTint(new THREE.Color(), identity.metadata.color, identity.objectId),
        configureBatch: (batch, refs) => {
            if (!baked) return;
            for (const ref of refs) {
                const entity = entities.get(ref.objectId), placement = placements.get(ref.objectId);
                assert(entity && placement, 'Missing runtime entity or terrain evidence');
                const matrix = new THREE.Matrix4().makeScale(1, placement.scaleY, 1);
                matrix.setPosition(0, placement.baseY, 0);
                batch.setMatrixAt(ref.instanceId, matrix);
            }
        },
    });
    while (!task.done) {
        const start = performance.now();
        let count = 0;
        do { task.step(1); count++; } while (!task.done && count < 24 && performance.now() - start < 4);
        if (!task.done) await nextFrame();
    }
    return task.result();
}
function render(scene, center, orbit, rebase) {
    const camera = new THREE.PerspectiveCamera(47, 600 / 460, 0.1, 4000);
    camera.position.set(center.x + 1050 * Math.cos(orbit), 850, center.z + 1050 * Math.sin(orbit));
    camera.lookAt(center.x, 10, center.z);
    setSceneRenderOrigin(scene, rebase); applyRenderOriginForRender(scene, camera);
    renderer.render(scene, camera);
    const result = new Uint8Array(600 * 460 * 4);
    gl.readPixels(0, 0, 600, 460, gl.RGBA, gl.UNSIGNED_BYTE, result);
    resetSceneRenderOrigin(scene);
    scene.userData.auditCamera = camera;
    return result;
}
function refs(root) { return root.children.flatMap(batch => batch.userData.lodRefs); }
function ids(root) { return refs(root).map(ref => ref.objectId).sort(); }
function nearbyPixelMatches(image, reference, offset) {
    const x = (offset / 4) % 600, y = Math.floor(offset / 4 / 600);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || x + dx >= 600 || y + dy < 0 || y + dy >= 460) continue;
        const other = ((y + dy) * 600 + x + dx) * 4;
        if ([0, 1, 2].every(c => Math.abs(image[other+c] - reference[offset+c]) <= 1)) return true;
    }
    return false;
}
function comparePixels(a, b) {
    let changed = 0, interior = 0, maxChannelDelta = 0;
    for (let p = 0; p < a.length; p += 4) {
        const delta = Math.max(...[0, 1, 2].map(c => Math.abs(a[p+c] - b[p+c])));
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        if (delta > 1) {
            changed++;
            if (!nearbyPixelMatches(a, b, p) || !nearbyPixelMatches(b, a, p)) interior++;
        }
    }
    return { changed, interior, maxChannelDelta };
}
function pixelHits(scene, offset) {
    scene.updateMatrixWorld(true);
    const camera = scene.userData.auditCamera; camera.updateMatrixWorld(true);
    const x = (offset / 4) % 600, y = Math.floor(offset / 4 / 600);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x + 0.5) / 600 * 2 - 1, (y + 0.5) / 460 * 2 - 1), camera);
    return ray.intersectObject(scene, true).slice(0, 4).map(hit => ({
        id: hit.object.userData.objectIdsByBatchId?.[hit.batchId], distance: hit.distance,
    }));
}
function identityPixels(scene, center, orbit, rebase, numbers) {
    const flat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const backups = [], outputSpace = renderer.outputColorSpace;
    scene.traverse(batch => {
        if (!batch.isBatchedMesh) return;
        const colors = batch.userData.lodRefs.map(ref => {
            const color = batch.getColorAt(ref.instanceId, new THREE.Color());
            const id = numbers.get(ref.objectId);
            batch.setColorAt(ref.instanceId, new THREE.Color().setRGB((id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255));
            return { ref, color };
        });
        backups.push({ batch, material: batch.material, colors }); batch.material = flat;
    });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    try { return render(scene, center, orbit, rebase); }
    finally {
        renderer.outputColorSpace = outputSpace;
        for (const backup of backups) {
            backup.batch.material = backup.material;
            for (const { ref, color } of backup.colors) backup.batch.setColorAt(ref.instanceId, color);
        }
        flat.dispose();
    }
}
function bindDetail(roots) {
    // One production index, with two copies of each ID just like coarse tile
    // borders. Separate per-root maps would miss the actual live regression.
    const index = createFarBuildingLodIndex({ isDetailed, isDetailedTile });
    for (const root of roots) for (const ref of refs(root)) index.register(ref);
    const unsubscribe = onDetailedChange(objectId => index.syncObject(objectId));
    return {
        retire(root) { for (const ref of refs(root)) index.unregister(ref); },
        dispose() { unsubscribe(); index.clear(); },
    };
}
async function run() {
    assert(!/SwiftShader|llvmpipe/i.test(report.renderer), 'Headed real GPU required');
    const [snapshot, descriptor, bytes] = await Promise.all([
        fetchFile('source-render-clean-live-v3.json', true), fetchFile(tileFile + '.json', true), fetchFile(tileFile),
    ]);
    assert(snapshot.sourceRevision === descriptor.sourceRevision, 'Source and bake do not match');
    const baked = await decode(bytes, { ...descriptor, checksum: descriptor.sha256 });
    // A fresh browser compile in the offline frame isolates serialization from
    // legacy anchor-dependent Float32 rounding. This reference is not a second
    // decode of the same bytes and cannot hide a compiler/codec disagreement.
    const freshBake = compileFarBuildingBake(snapshot, { tile: baked.tile, revision: baked.revision });
    for (let index = 0; index < freshBake.packet.primitives.length; index++) {
        const a = freshBake.packet.primitives[index], b = baked.packet.primitives[index];
        for (const key of ['positions', 'normals', 'indices', 'uvs']) {
            const mismatch = a[key].findIndex((v, i) => v !== b[key][i]);
            assert(a[key].length === b[key].length && mismatch === -1,
                `Offline ${key} mismatch: primitive ${index}, component ${mismatch}, browser ${a[key][mismatch]}, bake ${b[key][mismatch]}`);
        }
        assert(stableJson(a.entityRanges) === stableJson(b.entityRanges), 'Offline material/identity mismatch');
    }
    report.sourceRevision = snapshot.sourceRevision; report.sha256 = descriptor.sha256;
    report.entities = baked.entities.length; report.prisms = baked.packet.primitives.length;
    report.landmarks = baked.entities.filter(e => e.feature.properties.footprint_source === 'landmark').map(e => ({ id: e.objectId, parent: e.parentId }));
    const bounds = worldTileBounds(baked.tile);
    for (const [label, anchor, rebase] of [
        ['live / baked and terrain seating', { lon: 15.9706, lat: 45.8104 }, { x: 0, z: 0 }],
        ['changed anchor and floating origin', { lon: 16.05, lat: 46.15 }, { x: -6200, z: 37000 }],
    ]) {
        const terrain = terrainFor(baked, anchor);
        const entities = new Map(baked.entities.map(e => [e.objectId, e]));
        assert(entities.size === baked.entities.length, 'Source object IDs collide across namespaces; authority migration must stop');
        const placements = new Map();
        const directFeatures = baked.entities.map(e => e.feature).filter(f => belongsInBuildingLayer(f.properties)).map(feature => {
            const objectId = feature.properties.object_id;
            const baseY = terrain.evidenceFoundationSceneY(outerRings(feature.geometry)[0]);
            const placement = bakedFarEntityPlacement(entities.get(objectId), { anchorLat: anchor.lat, baseY });
            assert(placement, `Missing foundation ${objectId}`); placements.set(objectId, placement);
            return { entityId: farBuildingSourceIdentity(feature.properties).entityId, objectId, geometry: feature.geometry, baseY,
                heightM: pickFarHeightForFeature(feature.properties, feature.geometry, anchor.lat), color: farBuildingColorForUseClass(feature.properties.use_class) };
        });
        const origin = geoToLocal(baked.tile.originLon, baked.tile.originLat, anchor.lon, anchor.lat);
        const directPacket = compileFarBuildingRenderPacket({ tile: baked.tile, generation: 0, sourceRevision: baked.sourceRevision,
            inputs: { anchorLon: anchor.lon, anchorLat: anchor.lat, tileOriginX: origin.x, tileOriginZ: origin.z, features: directFeatures } });
        const transform = worldTilePlacement(baked.tile, { anchor });
        let maxVertexDeltaM = 0, differentIndexEntities = 0;
        for (let index = 0; index < directPacket.primitives.length; index++) {
            const a = directPacket.primitives[index], b = baked.packet.primitives[index];
            assert(a.entityRanges[0].entityId === b.entityRanges[0].entityId, 'Primitive ordering changed');
            assert(stableJson(a.entityRanges) === stableJson(b.entityRanges), 'Live/baked identity or tint metadata changed');
            assert(a.positions.length === b.positions.length, 'Vertex count changed');
            assert(a.indices.length === b.indices.length, 'Index count changed');
            if (a.indices.some((v, i) => v !== b.indices[i])) differentIndexEntities++;
            const placement = placements.get(a.entityRanges[0].metadata.objectId);
            for (let i = 0; i < a.positions.length; i += 3) {
                maxVertexDeltaM = Math.max(maxVertexDeltaM,
                    Math.abs(a.positions[i] - b.positions[i] * transform.scale.x),
                    Math.abs(a.positions[i+1] - (b.positions[i+1] * placement.scaleY + placement.baseY)),
                    Math.abs(a.positions[i+2] - b.positions[i+2]));
            }
        }
        report.geometry = { label, maxVertexDeltaM, differentIndexEntities };
        const direct = await upload(directPacket, entities, placements, false);
        direct.position.set(origin.x, 0, origin.z); direct.updateMatrix();
        const offline = applyWorldTilePlacement(await upload(baked.packet, entities, placements, true), baked.tile, { anchor });
        assert(JSON.stringify(ids(direct)) === JSON.stringify(ids(offline)), 'Visible identity mismatch');
        const scenes = [makeScene(direct), makeScene(offline)];
        const fresh = applyWorldTilePlacement(await upload(freshBake.packet, entities, placements, true), baked.tile, { anchor });
        const freshScene = makeScene(fresh);
        // Anchor-invariance control: translate the live compiler's longitude
        // before localization, then keep the geography and camera identical.
        // This used to reveal rounding before tile localization; it should now
        // be stable. It does not define a tolerance for the baked projection.
        const controlAnchor = { ...anchor, lon: anchor.lon + 0.1 };
        const controlOrigin = geoToLocal(baked.tile.originLon, baked.tile.originLat, controlAnchor.lon, controlAnchor.lat);
        const controlPacket = compileFarBuildingRenderPacket({ tile: baked.tile, generation: 0, sourceRevision: baked.sourceRevision,
            inputs: { anchorLon: controlAnchor.lon, anchorLat: controlAnchor.lat,
                tileOriginX: controlOrigin.x, tileOriginZ: controlOrigin.z, features: directFeatures } });
        const control = await upload(controlPacket, entities, placements, false);
        control.position.copy(direct.position); control.updateMatrix();
        const controlScene = makeScene(control);
        const center = geoToLocal((bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2, anchor.lon, anchor.lat);
        const detail = bindDetail([direct, offline]);
        let differingPixels = 0, interiorDifferences = 0;
        report.interiorSamples = [];
        report.identityPass = [];
        report.precisionControls = [];
        for (const orbit of [0.7, 1.7]) {
            await nextFrame();
            const a = render(scenes[0], center, orbit, rebase);
            left.getContext('2d').drawImage(renderer.domElement, 0, 0);
            const b = render(scenes[1], center, orbit, rebase);
            const freshPixels = render(freshScene, center, orbit, rebase);
            const freshComparison = comparePixels(b, freshPixels);
            assert(freshComparison.maxChannelDelta === 0, 'Fresh same-frame compile and decoded bake differ on GPU');
            const controlPixels = render(controlScene, center, orbit, rebase);
            report.precisionControls.push({ orbit, freshComparison, liveAnchorComparison: comparePixels(a, controlPixels) });
            render(scenes[1], center, orbit, rebase);
            let nonBackground = 0;
            const interiorOffsets = [];
            for (let p = 0; p < a.length; p += 4) {
                if (a[p] !== a[0] || a[p+1] !== a[1] || a[p+2] !== a[2]) nonBackground++;
                if ([0, 1, 2].some(c => Math.abs(a[p+c] - b[p+c]) > 1)) {
                    differingPixels++;
                    if (!nearbyPixelMatches(a, b, p) || !nearbyPixelMatches(b, a, p)) {
                        interiorDifferences++;
                        interiorOffsets.push(p);
                        if (report.interiorSamples.length < 6) report.interiorSamples.push({
                            x: (p / 4) % 600, y: Math.floor(p / 4 / 600), orbit,
                            directColor: [...a.slice(p, p+3)], bakedColor: [...b.slice(p, p+3)],
                            directHits: pixelHits(scenes[0], p), bakedHits: pixelHits(scenes[1], p),
                        });
                    }
                }
            }
            assert(nonBackground > 1000, 'Empty/hidden scene cannot pass visual parity');
            if (new URLSearchParams(location.search).has('inspect') && interiorOffsets.length) {
                const objectIds = ids(direct), numbers = new Map(objectIds.map((id, index) => [id, index + 1]));
                const aIds = identityPixels(scenes[0], center, orbit, rebase, numbers);
                const bIds = identityPixels(scenes[1], center, orbit, rebase, numbers);
                const pairs = {};
                for (const p of interiorOffsets) {
                    const aId = aIds[p] + (aIds[p+1] << 8) + (aIds[p+2] << 16);
                    const bId = bIds[p] + (bIds[p+1] << 8) + (bIds[p+2] << 16);
                    const pair = `${objectIds[aId-1]} -> ${objectIds[bId-1]}`;
                    pairs[pair] = (pairs[pair] || 0) + 1;
                }
                report.identityPass.push({ orbit, pairs });
                render(scenes[1], center, orbit, rebase);
            }
        }
        report.pixelComparison = { label, differingPixels, interiorDifferences };
        // Gate serialization/rendering with exact same-frame GPU equality,
        // topology and every entity's world geometry/materials, not a pixel
        // quota. Different Float32 frames can resolve existing coplanar faces
        // to different tints even when every vertex agrees within 0.1 mm.
        // Keep the full-scene raster differences visible in the report for
        // human inspection; do not present them as a pixel-exact live match.
        assert(differentIndexEntities === 0, 'Baked topology differs');
        assert(maxVertexDeltaM < 0.0001, `World-coordinate drift exceeds tile Float32 precision: ${maxVertexDeltaM} m`);
        const testIds = baked.entities.filter(e => e.parentId === 'landmark:hnk' && e.drawable).map(e => e.objectId);
        assert(testIds.length === 5, 'Whole HNK material-part membership is incomplete');
        for (const value of [true, false]) {
            for (const testId of testIds) setDetailed(testId, value);
            for (const testId of testIds) for (const root of [direct, offline]) {
                const ref = refs(root).find(entry => entry.objectId === testId);
                assert(ref && ref.batch.getVisibleAt(ref.instanceId) === !value, 'Detail handoff visibility mismatch');
            }
        }
        detail.retire(direct);
        for (const testId of testIds) setDetailed(testId, true);
        for (const testId of testIds) {
            const retired = refs(direct).find(ref => ref.objectId === testId);
            const remaining = refs(offline).find(ref => ref.objectId === testId);
            assert(retired.batch.getVisibleAt(retired.instanceId), 'Retired copy retained an ownership listener');
            assert(!remaining.batch.getVisibleAt(remaining.instanceId), 'Retiring one copy lost its neighbor');
        }
        for (const testId of testIds) setDetailed(testId, false);
        const first = baked.entities.find(e => e.drawable);
        assert(bakedFarEntityPlacement(first, { anchorLat: anchor.lat, baseY: null }) === null, 'Missing terrain must gate publication');
        report.cases.push({ label, differingPixels, interiorDifferences, maxVertexDeltaM, differentIndexEntities,
            exactGpuRoundTrip: true, precisionControls: report.precisionControls,
            identityCount: ids(offline).length, detailHideRestore: true, duplicateRetirement: true,
            missingTerrainGated: true, passed: true });
        detail.dispose(); resetDetailed();
        for (const root of [direct, offline, fresh, control]) { for (const batch of root.children) batch.dispose(); root.clear(); }
    }
    report.glError = gl.getError(); assert(report.glError === 0, 'WebGL error');
    report.passed = report.errors.length === 0;
}
try { await run(); } catch (error) { report.errors.push(error.stack || String(error)); report.passed = false; }
finally { report.done = true; document.querySelector('#result').textContent = JSON.stringify(report, null, 2); }
