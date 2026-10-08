// Normalize a reproducible headed browser launch and label renderer scope.
import { isAbsolute, resolve } from 'node:path';

const REQUIRED_FLAGS = [
    '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
];

export function resolvePerfBrowserLaunch(browserLaunch = {}, configRoot = process.cwd(), viewport = {}) {
    if (!browserLaunch || typeof browserLaunch !== 'object' || Array.isArray(browserLaunch)) {
        throw new Error('browserLaunch must be an object');
    }
    const keys = Object.keys(browserLaunch);
    if (keys.some(key => !['executablePath', 'args'].includes(key))) {
        throw new Error('browserLaunch supports only executablePath and args');
    }
    let executablePath;
    if (browserLaunch.executablePath !== undefined) {
        if (typeof browserLaunch.executablePath !== 'string' || !browserLaunch.executablePath.trim()) {
            throw new Error('browserLaunch.executablePath must be a nonempty path');
        }
        executablePath = isAbsolute(browserLaunch.executablePath)
            ? browserLaunch.executablePath : resolve(configRoot, browserLaunch.executablePath);
    }
    const extraArgs = browserLaunch.args ?? [];
    if (!Array.isArray(extraArgs) || extraArgs.some(arg => typeof arg !== 'string'
        || !/^--[a-zA-Z0-9]/.test(arg) || /[\x00\r\n]/.test(arg))) {
        throw new Error('browserLaunch.args must be an array of command-line flags');
    }
    if (extraArgs.some(arg => /^--(?:headless|window-size|window-position|user-data-dir|remote-debugging-port|remote-debugging-pipe)(?:=|$)/.test(arg))) {
        throw new Error('browserLaunch.args cannot override headed mode, window geometry or browser control');
    }
    for (const required of REQUIRED_FLAGS) {
        if (extraArgs.some(arg => arg === required || arg.startsWith(`${required}=`))) {
            throw new Error(`browserLaunch.args cannot override required flag ${required}`);
        }
    }
    if (!Number.isFinite(viewport.width) || viewport.width <= 0
        || !Number.isFinite(viewport.height) || viewport.height <= 0) {
        throw new Error('Explicit viewport dimensions required for browser launch');
    }
    const args = [...REQUIRED_FLAGS, '--window-position=40,40',
        `--window-size=${viewport.width},${viewport.height}`, ...extraArgs];
    return { ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: false, args };
}

export function classifyPerfRenderer(rendererName) {
    if (typeof rendererName !== 'string' || !rendererName.trim()) {
        return { kind: 'unknown', comparisonScope: 'renderer not identified' };
    }
    if (/swiftshader|llvmpipe|softpipe|lavapipe|swrast|software|microsoft basic render/i.test(rendererName)) {
        return { kind: 'software', comparisonScope: 'software-rendered host only' };
    }
    if (/nvidia|geforce|radeon|amd|intel|apple|mali|adreno|powervr/i.test(rendererName)) {
        return { kind: 'hardware', comparisonScope: 'renderer-specific; compare only matching renderer identity' };
    }
    return { kind: 'unknown', comparisonScope: 'renderer type unknown; compare only matching renderer identity' };
}
