// Shared deterministic binary envelope for immutable Station3D geometry.
//
// The JSON directory contains ordinary metadata plus typed-array descriptors;
// the heavy geometry buffers follow it as aligned binary sections. Keeping the
// codec Three.js-free lets Node bake/publish tools and the browser use exactly
// the same validation and decoding path.

const HEADER_BYTES = 24;
const ALIGNMENT = 8;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_SECTION_COUNT = 1_000_000;

const TYPED_ARRAYS = Object.freeze({
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
});

export class TypedArrayEnvelopeError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'TypedArrayEnvelopeError';
        this.code = code;
        this.details = details;
    }
}

// Preserve the $s3l directory marker and S3L1 byte layout for existing campaigns.
export function createTypedArrayEnvelopeCodec({
    magic, version, validate, ErrorType = TypedArrayEnvelopeError,
    label = 'Geometry envelope', maxBytes = 0xffffffff,
}) {
    if (typeof magic !== 'string' || !/^[\x20-\x7e]{4}$/.test(magic)
        || !Number.isInteger(version) || version < 1 || version > 65535
        || typeof validate !== 'function') throw new TypeError('Invalid binary envelope codec');

    function fail(code, message, details = null) {
        throw new ErrorType(code, message.replaceAll('Campaign pack', label).replaceAll('campaign pack', label), details);
    }

    function align(value) {
        return Math.ceil(value / ALIGNMENT) * ALIGNMENT;
    }

    function canonicalize(value) {
        if (Array.isArray(value)) return value.map(canonicalize);
        if (!value || typeof value !== 'object') return value;
        const output = Object.create(null);
        for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
        return output;
    }

    function encodeDirectoryValue(value, sections, seen, copySections) {
        if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
            const type = value.constructor?.name;
            if (!Object.hasOwn(TYPED_ARRAYS, type)) {
                fail('unsupported-typed-array', `Campaign pack cannot encode ${type || 'this view'}`);
            }
            const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            const sectionBytes = copySections ? new Uint8Array(bytes) : bytes;
            const section = sections.length;
            sections.push(sectionBytes);
            return {
                $s3l: 'typed-array',
                section,
                type,
                length: value.length,
                byteLength: sectionBytes.byteLength,
            };
        }
        if (value instanceof ArrayBuffer) {
            const sectionBytes = copySections
                ? new Uint8Array(value.slice(0))
                : new Uint8Array(value);
            const section = sections.length;
            sections.push(sectionBytes);
            return {
                $s3l: 'array-buffer',
                section,
                byteLength: sectionBytes.byteLength,
            };
        }
        if (Array.isArray(value)) {
            if (seen.has(value)) fail('cyclic-value', 'Campaign pack values must not be cyclic');
            seen.add(value);
            const output = value.map(item => encodeDirectoryValue(item, sections, seen, copySections));
            seen.delete(value);
            return output;
        }
        if (!value || typeof value !== 'object') {
            if (typeof value === 'number' && !Number.isFinite(value)) {
                fail('non-finite-value', 'Campaign pack numbers must be finite');
            }
            if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
                fail('unsupported-value', `Campaign pack cannot encode ${typeof value}`);
            }
            return value;
        }
        if (seen.has(value)) fail('cyclic-value', 'Campaign pack values must not be cyclic');
        if (value.$s3l === 'typed-array' || value.$s3l === 'array-buffer') {
            fail('reserved-descriptor', 'Binary section descriptors cannot be supplied as metadata');
        }
        seen.add(value);
        const output = Object.create(null);
        for (const key of Object.keys(value).sort()) {
            const child = value[key];
            if (child !== undefined) {
                output[key] = encodeDirectoryValue(child, sections, seen, copySections);
            }
        }
        seen.delete(value);
        return output;
    }

    function encodedParts(chunkValue, { copySections = false } = {}) {
        const chunk = validate(chunkValue);
        const sections = [];
        const directoryValue = encodeDirectoryValue(chunk, sections, new Set(), copySections);
        const metadata = new TextEncoder().encode(JSON.stringify(canonicalize(directoryValue)));
        if (metadata.byteLength > MAX_METADATA_BYTES) {
            fail('metadata-too-large', 'Campaign pack metadata exceeds the decoder limit');
        }
        const directoryEnd = align(HEADER_BYTES + metadata.byteLength);
        let totalBytes = directoryEnd;
        for (const section of sections) {
            totalBytes = align(totalBytes + section.byteLength);
        }
        if (totalBytes > maxBytes || sections.length > MAX_SECTION_COUNT) fail('encoder-limit', 'Campaign pack exceeds envelope limits');
        const prefix = new Uint8Array(directoryEnd);
        prefix.set(new TextEncoder().encode(magic), 0);
        const view = new DataView(prefix.buffer);
        view.setUint16(4, version, true);
        view.setUint16(6, 0, true);
        view.setUint32(8, metadata.byteLength, true);
        view.setUint32(12, sections.length, true);
        view.setUint32(16, directoryEnd, true);
        view.setUint32(20, totalBytes, true);
        prefix.set(metadata, HEADER_BYTES);
        const parts = [prefix];
        let offset = directoryEnd;
        for (const section of sections) {
            parts.push(section);
            offset += section.byteLength;
            const padding = align(offset) - offset;
            if (padding > 0) {
                parts.push(new Uint8Array(padding));
                offset += padding;
            }
        }
        return { parts, totalBytes };
    }

    function encode(chunkValue) {
        const { parts, totalBytes } = encodedParts(chunkValue);
        const output = new ArrayBuffer(totalBytes);
        const bytes = new Uint8Array(output);
        let offset = 0;
        for (const part of parts) {
            bytes.set(part, offset);
            offset += part.byteLength;
        }
        return output;
    }

    function encodeBlob(chunkValue, { type = '' } = {}) {
        if (typeof Blob !== 'function') {
            throw new Error('Campaign pack Blob encoding is unavailable in this runtime');
        }
        const { parts } = encodedParts(chunkValue);
        return new Blob(parts, { type });
    }

    function checkedInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
        const number = value;
        if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
            fail('invalid-directory', `${label} is invalid`);
        }
        return number;
    }

    function sectionTable(directoryValue, bytes, sectionStart, sectionCount) {
        const descriptors = new Map();
        const visit = (value) => {
            if (!value || typeof value !== 'object') return;
            if (value.$s3l === 'typed-array' || value.$s3l === 'array-buffer') {
                const index = checkedInteger(value.section, 'section index', {
                    max: Math.max(0, sectionCount - 1),
                });
                if (descriptors.has(index)) fail('duplicate-section', `Section ${index} is referenced twice`);
                const byteLength = checkedInteger(value.byteLength, 'section byte length', {
                    max: bytes.byteLength,
                });
                descriptors.set(index, { byteLength });
                return;
            }
            if (Array.isArray(value)) value.forEach(visit);
            else Object.values(value).forEach(visit);
        };
        visit(directoryValue);
        if (descriptors.size !== sectionCount) {
            fail('section-count-mismatch', 'Campaign pack section directory is incomplete');
        }
        const sections = [];
        let offset = sectionStart;
        for (let index = 0; index < sectionCount; index++) {
            const descriptor = descriptors.get(index);
            if (!descriptor) fail('missing-section', `Campaign pack section ${index} is missing`);
            const end = offset + descriptor.byteLength;
            if (end > bytes.byteLength) fail('truncated-section', `Campaign pack section ${index} is truncated`);
            // Decode owns one copy per section, made below; do not copy it twice.
            sections.push(bytes.subarray(offset, end));
            offset = align(end);
        }
        if (offset !== bytes.byteLength) fail('trailing-bytes', 'Campaign pack has an invalid byte length');
        return sections;
    }

    function decodeDirectoryValue(value, sections) {
        if (Array.isArray(value)) return value.map(item => decodeDirectoryValue(item, sections));
        if (!value || typeof value !== 'object') return value;
        if (value.$s3l === 'array-buffer') {
            const section = sections[value.section];
            return section.buffer.slice(section.byteOffset, section.byteOffset + section.byteLength);
        }
        if (value.$s3l === 'typed-array') {
            const Type = Object.hasOwn(TYPED_ARRAYS, value.type) ? TYPED_ARRAYS[value.type] : null;
            if (!Type) fail('unsupported-typed-array', `Unknown campaign pack array ${value.type}`);
            const section = sections[value.section];
            const length = checkedInteger(value.length, 'typed array length');
            if (length * Type.BYTES_PER_ELEMENT !== section.byteLength) {
                fail('typed-array-size-mismatch', `Campaign pack ${value.type} section has the wrong length`);
            }
            const buffer = section.buffer.slice(section.byteOffset, section.byteOffset + section.byteLength);
            return new Type(buffer, 0, length);
        }
        const output = {};
        for (const [key, child] of Object.entries(value)) {
            Object.defineProperty(output, key, {
                value: decodeDirectoryValue(child, sections), enumerable: true, writable: true, configurable: true,
            });
        }
        return output;
    }

    function asBytes(value) {
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        fail('invalid-input', 'Campaign pack decoder requires an ArrayBuffer or typed-array view');
    }

    function decode(value) {
        const input = asBytes(value);
        if (input.byteLength < HEADER_BYTES) fail('truncated-header', 'Campaign pack header is truncated');
        const inputMagic = new TextDecoder().decode(input.subarray(0, 4));
        if (inputMagic !== magic) fail('invalid-magic', 'Campaign pack magic is invalid');
        const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
        const inputVersion = view.getUint16(4, true);
        if (inputVersion !== version) {
            fail('unsupported-version', `Unsupported campaign pack binary version ${inputVersion}`);
        }
        if (view.getUint16(6, true) !== 0) fail('unsupported-flags', 'Campaign pack uses unknown mandatory flags');
        const metadataLength = view.getUint32(8, true);
        const sectionCount = view.getUint32(12, true);
        const sectionStart = view.getUint32(16, true);
        const totalBytes = view.getUint32(20, true);
        if (metadataLength > MAX_METADATA_BYTES || sectionCount > MAX_SECTION_COUNT || input.byteLength > maxBytes) {
            fail('decoder-limit', 'Campaign pack exceeds decoder safety limits');
        }
        if (totalBytes !== input.byteLength) fail('byte-length-mismatch', 'Campaign pack byte length is invalid');
        const metadataEnd = HEADER_BYTES + metadataLength;
        if (metadataEnd > input.byteLength || sectionStart !== align(metadataEnd)) {
            fail('invalid-directory-offset', 'Campaign pack directory offset is invalid');
        }
        let directoryValue;
        try {
            directoryValue = JSON.parse(new TextDecoder().decode(input.subarray(HEADER_BYTES, metadataEnd)));
        } catch (error) {
            fail('invalid-directory-json', 'Campaign pack directory JSON is invalid', error?.message);
        }
        const sections = sectionTable(directoryValue, input, sectionStart, sectionCount);
        return validate(decodeDirectoryValue(directoryValue, sections));
    }

    return Object.freeze({ encode, encodeBlob, decode });
}
