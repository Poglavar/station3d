import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

import { fingerprintDirectory, startPerfReplayServer, resolvePublicFile, hasPerfReplayFailure } from '../../../tools/lib/perf-replay-server.mjs';
import { openPerfSourceArchive } from '../../../tools/lib/perf-source-archive.mjs';

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'station3d-perf-replay-'));

test('an archive read stays pending until verified, while settled misses and corrupt reads fail', () => {
    const row = { hash: null, outcome: 'pending', error: null };
    assert.equal(hasPerfReplayFailure([row]), false);
    row.hash = 'verified-hash'; row.outcome = 'replayed';
    assert.equal(hasPerfReplayFailure([row]), false);
    assert.equal(hasPerfReplayFailure([{ hash: null, outcome: 'miss', error: 'missing' }]), true);
    assert.equal(hasPerfReplayFailure([{ hash: null, outcome: 'failed', error: 'corrupt' }]), true);
});

async function startProvider(handler) {
    const server = createServer(handler);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        origin: `http://127.0.0.1:${server.address().port}`,
        close: async () => {
            server.closeAllConnections();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}

test('serves host and engine files from their separate public roots with no-store headers', async t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hostRoot = path.join(root, 'host'), engineDist = path.join(root, 'engine');
    fs.mkdirSync(hostRoot); fs.mkdirSync(engineDist);
    fs.writeFileSync(path.join(hostRoot, 'index.html'), '<main>host</main>');
    fs.writeFileSync(path.join(engineDist, 'loader.js'), 'globalThis.engine = true;');
    const archive = openPerfSourceArchive(path.join(root, 'archive'), { mode: 'record' });
    archive.record('/api/ping', Buffer.from('pong'), 'text/plain');
    archive.seal();
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive });
    t.after(() => replay.close());

    const host = await fetch(`${replay.origin}/index.html`);
    assert.equal(host.status, 200);
    assert.equal(await host.text(), '<main>host</main>');
    assert.match(host.headers.get('cache-control'), /no-store/);
    const engine = await fetch(`${replay.origin}/vendor/station3d/loader.js`);
    assert.equal(engine.status, 200);
    assert.equal(engine.headers.get('content-type'), 'text/javascript');
    assert.equal(await engine.text(), 'globalThis.engine = true;');
    assert.equal(replay.served.size, 2);
    assert.deepEqual([...replay.served.keys()].sort(), ['engine/loader.js', 'host/index.html']);

    const api = await fetch(`${replay.origin}/api/ping`);
    assert.equal(await api.text(), 'pong');
    assert.match(api.headers.get('cache-control'), /no-store/);
});

test('private and traversal paths cannot resolve from a public root', () => {
    const root = tempRoot();
    try {
        assert.throws(() => resolvePublicFile(root, '/.env'), /Private/);
        assert.throws(() => resolvePublicFile(root, '/%2e%2e/secret'), /Private|escapes/);
        assert.throws(() => resolvePublicFile(root, '/nested/.hidden'), /Private/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('replay refuses a source blob changed after the archive was opened', async t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hostRoot = path.join(root, 'host'), engineDist = path.join(root, 'engine');
    fs.mkdirSync(hostRoot); fs.mkdirSync(engineDist);
    const archiveDir = path.join(root, 'archive');
    const recording = openPerfSourceArchive(archiveDir, { mode: 'record' });
    recording.record('/api/ping', Buffer.from('pong'), 'text/plain');
    recording.seal();
    const archive = openPerfSourceArchive(archiveDir);
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive });
    t.after(() => replay.close());
    fs.writeFileSync(archive.lookup('/api/ping').bodyPath, 'oops');

    const response = await fetch(`${replay.origin}/api/ping`);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /Corrupt source blob/);
    assert.equal(response.headers.get('x-source-sha256'), null);
    assert.equal(replay.requests[0].hash, null);
    assert.equal(replay.requests[0].outcome, 'failed');
    assert.match(replay.errors[0].message, /Corrupt source blob/);
});

