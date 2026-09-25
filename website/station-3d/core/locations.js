import { logStamp } from './log-stamp.js';
import { getWorldProvider } from './api.js';
// Regional presentation recipes for the OSM 3D world. Runtime data sources are
// national and spatial: every walk/cab session starts from the Croatia profile,
// while the player's coordinates select the local ground and architecture look.
// `?loc=` is deliberately not consulted here; an old planner URL must not turn
// Split's sea into Zagreb grass or select a different set of buildings.

export const LOCATIONS = {
    zagreb: {
        // Source-agnostic 3D buildings: /buildings-mesh unions every survey
        // covering the bbox — the GDI LOD2 photogrammetry AND the hand-modelled
        // landmarks, which are baked upstream and arrive as ordinary meshes that
        // happen to state their own material. The builder never learns a
        // landmark is special, which is what lets the bespoke landmark layer go.
        country: 'croatia',                          // ingest bucket fallback (see world-coverage.js)
        localBird: 'crow',                           // sporadic ambient call (world/ambient-birds.js)
        buildings: 'mesh',
        // public.facade_street is keyed to Zagreb's GDI object ids. The
        // source-agnostic mesh endpoint still carries those same ids, so this
        // capability must not disappear merely because the endpoint name no
        // longer says "gdi".
        streetFacingFacades: true,
        farBuildings: true,                          // LOD1 footprint boxes via /buildings-lod1
        // Decor comes from the DB via GET /api/decor?kind=&bbox= (public.osm_decor),
        // not from baked files: the shipped zagreb_tram_*.json set had grown to 14 MB
        // of greenery alone, fetched whole on every session, and widening it to the
        // commuter basin would have roughly doubled that. The bbox endpoint also means
        // coverage now extends as far as the ingest does instead of as far as one
        // committed file happened to reach.
        decorEnabled: false,
        apiDecor: true,
        passengers: true,                            // boarding demand + fares exist here; other
                                                     // locations hide the (non-functional) HUD counter

        roadIndexUrl: 'json/zagreb_roads.json',           // facade-window street index
        water: false,                                // decor already renders the baked ponds/rivers
        // No static grid: the DGU terrain is fetched live as a bounded moving
        // lattice of cacheable /terrain/grid cells around the camera.
        // Grass base + sidewalk-near-buildings-and-roads blend, matching the flat
        // world's ground cover (the mask is fed by the same road/building layers).
        terrain: {
            surfaceStyle: 'grass',
            // Keep Station3D on the established national grid until the LiDAR
            // path has movement/streaming performance preprocessing and proof.
            source: 'dgu-dtm-20m',
        },
        // Zagreb shows its terrain by default (the rollout opt-in ended 2026-09-25):
        // authored landmarks carry an absolute datum and only sit right on it.
        // ?elevation=0 still opens the flat world.
        // Velika Gorica / airport band: buildings that are not tall but HUGE by volume are halls,
        // terminals and logistics sheds, and procedural house windows read wrong on them, so they
        // get large glass panels and a flat membrane roof instead. Thresholds are the p99 of the
        // ingested VG band. maxLatitude keeps it south of the city proper, which stays on the
        // 35 m eaves-height rule. This is opt-in per location BECAUSE it used to be a bare
        // latitude test in the renderer: every coastal location (Split 43.4–43.6, sjeverna-
        // dalmacija 43.7–44.2, Rijeka 45.3–45.4, Istria 44.8–45.5) sits entirely below that
        // ceiling, so ordinary two-storey coastal stock was being glazed like an airport terminal.
        massiveVolumeCurtains: {
            maxLatitude: 45.745,
            minAreaM2: 500,
            minVolumeM3: 5500,
        },
    },
    split: {
        // Source-agnostic 3D buildings: the server unions every survey that
        // covers this bbox (here our DGU-LiDAR LOD2 reconstruction, 64,760
        // meshes) and stamps each feature with the KIND of geometry, so the
        // builder never learns which survey produced it. Adding another city's
        // survey is an API-side registry entry and nothing here.
        country: 'croatia',                          // ingest bucket fallback (see world-coverage.js)
        localBird: 'seagull',                        // sporadic ambient call (world/ambient-birds.js)
        buildings: 'mesh',
        buildingEndpoint: 'buildings-mesh',
        // Real heights instead of invented ones. /buildings-render resolves the
        // best source per building — a LiDAR LoD2 mesh where one exists, else a
        // height MEASURED from the DGU point cloud (class-6 roof over class-2
        // ground, MAE 0.72 m against GDI), else the footprint alone.
        // 59,989 of 98,268 buildings in this corridor now carry a measured
        // height where /buildings-overture had one for 42 of them, and
        // estimateOvertureBuildingHeight() had to invent the rest.
        // It still invents where height comes back null — that is the honest
        // tier 3, not a silent 0 m.
        //
        // The far horizon stays on /buildings-render deliberately: at 800-1600 m
        // a prism is the right geometry, and streaming LOD2 face meshes out
        // there would cost a great deal to render something no one can resolve.
        // It must still agree with the detailed layer about HEIGHT, and it does:
        // building_render tier 1 carries the same ridge/eave the mesh was built
        // from, so a building does not change size at the ~300 m hand-off.
        farBuildingEndpoint: 'buildings-render',
        farBuildings: true,
        decorEnabled: false,                         // no pre-baked decor files
        apiDecor: true,                              // multi-city /api/decor bbox source
        roadIndexUrl: null,
        water: true,                                 // sea layer: DB water via /api/water, sunk below ground
        // Live DGU grid (like Zagreb), not the old shipped
        // terrain/split-dgu-dtm-20m.{json,bin}. That asset covered only
        // 16.20–16.56 E / 43.45–43.62 N, which stops short of the M604 north of
        // Kaštela: the existing railway had no surface to sit on for the first
        // 14.8 km of its reconstruction. public.dgu_dem covers the whole area and
        // agrees with the retired asset to +0.46 m mean, so this is the same
        // terrain over a bigger footprint — and the same source the
        // reconstructions are solved against.
        // best-available since 2026-08-07: the Trogir–Split 1 m LiDAR DMR is
        // imported, and it carries the real Divulje road-tunnel cuttings the
        // 20 m DTM smooths away. The grid resolver's cell cap still governs
        // the delivered resolution for corridor-sized boxes; the DETAIL
        // window is what brings true 1 m ground near the walker
        // (Station3D docs/performance/audit.md, bounded terrain window).
        terrain: {
            surfaceStyle: 'dalmatian-karst',
            // The BASE corridor grid stays on the 20 m DTM: at its ~12 m
            // capped resolution, best-available forced PostGIS to clip and
            // union the whole corridor's LiDAR at native resolution only to
            // hand back coarse cells — 10-18 s of the Data phase for ground
            // the detail windows re-cover anyway. Far terrain at 20 m is the
            // accepted look; the 1 m truth lives in the windows below.
            source: 'dgu-dtm-20m',
            // ±550 m fits the native-resolution request budget. This window
            // follows the camera; the 20 m fixed-cell mosaic is the immediate
            // base until fine evidence arrives.
            detail: {
                source: 'best-available',
                halfSizeM: 550,
                meshStepM: 4,
            },
        },
        naturalGround: {
            style: 'dalmatian-karst',
            radiusM: 650,
            rebuildM: 280,
        },
        urbanGround: {
            coreRadiusM: 14,
            blendRadiusM: 18,
            maskHalfSizeM: 320,
            maskSizePx: 512,
            refreshMoveM: 80,
        },
    },
    // Zadar–Šibenik–Knin. Same Dalmatian recipe as Split — Overture buildings,
    // DB decor, sea, karst ground, live DGU grid — over the area the M606
    // Knin–Zadar, M607 Perković–Šibenik and L211 Ražine–Šibenik Luka
    // reconstructions run through.
    'sjeverna-dalmacija': {
        country: 'croatia',                          // ingest bucket fallback (see world-coverage.js)
        localBird: 'seagull',                        // Šibenik: sporadic ambient call (world/ambient-birds.js)
        buildings: 'overture',
        farBuildings: true,
        decorEnabled: false,
        apiDecor: true,
        roadIndexUrl: null,
        water: true,                                 // Zadar and Šibenik are coastal
        terrain: { surfaceStyle: 'dalmatian-karst' },
        naturalGround: {
            style: 'dalmatian-karst',
            radiusM: 650,
            rebuildM: 280,
        },
        urbanGround: {
            coreRadiusM: 14,
            blendRadiusM: 18,
            maskHalfSizeM: 320,
            maskSizePx: 512,
            refreshMoveM: 80,
        },
    },
    // Rijeka bay: Opatija–Rijeka–Bakar. Same coastal recipe as Split — Overture
    // buildings, DB decor, sea, karst ground, live DGU grid. Added for the
    // Sušak–Brajdica tunnel reconstruction; Kvarner limestone reads fine with
    // the Dalmatian karst surface.
    rijeka: {
        country: 'croatia',                          // ingest bucket fallback (see world-coverage.js)
        buildings: 'overture',
        farBuildings: true,
        decorEnabled: false,
        apiDecor: true,
        roadIndexUrl: null,
        water: true,                                 // the harbour is half the view
        terrain: { surfaceStyle: 'dalmatian-karst' },
        naturalGround: {
            style: 'dalmatian-karst',
            radiusM: 650,
            rebuildM: 280,
        },
        urbanGround: {
            coreRadiusM: 14,
            blendRadiusM: 18,
            maskHalfSizeM: 320,
            maskSizePx: 512,
            refreshMoveM: 80,
        },
    },
    // Istria shares Rijeka's coastal Kvarner recipe — Overture buildings, karst
    // ground, harbour water (Pula) — as its own world for the R101/L213 lines.
    istria: {
        country: 'croatia',                          // ingest bucket fallback (see world-coverage.js)
        buildings: 'overture',
        farBuildings: true,
        decorEnabled: false,
        apiDecor: true,
        roadIndexUrl: null,
        water: true,
        terrain: { surfaceStyle: 'dalmatian-karst' },
        naturalGround: {
            style: 'dalmatian-karst',
            radiusM: 650,
            rebuildM: 280,
        },
        urbanGround: {
            coreRadiusM: 14,
            blendRadiusM: 18,
            maskHalfSizeM: 320,
            maskSizePx: 512,
            refreshMoveM: 80,
        },
    },
    // The Zagreb–Split railway as ONE location: 422 km of corridor rather than a
    // city. Sources are the same everywhere along it (Overture buildings, DB
    // decor, live DGU grid), but the ground is not — Posavina farmland at one end
    // and Dalmatian karst at the other. So it carries no style of its own:
    // styleFrom 'nearest-city' resolves the look from whichever prepared city the
    // session anchor is in or closest to (see applyAnchorStyle).
    'zagreb-split': {
        // 'gdi', NOT 'overture', even though most of the corridor has no GDI
        // coverage: /buildings-3d?fill=overture resolves the source PER TILE, so
        // the karst end still gets its Overture footprints while the Zagreb end
        // gets the real survey. With 'overture' the whole 52 km was UUID-keyed
        // prisms — including the city, where the tower spec (GDI object_ids)
        // could suppress nothing, so every modelled tower ALSO wore its massing,
        // and the ≥35 m curtain-wall rule (GDI eave heights, GDI build path)
        // never fired: a ride full of doubled towers and plaster high-rises.
        country: 'croatia',                          // ingest bucket fallback (see world-coverage.js)
        buildings: 'gdi',
        farBuildings: true,
        decorEnabled: false,
        apiDecor: true,
        roadIndexUrl: null,
        water: true,                                 // Kupa, Mrežnica, the Adriatic at the far end
        styleFrom: 'nearest-city',
        terrain: { surfaceStyle: 'dalmatian-karst' },
        naturalGround: {
            style: 'dalmatian-karst',
            radiusM: 650,
            rebuildM: 280,
        },
        urbanGround: {
            coreRadiusM: 14,
            blendRadiusM: 18,
            maskHalfSizeM: 320,
            maskSizePx: 512,
            refreshMoveM: 80,
        },
    },
    // Nizinska pruga Karlovac – Rijeka: the DESIGNED new line's 5 km strip.
    // Same recipe as the Split corridor — per-tile GDI-with-Overture-fill
    // buildings (the Karlovac end sits beside the zagreb-split strip, the karst
    // middle is Overture-only either way), live DGU terrain, DB decor. Ground
    // style resolves from the nearest prepared city: grass at the Karlovac end,
    // Dalmatian karst by the time the line drops toward Rijeka.
    'nizinska-pruga': {
        country: 'croatia',                          // ingest bucket fallback (see world-coverage.js)
        buildings: 'gdi',
        farBuildings: true,
        decorEnabled: false,
        apiDecor: true,
        roadIndexUrl: null,
        water: true,                                 // Kupa, Mrežnica, Tounjčica, and the Bakar bay
        styleFrom: 'nearest-city',
        terrain: { surfaceStyle: 'dalmatian-karst' },
        naturalGround: {
            style: 'dalmatian-karst',
            radiusM: 650,
            rebuildM: 280,
        },
        urbanGround: {
            coreRadiusM: 14,
            blendRadiusM: 18,
            maskHalfSizeM: 320,
            maskSizePx: 512,
            refreshMoveM: 80,
        },
    },
    // Zagreb Gk – Sisak. Same shape as the Split corridor, but the whole 50 km is
    // Sava plain rather than karst, so its style resolves to Zagreb's from either
    // end — styleFrom is kept anyway so it cannot silently inherit a Dalmatian
    // surface if the nearest-city logic changes.
    'zagreb-sisak': {
        // Same per-tile reasoning as zagreb-split: the Zagreb end has the GDI
        // survey and the modelled towers; 'overture' for the whole corridor
        // un-suppressed their massing and skipped the curtain-wall rule there.
        country: 'croatia',                          // ingest bucket fallback (see world-coverage.js)
        buildings: 'gdi',
        farBuildings: true,
        decorEnabled: false,
        apiDecor: true,
        roadIndexUrl: null,
        water: true,                                 // the Sava, and the Odra channel
        styleFrom: 'nearest-city',
        terrain: { surfaceStyle: 'grass' },
        urbanGround: {
            coreRadiusM: 14,
            blendRadiusM: 18,
            maskHalfSizeM: 320,
            maskSizePx: 512,
            refreshMoveM: 80,
        },
    },
    // Country-scale free roam. The detailed mesh endpoint resolves the best
    // survey where one exists and fills the rest from the national Overture
    // footprint import. No Zagreb-only baked assets are referenced here.
    croatia: {
        country: 'croatia',
        localBird: null,
        buildings: 'mesh',
        buildingEndpoint: 'buildings-mesh',
        farBuildingEndpoint: 'buildings-render',
        farBuildings: true,
        decorEnabled: false,
        apiDecor: true,
        passengers: false,
        roadIndexUrl: null,
        water: true,
        styleFrom: 'nearest-city',
        terrain: {
            surfaceStyle: 'grass',
            source: 'dgu-dtm-20m',
            detail: {
                source: 'best-available',
                halfSizeM: 550,
                meshStepM: 4,
            },
        },
        naturalGround: {
            style: 'grass',
            radiusM: 650,
            rebuildM: 280,
        },
        urbanGround: {
            coreRadiusM: 14,
            blendRadiusM: 18,
            maskHalfSizeM: 320,
            maskSizePx: 512,
            refreshMoveM: 80,
        },
    },
};

