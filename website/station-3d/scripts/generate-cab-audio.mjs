#!/usr/bin/env node
// Pre-generate every spoken cab line as static MP3s under ../audio/.
// Four buckets:
//   * `shoot`       — civilian driver yells when a bullet hits their car
//   * `wreck`       — civilian driver laments when their car is destroyed
//   * `enemy-shoot` — enemy technical / tram opens fire
//   * `enemy-hit`   — enemy technical / tram gets hit but survives
//   * `enemy-wreck` — enemy technical / tram is destroyed
//   * `friendly-fire` — allied blue tram complains when the player hits it
// The runtime (cab-voice.js) loads the manifest produced here and picks a file
// at random per event, so no TTS calls happen at play time.
//
// Usage:
//   OPENAI_API_KEY=... node scripts/generate-cab-audio.js
//   node --env-file=/path/to/.env scripts/generate-cab-audio.js
//   node scripts/generate-cab-audio.js --voices=onyx,ash,ballad
//   node scripts/generate-cab-audio.js --only=shoot
//   node scripts/generate-cab-audio.js --only=enemy-shoot
//   node scripts/generate-cab-audio.js --only=enemy-hit
//   node scripts/generate-cab-audio.js --only=friendly-fire
//
// Re-run after editing the line lists or voice list.

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.resolve(__dirname, '..', 'audio');
const MANIFEST_PATH = path.join(AUDIO_DIR, 'manifest.json');

const OPENAI_API = 'https://api.openai.com/v1';
const TTS_MODEL = 'gpt-4o-mini-tts';

// Roughly $0.015 / 1k input characters for gpt-4o-mini-tts.
const COST_PER_1K_CHARS_USD = 0.015;

const MALE_VOICES = ['onyx', 'ash'];
const FEMALE_VOICES = ['ballad'];

function line(text, voices = null) {
    return voices ? { text, voices: [...voices] } : { text };
}

const SHOOT_LINES = [
    line('Ej, pazi majmune!'),
    line('Rekli su na prognozi kiša, ali ne metaka!'),
    line('Promet je u ovom gradu sve gori, majkemi'),
    line('Alooooo jesi ti normalan??'),
    line('Koji ti je??'),
    line('Budalo!'),
    line('ej!', MALE_VOICES),
    line('Heeeeeej', MALE_VOICES),
    line('ej! ej! ej!', FEMALE_VOICES),
    line('Hej ja sam civil!', MALE_VOICES),
];

const WRECK_LINES = [
    line('Danas stvarno nije moj dan'),
    line('Ponekad poželim da imam tenk'),
    line('Još jedna rata lizinga mi je ostala, još jedna'),
    line('I tako je od punice auto, briga me'),
    line('Uništili mi auto mitraljezom, konačno dobar story za insta'),
    line('Ajme meni i kaj bum sad? Ne bum niš'),
    line('Jesu ovo pripreme za vojnu paradu ili kaj? El možete pazit malo?'),
    line('Ode životna ušteđevina'),
    line('Ma ja sam kriv, stao sam točno ispred metka'),
];

const ENEMY_SHOOT_LINES = [
    line('Hahaha kušaj olovo kapitalistička svinjo!', MALE_VOICES),
    line('Eno ga, drž ga!', MALE_VOICES),
    line('Drugovi oprez, neprijatelj je došao!', MALE_VOICES),
    line('Evo ti rafal socijalne pravde!', MALE_VOICES),
    line('No pasaran!', MALE_VOICES),
    line('Proleteri svih zemalja, lajkajte i šerajte!', MALE_VOICES),
];

const ENEMY_HIT_LINES = [
    line('Sudit će ti narod!', MALE_VOICES),
    line('Ne pucaj! Ja sam samo kuhar!', MALE_VOICES),
    line('Staljinovih mi brkova, ovdje postaje vruće!', MALE_VOICES),
];

