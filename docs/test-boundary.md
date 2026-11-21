# Test ownership boundary

## Current state

Every test inherited from zagreb-isochrone now has an owner. The engine-owned
manifest (`tests/engine-owned.json`, the `npm test` target) holds the inherited
tests that exercise engine code, including those updated to the engine's later,
intended changes; tests and assertions that need Zagreb host files, campaign
content, Croatian datasets or downstream audio stay in zagreb-isochrone, which
runs them against the installed Station3D package.

The extracted repository must not copy the whole Zagreb application merely to
make inherited tests green.

## Classification

### Station3D-owned

Move the implementation or supporting tool into Station3D and retain the test:

- Runtime `core/`, `world/`, `scene/`, generic `modes/` and cleared model tests.
- Worker bundling and terrain/render compiler tests.
- Immutable world-pack validation, baking and publication tests.
- Engine performance parsers and deterministic scenario helpers.
- The shared tunnel-cover, tram-switch, deep-link and transit-station model
  helpers currently retained at the `website/` level.

Representative missing tools include `bundle-station3d-worker.mjs`,
`publish-station3d-world.mjs`, and engine-focused `perf-*` modules.

### Cross-repository contracts

These should run in the Zagreb repository against a tagged or locally linked
Station3D package:

- Planner-to-Station3D deep links and position sharing.
- Host import maps, modal bootstrap and mobile entry wiring.
- Planner route/profile handoff to rail and cab modes.
- Reduced-motion and host overlay integration.
- Data-provider response schemas and attribution delivery.

Station3D should own the contract fixtures and schema validators; Zagreb should
own proof that its host and API conform.

### Zagreb-owned

Leave these downstream:

- Sloboda explorer host, ambience, highlighting and rail overlays.
- Toranj voice authoring/editor/gateway and campaign source-edit tools.
- Croatian HŽ/reference-rail imports, historical speed and gradient datasets.
- Transit planner editing, pricing, civil-object views and leaderboard UI.
- DGU terrain fixture coverage and Zagreb/Split regional registry behavior.
- Tower viewer and other named-structure QA.

## Migration rule

The public engine test command will use a positive manifest of Station3D-owned
tests. It must not use a growing exclusion list, because new downstream-coupled
tests would otherwise enter the engine suite silently.

A new test joins the manifest only when everything it reads ships in this
repository; a test that also needs a downstream host is a contract test and
lives with that host.
