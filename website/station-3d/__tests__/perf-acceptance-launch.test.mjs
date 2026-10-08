import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolvePerfBrowserLaunch, classifyPerfRenderer } from '../../../tools/lib/perf-acceptance-launch.mjs';

const viewport = { width: 1280, height: 720 };
const requiredFlags = [
    '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--window-position=40,40', '--window-size=1280,720',
];

test('defaults to headed Chrome with the stable anti-throttling and viewport flags', () => {
    const launch = resolvePerfBrowserLaunch({}, '/runs/config', viewport);
    assert.equal(launch.channel, 'chrome');
    assert.equal(launch.headless, false);
    assert.deepEqual(launch.args, requiredFlags);
});

test('uses an explicit resolved browser binary and appends custom flags without dropping required flags', () => {
    const launch = resolvePerfBrowserLaunch({ executablePath: '../chromium/chrome', args: ['--ozone-platform=x11'] },
        '/runs/config', viewport);
    assert.equal(launch.executablePath, path.resolve('/runs/config', '../chromium/chrome'));
    assert.equal('channel' in launch, false);
    assert.equal(launch.headless, false);
    assert.deepEqual(launch.args, [...requiredFlags, '--ozone-platform=x11']);
});

test('rejects launch settings that can disable required anti-throttling flags or have invalid shapes', () => {
    assert.throws(() => resolvePerfBrowserLaunch({ args: ['--disable-renderer-backgrounding=false'] }, '/x', viewport),
        /cannot override required flag/);
    assert.throws(() => resolvePerfBrowserLaunch({ args: '--no-sandbox' }, '/x', viewport), /array of command-line flags/);
    assert.throws(() => resolvePerfBrowserLaunch({ channel: 'chromium' }, '/x', viewport), /only executablePath and args/);
    assert.throws(() => resolvePerfBrowserLaunch({}, '/x', { width: 0, height: 720 }), /viewport dimensions/);
    for (const arg of ['--headless', '--headless=new', '--window-size=1,1', '--user-data-dir=/x', '--remote-debugging-port=1234']) {
        assert.throws(() => resolvePerfBrowserLaunch({ args: [arg] }, '/x', viewport), /cannot override headed mode/);
    }
    for (const arg of ['https://example.test', '', '--foo\nbar', null]) {
        assert.throws(() => resolvePerfBrowserLaunch({ args: [arg] }, '/x', viewport), /array of command-line flags/);
    }
});

test('classifies llvmpipe as software with a scoped comparison and keeps unidentified renderers unknown', () => {
    assert.deepEqual(classifyPerfRenderer('llvmpipe (LLVM 20.1.2, 128 bits)'), {
        kind: 'software', comparisonScope: 'software-rendered host only',
    });
    assert.deepEqual(classifyPerfRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX)'), {
        kind: 'hardware', comparisonScope: 'renderer-specific; compare only matching renderer identity',
    });
    assert.deepEqual(classifyPerfRenderer(null), { kind: 'unknown', comparisonScope: 'renderer not identified' });
    assert.deepEqual(classifyPerfRenderer('Mesa renderer'), {
        kind: 'unknown', comparisonScope: 'renderer type unknown; compare only matching renderer identity',
    });
});
// Browser configuration must preserve the measured viewport and execution mode.
