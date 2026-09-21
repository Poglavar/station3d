#!/usr/bin/env node
// Pre-generate ZET-style bilingual station announcements for the cab view.
// Real ZET PA: "Sljedeća postaja je... The next station is... <Name>" when
// approaching, and just "<Name>" when arriving. To reuse the name clip in
// both contexts, this script generates two file types:
//
//   audio/announcements/prefix.mp3           — "Sljedeća postaja je... The next station is..."
//   audio/announcements/<slug>.mp3           — just "<Name>." per unique station
//
// Runtime chains prefix + name (with Web Audio scheduling for tight seam)
// for the approach announcement, and plays just <slug>.mp3 on arrival.
//
// Usage:
//   node --env-file=../cadastre-data/api/.env scripts/generate-station-audio.mjs                            # all stations
//   node --env-file=... scripts/generate-station-audio.mjs --mode=prefix                                   # just regen the prefix
//   node --env-file=... scripts/generate-station-audio.mjs --names="Trg bana J. Jelačića"                  # smoke test one station
//   node --env-file=... scripts/generate-station-audio.mjs --voice=coral
//   node --env-file=... scripts/generate-station-audio.mjs --limit=1
//
// Re-run after changing wording, voice, the override map, or the stop list.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..', '..', '..');
const WEB_ROOT   = path.resolve(__dirname, '..', '..');
const OUT_DIR    = path.resolve(__dirname, '..', 'audio', 'announcements');
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');

const TRAM_STOPS_PATH = path.join(WEB_ROOT, 'json/zagreb_tram_stops.json');
// Rail stations come from the API (public.rail_station); the static file they
// used to be read from is gone. Tram stops are still a static asset.
const RAIL_STATIONS_URL = process.env.RAIL_STATIONS_URL
    || 'http://localhost:3001/api/transit/rail-stations';

const OPENAI_API = 'https://api.openai.com/v1';
const TTS_MODEL  = 'gpt-4o-mini-tts';
const COST_PER_1K_CHARS_USD = 0.015;

// Source-to-spoken overrides: when the displayed station name has Croatian
// abbreviations or initials, the spoken version expands them. Mirrors what
// real ZET PA announcements do — the sign reads "Trg bana J. Jelačića"
// but the announcer says the full "Trg bana Josipa Jelačića".
const PRONUNCIATION_OVERRIDES = {
    'Trg bana J. Jelačića':  'Trg bana Josipa Jelačića',
    'Trg P. Krešimira':      'Trg Petra Krešimira',
    'Trg dr. F. Tuđmana':    'Trg doktora Franje Tuđmana',
    'Trg Rep. Hrvatske':     'Trg Republike Hrvatske',
    'Trg hr. velikana':      'Trg hrvatskih velikana',
    'Trg žrt. fašizma':      'Trg žrtava fašizma',
    'Branim. tržnica':       'Branimirova tržnica',
    'Autobusni kol.':        'Autobusni kolodvor',
    'Grač. Mihaljevac':      'Gračanski Mihaljevac',
    'Muzej suv.umjetnosti':  'Muzej suvremene umjetnosti',
    'Radić. šetalište':      'Radićevo šetalište',
    'St. dom S. Radić':      'Studentski dom Stjepana Radića',
    'Sveučilišna al.':       'Sveučilišna aleja',
    'Učit. fakultet':        'Učiteljski fakultet',
};

const PREFIX_TEXT = 'Sljedeća postaja je... The next stop is...';
const NAME_TEXT   = (name) => `${PRONUNCIATION_OVERRIDES[name] || name}.`;

const VOICE_INSTRUCTIONS = [
    'PERSONA: Calm, neutral female public-transit announcer for Zagreb tram (ZET).',
    'PACING: Slightly slower than conversational; clear word boundaries on station names.',
    'EMOTION: Neutral and informative — neither warm nor cold. Slightly downward intonation at the end.',
    'PAUSES: The ellipses (...) are intentional pauses; honour them with ~0.4s of silence each.',
    'LANGUAGE: Mixed Croatian (Sljedeća postaja je) and English (the next station is). The station name itself is ALWAYS a Croatian proper noun — never apply English phonetics to it. Same voice identity throughout.',
    'CRITICAL — CROATIAN J: The letter "J" in Croatian is pronounced as English "Y" (as in "yes" / "year"), NOT as English "J" (as in "jam"). So "Jelačić" is "yeh-LAH-cheech", "Josip" is "YOH-seep", "Maksimir" stays as English-readable but if you see any J in a Croatian word, it MUST be Y.',
    'PRONUNCIATION: Other Croatian diacritics — š = "sh", č = hard "ch" (as in "chair"), ć = soft "ch" (between "ch" and "ts"), đ = soft "j" (as in "judge"), ž = "zh" (as in "measure").',
].join(' ');

