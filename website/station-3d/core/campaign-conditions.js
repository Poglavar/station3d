// Evaluates the deliberately small, data-only condition language used by
// campaign definitions. Conditions never execute authored JavaScript.

import { finiteOrNull } from './math.js';

const OWN = Object.prototype.hasOwnProperty;

function readPath(value, path) {
    const parts = String(path || '').split('.').filter(Boolean);
    let current = value;
    for (const part of parts) {
        if (current == null || !OWN.call(Object(current), part)) return undefined;
        current = current[part];
    }
    return current;
}

function compare(actual, rule) {
    if (OWN.call(rule, 'equals')) return Object.is(actual, rule.equals);
    if (Array.isArray(rule.oneOf)) return rule.oneOf.some(value => Object.is(actual, value));
    if (OWN.call(rule, 'exists')) return rule.exists ? actual !== undefined : actual === undefined;
    const actualNumber = finiteOrNull(actual);
    const minimum = finiteOrNull(rule.atLeast);
    const maximum = finiteOrNull(rule.atMost);
    if (minimum != null) return actualNumber != null && actualNumber >= minimum;
    if (maximum != null) return actualNumber != null && actualNumber <= maximum;
    return !!actual;
}

export function evaluateCampaignCondition(condition, { run = {}, event = {} } = {}) {
    if (condition == null) return true;
    if (typeof condition === 'boolean') return condition;
    if (Array.isArray(condition)) {
        return condition.every(entry => evaluateCampaignCondition(entry, { run, event }));
    }
    if (typeof condition !== 'object') return false;
    if (Array.isArray(condition.all)) {
        return condition.all.every(entry => evaluateCampaignCondition(entry, { run, event }));
    }
    if (Array.isArray(condition.any)) {
        return condition.any.some(entry => evaluateCampaignCondition(entry, { run, event }));
    }
    if (OWN.call(condition, 'not')) {
        return !evaluateCampaignCondition(condition.not, { run, event });
    }
    if (typeof condition.flag === 'string') {
        return compare(run.flags?.[condition.flag], condition);
    }
    if (typeof condition.inventory === 'string') {
        const count = Number(run.inventory?.[condition.inventory]) || 0;
        return count >= Math.max(1, Number(condition.countAtLeast) || 1);
    }
    if (typeof condition.objective === 'string') {
        const completed = (run.completedObjectives || []).includes(condition.objective);
        return completed === (condition.completed !== false);
    }
    if (typeof condition.scene === 'string') {
        const completed = (run.completedScenes || []).includes(condition.scene);
        return completed === (condition.completed !== false);
    }
    if (condition.event && typeof condition.event === 'object') {
        return compare(readPath(event, condition.event.field), condition.event);
    }
    if (condition.choice && typeof condition.choice === 'object') {
        return compare(readPath(run.choices || {}, condition.choice.field), condition.choice);
    }
    return false;
}

export function validateCampaignCondition(condition, path = 'condition') {
    const errors = [];
    const visit = (value, currentPath) => {
        if (value == null || typeof value === 'boolean') return;
        if (Array.isArray(value)) {
            value.forEach((entry, index) => visit(entry, `${currentPath}[${index}]`));
            return;
        }
        if (typeof value !== 'object') {
            errors.push(`${currentPath} must be a condition object.`);
            return;
        }
        const compoundKeys = ['all', 'any'].filter(key => OWN.call(value, key));
        if (compoundKeys.length > 0) {
            for (const key of compoundKeys) {
                if (!Array.isArray(value[key]) || value[key].length === 0) {
                    errors.push(`${currentPath}.${key} must be a non-empty array.`);
                } else {
                    value[key].forEach((entry, index) => visit(entry, `${currentPath}.${key}[${index}]`));
                }
            }
            return;
        }
        if (OWN.call(value, 'not')) {
            visit(value.not, `${currentPath}.not`);
            return;
        }
        if (typeof value.flag === 'string'
            || typeof value.inventory === 'string'
            || typeof value.objective === 'string'
            || typeof value.scene === 'string') return;
        if (value.event && typeof value.event.field === 'string') return;
        if (value.choice && typeof value.choice.field === 'string') return;
        errors.push(`${currentPath} uses an unknown condition shape.`);
    };
    visit(condition, path);
    return errors;
}

export function campaignEventField(event, path) {
    return readPath(event, path);
}
