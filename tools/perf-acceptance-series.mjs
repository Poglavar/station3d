#!/usr/bin/env node
// Predeclare, execute, and compare a fixed loaded-host acceptance series.
import { parseArgs } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
    createPerfAcceptanceSeries, readPerfAcceptanceSeries, runPerfAcceptanceSeries, comparePerfAcceptanceSeries,
    perfAcceptanceSeriesPassed,
} from './lib/perf-acceptance-series.mjs';

const usage = `Usage: node tools/perf-acceptance-series.mjs ACTION [options]
  plan --config FILE --plan FILE --id NAME --baseline-preflight FILE
       [--candidate-preflight FILE] [--kind comparison|control] [--pairs N] [--seed HEX]
  run --plan FILE --run [--resume]
  compare --plan FILE

Planning validates fresh sealed preflights and current package identities without launching a browser.
Execution follows the fixed randomized slot order and stops at the first rejected capture.
Receipts are retained under config.outputDir; neither runs nor plans are overwritten.
For an A/A control, use --kind control --pairs 4; the default comparison uses 12 pairs.`;
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, plan: { type: 'string' }, id: { type: 'string' },
    'baseline-preflight': { type: 'string' }, 'candidate-preflight': { type: 'string' },
    kind: { type: 'string', default: 'comparison' }, pairs: { type: 'string', default: '12' },
    seed: { type: 'string' }, run: { type: 'boolean' }, resume: { type: 'boolean' }, help: { type: 'boolean' },
} });
const action = positionals[0];
if (values.help || !action) {
    console.log(usage);
    process.exit(values.help ? 0 : 2);
}
if (!['plan', 'run', 'compare'].includes(action)) throw new Error(`Unknown action: ${action}`);
if (!values.plan) throw new Error('--plan FILE is required');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const collectorPath = resolve(repoRoot, 'tools/perf-acceptance.mjs');

function inspectVariant({ configPath, variant }) {
    const child = spawnSync(process.execPath, [collectorPath, '--config', configPath, '--stage', 'inspect', '--variant', variant], {
        cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (child.status !== 0) throw new Error(`Inspect ${variant} failed: ${(child.stderr || child.error?.message || '').trim()}`);
    try { return JSON.parse(child.stdout); }
    catch (error) { throw new Error(`Inspect ${variant} returned invalid JSON: ${error.message}`); }
}

function runSlot({ configPath, wrapperPath, slot, preflightPath }) {
    const args = [collectorPath, '--config', configPath, '--stage', 'measure', '--variant', slot.variant,
        '--label', slot.label, '--preflight', preflightPath, '--experiment-plan', wrapperPath,
        '--experiment-slot', String(slot.index), '--run'];
    console.error(`${new Date().toISOString()} series ${slot.index + 1}/${slot.total ?? '?'} ${slot.label}`);
    return new Promise(resolvePromise => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderrTail = '';
        child.stdout.resume();
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => {
            process.stderr.write(chunk);
            stderrTail = (stderrTail + chunk).slice(-65536);
        });
        const forward = signal => { try { child.kill(signal); } catch {} };
        const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM');
        process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
        child.on('error', error => {
            process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
            resolvePromise({ exitCode: 1, error: error.message });
        });
        child.on('close', code => {
            process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
            resolvePromise({ exitCode: code ?? 1, error: code === 0 ? null
                : `Collector exited with status ${code}${stderrTail ? `: ${stderrTail.trim().slice(-2000)}` : ''}` });
        });
    });
}

if (action === 'plan') {
    if (!values.config || !values.id || !values['baseline-preflight']) throw new Error('plan requires --config, --id, and --baseline-preflight');
    const pairs = Number(values.pairs);
    if (!Number.isSafeInteger(pairs) || pairs < 2) throw new Error('--pairs must be a positive even integer within the plan limits');
    const wrapper = await createPerfAcceptanceSeries({
        configPath: values.config,
        planPath: values.plan,
        id: values.id,
        kind: values.kind,
        pairs,
        seed: values.seed,
        baselinePreflightPath: values['baseline-preflight'],
        candidatePreflightPath: values['candidate-preflight'],
    }, { inspectVariant });
    console.log(JSON.stringify({ plan: resolve(values.plan), planHash: wrapper.plan.hash, slots: wrapper.plan.slots.length,
        kind: wrapper.plan.kind, seed: wrapper.plan.seed }, null, 2));
} else if (action === 'run') {
    const result = await runPerfAcceptanceSeries(values.plan, { resume: values.resume, run: values.run }, {
        runSlot,
        onResume: ({ count, nextSlot }) => {
            if (count > 0) process.stderr.write(`Resuming after ${count} accepted receipts; next ${nextSlot?.label ?? 'series complete'}\n`);
        },
    });
    console.log(JSON.stringify({ complete: result.complete, resumed: result.resumed || 0,
        receiptCount: result.receipts.length, receiptLabels: result.receipts.map(receipt => receipt.label).filter(Boolean),
        ...(result.stoppedAt === undefined ? {} : { stoppedAt: result.stoppedAt }),
        ...(result.reason ? { reason: result.reason } : {}) }, null, 2));
    if (!result.complete) process.exitCode = 1;
} else {
    const { wrapper } = await readPerfAcceptanceSeries(values.plan);
    const verdict = await comparePerfAcceptanceSeries(values.plan);
    console.log(JSON.stringify(verdict, null, 2));
    if (!perfAcceptanceSeriesPassed(wrapper.plan.kind, verdict)) process.exitCode = 1;
}
