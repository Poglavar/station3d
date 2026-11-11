// Loads the shared LLM cost layer (one rate table, one ledger) that prices and records every paid
// clip the audio generation scripts synthesize. The layer is not part of this repository:
// LLM_COST_LIB names its index.mjs, and without that variable the checkout beside this repository
// (../agents/lib/llm-cost) is used. A script that cannot load the layer must not spend money, so
// each script loads it before its first paid request and lets a failure stop the run.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SIBLING_CHECKOUT = new URL('../../../../agents/lib/llm-cost/index.mjs', import.meta.url);

// env: the process environment (injectable for tests). Resolves to the layer's exports, which
// include computeCost(model, usage) and record(entry); rejects when it cannot be loaded.
export async function loadLlmCost(env = process.env) {
    const configured = typeof env.LLM_COST_LIB === 'string' ? env.LLM_COST_LIB.trim() : '';
    const location = configured ? pathToFileURL(path.resolve(configured)) : SIBLING_CHECKOUT;
    const file = fileURLToPath(location);
    let layer;
    try {
        layer = await import(location.href);
    } catch (error) {
        throw new Error(`LLM cost layer could not be loaded from ${file}; set LLM_COST_LIB to its index.mjs`, { cause: error });
    }
    if (typeof layer.computeCost !== 'function' || typeof layer.record !== 'function') {
        throw new Error(`${file} is not the LLM cost layer: it must export computeCost and record`);
    }
    return layer;
}
