import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';

import * as THREE from 'three';

import { createCampaignPackMaterial } from '../core/campaign-pack-material.js';

import { captureCampaignPackScene } from '../core/campaign-pack-capture-three.js';
import { decodeCampaignPackChunk } from '../core/campaign-pack-binary.js';
import { decompressCampaignPackPayload } from '../core/campaign-pack-compression.js';
import { createCampaignPackSupportIndex } from '../core/campaign-pack-support.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { validateRenderPacket } from '../core/render-packet.js';
import { campaignPackRailFeatures } from '../core/campaign-pack.js';
import { markSurfaceClaim } from '../core/surface-claim.js';

function triangleGeometry(y = 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0, y, 0,
        10, y, 0,
        0, y, 10,
    ], 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    geometry.setIndex([0, 1, 2]);
    return geometry;
}

test('campaign capture emits only stable layers in one fixed anchor frame', async () => {
    const scene = new THREE.Scene();
    const terrainRoot = markInspectionLayer(new THREE.Group(), { id: 'terrain' });
    const terrain = new THREE.Mesh(
        triangleGeometry(3),
        new THREE.MeshStandardMaterial({ color: 0x668844 }),
    );
    terrain.material.map = new THREE.Texture({
        width: 2,
        height: 2,
        getContext() {},
        toBlob(callback, type) {
            callback(new Blob([new Uint8Array([9, 8, 7])], { type }));
        },
    });
    terrain.position.set(20, 0, -30);
    terrainRoot.add(terrain);
    scene.add(terrainRoot);

    const buildingRoot = markInspectionLayer(new THREE.Group(), { id: 'buildings' });
    const buildings = new THREE.InstancedMesh(
        triangleGeometry(8),
        new THREE.MeshLambertMaterial({ color: 0xbb9977 }),
        2,
    );
    buildings.setMatrixAt(0, new THREE.Matrix4().makeTranslation(25, 0, -25));
    buildings.setMatrixAt(1, new THREE.Matrix4().makeTranslation(35, 0, -25));
    buildingRoot.add(buildings);
    scene.add(buildingRoot);

    const dynamicRoot = markInspectionLayer(new THREE.Group(), { id: 'cars' });
    dynamicRoot.add(new THREE.Mesh(triangleGeometry(50), new THREE.MeshBasicMaterial()));
    scene.add(dynamicRoot);

    const railFeatures = [{
        type: 'Feature',
        properties: { referenceSourceId: 'fixture-rail', trackCount: 1 },
        geometry: { type: 'LineString', coordinates: [[15.9, 45.8, 113], [15.91, 45.8, 113]] },
    }];
    const captured = await captureCampaignPackScene({
        scene,
        packId: 'fixture-level',
        releaseId: 'fixture-release',
        sourceRevision: 'fixture-source',
        anchor: {
            lat: 45.8,
            lon: 15.9,
            sceneDatumAslM: 110,
            verticalDatum: 'EVRF2000',
        },
        packAnchorLocal: { x: 20, z: -30 },
        bounds: { west: 15.8, south: 45.7, east: 16, north: 45.9 },
        playArea: { type: 'Polygon', coordinates: [] },
        railFeatures,
        cryptoImpl: webcrypto,
    });
    assert.equal(captured.manifest.outputCounts.sourceMeshes, 2);
    const capturedRails = campaignPackRailFeatures(captured);
    assert.deepEqual(capturedRails, railFeatures);
    railFeatures[0].geometry.coordinates[0][2] = 120;
    assert.equal(capturedRails[0].geometry.coordinates[0][2], 113,
        'live source changes must not mutate the captured driving geometry');
    assert.equal(captured.manifest.outputCounts.triangles, 3);
    assert.ok(captured.chunks.length >= 2);
    const decoded = await Promise.all(captured.chunks.map(async entry => decodeCampaignPackChunk(
        await decompressCampaignPackPayload(entry.payload, { encoding: entry.encoding }),
    )));
    const encodedMaps = decoded.flatMap(chunk => Object.values(chunk.materials))
        .map(material => material.map)
        .filter(Boolean);
    assert.ok(encodedMaps.some(map => map.mimeType === 'image/webp'
        && map.encodedData instanceof Uint8Array));
    const packets = decoded.flatMap(chunk => chunk.packets);
    packets.forEach(packet => validateRenderPacket(packet));
    assert.equal(packets.flatMap(packet => packet.primitives).some(
        primitive => primitive.bounds.minY === 50,
    ), false);
    const support = createCampaignPackSupportIndex(packets);
    assert.equal(support.terrainYAt(2, 2), 3);
    assert.equal(support.supportYAt(7, 7, { maxY: 20 }), 8);
    assert.match(captured.manifest.chunks[0].sha256, /^[0-9a-f]{64}$/);
});

