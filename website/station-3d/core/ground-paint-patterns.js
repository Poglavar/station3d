import * as THREE from 'three';

const powerOfTwo = n => Number.isSafeInteger(n) && n > 0 && (n & (n - 1)) === 0;
const identity = spec => JSON.stringify([spec.key, spec.revision]);
const linearToSrgb = Uint8Array.from({ length: 256 }, (_, byte) => {
    const value = byte / 255;
    return Math.round(255 * (value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055));
});

// Pages share immutable, reference-counted patterns. Movement never copies
// material images. Array storage has one sampler and no atlas gutters.
export function createGroundPaintPatternLibrary({ renderer, size = 1024, maxLayers = 6,
    rowsPerStep = 16, now = () => performance.now() }) {
    if (typeof renderer?.initTexture !== 'function' || !renderer.capabilities
        || !powerOfTwo(size) || size > 1024 || !Number.isSafeInteger(maxLayers)
        || maxLayers < 1 || maxLayers > 6 || !Number.isSafeInteger(rowsPerStep)
        || rowsPerStep < 1 || rowsPerStep > 64) throw new TypeError('Invalid ground pattern library configuration');
    const slots = Array(maxLayers).fill(null), leases = new Set();
    let texture = null, closed = false, uploads = 0, maxItemMs = 0;
    let mipBytes = 0;
    for (let edge = size; edge >= 1; edge /= 2) mipBytes += edge * edge * 4 * maxLayers;

    function allocate() {
        if (texture) return;
        texture = new THREE.DataArrayTexture(new Uint8Array(size * size * maxLayers * 4), size, size, maxLayers);
        texture.name = 'Ground repeating material patterns';
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true; texture.flipY = false;
        texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy?.() || 1);
    }
    function capture(spec, resolve) {
        if (typeof spec.key !== 'string' || !spec.key || typeof spec.revision !== 'string' || !spec.revision
            || typeof resolve !== 'function') throw new TypeError('Ground pattern identity/resolver required');
        const source = resolve(spec.key, spec.revision), image = source?.image;
        if (!source?.isTexture || !image || source.wrapS !== THREE.RepeatWrapping || source.wrapT !== THREE.RepeatWrapping
            || ![THREE.SRGBColorSpace, THREE.LinearSRGBColorSpace].includes(source.colorSpace)) {
            throw new TypeError('Missing or incompatible repeating paint texture ' + spec.key);
        }
        const { width, height } = image;
        if (!powerOfTwo(width) || !powerOfTwo(height) || width > size || height > size
            || size % width || size % height) throw new RangeError('Ground pattern dimensions must divide the library size');
        if (source.isDataTexture) {
            if (source.type !== THREE.UnsignedByteType || source.format !== THREE.RGBAFormat
                || !(image.data instanceof Uint8Array) || image.data.length !== width * height * 4) {
                throw new TypeError('Ground pattern requires an RGBA8 data texture');
            }
        } else if (typeof image.getContext !== 'function') throw new TypeError('Ground pattern requires canvas or RGBA8 pixels');
        return { key: identity(spec), source, version: source.version, image, width, height,
            flipY: source.flipY, linear: source.colorSpace === THREE.LinearSRGBColorSpace };
    }
    function assertUnchanged(slot) {
        if (slot.source.version !== slot.version || slot.source.image !== slot.image
            || slot.image.width !== slot.width || slot.image.height !== slot.height
            || slot.source.flipY !== slot.flipY) throw new Error('Ground pattern source changed during preparation');
    }
    function acquire(captured, resolveAlbedoMap) {
        if (closed) throw new Error('Ground pattern library is disposed');
        if (!Array.isArray(captured?.recipes) || captured.recipes.length > 255) throw new TypeError('Invalid captured ground styles');
        const requested = new Map();
        for (const recipe of captured.recipes) {
            if (!recipe.albedoMap) continue;
            const input = capture(recipe.albedoMap, resolveAlbedoMap), earlier = requested.get(input.key);
            if (earlier && (earlier.source !== input.source || earlier.version !== input.version)) {
                throw new Error('Conflicting ground pattern identity');
            }
            requested.set(input.key, input);
        }
        // Validate capacity and every identity before allocation/reference
        // mutation. A rejected successor cannot disturb old pages.
        const matches = new Map();
        for (const input of requested.values()) {
            const slot = slots.find(item => item?.key === input.key);
            if (!slot) continue;
            if (slot.source !== input.source || slot.version !== input.version) throw new Error('Ground pattern identity changed without a revision');
            if (slot.phase !== 'ready') throw new Error('Ground pattern already has a private preparation');
            matches.set(input.key, slot);
        }
        // A released page does not free the array allocation. Keep its ready
        // pixels reusable inside that same bound instead of reading, copying
        // and uploading them again after a temporary gap in page ownership.
        // Validate the whole request before choosing victims: a cached match
        // requested later in the recipe list must not be evicted by a new key.
        const available = slots.filter(item => !item || (item.refs === 0 && !requested.has(item.key)));
        if (requested.size - matches.size > available.length) throw new RangeError('Ground pattern layer capacity exhausted');
        if (requested.size) allocate();
        const owned = new Map();
        for (const input of requested.values()) {
            let slot = matches.get(input.key);
            if (!slot) {
                let layer = slots.findIndex(item => !item);
                if (layer < 0) layer = slots.findIndex(item => item.refs === 0 && !requested.has(item.key));
                slot = { ...input, layer, refs: 0, phase: 'image', row: 0, pixels: null, stagingBytes: 0,
                    mapping: Object.freeze({ layer, scaleU: input.width / size, scaleV: input.height / size }) };
                slots[layer] = slot;
            }
            slot.refs++; owned.set(input.key, slot);
        }
        const pending = [...owned.values()].filter(slot => slot.phase !== 'ready');
        let cursor = 0, released = false;
        const lease = Object.freeze({
            get(spec) {
                if (released || cursor !== pending.length) throw new Error('Ground pattern lease is not ready');
                const slot = owned.get(identity(spec));
                if (!slot) throw new Error('Unknown captured ground pattern');
                return slot.mapping;
            },
            step() {
                if (released) throw new Error('Ground pattern lease is released');
                if (cursor === pending.length) return true;
                const started = now(), slot = pending[cursor];
                try {
                    assertUnchanged(slot);
                    if (slot.phase === 'image') {
                        const pixels = slot.source.isDataTexture ? slot.image.data
                            : slot.image.getContext('2d')?.getImageData(0, 0, slot.width, slot.height).data;
                        if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)
                            || pixels.length !== slot.width * slot.height * 4) throw new TypeError('Ground pattern pixels unavailable');
                        slot.pixels = pixels;
                        slot.stagingBytes = slot.source.isDataTexture ? 0 : pixels.byteLength;
                        slot.phase = 'copy';
                    } else if (slot.phase === 'copy') {
                        const end = Math.min(size, slot.row + rowsPerStep), data = texture.image.data;
                        for (let y = slot.row; y < end; y++) {
                            const sy = slot.flipY ? slot.height - 1 - y % slot.height : y % slot.height;
                            for (let x = 0; x < size; x++) {
                                const from = (sy * slot.width + x % slot.width) * 4;
                                const to = (slot.layer * size * size + y * size + x) * 4;
                                for (let channel = 0; channel < 4; channel++) {
                                    const byte = slot.pixels[from + channel];
                                    data[to + channel] = slot.linear && channel < 3 ? linearToSrgb[byte] : byte;
                                }
                            }
                        }
                        slot.row = end;
                        if (end === size) { slot.phase = 'upload'; slot.pixels = null; slot.stagingBytes = 0; }
                    } else if (slot.phase === 'upload') {
                        texture.addLayerUpdate(slot.layer); texture.needsUpdate = true;
                        renderer.initTexture(texture);
                        slot.phase = 'ready'; uploads++; cursor++;
                    }
                    return cursor === pending.length;
                } finally { maxItemMs = Math.max(maxItemMs, now() - started); }
            },
            get ready() { return !released && cursor === pending.length; },
            get released() { return released; },
            get texture() { return texture; },
            release() {
                if (released) return false;
                released = true; leases.delete(lease);
                for (const slot of owned.values()) if (--slot.refs === 0) {
                    if (closed || slot.phase !== 'ready') slots[slot.layer] = null;
                    slot.pixels = null; slot.stagingBytes = 0;
                }
                return true;
            },
        });
        leases.add(lease);
        return lease;
    }
    return Object.freeze({ acquire,
        get texture() { return texture; },
        stats: () => Object.freeze({ closed, allocatedCPUBytes: texture?.image.data.byteLength || 0,
            stagingCPUBytes: slots.reduce((sum, slot) => sum + (slot?.stagingBytes || 0), 0),
            allocatedGPUBaseBytes: texture ? size * size * maxLayers * 4 : 0,
            allocatedGPUFullMipsBytes: texture ? mipBytes : 0, capacity: maxLayers,
            referencedSlots: slots.filter(slot => slot?.refs > 0).length,
            residentSlots: slots.filter(Boolean).length, leases: leases.size, uploads, maxItemMs }),
        dispose() {
            if (closed) return false;
            closed = true;
            for (const lease of [...leases]) lease.release();
            slots.fill(null);
            texture?.dispose(); texture = null;
            return true;
        },
    });
}
