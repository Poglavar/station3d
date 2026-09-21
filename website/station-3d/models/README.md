# Station3D model library

This directory owns reusable vehicle and small-object factories. A model
factory owns geometry, materials, variants and local animation handles. World
layers or downstream content packages own placement, terrain support,
interactions, streaming and session teardown.

Creator-authored vehicle models covered by the repository MIT licence are
listed in [`vehicles/LICENSE.md`](vehicles/LICENSE.md). Product names and
liveries identify depicted subjects; they do not imply affiliation or a
trademark licence.

## Included models

| Family | Source | Runtime use |
| --- | --- | --- |
| TMK 2400 trams | `vehicles/tram.js`, `tmk-2400-detail.js`, `tmk-2400-fleet-geometry.js` | Player cab and ambient tram factories |
| HŽ 7022 train | `vehicles/hz-7022.js` | Generic rail-vehicle publication |
| Road fleet | `vehicles/road-vehicles.js`, `road-fleet-models.js`, `traffic-vehicle-catalog.js`, `vehicles/fleet/*.json` | Ambient and controllable road traffic |
| Bicycles | `vehicles/bicycle.js` | Road-traffic adapters |
| Generic boat and airplane | `vehicles/boat-airplane.js`, `boat-airplane-geometry.js`, `leut-geometry.js` | Special-vehicle controller |
| UTVA aircraft | `vehicles/aircraft-models.js`, `utva-airplane.js`, `utva-liaison.glb` | Select with `model: 'utva'`; preload before creating an instance |
| Tram cab | `vehicles/cab-interior.js` | First-person cab mode |
| Construction machinery | `vehicles/construction-machinery.js`, `construction-machinery-rig.js` | Reusable consumer-authored set pieces |
| Street furniture and props | `objects/*.js` | Decor layers, interactions and downstream content |

The shared model viewer is at `website/station-3d/model-viewer.html`. From the
repository root, run:

```sh
npm run models:viewer -- 8105
```

Then open <http://localhost:8105/station-3d/model-viewer.html>. See
[`../viewers/README.md`](../viewers/README.md) for viewer controls and catalog
registration.

## Adding a model

1. Add a clearly named module under `vehicles/` or `objects/`.
2. Return a local-coordinate Three.js group plus only the animation handles an
   adapter needs. Do not import session, UI or campaign state into a factory.
3. Register the preview in `../viewers/model-catalog.js`.
4. Record every binary/runtime asset in the root `assets.manifest.json`, with
   author, source, licence and release-clearance fields.
5. Add engine-owned geometry or behavior tests and run the repository
   verification sequence.

Generic terrain, surface precedence, road/rail formations, collision and
streaming stay in the engine. Named buildings, landmarks, bridges, authored
actors, campaign set pieces and regional data adapters belong in downstream
content packages.

## Runtime asset rules

Factories may reference audited runtime assets through
`station3dAssetUrl(...)`. The build copies only paths explicitly allowed by
`assets.manifest.json`; `npm run assets:audit:release` and
`npm run test:package` verify the published boundary. Editable studies,
reference renders and campaign media are not part of the initial public
package.

Shared geometry/material caches must expose teardown, and live model instances
must own or safely share their resources according to the engine disposal
contract.
