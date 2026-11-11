// The audio generation scripts load the external LLM cost layer at run time; a run that cannot
// price and record its clips must stop before it spends anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadLlmCost } from '../scripts/llm-cost-loader.mjs';

async function withLayerFile(source, run) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'llm-cost-loader-'));
    try {
        const file = path.join(dir, 'index.mjs');
        await writeFile(file, source);
        return await run(file);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test('LLM_COST_LIB names the cost layer the scripts price and record with', async () => {
    const source = 'export const computeCost = (model, usage) => usage.characters * 2;\n'
        + 'export const record = (entry) => ({ recorded: entry.model });\n';
    await withLayerFile(source, async (file) => {
        const layer = await loadLlmCost({ LLM_COST_LIB: `  ${file}  ` });
        assert.equal(layer.computeCost('tts', { characters: 21 }), 42);
        assert.deepEqual(layer.record({ model: 'tts' }), { recorded: 'tts' });
    });
});

test('a cost layer that cannot be loaded stops the run and names the variable to set', async () => {
    const missing = path.join(os.tmpdir(), 'llm-cost-loader-missing', 'index.mjs');
    await assert.rejects(
        loadLlmCost({ LLM_COST_LIB: missing }),
        (error) => error.message.includes(missing) && error.message.includes('LLM_COST_LIB') && error.cause instanceof Error,
    );
});

test('a module without computeCost and record is not accepted as the cost layer', async () => {
    await withLayerFile('export const computeCost = () => 0;\n', async (file) => {
        await assert.rejects(loadLlmCost({ LLM_COST_LIB: file }), /must export computeCost and record/);
    });
});
