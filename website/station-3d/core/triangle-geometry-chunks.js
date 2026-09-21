// Splits unindexed triangle buffers into bounded upload ranges without cutting
// a triangle. Renderers can use the same ranges for position and UV attributes.

export function trianglePositionChunkRanges(
    positionValueCount,
    { maxVertices = 24_000 } = {},
) {
    const completePositionValues = Math.floor(
        Math.max(0, Number(positionValueCount) || 0) / 9,
    ) * 9;
    if (completePositionValues === 0) return [];
    const requestedVertices = Math.max(3, Math.floor(Number(maxVertices) || 24_000));
    const maxPositionValues = Math.max(9, Math.floor(requestedVertices / 3) * 9);
    const ranges = [];
    for (let start = 0; start < completePositionValues; start += maxPositionValues) {
        ranges.push({
            positionStart: start,
            positionEnd: Math.min(completePositionValues, start + maxPositionValues),
            uvStart: start / 3 * 2,
            uvEnd: Math.min(completePositionValues, start + maxPositionValues) / 3 * 2,
        });
    }
    return ranges;
}
