import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { parseMeshDocument } from '../viewers/model-mesh-document.js';
import { createModelImporter } from '../viewers/model-import.js';
import { studyCatalog } from '../viewers/model-studies.js';
import { disposePreview, inspectModel, modelBounds } from '../viewers/model-viewer-core.js';

// Resolved from this file, not the cwd: npm test runs from website/station-3d.
const modelRoot = fileURLToPath(new URL('../models', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(modelRoot, 'viewer-studies.json')));
const jsonAssets = manifest.filter(asset => asset.format === 'json');
const baseURL = new URL('../../', import.meta.url);
// Manifest paths are repo-root relative (website/…); resolve them from here too.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fromRepo = relative => path.join(repoRoot, relative);

async function localImporter() {
    const importer = await createModelImporter(null);
    return {
        ...importer,
        url: async (url, { format }) => {
            const bytes = fs.readFileSync(new URL(url));
            return importer.parse(format === 'glb' ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes.toString(), format);
        },
    };
}

test('all recovered mesh documents retain geometry, material records and Z-up dimensions through the common importer', async () => {
    const importer = await localImporter();
    try {
        assert.ok(jsonAssets.length > 0);
        for (const asset of jsonAssets) {
            const doc = JSON.parse(fs.readFileSync(fromRepo(asset.model)));
            const preview = await importer.parse(JSON.stringify(doc), 'json');
            try {
                const stats = inspectModel(preview.object);
                const sourceBounds = new THREE.Box3();
                let triangles = 0;
                for (const group of doc.groups) {
                    triangles += group.indices.length / 3;
                    for (let i = 0; i < group.positions.length; i += 3) sourceBounds.expandByPoint(new THREE.Vector3(...group.positions.slice(i, i + 3)));
                    const material = preview.object.getObjectByName(group.material).material;
                    const record = doc.materials[group.material];
                    assert.deepEqual(material.color.toArray(), record.color, asset.id);
                    assert.equal(material.opacity, record.alpha, asset.id);
                    assert.equal(material.transparent, record.alpha < 1, asset.id);
                    assert.equal(material.depthWrite, record.alpha >= 1, asset.id);
                    assert.equal(material.emissiveIntensity, record.emissiveStrength, asset.id);
                }
                const sourceSize = sourceBounds.getSize(new THREE.Vector3());
                const expected = [sourceSize.x, sourceSize.z, sourceSize.y];
                stats.dimensions.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-4, asset.id));
                assert.equal(stats.triangles, triangles, asset.id);
            } finally { disposePreview(preview); }
        }
    } finally { importer.dispose(); }
});

test('mesh documents reject incomplete and non-finite triangle data', () => {
    const document = { materials: { paint: { color: [1, 0, 0] } }, groups: [{ material: 'paint', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }] };
    for (const update of [{ positions: [0, 1] }, { positions: [NaN, 0, 0] }, { indices: [0, 1] }, { indices: [0, 1, 4] }, { material: 'missing' }]) {
        const bad = structuredClone(document);
        Object.assign(bad.groups[0], update);
        assert.throws(() => parseMeshDocument(bad), /Invalid geometry|Missing material/);
    }
});

test('every model, source and reference is a durable canonical asset', () => {
    const ids = new Set();
    for (const asset of manifest) {
        assert.ok(!ids.has(asset.id), asset.id); ids.add(asset.id);
        for (const value of [asset.model, asset.source, ...(asset.referenceImages || []).map(reference => reference.path)].filter(Boolean)) {
            assert.ok(value.startsWith('website/station-3d/models/'), value);
            assert.ok(fs.statSync(fromRepo(value)).isFile(), value);
            assert.ok(fs.realpathSync(fromRepo(value)).startsWith(modelRoot + path.sep), value);
        }
    }
});

test('recovered GLB vehicles load real meshes and omit the airplane review ground', async () => {
    const importer = await localImporter();
    try {
        const entries = studyCatalog(manifest, importer, baseURL);
        for (const asset of manifest.filter(asset => asset.format === 'glb' && asset.category === 'vehicles')) {
            const preview = await entries.find(entry => entry.id === asset.id).create();
            try {
                const stats = inspectModel(preview.object);
                assert.ok(stats.triangles > 100 && stats.dimensions.every(value => value > .1 && value < 100), asset.id);
                if (asset.id === 'study-utva') {
                    assert.equal(preview.object.getObjectByName('Ground'), undefined);
                    assert.ok(stats.dimensions[0] < 20, 'airplane framing must exclude the studio ground');
                    assert.deepEqual(preview.controls.map(control => [control.id, control.value]), [['pilot', true], ['cargo', true]]);
                    const pilot = preview.object.getObjectByName('Pilot'), cargo = preview.object.getObjectByName('Cargo');
                    preview.seek(0, { pilot: false, cargo: true });
                    assert.equal(pilot.visible, false); assert.equal(cargo.visible, true);
                    preview.update(0, 0, { pilot: true, cargo: false });
                    assert.equal(pilot.visible, true); assert.equal(cargo.visible, false);
                    preview.seek(0, { pilot: true, cargo: true });
                    assert.equal(pilot.visible, true); assert.equal(cargo.visible, true);
                    assert.ok(preview.cameraViews.cockpit && preview.cameraViews.inside && preview.cameraViews['cabin-side']);
                }
            } finally { disposePreview(preview); }
        }
    } finally { importer.dispose(); }
});

test('fleet line-up preserves scale, separates bounds and restores daytime emission', async () => {
    const importer = await localImporter();
    try {
        const entries = studyCatalog(manifest, importer, baseURL);
        const preview = await entries.find(entry => entry.id === 'study-fleet-lineup').create();
        try {
            assert.equal(preview.object.children.length, manifest.filter(asset => asset.fleet === 'current').length);
            let previousMax = -Infinity;
            const resources = new Set();
            for (const holder of preview.object.children) {
                const bounds = modelBounds(holder);
                assert.ok(bounds.min.x >= previousMax + 3.99);
                assert.ok(Math.abs(bounds.min.y) < 1e-5);
                assert.deepEqual(holder.scale.toArray(), [1, 1, 1]);
                previousMax = bounds.max.x;
                holder.traverse(part => { if (part.geometry) { assert.ok(!resources.has(part.geometry)); resources.add(part.geometry); } });
            }
            const lamp = preview.object.getObjectByName('Lamp').material;
            const dayIntensity = lamp.emissiveIntensity;
            preview.setLighting(true); assert.equal(lamp.emissiveIntensity, dayIntensity * 2.2);
            preview.setLighting(false); assert.equal(lamp.emissiveIntensity, dayIntensity);
        } finally { disposePreview(preview); }
    } finally { importer.dispose(); }
});
