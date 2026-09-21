// Versioned, Three.js-free geometry contract shared by render Workers and the
// main-thread publication boundary. Packet coordinates are physical metres in
// the tile's local frame; the tile origin carries the geographic placement.

export const RENDER_PACKET_SCHEMA_VERSION = 1;
export const RENDER_PACKET_CONTRACT = 'station3d-render-packet-v1';

export class RenderPacketValidationError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'RenderPacketValidationError';
        this.code = code;
        this.details = details;
    }
}

function fail(code, message, details = null) {
    throw new RenderPacketValidationError(code, message, details);
}

function finite(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) fail('non-finite-value', `${label} must be finite`);
    return number;
}

function integer(value, label) {
    const number = finite(value, label);
    if (!Number.isInteger(number)) fail('non-integer-value', `${label} must be an integer`);
    return number;
}

function nonEmptyString(value, label) {
    const text = String(value ?? '').trim();
    if (!text) fail('missing-string', `${label} must be a non-empty string`);
    return text;
}

function validateRevision(value, label) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    fail('invalid-revision', `${label} must be a finite number or non-empty string`);
}

function validateTile(tile, label = 'tile') {
    if (!tile || typeof tile !== 'object') fail('missing-tile', `${label} is required`);
    nonEmptyString(tile.matrix, `${label}.matrix`);
    integer(tile.z, `${label}.z`);
    integer(tile.x, `${label}.x`);
    integer(tile.y, `${label}.y`);
    finite(tile.originLon, `${label}.originLon`);
    finite(tile.originLat, `${label}.originLat`);
    if (tile.sizeM != null && !(finite(tile.sizeM, `${label}.sizeM`) > 0)) {
        fail('invalid-tile-size', `${label}.sizeM must be positive`);
    }
    return tile;
}

function validateBounds(bounds, label) {
    if (!bounds || typeof bounds !== 'object') {
        fail('missing-bounds', `${label}.bounds is required`);
    }
    const resolved = {
        minX: finite(bounds.minX, `${label}.bounds.minX`),
        minY: finite(bounds.minY, `${label}.bounds.minY`),
        minZ: finite(bounds.minZ, `${label}.bounds.minZ`),
        maxX: finite(bounds.maxX, `${label}.bounds.maxX`),
        maxY: finite(bounds.maxY, `${label}.bounds.maxY`),
        maxZ: finite(bounds.maxZ, `${label}.bounds.maxZ`),
    };
    if (resolved.maxX < resolved.minX
        || resolved.maxY < resolved.minY
        || resolved.maxZ < resolved.minZ) {
        fail('inverted-bounds', `${label}.bounds has an inverted axis`);
    }
    return resolved;
}

function validateTypedArray(value, Type, label, { optional = false } = {}) {
    if (optional && value == null) return null;
    if (!(value instanceof Type)) {
        fail('invalid-typed-array', `${label} must be ${Type.name}`);
    }
    return value;
}

function* validateEntityRanges(ranges, indexCount, label, budget) {
    if (!Array.isArray(ranges)) fail('invalid-entity-ranges', `${label} must be an array`);
    let previousEnd = 0;
    for (let index = 0; index < ranges.length; index++) {
        const range = ranges[index];
        if (!range || typeof range !== 'object') {
            fail('invalid-entity-range', `${label}[${index}] must be an object`);
        }
        if (range.entityId == null || String(range.entityId).trim() === '') {
            fail('missing-entity-id', `${label}[${index}].entityId is required`);
        }
        const startIndex = integer(range.startIndex, `${label}[${index}].startIndex`);
        const count = integer(range.indexCount, `${label}[${index}].indexCount`);
        if (startIndex < 0 || count < 0 || startIndex + count > indexCount) {
            fail('entity-range-out-of-bounds', `${label}[${index}] exceeds its primitive`);
        }
        if (startIndex < previousEnd) {
            fail('overlapping-entity-ranges', `${label}[${index}] overlaps the previous range`);
        }
        previousEnd = startIndex + count;
        if (budget.check()) yield;
    }
}