let active = null;
let activeProvider = null;

// Neutral defaults for an OSM-style HTTP provider. Regional products can
// override this data through configureWorld({ worldProfile }) without adding
// country checks or source names to the engine itself.
export const DEFAULT_WORLD_PROFILE = Object.freeze({
    id: 'default-world',
    country: null,
    localBird: null,
    buildings: 'overture',
    farBuildings: true,
    decorEnabled: false,
    apiDecor: true,
    passengers: false,
    roadIndexUrl: null,
    water: true,
    terrain: Object.freeze({ surfaceStyle: 'grass' }),
    naturalGround: Object.freeze({
        style: 'grass',
        radiusM: 650,
        rebuildM: 280,
    }),
    urbanGround: Object.freeze({
        coreRadiusM: 14,
        blendRadiusM: 18,
        maskHalfSizeM: 320,
        maskSizePx: 512,
        refreshMoveM: 80,
    }),
});

function configuredWorldProfile() {
    const provider = getWorldProvider();
    return {
        provider,
        profile: provider.worldProfile || DEFAULT_WORLD_PROFILE,
    };
}

function browserLocationRegistry() {
    return (typeof window !== 'undefined' && window.__locationRegistry) || null;
}

// Resolve the regional presentation without mutating session state. Keeping
// this pure makes the country-scale transition policy testable and lets the
// moving terrain layer ask the same question again after a long drive.
export function resolveRegionalLocation(location, anchorLat, anchorLon, registry = browserLocationRegistry()) {
    if (location.styleFrom !== 'nearest-city') return location;
    const regionalLocationId = registry?.detectByLatLng?.(anchorLat, anchorLon) || null;
    const cityId = registry?.nearestCityId?.(anchorLat, anchorLon);
    const city = cityId && LOCATIONS[cityId];
    if (!city) return { ...location, regionalLocationId };
    const cityBbox = registry?.REGISTRY?.[cityId]?.bbox;
    const styleCityContainsPosition = Array.isArray(cityBbox)
        && cityBbox.length === 4
        && Number(anchorLon) >= Number(cityBbox[0])
        && Number(anchorLon) <= Number(cityBbox[2])
        && Number(anchorLat) >= Number(cityBbox[1])
        && Number(anchorLat) <= Number(cityBbox[3]);
    return {
        ...location,
        terrain: { ...location.terrain, surfaceStyle: city.terrain?.surfaceStyle || location.terrain?.surfaceStyle },
        naturalGround: city.naturalGround ? { ...city.naturalGround } : location.naturalGround,
        urbanGround: city.urbanGround ? { ...city.urbanGround } : location.urbanGround,
        // Service/ambience flags belong to a city only while the player is
        // actually inside it. A nearest-city style is allowed to colour the
        // countryside, but must not invent Zagreb passenger demand in Osijek.
        localBird: styleCityContainsPosition ? (city.localBird || null) : (location.localBird || null),
        passengers: styleCityContainsPosition ? city.passengers === true : location.passengers === true,
        regionalLocationId,
        styleCityId: cityId,
        styleCityContainsPosition,
    };
}

