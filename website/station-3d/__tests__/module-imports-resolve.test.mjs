// Every relative import in the Station3D source tree must point at a real file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_FROM = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"](\.[^'"]+)['"]/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;
const DYNAMIC = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

async function jsFiles(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await jsFiles(full));
        else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
}

function blankCommentsAndTemplates(source) {
    const out = source.split('');
    let index = 0;
    const blank = (from, to) => {
        for (let cursor = from; cursor < to; cursor += 1) if (out[cursor] !== '\n') out[cursor] = ' ';
    };
    while (index < source.length) {
        const pair = source.slice(index, index + 2);
        if (pair === '//') {
            const end = source.indexOf('\n', index);
            blank(index, end === -1 ? source.length : end);
            index = end === -1 ? source.length : end;
        } else if (pair === '/*') {
            const end = source.indexOf('*/', index + 2);
            const stop = end === -1 ? source.length : end + 2;
            blank(index, stop);
            index = stop;
        } else if (source[index] === '`') {
            const end = source.indexOf('`', index + 1);
            const stop = end === -1 ? source.length : end + 1;
            blank(index + 1, stop - 1);
            index = stop;
        } else {
            index += 1;
        }
    }
    return out.join('');
}

function specifiersIn(source) {
    const scannable = blankCommentsAndTemplates(source);
    const found = [];
    for (const pattern of [STATIC_FROM, BARE_IMPORT, DYNAMIC]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(scannable)) !== null) {
            found.push({ spec: match[1], line: scannable.slice(0, match.index).split('\n').length });
        }
    }
    return found;
}

test('every relative import in Station3D resolves to a real file', async () => {
    const files = await jsFiles(ROOT);
    assert.ok(files.length > 50, `expected the module tree, found ${files.length} files`);
    const broken = [];
    let checked = 0;
    for (const file of files) {
        for (const { spec, line } of specifiersIn(readFileSync(file, 'utf8'))) {
            checked += 1;
            if (!existsSync(path.resolve(path.dirname(file), spec))) {
                broken.push(`${path.relative(ROOT, file)}:${line} -> ${spec}`);
            }
        }
    }
    assert.ok(checked > 300, `expected to scan the real graph, only saw ${checked} imports`);
    assert.deepEqual(broken, [], `unresolvable imports:\n  ${broken.join('\n  ')}`);
});
