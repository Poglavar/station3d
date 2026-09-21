# Station3D

**A travel and game engine for explorable 3D worlds, powered by OpenStreetMap
and other open data.**

Station3D is a browser-based 3D world engine for maps, travel experiences and
games. It renders streamed terrain, buildings, roads, paths, rails, water,
vehicles and pedestrians around geographic coordinates and provides walking,
driving, rail and static-view modes.

## In-engine gallery

These are live Station3D scenes inside the Zagreb and Sloboda applications.
Select an image to open the full-resolution capture.

<table>
  <tr>
    <td colspan="2">
      <a href="https://raw.githubusercontent.com/Poglavar/station3d/main/website/station-3d/media/readme-gallery/zagreb-street.jpg"><img src="https://raw.githubusercontent.com/Poglavar/station3d/main/website/station-3d/media/readme-gallery/zagreb-street.jpg" alt="Street-level Station3D view in Zagreb with roads, a cycle lane, buildings, trees and a pedestrian." width="100%"></a><br>
      <sub>Zagreb street scene: streamed roads, cycle infrastructure, buildings and street life.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <a href="https://raw.githubusercontent.com/Poglavar/station3d/main/website/station-3d/media/readme-gallery/split-st-duje.jpg"><img src="https://raw.githubusercontent.com/Poglavar/station3d/main/website/station-3d/media/readme-gallery/split-st-duje.jpg" alt="Station3D aerial view of the Cathedral of Saint Domnius and the surrounding Split roofscape." width="100%"></a><br>
      <sub>Split landmark geometry integrated with the streamed city.</sub>
    </td>
    <td width="50%">
      <a href="https://raw.githubusercontent.com/Poglavar/station3d/main/website/station-3d/media/readme-gallery/split-rail-cab.jpg"><img src="https://raw.githubusercontent.com/Poglavar/station3d/main/website/station-3d/media/readme-gallery/split-rail-cab.jpg" alt="Station3D rail-cab view inside a lit tunnel near Split." width="100%"></a><br>
      <sub>Rail-cab mode with formed track, tunnel geometry and lighting.</sub>
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
      <a href="https://raw.githubusercontent.com/Poglavar/station3d/main/website/station-3d/media/readme-gallery/vis-mobile-campaign.jpg"><img src="https://raw.githubusercontent.com/Poglavar/station3d/main/website/station-3d/media/readme-gallery/vis-mobile-campaign.jpg" alt="Station3D mobile walking view on the Vis waterfront with touch controls and a campaign objective." width="300"></a><br>
      <sub>Mobile walking and campaign UI on the Vis waterfront.</sub>
    </td>
  </tr>
</table>

World data in these captures includes
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright) under
ODbL and the provider datasets credited by each host application.

Station3D is the temporary project name. Original engine code and the generic
road-fleet models are MIT licensed. Third-party audio keeps the licences listed
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

> **Alpha status:** the package and integration boundary are working locally,
> but `station3d@0.1.0-alpha.1` has not yet been published to npm. Until it is,
> install a tarball produced by `npm pack`. Pin every alpha exactly.

## What the package includes

- A self-contained browser distribution with JavaScript, CSS, workers, Draco
  decoders and audited runtime assets.
- A stable browser facade exposed as `window.Station3D`.
- World-provider configuration, host lifecycle callbacks and data-attribution
  metadata for the host to display.
- Static, walking, driving and rail-session entry points.
- A vendoring command that copies the complete browser distribution into an
  application's public directory.

It does **not** include an OSM database, geodata backend, tiles, a regional
campaign or an application shell. A real application supplies those pieces.

## Requirements

- Node.js 22 or newer for installation and build tooling.
- A modern browser with WebGL2.
- A static web server. Opening the demo or distribution through `file://` will
  not work because the engine loads ES modules, workers and assets by URL.
- For a populated world, an HTTP service implementing Station3D's current data
  endpoint families. See [Provider contract](docs/provider-contract.md).

## Install in an application

Once the alpha is on npm, pin it exactly:

```sh
npm install --save-exact station3d@0.1.0-alpha.1
```

Before publication, build a real package tarball from a Station3D checkout and
install that tarball in the consumer:

```sh
# In Station3D
npm ci
npm pack

# In the consuming application
npm install --save-exact /absolute/path/to/station3d-0.1.0-alpha.1.tgz
```

