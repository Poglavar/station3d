// Colors by GDI use_class (gdi_building.use_class), which is keyed by the mesh's
// own object_id — so a building is coloured by what it IS, with no join through
// the cadastre. The old palette keyed off DGU's sifra_vrste_zgrade and could only
// be reached through a many-to-many match; GDI names the use of 357,682 of 357,683
// meshes directly.
//
// Palette is deliberately the same one: warm ochres for housing, cool blues for
// civic, greys for industry, so the city reads as it did. What changes is COVERAGE.
// The old map painted school/kindergarten/university blue and dropped everything
// else civic into the default tan; GDI names the whole "D-" family — javna i
// društvena namjena — so hospitals, ministries, museums and churches are civic too,
// each its own shade rather than one flat blue.
//
// Anything unmapped (Ostalo, brownfield, Park, Šuma, Cesta …) falls through to the
// per-object jittered warm tan, exactly as an unrecognised DGU code used to.
export const BUILDING_USE_COLORS = {
    // Housing and mixed use — 86% of every building in the city.
    'Stambena i mješovita': 0xe7ab6e,

    // Javna i društvena namjena. Public stays BLUE.
    'D5- Školska':       0x7596cb,   // school       — the original blue, unchanged
    'D4- Predškolska':   0x7596cb,   // kindergarten — the original blue, unchanged
    'D- sve':            0x7596cb,   // public, unspecified
    'D6- Visokoškolska': 0x6a89c0,   // university
    'D1- Upravna':       0x6f8fc4,   // administration
    'D3- Zdravstvena':   0x86b4d8,   // health
    'D2- Socijalna':     0x8aa6d4,   // social care
    'D7- Kulturna':      0x9c8fd0,   // culture
    'D8- Vjerska':       0xb0a7c8,   // religious — pale, so churches read as stone

    // Work.
    'Poslovna':                   0x94a5c6,
    'Trgovački kompleksi':        0xca836b,
    'Ugostiteljsko turistička':   0xca836b,
    'Tržnica':                    0xd3ab42,
    'Poljoprivredno gospodarska': 0xa69a86,

    // Industry and utility.
    'Proizvodna':     0x99a1a1,
    'Infrastruktura': 0x99a1a1,
    'Trafostanica':   0x99a1a1,
    'Vodocrpilište':  0x99a1a1,
    'Benzinska':      0xa99f9f,
    'Otpad':          0xa99f9f,
    'Eksploatacija':  0xa99f9f,

    // Movement.
    'Kolodvor/Terminal': 0x939bb0,
    'Željeznica':        0x939bb0,
    'Garaža':            0x939bb0,
    'Parkiralište':      0x939bb0,

    // Sport and recreation.
    'Sport s gradnjom':  0x94a5c6,
    'Sport bez gradnje': 0x94a5c6,
    'Igralište':         0x94a5c6,

    // State.
    'MORH': 0x8f9aa5,
    'MUP':  0x8f9aa5,
};

export const FAR_BUILDING_DEFAULT_COLOR = 0xe7ab6e;
export function farBuildingColorForUseClass(useClass) {
    const hex = BUILDING_USE_COLORS[useClass];
    return hex == null ? FAR_BUILDING_DEFAULT_COLOR : hex;
}
