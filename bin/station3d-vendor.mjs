#!/usr/bin/env node
// Copies the complete built browser distribution into a web application's public tree.
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(packageRoot, 'website/station-3d/dist');
const args = process.argv.slice(2);
const force = args.includes('--force');
const targetArg = args.find(arg => arg !== '--force');
if (!targetArg || targetArg === '--help' || targetArg === '-h') {
    console.log('Usage: station3d-vendor [--force] <public-directory>');
    process.exit(targetArg ? 0 : 1);
}
const target = resolve(process.cwd(), targetArg);
const targetName = basename(target).toLowerCase();
if (!['station3d', 'station-3d'].includes(targetName)
    || target === '/' || target === homedir() || target === process.cwd()
    || target === packageRoot || existsSync(resolve(target, '.git'))) {
    throw new Error('Target must be a dedicated station3d or station-3d asset directory');
}
if (!existsSync(source)) throw new Error('Station3D distribution is missing; reinstall or rebuild the package');
if (existsSync(target) && readdirSync(target).length) {
    if (!force) throw new Error(`Target is not empty: ${target} (pass --force to replace it)`);
    rmSync(target, { recursive: true, force: true });
}
cpSync(source, target, { recursive: true });
console.log(`[station3d-vendor] copied ${source} -> ${target}`);
