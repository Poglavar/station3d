// Selects the streamed terrain's shared material maps from a location style key.

import * as THREE from 'three';
import { getLocation } from '../core/locations.js';
import { getSidewalkTexture, SIDEWALK_UV_PER_M } from '../scene/setup.js';
import { createDalmatianTerrainRaster } from '../core/dalmatian-terrain-texture.js';
import { getGrassTexture } from './decor.js';

const DALMATIAN_TILE_M = 64;
// Grass pattern repeat for the terrain base, matching the flat world's
// ground-cover density (GRASS_TILE_ON_GROUND_M) so the two worlds read the same.
const GRASS_TILE_M = 3.0;
let dalmatianSurface = null;

function makeDataTexture(data, size, colorSpace = null) {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    if (colorSpace) texture.colorSpace = colorSpace;
    texture.needsUpdate = true;
    return texture;
}

function getDalmatianSurface() {
    if (dalmatianSurface) return dalmatianSurface;
    const raster = createDalmatianTerrainRaster();
    dalmatianSurface = {
        map: makeDataTexture(raster.color, raster.size, THREE.SRGBColorSpace),
        bumpMap: makeDataTexture(raster.height, raster.size),
        bumpScale: 0.18,
        uvPerM: 1 / DALMATIAN_TILE_M,
    };
    return dalmatianSurface;
}

export function getTerrainSurface(styleKey) {
    if (styleKey === 'dalmatian-karst') return getDalmatianSurface();
    // Grass default: the terrain reads as grassland, and the shared
    // urban-ground shader blends the sidewalk catch-all back in only near
    // buildings and roads — the same rule the flat world's ground cover uses.
    if (styleKey === 'grass') {
        return {
            map: getGrassTexture(),
            bumpMap: null,
            bumpScale: 0,
            uvPerM: 1 / GRASS_TILE_M,
        };
    }
    return {
        map: getSidewalkTexture(),
        bumpMap: null,
        bumpScale: 0,
        uvPerM: SIDEWALK_UV_PER_M,
    };
}

// Formation seam collars must use the same maps and world-space UV scale as
// the active terrain. Their geometry deliberately overlaps the terrain mask
// to seal quantisation gaps; a different surface material turns that overlap
// into a visible sidewalk strip.
export function getActiveTerrainSurface() {
    return getTerrainSurface(getLocation().terrain?.surfaceStyle);
}
