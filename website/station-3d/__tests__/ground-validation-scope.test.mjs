import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';

// Execute the production scope wrapper without importing world/scene globals.
// The injected compiler exposes one shared source lease to many independent
// entries; the real registry still checks every entry and the complete group.
const source = readFileSync(new URL('../world/ground-generations.js', import.meta.url), 'utf8');
const wrapper = source.slice(source.indexOf('export function* prepareWorldGroundGenerationSteps'),
    source.indexOf('function* prepareWorldGroundGraphSteps')).replace('export ', '');
const make = Function('prepareWorldGroundGraphSteps', `${wrapper}; return prepareWorldGroundGenerationSteps;`);

test('ground validation shares only synchronous source reads and rechecks every publication phase', () => {
    const registry = createSurfacePublicationRegistry();
    let sourceCurrent = true, sourceChecks = 0, entryChecks = 0;
    const compile = make(function* ({ checkSources }) {
        const current = () => checkSources(() => { sourceChecks++; return sourceCurrent; });
        assert.equal(current(), true); assert.equal(current(), true);
        yield { phase: 'first' };
        assert.equal(current(), true); assert.equal(current(), true);
        const entries = Array.from({ length: 64 }, (_, i) => ({
            ticket: registry.begin({ key: `receiver:${i}`, generation: 1 }), clear: true,
            isCurrent: () => { entryChecks++; return current(); }, commit: () => true,
        }));
        return { entries, isCurrent: () => entries.every(entry => entry.isCurrent()) };
    });
    const steps = compile({});
    assert.equal(steps.next().done, false); assert.equal(sourceChecks, 1);
    const { value: candidate, done } = steps.next();
    assert.equal(done, true); assert.equal(sourceChecks, 2, 'a yielded visit cannot reuse the previous lease check');
    candidate.entries[0].isCurrent(); candidate.entries[0].isCurrent();
    assert.equal(sourceChecks, 4, 'unscoped reads are never cached');
    assert.equal(candidate.isCurrent(), true); assert.equal(sourceChecks, 5);
    entryChecks = 0;
    const batch = registry.prepareBatch(candidate.entries, candidate);
    assert.equal(batch.state, 'staged'); assert.equal(sourceChecks, 6);
    assert.equal(entryChecks, 128, 'each row plus every group member is still validated');
    sourceCurrent = false;
    assert.equal(batch.publish().status, 'dependency-revised');
    assert.equal(sourceChecks, 7, 'publication checks the changed source instead of a preparation result');
    assert.equal(registry.snapshot().pendingCount, 0);
    assert.equal(candidate.isCurrent(), false); assert.equal(sourceChecks, 8);
    registry.close();
});

test('ground scope clears cached source reads after nested checks and exceptions', () => {
    let current = true, checks = 0;
    const compile = make(function* ({ checkSources }) {
        return { entries: [], isCurrent: () => checkSources(() => { checks++; return current; }) };
    });
    const candidate = compile({}).next().value;
    assert.throws(() => candidate.withValidationScope(() => {
        assert.equal(candidate.isCurrent(), true);
        assert.equal(candidate.isCurrent(), true);
        throw new Error('validation interrupted');
    }), /validation interrupted/);
    assert.equal(checks, 1);
    current = false;
    assert.equal(candidate.isCurrent(), false); assert.equal(checks, 2);
});

test('consumer road validity is shared within a compiler visit but renewed after yields and at the boundary', () => {
    let valid = true, checks = 0;
    const registry = createSurfacePublicationRegistry();
    const validateRoad = () => { checks++; return valid; };
    const compile = make(function* ({ checkRead }) {
        const current = () => checkRead(validateRoad);
        // Terrain support checks validity before each cell, evidence knot and
        // triangle. That is many reads but only one uninterrupted compiler visit.
        for (let i = 0; i < 10000; i++) assert.equal(current(), true);
        yield { phase: 'terrain-support-triangle' };
        for (let i = 0; i < 10000; i++) assert.equal(current(), true);
        return { entries: [{ ticket: registry.begin({ key: 'physics', generation: 1 }), clear: true,
            isCurrent: current, commit() { assert.fail('expired read cannot publish'); } }], isCurrent: current };
    });
    const steps = compile({});
    assert.equal(steps.next().done, false); assert.equal(checks, 1);
    const candidate = steps.next().value; assert.equal(checks, 2, 'the second visit rechecks the dependency closure');
    const batch = registry.prepareBatch(candidate.entries, candidate);
    assert.equal(batch.state, 'staged'); assert.equal(checks, 3);
    valid = false;
    assert.equal(batch.publish().status, 'dependency-revised'); assert.equal(checks, 4);
    assert.equal(candidate.isCurrent(), false); assert.equal(checks, 5);
    assert.throws(() => candidate.withValidationScope(() => {
        candidate.isCurrent(); throw Error('cancelled');
    }), /cancelled/);
    valid = true;
    assert.equal(candidate.isCurrent(), true); assert.equal(checks, 7, 'exceptions cannot retain validation results');
    registry.close();
});