Do not use `npm link` for release testing. Symlinks can hide missing files and
incorrect asset URLs that a real npm package would expose.

## Copy the browser distribution

Station3D is delivered through npm, but it runs as an intact browser asset
directory. Copy it into the consumer's public tree during the app build:

```sh
npx station3d-vendor --force public/vendor/station3d
```

Use a dedicated destination whose final directory is named `station3d` or
`station-3d`. `--force` replaces an existing destination. The command refuses
unsafe targets such as the repository root, home directory or a Git checkout.

Keep the copied directory intact. Its hashed chunks, workers, decoder files,
CSS and media are one versioned unit.

Typical package scripts are:

```json
{
  "scripts": {
    "vendor:station3d": "station3d-vendor --force public/vendor/station3d",
    "build": "npm run vendor:station3d && your-existing-build-command"
  }
}
```

## Minimal browser integration

Load the generated `loader.js`. It installs the matching stylesheet and makes
the lightweight facade available through `window.__station3DReady`.

```html
<button id="explore-world">Explore in 3D</button>
<script src="/vendor/station3d/loader.js"></script>
<script type="module">
  const station3d = await window.__station3DReady;

  station3d.configureWorld({
    id: 'my-world',
    apiBaseUrl: 'https://world.example.com/api',
    bounds: {
      west: 2.20,
      south: 48.80,
      east: 2.45,
      north: 48.95
    },
    attributions: [
      {
        name: 'OpenStreetMap contributors',
        url: 'https://www.openstreetmap.org/copyright',
        license: 'ODbL 1.0',
        licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/'
      }
    ],
    worldProfile: {
      id: 'my-world',
      buildings: 'overture',
      farBuildings: true,
      decorEnabled: false,
      apiDecor: true,
      passengers: false,
      water: true,
      terrain: { surfaceStyle: 'grass' }
    }
  });

  station3d.configureHost({
    name: 'My application',
    basePath: '/explore',
    devOverlays: false,
    campaigns: false,
    onExit() {
      history.back();
    }
  });

  document.querySelector('#explore-world').addEventListener('click', () => {
    station3d.openWalk(48.8566, 2.3522);
  });
</script>
```

Call `configureWorld()` and `configureHost()` before opening the first session.
The facade queues an open request while the larger runtime is loading.

## Public browser API

The common entry points are:

| Method | Purpose |
| --- | --- |
| `configureWorld(options)` | Select the data service, bounds, attribution and world profile. |
| `configureHost(options)` | Set the host name, exit callback, campaign availability and development-overlay policy. |
| `ready()` / `preload()` | Load the full runtime without opening a session. |
| `open(lat, lon, name?, options?)` | Open a static 3D inspection view. |
| `openWalk(lat, lon, options?)` | Start a first-person walking session. |
| `openGta(lat, lon, options?)` | Start the free road-vehicle mode. Returns `false` outside configured bounds. |
| `openCab(train, line, poseFn, options?)` | Advanced rail integration using host-provided train, line and live pose data. |
| `close()` | Close the current Station3D session. |
| `setQuality('auto' | 'high' | 'medium' | 'low')` | Select the render-quality policy. |
| `setWeather(preset)` | Apply a supported weather preset. |
| `getPose()` | Read the current geographic camera/player pose, or `null`. |
| `getSessionSnapshot()` | Read the current cab/walk/drive session state, or `null`. |
| `getWorldProvider()` | Read the normalized immutable provider configuration. |
| `getWorldAttributions()` | Read the provider's attribution entries. |

`openCab()` is intentionally an advanced adapter boundary. Applications that
do not already own live rail state should begin with `open()`, `openWalk()` or
`openGta()`.

Data-audit and source-inspection applications may import the separately bundled
`/vendor/station3d/inspection.js` entry. It exposes stable entity keys,
selection state, source metadata and payload normalization helpers without
loading the world runtime or creating another render loop.

Planner hosts may import `/vendor/station3d/planning.js` for ENS-plan parsing
and proposal-track conversion. Development-only scenario links may lazily
import `/vendor/station3d/debug.js`; neither entry initializes the renderer.

Developer terrain inspectors may import `/vendor/station3d/terrain-tools.js`,
and authored dialogue preview pages may import `/vendor/station3d/voice-tools.js`.
These optional tooling entries also remain independent of the world runtime.

