// Pure location-specific facade and pitched-roof styling. Keeping this policy
// outside the renderer lets Split use Dalmatian details without changing Zagreb.

const ZAGREB_PITCHED_ROOF_STYLE = Object.freeze({
    key: 'zagreb-clay',
    profile: 'flat-tile',
    // Continental Croatia is a two-slope (gabled) roof region like the coast —
    // only the SHINGLES differ (dark flat clay here vs kanalica there). Only
    // the Overture builder reads this; GDI meshes carry their real roofs.
    roofForm: 'gable',
    palette: Object.freeze([
        0x583020,
        0x4c2818,
        0x4a2410,
        0x583624,
        0x5a2a14,
        0x4e3024,
        0x5c3018,
    ]),
    jitter: Object.freeze({ h: 0.012, s: 0.08, l: 0.05 }),
    roughness: 0.85,
    normalScale: 0.28,
    textureCellWidthM: 1.8,
    textureCellHeightM: 1.4,
});

const SPLIT_PITCHED_ROOF_STYLE = Object.freeze({
    key: 'split-kanalica',
    profile: 'kanalica',
    roofForm: 'gable',
    // Sun-bleached Dalmatian terracotta: deliberately lighter and more orange-red
    // than Zagreb's dark brown clay, with enough variation for individual roofs.
    palette: Object.freeze([
        0xc65f36,
        0xb95432,
        0xd17445,
        0xc8673c,
        0xdc8451,
        0xb8492b,
        0xca7146,
    ]),
    jitter: Object.freeze({ h: 0.018, s: 0.10, l: 0.08 }),
    roughness: 0.82,
    normalScale: 0.55,
    // Six roughly 24 cm channels and four roughly 42 cm tile lengths per cell.
    textureCellWidthM: 1.44,
    textureCellHeightM: 1.68,
});

const SPLIT_WINDOW_FRAME_COLORS = Object.freeze([
    '#4f7659',
    '#5f8567',
    '#456c52',
    '#6f8f70',
    '#3f634b',
    '#557a5d',
]);

const SPLIT_LOW_RISE_FACADE_STYLE = Object.freeze({
    key: 'split-dalmatian-limestone',
    maxFloors: 2,
    textureWidthM: 4.8,
    textureHeightM: 3.6,
    variants: 4,
    bumpScale: 0.14,
    roughness: 0.96,
});

function wrappedIndex(index, length) {
    return ((index % length) + length) % length;
}

function fract(value) {
    return value - Math.floor(value);
}

// The Dalmatian recipe is regional, not a property of one location: Šibenik and Zadar build the
// same kanalica roofs and limestone low-rise as Split. Kept as an explicit list rather than derived
// from the karst ground style, because ground and architecture are separate calls — Rijeka shares
// the karst surface but its centre is Habsburg, so it stays continental until someone decides.
const DALMATIAN_LOCATION_IDS = new Set(['split', 'sjeverna-dalmacija']);

function isDalmatianLocation(locationId) {
    return DALMATIAN_LOCATION_IDS.has(locationId);
}

// Rijeka's tall stock is post-war modernist — Zamet, Krnjevo, Turnić — and those blocks are flat
// topped, while the Habsburg core below them keeps its pitches. The procedural roof gate upstream
// only looks at footprint AREA, so a slim tower on a small footprint gets a gable however tall it
// is; this is the height half of that decision. Tune the threshold here: 7 sits above the 4–6 floor
// core and at the foot of the tower range, so the boundary falls in a sparse band.
const FLAT_ROOF_MIN_FLOORS_BY_LOCATION = Object.freeze({ rijeka: 7 });

export function hasFlatRoof(locationId, floors) {
    const minFloors = FLAT_ROOF_MIN_FLOORS_BY_LOCATION[locationId];
    if (!minFloors) return false;
    const floorCount = Number(floors);
    // An unknown floor count must not read as a tower; leave the roof as it was.
    if (!Number.isFinite(floorCount)) return false;
    return Math.round(floorCount) >= minFloors;
}

