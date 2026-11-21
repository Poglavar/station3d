// Catches the "used it, never imported it" bug: a module calls a function that
// some OTHER module in the tree exports, but never imports it. The browser only
// finds out when the line runs, as a bare ReferenceError deep inside a session:
//
//     3D walk open error: ReferenceError: isElevationMode is not defined
//         at getSessionLayerEntries (cab.js:423)
//
// That shipped to production in modes/cab.js. Nothing caught it: the import-path
// test (module-imports-resolve) only checks that files exist, no unit test calls
// getSessionLayerEntries, node --check parses it fine, and the deploy smoke test
// only asks nginx for 200s. It needed something that reads the bindings.
//
// Deliberately narrow, because there is no AST parser in this project and a
// regex cannot do real scope analysis. It only fires when a name is (a) exported
// by another module here, (b) called here, (c) not imported here, (d) not
// declared here, and (e) not a parameter. That combination is specific enough to
// have found exactly one real defect and nothing else across the tree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Comments and string bodies are blanked, newlines kept so line numbers hold.
function strip(source) {
    const out = source.split('');
    const blank = (from, to) => {
        for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
    };
    let i = 0;
    while (i < source.length) {
        const two = source.slice(i, i + 2);
        if (two === '//') {
            const e = source.indexOf('\n', i);
            const stop = e === -1 ? source.length : e;
            blank(i, stop); i = stop;
        } else if (two === '/*') {
            const e = source.indexOf('*/', i + 2);
            const stop = e === -1 ? source.length : e + 2;
            blank(i, stop); i = stop;
        } else if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
            const q = source[i];
            let j = i + 1;
            while (j < source.length && source[j] !== q) {
                if (source[j] === '\\') j += 1;
                j += 1;
            }
            blank(i + 1, Math.min(j, source.length));
            i = Math.min(j + 1, source.length);
        } else {
            i += 1;
        }
    }
    return out.join('');
}

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

function namesBoundIn(src) {
    const bound = new Set();
    // declarations
    for (const m of src.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
    for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
    // destructured declarations — `const { createTramMesh, x: y } = await import('…')`
    // binds createTramMesh and y locally; the lazy-loading catalog relies on this.
    for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(':').pop()?.split('=')[0]?.trim();
            if (name && /^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
        }
    }
    // imports, including default and namespace forms
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop()?.trim();
            if (name) bound.add(name);
        }
    }
    for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) bound.add(m[1]);
    for (const m of src.matchAll(/import\s*\*\s*as\s*([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
    // parameters, including destructured ones — `function f({ getBuildingsGroup })`
    // binds that name locally and must not be mistaken for a missing import.
    const parameterLists = [];
    for (let start = src.indexOf('('); start >= 0; start = src.indexOf('(', start + 1)) {
        let depth = 1;
        for (let end = start + 1; end < src.length && depth; end++) {
            if (src[end] === '(') depth++;
            else if (src[end] === ')') depth--;
            if (depth === 0 && /^(?:\s*)(?:=>|\{)/.test(src.slice(end + 1))) {
                parameterLists.push(src.slice(start + 1, end));
            }
        }
    }
    for (const params of parameterLists) {
        for (const raw of params.split(',')) {
            const name = raw.trim().replace(/^\.\.\./, '').split('=')[0].replace(/[{}[\]]/g, '').trim();
            if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
            for (const inner of raw.matchAll(/([A-Za-z_$][\w$]*)\s*(?::|,|\}|$)/g)) bound.add(inner[1]);
        }
    }
    // object-literal and class method shorthand: `foo() {` defines, not calls
    for (const m of src.matchAll(/(?:^|[,{;\n])\s*(?:async\s+|get\s+|set\s+|static\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
        bound.add(m[1]);
    }
    return bound;
}

test('parameter scanner accepts nested default callback expressions', () => {
    const bound = namesBoundIn(`function* f(state, {
        materials = {}, buildManholeMesh = null, now = () => performance.now(),
        isCurrent = () => true,
    } = {}) { buildManholeMesh(); }`);
    for (const name of ['state', 'materials', 'buildManholeMesh', 'now', 'isCurrent']) {
        assert.equal(bound.has(name), true, name);
    }
});

test('parameter scanner does not hide a genuinely missing imported symbol', () => {
    const bound = namesBoundIn('function f(value = () => missing()) { return realCall(); }');
    assert.equal(bound.has('realCall'), false);
    assert.equal(bound.has('missing'), false);
});

test('a symbol exported elsewhere is imported before it is called', async () => {
    const files = (await jsFiles(ROOT)).filter(f => !f.includes(`${path.sep}__tests__${path.sep}`));
    assert.ok(files.length > 50, `expected the module tree, found ${files.length} files`);

    const sources = new Map(files.map(f => [f, strip(readFileSync(f, 'utf8'))]));

    const exportedBy = new Map();
    for (const [file, src] of sources) {
        for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
            if (!exportedBy.has(m[1])) exportedBy.set(m[1], file);
        }
    }

    const unbound = [];
    for (const [file, src] of sources) {
        const bound = namesBoundIn(src);
        const reported = new Set();
        for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
            const name = m[1];
            if (reported.has(name) || bound.has(name)) continue;
            const owner = exportedBy.get(name);
            if (!owner || owner === file) continue;
            reported.add(name);
            const line = src.slice(0, m.index).split('\n').length;
            unbound.push(`${path.relative(ROOT, file)}:${line} calls ${name}() — exported by `
                + `${path.relative(ROOT, owner)}, never imported here`);
        }
    }

    assert.deepEqual(unbound, [], `unimported symbols:\n  ${unbound.join('\n  ')}`);
});
