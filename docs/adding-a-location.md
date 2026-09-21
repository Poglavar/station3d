# Adding a location (supported city / served area)

A "location" in the planner is **not a live OSM pull** — it is a curated bundle
of data that has to be prepared ahead of time. That is why planning is only
allowed inside the locations we've prepared (Zagreb, Split), and why adding a
new one is a deliberate checklist rather than something that happens on the fly.

A project belongs to exactly one location; the app detects it from the project
geometry (or an explicit `?loc=`) and stores it on save. See
`website/location-registry.js` and `website/station-3d/core/locations.js`.

## What a location needs

| Layer | Zagreb | Split | Sjeverna Dalmacija | Notes |
|---|---|---|---|---|
| **Buildings** | GDI LOD2 meshes (`/buildings-3d`) | Overture footprints+heights (`/buildings-overture`) | Overture | Ingested into the DB per area. Not fetched live. |
| **Far horizon (LOD1)** | `/buildings-lod1` GDI prisms | same endpoint's all-or-nothing Overture fill | same as Split | Enabled per location via `farBuildings` in `core/locations.js`. Where the detailed source is Overture, far prisms share its object_ids and must run the same area+seed height estimate (`pickFarHeightForFeature`) or every building pops at the ~300 m LOD swap. |
| **Elevation grid** | live `/api/terrain/grid` | live `/api/terrain/grid` | live `/api/terrain/grid` | All three read `public.dgu_dem` (`terrain/import-dgu-dem.js --bbox …`). Split's shipped `terrain/split-dgu-dtm-20m.{json,bin}` was retired on 2026-07-26: it covered 16.20–16.56 E / 43.45–43.62 N and stopped short of the M604 north of Kaštela, so the existing railway had no surface to sit on for its first 14.8 km. The two sources agree to +0.46 m mean. |
| **Decor** (trees, greenery, hedges, footpaths, benches, crossings, fountains) | `/api/decor` (multi-city, DB) | `/api/decor` (multi-city, DB) | `/api/decor` (47k features) | `apiDecor: true`. Zagreb's baked `zagreb_tram_*.json` set was retired on 2026-07-26 — greenery alone had reached 14 MB fetched whole per session, and the file's extent silently capped coverage. `decorEnabled` is the legacy baked path; no location should need it again. |
| **Water** | none — decor `greenery` carries the Sava, lakes and ponds as flat `water` surfaces | `/api/water` (`overture_water`), sunk below ground as sea | `/api/water` — Zadar and Šibenik are coastal | `water: true` turns on the dedicated layer. **Do not set it for an inland city whose decor already draws its rivers — you get the same water twice.** `overture_water` is ingested for Zagreb regardless (it is a cleaner river source if the layer is ever reworked). |
| **Roads / curbs** | DB `osm_road` (bbox) | DB `osm_road` (bbox) | DB `osm_road` (bbox) | Multi-city; the data must be present for the bbox. |
| **Ground style** | `terrain: { surfaceStyle: 'grass' }` → procedural farmland patchwork | `surfaceStyle: 'dalmatian-karst'` | `'dalmatian-karst'` | `'grass'` also opts the ground into the field quilt (`core/field-patchwork-texture.js`); any other style is left as authored. |
| **Census (ridership)** | yes (residents/jobs) | **no** | **no** | Drives the leaderboard. No census ⇒ routes score 0 and land in the *unranked* tab. |
| **Existing rail (reference)** | reference projects | reference projects | reference projects | Every source is imported offline as an ordinary read-only `purpose: existing`, `access: reference` project. Solved reconstructions carry EVRF2000 heights; local-PBF OSM imports declare terrain draping. The same “Ostale pruge” toggle controls map and 3D/sim display. |
| **Valhalla routing** | covered | check graph coverage | check graph coverage | Station catchments need Valhalla to reach the area; outside the graph, isochrones fail and population is 0. |

## Corridor locations

A long-distance railway is not a city. Zagreb–Split is 422 km whose bounding box
covers 26,000 km² of Bosnia, Kvarner and open sea, while its 5 km corridor is
1,273 km² — a quarter of what Sjeverna Dalmacija's rectangle ingests. So the
served area is the strip along the line:

- **The centreline** comes from `scripts/build-rail-corridor.mjs`, which stitches
  the OSM refs into one ordered polyline (`corridors/zagreb-split.geojson`, plus a
  coarse copy). Long lines are routed as explicit **legs**: OSM's M604 chain has a
  24 m gap on the northern approach to Knin, and joining legs across a logged seam
  is honest where silently bridging "whatever is 24 m away" is not.