// Halls, terminals and logistics sheds are not tall but huge, and house-like punched windows read
// wrong on them, so they take large glass panels and a flat roof instead. Policy, not geometry: the
// caller measures the footprint and hands the numbers in. A location without a
// `massiveVolumeCurtains` config never qualifies — the rule has to be granted, never inferred from
// where in the world the building happens to be.
export function hasMassiveVolumeCurtain(config, metrics) {
    if (!config) return false;
    // Number(null) is 0, and 0 is south of every latitude ceiling — a building with no coordinate
    // would read as inside the band. Absent has to stay absent, never coerce to a plausible number.
    const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

    const areaM2 = finite(metrics?.areaM2);
    if (areaM2 === null || areaM2 < (config.minAreaM2 ?? 0)) return false;

    const maxLatitude = finite(config.maxLatitude);
    if (maxLatitude !== null) {
        const latitude = finite(metrics?.latitude);
        if (latitude === null || latitude >= maxLatitude) return false;
    }

    // An unknown height falls back to a single storey rather than multiplying out to a fake
    // volume — the same assumption the renderer made before this moved out of it.
    const heightM = finite(metrics?.heightM);
    const usableHeight = heightM !== null && heightM > 0 ? heightM : 3;
    return areaM2 * usableHeight >= (config.minVolumeM3 ?? Infinity);
}

// ─── New-build (proposal) architecture ──────────────────────────────────────
// CB proposal massing is NEW construction, so it must not inherit the existing
// stock's weathered greys and olive renders. Walls: whites and light warm
// tones, with marble/stone cladding weighted up. Windows: modern aluminium —
// in Dalmatian locations mostly with green aluminium shutters (the traditional
// grilje reinterpreted), elsewhere plain flush glazing. Applies to every
// proposal building regardless of plan; per-plan overrides can be layered on
// top if a plan ever wants a different character.

export const NEW_BUILD_WALL_PALETTE = Object.freeze([
    0xf5f2ea, // warm white render
    0xefede6, // chalk white
    0xf1ece0, // ivory
    0xe9e6df, // cool off-white
    0xe8e4dc, // marble white
    0xf3f0e8, // limewash
    0xe4ded2, // light stone
    0xdfdcd5, // pale grey-white
]);

// Finish → wall texture + material params. 'marble' appears twice deliberately
// so it stays the single most common finish ("more marble"). 'tiles' (ceramic
// grid with light grout) and 'blocks' (staggered ashlar with light seams) add
// the visibly jointed claddings.
export const NEW_BUILD_WALL_FINISHES = Object.freeze([
    Object.freeze({ key: 'render', roughness: 0.88, envMapIntensity: 0.35 }),
    Object.freeze({ key: 'marble', roughness: 0.5, envMapIntensity: 0.65 }),
    Object.freeze({ key: 'stone', roughness: 0.72, envMapIntensity: 0.45 }),
    Object.freeze({ key: 'marble', roughness: 0.5, envMapIntensity: 0.65 }),
    Object.freeze({ key: 'tiles', roughness: 0.58, envMapIntensity: 0.5 }),
    Object.freeze({ key: 'blocks', roughness: 0.78, envMapIntensity: 0.4 }),
]);

// Style indices at/above this base select from newBuildWindowStyles() instead
// of the ordinary FACADE_WINDOW_STYLES — keeps one integer namespace through
// the facade texture/material caches without touching their keys.
export const NEW_BUILD_WINDOW_STYLE_BASE = 100;