// Resolve a complete model-world session from coordinates alone. Source
// identity stays national; only presentation and truly local service flags are
// inherited from the detected region.
export function resolveSpatialLocation(anchorLat, anchorLon, registry = browserLocationRegistry()) {
    const { profile } = configuredWorldProfile();
    return resolveRegionalLocation(
        { ...profile },
        anchorLat,
        anchorLon,
        registry,
    );
}

// Settle the national sources and initial regional look before layers begin.
export function applyAnchorStyle(anchorLat, anchorLon, registry = browserLocationRegistry()) {
    const { provider } = configuredWorldProfile();
    const next = resolveSpatialLocation(anchorLat, anchorLon, registry);
    active = next;
    activeProvider = provider;
    console.log(logStamp(), `[locations] ${active.id || 'world'} session at ${active.regionalLocationId || 'configured area'}`
        + ` uses ${active.styleCityId || 'default'} presentation (${active.terrain?.surfaceStyle || 'default'})`);
    return active;
}

// Country/corridor sessions can cross presentation regions without restarting.
// Return an explicit change record so render layers rebuild only when the
// nearest-city style actually changes, not on every position update.
export function refreshRegionalLocation(anchorLat, anchorLon) {
    const current = getLocation();
    if (current.styleFrom !== 'nearest-city') {
        return { changed: false, location: current };
    }
    const next = resolveSpatialLocation(anchorLat, anchorLon);
    const changed = next.regionalLocationId !== current.regionalLocationId
        || next.styleCityId !== current.styleCityId
        || next.styleCityContainsPosition !== current.styleCityContainsPosition
        || next.terrain?.surfaceStyle !== current.terrain?.surfaceStyle
        || next.naturalGround?.style !== current.naturalGround?.style
        || next.localBird !== current.localBird
        || next.passengers !== current.passengers;
    if (!changed) return { changed: false, location: current };
    active = next;
    console.log(logStamp(), `[locations] ${active.id} regional style is now ${active.styleCityId}`
        + ` (${active.terrain?.surfaceStyle})`);
    return {
        changed: true,
        location: active,
        previousStyleCityId: current.styleCityId || null,
        styleCityId: active.styleCityId || null,
    };
}

