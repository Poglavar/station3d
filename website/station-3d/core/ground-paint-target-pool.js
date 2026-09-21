import { createGroundPaintTarget } from './ground-paint-page-three.js';

// Shared retained pages plus ONE successor use a fixed target pool. A retired
// page returns its target only after the publication boundary releases it;
// repeated movement does not allocate a fresh GPU texture every time.
export function createGroundPaintTargetPool({ size, maxTargets, maxTextureBytes }) {
    if (![size, maxTargets, maxTextureBytes].every(n => Number.isSafeInteger(n) && n > 0)) {
        throw new TypeError('Explicit ground paint pool dimensions and byte budget required');
    }
    const bytesPerTarget = size * size;
    if (bytesPerTarget * maxTargets > maxTextureBytes) throw new RangeError('Ground paint target budget exceeded');
    const free = Array.from({ length: maxTargets }, (_, i) => maxTargets - 1 - i);
    let target = null;
    let closed = false, leased = 0;
    return Object.freeze({
        acquire() {
            if (closed) throw new Error('Ground paint target pool is closed');
            if (!free.length) return null;
            target ||= createGroundPaintTarget(size, maxTargets);
            const layer = free.pop(); leased++;
            let released = false;
            return Object.freeze({ target, layer,
                get released() { return released || closed; },
                release() {
                    if (released) return false;
                    released = true; leased--;
                    if (!closed) free.push(layer);
                    return true;
                },
            });
        },
        stats() { return Object.freeze({ closed, targets: target ? 1 : 0, layers: target ? maxTargets : 0,
            leased: closed ? 0 : leased, free: closed ? 0 : free.length,
            textureBytes: target ? maxTargets * bytesPerTarget : 0, maxTextureBytes: bytesPerTarget * maxTargets }); },
        dispose() {
            if (closed) return false;
            closed = true;
            target?.dispose(); target = null; free.length = 0;
            return true;
        },
    });
}
