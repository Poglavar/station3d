// Builds and decodes requests to the shared DGU terrain-grid API so browser
// sessions and offline asset builders consume exactly the same grid contract.

function finiteCoordinate(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`terrain grid request: invalid ${label}`);
    return number;
}

export function terrainGridApiUrl(apiBase, {
    bbox,
    resolutionDeg,
    source,
    cacheTile = false,
}) {
    if (!Array.isArray(bbox) || bbox.length !== 4) {
        throw new Error('terrain grid request requires a four-value bbox');
    }
    const bounds = bbox.map((value, index) => finiteCoordinate(value, `bbox[${index}]`));
    if (!(bounds[2] > bounds[0]) || !(bounds[3] > bounds[1])) {
        throw new Error('terrain grid request requires ordered bounds');
    }
    const resolution = finiteCoordinate(resolutionDeg, 'resolutionDeg');
    if (!(resolution > 0)) throw new Error('terrain grid request requires positive resolution');
    const base = String(apiBase || '').replace(/\/+$/, '');
    if (!base) throw new Error('terrain grid request requires an API base URL');
    const bboxValue = bounds.map((value) => value.toFixed(6)).join(',');
    let url = `${base}/terrain/grid?bbox=${bboxValue}&res=${resolution}`;
    if (source != null && String(source).trim() !== '') {
        const sourceKey = String(source).trim();
        if (!/^[a-z0-9-]+$/.test(sourceKey)) {
            throw new Error('terrain grid request requires a valid source key');
        }
        url += `&source=${encodeURIComponent(sourceKey)}`;
    }
    if (cacheTile) url += '&tile=1';
    return url;
}

const DEFAULT_BASE64_CHUNK_CHARS = 256 * 1024;

function decodeBase64Buffer(value, label) {
    if (typeof value !== 'string') throw new Error(`terrain grid: missing ${label}`);
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
}

function decodedBase64ByteLength(value, label) {
    if (typeof value !== 'string') throw new Error(`terrain grid: missing ${label}`);
    if (value.length === 0 || value.length % 4 !== 0) {
        throw new Error(`terrain grid: invalid ${label}`);
    }
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    return (value.length / 4) * 3 - padding;
}

function* decodeBase64BufferSteps(value, label, {
    chunkChars = DEFAULT_BASE64_CHUNK_CHARS,
} = {}) {
    const byteLength = decodedBase64ByteLength(value, label);
    const bytes = new Uint8Array(byteLength);
    const requestedChunkChars = Math.max(4, Math.floor(Number(chunkChars) || 0));
    const boundedChunkChars = requestedChunkChars - (requestedChunkChars % 4);
    let sourceOffset = 0;
    let byteOffset = 0;
    while (sourceOffset < value.length) {
        const end = Math.min(value.length, sourceOffset + boundedChunkChars);
        const binary = globalThis.atob(value.slice(sourceOffset, end));
        for (let index = 0; index < binary.length; index++) {
            bytes[byteOffset + index] = binary.charCodeAt(index);
        }
        sourceOffset = end;
        byteOffset += binary.length;
        if (sourceOffset < value.length) {
            yield {
                phase: `decode-${label}`,
                decodedBytes: byteOffset,
                totalBytes: byteLength,
            };
        }
    }
    if (byteOffset !== byteLength) throw new Error(`terrain grid: invalid ${label}`);
    return bytes.buffer;
}

// Large moving detail windows contain several megabytes of height and source
// base64. Decoding both strings in the fetch Promise used to monopolize one
// microtask before the next frame could begin. The iterator produces the exact
// same buffers while giving a scheduler a bounded checkpoint between chunks.
export function* decodeTerrainGridApiPayloadSteps(payload, options = {}) {
    if (!payload || typeof payload.dataBase64 !== 'string') {
        throw new Error('terrain grid: missing data');
    }
    const data = decodeBase64BufferSteps(payload.dataBase64, 'data', options);
    let dataStep = data.next();
    while (!dataStep.done) {
        yield dataStep.value;
        dataStep = data.next();
    }
    let sourceArrayBuffer = null;
    if (typeof payload.sourceDataBase64 === 'string') {
        const source = decodeBase64BufferSteps(
            payload.sourceDataBase64,
            'source data',
            options,
        );
        let sourceStep = source.next();
        while (!sourceStep.done) {
            yield sourceStep.value;
            sourceStep = source.next();
        }
        sourceArrayBuffer = sourceStep.value;
    }
    return {
        metadata: payload,
        arrayBuffer: dataStep.value,
        sourceArrayBuffer,
    };
}

export function decodeTerrainGridApiPayload(payload) {
    // Preserve the synchronous public contract for Node tools and callers that
    // decode small payloads. Browser streaming passes the iterator to its frame
    // queue instead (see world/terrain.js).
    if (!payload || typeof payload.dataBase64 !== 'string') {
        throw new Error('terrain grid: missing data');
    }
    return {
        metadata: payload,
        arrayBuffer: decodeBase64Buffer(payload.dataBase64, 'data'),
        sourceArrayBuffer: typeof payload.sourceDataBase64 === 'string'
            ? decodeBase64Buffer(payload.sourceDataBase64, 'source data')
            : null,
    };
}

// Streams the response body counting real bytes against the payload length so
// progress is an actual percentage, never an estimate. A gzipped response
// streams DECOMPRESSED bytes while Content-Length is the compressed size, so
// the API sends x-uncompressed-length for exactly this reader; falling back
// to Content-Length is only correct for identity-encoded responses. When the
// length is unknown or the body is not streamable, falls back to plain
// json() and reports nothing.
async function readJsonWithProgress(response, onProgress) {
    const totalBytes = Number(response.headers?.get?.('x-uncompressed-length'))
        || Number(response.headers?.get?.('content-length'));
    if (!response.body || typeof response.body.getReader !== 'function'
        || !Number.isFinite(totalBytes) || totalBytes <= 0) {
        return response.json();
    }
    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedBytes += value.byteLength;
        onProgress({
            receivedBytes,
            totalBytes,
            fraction: Math.min(1, receivedBytes / totalBytes),
        });
    }
    const assembled = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
        assembled.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(assembled));
}

export async function fetchTerrainGridApi(apiBase, request, {
    signal,
    cache,
    fetchImpl = globalThis.fetch,
    onProgress,
    decodePayload = decodeTerrainGridApiPayload,
} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('terrain grid request requires fetch');
    const response = await fetchImpl(terrainGridApiUrl(apiBase, request), { signal, cache });
    if (!response.ok) {
        const error = new Error(`terrain grid HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    const payload = typeof onProgress === 'function'
        ? await readJsonWithProgress(response, onProgress)
        : await response.json();
    if (typeof decodePayload !== 'function') {
        throw new Error('terrain grid request requires a payload decoder');
    }
    return await decodePayload(payload);
}
