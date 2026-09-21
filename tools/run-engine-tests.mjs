// Runs the positive manifest of tests owned by the extracted engine.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'tests/engine-owned.json'), 'utf8'));
if (!Array.isArray(manifest.tests) || manifest.tests.length === 0) {
    throw new Error('tests/engine-owned.json must contain at least one test');
}
const testRoot = resolve(repoRoot, 'website/station-3d');
const result = spawnSync(process.execPath, ['--test', ...manifest.tests], {
    cwd: testRoot,
    stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
