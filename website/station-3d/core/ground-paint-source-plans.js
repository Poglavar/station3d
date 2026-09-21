// Compose immutable regional paint indexes without rebuilding unchanged source
// polygons. Only material coverage is combined; receivers still own support.
import { createBoundsGrid } from './bounds-grid.js';
import { compareGroundPaint } from './ground-composite-plan.js';
import { GROUND_GENERATION_LIMITS } from './ground-generation-limits.js';

export const groundPaintCapacity = message => Object.assign(new RangeError(message), { code: 'ground-generation-capacity' });

export function* combineGroundPaintSourcePlansSteps({ receiver, plans,
    maxRegions = GROUND_GENERATION_LIMITS.paintSources.maxRegions,
    maxRecords = GROUND_GENERATION_LIMITS.paintSources.maxRecords }) {
    if (!(plans instanceof Map) || plans.size > maxRegions) throw groundPaintCapacity('Ground paint region capacity exceeded');
    const byKey = new Map(), regions = [];
    for (const [key, plan] of plans) {
        if (plan.contract !== 'station3d-ground-composite-plan-v1'
            || ['key', 'verticalBand', 'coverageRevision'].some(name => plan.receiver[name] !== receiver[name])) {
            throw new TypeError('Ground paint region belongs to another receiver');
        }
        let bounds = null;
        for (const record of plan.commands) {
            if (byKey.has(record.key)) throw new Error(`Ground paint source has competing regional owners: ${record.key}`);
            if (byKey.size >= maxRecords) throw groundPaintCapacity('Ground paint source capacity exceeded');
            byKey.set(record.key, record);
            const b = record.bounds;
            bounds = bounds ? { minX: Math.min(bounds.minX, b.minX), minZ: Math.min(bounds.minZ, b.minZ),
                maxX: Math.max(bounds.maxX, b.maxX), maxZ: Math.max(bounds.maxZ, b.maxZ) } : { ...b };
            if (byKey.size % 128 === 0) yield { phase: 'paint-region-index', records: byKey.size };
        }
        if (bounds) regions.push({ key, plan, bounds });
        yield { phase: 'paint-region-index', regions: regions.length };
    }
    const grid = createBoundsGrid(regions, { cellM: 400 });
    const commands = Object.freeze([...byKey.values()].sort(compareGroundPaint));
    return Object.freeze({ contract: 'station3d-ground-composite-plan-v1',
        receiver: Object.freeze({ key: receiver.key, verticalBand: receiver.verticalBand,
            coverageRevision: receiver.coverageRevision }), bounds: receiver.bounds,
        commands, sourceKeys: Object.freeze([...byKey.keys()]), byKey: key => byKey.get(key) || null,
        stats: Object.freeze({ regions: regions.length, records: byKey.size }),
        paintAt(x, z, binding) {
            let winner = null;
            for (const region of grid.candidatesAt(x, z)) {
                const record = region.plan.paintAt(x, z, binding);
                if (record && (!winner || compareGroundPaint(record, winner) > 0)) winner = record;
            }
            return winner;
        },
        commandsInBounds(bounds) {
            const found = [];
            for (const region of grid.candidatesInBox(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ)) {
                found.push(...region.plan.commandsInBounds(bounds));
            }
            return found.sort(compareGroundPaint);
        },
    });
}