// Aluminium-shutter greens: the traditional Dalmatian window green, slightly
// cooled toward a powder-coated RAL tone rather than weathered paint.
// Every wScale/hScale stays inside the opening-mask envelope buildings.js
// reserves (WINDOW_MAX_W_SCALE 1.15 / WINDOW_MAX_H_SCALE 1.12) — the shutter
// itself paints INSIDE the window opening (a sliding panel over the glass),
// so it can never overhang a roof edge the mask already cleared.
const NEW_BUILD_WINDOW_STYLES_DALMATIAN = Object.freeze([
    // White alu frame, green sliding shutter drawn partly across the glass.
    { frame: '#f2f0ea', glass: '#41525e', mullion: '#f2f0ea', wScale: 1.0, hScale: 1.05, panes: 'single', sill: 'flush', head: 'none', shutter: 'slide', shutterColor: '#3e6a50' },
    // Off-white frame, deeper green, vertical split.
    { frame: '#e9e7e0', glass: '#3c4c58', mullion: '#e9e7e0', wScale: 0.95, hScale: 1.1, panes: 'vertical', sill: 'flush', head: 'none', shutter: 'slide', shutterColor: '#476f55' },
    // Shutters fully closed — the Mediterranean daytime facade.
    { frame: '#dedcd5', glass: '#45565f', mullion: '#dedcd5', wScale: 1.05, hScale: 1.0, panes: 'single', sill: 'flush', head: 'none', shutter: 'closed', shutterColor: '#37624a' },
    // Light sage-green shutter on an ivory frame.
    { frame: '#f4f2ec', glass: '#3a4a56', mullion: '#f4f2ec', wScale: 1.0, hScale: 1.08, panes: 'vertical', sill: 'flush', head: 'none', shutter: 'slide', shutterColor: '#54785c' },
    // Flush dark-aluminium glazing, no shutters — the modern minority.
    { frame: '#565b5e', glass: '#4e5f6a', mullion: '#565b5e', wScale: 1.12, hScale: 1.0, panes: 'single', sill: 'flush', head: 'none', shutter: null, shutterColor: null },
]);

const NEW_BUILD_WINDOW_STYLES_DEFAULT = Object.freeze([
    { frame: '#f0eee8', glass: '#42525e', mullion: '#f0eee8', wScale: 1.0, hScale: 1.05, panes: 'single', sill: 'flush', head: 'none', shutter: null, shutterColor: null },
    { frame: '#565b5e', glass: '#4e5f6a', mullion: '#565b5e', wScale: 1.12, hScale: 1.0, panes: 'single', sill: 'flush', head: 'none', shutter: null, shutterColor: null },
    { frame: '#d9d7d0', glass: '#3c4c58', mullion: '#d9d7d0', wScale: 0.95, hScale: 1.1, panes: 'vertical', sill: 'flush', head: 'none', shutter: null, shutterColor: null },
]);

export function newBuildWindowStyles(locationId) {
    return isDalmatianLocation(locationId)
        ? NEW_BUILD_WINDOW_STYLES_DALMATIAN
        : NEW_BUILD_WINDOW_STYLES_DEFAULT;
}

export function getPitchedRoofStyle(locationId) {
    return isDalmatianLocation(locationId) ? SPLIT_PITCHED_ROOF_STYLE : ZAGREB_PITCHED_ROOF_STYLE;
}

export function resolveFacadeWindowStyle(locationId, baseStyle, styleIndex) {
    if (!isDalmatianLocation(locationId)) return baseStyle;
    const frame = SPLIT_WINDOW_FRAME_COLORS[wrappedIndex(styleIndex, SPLIT_WINDOW_FRAME_COLORS.length)];
    return { ...baseStyle, frame, mullion: frame };
}

export function getLowRiseFacadeStyle(locationId, floors) {
    const floorCount = Math.max(1, Math.round(Number(floors) || 1));
    if (!isDalmatianLocation(locationId) || floorCount > SPLIT_LOW_RISE_FACADE_STYLE.maxFloors) return null;
    return SPLIT_LOW_RISE_FACADE_STYLE;
}

// Periodic height field for traditional barrel-shaped "kupa kanalica" tiles.
// U advances by one rounded channel; V advances by one overlapping tile length.
export function kanalicaHeightAt(u, v) {
    if (!Number.isFinite(u) || !Number.isFinite(v)) return 0;
    const across = fract(u);
    const normalizedRadius = Math.abs(across - 0.5) / (0.5 * 0.86);
    const barrel = normalizedRadius < 1
        ? Math.sqrt(Math.max(0, 1 - normalizedRadius * normalizedRadius))
        : 0;
    const channel = Math.floor(u);
    const stagger = ((channel % 2) + 2) % 2 === 0 ? 0 : 0.5;
    const along = fract(v + stagger);
    const seamDistance = Math.min(along, 1 - along);
    const overlap = Math.max(0, 1 - seamDistance / 0.18);
    return Math.min(1, 0.07 + barrel * 0.75 + overlap * (0.06 + barrel * 0.12));
}
