// Procedural brick bond for stated-material building parts (baked landmarks).
//
// A landmark_mesh row may carry a `texture` config ({kind:'brick', scale,
// accent, mortar}); the tones live in the generated map, so the part's vertex
// colour goes WHITE and the material carries the DataTexture. Ported verbatim
// from the authoring viewer (zagreb-zgrade-datiranje/models/structures/lib/tower-builder.js)
// so the sim and the viewer render the same wall from the same spec.
//
// Pure functions, no DOM/canvas — headless-testable; only `three` for colour math.
import * as THREE from 'three';

export function seededUnit(x, y, seed = 1) {
    let h = Math.imul((x | 0) ^ seed, 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16) ^ (y | 0), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function brickTextureData(size, baseHex, accentHex, mortarHex, seed = 7) {
    const base = new THREE.Color(baseHex);
    const accent = new THREE.Color(accentHex);
    const mortar = new THREE.Color(mortarHex);
    const data = new Uint8Array(size * size * 4);
    const courses = 24;                       // brick rows per tile (7.5 cm at 1.8 m)
    const courseH = size / courses;
    const brickW = courseH * 3.2;             // ~24 cm bricks
    const brickTone = new Map();
    for (let y = 0; y < size; y += 1) {
        const row = Math.floor(y / courseH);
        const yin = y - row * courseH;
        for (let x = 0; x < size; x += 1) {
            const shifted = x + (row % 2) * (brickW / 2);
            const col = Math.floor(shifted / brickW);
            const xin = shifted - col * brickW;
            let tone;
            if (yin < 1 || xin < 1) {
                tone = mortar;
            } else {
                const key = `${col},${row}`;
                tone = brickTone.get(key);
                if (!tone) {
                    if (seededUnit(col, row, seed) < 0.14) {
                        tone = accent;
                    } else {
                        tone = base.clone().offsetHSL(
                            (seededUnit(col, row, seed + 101) - 0.5) * 0.015,
                            0,
                            (seededUnit(col, row, seed + 202) - 0.5) * 0.14,
                        );
                    }
                    brickTone.set(key, tone);
                }
            }
            // THREE.Color holds linear-space components; the texture is declared
            // sRGB, so convert at write time or the renderer decodes twice and the
            // wall comes out darker and more saturated than the authored tones.
            const srgb = tone.clone().convertLinearToSRGB();
            const i = (y * size + x) * 4;
            data[i] = Math.round(srgb.r * 255);
            data[i + 1] = Math.round(srgb.g * 255);
            data[i + 2] = Math.round(srgb.b * 255);
            data[i + 3] = 255;
        }
    }
    return data;
}

/**
 * Box-projected UVs for a non-indexed triangle soup: each triangle projects onto
 * the plane of its dominant normal axis, in local metres over `scale` metres per
 * texture repeat. Coplanar surfaces share coordinates, so the bond runs
 * continuously across a facade.
 */
export function boxProjectedUvs(positions, scale = 1.8) {
    const uv = new Float32Array((positions.length / 3) * 2);
    for (let t = 0; t < positions.length; t += 9) {
        const ux = positions[t + 3] - positions[t];
        const uy = positions[t + 4] - positions[t + 1];
        const uz = positions[t + 5] - positions[t + 2];
        const vx = positions[t + 6] - positions[t];
        const vy = positions[t + 7] - positions[t + 1];
        const vz = positions[t + 8] - positions[t + 2];
        const nx = Math.abs(uy * vz - uz * vy);
        const ny = Math.abs(uz * vx - ux * vz);
        const nz = Math.abs(ux * vy - uy * vx);
        for (let k = 0; k < 3; k += 1) {
            const p = t + k * 3;
            const out = (p / 3) * 2;
            if (nx >= ny && nx >= nz) {
                uv[out] = positions[p + 2] / scale;
                uv[out + 1] = positions[p + 1] / scale;
            } else if (ny >= nx && ny >= nz) {
                uv[out] = positions[p] / scale;
                uv[out + 1] = positions[p + 2] / scale;
            } else {
                uv[out] = positions[p] / scale;
                uv[out + 1] = positions[p + 1] / scale;
            }
        }
    }
    return uv;
}