- **Ingests take `--corridor <geojson>`**: buildings and water prune the remote
  Overture scan with the cells the corridor touches (76 for Zagreb–Split, 6,656 km²
  against a 26,116 km² box) and then test every row against the real width; roads
  use Overpass's own `around:` selector, sliced into ~100 km pieces because the
  whole line in one query comes back empty; decor bakes from a PBF pre-clipped to
  the corridor polygon (`osmium extract -p`, `DECOR_PBF=…`).
- **Detection is ordered, not disjoint.** A corridor runs THROUGH the cities it
  connects, so `detectByLatLng` checks city bboxes first and corridors second:
  inside Zagreb you are in Zagreb. `location-registry.test.mjs` enforces that
  cities never overlap each other and that a city always wins.
- **A PLANNED line has no OSM track to stitch.** The nizinska pruga corridor
  (`corridors/nizinska-pruga.geojson`, Karlovac–Krasica, 108 km) is generated
  from the checked-in design reconstructions
  (`scripts/legacy-rail/nizinska-*/network.geojson`) instead of
  `build-rail-corridor.mjs` — same Feature shape (`LineString`,
  `properties.widthM`), so `lib/corridor.js` and every `--corridor` ingest
  consume it unchanged. When corridors overlap, their order in
  `location-registry.js` decides: `zagreb-split` sits before `nizinska-pruga`,
  so the legacy strip keeps Karlovac and Tounj while the new corridor claims
  only the previously unserved Belaj–Tounj alignment and the Skradnik–Krasica
  middle.
- **Ground style comes from the nearest city** (`styleFrom: 'nearest-city'` in
  `core/locations.js`). One config for 422 km, but the look is resolved per session
  from its anchor by `applyAnchorStyle`: farmland around Karlovac (from Zagreb),
  karst at Gospić (from Sjeverna Dalmacija). Sources — Overture buildings, DB
  decor, the live DGU grid — are the same the whole way.

## Checklist to add a location `X`

0. **Pick ONE bbox for X and use it for every ingest.** Buildings, roads, water and
   decor each have their own `CITIES`/`DECOR_BBOX` entry, and when they disagree the
   world simply ends in a different place per layer — buildings on a roadless plain,
   or roads running into blank ground. That reads as a rendering bug, not an edge of
   coverage, and it has cost real debugging time. Zagreb's is
   `15.58,45.60,16.30,46.00` (the commuter basin: Jastrebarsko/Samobor/Zaprešić/
   Dugo Selo/Velika Gorica) and Sjeverna Dalmacija's is `15.15,43.65,16.30,44.20`
   (Zadar–Šibenik–Knin), each repeated verbatim in
   `cadastre-data/buildings/fetch-overture-buildings.js`,
   `cadastre-data/roads/fetch-osm-roads.js`, `cadastre-data/water/fetch-overture-water.js`
   and the `DECOR_BBOX` used for the decor bake. Also check the DGU DEM reaches it
   (`public.dgu_dem` starts at lon 15.6344, so Zagreb's western border strip has
   buildings but flat terrain under `?elevation=1`).

   **Prepared bboxes must not overlap.** `detectByLatLng` returns the first match,
   so an overlap makes a project's location depend on registry order. Sjeverna
   Dalmacija stops at 43.65 because Split reaches 43.64;
   `location-registry.test.mjs` fails on any overlapping pair.

   **Every one of these scripts writes to the LOCAL database only.** Prod needs a
   separate manual copy per table (dump → scp → staging table → swap inside one
   transaction, DDL as `sudo -u postgres`); prod cannot even run the Overture
   scripts, as it has no duckdb. Skipping this is the single most common way a
   location looks broken in prod while being fine locally — diagnose it by comparing
   `min/max(ST_X/ST_Y(...))` per city on both databases, never by reading client code.
   A clean rectangular corner is an ingest bbox, never real absence.
1. **Buildings** — ingest footprints/meshes for X's bbox (Overture is the
   easiest multi-city path; see `cadastre-data/buildings/fetch-overture-buildings.js`).
   For a city with no LOD2 survey, `?fill=overture` on `/buildings-3d` and
   `/buildings-lod1` tops the response up per building, so X needs no GDI equivalent.
2. **Elevation** — two delivery paths: either ship a static DGU DTM grid like
   Split (`scripts/build-terrain-dgu.mjs` → `website/terrain/`, referenced by
   `LOCATIONS.X.terrain`), or serve it live like Zagreb from `/api/terrain/grid`
   (set `terrain: {}` as an endpoint marker). Either way, import the DGU tiles into
   `public.dgu_dem` (`cadastre-data/terrain/import-dgu-dem.js --bbox …`) — the live
   endpoint and `/api/terrain/profile` both read it. Add `terrainOptIn: true` to
   ship the location flat by default (DGU on with `?elevation=1`) while draping is
   still being tuned.