test('HTTP replay does not mark a response replayed before its body has been read', async t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hostRoot = path.join(root, 'host'), engineDist = path.join(root, 'engine');
    fs.mkdirSync(hostRoot); fs.mkdirSync(engineDist);
    const archive = openPerfSourceArchive(path.join(root, 'archive'), { mode: 'record' });
    archive.record('/api/ping', Buffer.from('pong'), 'text/plain'); archive.seal();
    const source = archive.lookup('/api/ping');
    let beforeRead;
    const inspectedArchive = { sealed: true, lookup: () => ({ entry: source.entry,
        get bodyPath() {
            beforeRead = { ...replay.requests[0] };
            return source.bodyPath;
        } }) };
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive: inspectedArchive });
    t.after(() => replay.close());
    const response = await fetch(`${replay.origin}/api/ping`);
    assert.equal(await response.text(), 'pong');
    assert.equal(beforeRead.outcome, 'pending');
    assert.equal(beforeRead.hash, null);
    assert.equal(hasPerfReplayFailure([beforeRead]), false);
    assert.equal(replay.requests[0].outcome, 'replayed');
    assert.equal(replay.requests[0].hash, source.entry.hash);
});

test('fingerprints media and refuses a file changed after startup before its first request', async t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hostRoot = path.join(root, 'host'), engineDist = path.join(root, 'engine');
    fs.mkdirSync(hostRoot); fs.mkdirSync(engineDist);
    fs.writeFileSync(path.join(hostRoot, 'tile.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(hostRoot, 'vendor-note.txt'), 'host file');
    fs.mkdirSync(path.join(hostRoot, 'vendor', 'station3d'), { recursive: true });
    fs.writeFileSync(path.join(hostRoot, 'vendor', 'station3d', 'loader.js'), 'engine mount');
    const initialHost = await fingerprintDirectory(hostRoot, { exclude: ['vendor/station3d'] });
    assert.deepEqual(initialHost.entries.map(entry => entry.file), ['tile.png', 'vendor-note.txt']);
    fs.writeFileSync(path.join(hostRoot, 'tile.png'), Buffer.from([4, 5, 6]));
    const archive = openPerfSourceArchive(path.join(root, 'archive'), { mode: 'record' });
    archive.record('/api/ping', Buffer.from('pong'), 'text/plain'); archive.seal();
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive,
        fingerprints: { host: initialHost, engine: await fingerprintDirectory(engineDist) } });
    t.after(() => replay.close());

    const response = await fetch(`${replay.origin}/tile.png`);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /differs from startup fingerprint/);
    assert.equal(replay.served.size, 0);
    assert.equal(replay.errors[0].message, 'Served file differs from startup fingerprint: host/tile.png');
});

test('refuses a symlinked host file that resolves outside the public root', async t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hostRoot = path.join(root, 'host'), engineDist = path.join(root, 'engine');
    fs.mkdirSync(hostRoot); fs.mkdirSync(engineDist);
    const secret = path.join(root, 'outside.txt');
    fs.writeFileSync(secret, 'private bytes');
    fs.symlinkSync(secret, path.join(hostRoot, 'shared.txt'));
    const archive = openPerfSourceArchive(path.join(root, 'archive'), { mode: 'record' });
    archive.record('/api/ping', Buffer.from('pong'), 'text/plain'); archive.seal();
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive });
    t.after(() => replay.close());

    const response = await fetch(`${replay.origin}/shared.txt`);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /Symlink path is not public/);
    assert.equal(replay.served.size, 0);
});

test('sealed replay logs a missing frozen URL and returns 502 without contacting a provider', async t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hostRoot = path.join(root, 'host'), engineDist = path.join(root, 'engine');
    fs.mkdirSync(hostRoot); fs.mkdirSync(engineDist);
    const archive = openPerfSourceArchive(path.join(root, 'archive'), { mode: 'record' });
    archive.record('/api/known', Buffer.from('known'), 'text/plain'); archive.seal();
    let providerHits = 0;
    const provider = await startProvider((_req, res) => { providerHits++; res.end('upstream'); });
    t.after(() => provider.close());
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive, providerBaseUrl: provider.origin });
    t.after(() => replay.close());

    const response = await fetch(`${replay.origin}/api/missing?x=1`);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /Missing frozen source/);
    assert.equal(providerHits, 0);
    assert.equal(replay.errors.length, 1);
    assert.equal(replay.errors[0].url, '/api/missing?x=1');
    assert.equal(replay.errors[0].status, 502);
});

