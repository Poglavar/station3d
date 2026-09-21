// Shared support-placement policy for every viaduct renderer. Geometry and OSM
// lookup stay with the caller; this module only chooses structurally plausible
// clear positions along an ordered alignment.

export const DEFAULT_PILLAR_PLACEMENT = Object.freeze({
    slideStepM: 2,
    slideMaxM: 20,
    nominalSpacingM: 30,
    maxSpanM: 95,
});

// A resolved support is a new structural station, not merely a moved footing.
// Callers must derive the shaft, cap, bearings, and other support-local pieces
// from its resolved x/z. In particular, do not call a sample's captured
// `point()` closure after placement: that closure still belongs to the nominal
// row and leaves the cap floating beside a slid shaft.
export function pointAtPlacedSupport(sample, lateralOffsetM = 0, y = sample?.y) {
    const offsetM = Number(lateralOffsetM) || 0;
    return {
        x: Number(sample?.x) + (Number(sample?.nx) || 0) * offsetM,
        y: Number(y),
        z: Number(sample?.z) + (Number(sample?.nz) || 0) * offsetM,
    };
}

export function resolveIntelligentPillarSamples(samples, clearanceAt, {
    slideStepM = DEFAULT_PILLAR_PLACEMENT.slideStepM,
    slideMaxM = DEFAULT_PILLAR_PLACEMENT.slideMaxM,
    nominalSpacingM = DEFAULT_PILLAR_PLACEMENT.nominalSpacingM,
    maxSpanM = DEFAULT_PILLAR_PLACEMENT.maxSpanM,
} = {}) {
    if (!Array.isArray(samples) || samples.length === 0) return [];
    if (typeof clearanceAt !== 'function') {
        return samples.map((sample, sourceIndex) => ({ ...sample, sourceIndex, placement: 'kept' }));
    }

    const out = [];
    let lastKeptS = null;
    for (let index = 0; index < samples.length; index++) {
        const sample = samples[index];
        const s = Number(sample.s) || 0;
        const initialScore = clearanceAt(sample.x, sample.z);
        if (initialScore >= 0) {
            out.push({ ...sample, sourceIndex: index, placement: 'kept' });
            lastKeptS = s;
            continue;
        }

        const neighbour = samples[index + 1] || samples[index - 1];
        let dx = Number(sample.ux);
        let dz = Number(sample.uz);
        if (!Number.isFinite(dx) || !Number.isFinite(dz)) {
            dx = neighbour ? (index + 1 < samples.length
                ? neighbour.x - sample.x : sample.x - neighbour.x) : 0;
            dz = neighbour ? (index + 1 < samples.length
                ? neighbour.z - sample.z : sample.z - neighbour.z) : 0;
        }
        const directionLength = Math.hypot(dx, dz) || 1;
        dx /= directionLength;
        dz /= directionLength;

        let placed = null;
        let best = { score: initialScore, x: sample.x, z: sample.z };
        for (let offset = slideStepM; offset <= slideMaxM && !placed; offset += slideStepM) {
            for (const sign of [1, -1]) {
                const x = sample.x + dx * offset * sign;
                const z = sample.z + dz * offset * sign;
                const score = clearanceAt(x, z);
                if (score > best.score) best = { score, x, z };
                if (score >= 0) {
                    placed = {
                        ...sample,
                        x,
                        z,
                        s: s + offset * sign,
                        sourceIndex: index,
                        placement: 'slid',
                    };
                    break;
                }
            }
        }
        if (placed) {
            out.push(placed);
            lastKeptS = placed.s;
            continue;
        }

        const endpoint = index === 0 || index === samples.length - 1;
        const nextS = samples[index + 1]
            ? Number(samples[index + 1].s) || (s + nominalSpacingM)
            : s + nominalSpacingM;
        const gapIfSkipped = lastKeptS == null ? Infinity : nextS - lastKeptS;
        if (!endpoint && gapIfSkipped <= maxSpanM) continue;

        out.push({
            ...sample,
            x: best.x,
            z: best.z,
            sourceIndex: index,
            placement: 'forced',
        });
        lastKeptS = s;
    }
    return out;
}
