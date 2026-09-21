// Reusable allocation-stable broad phase for frequently rebuilt world-space point sets.

export function createPointSpatialIndex(cellSizeM = 10) {
    const cellSize = Number(cellSizeM);
    if (!(cellSize > 0)) throw new Error('Spatial index cell size must be positive');
    const columns = new Map();
    const cellPool = [];
    const columnPool = [];

    function clear() {
        for (const column of columns.values()) {
            for (const cell of column.values()) {
                cell.length = 0;
                cellPool.push(cell);
            }
            column.clear();
            columnPool.push(column);
        }
        columns.clear();
    }

    function add(item, x, z) {
        if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
        const cellX = Math.floor(x / cellSize);
        const cellZ = Math.floor(z / cellSize);
        let column = columns.get(cellX);
        if (!column) {
            column = columnPool.pop() || new Map();
            columns.set(cellX, column);
        }
        let cell = column.get(cellZ);
        if (!cell) {
            cell = cellPool.pop() || [];
            column.set(cellZ, cell);
        }
        cell.push(item);
        return true;
    }

    function forEachInBounds(minX, minZ, maxX, maxZ, visit) {
        if (typeof visit !== 'function') return false;
        const safeMinX = Math.min(Number(minX), Number(maxX));
        const safeMaxX = Math.max(Number(minX), Number(maxX));
        const safeMinZ = Math.min(Number(minZ), Number(maxZ));
        const safeMaxZ = Math.max(Number(minZ), Number(maxZ));
        if (![safeMinX, safeMaxX, safeMinZ, safeMaxZ].every(Number.isFinite)) return false;
        const minCellX = Math.floor(safeMinX / cellSize);
        const maxCellX = Math.floor(safeMaxX / cellSize);
        const minCellZ = Math.floor(safeMinZ / cellSize);
        const maxCellZ = Math.floor(safeMaxZ / cellSize);
        for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
            const column = columns.get(cellX);
            if (!column) continue;
            for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
                const cell = column.get(cellZ);
                if (!cell) continue;
                for (const item of cell) {
                    if (visit(item) === true) return true;
                }
            }
        }
        return false;
    }

    return { add, clear, forEachInBounds };
}
