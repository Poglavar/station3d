import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAircraftMesh, preloadAircraftModels, disposeAircraftModelCache } from '../models/vehicles/aircraft-models.js';
import { disposeGroup } from '../core/dispose.js';

const bytes = fs.readFileSync(new URL('../models/vehicles/utva-liaison.glb', import.meta.url));

test('shared aircraft preparation loads once and publishes independent animated UTVA instances', async () => {
    const originalFetch = globalThis.fetch, originalProgressEvent = globalThis.ProgressEvent;
    let loads = 0;
    globalThis.fetch = async request => {
        loads += 1;
        assert.match(request.url, /models\/vehicles\/utva-liaison\.glb$/);
        return new Response(bytes, { status: 200, headers: { 'Content-Length': String(bytes.length) } });
    };
    globalThis.ProgressEvent ??= class extends Event { constructor(type, data) { super(type); Object.assign(this, data); } };
    try {
        const spec = { model: 'utva', interior: 'smuggler' };
        assert.throws(() => createAircraftMesh(spec), /preloaded/);
        await Promise.all([preloadAircraftModels([spec]), preloadAircraftModels([spec])]);
        assert.equal(loads, 1, 'flight and cinematic layers share the same request');
        const first = createAircraftMesh(spec), second = createAircraftMesh(spec);
        assert.equal(first.userData.pilotSeat.parent, first);
        assert.equal(second.userData.propeller.parent, second);
        assert.notEqual(first.userData.propeller, second.userData.propeller);
        first.userData.propeller.rotation.z = 2;
        assert.equal(Math.abs(second.userData.propeller.rotation.z), 0);
        const secondMesh = second.getObjectByName('UtvaAirframe').children[0];
        let disposed = false;
        secondMesh.geometry.addEventListener('dispose', () => { disposed = true; });
        disposeGroup(first);
        disposeAircraftModelCache();
        assert.equal(disposed, false, 'retiring a scene or the source cache cannot destroy a different aircraft');
        assert.throws(() => createAircraftMesh(spec), /preloaded/);
        disposeGroup(second);
        assert.equal(disposed, true);
    } finally {
        disposeAircraftModelCache();
        globalThis.fetch = originalFetch;
        if (originalProgressEvent === undefined) delete globalThis.ProgressEvent;
        else globalThis.ProgressEvent = originalProgressEvent;
    }
});