test('campaign capture canonicalizes an unclaimed rail layer for runtime publication', async () => {
    const scene = new THREE.Scene();
    const railRoot = markInspectionLayer(new THREE.Group(), { id: 'rail-formation' });
    railRoot.add(new THREE.Mesh(
        triangleGeometry(2),
        new THREE.MeshStandardMaterial({ color: 0x777777 }),
    ));
    scene.add(railRoot);

    const captured = await captureCampaignPackScene({
        scene,
        packId: 'rail-level',
        releaseId: 'rail-release',
        sourceRevision: 'fixture-source',
        anchor: {
            lat: 45.8,
            lon: 15.9,
            sceneDatumAslM: 110,
            verticalDatum: 'EVRF2000',
        },
        playArea: { type: 'Polygon', coordinates: [] },
        cryptoImpl: webcrypto,
    });
    const chunk = decodeCampaignPackChunk(await decompressCampaignPackPayload(
        captured.chunks[0].payload,
        { encoding: captured.chunks[0].encoding },
    ));
    assert.equal(
        chunk.packets[0].primitives[0].surfaceClaims[0].surfaceClass,
        'rail-trackbed',
    );
});

test('campaign capture preserves compiled support and colorless rail prepass claims', async () => {
    const scene = new THREE.Scene();
    const expectedClaims = [];
    for (const [index, input] of [
        { surfaceClass: 'terrain', supportReady: true },
        { surfaceClass: 'rail-trackbed', supportReady: true, cutsBackstop: true },
        { surfaceClass: 'rail-trackbed', paintsColor: false, cutsBackstop: true },
    ].entries()) {
        const root = markInspectionLayer(new THREE.Group(), {
            id: index === 0 ? 'terrain' : 'rail-trackbed',
        });
        const mesh = new THREE.Mesh(triangleGeometry(2), new THREE.MeshStandardMaterial());
        mesh.position.x = index * 20;
        mesh.name = `surface-${index}`;
        expectedClaims.push(markSurfaceClaim(mesh, {
            ...input,
            coverageState: 'published',
            verticalRelation: 'same-level',
            verticalBand: 'ground',
        }));
        root.add(mesh);
        scene.add(root);
    }
    const captured = await captureCampaignPackScene({
        scene,
        packId: 'claimed-level',
        releaseId: 'claimed-release',
        sourceRevision: 'fixture-source',
        anchor: { lat: 45.8, lon: 15.9, sceneDatumAslM: 110, verticalDatum: 'EVRF2000' },
        playArea: { type: 'Polygon', coordinates: [] },
        cryptoImpl: webcrypto,
    });
    const chunks = await Promise.all(captured.chunks.map(async chunk => decodeCampaignPackChunk(
        await decompressCampaignPackPayload(chunk.payload, { encoding: chunk.encoding }),
    )));
    const packets = chunks.flatMap(chunk => chunk.packets);
    const primitives = packets.flatMap(packet => packet.primitives);
    for (let index = 0; index < expectedClaims.length; index++) {
        const primitive = primitives.find(item => item.entityRanges.some(
            range => range.entityId === `surface-${index}`,
        ));
        assert.deepEqual(primitive.surfaceClaims[0], expectedClaims[index]);
    }
    const support = createCampaignPackSupportIndex(packets);
    assert.equal(support.terrainYAt(2, 2), 2);
    assert.equal(support.supportYAt(22, 2, { surfaceClasses: ['rail-trackbed'] }), 2);
    assert.equal(support.supportYAt(42, 2, { surfaceClasses: ['rail-trackbed'] }), null,
        'a stencil prepass must not become a visible or supporting surface');
});

