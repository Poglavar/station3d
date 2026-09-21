// Preserve the exact ribbon quads while splitting large cycle contributions
// into bounded colour records. Adjacent quads are batched by the page compiler.
import { createGroundSurfacePaintRecordSteps } from './ground-surface-paint.js';
import { groundPaintCapacity } from './ground-paint-source-plans.js';
import { SURFACE_CLASS } from './surface-hierarchy.js';

export function* createGroundBikePaintRecordsSteps({ quads, identity, receiver, claim,
    materialKey, materialRevision, maxRecords = 7 }) {
    if (claim?.surfaceClass !== SURFACE_CLASS.CYCLEWAY) throw new TypeError('Cycle paint requires a cycleway claim');
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 8) throw new TypeError('Invalid cycle paint record capacity');
    if (quads.length > maxRecords * 2048) throw groundPaintCapacity('Cycle paint owner capacity exceeded');
    const records = [];
    for (let start = 0; start < quads.length; start += 2048) {
        const coordinates = [];
        for (let index = start; index < Math.min(quads.length, start + 2048); index++) {
            coordinates.push([quads[index].map(point => [point.x, point.z])]);
            if ((index + 1) % 32 === 0) yield { phase: 'cycle-paint-quads' };
        }
        records.push(yield* createGroundSurfacePaintRecordSteps({ geometry: { type: 'MultiPolygon', coordinates },
            identity: { key: `${identity.key}:cycle-paint:${records.length}`, revisionKey: identity.revisionKey },
            receiver, claim, materialKey, materialRevision, sourcePriority: 1, project: (x, z) => ({ x, z }) }));
    }
    return Object.freeze(records);
}