3. **Decor** — bake from OSM, then load into the DB; the world reads it by bbox and
   never sees a file:
   ```bash
   # 1. refresh the PBF if stale (validate BEFORE overwriting the working copy —
   #    osmium infers format from the extension, so a *.part name fails the check)
   curl -fL -o croatia-latest.osm.pbf.part https://download.geofabrik.de/europe/croatia-latest.osm.pbf
   osmium fileinfo --input-format=pbf croatia-latest.osm.pbf.part && mv …

   # 2. bake all eight kinds SEQUENTIALLY — the generators share hardcoded /tmp
   #    scratch paths and clobber each other in parallel. Greenery FIRST (see below).
   DECOR_BBOX='<X bbox>' DECOR_OUT=<dir>/X_<kind>.json \
     node scripts/build-tram-<kind>-osm.mjs        # trees greenery hedges footpaths benches crossings fountains

   # 3. load (validates without --run; replaces only X's rows, transactionally)
   cd ../cadastre-data/api && node scripts/load-osm-decor.mjs --city X --dir <dir> --run
   ```
   Four things that will bite:
   - The loader expects `<city>_<kind>.json`; the generators default to
     `zagreb_tram_<kind>*.json`. Always pass `DECOR_OUT`.
   - **`build-tram-footpaths-osm.mjs` keeps only footpaths crossing green polygons and
     reads `DECOR_GREENERY`, defaulting to the old shipped greenery file.** Bake greenery
     first and point `DECOR_GREENERY` at the new output, or footpath coverage silently
     inherits whatever bbox that old file had (this cost 39k segments once).
   - **Fountain ownership is split by source geometry, not rendered twice.** Point
     fountains stay in `<city>_fountains_osm.json` as generic props. Polygonal
     basins are exact `semantic=fountain` water features in greenery; open fountain
     ways are buffered along their authored line there. Always rebuild both files
     together when refreshing fountains.
   - **`crossings` keeps only crossings within 60 m of a TRAM track** (`NEAR_TRACK_M`),
     so it is legitimately empty wherever X has no trams. Not a clipping bug; change the
     constant only if you mean to change what the asset represents.
   - Adding an eighth kind means touching five places: the `osm_decor_kind_check`
     constraint (new file under `api/ddl/decor/`, applied to BOTH databases), the
     loader's `DECOR_KINDS` + `FILE_NAMES` + an explicit `rowsForKind` branch, the API's
     `DECOR_KINDS`, and the `apiDecor` branch in `world/decor.js`. Miss the last one and
     the kind vanishes silently for every apiDecor city — exactly how fountains were
     lost until 2026-07-26. Verify with `GET /api/decor/status?city=X` (`missing_kinds`).
4. **Water** — only if X actually needs the dedicated layer (coastal). Ingest with
   `cadastre-data/water/fetch-overture-water.js --run --city X`, then set `water: true`.
   For an inland city, leave it off and let decor greenery draw the rivers.
5. **Valhalla** — confirm the routing graph covers X (needed for station
   catchments); extend it if not.
6. **Census** — optional but needed for leaderboard ranking; without it X's
   projects stay unranked (which is fine, just call it out).
7. **Existing rail** — optional, but it is what makes a planned route legible
   against reality. Import a solved profile with
   `scripts/build-reference-rail-transit-project.mjs --post …`, or prepare a
   terrain-draped project from a local extract with
   `scripts/build-osm-rail-reference-project.mjs --pbf … --bbox … --location X`.
   This pipeline is deliberately offline-only: there is no Overpass or live OSM
   fallback. Only import absolute-profile stretches whose terrain coverage is
   valid. The API discovers all reference projects; no registry source switch is
   required. See the README section.
8. **Register X** in two places, keeping ids aligned:
   - `website/location-registry.js` — `bbox` (served-area extent) + a `prepared`
     note. This is the allowlist + geometry detection.
   - `website/station-3d/core/locations.js` — `LOCATIONS.X` render config
     (building source, `terrain` grid files, `apiDecor`, water, ground style).
9. **Verify** — `?loc=X` shows the right buildings/terrain in walk/cab; drawing a
   route there detects `location: 'X'` on save and reloads with it.

Until all of this exists for X, drawing there should be blocked (Phase 2) rather
than shipped as a flat, buildingless, unrankable world.