function* colliderEntries(value) {
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) yield [index, value[index]];
    } else {
        for (const key in value) {
            if (Object.hasOwn(value, key)) yield [key, value[key]];
        }
    }
}

function* validateColliderData(colliderData, label, budget) {
    if (colliderData == null) return;
    if (typeof colliderData !== 'object' || Array.isArray(colliderData)) {
        fail('invalid-collider-data', `${label} must be an object or null`);
    }
    const visit = function* (value, path, seen) {
        if (budget.check()) yield;
        if (value == null || typeof value === 'string' || typeof value === 'boolean') return;
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) fail('non-finite-collider-field', `${path} must be finite`);
            return;
        }
        if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return;
        if (typeof value !== 'object') {
            fail('invalid-collider-field', `${path} cannot be transferred`);
        }
        if (seen.has(value)) fail('cyclic-collider-data', `${path} must not be cyclic`);
        seen.add(value);
        for (const [key, child] of colliderEntries(value)) yield* visit(child, `${path}.${key}`, seen);
        seen.delete(value);
    };
    for (const [key, value] of colliderEntries(colliderData)) {
        yield* visit(value, `${label}.${key}`, new Set());
    }
}

function* validateSurfaceClaims(claims, label, budget) {
    if (!Array.isArray(claims)) fail('invalid-surface-claims', `${label} must be an array`);
    for (let index = 0; index < claims.length; index++) {
        const claim = claims[index];
        if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
            fail('invalid-surface-claim', `${label}[${index}] must be an object`);
        }
        for (const key of ['surfaceClass', 'coverageState', 'verticalRelation']) {
            if (claim[key] != null) nonEmptyString(claim[key], `${label}[${index}].${key}`);
        }
        if (budget.check()) yield;
    }
}

function* validateFiniteArray(values, label, budget) {
    for (let index = 0; index < values.length; index++) {
        if (!Number.isFinite(values[index])) {
            fail('non-finite-attribute', `${label}[${index}] must be finite`);
        }
        if (budget.check()) yield;
    }
}

function* validatePrimitive(primitive, primitiveIndex, budget) {
    const label = `primitives[${primitiveIndex}]`;
    if (!primitive || typeof primitive !== 'object') {
        fail('invalid-primitive', `${label} must be an object`);
    }
    const positions = validateTypedArray(primitive.positions, Float32Array, `${label}.positions`);
    const normals = validateTypedArray(primitive.normals, Float32Array, `${label}.normals`);
    const uvs = validateTypedArray(primitive.uvs, Float32Array, `${label}.uvs`);
    const colors = validateTypedArray(
        primitive.colors,
        Float32Array,
        `${label}.colors`,
        { optional: true },
    );
    const indices = primitive.indices instanceof Uint16Array
        ? primitive.indices
        : validateTypedArray(primitive.indices, Uint32Array, `${label}.indices`);
    if (positions.length === 0 || positions.length % 3 !== 0) {
        fail('invalid-position-count', `${label}.positions must contain complete vertices`);
    }
    const vertexCount = positions.length / 3;
    if (normals.length !== positions.length) {
        fail('invalid-normal-count', `${label}.normals must match positions`);
    }
    if (uvs.length !== vertexCount * 2) {
        fail('invalid-uv-count', `${label}.uvs must contain one pair per vertex`);
    }
    if (colors && colors.length !== positions.length) {
        fail('invalid-color-count', `${label}.colors must contain one RGB value per vertex`);
    }
    yield* validateFiniteArray(normals, `${label}.normals`, budget);
    yield* validateFiniteArray(uvs, `${label}.uvs`, budget);
    if (colors) yield* validateFiniteArray(colors, `${label}.colors`, budget);
    // A fully cut receiver still carries its lattice and coverage metadata.
    // Empty output must be explicit; an accidentally missing index buffer is
    // not evidence that an owner has deliberately withdrawn all its faces.
    if ((indices.length === 0 && primitive.empty !== true) || indices.length % 3 !== 0) {
        fail('invalid-index-count', `${label}.indices must contain complete triangles`);
    }
    if (primitive.empty != null && (typeof primitive.empty !== 'boolean'
        || primitive.empty !== (indices.length === 0))) {
        fail('invalid-empty-primitive', `${label}.empty must agree with its index buffer`);
    }
    const bounds = validateBounds(primitive.bounds, label);
    for (let index = 0; index < indices.length; index++) {
        if (indices[index] >= vertexCount) {
            fail('index-out-of-bounds', `${label}.indices[${index}] exceeds vertex count`);
        }
        if (budget.check()) yield;
    }
    const epsilon = 1e-3;
    for (let offset = 0; offset < positions.length; offset += 3) {
        const x = positions[offset];
        const y = positions[offset + 1];
        const z = positions[offset + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            fail('non-finite-position', `${label}.positions contains a non-finite value`);
        }
        if (x < bounds.minX - epsilon || x > bounds.maxX + epsilon
            || y < bounds.minY - epsilon || y > bounds.maxY + epsilon
            || z < bounds.minZ - epsilon || z > bounds.maxZ + epsilon) {
            fail('position-outside-bounds', `${label}.positions lies outside declared bounds`);
        }
        if (budget.check()) yield;
    }
    nonEmptyString(primitive.materialKey, `${label}.materialKey`);
    finite(primitive.renderOrder, `${label}.renderOrder`);
    yield* validateEntityRanges(primitive.entityRanges, indices.length, `${label}.entityRanges`, budget);
    yield* validateSurfaceClaims(primitive.surfaceClaims, `${label}.surfaceClaims`, budget);
    yield* validateColliderData(primitive.colliderData, `${label}.colliderData`, budget);
    if (budget.check()) yield;
    return primitive;
}

