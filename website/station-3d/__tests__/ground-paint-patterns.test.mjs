import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGroundPaintPatternLibrary } from '../core/ground-paint-patterns.js';

const spec = (key = 'pavers', revision = 'v1') => ({ key, revision });
const captured = (...specs) => ({ recipes: specs.map(albedoMap => ({ albedoMap })) });
const pixels = [128,64,32,255, 64,160,96,255, 48,96,192,255, 192,160,128,255];
function source(data = pixels, colorSpace = THREE.SRGBColorSpace, flipY = false) {
    const texture = new THREE.DataTexture(new Uint8Array(data), 2, 2);
    texture.colorSpace = colorSpace; texture.flipY = flipY;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.needsUpdate = true;
    return texture;
}
function harness(options = {}) {
    const uploads = [];
    let time = 0;
    const renderer = { capabilities: { getMaxAnisotropy: () => 8 },
        initTexture(texture) {
            assert.ok(texture.version > 0, 'mark pixels dirty before submitting the upload');
            assert.equal(texture.layerUpdates.size, 1, 'one layer upload per bounded item');
            uploads.push({ version: texture.version, layers: [...texture.layerUpdates], bytes: texture.image.data.slice() });
            texture.clearLayerUpdates();
        } };
    return { uploads, library: createGroundPaintPatternLibrary({ renderer, size: 4, maxLayers: 2,
        rowsPerStep: 1, now: () => ++time, ...options }) };
}
function finish(lease, limit = 30) {
    for (let step = 0; step < limit && !lease.ready; step++) lease.step();
    assert.equal(lease.ready, true, 'bounded preparation must finish');
}

test('row copies, source read and upload are separate; repeated pixels preserve world scale', () => {
    const { library, uploads } = harness(), texture = source();
    const requests = [];
    const lease = library.acquire(captured(spec()), (key, revision) => { requests.push([key, revision]); return texture; });
    assert.deepEqual(requests, [['pavers','v1']]);
    assert.throws(() => lease.get(spec()), /not ready/);
    lease.step();
    assert.ok(library.texture.image.data.every(byte => byte === 0), 'image-read item must not copy rows');
    for (let y = 0; y < 4; y++) {
        assert.equal(lease.step(), false);
        assert.equal(uploads.length, 0, 'row copy cannot also upload');
        for (let x = 0; x < 4; x++) {
            assert.deepEqual([...library.texture.image.data.slice((y*4+x)*4,(y*4+x+1)*4)],
                pixels.slice((y%2*2+x%2)*4,(y%2*2+x%2+1)*4));
        }
        assert.ok(library.texture.image.data.slice((y+1)*16,64).every(byte => byte === 0));
    }
    assert.equal(lease.step(), true); assert.equal(uploads.length, 1);
    assert.deepEqual(lease.get(spec()), { layer: 0, scaleU: .5, scaleV: .5 });
    assert.equal(library.stats().maxItemMs, 1);
    lease.release(); library.dispose();
});

test('canvas-style flip and linear source conversion preserve the sampled image', () => {
    for (const [flipY, colorSpace] of [[true,THREE.SRGBColorSpace],[false,THREE.LinearSRGBColorSpace]]) {
        const { library } = harness(), texture = source(pixels,colorSpace,flipY);
        const lease = library.acquire(captured(spec()), () => texture); finish(lease);
        const offset = flipY ? 8 : 0;
        const expected = pixels.slice(offset,offset+4).map((byte,c) => {
            if (colorSpace !== THREE.LinearSRGBColorSpace || c === 3) return byte;
            const value = byte/255;
            return Math.round(255*(value<=.0031308 ? 12.92*value : 1.055*value**(1/2.4)-.055));
        });
        assert.deepEqual([...library.texture.image.data.slice(0,4)], expected);
        lease.release(); library.dispose();
    }
});

test('capacity and identity preflight retain old slots and reference counts unchanged', () => {
    const { library } = harness({ maxLayers: 1 }), a = source(), b = source();
    const lease = library.acquire(captured(spec()), () => a); finish(lease);
    const before = library.stats(), bytes = library.texture.image.data.slice();
    assert.throws(() => library.acquire(captured(spec(),spec('other')), key => key === 'pavers' ? a : b), /capacity/);
    assert.throws(() => library.acquire(captured(spec()), () => b), /identity/);
    a.needsUpdate = true;
    assert.throws(() => library.acquire(captured(spec()), () => a), /revision/);
    assert.deepEqual(library.stats(), before);
    assert.deepEqual(library.texture.image.data, bytes);
    assert.equal(lease.get(spec()).layer, 0, 'ready copy survives its borrowed source changing');
    lease.release(); library.dispose();
});

