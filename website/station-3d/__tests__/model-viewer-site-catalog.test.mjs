// A site can add its own models to the shared viewer: the page names a module (<meta name="station3d-model-catalog">)
// whose MODEL_CATALOG and MODEL_CODES siteModelEntries checks against the engine's before the viewer lists them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteModelEntries } from '../viewers/model-names.js';

const engineEntries = [{ id: 'sedan', label: 'Sedan' }];
const engineCodes = { sedan: 'TSDM', 'actor-kept': 'K33P' };
const model = id => ({ id, label: `Model ${id}`, category: 'people', create: async () => ({}) });

test('a site model is named with its own permanent code', () => {
    const [entry] = siteModelEntries({ MODEL_CATALOG: [model('statue')], MODEL_CODES: { statue: 'ST4T' } },
        { engineEntries, engineCodes });
    assert.equal(entry.code, 'ST4T');
    assert.equal(entry.label, 'Model statue ST4T');
    assert.equal(entry.name, 'Model statue');
});

test('a code the engine still lists for the same id stays the site model\'s', () => {
    const [entry] = siteModelEntries({ MODEL_CATALOG: [model('actor-kept')], MODEL_CODES: { 'actor-kept': 'K33P' } },
        { engineEntries, engineCodes });
    assert.equal(entry.code, 'K33P');
});

test('a site model cannot take an engine id or another model\'s code, and needs a code and a factory', () => {
    const check = (site, pattern) => assert.throws(() => siteModelEntries(site, { engineEntries, engineCodes }), pattern);
    check({ MODEL_CATALOG: [model('sedan')], MODEL_CODES: { sedan: 'TSDM' } }, /id of an engine model/);
    check({ MODEL_CATALOG: [model('statue')], MODEL_CODES: { statue: 'TSDM' } }, /code TSDM of sedan/);
    check({ MODEL_CATALOG: [model('statue')], MODEL_CODES: {} }, /Missing model code: statue/);
    check({ MODEL_CATALOG: [model('statue')], MODEL_CODES: { statue: 'O0I1' } }, /Invalid model code/);
    check({ MODEL_CATALOG: [{ ...model('statue'), create: null }], MODEL_CODES: { statue: 'ST4T' } }, /no create/);
    check({ MODEL_CATALOG: model('statue'), MODEL_CODES: { statue: 'ST4T' } }, /exports MODEL_CATALOG/);
});

test('the viewer loads the module its page names, after the engine catalog and before the first model opens', () => {
    const viewer = readFileSync(new URL('../viewers/model-viewer.js', import.meta.url), 'utf8');
    const load = viewer.indexOf('meta[name="station3d-model-catalog"]');
    assert.ok(load > 0, 'the viewer reads the page\'s meta');
    assert.match(viewer.slice(load), /siteModelEntries\(site, \{ engineEntries: catalog \}\)/);
    assert.ok(load < viewer.indexOf('await openEntry(initial.model'), 'a link to a site model opens it');
});
