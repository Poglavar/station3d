#!/usr/bin/env node
// Deterministically rasterize the first-party crowd-face mask and write its PNG.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { createCrowdFaceAtlas } from '../core/crowd-face-atlas.js';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const defaultOutput = resolve(scriptDir, '../assets/people/crowd-faces.png');
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return crc >>> 0;
});

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const name = Buffer.from(type, 'ascii');
    const chunk = Buffer.allocUnsafe(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    name.copy(chunk, 4);
    data.copy(chunk, 8);
    const checksumInput = Buffer.allocUnsafe(name.length + data.length);
    name.copy(checksumInput, 0);
    data.copy(checksumInput, name.length);
    chunk.writeUInt32BE(crc32(checksumInput), 8 + data.length);
    return chunk;
}

export function encodeCrowdFacePng({ width, height, data }) {
    if (!Number.isSafeInteger(width) || width < 1
        || !Number.isSafeInteger(height) || height < 1
        || !(data instanceof Uint8Array) || data.byteLength !== width * height * 4) {
        throw new TypeError('Expected a positive-size RGBA atlas');
    }
    const scanlineBytes = width * 4;
    const scanlines = Buffer.alloc((scanlineBytes + 1) * height);
    const rgba = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    for (let y = 0; y < height; y++) {
        const target = y * (scanlineBytes + 1);
        scanlines[target] = 0; // PNG filter: None
        rgba.copy(scanlines, target + 1, y * scanlineBytes, (y + 1) * scanlineBytes);
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // truecolour with alpha (RGBA)
    header[10] = 0; // compression method
    header[11] = 0; // filter method
    header[12] = 0; // no interlace
    const compressed = deflateSync(scanlines, { level: 9, memLevel: 9, strategy: 0 });
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', compressed),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

async function main() {
    const { values } = parseArgs({ options: {
        write: { type: 'boolean' }, output: { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help || !values.write) {
        process.stdout.write('Usage: node generate-crowd-face-atlas.mjs --write [--output FILE]\n');
        return;
    }
    const outputPath = resolve(values.output || defaultOutput);
    const png = encodeCrowdFacePng(createCrowdFaceAtlas());
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, png);
    process.stderr.write(`Wrote procedural crowd-face atlas: ${outputPath} (${png.length} bytes)\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => {
        process.stderr.write(`${error?.stack || error}\n`);
        process.exitCode = 1;
    });
}
