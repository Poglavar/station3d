// Records explicit CPU audit hit stacks for deterministic headless reclassification.
// This is geometry/classifier evidence only; it does not prove GPU visibility.
import { classifySurfaceStack } from './surface-audit.js';

export const SURFACE_AUDIT_STACK_SCHEMA = 'station3d-audit-stacks-v1';

const finite = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
    return value;
};
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const normalized = value => Array.isArray(value)
    ? value.map(normalized)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])]))
        : value;
const keyOf = value => JSON.stringify(normalized(value));

function descriptorFor(hit) {
    const descriptor = { ...hit };
    delete descriptor.y; delete descriptor.culled; delete descriptor.discarded;
    return descriptor;
}

export function createSurfaceAuditRecording({ options = {} } = {}) {
    const descriptors = [];
    const descriptorIndex = new Map();
    const cells = [];
    return {
        recordCell({ x, z, terrainCovered = false, hits = [], expectedHits = null } = {}) {
            finite(x, 'x'); finite(z, 'z');
            if (typeof terrainCovered !== 'boolean' && terrainCovered !== null) throw new TypeError('invalid terrain coverage');
            if (!Array.isArray(hits)) throw new TypeError('hits must be an array');
            if (expectedHits !== null && !Array.isArray(expectedHits)) throw new TypeError('expected hits must be an array');
            const encode = entries => entries.map((hit) => {
                if (!hit || typeof hit !== 'object') throw new TypeError('hit must be an object');
                finite(hit.y, 'hit.y');
                if (hit.discarded !== undefined && typeof hit.discarded !== 'boolean' && hit.discarded !== null) throw new TypeError('invalid discarded value');
                const descriptor = descriptorFor(hit);
                const key = keyOf(descriptor);
                let index = descriptorIndex.get(key);
                if (index === undefined) { index = descriptors.length; descriptors.push(clone(descriptor)); descriptorIndex.set(key, index); }
                return { descriptor: index, y: hit.y, culled: hit.culled === true, discarded: hit.discarded === undefined ? false : hit.discarded };
            });
            cells.push({ x, z, terrainCovered, hits: encode(hits),
                ...(expectedHits !== null ? { expectedHits: encode(expectedHits) } : {}) });
        },
        result() { return { schema: SURFACE_AUDIT_STACK_SCHEMA, options: clone(options), descriptors: clone(descriptors), cells: clone(cells) }; },
    };
}

export function decodeSurfaceAuditCell(recording, index) {
    if (!recording || recording.schema !== SURFACE_AUDIT_STACK_SCHEMA || !Array.isArray(recording.descriptors) || !Array.isArray(recording.cells)) throw new TypeError('invalid audit recording');
    const cell = recording.cells[index];
    if (!cell) throw new RangeError('invalid audit cell index');
    finite(cell.x, 'cell.x'); finite(cell.z, 'cell.z');
    if (typeof cell.terrainCovered !== 'boolean' && cell.terrainCovered !== null) throw new TypeError('invalid terrain coverage');
    if (!Array.isArray(cell.hits)) throw new TypeError('invalid audit cell hits');
    const decode = entries => entries.map((entry) => {
        if (!Number.isInteger(entry?.descriptor) || entry.descriptor < 0 || entry.descriptor >= recording.descriptors.length) throw new TypeError('invalid descriptor reference');
        const descriptor = recording.descriptors[entry.descriptor];
        if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new TypeError('invalid descriptor');
        finite(entry.y, 'encoded hit.y');
        if (typeof entry.discarded !== 'boolean' && entry.discarded !== null) throw new TypeError('invalid discarded value');
        return { ...clone(recording.descriptors[entry.descriptor]), y: entry.y, culled: entry.culled === true, discarded: entry.discarded };
    });
    if (cell.expectedHits !== undefined && !Array.isArray(cell.expectedHits)) throw new TypeError('invalid expected audit hits');
    return { x: cell.x, z: cell.z, terrainCovered: cell.terrainCovered, hits: decode(cell.hits),
        ...(cell.expectedHits !== undefined ? { expectedHits: decode(cell.expectedHits) } : {}) };
}

export function classifyRecordedSurfaceCell(recording, index, options = {}) {
    const cell = decodeSurfaceAuditCell(recording, index);
    return classifySurfaceStack(cell.hits, { ...recording.options, ...options, terrainCovered: cell.terrainCovered,
        ...(cell.expectedHits ? { expectedHits: cell.expectedHits } : {}) });
}