test('non-GET provider requests fail without changing the sealed archive or reaching upstream', async t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hostRoot = path.join(root, 'host'), engineDist = path.join(root, 'engine');
    fs.mkdirSync(hostRoot); fs.mkdirSync(engineDist);
    const archiveDir = path.join(root, 'archive');
    const archive = openPerfSourceArchive(archiveDir, { mode: 'record' });
    archive.record('/api/known', Buffer.from('known'), 'text/plain'); archive.seal();
    const manifestBefore = fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8');
    let providerHits = 0;
    const provider = await startProvider((_req, res) => { providerHits++; res.end('upstream'); });
    t.after(() => provider.close());
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive, providerBaseUrl: provider.origin });
    t.after(() => replay.close());

    const response = await fetch(`${replay.origin}/api/new`, { method: 'POST', body: 'mutation' });
    assert.equal(response.status, 502);
    assert.match(await response.text(), /Unexpected provider method: POST/);
    assert.equal(providerHits, 0);
    assert.equal(archive.size, 1);
    assert.equal(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'), manifestBefore);
    assert.equal(replay.errors.length, 1);
});

test('recording coalesces concurrent GETs, persists the response, then replays identical bytes', async t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hostRoot = path.join(root, 'host'), engineDist = path.join(root, 'engine');
    fs.mkdirSync(hostRoot); fs.mkdirSync(engineDist);
    const archiveDir = path.join(root, 'archive');
    const archive = openPerfSourceArchive(archiveDir, { mode: 'record' });
    let providerHits = 0;
    const body = Buffer.from('deterministic provider bytes');
    let releaseProvider;
    const gate = new Promise(resolve => { releaseProvider = resolve; });
    const provider = await startProvider(async (req, res) => {
        providerHits++;
        assert.equal(req.url, '/api/asset?tile=3&x=4');
        await gate;
        res.writeHead(206, { 'Content-Type': 'application/octet-stream' });
        res.end(body);
    });
    t.after(() => provider.close());
    const recording = await startPerfReplayServer({ hostRoot, engineDist, archive,
        providerBaseUrl: `${provider.origin}/api`, recording: true });
    t.after(() => recording.close());

    const url = `${recording.origin}/api/asset?tile=3&x=4`;
    const first = fetch(url), second = fetch(url);
    while (providerHits === 0) await new Promise(resolve => setTimeout(resolve, 1));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(providerHits, 1);
    releaseProvider();
    const responses = await Promise.all([first, second]);
    const recorded = await Promise.all(responses.map(async response => ({
        status: response.status, type: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()),
    })));
    for (const response of recorded) {
        assert.equal(response.status, 206);
        assert.equal(response.type, 'application/octet-stream');
        assert.deepEqual(response.bytes, body);
    }
    assert.equal(archive.size, 1);
    assert.equal(archive.sealed, false);
    assert.equal(archive.lookup('/api/asset?tile=3&x=4').entry.status, 206);

    archive.seal();
    const reopened = openPerfSourceArchive(archiveDir);
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive: reopened });
    t.after(() => replay.close());
    const replayed = await fetch(url.replace(recording.origin, replay.origin));
    assert.equal(replayed.status, 206);
    assert.equal(replayed.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await replayed.arrayBuffer()), body);
    assert.equal(providerHits, 1);
});

test('recording retains exact failed-fetch and disallowed-status attempts', async t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hostRoot = path.join(root, 'host'), engineDist = path.join(root, 'engine');
    fs.mkdirSync(hostRoot); fs.mkdirSync(engineDist);
    const archive = openPerfSourceArchive(path.join(root, 'archive'), { mode: 'record' });
    const provider = await startProvider((req, res) => {
        if (req.url === '/api/disallowed?bbox=1,2,3,4') {
            res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('provider failure');
        } else if (req.url === '/api/network?bbox=5,6,7,8') res.destroy();
        else { res.writeHead(404); res.end('unexpected route'); }
    });
    t.after(() => provider.close());
    const recording = await startPerfReplayServer({ hostRoot, engineDist, archive,
        providerBaseUrl: `${provider.origin}/api`, recording: true });
    t.after(() => recording.close());

    const failed = await fetch(`${recording.origin}/api/disallowed?bbox=1,2,3,4`);
    assert.equal(failed.status, 502);
    const network = await fetch(`${recording.origin}/api/network?bbox=5,6,7,8`);
    assert.equal(network.status, 502);
    assert.deepEqual(recording.requests.map(row => row.key), [
        '/api/disallowed?bbox=1,2,3,4', '/api/network?bbox=5,6,7,8',
    ]);
    assert.equal(recording.requests[0].outcome, 'failed');
    assert.equal(recording.requests[0].providerStatus, 500);
    assert.match(recording.requests[0].error, /Disallowed source response 500/);
    assert.equal(recording.requests[1].outcome, 'failed');
    assert.equal(recording.requests[1].providerStatus, null);
    assert.match(recording.requests[1].error, /fetch failed/i);
    assert.equal(recording.requests[0].hash, null);
    assert.equal(recording.requests[1].hash, null);
    assert.equal(archive.size, 0);
});

