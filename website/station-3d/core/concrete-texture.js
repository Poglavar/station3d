// Pure deterministic raster generation for board-formed retaining-wall concrete.
// A flat grey field with fine grain, low-frequency staining, and faint
// horizontal form-board seams with tie-rod holes — visibly distinct from the
// coursed Dalmatian stone (no block joints) so cut walls and tunnel walls read
// as different materials. Canvas-free so rendering and headless QA share it.

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

// Smooth value noise sampled on an integer lattice of `cells` per axis.
function valueNoise(seed, x, y, cells, size) {
    const fx = (x / size) * cells;
    const fy = (y / size) * cells;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const corner = (ix, iy) => unit(seed, ((ix % cells) + cells) % cells, ((iy % cells) + cells) % cells);
    const top = corner(x0, y0) * (1 - sx) + corner(x0 + 1, y0) * sx;
    const bottom = corner(x0, y0 + 1) * (1 - sx) + corner(x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bottom * sy;
}

export function createConcreteRaster(size = 256, seed = 0x3c0c2e) {
    const safeSize = Math.max(16, Math.round(Number(size) || 256));
    const color = new Uint8Array(safeSize * safeSize * 4);
    const height = new Uint8Array(safeSize * safeSize * 4);
    const boardCount = 5;                       // horizontal form-board courses
    const boardHeight = safeSize / boardCount;

    for (let y = 0; y < safeSize; y++) {
        const boardLocalY = y - Math.floor(y / boardHeight) * boardHeight;
        // Distance to the nearest board seam (top or bottom of this course).
        const seamDistance = Math.min(boardLocalY, boardHeight - boardLocalY);
        const seam = seamDistance < 1.1;
        for (let x = 0; x < safeSize; x++) {
            const patch = valueNoise(seed, x, y, 6, safeSize);        // broad staining
            const grain = valueNoise(seed ^ 0x9e37, x, y, 48, safeSize); // fine aggregate
            const speckle = unit(seed, x + y * safeSize, 7) - 0.5;
            // Tie-rod holes: a sparse grid of small darker recesses.
            const holeX = Math.abs(((x + boardHeight * 0.5) % boardHeight) - boardHeight * 0.5);
            const tieHole = seam && holeX < 1.4 && ((Math.floor(x / boardHeight) + Math.floor(y / boardHeight)) % 2 === 0);

            let tone = 150 + (patch - 0.5) * 26 + (grain - 0.5) * 16 + speckle * 6;
            let relief = 150 + (grain - 0.5) * 22 + (patch - 0.5) * 10;
            if (seam) { tone -= 16; relief -= 30; }
            if (tieHole) { tone -= 34; relief -= 55; }
            const index = (y * safeSize + x) * 4;
            // Neutral, faintly cool grey.
            color[index] = clampByte(tone + 2);
            color[index + 1] = clampByte(tone + 1);
            color[index + 2] = clampByte(tone);
            color[index + 3] = 255;
            height[index] = height[index + 1] = height[index + 2] = clampByte(relief);
            height[index + 3] = 255;
        }
    }
    return { size: safeSize, color, height };
}

// Warmer road-retaining concrete with large vertical shutter panels, rain
// streaks, patched pours and a damp lower band. This deliberately does not
// reuse the rail wall's horizontal board courses: adjacent authorities remain
// legible even when their wall faces meet at the same civil seam.
export function createRoadRetainingConcreteRaster(size = 256, seed = 0x72d14a) {
    const safeSize = Math.max(16, Math.round(Number(size) || 256));
    const color = new Uint8Array(safeSize * safeSize * 4);
    const height = new Uint8Array(safeSize * safeSize * 4);
    const panelCount = 4;
    const panelWidth = safeSize / panelCount;

    for (let y = 0; y < safeSize; y++) {
        const vertical01 = y / Math.max(1, safeSize - 1);
        const constructionJointDistance = Math.abs(y - safeSize * 0.52);
        for (let x = 0; x < safeSize; x++) {
            const panelLocalX = x - Math.floor(x / panelWidth) * panelWidth;
            const panelJointDistance = Math.min(
                panelLocalX,
                panelWidth - panelLocalX,
            );
            const panelJoint = panelJointDistance < 1.25;
            const constructionJoint = constructionJointDistance < 1.1;
            const cloud = valueNoise(seed, x, y, 5, safeSize);
            const aggregate = valueNoise(seed ^ 0x51ad, x, y, 44, safeSize);
            // Low-frequency X-only noise becomes long runoff streaks. Modulate
            // it gently in Y so it never reads as flat wallpaper columns.
            const runoffColumn = valueNoise(seed ^ 0xb41e, x, 0, 18, safeSize);
            const runoffBreak = valueNoise(seed ^ 0x18c7, x, y, 9, safeSize);
            const runoff = Math.max(0, runoffColumn - 0.52)
                * (0.45 + vertical01 * 0.85)
                * (0.65 + runoffBreak * 0.55);
            const speckle = unit(seed ^ 0x7741, x + y * safeSize, 13) - 0.5;

            // Sparse tie recesses and their rusty downward bleed.
            const tieSpacing = panelWidth * 0.5;
            const tieX = Math.abs(((x + tieSpacing * 0.5) % tieSpacing) - tieSpacing * 0.5);
            const tieY = Math.abs(((y + safeSize * 0.17) % (safeSize * 0.34))
                - safeSize * 0.17);
            const tieHole = tieX < 1.7 && tieY < 1.7;
            const rustDrip = tieX < 1.2
                && tieY > 1.5
                && tieY < safeSize * 0.075;
            // Each repeat has a darker damp edge rather than a hard painted
            // stripe; cloud noise breaks it into irregular weathering.
            const damp = Math.max(0, (vertical01 - 0.72) / 0.28)
                * (0.55 + cloud * 0.65);

            let tone = 143
                + (cloud - 0.5) * 30
                + (aggregate - 0.5) * 13
                + speckle * 7
                - runoff * 28
                - damp * 22;
            let relief = 151
                + (aggregate - 0.5) * 25
                + (cloud - 0.5) * 8
                - runoff * 11;
            if (panelJoint) { tone -= 20; relief -= 36; }
            if (constructionJoint) { tone -= 10; relief -= 20; }
            if (tieHole) { tone -= 38; relief -= 58; }
            if (rustDrip) tone -= 10;

            const index = (y * safeSize + x) * 4;
            const rust = rustDrip ? 13 : runoff * 4;
            // Aged warm-grey concrete: enough ochre/brown to distinguish it
            // from the rail wall while remaining unmistakably concrete.
            color[index] = clampByte(tone + 10 + rust);
            color[index + 1] = clampByte(tone + 4 + rust * 0.35);
            color[index + 2] = clampByte(tone - 5);
            color[index + 3] = 255;
            height[index] = height[index + 1] = height[index + 2] = clampByte(relief);
            height[index + 3] = 255;
        }
    }
    return { size: safeSize, color, height };
}
