import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODEL_CATALOG } from '../viewers/model-catalog.js';
import { studyCatalog } from '../viewers/model-studies.js';
import { generateModelCode, namedModel, validateModelCodes } from '../viewers/model-names.js';

const manifest = JSON.parse(readFileSync(new URL('../models/viewer-studies.json', import.meta.url)));
const entries = [...MODEL_CATALOG, ...studyCatalog(manifest, null, 'http://localhost/')];

test('every library model has a unique stored code and separates tool provenance from its name', () => {
    validateModelCodes(entries);
    const named = entries.map(entry => namedModel(entry));
    assert.equal(new Set(named.map(entry => entry.code)).size, entries.length);
    for (const entry of named) {
        assert.ok(!/blender/i.test(entry.label), entry.id);
        assert.ok(entry.label.endsWith(' ' + entry.code));
    }
    const sedans = named.filter(entry => /\bSedan\b/i.test(entry.name));
    assert.equal(sedans.length, 2);
    assert.equal(new Set(sedans.map(entry => entry.label)).size, 2);
    assert.equal(named.find(entry => entry.id === 'study-fleet-lineup').provenance, 'Blender');
});

test('renaming and reordering models preserves their identity codes', () => {
    const original = namedModel(entries[0]);
    const renamed = namedModel({ ...entries[0], label: 'A different name' });
    assert.equal(renamed.code, original.code);
    assert.equal(renamed.label, 'A different name ' + original.code);
    assert.deepEqual(entries.map(entry => namedModel(entry).code), [...entries].reverse().map(entry => namedModel(entry).code).reverse());
});

test('rail vehicle classes remain searchable labels', () => {
    for (const id of ['tmk-2400-old', 'tmk-2400-new', 'hz-7022']) {
        const entry = entries.find(item => item.id === id);
        assert.match(entry.label.toLowerCase(), id === 'hz-7022' ? /train/ : /tram/);
    }
});

test('native road vehicle labels include their searchable class words', () => {
    const expected = {
        suv: /suv.*car/i,
        sedan: /sedan.*car/i,
        technical: /pickup.*truck/i,
        truck: /truck/i,
        bus: /bus/i,
        bicycle: /bicycle/i,
    };
    for (const [type, pattern] of Object.entries(expected)) {
        const entry = entries.find(item => item.id === `road-${type}`);
        assert.ok(entry, type);
        assert.match(entry.label, pattern, type);
    }
    assert.match(entries.find(entry => entry.id === 'boat-leut').label, /boat/i);
});

test('new code generation retries collisions and validation rejects duplicate or unregistered codes', () => {
    let attempt = 0;
    const code = generateModelCode(new Set(['2222']), bytes => bytes.fill(attempt++));
    assert.equal(code, '3333');
    assert.equal(attempt, 2);
    assert.throws(() => validateModelCodes([], { a: 'ABCD', b: 'ABCD' }), /Duplicate model code/);
    assert.throws(() => validateModelCodes([{ id: 'new' }], {}), /Missing model code/);
    assert.throws(() => validateModelCodes([], { a: 'a1' }), /Invalid model code/);
});
