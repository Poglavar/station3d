// Reproducible cut, fill, shared wall and clipped opening inputs for the frozen
// pre-scheduling geometry capture and the production dressing integration test.
export function dressingProfiles() {
    const ring = (count, cx, cz, radius, height) => Array.from({ length: count }, (_, index) => {
        const angle = index * 2 * Math.PI / count;
        const x = Math.cos(angle), z = Math.sin(angle);
        const terrainY = height(index);
        return { innerX: cx + x * radius, innerZ: cz + z * radius, roadY: .2 * z,
            outerX: cx + x * (radius + 2), outerZ: cz + z * (radius + 2),
            terrainY, wallTerrainY: terrainY - .4,
            cutoutX: cx + x * (radius + 2), cutoutZ: cz + z * (radius + 2),
            cutoutTerrainY: terrainY + .25,
            overlapX: cx + x * (radius + 2.3), overlapZ: cz + z * (radius + 2.3),
            overlapTerrainY: terrainY + 2 * Math.sin(angle), surfaceApronWidthM: .7 };
    });
    return [
        { points: ring(1800, 0, 0, 90, i => i < 900 ? 3 : -2), wallTopUnderlapM: .1,
            bounds: { minX: -93, maxX: 93, minZ: -93, maxZ: 93 } },
        { points: ring(8, 20, 0, 8, () => 4), verticalRetainedWalls: true,
            internalSegments: [false, true], sharedRetainingWallSegments: [false, false, true],
            collarInternalSegments: [false, false, false, true],
            terrainReplacementBackstopSegments: [false, false, false, false, true],
            roadOpeningSegmentRanges: [[[.25, .7]], [], [], [], [], [[0, .2], [.8, 1]]] },
        // Existing wall collider ownership covers complete profiles even when
        // the visual window omits this distant mesh. Scheduling preserves it.
        { points: ring(4, 1000, 1000, 4, () => 3),
            bounds: { minX: 994, maxX: 1006, minZ: 994, maxZ: 1006 } },
    ];
}