function parseArgs(argv) {
    const out = {};
    for (const a of argv) {
        if (!a.startsWith('--')) continue;
        const [k, v] = a.replace(/^--/, '').split('=');
        out[k] = v ?? true;
    }
    return out;
}

function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
const log = (...a) => console.log(`[${ts()}]`, ...a);

// Strip diacritics, lowercase, collapse non-alphanumeric to single hyphens.
// Same algorithm must be reproducible client-side so the cab can compute
// the URL from a station name without consulting the manifest.
function slugify(name) {
    return name.normalize('NFD')
        .replace(/[̀-ͯ]/g, '')   // strip combining marks
        .replace(/[đĐ]/g, m => m === 'đ' ? 'd' : 'D')   // đ isn't decomposed by NFD
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

async function loadStationNames() {
    const tram = JSON.parse(await readFile(TRAM_STOPS_PATH, 'utf8'));
    const railResponse = await fetch(RAIL_STATIONS_URL);
    if (!railResponse.ok) {
        throw new Error(`rail-stations returned HTTP ${railResponse.status} — is the API up?`);
    }
    const rail = await railResponse.json();
    const names = new Set();
    for (const s of tram) if (s.name) names.add(s.name);
    for (const s of rail) if (s.name) names.add(s.name);
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'hr'));
}

async function synthesize(text, voice, apiKey) {
    const res = await fetch(`${OPENAI_API}/audio/speech`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: TTS_MODEL,
            voice,
            input: text,
            instructions: VOICE_INSTRUCTIONS,
            response_format: 'mp3',
        }),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`OpenAI TTS ${res.status}: ${errText.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
}

async function loadOrInitManifest(voice) {
    let manifest = { generatedAt: new Date().toISOString(), voice, prefix: null, stations: {} };
    try {
        const prior = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
        if (prior && prior.stations) manifest.stations = prior.stations;
        if (prior && prior.prefix)   manifest.prefix   = prior.prefix;
    } catch (_) {}
    manifest.generatedAt = new Date().toISOString();
    manifest.voice = voice;
    return manifest;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error('OPENAI_API_KEY not set. Try: node --env-file=../cadastre-data/api/.env scripts/generate-station-audio.mjs');
        process.exit(1);
    }
    const voice = args.voice || 'coral';
    const mode = args.mode || 'all';      // all | prefix | names
    const limit = args.limit ? parseInt(args.limit, 10) : Infinity;
    const onlyFilter = args.names
        ? new Set(String(args.names).split(',').map(s => s.trim()))
        : null;

    await mkdir(OUT_DIR, { recursive: true });
    const manifest = await loadOrInitManifest(voice);

    // ── Prefix clip (always single — same for every station). ──────────
    if (mode === 'all' || mode === 'prefix') {
        log(`Voice: ${voice} — generating prefix clip...`);
        const t0 = Date.now();
        const buf = await synthesize(PREFIX_TEXT, voice, apiKey);
        await writeFile(path.join(OUT_DIR, 'prefix.mp3'), buf);
        manifest.prefix = { file: 'audio/announcements/prefix.mp3', text: PREFIX_TEXT };
        log(`  ✓ prefix.mp3  (${buf.length} B, ${Date.now() - t0} ms)  "${PREFIX_TEXT}"`);
    }

    // ── Per-station name clips. ────────────────────────────────────────
    if (mode === 'all' || mode === 'names') {
        let names = await loadStationNames();
        if (onlyFilter) names = names.filter(n => onlyFilter.has(n));
        if (Number.isFinite(limit)) names = names.slice(0, limit);

        const totalChars = names.reduce((s, n) => s + NAME_TEXT(n).length, 0);
        const estUsd = (totalChars / 1000) * COST_PER_1K_CHARS_USD;
        log(`Will generate ${names.length} name MP3s (~${totalChars} chars, est $${estUsd.toFixed(4)})`);

        let i = 0;
        for (const name of names) {
            i += 1;
            const slug = slugify(name);
            const text = NAME_TEXT(name);
            const filename = `${slug}.mp3`;
            const t0 = Date.now();
            try {
                const buf = await synthesize(text, voice, apiKey);
                await writeFile(path.join(OUT_DIR, filename), buf);
                const ms = Date.now() - t0;
                manifest.stations[name] = { file: `audio/announcements/${filename}`, slug, text };
                log(`  [${i}/${names.length}] ✓ ${slug}.mp3  (${buf.length} B, ${ms} ms)  "${name}"`);
            } catch (err) {
                log(`  [${i}/${names.length}] ✗ ${slug}.mp3  FAILED: ${err.message}`);
                throw err;
            }
        }
    }

    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    log(`Wrote manifest: ${MANIFEST_PATH}`);
    log('DONE');
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