const ENEMY_WRECK_LINES = [
    line('Propadoh! Osvetite me drugovi!', MALE_VOICES),
    line('Uništiše me!', MALE_VOICES),
    line('Pogođen sam!', MALE_VOICES),
];

const FRIENDLY_FIRE_LINES = [
    line('Hej zemljače, pa mi smo naši!', MALE_VOICES),
    line('Prijateljska vatra!', MALE_VOICES),
];

// Different delivery per bucket. Civilian shoot lines are angry, shocked yells
// at whoever shot them. Civilian wreck lines are deflated, ironic, sometimes
// resigned. Enemy lines are aggressive militia taunts / panicked last words.
// Friendly-fire lines are allied disbelief and protest.
const INSTRUCTIONS = {
    shoot: [
        'PERSONA: Hrvatski vozač srednjih godina, frustriran prometom u Zagrebu.',
        'EMOTION: Bijes i šok — netko mu je upravo pucao u auto. Glas pun nevjerice i ljutnje.',
        'PACING: Kratko, oštro, eksplozivno. Kao da viče kroz spušten prozor.',
        'DELIVERY: Pojačaj glasnoću na uskličnicima, izvuci samoglasnike na "Alooooo", "majkemi".',
    ].join(' '),
    wreck: [
        'PERSONA: Hrvatski vozač srednjih godina koji upravo gleda svoj uništeni auto.',
        'EMOTION: Rezignacija, suhi crni humor, blagi očaj. Kao da mu se ovo događa svaki dan.',
        'PACING: Sporije, monotono, ponekad uzdah prije rečenice.',
        'DELIVERY: Više prema sebi nego prema nekome. Bez vike — tiho, pomireno, mrzovoljno.',
    ].join(' '),
    'enemy-shoot': [
        'PERSONA: Pripadnik crvene milicije naoružan na tehnikaliji ili tramvaju.',
        'EMOTION: Agresija, fanatična euforija, ratničko kurčenje.',
        'PACING: Kratko i glasno, kao urlik neposredno prije rafala.',
        'DELIVERY: Oštar, prijeteći, glas baca prema neprijatelju. Naglasi "kapitalistička svinjo", "drž ga", "drugovi".',
    ].join(' '),
    'enemy-hit': [
        'PERSONA: Pripadnik crvene milicije pogođen, ali još uvijek živ i u borbi.',
        'EMOTION: Bol, panika, ljutnja i fanatični prkos.',
        'PACING: Kratko, naglo, kao refleksni povik odmah nakon pogotka.',
        'DELIVERY: Glas je uzdrman, zadihan i ogorčen. Naglasi "Sudit će ti narod", "samo kuhar" i "Staljinovih mi brkova".',
    ].join(' '),
    'enemy-wreck': [
        'PERSONA: Ranjen ili uništen neprijateljski borac u zadnjim sekundama.',
        'EMOTION: Panika, bol, očaj, ali i dalje ratnički prkos.',
        'PACING: Kratko, zadihano, kao posljednji povik kroz dim i metal.',
        'DELIVERY: Puknuti glas, hitnost, bolni usklici. Naglasi "Osvetite me drugovi" i "Pogođen sam".',
    ].join(' '),
    'friendly-fire': [
        'PERSONA: Vozač plavog saveznickog tramvaja kojeg je upravo pogodio prijateljski metak.',
        'EMOTION: Nevjerica, ljutnja, protest prema svome covjeku.',
        'PACING: Kratko i jasno, dovoljno glasno da nadjaca buku borbe.',
        'DELIVERY: Zvuči kao saveznik koji prekorava svog covjeka, ne kao civil i ne kao neprijatelj. Naglasi "zemljače", "naši" i "Prijateljska vatra".',
    ].join(' '),
};

function resolveEntry(entry) {
    if (typeof entry === 'string') return { text: entry, voices: null };
    return {
        text: String(entry.text || ''),
        voices: Array.isArray(entry.voices) ? entry.voices.map(v => String(v).trim()).filter(Boolean) : null,
    };
}

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

