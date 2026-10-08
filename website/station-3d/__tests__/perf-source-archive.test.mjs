import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { importPerfSourceArchive, openPerfSourceArchive, sourceKey } from '../../../tools/lib/perf-source-archive.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'station3d-perf-source-'));
const cacheRule = [{ pathnamePattern: '^/api/facade$', dropQueryParameters: ['t'] }];

test('source keys ignore origin while preserving exact spatial query and repeated parameter order', () => {
    const a = 'https://baseline.test/api/roads?bbox=1%2C2%2C3%2C4&tag=a&tag=b';
    const b = 'http://candidate.test/api/roads?bbox=1%2C2%2C3%2C4&tag=a&tag=b';
    assert.equal(sourceKey(a), '/api/roads?bbox=1%2C2%2C3%2C4&tag=a&tag=b');
    assert.equal(sourceKey(a), sourceKey(b));
    assert.notEqual(sourceKey(a), sourceKey(a.replace('bbox=1%2C2%2C3%2C4', 'bbox=1.0001%2C2%2C3%2C4')));
    assert.notEqual(sourceKey(a), sourceKey('https://baseline.test/api/roads?tag=a&bbox=1%2C2%2C3%2C4&tag=b'));
});

test('declared query removal drops only matching names and retains other query order', () => {
    assert.equal(sourceKey('https://a.test/api/facade?tile=3&t=1&tag=a&t=2&tag=b', cacheRule),
        '/api/facade?tile=3&tag=a&tag=b');
    assert.equal(sourceKey('https://a.test/api/roads?t=1&bbox=1,2,3,4', cacheRule),
        '/api/roads?t=1&bbox=1,2,3,4');
});

test('record, save, replay and seal preserve immutable source identities', t => {
    const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'archive'), body = Buffer.from('source bytes');
    const archive = openPerfSourceArchive(dir, { mode: 'record' });
    assert.equal(archive.sealed, false);
    assert.equal(archive.size, 0);
    const entry = archive.record('https://base.test/api/tile?bbox=0,0,1,1', body, 'application/json', 200);
    assert.equal(entry.hash, digest(body));
    assert.equal(archive.lookup('http://candidate.test/api/tile?bbox=0,0,1,1').entry.key,
        '/api/tile?bbox=0,0,1,1');
    assert.throws(() => archive.record('https://other.test/api/tile?bbox=0,0,1,1', Buffer.from('changed'), 'application/json'),
        /immutable key/);
    archive.save();
    const hashBeforeSeal = archive.hash();
    assert.equal(archive.seal(), hashBeforeSeal);
    assert.equal(archive.sealed, true);
    assert.throws(() => archive.record('/api/new', Buffer.from('x'), 'text/plain'), /sealed/);
    assert.throws(() => archive.save(), /sealed/);

    const replay = openPerfSourceArchive(dir);
    assert.equal(replay.sealed, true);
    assert.equal(replay.hash(), hashBeforeSeal);
    assert.equal(fs.readFileSync(replay.lookup('/api/tile?bbox=0,0,1,1').bodyPath, 'utf8'), 'source bytes');
    assert.throws(() => replay.record('/api/new', Buffer.from('x'), 'text/plain'), /replay mode/);
    assert.equal(replay.seal(), hashBeforeSeal);
});

test('an empty archive cannot be sealed and replay mode never persists writes', t => {
    const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'archive');
    const archive = openPerfSourceArchive(dir, { mode: 'record' });
    assert.throws(() => archive.seal(), /empty/);
    const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    const replay = openPerfSourceArchive(dir, { mode: 'replay' });
    assert.equal(replay.sealed, false);
    assert.throws(() => replay.save(), /replay mode/);
    assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before);
});

test('a sealed v1 archive with no source entries is invalid', t => {
    const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'archive');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        schema: 'station3d-perf-source-archive-v1', sealed: true,
        rules: [], allowedResponses: [], entries: [],
    }));
    assert.throws(() => openPerfSourceArchive(dir), /Sealed source archive must not be empty/);
});

test('same-origin-independent key accepts identical content and rejects changed response metadata', t => {
    const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const archive = openPerfSourceArchive(path.join(root, 'archive'), { mode: 'record' });
    const body = Buffer.from('body');
    archive.record('https://base.test/a?x=1', body, 'text/plain', 200);
    assert.deepEqual(archive.record('http://candidate.test/a?x=1', body, 'text/plain', 200), {
        key: '/a?x=1', hash: digest(body), bytes: 4, status: 200, contentType: 'text/plain',
    });
    assert.throws(() => archive.record('https://base.test/a?x=1', body, 'application/json', 200), /immutable key/);
    assert.throws(() => archive.record('https://base.test/a?x=1', body, 'text/plain', 201), /immutable key/);
});

