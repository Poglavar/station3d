// Shared physical road dimensions and sample frames for structures and their
// terrain openings. A profile-association radius is not a physical width.
export const DEFAULT_ROAD_HALF_WIDTH_M = 4.5;
export const DEFAULT_FORMATION_HALF_WIDTH_M = 6;

function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

export function roadStructureRoadHalfWidthM(definition) {
    return positive(definition?.crossSection?.carriagewayHalfWidthM)
        ?? (positive(definition?.widthM) ?? DEFAULT_ROAD_HALF_WIDTH_M * 2) * .5;
}

export function roadStructureFormationHalfWidthM(definition) {
    return positive(definition?.crossSection?.formationHalfWidthM)
        ?? positive(definition?.corridorHalfWidthM)
        ?? Math.max(DEFAULT_FORMATION_HALF_WIDTH_M, roadStructureRoadHalfWidthM(definition) + 1.5);
}

export function roadStructureHalfWidths(alignment) {
    return {
        roadHalfWidthM: roadStructureRoadHalfWidthM(alignment?.definition),
        formationHalfWidthM: roadStructureFormationHalfWidthM(alignment?.definition),
    };
}

export function roadStructureSampleFrame(samples, index) {
    const before = samples[Math.max(0, index - 1)];
    const after = samples[Math.min(samples.length - 1, index + 1)];
    const dx = after.x - before.x, dz = after.z - before.z;
    const length = Math.hypot(dx, dz) || 1;
    const ux = dx / length, uz = dz / length;
    return { ux, uz, nx: -uz, nz: ux };
}
