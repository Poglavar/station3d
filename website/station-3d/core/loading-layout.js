// Turn relative loading-work weights into fixed grid spans. A single CSS flex
// row distributes its spare width among only the items on that row, which made
// an orphaned final component appear to represent the whole load. These plans
// keep one global scale across rows: wrapping changes placement, never meaning.

function positiveWeight(value, fallback = 1) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function partitionRows(weights, requestedRows, maxItemsPerRow) {
    const count = weights.length;
    if (count === 0) return [];
    const rowCount = Math.max(
        1,
        Math.min(count, Math.max(requestedRows, Math.ceil(count / maxItemsPerRow))),
    );
    const prefix = [0];
    for (const weight of weights) prefix.push(prefix.at(-1) + weight);

    // Ordered linear partition: minimize the heaviest row without reordering
    // labels. The component list itself carries the loading pipeline order.
    const costs = Array.from(
        { length: rowCount + 1 },
        () => Array(count + 1).fill(Infinity),
    );
    const previous = Array.from(
        { length: rowCount + 1 },
        () => Array(count + 1).fill(-1),
    );
    costs[0][0] = 0;
    for (let rows = 1; rows <= rowCount; rows++) {
        for (let end = rows; end <= count; end++) {
            const firstStart = Math.max(rows - 1, end - maxItemsPerRow);
            for (let start = firstStart; start < end; start++) {
                if (!Number.isFinite(costs[rows - 1][start])) continue;
                const rowWeight = prefix[end] - prefix[start];
                const cost = Math.max(costs[rows - 1][start], rowWeight);
                if (cost < costs[rows][end]) {
                    costs[rows][end] = cost;
                    previous[rows][end] = start;
                }
            }
        }
    }

    const ranges = [];
    let end = count;
    for (let rows = rowCount; rows > 0; rows--) {
        const start = previous[rows][end];
        // The row-count/capacity constraints above guarantee a solution. Keep
        // a defensive fallback so malformed options still produce a layout.
        if (start < 0) return [[0, count]];
        ranges.unshift([start, end]);
        end = start;
    }
    return ranges;
}

function scaleForRows(weights, ranges, columns, minimumSpan) {
    let low = 0;
    let high = columns / Math.min(...weights);
    for (let iteration = 0; iteration < 48; iteration++) {
        const scale = (low + high) / 2;
        const fits = ranges.every(([start, end]) => {
            let used = 0;
            for (let index = start; index < end; index++) {
                used += Math.max(minimumSpan, weights[index] * scale);
            }
            return used <= columns;
        });
        if (fits) low = scale;
        else high = scale;
    }
    return low;
}

export function loadingGridPlan(items, {
    columns = 24,
    targetRows = 2,
    minimumSpan = 4,
    fallbackWeight = 800,
} = {}) {
    const safeColumns = Math.max(1, Math.floor(positiveWeight(columns)));
    const safeMinimum = Math.max(
        1,
        Math.min(safeColumns, Math.floor(positiveWeight(minimumSpan))),
    );
    const weights = (Array.isArray(items) ? items : []).map(item => (
        positiveWeight(item?.weight, fallbackWeight)
    ));
    if (weights.length === 0) return [];

    const maxItemsPerRow = Math.max(1, Math.floor(safeColumns / safeMinimum));
    const ranges = partitionRows(
        weights,
        Math.max(1, Math.floor(positiveWeight(targetRows))),
        maxItemsPerRow,
    );
    const scale = scaleForRows(weights, ranges, safeColumns, safeMinimum);
    const rowStarts = new Set(ranges.slice(1).map(([start]) => start));

    return weights.map((weight, index) => ({
        span: Math.min(
            safeColumns,
            Math.max(safeMinimum, Math.floor(weight * scale)),
        ),
        breakBefore: rowStarts.has(index),
    }));
}