test('response status exceptions are explicit and survive reopening', t => {
    const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'archive');
    const allowedResponses = [{ pathnamePattern: '^/api/optional/\\d+$', statuses: [404] }];
    const archive = openPerfSourceArchive(dir, { mode: 'record', allowedResponses });
    archive.record('/api/optional/17', Buffer.from('missing'), 'text/plain', 404);
    assert.throws(() => archive.record('/api/other', Buffer.from('bad'), 'text/plain', 404), /Disallowed/);
    assert.throws(() => archive.record('/api/optional/18', Buffer.from('server error'), 'text/plain', 500), /Disallowed/);
    archive.seal();
    assert.equal(openPerfSourceArchive(dir, { allowedResponses }).lookup('/api/optional/17').entry.status, 404);
    assert.throws(() => openPerfSourceArchive(dir, { allowedResponses: [] }), /do not match/);
});

test('archive rules are part of identity and explicit mismatches are rejected', t => {
    const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'archive');
    const archive = openPerfSourceArchive(dir, { mode: 'record', rules: cacheRule });
    archive.record('/api/facade?id=3&t=100', Buffer.from('x'), 'application/json');
    const ruleHash = archive.hash();
    assert.equal(archive.lookup('/api/facade?id=3&t=200').entry.key, '/api/facade?id=3');
    const plain = openPerfSourceArchive(path.join(root, 'plain'), { mode: 'record' });
    plain.record('/api/facade?id=3', Buffer.from('x'), 'application/json');
    assert.notEqual(ruleHash, plain.hash());
    assert.throws(() => openPerfSourceArchive(dir, { mode: 'replay', rules: [] }), /do not match/);
});

test('corrupt and path-traversing blob references are rejected during load', t => {
    const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'archive');
    const archive = openPerfSourceArchive(dir, { mode: 'record' });
    const entry = archive.record('/api/data', Buffer.from('valid'), 'application/octet-stream');
    archive.save();
    fs.writeFileSync(path.join(dir, entry.hash), 'corrupt');
    assert.throws(() => openPerfSourceArchive(dir), /Corrupt source blob/);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.entries[0].hash = '../outside';
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    assert.throws(() => openPerfSourceArchive(dir), /Invalid source archive entry/);
});

test('import verifies legacy v2 data, deduplicates bodies, and copies blobs into an unsealed v1 archive', t => {
    const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'legacy'), target = path.join(root, 'imported');
    fs.mkdirSync(source);
    const body = Buffer.from('shared body'), hash = digest(body);
    fs.writeFileSync(path.join(source, hash), body);
    const manifest = {
        schema: 'station3d-audit-source-fixtures-v2', complete: true,
        entries: [
            { url: 'https://base.test/api/a?bbox=1,2,3,4', hash, bytes: body.length, status: 200, contentType: 'application/json' },
            { url: 'http://other.test/api/a?bbox=1,2,3,4', hash, bytes: body.length, status: 200, contentType: 'application/json' },
            { url: 'https://base.test/api/b', hash, bytes: body.length, status: 200, contentType: 'application/json' },
        ],
    };
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest));
    importPerfSourceArchive(source, target);
    const imported = openPerfSourceArchive(target);
    assert.equal(imported.size, 2);
    assert.equal(imported.sealed, false);
    assert.equal(fs.readdirSync(target).filter(name => /^[a-f0-9]{64}$/.test(name)).length, 1);
    assert.notEqual(fs.statSync(path.join(source, hash)).ino, fs.statSync(path.join(target, hash)).ino);
    assert.equal(fs.readFileSync(imported.lookup('/api/a?bbox=1,2,3,4').bodyPath, 'utf8'), 'shared body');
});

test('legacy import rejects origin-independent collisions with different bodies before creating target', t => {
    const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'legacy'), target = path.join(root, 'imported');
    fs.mkdirSync(source);
    const one = Buffer.from('one'), two = Buffer.from('two'), h1 = digest(one), h2 = digest(two);
    fs.writeFileSync(path.join(source, h1), one);
    fs.writeFileSync(path.join(source, h2), two);
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
        schema: 'station3d-audit-source-fixtures-v2', complete: true,
        entries: [
            { url: 'https://base.test/api/a?x=1', hash: h1, bytes: one.length, status: 200, contentType: 'text/plain' },
            { url: 'http://candidate.test/api/a?x=1', hash: h2, bytes: two.length, status: 200, contentType: 'text/plain' },
        ],
    }));
    assert.throws(() => importPerfSourceArchive(source, target), /Conflicting origin-independent/);
    assert.equal(fs.existsSync(target), false);
});

test('import rejects a non-empty target and legacy archives with invalid blob hashes', t => {
    const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'legacy'), target = path.join(root, 'non-empty');
    fs.mkdirSync(source); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'x');
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ schema: 'station3d-audit-source-fixtures-v2', complete: true, entries: [] }));
    assert.throws(() => importPerfSourceArchive(source, target), /absent or empty/);

    const invalid = path.join(root, 'invalid'); fs.mkdirSync(invalid);
    fs.writeFileSync(path.join(invalid, 'manifest.json'), JSON.stringify({ schema: 'station3d-audit-source-fixtures-v2', complete: true,
        entries: [{ url: 'https://x.test/a', hash: '../../bad', bytes: 1, status: 200, contentType: 'text/plain' }] }));
    assert.throws(() => importPerfSourceArchive(invalid, path.join(root, 'bad-target')), /Invalid legacy source entry/);
});
