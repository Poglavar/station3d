// Simulation admission limits. Renderer resolution/DPR do not participate in
// source selection, dependency closure or support. These are hard ceilings,
// not preallocations; a rejected successor retains the complete active world.
const MiB = 1024 ** 2;
const ROAD_GENERATION_MAX_OWNERS = 16384;
const GROUND_GENERATION_MAX_BUCKETS = 256;
// Road receiver buckets are counted across a whole generation, and the count
// is the union of the buckets a changed owner leaves and the ones it joins —
// so a moving camera charges both sides of every re-bucketed road. Split's
// waterfront reached 257 against the shared 256 and had its entire generation
// rejected (2026-09-16), taking the coast collar with it. Buckets are merged
// draw groups, one Map entry each; maxGeometryBytes below is the real memory
// bound, so the ceiling only has to stay far enough ahead of a dense
// city-centre pass to keep that from being the thing that fails.
const ROAD_RECEIVER_MAX_BUCKETS = 2048;
export const GROUND_GENERATION_LIMITS = Object.freeze({
    terrainPublication: Object.freeze({ tileM: 400, maxTiles: 256, maxChangedTiles: 128,
        maxSnapshots: 32, maxReadSnapshots: 2048, maxSourceBytes: 256 * MiB,
        maxReceiverBytes: 512 * MiB, maxSegments: 400 }),
    roadAdmission: Object.freeze({ maxFeatures: ROAD_GENERATION_MAX_OWNERS }),
    // A coherent ground generation replaces multiple road aggregate groups.
    // A native turn into a second streaming corridor exceeded the ordinary
    // publisher's 32 MiB group limit. Bound the complete candidate separately;
    // ordinary groups and individual upload slices retain their own limits.
    roadReceivers: Object.freeze({ maxOwners: ROAD_GENERATION_MAX_OWNERS, maxBuckets: ROAD_RECEIVER_MAX_BUCKETS,
        maxSourceTiles: 256, maxGeometryBytes: 64 * MiB }),
    // Paint must admit a complete receiver group. A source can move from an
    // old region to a new one in the same transaction; both changes count,
    // while the final retained index remains within the smaller live limit.
    paintSources: Object.freeze({ maxRegions: GROUND_GENERATION_MAX_BUCKETS, maxRecords: 4096,
        maxChangedRegions: GROUND_GENERATION_MAX_BUCKETS * 2, maxReplacements: 8192 }),
    roadFootprint: Object.freeze({ maxTriangles: 32768 }),
    railAdmission: Object.freeze({ maxFeatures: 4096 }),
    railConstruction: Object.freeze({ maxSegments: 262144, maxProfiles: 8192, maxProfilePoints: 1048576 }),
    alignmentSources: Object.freeze({ maxFeatures: 16384,
        maxDependencyEntries: 32768, maxDependencyBounds: 131072 }),
    railOwnership: Object.freeze({ maxCrossings: 8192, maxOpenings: 8192,
        maxDependencyEntries: 32768, maxDependencyBounds: 131072 }),
    structures: Object.freeze({ maxAlignments: 512, maxSamples: 262144, maxObjects: 8192, maxGeometryBytes: 64 * MiB,
        maxVertices: 1048576, maxTriangles: 524288 }),
    railReceivers: Object.freeze({ maxSegments: 262144, maxCells: 2048 }),
    curbs: Object.freeze({ maxTiles: 256 }),
    ownership: Object.freeze({ radiusM: 1600 * Math.SQRT2, maxProfiles: 16384, maxRegions: 16384 }),
    openings: Object.freeze({ maxRegions: 8192, maxSourceVertices: 65536, maxCandidates: 256, maxFragments: 16384 }),
    openingSupport: Object.freeze({ maxObjects: 8192, maxVertices: 262144, maxTriangles: 131072 }),
    stations: Object.freeze({ maxGeometryBytes: 32 * MiB }),
    water: Object.freeze({ maxSourceVertices: 65536, maxOperandVertices: 8192,
        maxIntersections: 16384, maxOutputTriangles: 8192, maxGeometryBytes: 16 * MiB }),
    support: Object.freeze({ maxSources: 16384, maxSurfaces: 16384, maxFaces: 1048576,
        maxIndexEntries: 4194304, maxPointCandidates: 4096 }),
    cutout: Object.freeze({ limits: Object.freeze({ maxSources: 32768, maxSourceVertices: 1048576,
        maxIndexEntries: 4194304, maxCellCandidates: 4096, maxOperandVertices: 16384,
        maxIntersections: 65536, maxOutputTriangles: 1048576 }), maxVertices: 1048576, maxTriangles: 1048576 }),
    terrain: Object.freeze({ maxGeometryBytes: 256 * MiB }),
});