test('active and staged leases pin slots; cancelling a candidate cannot alter old bytes', () => {
    const { library, uploads } = harness(), a = source(), b = source(pixels.map((v,i)=>i%4===3?255:255-v));
    let sourceDisposals = 0; a.addEventListener('dispose', () => sourceDisposals++);
    const first = library.acquire(captured(spec()), () => a); finish(first);
    const second = library.acquire(captured(spec()), () => a);
    assert.equal(second.ready, true); assert.equal(uploads.length, 1);
    first.release(); assert.equal(library.stats().referencedSlots, 1);
    const old = library.texture.image.data.slice(0,64);
    const staged = library.acquire(captured(spec('pavers','v2')), () => b);
    staged.step(); staged.step();
    assert.deepEqual(library.texture.image.data.slice(0,64), old);
    staged.release(); assert.equal(library.stats().referencedSlots, 1);
    const replacement = library.acquire(captured(spec('other')), () => b); finish(replacement);
    assert.equal(replacement.get(spec('other')).layer, 1);
    second.release(); replacement.release();
    assert.equal(library.stats().referencedSlots, 0);
    const reused = library.acquire(captured(spec('third')), () => b); finish(reused);
    assert.equal(reused.get(spec('third')).layer, 0);
    reused.release(); assert.equal(library.dispose(), true); assert.equal(library.dispose(), false);
    assert.equal(sourceDisposals, 0, 'library borrows original source textures');
});

test('source changes during cooperative work reject before new bytes reach the GPU', () => {
    const { library, uploads } = harness(), texture = source();
    const lease = library.acquire(captured(spec()), () => texture);
    assert.throws(() => library.acquire(captured(spec()), () => texture), /private preparation/);
    lease.step(); texture.needsUpdate = true;
    assert.throws(() => lease.step(), /changed during preparation/);
    assert.equal(uploads.length, 0); lease.release();
    assert.equal(library.stats().leases, 0); assert.equal(library.stats().referencedSlots, 0);
    library.dispose();
});

test('canvas readback is one bounded step and its staging copy is released after row packing', () => {
    const { library, uploads } = harness();
    let reads = 0;
    const image = { width: 2, height: 2, getContext(kind) {
        assert.equal(kind, '2d');
        return { getImageData(...args) {
            assert.deepEqual(args, [0,0,2,2]); reads++;
            return { data: new Uint8ClampedArray(pixels) };
        } };
    } };
    const texture = new THREE.CanvasTexture(image);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.colorSpace = THREE.SRGBColorSpace;
    const lease = library.acquire(captured(spec()), () => texture);
    assert.equal(reads, 0); lease.step();
    assert.equal(reads, 1); assert.equal(library.stats().stagingCPUBytes, 16);
    assert.equal(uploads.length, 0);
    finish(lease);
    assert.equal(library.stats().stagingCPUBytes, 0);
    assert.deepEqual([...library.texture.image.data.slice(0,4)], pixels.slice(8,12));
    assert.equal(reads, 1); lease.release(); library.dispose();
});

test('empty material tables require no resolver, allocation or upload and dispose all leases', () => {
    const { library } = harness();
    const lease = library.acquire({ recipes: [{ linearColor: [1,1,1] }] });
    assert.equal(lease.ready, true); assert.equal(lease.texture, null);
    assert.equal(library.stats().allocatedGPUFullMipsBytes, 0);
    assert.equal(library.stats().leases, 1);
    lease.release(); assert.equal(library.stats().leases, 0);
    const active = library.acquire({ recipes: [] });
    library.dispose(); assert.equal(active.released, true);
    assert.throws(() => active.step(), /released/);
    assert.throws(() => library.acquire({ recipes: [] }), /disposed/);
});

test('exact retained and mip allocations include every reserved layer', () => {
    const { library } = harness({ size: 1024, maxLayers: 4 });
    const lease = library.acquire(captured(spec()), () => source());
    assert.equal(library.stats().allocatedCPUBytes, 16777216);
    assert.equal(library.stats().allocatedGPUBaseBytes, 16777216);
    assert.equal(library.stats().allocatedGPUFullMipsBytes, 22369616);
    lease.release(); library.dispose();
});