Explorer shells can import `/vendor/station3d/host.js` for localization,
loading-curtain, audio-unlock and session-controller helpers. Authored campaign
products use `station3d-build` with an explicit logical-path overlay manifest;
the resulting distribution is one bundle graph, so content does not bring a
second engine, Three.js runtime or render loop.

The browser dispatches these integration events:

- `station3d:runtime-ready` when the heavy runtime is loaded.
- `station3d:load-error` when the browser bundle cannot initialize.
- `station3d:open-refused` when an asynchronous open request is rejected.
- `station3d:pose` at a throttled cadence while a session is active.

## World-provider options

`configureWorld()` accepts plain data and freezes a defensive copy:

| Field | Meaning |
| --- | --- |
| `id` | Stable provider identifier: letters, digits, `.`, `_` and `-`. |
| `apiBaseUrl` | Root-relative or absolute HTTP(S) base URL. Defaults to `/api`. |
| `bounds` | Optional `{west, south, east, north}` geographic service extent. |
| `attributions` | Array of `{name, url?, license?, licenseUrl?}` records. |
| `worldProfile` | Rendering/data capabilities for this world. |

The neutral profile uses Overture-style buildings, a grass surface, water,
far buildings and API-backed decor. Override only capabilities your provider
actually serves. The currently supported profile fields and HTTP expectations
are described in [Provider contract](docs/provider-contract.md).

The v0.1 provider boundary configures an HTTP base URL; it is not yet a set of
JavaScript callback methods. A custom application therefore has two choices:

1. Point `apiBaseUrl` at a compatible Station3D data service or proxy.
2. Start from the deterministic empty provider in `demo/` while implementing
   its real data adapter.

The second option proves installation and UI integration, but naturally shows
an empty synthetic world rather than downloading OSM on its own.

## Try the repository demo

```sh
npm ci
npm run build:station3d
npm run demo:serve
```

Open <http://localhost:4173/demo/>. The demo uses a deterministic local endpoint
that returns empty GeoJSON collections, so it requires no credentials or
private service.

## Current extraction status

The installation path is functional: the engine test suite passes, the
production bundle builds, the actual npm tarball installs and vendors into an
isolated consumer, and the demo opens and renders in a browser.

The extraction is release-candidate clean: authored Toranj/Zagreb campaign
sources and their legacy tests remain downstream, while the creator-authored
TMK 2400, HŽ 7022 and UTVA vehicle models are explicitly released under MIT as
reusable engine assets. The release audit must remain green before any public
tag or npm publication.

## Develop Station3D

```sh
npm ci
npm test
npm run build:station3d
npm run assets:audit:release
npm run test:package
```

- `npm test` runs the engine-owned Node test manifest.
- `npm run build:station3d` generates the ignored browser distribution.
- `npm run assets:audit:release` rejects unlicensed media and regional/authored
  inputs in the public bundle.
- `npm run test:package` packs, installs and vendors the actual npm tarball in
  an isolated consumer fixture.

Do not edit `website/station-3d/dist/` or `node_modules/`; both are generated.

## Repository and product boundaries

Reusable terrain, surface precedence, roads, rails, collision, streaming,
movement and rendering belong here. Regional data adapters, named structures,
liveries and authored campaigns belong in separate consumer/content packages.
See [Extraction boundary](docs/extraction-boundary.md).

A downstream product should consume an exact tagged Station3D version rather
than copy engine files into its own source tree. This keeps fixes shared by all
products and makes upgrades reviewable.

## Instructions for coding agents

Coding agents should read [AGENTS.md](AGENTS.md) before changing the repository.
It defines the engine/content boundary, public API constraints, asset rules and
the required verification sequence. Agents integrating Station3D into another
application should also read [Consumer integration](docs/consumer-integration.md)
and [Provider contract](docs/provider-contract.md).

## Licence and provenance

- Original Station3D code and the creator-authored vehicle models listed in
  `website/station-3d/models/vehicles/LICENSE.md`: MIT.
- Packaged third-party audio: its recorded CC0, public-domain or CC BY terms.
- OSM-derived databases/world packs: ODbL obligations remain with the provider
  and data package; using this engine does not relicense that data.

See [Asset audit](docs/asset-audit.md),
[third-party notices](THIRD_PARTY_NOTICES.md) and
[extraction provenance](docs/extraction-provenance.md).
