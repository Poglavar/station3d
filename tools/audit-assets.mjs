// Verifies the candidate asset allowlist and reports public-release blockers.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stationRoot = resolve(repoRoot, 'website/station-3d');
const releaseMode = process.argv.includes('--release');
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'assets.manifest.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const errors = [];
const blockers = [];

function filesBelow(path) {
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path).flatMap(name => filesBelow(resolve(path, name)));
}

let candidateFiles = 0;
const manifestedRoots = [];
for (const group of manifest.groups || []) {
    if (!group.id || !Array.isArray(group.paths) || !group.paths.length || !group.license) {
        errors.push(`Malformed asset group: ${group.id || '<unnamed>'}`);
        continue;
    }
    const provenance = resolve(stationRoot, group.provenance || '');
    if (!group.provenance || !existsSync(provenance)) {
        errors.push(`${group.id}: missing provenance ${group.provenance || '<unset>'}`);
    }
    for (const relativePath of group.paths) {
        const path = resolve(stationRoot, relativePath);
        manifestedRoots.push(path);
        if (!existsSync(path)) errors.push(`${group.id}: missing ${relativePath}`);
        else if (group.includeInCandidate === true) candidateFiles += filesBelow(path).length;
    }
    if (group.includeInCandidate === true && group.releaseCleared !== true) {
        blockers.push(`${group.id}: ${group.license}`);
    }
}

const mediaExtensions = new Set([
    '.blend', '.flac', '.glb', '.gltf', '.jpeg', '.jpg', '.mp3', '.ogg',
    '.png', '.wav', '.webp',
]);
for (const path of filesBelow(stationRoot)) {
    if (path.startsWith(`${resolve(stationRoot, 'dist')}${sep}`)) continue;
    if (!mediaExtensions.has(extname(path).toLowerCase())) continue;
    const covered = manifestedRoots.some(root => path === root || path.startsWith(`${root}${sep}`));
    if (!covered) errors.push(`unmanifested media: ${path.slice(stationRoot.length + 1)}`);
}

const buildManifestPath = resolve(stationRoot, 'dist/build-manifest.json');
if (existsSync(buildManifestPath)) {
    const build = JSON.parse(readFileSync(buildManifestPath, 'utf8'));
    for (const input of build.reviewRequiredInputs || []) blockers.push(`bundle input: ${input}`);
}
if (packageJson.private === true) blockers.push('package.json is private');
if (packageJson.license === 'UNLICENSED') blockers.push('code license is UNLICENSED');

if (errors.length) {
    for (const error of errors) console.error(`[asset-audit] ERROR ${error}`);
    process.exitCode = 1;
} else {
    console.log(`[asset-audit] candidate manifest valid: ${manifest.groups.length} groups, ${candidateFiles} files`);
}
if (blockers.length) {
    console.log(`[asset-audit] public release blocked by ${blockers.length} item(s):`);
    for (const blocker of blockers) console.log(`  - ${blocker}`);
    if (releaseMode) process.exitCode = 1;
} else {
    console.log('[asset-audit] public release asset gate passed');
}
