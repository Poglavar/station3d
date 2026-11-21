// Shared envelope must preserve ordinary metadata without prototype or descriptor ambiguity.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTypedArrayEnvelopeCodec } from '../core/typed-array-envelope.js';

const codec = createTypedArrayEnvelopeCodec({ magic: 'TEST', version: 1, validate: value => value });

test('prototype-shaped JSON keys survive as ordinary own data', () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"value":2},"nested":{"__proto__":3}}');
    const decoded = codec.decode(codec.encode(source));
    assert.deepEqual(decoded, source);
    assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
    assert.equal(Object.getPrototypeOf(decoded.nested), Object.prototype);
    assert.equal({}.polluted, undefined);
});

test('ordinary metadata cannot impersonate a binary section descriptor', () => {
    for (const marker of ['typed-array', 'array-buffer']) {
        assert.throws(() => codec.encode({ nested: { $s3l: marker, section: 0, byteLength: 0, type: 'Uint8Array', length: 0 } }),
            error => error.code === 'reserved-descriptor');
    }
});
