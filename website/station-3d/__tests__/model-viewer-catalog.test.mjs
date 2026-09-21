import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { controlDefaults, disposePreview, inspectModel } from '../viewers/model-viewer-core.js';
import { ROAD_TRAFFIC_VEHICLE_TYPES } from '../models/vehicles/traffic-vehicle-catalog.js';

const gradient = () => ({ addColorStop() {} });
const canvas = () => ({ getContext: () => new Proxy({ canvas: { width: 1, height: 1 }, createLinearGradient: gradient, createRadialGradient: gradient, measureText: () => ({ width: 1 }) }, { get(target, key) { if (key in target) return target[key]; return () => {}; } }) });
globalThis.document = { createElement: canvas, createElementNS: () => ({ set src(_) {}, addEventListener(_, fn) { fn(); }, removeEventListener() {} }) };
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async input => String(input).startsWith('file:') ? new Response(await readFile(new URL(input))) : fetchOriginal(input);
const { MODEL_CATALOG, modelCatalogEntry } = await import('../viewers/model-catalog.js');

test('catalog includes every traffic type, crowd mode and reusable prop family', () => {
    assert.equal(new Set(MODEL_CATALOG.map(item => item.id)).size, MODEL_CATALOG.length);
    for (const type of ROAD_TRAFFIC_VEHICLE_TYPES) assert.ok(modelCatalogEntry('road-' + type.name));
    for (const id of ['tmk-2400-fleet', 'tmk-2400-old', 'tmk-2400-new', 'hz-7022', 'airplane-smuggler', 'airplane-before', 'crowd-faces', 'crowd-walking', 'crowd-waiting', 'bench', 'street-lamp', 'stop-shelter', 'manhole', 'machine-gun', 'machine-gun-nest', 'sealed-package', 'market-stall']) assert.ok(modelCatalogEntry(id), id);
    for (const item of MODEL_CATALOG) assert.ok(!item.source.includes('/structures/'));
    assert.equal(modelCatalogEntry('unknown'), null);
});

test('every catalog entry constructs visible finite geometry and synchronously accepts all its controls', async () => {
    for (const item of MODEL_CATALOG) {
        const preview = await item.create({ seed: 'repeatable', columns: 6 });
        const state = controlDefaults(preview.controls);
        preview.seek(0, state);
        let info;
        try { info = inspectModel(preview.object); }
        catch (error) { throw new Error(item.id, { cause: error }); }
        assert.ok(info.triangles > 0, item.id);
        assert.ok(info.dimensions.every(Number.isFinite), item.id);
        for (const camera of Object.values(preview.cameraViews)) {
            assert.ok([...camera.position, ...camera.target].every(Number.isFinite), item.id);
        }
        for (const control of preview.controls) {
            const next = { ...state, [control.id]: control.type === 'checkbox' ? true : control.type === 'range' ? control.max : control.options.at(-1).value };
            assert.equal(preview.seek(.7, next)?.then, undefined, item.id + ': seek must finish before rendering');
            assert.equal(preview.update(.8, .1, next)?.then, undefined, item.id + ': update must be synchronous');
            assert.ok(inspectModel(preview.object).dimensions.every(Number.isFinite), item.id);
        }
        disposePreview(preview);
    }
});

test('tram controls move doors, restore their transforms, and change visible LOD', async () => {
    const tram = await modelCatalogEntry('tmk-2400-old').create();
    const meshes = [];
    tram.object.traverse(part => { if (part.isInstancedMesh) meshes.push(part); });
    const before = meshes.map(mesh => [...mesh.instanceMatrix.array]);
    tram.seek(0, { doors: 1, lod: 'near' });
    assert.ok(meshes.some((mesh, index) => mesh.instanceMatrix.array.some((value, i) => value !== before[index][i])));
    tram.seek(0, { doors: 0, lod: 'far' });
    assert.equal(tram.object.userData.farMesh.visible, true);
    tram.seek(0, { doors: 0, lod: 'near' });
    meshes.forEach((mesh, i) => assert.deepEqual([...mesh.instanceMatrix.array], before[i]));
    disposePreview(tram);
});

test('train and package controls change their exposed parts', async () => {
    const train = await modelCatalogEntry('hz-7022').create();
    const car = train.object.userData.cars[0];
    const door = car.userData.doorParts[0];
    train.seek(0, { doors: 1, bend: .2 });
    assert.ok(Math.abs(door.mesh.position.z - door.closedZ) > .7);
    assert.notEqual(car.rotation.y, 0);
    const parcel = await modelCatalogEntry('sealed-package').create();
    parcel.seek(0, { open: 1, key: true });
    assert.equal(parcel.object.userData.sealedPackage.contents.visible, true);
    assert.equal(parcel.object.userData.sealedPackage.twine.visible, false);
    assert.equal(parcel.object.userData.sealedPackage.key.visible, true);
    disposePreview(train); disposePreview(parcel);
});

test('airplane has a pilot and real cabin; its controls support repeatable before/after inspection', async () => {
    const airplane = await modelCatalogEntry('airplane-smuggler').create();
    assert.ok(airplane.object.getObjectByName('GtaAirplaneCabinFloor'));
    const pilot = airplane.object.getObjectByName('ViewerAirplanePilot');
    assert.equal(pilot.parent.name, 'GtaAirplanePilotSeat');
    const wing = airplane.object.getObjectByName('GtaAirplaneRoundedMainWing');
    const before = wing.position.clone();
    airplane.seek(2, { pilot: false, breakup: 1, propellers: true });
    const propeller = airplane.object.getObjectByName('GtaAirplanePropeller');
    const rotation = propeller.rotation.clone();
    assert.equal(pilot.visible, false);
    assert.notDeepEqual(wing.position, before);
    airplane.seek(2, { pilot: false, breakup: 1, propellers: true });
    assert.deepEqual(propeller.rotation.toArray(), rotation.toArray());
    airplane.seek(0, { pilot: true, breakup: 0, propellers: false });
    assert.deepEqual(wing.position, before);
    assert.equal(pilot.visible, true);
    disposePreview(airplane);
});