test('captures and replays allowlisted external URLs by exact origin, path and query', async t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hostRoot = path.join(root, 'host'), engineDist = path.join(root, 'engine');
    fs.mkdirSync(hostRoot); fs.mkdirSync(engineDist);
    const archiveDir = path.join(root, 'archive');
    const archive = openPerfSourceArchive(archiveDir, { mode: 'record' });
    const body = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);
    let providerHits = 0;
    const provider = await startProvider((req, res) => {
        providerHits++;
        assert.equal(req.url, '/15/5234/11234.png?scale=2&bbox=1%2C2%2C3%2C4');
        res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(body);
    });
    t.after(() => provider.close());
    const originalUrl = `${provider.origin}/15/5234/11234.png?scale=2&bbox=1%2C2%2C3%2C4`;
    const endpoint = origin => `${origin}/api/__external?url=${encodeURIComponent(originalUrl)}`;
    const recording = await startPerfReplayServer({ hostRoot, engineDist, archive,
        recording: true, externalOrigins: [provider.origin] });
    t.after(() => recording.close());

    const captured = await fetch(endpoint(recording.origin));
    assert.equal(captured.status, 200);
    assert.equal(captured.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await captured.arrayBuffer()), body);
    assert.equal(providerHits, 1);
    assert.equal(recording.requests[0].key, originalUrl);
    assert.match(recording.requests[0].archiveKey, /url=http%3A%2F%2F127\.0\.0\.1%3A\d+%2F15%2F5234%2F11234\.png%3Fscale%3D2%26bbox%3D1%252C2%252C3%252C4/);

    archive.seal();
    const reopened = openPerfSourceArchive(archiveDir);
    const replay = await startPerfReplayServer({ hostRoot, engineDist, archive: reopened,
        externalOrigins: [provider.origin] });
    t.after(() => replay.close());
    const replayed = await fetch(endpoint(replay.origin));
    assert.equal(replayed.status, 200);
    assert.equal(replayed.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await replayed.arrayBuffer()), body);
    assert.equal(replay.requests[0].key, originalUrl);
    assert.equal(replay.requests[0].outcome, 'replayed');
    assert.equal(providerHits, 1);
});

test('rejects external origins outside the explicit allowlist before fetching', async t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hostRoot = path.join(root, 'host'), engineDist = path.join(root, 'engine');
    fs.mkdirSync(hostRoot); fs.mkdirSync(engineDist);
    let deniedHits = 0;
    const allowedProvider = await startProvider((_req, res) => res.end('allowed'));
    const deniedProvider = await startProvider((_req, res) => { deniedHits++; res.end('denied'); });
    t.after(() => allowedProvider.close());
    t.after(() => deniedProvider.close());
    const archive = openPerfSourceArchive(path.join(root, 'archive'), { mode: 'record' });
    const recording = await startPerfReplayServer({ hostRoot, engineDist, archive,
        recording: true, externalOrigins: [allowedProvider.origin] });
    t.after(() => recording.close());
    const target = `${deniedProvider.origin}/tile.png?z=15&x=123`;
    const response = await fetch(`${recording.origin}/api/__external?url=${encodeURIComponent(target)}`);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /External origin is not allowed/);
    assert.equal(deniedHits, 0);
    assert.equal(recording.requests[0].key, target);
    assert.equal(recording.requests[0].outcome, 'failed');
    assert.match(recording.requests[0].error, /External origin is not allowed/);
    assert.equal(archive.size, 0);
});
