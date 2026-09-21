// Serves the standalone demo and a tiny deterministic provider fixture without caching.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portIndex = process.argv.indexOf('--port');
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: npm run demo:serve -- [--port 4173]');
    process.exit(0);
}
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port');
const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.wasm': 'application/wasm',
    '.wav': 'audio/wav',
};

function sendJson(response, value) {
    response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    });
    response.end(JSON.stringify(value));
}

const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/demo-api/')) {
        if (url.pathname.endsWith('/catchment-stats')) {
            sendJson(response, { catchment_population: 0, catchment_jobs: 0 });
        } else {
            sendJson(response, { type: 'FeatureCollection', features: [] });
        }
        return;
    }
    const requested = url.pathname === '/'
        ? '/demo/index.html'
        : (url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname);
    const path = resolve(repoRoot, `.${requested}`);
    if (!path.startsWith(`${repoRoot}/`) || !existsSync(path) || !statSync(path).isFile()) {
        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end('Not found');
        return;
    }
    response.writeHead(200, {
        'Content-Type': types[extname(path)] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    });
    createReadStream(path).pipe(response);
});
server.listen(port, '127.0.0.1', () => {
    console.log(`[demo] http://localhost:${port}/demo/`);
});
