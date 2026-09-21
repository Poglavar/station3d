#!/usr/bin/env node
// Generate the two alternating static voices used by ambient pedestrian pairs.
// Runtime playback is local; this script is the only API consumer.

import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PEDESTRIAN_CONVERSATIONS } from '../core/pedestrian-conversations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const audioDir = path.resolve(here, '..', 'audio', 'conversations');
const apiKey = process.env.OPENAI_API_KEY;
const useLocalVoices = process.argv.includes('--local');
const voiceBySpeaker = { A: 'onyx', B: 'ash' };
const localVoiceBySpeaker = { A: 'Lana', B: 'Tina' };
const execFile = promisify(execFileCallback);
const instructions = [
    'PERSONA: Dva Zagrepčana razgovaraju dok zajedno hodaju ulicom.',
    'ACCENT: Prirodan zagrebački govor; zadrži kajkavske riječi točno kako su napisane.',
    'DELIVERY: Opušteno, nenametljivo i realistično, kao dio razgovora, ne kao najava ili gluma.',
    'PACING: Kratka replika normalne brzine, bez dodavanja riječi ili zvukova.',
].join(' ');

if (!useLocalVoices && !apiKey) throw new Error('OPENAI_API_KEY is required (or pass --local)');

async function synthesizeLocal(line) {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'st3d-conversation-'));
    const aiff = path.join(temp, 'line.aiff');
    const mp3 = path.join(temp, 'line.mp3');
    try {
        await execFile('/usr/bin/say', [
            '-v', localVoiceBySpeaker[line.speaker],
            '-r', line.speaker === 'A' ? '176' : '188',
            '-o', aiff,
            line.text,
        ]);
        await execFile('/opt/homebrew/bin/lame', ['--silent', '-b', '96', aiff, mp3]);
        return readFile(mp3);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
}

async function synthesizeRemote(line) {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini-tts',
            voice: voiceBySpeaker[line.speaker],
            input: line.text,
            instructions,
            response_format: 'mp3',
        }),
    });
    if (!response.ok) throw new Error(`OpenAI TTS ${response.status}: ${await response.text()}`);
    return Buffer.from(await response.arrayBuffer());
}

for (const script of PEDESTRIAN_CONVERSATIONS) {
    const dir = path.join(audioDir, script.id);
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < script.lines.length; index += 1) {
        const line = script.lines[index];
        const bytes = useLocalVoices
            ? await synthesizeLocal(line)
            : await synthesizeRemote(line);
        const file = path.join(dir, `${index + 1}.mp3`);
        await writeFile(file, bytes);
        console.log(`${script.id}/${index + 1}.mp3 ${line.speaker} ${bytes.length} B`);
    }
}