async function synthesize(text, voice, instructions, apiKey) {
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
            instructions,
            response_format: 'mp3',
        }),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`OpenAI TTS ${res.status}: ${errText.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error('OPENAI_API_KEY not set. Try: node --env-file=../cadastre-data/api/.env scripts/generate-cab-audio.js');
        process.exit(1);
    }

    const voices = (args.voices ? String(args.voices).split(',') : ['onyx', 'ash', 'ballad'])
        .map(v => v.trim()).filter(Boolean);
    const buckets = args.only ? [args.only] : ['shoot', 'wreck', 'enemy-shoot', 'enemy-hit', 'enemy-wreck', 'friendly-fire'];
    const linesByBucket = {
        shoot: SHOOT_LINES,
        wreck: WRECK_LINES,
        'enemy-shoot': ENEMY_SHOOT_LINES,
        'enemy-hit': ENEMY_HIT_LINES,
        'enemy-wreck': ENEMY_WRECK_LINES,
        'friendly-fire': FRIENDLY_FIRE_LINES,
    };

    let totalChars = 0;
    let totalFiles = 0;
    for (const b of buckets) {
        const entries = linesByBucket[b];
        if (!entries) throw new Error(`Unknown bucket: ${b}`);
        for (const entry of entries) {
            const { text, voices: entryVoices } = resolveEntry(entry);
            const renderVoices = (entryVoices || voices).filter(v => voices.includes(v));
            totalChars += text.length * renderVoices.length;
            totalFiles += renderVoices.length;
        }
    }
    const estUsd = (totalChars / 1000) * COST_PER_1K_CHARS_USD;
    log(`Voices: ${voices.join(', ')}`);
    log(`Buckets: ${buckets.join(', ')}`);
    log(`Will generate ${totalFiles} MP3s (~${totalChars} chars, est $${estUsd.toFixed(4)})`);

    // Load any prior manifest so a partial re-run (e.g. --only=shoot) keeps
    // the buckets it isn't touching intact.
    let manifest = { generatedAt: new Date().toISOString(), voices, buckets: {} };
    try {
        const prior = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
        if (prior && prior.buckets) {
            manifest.buckets = { ...prior.buckets };
        }
    } catch (_) { /* no prior manifest — fine */ }
    manifest.generatedAt = new Date().toISOString();
    manifest.voices = voices;

    for (const bucket of buckets) {
        const entries = linesByBucket[bucket];
        manifest.buckets[bucket] = [];
        for (const voice of voices) {
            const subdir = path.join(AUDIO_DIR, bucket, voice);
            // Wipe any prior render of this bucket+voice so removed lines
            // don't leave orphan MP3s the manifest no longer indexes.
            await rm(subdir, { recursive: true, force: true });
        }
        for (const voice of voices) {
            await mkdir(path.join(AUDIO_DIR, bucket, voice), { recursive: true });
        }
        const counters = new Map(voices.map(v => [v, 0]));
        for (const entry of entries) {
            const { text, voices: entryVoices } = resolveEntry(entry);
            const renderVoices = (entryVoices || voices).filter(v => voices.includes(v));
            for (const voice of renderVoices) {
                const filename = `${(counters.get(voice) || 0) + 1}.mp3`;
                counters.set(voice, (counters.get(voice) || 0) + 1);
                const t0 = Date.now();
                const buf = await synthesize(text, voice, INSTRUCTIONS[bucket], apiKey);
                await writeFile(path.join(AUDIO_DIR, bucket, voice, filename), buf);
                const ms = Date.now() - t0;
                const rel = `audio/${bucket}/${voice}/${filename}`;
                manifest.buckets[bucket].push({ file: rel, voice, text });
                log(`  ✓ ${rel}  (${buf.length} B, ${ms} ms)  "${text}"`);
            }
        }
    }

    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    log(`Wrote manifest: ${MANIFEST_PATH}`);
    log(`DONE — ${totalFiles} files, est cost $${estUsd.toFixed(4)}`);
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