test('a vertex-alpha darkening overlay is baked as multiply blending, not an opaque black band', async () => {
    const scene = new THREE.Scene();
    const buildingRoot = markInspectionLayer(new THREE.Group(), { id: 'buildings' });
    // The contact-AO skirt: black RGBA vertex colours fading from the wall seam.
    const skirt = new THREE.BufferGeometry();
    skirt.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 1.1, 0], 3));
    skirt.setAttribute('color', new THREE.BufferAttribute(new Float32Array([
        0, 0, 0, 0.32,
        0, 0, 0, 0.32,
        0, 0, 0, 0,
    ]), 4));
    skirt.setIndex([0, 1, 2]);
    const ao = new THREE.Mesh(skirt, new THREE.MeshBasicMaterial({
        color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false,
    }));
    ao.name = 'BuildingContactAO';
    ao.renderOrder = 5;
    buildingRoot.add(ao);
    // An ordinary RGB-coloured wall in the same layer keeps normal blending.
    const wall = new THREE.Mesh(triangleGeometry(2), new THREE.MeshLambertMaterial({ vertexColors: true }));
    wall.geometry.setAttribute('color', new THREE.Float32BufferAttribute([0.5, 0.4, 0.3, 0.5, 0.4, 0.3, 0.5, 0.4, 0.3], 3));
    buildingRoot.add(wall);
    scene.add(buildingRoot);

    const captured = await captureCampaignPackScene({
        scene,
        packId: 'fixture-ao',
        releaseId: 'fixture-ao-release',
        sourceRevision: 'fixture-source',
        anchor: { lat: 45.8, lon: 15.9, sceneDatumAslM: 110, verticalDatum: 'EVRF2000' },
        packAnchorLocal: { x: 0, z: 0 },
        bounds: { west: 15.8, south: 45.7, east: 16, north: 45.9 },
        playArea: { type: 'Polygon', coordinates: [] },
        railFeatures: [],
        cryptoImpl: webcrypto,
    });
    const decoded = await Promise.all(captured.chunks.map(async entry => decodeCampaignPackChunk(
        await decompressCampaignPackPayload(entry.payload, { encoding: entry.encoding }),
    )));
    const materials = Object.assign({}, ...decoded.map(chunk => chunk.materials));
    const primitives = decoded.flatMap(chunk => chunk.packets).flatMap(packet => packet.primitives);
    const overlay = primitives.find(primitive => primitive.renderOrder === 5);
    assert.ok(overlay, 'the skirt is captured');
    assert.equal(materials[overlay.materialKey].blending, 'multiply');
    assert.equal(materials[overlay.materialKey].vertexColors, true);
    assert.equal(materials[overlay.materialKey].transparent, true);
    assert.equal(materials[overlay.materialKey].depthWrite, false);
    // Black at alpha 0.32 becomes a 0.68 darkening factor; alpha 0 leaves the surface untouched.
    const colors = Array.from(overlay.colors);
    assert.equal(colors.length, 9);
    for (const value of colors.slice(0, 6)) assert.ok(Math.abs(value - 0.68) < 1e-6, `seam colour ${value}`);
    for (const value of colors.slice(6, 9)) assert.ok(Math.abs(value - 1) < 1e-6, `faded colour ${value}`);
    // What the capture wrote must also draw: three binds a multiply blend only for
    // a premultiplied material, and otherwise paints the skirt opaque.
    const loaded = createCampaignPackMaterial(materials[overlay.materialKey], overlay.materialKey, null);
    assert.equal(loaded.blending, THREE.MultiplyBlending);
    assert.equal(loaded.premultipliedAlpha, true, 'a multiply material must be premultiplied');
    const plain = primitives.find(primitive => primitive !== overlay);
    assert.equal(materials[plain.materialKey].blending, 'normal');
    assert.ok(Math.abs(Array.from(plain.colors)[0] - 0.5) < 1e-6, 'RGB colours pass through unchanged');
});