export function getLocation() {
    const { provider, profile } = configuredWorldProfile();
    if (active && activeProvider === provider) return active;
    active = { ...profile };
    activeProvider = provider;
    console.log(logStamp(), `[locations] active source profile: ${active.id || provider.id} (buildings: ${active.buildings})`);
    return active;
}

// All consumers of the shared building tile stream must use the same key and
// endpoint. Keeping this mapping beside the per-location source selection
// prevents decoration/exclusion layers from quietly inventing a parallel
// city-specific building pipeline.
export function buildingEndpointForLocation(location = getLocation()) {
    // buildingEndpoint overrides the URL WITHOUT changing `buildings`, which
    // stays the builder-dispatch key ('gdi' | 'overture') that buildings.js
    // branches on in a dozen places. /buildings-render serves the same
    // footprint+height shape as /buildings-overture — it just resolves the best
    // available source per building first, and emits object_id/height aliases
    // so the Overture path consumes it unchanged.
    if (location?.buildingEndpoint) return location.buildingEndpoint;
    // 'mesh' = the source-agnostic endpoint: the server unions every survey
    // covering the bbox and labels each feature by geometry KIND.
    if (location?.buildings === 'mesh') return 'buildings-mesh';
    if (location?.buildings === 'gdi') return 'buildings-3d';
    if (location?.buildings === 'overture') return 'buildings-overture';
    return 'buildings-bus';
}

