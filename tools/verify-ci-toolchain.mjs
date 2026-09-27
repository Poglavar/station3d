// Keeps local CI and the pre-push hook on the exact GitHub Actions toolchain.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const nodeVersion = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
const { packageManager } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
if (process.versions.node !== nodeVersion || `npm@${npmVersion}` !== packageManager) {
    console.error(`CI requires Node ${nodeVersion} and ${packageManager}; found Node ${process.versions.node} and npm@${npmVersion}.`);
    console.error(`Run nvm install && nvm use, then npm install --global ${packageManager} if npm still differs.`);
    process.exitCode = 1;
}
