// Guards the app-level mute boundary: no Station3D sound graph may bypass the
// managed master output by connecting straight to an AudioContext destination.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function javascriptFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => {
        const fullPath = path.join(dir, entry.name);
        // Dependencies own their audio internals; this contract covers only
        // Station3D source and must behave the same whether npm is installed
        // locally in this directory or resolved from a parent workspace.
        if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === 'dist')) return [];
        if (entry.isDirectory()) return javascriptFiles(fullPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
    }));
    return nested.flat();
}

test('all audio graphs connect through the managed mute output', async () => {
    const bypasses = [];
    for (const file of await javascriptFiles(root)) {
        if (file.endsWith(`${path.sep}core${path.sep}audio-unlock.js`)) continue;
        const source = await readFile(file, 'utf8');
        if (/\.connect\([^;\n]*\.destination\)/.test(source)) {
            bypasses.push(path.relative(root, file));
        }
        if (/\bnew Audio\(/.test(source) && !/registerAudioElement\(new Audio\(/.test(source)) {
            bypasses.push(`${path.relative(root, file)} (unmanaged Audio element)`);
        }
    }
    assert.deepEqual(bypasses, []);
});
