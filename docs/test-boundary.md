# Test ownership boundary

## Baseline

The first history-preserving extraction runs 4,694 assertions. Of those, 4,574
pass and 120 fail. The failures occur across 81 test files plus individual
assertions in otherwise loaded files. They primarily expose deliberately
omitted Zagreb host files, not production-bundle failures; the standalone
Station3D bundle already builds successfully.

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

During migration:

1. Add an explicit engine-owned manifest.
2. Bring generic supporting tools into the extracted history.
3. Move downstream tests back to their owning repository or convert them into
   contract tests.
4. Make `npm test` green in Station3D.
5. Keep the full inherited run available as `test:extraction-audit` until every
   test has an owner, then remove that temporary command.

The first positive manifest is checked in at `tests/engine-owned.json` and is
now the default `npm test` target. It intentionally starts with deterministic,
host-independent contracts; additional inherited tests move into it only after
their source and fixture ownership are confirmed.