function sameTile(actual, expected) {
    return actual.matrix === expected.matrix
        && actual.z === expected.z
        && actual.x === expected.x
        && actual.y === expected.y
        && Math.abs(actual.originLon - expected.originLon) <= 1e-10
        && Math.abs(actual.originLat - expected.originLat) <= 1e-10;
}

// Identity/schema checks are constant-size and run before any deferred work.
// This is not a geometry-validation receipt: consumers must finish the task.
function validateRenderPacketHeader(packet, expected = {}) {
    if (!packet || typeof packet !== 'object') fail('missing-packet', 'Render packet is required');
    if (packet.schemaVersion !== RENDER_PACKET_SCHEMA_VERSION) {
        fail(
            'unsupported-schema',
            `Expected render packet schema ${RENDER_PACKET_SCHEMA_VERSION}`,
            { actual: packet.schemaVersion },
        );
    }
    const compilerId = nonEmptyString(packet.compilerId, 'compilerId');
    nonEmptyString(packet.compilerVersion, 'compilerVersion');
    validateRevision(packet.sourceRevision, 'sourceRevision');
    if (integer(packet.generation, 'generation') < 0) {
        fail('invalid-generation', 'generation must be non-negative');
    }
    validateTile(packet.tile);
    if (!Array.isArray(packet.primitives)) fail('invalid-primitives', 'primitives must be an array');

    if (expected.compilerId != null && compilerId !== expected.compilerId) {
        fail('compiler-mismatch', `Expected compiler ${expected.compilerId}, got ${compilerId}`);
    }
    if (expected.compilerVersion != null
        && String(packet.compilerVersion) !== String(expected.compilerVersion)) {
        fail('compiler-version-mismatch', 'Render packet compiler version is stale');
    }
    if (expected.sourceRevision != null
        && String(packet.sourceRevision) !== String(expected.sourceRevision)) {
        fail('source-revision-mismatch', 'Render packet source revision is stale');
    }
    if (expected.generation != null && packet.generation !== expected.generation) {
        fail('generation-mismatch', 'Render packet generation is stale');
    }
    if (expected.tile && !sameTile(packet.tile, expected.tile)) {
        fail('tile-mismatch', 'Render packet tile does not match the request');
    }
    return packet;
}

