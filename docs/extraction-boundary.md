# Station3D extraction boundary

## Source of truth

The public Station3D repository will become the source of truth for reusable
engine behavior. The Zagreb product will consume tagged Station3D releases and
provide regional profiles, data adapters, structures and authored campaigns.
There must not be two independently edited copies of the engine.

## Belongs in Station3D

- Terrain rendering and surface precedence
- Road, path, curb and rail formations
- Collision, movement, streaming, LOD and render compilation
- Generic walk, road-vehicle, rail, boat and aircraft controllers
- Generic vehicles, people, objects and model interfaces whose assets are
  cleared for redistribution
- The generic campaign reducer, schema, dialogue and cinematic runtime
- Diagnostics, inspectors and performance controls
- Provider contracts for roads, buildings, terrain, water, decor, weather and
  immutable world packs

## Remains downstream

- The Toranj campaign, authored scenes, dialogue, cinematics and set pieces
- Named Croatian structures and construction stages
- DGU/GDI-specific configuration and Croatian coverage profiles
- Solved Croatian railway projects
- Regional vehicle identities and liveries unless explicitly cleared; the
  creator-authored TMK 2400, HŽ 7022 and UTVA runtime models are cleared under
  MIT and remain reusable engine assets
- Campaign audio, voices, portraits and other authored media
- Zagreb proposal/editor, transit-planner and Sloboda host integration

## Current dependency findings

The runtime has four source dependencies outside `website/station-3d`; all are
retained in this staging repository while they are converted to ordinary engine
modules:

- `website/station3d-links.js`
- `website/tram-switch-utils.js`
- `website/tunnel-cover-rule.js`
- `website/shared/transit-station-models.js`

The engine-owned test manifest covers only reusable engine behavior. Authored
Toranj/Zagreb source and legacy product tests remain in the downstream
repository; each future test must still be classified as engine-owned,
downstream-owned, or a contract test shared by both repositories.

## Public-release gates

1. A clean clone can install, build, test and start a demo without a sibling
   repository, secret or private service.
2. Runtime world data is supplied through injected provider contracts rather
   than Zagreb-named globals or a fixed `/api` implementation.
3. The demo uses a deterministic, redistributable provider fixture and the
   browser runtime opens successfully against it.
4. Every shipped asset has machine-readable source, author and license data.
5. Campaign and regional content is absent or distributed as an independently
   licensed package.
6. The engine code and explicitly listed creator-authored vehicle models use
   MIT; all other assets retain their recorded terms.
7. OSM/Overture attribution is visible at runtime and derivative database
   obligations are documented alongside data-pack tooling.
8. The Zagreb product successfully consumes a tagged Station3D release through
   the same public API available to third parties.