test('missing, malformed, oversized and non-repeating inputs fail before allocation', () => {
    const { library } = harness();
    const noRepeat = source(); noRepeat.wrapT = THREE.ClampToEdgeWrapping;
    const malformed = source(); malformed.image.data = new Uint8Array(3);
    const oversized = source(); oversized.image.width = 8;
    for (const texture of [null,{},noRepeat,malformed,oversized]) {
        assert.throws(() => library.acquire(captured(spec()), () => texture));
        assert.equal(library.texture, null); assert.equal(library.stats().leases, 0);
    }
    library.dispose();
});

test('six bounded shared patterns admit road and land-use recipes without per-page copies', () => {
    const {library,uploads} = harness({maxLayers:6});
    const specs = Array.from({length:6}, (_,i) => spec(`pattern:${i}`));
    const textures = new Map(specs.map(s => [s.key,source()]));
    const lease = library.acquire(captured(...specs), key => textures.get(key));
    finish(lease, 50);
    assert.equal(uploads.length,6);
    assert.equal(library.texture.image.depth,6);
    assert.equal(library.texture.image.data.length,4*4*4*6);
    const shared = library.acquire(captured(...specs), key => textures.get(key));
    assert.equal(shared.ready,true);
    assert.equal(uploads.length,6,'a new page reuses the ready patterns');
    shared.release(); lease.release(); library.dispose();
});

test('released ready patterns remain resident and reacquire without another upload', () => {
    const { library, uploads } = harness({ maxLayers: 2 });
    const texture = source();
    const first = library.acquire(captured(spec('retained')), () => texture);
    finish(first);
    assert.equal(uploads.length, 1);
    first.release();
    assert.equal(library.stats().referencedSlots, 0);
    assert.equal(library.stats().residentSlots, 1);

    const second = library.acquire(captured(spec('retained')), () => texture);
    assert.equal(second.ready, true);
    assert.equal(uploads.length, 1, 'ready resident is reused without uploading');
    assert.deepEqual(second.get(spec('retained')), { layer: 0, scaleU: .5, scaleV: .5 });
    second.release();
    library.dispose();
    assert.equal(library.stats().residentSlots, 0, 'dispose releases the unused ready resident');
    assert.equal(library.stats().allocatedCPUBytes, 0);
    assert.equal(library.stats().allocatedGPUFullMipsBytes, 0);
});

test('new acquisition preserves requested cached identity and evicts only an unused slot', () => {
    const { library } = harness({ maxLayers: 2 });
    const textures = new Map([
        ['a', source()], ['b', source(pixels.map((v, i) => i % 4 === 3 ? 255 : 255 - v))],
        ['c', source([32, 80, 144, 255, 144, 80, 32, 255, 96, 48, 160, 255, 160, 48, 96, 255])],
    ]);
    const resolve = key => textures.get(key);
    const a = library.acquire(captured(spec('a')), resolve); finish(a); a.release();
    const b = library.acquire(captured(spec('b')), resolve); finish(b); b.release();
    const requested = library.acquire(captured(spec('c'), spec('a')), resolve);
    finish(requested);
    assert.equal(requested.ready, true);
    assert.equal(requested.get(spec('a')).layer, 0, 'requested cached slot stays resident');
    assert.equal(requested.get(spec('c')).layer, 1, 'new request uses the released slot');
    requested.release();
    library.dispose();
});

test('pinned slots reject over-capacity without changing cache state', () => {
    const { library } = harness({ maxLayers: 2 });
    const a = source(), b = source(), c = source();
    const first = library.acquire(captured(spec('a')), key => key === 'a' ? a : b); finish(first);
    const second = library.acquire(captured(spec('b')), key => key === 'a' ? a : b); finish(second);
    const before = library.stats();
    assert.throws(() => library.acquire(captured(spec('c')), () => c), /capacity/);
    assert.deepEqual(library.stats(), before);
    first.release(); second.release(); library.dispose();
});

test('cancelling partial preparation frees its slot and dispose clears storage', () => {
    const { library } = harness({ maxLayers: 2 });
    const lease = library.acquire(captured(spec('partial')), () => source());
    lease.step();
    assert.equal(library.stats().residentSlots, 1);
    lease.release();
    assert.equal(library.stats().referencedSlots, 0);
    assert.equal(library.stats().residentSlots, 0);
    assert.equal(library.dispose(), true);
    assert.equal(library.stats().residentSlots, 0);
    assert.equal(library.stats().allocatedCPUBytes, 0);
    assert.equal(library.stats().allocatedGPUBaseBytes, 0);
});
