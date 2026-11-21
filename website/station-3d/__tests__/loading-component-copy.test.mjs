// Every queue that can become a pill on the model-world loading bar has
// Croatian and English copy. The dashboard falls back to the raw queue name
// ("pedestrian shader warmup"), which is how English pills reached a Croatian
// loading screen on 2026-09-10; this fails the moment a tracked queue is added
// without its 'loading.<label>' keys.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const i18n = readFileSync(join(root, 'core/i18n.js'), 'utf8');

function sourceFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            if (!['__tests__', 'dist', 'node_modules', 'viewers', 'models', 'assets', 'audio'].includes(name)) out.push(...sourceFiles(path));
        } else if (name.endsWith('.js')) {
            out.push(path);
        }
    }
    return out;
}

// Labels of every loading-tracked queue: frame-chunk queues that do not opt out,
// shader warm-up queues (tracked by construction), direct reports, and the
// fixed phase/queue set the bar always shows.
function trackedLabels() {
    const labels = new Set(['terrain-data', 'terrain-decode', 'terrain-mesh', 'base', 'layers',
        'roads', 'curbs', 'rail-cells', 'cars', 'buildings', 'far-buildings']);
    for (const file of sourceFiles(root)) {
        const src = readFileSync(file, 'utf8');
        for (const match of src.matchAll(/createFrameChunkQueue\(\s*\{/g)) {
            let depth = 1;
            let i = match.index + match[0].length;
            while (i < src.length && depth > 0) {
                if (src[i] === '{') depth += 1;
                else if (src[i] === '}') depth -= 1;
                i += 1;
            }
            const body = src.slice(match.index + match[0].length, i);
            const label = body.match(/label:\s*'([^']+)'/)?.[1];
            if (label && !/trackWorldReady:\s*false/.test(body)) labels.add(label);
        }
        for (const match of src.matchAll(/noteWorldQueue(?:Active|Idle)\('([^']+)'\)/g)) labels.add(match[1]);
        for (const match of src.matchAll(/_PREWARM_READY_LABEL = '([^']+)'/g)) labels.add(match[1]);
        if (file.endsWith('core/queued-shader-warmup.js')) labels.add(src.match(/label = '([^']+)'/)[1]);
        for (const match of src.matchAll(/label:\s*'([a-z-]+-shader-warmup)'/g)) labels.add(match[1]);
    }
    return [...labels].sort();
}

test('every loading-bar queue has Croatian and English copy', () => {
    const labels = trackedLabels();
    assert.ok(labels.length >= 18, `found only ${labels.length} tracked labels`);
    const missing = labels.filter(label => {
        const occurrences = i18n.split(`'loading.${label}':`).length - 1;
        return occurrences !== 2;
    });
    assert.deepEqual(missing, [], 'add both loading.<label> strings in core/i18n.js');
});
