// Pure deterministic raster generation for traditional Dalmatian limestone
// masonry. Large staggered stones, uneven joints, and warm mineral variation
// are encoded without browser canvas so rendering and headless QA share it.

function mixUint32(value) {
    let hash = value >>> 0;
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x7feb352d);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x846ca68b);
    hash ^= hash >>> 16;
    return hash >>> 0;
}

function unit(seed, a, b = 0) {
    return mixUint32((seed >>> 0) ^ Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) / 0x100000000;
}

function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function positiveModulo(value, modulus) {
    return ((value % modulus) + modulus) % modulus;
}

function buildRow(size, row, seed) {
    const count = 6 + Math.floor(unit(seed, row, 1) * 3);
    const weights = [];
    let total = 0;
    for (let index = 0; index < count; index++) {
        const weight = 0.68 + unit(seed, row * 31 + index, 2) * 0.74;
        weights.push(weight);
        total += weight;
    }
    const boundaries = [0];
    let cursor = 0;
    for (const weight of weights) {
        cursor += size * weight / total;
        boundaries.push(cursor);
    }
    return {
        boundaries,
        shift: unit(seed, row, 3) * size,
        phase: unit(seed, row, 4) * Math.PI * 2,
    };
}

function findStoneIndex(boundaries, x) {
    for (let index = 0; index < boundaries.length - 1; index++) {
        if (x >= boundaries[index] && x < boundaries[index + 1]) return index;
    }
    return boundaries.length - 2;
}

export function createDalmatianStoneRaster(size = 256, seed = 0x57a0e) {
    const safeSize = Math.max(16, Math.round(Number(size) || 256));
    const rowCount = 7;
    const rowHeight = safeSize / rowCount;
    const rows = Array.from({ length: rowCount }, (_value, row) => buildRow(safeSize, row, seed));
    const color = new Uint8Array(safeSize * safeSize * 4);
    const height = new Uint8Array(safeSize * safeSize * 4);

    for (let y = 0; y < safeSize; y++) {
        const row = Math.min(rowCount - 1, Math.floor(y / rowHeight));
        const rowLocalY = y - row * rowHeight;
        const rowInfo = rows[row];
        for (let x = 0; x < safeSize; x++) {
            const horizontalWave = Math.sin((x / safeSize) * Math.PI * 4 + rowInfo.phase) * 1.25;
            const horizontalDistance = Math.min(
                Math.abs(rowLocalY + horizontalWave),
                Math.abs(rowHeight - rowLocalY - horizontalWave),
            );
            const xWobble = Math.sin((rowLocalY / rowHeight) * Math.PI * 2 + rowInfo.phase) * 1.1;
            const shiftedX = positiveModulo(x + rowInfo.shift + xWobble, safeSize);
            const stone = findStoneIndex(rowInfo.boundaries, shiftedX);
            const left = rowInfo.boundaries[stone];
            const right = rowInfo.boundaries[stone + 1];
            const verticalDistance = Math.min(shiftedX - left, right - shiftedX);
            const jointDistance = Math.min(horizontalDistance, verticalDistance);
            const mortar = jointDistance < 1.65;
            const edgeBlend = Math.max(0, Math.min(1, (jointDistance - 1.2) / 2.8));
            const grain = (unit(seed, x + y * safeSize, 11) - 0.5) * 18;
            const stoneTone = unit(seed, row * 19 + stone, 12);
            const mineral = unit(seed, row * 29 + stone, 13);
            const base = 174 + stoneTone * 48;
            const index = (y * safeSize + x) * 4;

            if (mortar) {
                const mortarNoise = grain * 0.35;
                color[index] = clampByte(126 + mortarNoise);
                color[index + 1] = clampByte(122 + mortarNoise);
                color[index + 2] = clampByte(111 + mortarNoise);
                height[index] = height[index + 1] = height[index + 2] = clampByte(68 + mortarNoise);
            } else {
                const warm = (mineral - 0.5) * 16;
                const weather = (1 - edgeBlend) * -12;
                color[index] = clampByte(base + warm + grain + weather);
                color[index + 1] = clampByte(base - 3 + warm * 0.52 + grain * 0.78 + weather);
                color[index + 2] = clampByte(base - 16 - warm * 0.20 + grain * 0.55 + weather);
                const relief = 160 + stoneTone * 58 + edgeBlend * 17 + grain * 0.35;
                height[index] = height[index + 1] = height[index + 2] = clampByte(relief);
            }
            color[index + 3] = 255;
            height[index + 3] = 255;
        }
    }
    return { size: safeSize, color, height };
}
