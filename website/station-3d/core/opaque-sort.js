// Opaque draw order that groups draws by compiled program inside each render
// order. three's default groups by material id, but many materials share one
// program (clones, atlas pages, per-tile aggregates), so the dense Zagreb walk
// switched programs ~160 times a frame across ~83 programs (2026-09-23), each
// switch re-binding the program and re-uploading its uniforms. groupOrder and
// renderOrder stay first: ground stencil ownership depends on them.

// programOf(material) returns a stable numeric id for the material's current
// program, or null before its first compile.
export function createProgramGroupedOpaqueSort(programOf) {
    if (typeof programOf !== 'function') throw new TypeError('Opaque sort requires a program lookup');
    return function programGroupedOpaqueSort(a, b) {
        if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
        if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
        const pa = programOf(a.material), pb = programOf(b.material);
        if (pa !== pb) {
            // Uncompiled materials sort after compiled ones; they compile this frame.
            if (pa == null) return 1;
            if (pb == null) return -1;
            return pa - pb;
        }
        if (a.material.id !== b.material.id) return a.material.id - b.material.id;
        if (a.materialVariant !== b.materialVariant) return (a.materialVariant | 0) - (b.materialVariant | 0);
        if (a.z !== b.z) return a.z - b.z;
        return a.id - b.id;
    };
}

// Program id lookup through three's renderer.properties (no-op-safe).
export function rendererProgramLookup(renderer) {
    return material => renderer.properties.get(material)?.currentProgram?.id ?? null;
}
