# Station3D provider contract

This document describes the public provider boundary in `0.1.x`.

## Configuration

Call `Station3D.configureWorld(options)` once before the first session:

```js
Station3D.configureWorld({
  id: 'example-world',
  apiBaseUrl: 'https://world.example/api',
  bounds: { west: -1, south: 50, east: 1, north: 52 },
  attributions: [{
    name: 'OpenStreetMap contributors',
    url: 'https://www.openstreetmap.org/copyright',
    license: 'ODbL 1.0',
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/'
  }],
  worldProfile: {
    id: 'example-world',
    buildings: 'overture',
    farBuildings: true,
    decorEnabled: false,
    apiDecor: true,
    passengers: false,
    water: true,
    terrain: { surfaceStyle: 'grass' }
  }
});
```

Configuration is validated, cloned and frozen. Mutating the original object
after the call does not change an active provider.

`apiBaseUrl` may be root-relative or absolute HTTP(S). When it is cross-origin,
the service must allow the application's origin through CORS. Station3D does
not send credentials by default, so authenticated private services should be
placed behind an application-owned same-origin proxy.

## World profile

The neutral profile currently recognizes these common capability fields:

| Field | Typical value | Effect |
| --- | --- | --- |
| `id` | `'example-world'` | Stable profile/debug identity. |
| `buildings` | `'overture'`, `'mesh'`, `'gdi'` | Selects the compatible building endpoint/decoder. |
| `buildingEndpoint` | `'buildings-overture'` | Optional endpoint override without changing the decoder family. |
| `farBuildings` | `true` | Enables the horizon building ring. |
| `farBuildingEndpoint` | `'buildings-render'` | Optional far-building endpoint override. |
| `decorEnabled` | `false` | Enables legacy/static decor only when a product supplies it. |
| `apiDecor` | `true` | Streams decor from the provider API. |
| `passengers` | `false` | Enables passenger/fare systems when the product provides demand data. |
| `water` | `true` | Streams water polygons. |
| `terrain.surfaceStyle` | `'grass'` | Selects the generic ground appearance. |
| `terrain.source` | provider-defined key | Selects a terrain source passed to `/terrain/grid`. |
| `naturalGround` | sizing/style object | Controls the natural-ground ring. |
| `urbanGround` | sizing object | Controls the near urban composite. |

Do not advertise a capability that the data service cannot answer. Optional
visual systems should be disabled explicitly rather than returning invented
data.

## HTTP service in 0.1

The current provider abstraction supplies one base URL. Engine layers append
endpoint paths and geographic bounding boxes. Common endpoint families are:

| Family | Examples | Expected form |
| --- | --- | --- |
| Buildings | `/buildings-overture`, `/buildings-mesh`, `/buildings-lod1` | GeoJSON `FeatureCollection`; geometry/properties must match the selected building decoder. |
| Roads | `/roads`, `/roads/cab`, `/roads/curbs`, `/roads/vertical-alignments` | GeoJSON, or the versioned `RTL1` binary format when `format=bin` is requested. |
| Terrain | `/terrain/grid?bbox=…&res=…&source=…` | JSON metadata plus base64-encoded typed height/source arrays. |
| Water | `/water?bbox=…` | GeoJSON `FeatureCollection`. |
| Decor | `/decor?kind=…&bbox=…` | GeoJSON `FeatureCollection`. |
| Coverage | `/prepared-coverage` | Prepared-area metadata used for honest missing-data warnings. |
| Telemetry | `/telemetry` | Optional product-owned diagnostics sink. |

This is a compatibility contract, not a complete standalone backend
specification yet. The binary road and terrain decoders are versioned in
`core/road-tile-binary.js` and `core/terrain-api-grid.js`. If you are building
a new backend, begin with JSON/empty fixtures and one enabled capability at a
time, or proxy an existing compatible provider. Do not infer response fields
from screenshots or silently replace missing measurements with zero.

## Empty development provider

`tools/serve-demo.mjs` implements the smallest deterministic development
fixture: requests below `/demo-api/` return empty GeoJSON collections, with a
small special case for catchment statistics. It proves that packaging, loader,
host configuration and session startup do not depend on a regional app or a
private service.

An empty provider is useful for integration work but is not an OSM importer.
Station3D does not download or preprocess a planet extract in the browser.

## Attribution and data licences

Every provider/world pack owns its data attribution. Include at least the
upstream name and, where available, source URL, licence name and licence URL.
OSM-derived databases and produced works remain subject to ODbL requirements;
the Station3D MIT licence applies only to the engine and explicitly MIT-licensed
project assets.