// The source key and URL suffix are one contract. In Zagreb the visible
// building layer asks /buildings-3d to fill ragged GDI coverage with Overture;
// every exclusion/decor consumer must subscribe to that exact same response or
// SharedTileSession quite correctly treats it as a second source and fetches
// the near ring twice.
export function buildingTileSourceForLocation(location = getLocation()) {
    const endpoint = buildingEndpointForLocation(location);
    // Both mesh endpoints top up ragged survey coverage with Overture, because
    // coverage is a property of the data and only the server can resolve it.
    const querySuffix = (endpoint === 'buildings-3d' || endpoint === 'buildings-mesh')
        ? '&fill=overture' : '';
    return {
        endpoint,
        key: `buildings:${endpoint}${querySuffix}`,
        querySuffix,
    };
}

// The horizon ring, 800-1600 m out. It must agree with the DETAILED layer about
// how tall a building is, or the building visibly grows or shrinks at the
// ~300 m hand-off — so where the detailed layer streams resolved heights, this
// one has to as well. /buildings-lod1 would hand back the same footprints with
// no height and the ring would guess every one of them.
export function farBuildingTileSourceForLocation(location = getLocation()) {
    // farBuildingEndpoint is explicit where the detailed layer streams MESHES:
    // the horizon still wants cheap prisms with resolved heights, so it cannot
    // simply reuse the detailed endpoint any more.
    const endpoint = location?.farBuildingEndpoint
        || (buildingEndpointForLocation(location) === 'buildings-render'
            ? 'buildings-render' : 'buildings-lod1');
    // fill=overture only means anything to the GDI-backed lod1 endpoint; the
    // resolver has already unioned the surveys before the row exists.
    //
    // limit MATCHES the ring's own FAR_MAX_PER_TILE of 600 — not twice it. The
    // server already returns them ordered by height, so its top 600 is the top
    // 600; asking for 1200 doubled the payload to buy a marginal re-ordering of
    // buildings the ring then threw away. Measured on an 800 m Split tile:
    // 700 KB at limit=1200 against the lod1 path's 317 KB, which is what made
    // the horizon take visibly long to fill in.
    //
    // simplify=1 because these prisms are drawn 800-1600 m away, where the
    // default 0.5 m vertices are sub-pixel. The endpoint's own bbox heuristic
    // cannot infer this: the detailed ring requests boxes the same size.
    // The two far endpoints take different query shapes: the resolved one caps
    // and simplifies, the lod1 one fills from Overture.
    const querySuffix = endpoint === 'buildings-render'
        ? '&limit=600&simplify=1' : '&fill=overture';
    return {
        endpoint,
        key: `buildings-far:${endpoint}${querySuffix}`,
        querySuffix,
    };
}