// A step visits at most this many scalar values, XYZ vertices, or metadata
// records. The caller's existing frame queue checks its clock after EACH step.
// Sharing one counter across primitives prevents a large many-small-primitives
// packet from slipping through a per-buffer limit.
export const RENDER_PACKET_VALIDATION_CHECKS_PER_STEP = 2048;

export function createRenderPacketValidationTask(packetValue, expected = {}) {
    let packet = validateRenderPacketHeader(packetValue, expected);
    let checkedRecords = 0;
    let done = packet.primitives.length === 0;
    let disposed = false;
    const budget = {
        check() {
            checkedRecords += 1;
            return checkedRecords % RENDER_PACKET_VALIDATION_CHECKS_PER_STEP === 0;
        },
    };
    let iterator = (function* () {
        for (let index = 0; index < packet.primitives.length; index++) {
            yield* validatePrimitive(packet.primitives[index], index, budget);
        }
    })();
    return Object.freeze({
        step() {
            if (disposed) throw new Error('Render packet validation task is disposed');
            try {
                if (!done) done = iterator.next().done;
                if (done) iterator = null;
                return done;
            } catch (error) {
                // A closed generator returns done on its next advance. Latch
                // failure so catching an error cannot turn a bad packet valid.
                disposed = true;
                iterator = null;
                packet = null;
                throw error;
            }
        },
        get done() { return done; },
        progress: () => ({ checkedRecords, complete: done }),
        result() {
            if (disposed) throw new Error('Render packet validation task is disposed');
            if (!done) throw new Error('Render packet validation is incomplete');
            return packet;
        },
        dispose() {
            if (disposed) return false;
            disposed = true;
            iterator?.return();
            iterator = null;
            packet = null;
            return true;
        },
    });
}

// Workers and offline contract/fingerprint tools explicitly drain the same
// validator. Main-thread landing adapters use its bounded task instead.
export function validateRenderPacket(packet, expected = {}) {
    const task = createRenderPacketValidationTask(packet, expected);
    while (!task.step()) { /* worker/offline synchronous drain */ }
    return task.result();
}

function collectArrayBuffers(value, output, seen) {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        const buffer = value.buffer;
        if (!seen.has(buffer)) {
            seen.add(buffer);
            output.push(buffer);
        }
        return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const item of value) collectArrayBuffers(item, output, seen);
        return;
    }
    for (const item of Object.values(value)) collectArrayBuffers(item, output, seen);
}

export function renderPacketTransferables(packet) {
    const output = [];
    collectArrayBuffers(packet?.primitives || [], output, new Set());
    return output;
}

function fnvByte(hash, byte) {
    hash ^= byte;
    return Math.imul(hash, 16777619) >>> 0;
}

function hashText(hash, value) {
    const bytes = new TextEncoder().encode(String(value));
    for (const byte of bytes) hash = fnvByte(hash, byte);
    return hash;
}

// Compact deterministic fingerprint used by parity fixtures and shadow A/B.
// It is deliberately not cryptographic; byte-for-byte drift is the verdict.
export function renderPacketFingerprint(packet) {
    validateRenderPacket(packet);
    let hash = 2166136261;
    hash = hashText(hash, JSON.stringify({
        schemaVersion: packet.schemaVersion,
        compilerId: packet.compilerId,
        compilerVersion: packet.compilerVersion,
        sourceRevision: packet.sourceRevision,
        generation: packet.generation,
        tile: packet.tile,
        primitives: packet.primitives.map(primitive => ({
            materialKey: primitive.materialKey,
            renderOrder: primitive.renderOrder,
            bounds: primitive.bounds,
            entityRanges: primitive.entityRanges,
            surfaceClaims: primitive.surfaceClaims,
            colliderData: primitive.colliderData,
        })),
    }));
    for (const buffer of renderPacketTransferables(packet)) {
        for (const byte of new Uint8Array(buffer)) hash = fnvByte(hash, byte);
    }
    return hash.toString(16).padStart(8, '0');
}
