// Offline rasterizer for the shared crowd-face mask. Runtime loads its PNG.
// Transparent pixels leave the head's skin colour intact; features carry
// their own colours. The texture follows the shared sphere's UV frame (+Z).
import {
    CROWD_FACE_COLUMNS, CROWD_FACE_COUNT, CROWD_FACE_TILE_PX,
    crowdFaceFeatures,
} from './person-appearance.js';

function ellipse(x, y, rx, ry) {
    return Math.max(0, Math.min(1, (1.1 - Math.hypot(x / rx, y / ry)) * 8));
}

export function createCrowdFaceAtlas(tileSize = CROWD_FACE_TILE_PX) {
    const width = tileSize * CROWD_FACE_COLUMNS;
    const height = tileSize * Math.ceil(CROWD_FACE_COUNT / CROWD_FACE_COLUMNS);
    const data = new Uint8Array(width * height * 4);
    const sphere = new Float32Array(tileSize * tileSize * 3);
    for (let y = 0; y < tileSize; y++) {
        const theta = Math.PI * (y + 0.5) / tileSize;
        for (let x = 0; x < tileSize; x++) {
            const phi = Math.PI * 2 * (x + 0.5) / tileSize;
            const at = (y * tileSize + x) * 3;
            sphere[at] = -Math.cos(phi) * Math.sin(theta);
            sphere[at + 1] = Math.cos(theta);
            sphere[at + 2] = Math.sin(phi) * Math.sin(theta);
        }
    }
    for (let variant = 0; variant < CROWD_FACE_COUNT; variant++) {
        const f = crowdFaceFeatures(variant);
        const column = variant % CROWD_FACE_COLUMNS;
        const row = Math.floor(variant / CROWD_FACE_COLUMNS);
        for (let py = 0; py < tileSize; py++) {
            for (let px = 0; px < tileSize; px++) {
                const at = (py * tileSize + px) * 3;
                const x = sphere[at], y = sphere[at + 1], z = sphere[at + 2];
                const ax = Math.abs(x);
                let color = 0, alpha = 0;
                // Front fringe, lower temples and a hair cap around the back.
                const front = Math.max(0, z);
                const hairline = -0.15 + (f.hairline + 0.15) * front
                    + 0.065 * Math.sin(x * 8 + f.part * 1.6) * front;
                if (!f.bald && y > hairline) {
                    color = f.hairColor;
                    alpha = Math.min(1, (y - hairline) * 40);
                }
                if (z > 0.58 && y < 0.65) {
                    if (f.beard && y < -0.48 + ax * 0.27 && y > -0.88) {
                        color = f.hairColor;
                        alpha = 0.6;
                    }
                    const eyeX = ax - f.eyeX;
                    const eyeY = y - f.eyeY;
                    const white = ellipse(eyeX, eyeY, f.eyeWidth, f.eyeHeight);
                    if (white > 0) { color = 0xece8df; alpha = white; }
                    const iris = ellipse(eyeX, eyeY, 0.047, f.eyeHeight * 0.86);
                    if (iris > 0) { color = f.eyeColor; alpha = iris; }
                    const pupil = ellipse(eyeX, eyeY, 0.025, 0.041);
                    if (pupil > 0) { color = 0x24252a; alpha = pupil; }
                    const browY = f.eyeY + 0.15 + f.browSlope * eyeX;
                    const brow = ellipse(eyeX, y - browY, f.eyeWidth * 1.18, f.browThickness);
                    if (brow > 0) { color = f.hairColor; alpha = brow; }
                    // A gently curved closed mouth; no teeth or speech rig.
                    const lipY = -0.43 + f.smile * (x / f.mouthWidth) ** 2 * 0.1;
                    const lip = ellipse(x, y - lipY, f.mouthWidth, 0.022);
                    if (lip > 0) { color = 0x754845; alpha = lip; }
                    if (f.moustache) {
                        const moustache = ellipse(x, y + 0.31 - ax * 0.12, 0.23, 0.045);
                        if (moustache > 0) { color = f.hairColor; alpha = moustache; }
                    }
                }
                const target = ((row * tileSize + py) * width + column * tileSize + px) * 4;
                data[target] = color >>> 16 & 255;
                data[target + 1] = color >>> 8 & 255;
                data[target + 2] = color & 255;
                data[target + 3] = Math.round(alpha * 255);
            }
        }
    }
    return { data, width, height };
}
