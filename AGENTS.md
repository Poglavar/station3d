# Station3D instructions for coding agents

These instructions apply to the whole repository. Read `README.md`,
`docs/consumer-integration.md`, `docs/provider-contract.md` and
`docs/extraction-boundary.md` before changing public APIs, build output, data
contracts or repository boundaries.

## Mission

Station3D is the reusable engine. Keep terrain and surface precedence, ground
removal/backstops, roads, rails, curbs, collision, movement, streaming,
generic geometry, rendering, diagnostics and reusable campaign runtime here.

Keep regional providers, named structures, local liveries, product UI,
dialogue, actors, triggers, cinematics and explicit set pieces in downstream
packages. Do not solve a downstream problem by introducing city/country checks
or a second implementation of a world rule in product code.

## Consumer contract

- Consumers install an exact npm version and run `station3d-vendor` during
  their build. Do not tell consumers to expose `node_modules` or copy selected
  chunks by hand.
- The vendored directory is atomic: loader, stylesheet, chunks, workers,
  decoders and runtime assets must remain together.
- Configure the world and host before opening a session.
- Treat `window.Station3D` and the package `exports` map as public API. Update
  the README, integration docs and tests for every public change.
- The v0.1 provider is an HTTP-base configuration, not an arbitrary callback
  provider. Do not document unsupported callback injection.
- If an HTTP path, query, response shape or binary format changes, document and
  test the compatibility change. Prefer additive/versioned changes.

## Source ownership

- Engine source lives under `website/station-3d/` and reusable root tools.
- `website/station-3d/dist/` and `node_modules/` are generated; never edit or
  commit them.
- Vehicle factories stay independent of session/world state.
- Campaign adapters may call shared engine APIs but must not implement terrain,
  surface, collision, streaming or rendering policy.
- Do not add a dependency on a sibling checkout, a private service, a secret,
  or an absolute local filesystem path.

## Assets and licensing

- Do not add media, models or datasets without a matching
  `assets.manifest.json` entry containing provenance and an explicit licence.
- Update `THIRD_PARTY_NOTICES.md` when adding or changing third-party material.
- `npm run assets:audit:release` must pass before publication or before calling
  the extraction complete. Do not weaken its regional-input or
  unmanifested-media checks to make a release pass. The known blockers in
  `docs/asset-audit.md` are real extraction work, not expected-release output.
- OSM/Overture/provider attribution belongs in provider data and must remain
  visible to the host. The MIT code licence does not relicense world data.

## Implementation and tests

- Maintain only `docs/performance/audit.md` and `docs/performance/next-steps.md`
  as the canonical performance audit and backlog. Update them in place; keep
  dated measurements in machine-readable receipts, not new Markdown trackers.
  Preserve failed-run evidence and cross-mode support/appearance/selection gates.
- Keep meaningful logic in plain modules that can run under Node; keep DOM and
  WebGL wiring thin.
- Add deterministic tests for changed logic and contracts.
- Preserve generic behavior across static, walk, road and rail sessions unless
  a capability is explicitly mode-specific.
- Before handing off a change, run:

```sh
npm test
npm run build:station3d
npm run assets:audit:release
npm run test:package
git diff --check
```

- A build reporting any `Review-required bundle inputs` is not publishable.
- Browser verification is appropriate for integration or visual changes, but
  it does not replace the headless contract tests.

## Git and attribution

- Do not commit, push, publish, create releases or change remotes unless the
  user explicitly requests that action.
- Do not add an AI system as author or co-author. Do not add model/vendor names,
  generated-by banners or session links to source, docs, commits or assets.
- Preserve unrelated work in a dirty tree and report it rather than reverting
  it.

## Completion standard

A change is complete only when a clean consumer can install the actual packed
tarball, vendor it into a public directory, load `loader.js`, configure a world
and host, and open the relevant mode without relying on the original regional
application.
