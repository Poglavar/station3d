# Station3D performance next steps

Updated 8 October 2026. Read [audit.md](audit.md) for measurements, completed
work, scope and limitations. This is the single active performance backlog.
S1/S2, the S3 diagnostic probe, larger facade atlas pages, shadow reuse, opaque
sorting, lamp packing and road triangulation landed in alpha.3. Road read
evidence landed in alpha.5; paint and curb-query work landed in alpha.6.
Remaining portions of R1/R3/R4 and the complete-world performance comparison
are open. The loaded profile supports comparisons during ordinary host use.
The current queue is below; the dated diagnostic tables preserve the original
findings and must not be read as a list of still-unfixed alpha.6 failures.

The 23 September revision re-measured the 22 September claims against the same
served bundles (`cdd475cb…` standard, `d6ba6799…` Sloboda) and added frame-anatomy,
ground-generation, queue-liveness and draw-census probes. It found one liveness
bug that the previous list missed (S1), confirmed the car collider failure, and
replaced several "instrument first" items with measured, specific levers. See
"What changed" at the end for corrections to the previous version.

## Implementation status (released as Station3D `v0.1.0-alpha.3`, 23 September)

Everything in this table is in tag `v0.1.0-alpha.3` (`7a9fe04`). zagreb.lol runs
it in two places. The main transit page (`/prijevoz/`, `/prijevoz/transit.html`)
is the Universal Transit Planner release, which pins Station3D by tag: planner
`v0.1.0-alpha.4`. Sloboda and the OSM Checker use the Zagreb site's own vendored
engine, pinned by `STATION3D_COMMIT` in its deploy script. Deploying the site
alone does not change the transit page's engine.

Order-of-work items 1–3 were implemented on `perf-next` and merged to `main`.
Each has deterministic tests; `npm test` (344+ tests), the build, the release
asset audit and the packed-tarball consumer check pass. Browser evidence comes
from the Zagreb consumer cloned with the candidate vendored beside an untouched
baseline, against the live provider. The host was heavily contended throughout
(load 6–80, swap nearly full, another project's test runner), so **timing
comparisons are still owed**. Counts, liveness and correctness below are the
evidence.

The complete candidate measures higher GPU time than baseline (≈14.5 vs ≈10 ms
in the stationary walk view). That is expected, not a per-change regression:
S1 delivers the road, curb and lamp tiles baseline never receives, so the same
view draws ≈6.9 M indices instead of ≈4.9 M. In-session toggles isolate the
runtime changes: the program-grouped sort measured ~1 ms *less* GPU (14.3–14.7
vs 15.4–16.4 ms), and the shadow reuse was GPU-neutral with traffic moving.

| Item | What changed | Evidence | Still open |
| --- | --- | --- | --- |
| S1 | `core/held-delivery-wake.js`: once the world is revealed and ground is idle, parked road-family callbacks wake a `roads` admission. A publication that makes no progress is reported as `stalled` and not retried until another generation publishes. | Stationary walk, A/B twice: baseline stuck at 170–171 held deliveries; candidate drained. Ready times comparable (base 45.8/17.4 s, candidate 28.2/17.6 s). Without the reveal gate, startup waited for the whole corridor (58 s); the gate is part of the fix. | Stopped tram/paused planner starts not yet re-run. |
| S2 | Dressing colliders keep only triangles intersecting the bubble disc and report `requiredTriangles`. `dressingProfilesNear` on road and rail formations queries civil bounds. Rail no longer scans every profile. Fixed-bubble failures register a world-build blocker (`data-world-build-blockers`, telemetry `blockers`). Road admission defers owners past the loaded/requested base terrain (`core/terrain-evidence-scope.js`), and the terrain cut skips exactly those owners' profiles. | Zagreb car: ready 37.4 s, drove 116 m, health 100, no errors (was `rail-formation-dressings … budget`). Split car: ready and drove (was `formation-dressings` overflow). Split city flight: ready and flying (was `road-surface-terrain-incomplete` at 2382, 239). | Bubbles that genuinely need >8,000 in-disc triangles still fail by design, now with the required count. Deferred roads re-enter on the next generation after terrain coverage grows; not yet observed in a long flight. |
| S3 | `tools/perf-probe.mjs` + `tools/lib/perf-probe-summary.mjs` replace the unrunnable `tools/perf-trace.mjs`. Records frame intervals, GPU timer queries, per-framebuffer draws, program switches, uploads, scene census, shadow-cache counters and screenshots. Rejects windows with paging or load; takes host config via `--init-script`; resolves Playwright from the caller. | It measured all the A/B runs below and correctly marked every contended window invalid. | Not yet adopted by the Zagreb collector. |
| R1 | Facade atlas pages 512 → 1024 px (re-measured upload: ~1.2 ms per 1024 page on M1 Pro/ANGLE). | Building census 40 s after ready: materials 136 → 51, meshes 370 → 291. Drained candidate builds differing only in page size, same view and geometry (6.9 M indices): 83 fewer draws, 133 fewer materials, 129 fewer meshes. GPU per frame over three alternating pairs: 512 px 12.1/12.6/12.8 ms, 1024 px 11.6/14.3/14.4 ms. No consistent regression, but ~1 ms cannot be excluded on this host. | Per-tile contact AO/roof drainage (~68 draws) into regional batches; the 42-part GDI building (`gdi:building:61897`) as one batch. Both are tile-lifecycle refactors. |
| R2 | `core/cached-shadow-map.js` reuses the shadow map when the light and every caster signature are unchanged. The sun anchor is snapped to 8 m (height 2 m) and solar direction to 0.25°. | Same-session on/off screenshots are pixel-identical outside a 36×5 px animated patch. With traffic moving the map renders every frame (no regression, equal GPU time). With nothing moving it is skipped. **The static/dynamic split was built and rejected**: restoring cached depth cost +3–4 ms GPU per frame on ANGLE/Metal and halved frame rate from 120 to 60 Hz. | The CPU saving when skipped is unmeasured (host load). In city traffic the pass is almost never skippable. Reducing caster count (greenery) is the remaining lever. |
| R3 | Opaque draws grouped by compiled program inside each render order (`core/opaque-sort.js`). | Program switches per frame 158/162 → 126/127 in the same view (the candidate draws more content). | Static matrix freezing (0.3–0.4 ms) and batching the tiny greenery/rail/terrain tail not done. |
| L3a | Street lamps packed per region (`core/packed-instance-blocks.js`). Regions reserved 160 fixed slots per tile and drew up to the highest occupied slot, so empty zero-scaled slots were drawn. | Same view: 24,675 drawn lamp instances for 744 real → 744 for 744; main-pass indices 6.9 M → 5.8 M (−16 %). No new page errors. | In `v0.1.0-alpha.3`. Frame time and GPU change not separable from noise (degenerate instances cost only vertex work). |
| R5 | Road surface triangulation made Delaunay before refinement (`core/delaunay-flip.js`, called from `refineTriangulatedSurfaceSteps`). Earcut fans long road polygons into needles, and midpoint refinement keeps triangle shape, so each needle became a fan of slivers whose count grew with its squared length. | Same view: `RoadSurface` triangles 502 k → 146 k (−71 %) over the same 168–170 k m²; triangles under 0.05 m² 204 k → 33 k. Main-pass indices 5.8 M → 4.9 M, back to the old engine's figure while carrying all its missing roads and lamps. Walk GPU median lower in 3/3 pairs (−0.5 to −1.3 ms; host paging). Screenshots unchanged apart from the randomly seeded asphalt texture. Refinement CPU unchanged (191 vs 183 ms for 300 rings); a third as many vertices to sample, build and upload. GTA car and city-flight starts load and drive. | In `v0.1.0-alpha.3`. A flip on near-collinear Float32 points once folded two triangles onto one side of an edge; the guarded flip passes a 2,000-ring receiver-topology fuzz, and the regression test fails on the unguarded version. |
| R4 (part) | Auto DPR driven by measured GPU time (`core/gpu-frame-timer.js`, `createAutoDprGovernor`). The previous governor keyed on `renderMs` (CPU submission, ~3.6 ms while the GPU backlog surfaced as out-of-loop wait) and vetoed windows with background work pending (51 of 54): in a 54-window walk it ignored every window and never adjusted. Now: step down after 3 windows with GPU > 85 % of a 60 fps frame and frames missing 60 fps; step up on predicted headroom or a periodic probe with doubling back-off; no timer extension, no change. `perf-probe` pauses the engine timer during its own GPU windows and records the governor state. | Default `auto` resolves to `high` (DPR 1.5) on the M1 Pro. After L3a/R5 the dense walk at DSF 2 measures 7–13.6 ms GPU while walking, under the 14.2 ms pressure line, so the governor now reads every window and correctly keeps DPR 1.5 there; the step-down and probe paths are unit-tested, not yet seen in a browser. Host load 80–165 during the trace. | In `v0.1.0-alpha.3`. Not yet observed stepping down on a weaker GPU. Per-layer GPU attribution still open. |

### Quiet-host comparison (23 September, evening)

`tools/perf-probe.mjs`, dense Zagreb walk, `high`, DPR 1, 120 Hz display. The
runs alternated old engine (`cdd475cb…`), shipped `c98a73c` and `c98a73c` plus
lamp packing. Each run did a 90 s drain wait, a 10 s stationary window and a
20 s walk. Swap stayed nearly full, so the probe rejected most windows. Only
host-clean windows are quoted.

| Build | Main-pass indices | Drains in 90 s | Walk frame mean / p50 / p95 (clean) |
| --- | --- | --- | --- |
| Old engine | 4.7–4.9 M | never | 12.0–13.1 / 8.4–8.8 / 18–25 ms |
| `c98a73c` | 6.6–6.9 M | every run | 15.7–17.0 / 16.3–16.5 / 26–33 ms |
| + lamp packing | 5.4–5.8 M | every run | 13.9 / 10.3 / 25 ms (one clean window) |

- **Walking is slower than the old engine** (~30 % mean frame time; mostly 60 Hz
  instead of 120 Hz). The old engine is faster only because it never loaded
  the held road, curb, formation and road-graph lamp tiles (S1). Per-layer
  census at the same pose: road surface 452 k → 1,149 k indices, lamps
  700 k → 1,207 k (before packing). This is over the 10 % movement-regression
  bar. Accept it or pay for the content. Lamp packing (L3a) and road
  triangulation (R5) bring main-pass indices back to 4.9 M; R4 remains.
- GPU timer medians (11–13.5 ms) overlap across builds. Under vsync the GPU
  clock drops when there is slack, so GPU ms does not rank builds here.
- Greenery props appear later on `c98a73c`: absent 40 s after ready, present
  at 180 s. They wait for the extra road generations to settle.
- Stationary windows sit near 120 Hz for all builds. Stationary is no longer
  the discriminating case.

## Where the time goes (measured 23 September)

Dense Zagreb walk, `high` quality, M1 Pro, headed Chrome 153. The host was
shared (load 6–18, 13.3 of 14.3 GB swap in use), so absolute frame times are
diagnostic, not benchmarks. Proportions and counts are the durable findings.

| Question | Measured answer |
| --- | --- |
| Does a stationary session finish loading? | **No.** 171 downloaded road-family tile deliveries sat behind an admission barrier for the whole observation (≥250 s; 368,902 retry attempts, 315 ms CPU). Only movement-triggered generations release them. |
| Largest streaming CPU consumer? | `ground-generation`, in every mode. Cumulative queue CPU per audit capture: walk 13.1 s, tram 11.6 s, boat 23.5 s, train 29.1 s; buildings 3.3–8.5 s. |
| What does one road generation cost? | 1.1–3.2 s main-thread CPU, 11–41 s wall, 250–460 owners recompiled, of which 184–349 are new and 234–436 are flagged as physical-dependency recompiles (the flags overlap). |
| Main thread while walking | ~98 % busy (2 % idle). `renderer.render` 52 %, cooperative queue work ~13 % (ground-generation steps ~6 % of it), foot step incl. surface queries and building raycasts ~8 %. |
| Main thread while stationary | 22 % idle. `renderer.render` 60 %: shadow pass 23 %, `WebGLGeometries.update` attribute checks 20 % self. |
| Draws per frame | 528 main + 95 shadow draws, 160 program switches, 803 visible meshes, 1.63 M triangles. |
| Buildings | 474 visible meshes with **180 distinct materials**. ~170 are `FacadeAtlas:*` meshes (one material per tile × atlas page) of 30–120 triangles each; 42 unbatched per-entity Lambert meshes of ~24 triangles. |
| GPU per frame (timer query) | 9.0 ms at DPR 1 (1600 × 946); **21.5 ms at DPR 1.5** (2400 × 1419), the `high` cap on a Retina display. Freezing the shadow map left GPU time unchanged (22.2 ms): the cost is main-pass fragments. |
| Buffer uploads while walking | Small: 15.4 MB over 30 s. Texture upload calls: 5,381 in 30 s (≈180/s, bytes not counted for image sources). |

## Order of work

1. **Finish source coverage and preflights.** The consolidated tool, actual
   tarball installs, complete vendored directories and native route controls
   are in place. The recorder found and fixed a shared-material reopen defect;
   the sealed candidate walk then completed its route and three reopens.
   The candidate tram also completed three reopens and expanded the archive.
   Frozen water coverage now uses complete provider rows and passed 378 SQL
   parity cases. Its follow-up replay stopped on two missing curb responses
   and a terrain grid whose sampling origin shifts with the requested bbox.
   Both curb keys are now captured in a separate 2,012-response archive. The
   terrain snapshot contains complete native rasters, overviews and water
   masks; its prepared adapter uses the original provider sampling modules.
   The approved adapter matches 13 of 14 live-provider responses exactly; one
   height among 2,190,192 cells differs by 0.1 metres. Exact provider parity
   remains failed, with its cause unproven. All 14 frozen responses repeat
   byte for byte after reloading the session tables. Use this explicitly new
   fixed fixture for both variants' fresh preflights, retaining the discrepancy
   and newly matched package identities. Nearby or enclosing resampled terrain
   responses are not interchangeable. Finish these correctness checks before beginning
   either comparison profile; export and transport checks alone are not proof.
   Sealing alone is not coverage. Each replay-only preflight must finish the
   route and lifecycle work without a missing source or failed drain.
   Retain the standalone optional-asset gaps and empty-provider timeout in the
   receipt until the packed consumer also passes those checks.
2. **Finish alpha.6 walk/tram acceptance.** Compare `fc1e89b` and `3ee0002` using
   the predeclared loaded-host series below. Quiet-host
   baseline/candidate/candidate/baseline remains an optional isolated profile. Include cold
   startup, a stationary start that drains, three minutes of native movement,
   bounded recovery and close/reopen. Repeat at DPR 1 and the high-DPI cap.
   Both builds must include the identical material cleanup patch. Keep stack
   capture for the old `isReady` exception; it has not recurred in these runs.
   The `prod-de` capability probe verified usable headed Chromium with llvmpipe
   software rendering, and its CPU fixture checks passed. Use it for controlled
   CPU/loading/memory and software-rendered frame-time comparisons once source
   coverage is complete. Match browser, renderer, flags, viewport and workload;
   record host load, CPU steal and cgroup throttling during each run. Keep CPU
   phase timings separate from renderer CPU work. Scope these results to this
   host/backend; measure representative GPU-equipped clients separately before
   claiming their frame-time gains. Keep fixture work counts distinct from
   repeated timing evidence. Enabled WebGL flags alone do not identify hardware.
   Daytime fixes now allow an explicit Chromium binary and software renderer,
   and detect Linux CPU steal and cgroup throttling. The missing procedural
   crowd-face atlas is restored to the package. Apply that asset repair to
   both packaged variants before the existing alpha.6 comparison and retain
   new package/source identities; do not substitute it into sealed old runs.
3. **Re-profile ground construction on alpha.6, then choose one G2 family.**
   Genuine new-road compilation and curb draping remain candidates. The newer
   paint/curb changes alter the old phase ranking, so do not assume that the
   September 23 road-first worker order is still optimal. Preserve bounded
   snapshots/transfers, cancellation and atomic publication. Keep the terrain
   tiling and curb read-evidence experiments parked unless new evidence changes
   their timing verdict.
4. **Finish the specific R1/R3 building tail.** Regionalize contact AO and roof
   drainage, then the remaining per-entity meshes, preserving picking and
   passages. Measure independently of ground work. The larger atlas and opaque
   sort are already present; do not implement them again.
5. **Close the wider matrix and remaining R4 questions.** Human/explorer walk,
   rail seams and turnouts, road/curb driving, shore/boat transitions, land
   flight/landing and memory-limited hardware. Verify the existing GPU-driven
   auto-DPR governor before changing quality policy. Inspect support,
   appearance and interaction for every affected mode.

### Running the walk/rail acceptance tool

Build each revision with the pinned toolchain, pack it, install the tarball in
an isolated consumer, and run its installed `station3d-vendor` command. Point
the configuration at the entire resulting vendored directory. Record the
revision and SHA-256 of each tarball; the tool independently hashes every
served engine file and every regular file in the consumer's public tree.
The mounted engine subtree is excluded from the host hash. Symlinked public
files are refused, and served bytes must match the startup fingerprints.

Paths in this local JSON configuration are relative to the configuration file:

```json
{
  "hostRoot": "./consumer/public",
  "engines": {
    "baseline": { "dist": "./baseline/public/station3d" },
    "candidate": { "dist": "./candidate/public/station3d" }
  },
  "engineUrlPrefix": "/vendor/station3d/",
  "providerBaseUrl": "https://provider.example/api",
  "sourceArchive": "./sources",
  "outputDir": "./captures",
  "playwrightModule": "./consumer/node_modules/playwright",
  "initScript": "./host-scenario.js",
  "quality": "high",
  "viewport": { "width": 1600, "height": 1000, "deviceScaleFactor": 1 },
  "scenario": {
    "id": "walk-dense-dpr1",
    "url": "/walk.html?stats=0&perfAttribution=0&telemetry=0&weather=clear",
    "mode": "walk",
    "headingDeg": 0,
    "corridorM": 55,
    "stationarySeconds": 60,
    "movementSeconds": 180,
    "readyTimeoutSeconds": 240,
    "drainTimeoutSeconds": 180,
    "minDistanceM": 100,
    "lifecycleCycles": 3
  }
}
```

The host script configures its HTTP provider at `/api` before opening the
session. It owns any regional route selection. Walk uses native W/S input
along the configured heading, with at least two corridor turns required.
Rail uses the host's native pose provider and P pause control; configure
`initialPose: { lat, lon, headingDeg }` for the first pose of each fresh controller. For rail lifecycle,
the host script must define `window.__station3dAcceptanceReopen` to create a
fresh native controller through the host opener. Reusing an advanced pose
callback while pinning it back to the original anchor creates an invalid
reopen. The observer rejects a reused callback, records each initial correction,
and leaves subsequent poses native. Verify the resolved route on every host open.

The default launch uses installed headed Chrome. To use a specific Chromium
installation, add `browserLaunch: { executablePath: "./chromium/chrome", args:
["--use-gl=angle", "--use-angle=gl"] }`. The executable path is relative to the
configuration file. Extra flags cannot override headed mode, window geometry
or browser control. The resolved launch options are recorded and hashed into
the scenario identity. Software renderers can run every stage; comparisons
still require an identical browser and renderer, and receipts label their
scope as the software-rendered host. A GPU timer extension remains optional.

Linux host admission reads `/proc/stat` CPU steal and the unified cgroup v2
hierarchy, including ancestor quotas and throttling counters. Any observed
CPU throttling or more than 1% CPU steal in an interval rejects timing; missing
counter evidence, quota changes and hidden ancestor hierarchies also reject
it. Effective CPU capacity must match across measured phases and the ABBA
set. These checks supplement host load and swap activity. Linux cgroup v1 is
currently unsupported for timing admission. Correctness captures can retain
host failures, and the macOS load/swap checks keep their existing behavior.

Only explicitly configured `externalOrigins` may be recorded outside the
provider, for example basemap images requested when closing the 3D view.
Their complete original URLs, including origin and query, are archived;
frozen replay never fetches them live. Other external requests fail the run.
Optional `sourceKeyRules` may drop declared volatile metadata parameters;
spatial coordinates must retain exact identity. `expectedResponses` declares
any legitimate optional HTTP errors and is part of the archive identity.

For a continuously centered vector query, an explicitly exported complete
dataset can answer exact requests without changing the runtime or finding a
nearby recorded response. Configure each frozen dataset by file and SHA-256:

```json
{
  "vectorSources": [
    { "file": "./water-vector-source.json", "sha256": "<64 lowercase hexadecimal characters>" }
  ]
}
```

`station3d-perf-vector-source-v1` supports one defined query contract: a
positive WGS84 bbox selects whole features by PostGIS `BOX2DF` overlap. Its
export must include:

- `id`, `pathname`, `crs: "EPSG:4326"` and a `query` object with
  `parameter: "bbox"`, `selection: "postgis-box2df-overlap-v1"`,
  `maxSpanDegrees` and `maxFeatures` matching the provider.
- `coverage: { bbox, complete: true, rowCount, scope: "provider-visible-rows" }`.
  Establish the row count and export in the same read-only database snapshot,
  without a result limit. This attests the provider-visible dataset in that
  area, not completeness of the underlying real-world map.
- `provenance` containing `capturedAt`, `sourceRevision`, `querySha256` and
  `transactionSnapshot`, with retained export/count evidence.
- `features: [{ id, bounds, feature }]`, where `feature` is the original full
  GeoJSON feature and `bounds` is its authoritative outward-float32 database
  envelope. Do not infer it from coordinates rounded for GeoJSON delivery.

The resolver reproduces the provider's
[bounding-box overlap predicate](https://postgis.net/docs/geometry_overlaps.html),
orders features by stable id, and echoes the original exact query bbox with
`feature_count` and `truncated: false`. Unknown parameters, queries outside the
complete area, and results reaching the provider's truncation limit fail.
Clipped-response APIs and other query contracts are unsupported by this format.
Verify selected IDs and untouched feature contents against the provider,
including edge cases, before using a dataset for acceptance.

A registered dataset owns every request to its endpoint, including requests
already present in the exact-response archive. It cannot fall back to older
responses or a live provider. Each request records both the derived response
hash and dataset hash; the file is reverified before serving. Dataset bytes,
coverage and query semantics join the archive in the overall source identity.
`--stage seal` seals the HTTP archive; `--stage inspect` reports the combined
identity and the separately hash-pinned vector datasets.

For a provider that resamples native rasters or computes geometry for an exact
request, `snapshotSources` can use an audited offline query service:

```json
{
  "snapshotSources": [
    {
      "file": "terrain-source/snapshot-manifest.json",
      "sha256": "<64 lowercase hexadecimal characters>",
      "origin": "http://127.0.0.1:19491"
    }
  ]
}
```

This is a performance-fixture transport, not a new engine provider API. The
manifest must be a regular file within the configuration directory. The
service must bind to loopback (a local SSH forward is also usable). Its
`GET /__station3d_snapshot` response must contain the exact pinned manifest
bytes and `X-Source-Dataset-SHA256` header. The
`station3d-perf-http-snapshot-v1` manifest declares a unique `id`, owned
`pathnames`, complete coverage with a geographic `bbox` and `scope`, capture
provenance (`capturedAt`, `sourceRevision`, `transactionSnapshot`), and a
nonempty `files` inventory. Each inventory entry has a safe relative `file`,
`sha256`, `bytes`, and `role` (`code` or `data`). Include query-specific bounds,
sampling rules, dependencies and GIS runtime versions in the pinned manifest.

The harness forwards the exact path and query with
`X-Expected-Source-Dataset-SHA256`. Every successful JSON response must return
the matching dataset header and an `X-Source-SHA256` matching its body bytes.
Missing coverage, redirects, failed requests, changed manifests or mismatched
hashes fail the run. An owned endpoint never falls back to the response
archive or live provider, even during recording. The combined source identity
uses `station3d-perf-source-set-v2` when HTTP snapshots are present; existing
archive/vector-only identities are unchanged. Inspection and final capture
verification both contact the snapshot service, without launching a browser.

These checks establish consistent transport and identity; a service claiming
to be frozen is not itself proof of immutable inputs. Audit the adapter:
export complete native rows in one read-only snapshot, retain byte hashes and
row counts, load only those rows into isolated storage, and reuse the original
provider query and composition code. Reject requests outside exported support
including interpolation collars. Verify complete response/height/source bytes
against the provider for real queries, shifted origins and coverage edges.
Retain the adapter, dependency versions and parity receipts alongside the
data. The regional adapter and raw data remain downstream/local; Station3D
adds no dependency on a regional service, database or sibling checkout.

With a configuration named `acceptance.json` in the current directory, prepare
sources and both preflights. The last five commands use the strict quiet-host
profile; for ordinary host use, substitute the loaded series below:

```sh
# Optional: clone an earlier archive without modifying its original.
node tools/perf-acceptance.mjs --config acceptance.json --stage import --seed ./earlier-sources
node tools/perf-acceptance.mjs --config acceptance.json --stage record --variant baseline --label record-a --run
node tools/perf-acceptance.mjs --config acceptance.json --stage record --variant candidate --label record-b --run
node tools/perf-acceptance.mjs --config acceptance.json --stage seal
node tools/perf-acceptance.mjs --config acceptance.json --stage preflight --variant baseline --label preflight-a --run
node tools/perf-acceptance.mjs --config acceptance.json --stage preflight --variant candidate --label preflight-b --run
node tools/perf-acceptance.mjs --config acceptance.json --stage measure --variant baseline --label a1 --preflight captures/preflight-a.json --run
node tools/perf-acceptance.mjs --config acceptance.json --stage measure --variant candidate --label b1 --preflight captures/preflight-b.json --run
node tools/perf-acceptance.mjs --config acceptance.json --stage measure --variant candidate --label b2 --preflight captures/preflight-b.json --run
node tools/perf-acceptance.mjs --config acceptance.json --stage measure --variant baseline --label a2 --preflight captures/preflight-a.json --run
node tools/perf-acceptance.mjs --compare captures/a1.json captures/b1.json captures/b2.json captures/a2.json
```

Run one headed browser at a time. Every label must be new; failures retain
their receipts. Sealing does not establish coverage: both full preflights
must pass before timing. For families served from exact-response archives, a
missing request requires a new unsealed archive copy, additional recording and
new preflights. Do not patch a sealed
archive, round its queries or substitute nearby terrain. Changed tooling,
host files, sources, engine bytes or renderer context invalidate preflights.

Each run records native load and swap-in plus swap-out at two-second
intervals. Strict quiet-host measurement fails with missing/reset counters, gaps over 7.5 s,
load above 1.5 per CPU or paging above 0.5 MiB/s in any interval. Readiness,
all world/building/paint/decor drains, route distance, render-context stability,
visibility and lifecycle evidence must also pass. These thresholds are fixed
by the tool, not adjustable per candidate.
Held tile deliveries count as pending even when networking is idle. At initial
drain, post-stop drain and every reopen, a separate material inspection checks
that compiled ground-paint uniforms belong to the current receiver; retained
uniforms from a closed session reject the run.

The ABBA report computes comparisons only from valid, matching measurements.
The four receipts must have positive, non-overlapping chronological intervals
with at most five minutes between adjacent runs; duplicate or reordered runs
cannot establish a back-to-back comparison.
It rejects a pair-average p50 **or** p95 regression above 10% in either phase,
and new recurring aggregate long tasks above 50 ms when both baseline runs
had none. This aggregate check cannot identify individual recurring functions:
review profiles and generation/queue evidence before approving an optimization.
Support, appearance and selection still require their explicit cross-mode
checks; automatic timing acceptance alone does not close those gates.

After post-stop drain, a separate ten-second stationary diagnostic records
GPU query-window medians, render CPU and CDP task time. Unsupported GPU timers
remain unknown. Set `diagnosticSeconds` (at most 60) or
`diagnosticCpuProfile: true` to retain a V8 profile of this separate window.
Diagnostic timings are never substituted for the stats-off phases.

### Comparisons under ordinary host load

The loaded profile allows measured load, paging, Linux CPU steal and cgroup
throttling. It preserves their raw evidence. Missing/reset counters, sampling
gaps over 7.5 seconds, changed CPU capacity and all existing source/readiness/
drain/visibility/lifecycle failures still reject the capture. It does not
estimate an idle result by dividing frame times by CPU load or paging rate.

After the two fresh full-route preflights above:

```sh
# Optional A/A pilot: both roles run the exact baseline package.
node tools/perf-acceptance-series.mjs plan --config acceptance.json --plan captures/control-plan.json --id control-1 --kind control --pairs 4 --baseline-preflight captures/preflight-a.json
node tools/perf-acceptance-series.mjs run --plan captures/control-plan.json --run
node tools/perf-acceptance-series.mjs compare --plan captures/control-plan.json

# Fix the comparison budget before the first capture (default: 12 pairs).
node tools/perf-acceptance-series.mjs plan --config acceptance.json --plan captures/comparison-plan.json --id comparison-1 --pairs 12 --baseline-preflight captures/preflight-a.json --candidate-preflight captures/preflight-b.json
node tools/perf-acceptance-series.mjs run --plan captures/comparison-plan.json --run
node tools/perf-acceptance-series.mjs compare --plan captures/comparison-plan.json
```

Planning launches no browser. It checks current package/source/observer
identities against the preflights and writes a new plan with exclusive-create
semantics. The seed, balanced random AB/BA pair order, identities and tolerances
are hashed before captures start. Comparison plans allow 8–128 even pairs;
controls allow 2–128. Twelve pairs mean 24 full runs, including startup, both
timed phases, drain and reopens; this is a sustained job, not a short probe.
Run it through the host's job supervisor if it must outlive the shell.

Execution is serial and saves each original collector receipt. `--resume`
continues only after a valid completed prefix. It cannot replace a failed run
or skip a hole. A pair's second capture must start within five minutes of its
first capture ending; breaks are permitted between pairs. Interrupted pairs
and changed inputs need a new, separately retained experiment. Do not stop
early because a partial result looks favorable or increase the same experiment's
sample count after inspecting its result.

Analysis requires every planned slot in chronological order with the exact
plan binding. Movement distance may differ by at most 5%. Rail paths may differ
by at most 5 metres at equal absolute travelled distance. Walk plans bind
`routePolicy: { type: "native-walk-corridor-v1", headingDeg, lengthM, origin }`
to the configured corridor and baseline preflight start. Both walks must start
within 5 m of that origin and every waypoint must stay within 5 m of the finite
corridor. Turn counts may differ by at most 5%; alternating endpoint visits
must corroborate each recorded count within one final partial leg. Endpoint
witnesses allow the observer's 2 m recording interval and the native 2 m
return threshold. Other routes use `distance-aligned-v1`. This preserves the
native frame-sized turns without mistaking accumulated overshoot for a path
change. Native platform/CPU
count, Linux CPU capacity, requested workload, browser/GPU and render settings
must match. The collector records routes and `measurementProfile: "loaded"`
with `experiment: { planHash, slot }`; older captures cannot be relabelled.
The plan and wrapper use `station3d-perf-loaded-plan-v1` and
`station3d-perf-loaded-series-v1`. New native summaries distinguish
`evidenceValid`/`evidenceReasons` from the unchanged strict `clean`/`reasons`.
Per-phase `browserCpu` holds raw CDP counters and scheduled CPU seconds across
all browser threads, optionally per frame/metre. Process churn or unavailable
CDP accounting is reported as unknown and does not discard a slow frame run.

Four primary endpoints are stationary/movement p50/p95 frame times. An exact
binomial sign interval estimates the median paired candidate/baseline ratio
in log space, targeting at least 95% simultaneous coverage over all four
endpoints using Bonferroni. Pairs must be independent and representative;
thousands of frames within a run do not increase the statistical sample count.
An endpoint with its upper bound below 1 is improved; all four upper bounds
at or below 1.10 support `within-budget`. A lower bound above 1.10 establishes
regression; otherwise the result is `inconclusive`. Aggregate new recurring
long-task counts remain a conservative extra gate. Inspect their profiles
before assigning cause. A small A/A pilot reports descriptive noise only;
it does not approve a candidate or prove equivalence. All runs and pair ratios
remain available for review. Separate support, appearance and selection gates
still apply.
Repeat the whole protocol with a distinct high-DPI configuration and observed
renderer dimensions; a requested device scale alone does not prove the cap.

The following effort/priority table records the September 23 diagnoses and
original scope. The current order above and each item's release/status notes
take precedence over its historical priority label.

Effort includes implementation, focused tests and regression verification for one
experienced maintainer: S = up to one day, M = 2–4 days, L = 5–10 days, XL = a
separate project. Payoff is potential and scenario-specific; no percentage FPS
gain is promised without paired evidence.

| ID / priority | Work and owner | Effort | Risk | Potential payoff / confidence |
| --- | --- | --- | --- | --- |
| S1 / first | Break the tile-delivery admission-barrier deadlock — engine | S–M | Medium: the barrier exists to stop route-ahead deliveries from repeatedly invalidating road design | **High.** A stationary start never completes roads, curbs, formations, vertical alignments or road-graph lamps; the first movement then releases a burst. Removes an unbounded "not drained" state from every mode. **Confirmed** by live source state and code. |
| S2 / first | Complete bounded collision support and city-flight terrain evidence (was P1) — engine | M–L per failure family | High: support holes, seams, staged-memory peaks | **Very high usability payoff:** unblocks confirmed city car/flight starts. Car failure **re-reproduced**. Performance benefit is avoiding impossible/repeated work, not steady FPS. |
| S3 / parallel | Trustworthy, runnable performance measurement (was P2) — engine tooling + consumers | M | Low runtime risk | **High decision value.** Add GPU timer and GL counters, a working engine-local harness and swap-aware host admission. Confirmed need: engine `tools/perf-trace.mjs` cannot run. |
| R1 / next | Collapse building draw calls: facade atlas as one material per region (texture array/atlas), batch per-entity and per-tile building meshes — engine | M | Medium: facade appearance, picking/entity ranges, passage discard | **High, measured.** ~170 facade meshes plus 42 entity meshes carry under 5 % of building triangles but ~45 % of building draws (≈40 % of main-pass draws). Expect fewer draws and program switches, and fewer geometries checked each frame. |
| R2 / next | Cache the directional shadow map while the sun, the snapped shadow frustum and the caster set are unchanged — engine | S–M | Medium: stale shadows on moving vehicles/actors | **Medium–high CPU payoff when stationary or slow:** the shadow pass is 23 % of stationary main-thread time. No GPU win expected (measured). Implemented as reuse-when-unchanged; the dynamic-caster split was measured and rejected (see status). |
| R3 / next | Per-draw CPU hygiene: program/material sort, static matrix freezing, fewer tiny meshes outside buildings — engine | M | Low–medium | **Medium.** 160 program switches for 83 programs; `WebGLGeometries.update` is 11–20 % of main-thread time and scales with visible geometries × attributes. |
| G1 / next | Make road ground generations incremental in practice: recompile an owner only when something it read changed — engine | M–L | High: stale support, missed seams | **Released in `v0.1.0-alpha.5`.** Existing-owner recompiles −60 % walking, −45–60 % on the tram; walk ground CPU −40 %. Runtime verification finds 0 misses. Curbs and rail/opening changes remain box-based. |
| G2 / then | Move road/curb/formation/terrain-cut compilation to workers; keep only publication on the main thread — engine | L–XL | High: snapshot transfer, cancellation, atomic publication | **Very high potential:** ground generation is the largest streaming CPU consumer in every mode and 6–11 % of main-thread time while walking. Wall latency (11–41 s per road generation) would approach real CPU time. |
| R4 / then | High-DPI fragment cost: default adaptive render scale on `high`, shader and overdraw budget per layer — engine | M–L | Medium: sharpness, appearance parity | **Very high on Retina laptops:** 21.5 ms GPU at DPR 1.5 means dense views cannot hold 60 fps there regardless of CPU work. Per-layer GPU attribution still needed. |
| L1 / later | Reopen cancellation error and retained-memory bounds (was P8) — engine + provider caches | S–M; M–L if a leak is confirmed | Medium–high | **High correctness value.** Not re-measured on 23 September. |
| L2 / later | Observer-local startup readiness and speed-aware lookahead (was P5, P6) — engine | L | High: premature reveal, missing support | **Medium–high startup/flight payoff.** S1 must land first: today's global settle gate and the barrier interact. Corrected claim: no altitude-based physics suppression exists (see below). |
| L3 / later | Small items: walk-support BVH, lamp culling, texture-upload batching, queue counters, passage shader variant, shared transit pose snapshot (was P9 plus new) — engine/adapters | S–M each | Low–medium | **Low–medium each.** Walk building raycasts are ~4 % of walking main-thread time. |

## Definition of each step

### S1 — stationary sessions must finish delivering tiles

`core/shared-tile-session.js` installs an `admissionBarrier` when a ground
generation with delivery handoff releases its hold (around line 1311). The
barrier admits nothing. It is removed only when the **next** admission adds a
hold (line 1280) or the session closes. Deliveries that arrive in between
return `FRAME_CHUNK_DEFER_ITEM` forever. They are exactly the road-source
changes that would invalidate ground and start the next admission, so a
stationary observer deadlocks.

Measured on the dense walk start: four road-family sources held the barrier
with 19 + 95 + 38 + 19 pending callbacks, exactly the 171 stuck `tile-delivery`
items. Their labels were `roads`, `road-formations`, `road-vertical-alignments`,
`curbs` and `streetlamps:road-graph`. The network was idle and ground reported
no pending change. This explains why the 22 September walk drained only about
80 s after movement stopped, and why train ground was still catching up 115 s
after stopping.

Fix direction: the barrier must carry a wake obligation. When a barrier is
present and callbacks are pending, request the owning family's admission
(coalesced, one per family) rather than waiting for an unrelated invalidation.
Preserve its purpose: route-ahead deliveries may still be batched into one
generation, but a finite batch must always be scheduled. Tests: a headless
session with a released handoff and pending callbacks must schedule an
admission and drain within a bounded number of frames; a burst of route-ahead
deliveries during a generation must still produce one successor, not one per
tile. Re-run stationary walk, stopped tram and paused planner starts. "Drained
with zero pending" is the acceptance signal. The collector must not need movement
to reach it.

### S2 — unblock complete collision support (was P1)

Re-reproduced on 23 September: Zagreb car spawn 45.8105, 15.96916 fails with
`rail-formation-dressings collider exceeds its complete coverage budget`, and
the gate is released by timeout. During the failure the ground snapshot reports
`failed: 0` and `capacityBlocked: false`: the error travels through the local
fixed-bubble path (`modes/gta.js` `buildFixedBubbleSteps`), not the coordinator.
Loading diagnostics therefore cannot see it. Fix that propagation in the same
change.

Source facts: the caps are 8,000 triangles in 110 m (road) and 112 m (rail)
bubbles, in `core/gta-config.js`. `buildRoadFormationDressingTrimeshData()`
generates whole wall/collar profiles until the cap. Profiles densify at 4 m and
yield roughly 2–2.5 triangles per metre of ring, so the cap is about 3.5 km of
profile perimeter. Rail passes **every** formation profile
(`getSurfaceProfiles()`) and filters by bounds afterwards; road asks for
`surfaceProfilesNear()`. A long rail profile that touches the bubble
contributes its whole length.

Prefer exact spatial clipping to the bubble plus cooperative, complete chunks
under a combined geometry/body/staging budget. Splitting an already truncated
buffer is not a fix. Keep all triangles needed by the protected support region,
including seams and vertical bands, and keep the predecessor until the
replacement commits.

Treat the city-flight source block as a separate reproduction (not re-run on
23 September): Split, aircraft at 300 m, road 1087564470 lacking terrain
evidence at local `(2382.25, 239.04)`. Establish why a sample about 2.38 km from
the anchor lacks evidence, without substituting zero height or bypassing the
gate. Test a normal opening and a subsequent land flight and landing.

Tests: synthetic over-cap profiles, exact coverage at bubble/chunk boundaries,
retention/rollback, supersession, cancellation, combined staging bounds, and
failure visibility in `groundGenerations.snapshot()`.

### S3 — make performance evidence trustworthy and runnable (was P2)

Keep everything the previous P2 required: served-output hashes, packaged
installs, correct `/vendor/station3d*` classification, a stats-off observer,
separate CPU/GPU/queue/memory diagnostics, and preserved invalid runs. Add what
23 September showed is missing:

- **An engine-local harness that runs.** `tools/perf-trace.mjs` in this repository
  imports `perf-network.mjs`, `playwright-runtime.mjs` and ten `tools/lib/*`
  modules that exist only in the Zagreb consumer, so it fails at import. Either
  vendor a minimal runnable harness (demo host, recorded provider fixtures) or
  delete it and document the consumer collector as the tool.
- **GPU time and GL counters in the collector.** `EXT_disjoint_timer_query_webgl2`
  works in headed Chrome/ANGLE Metal. Per-framebuffer draw counts,
  `useProgram` switches and upload bytes, taken by wrapping the context during
  a bounded window, separate CPU-bound from GPU-bound frames. Frame intervals
  alone cannot: a 120 Hz display quantises everything to 8.3 ms steps, and an
  emulated device scale factor pinned all intervals at 33.3 ms in one run.
- **High-DPI captures.** Every 22 September capture used DPR 1. The same view costs
  2.4× the GPU time at the Retina `high` cap.
- **Swap-aware host admission.** The CPU contention probe passed while the host was
  paging. One 3.5 s main-thread task in a 23 September walk coincided with
  16,000 swap-ins, and the 22 September profile's 60 % attribute-loop share
  (with zero idle samples) was inflated the same way. Record swap-in deltas per
  window and reject windows with paging.
- **Drain is impossible while S1 is open.** Until S1 lands, label any
  "stationary drained" phase as reached only after movement.
- **Local tooling hazard (not engine).** `browser-reap` keys Playwright idleness on
  `~/.cache/energy-manager/browser-activity/pid-<ppid>` markers and never prunes
  them (1,622 present). A recycled node PID inherits a days-old marker and the
  fresh audit browser is killed within a minute. Long probes need to refresh
  their own marker until that tool prunes stale entries.

### R1 — collapse the building draw tail

The census of the dense walk view found 474 visible building meshes over 180
materials:

- 122 + 28 + 14 `OvertureAggregate` standard/passage aggregates (the intended
  regional batches);
- 34 `BuildingContactAO` and 34 `RoofDrainage` meshes, one per tile;
- about 170 `OvertureAggregate:FacadeAtlas:{punched|glass}:<tile>:<page>`
  meshes, each with a unique material and 30–120 triangles;
- 42 unnamed per-entity `MeshLambertMaterial` meshes of about 24 triangles.

Hiding all buildings in the same session lowered the p95 frame interval from
about 17 ms to 10 ms (exploratory, streaming not drained).

Direction:

- **Facade atlas.** Put facade atlas pages into a `DataArrayTexture` (or one
  shared atlas per region) addressed by a per-vertex layer/UV offset, so each
  region has one or two facade materials instead of one per tile × page.
- **Tiny meshes.** Fold contact AO and roof drainage into the regional aggregate
  buckets, and route the per-entity Lambert meshes through the owner-key batcher.

Preserve entity ranges, picking, passage discard and facade appearance.
Acceptance: building draws and materials in the same fixed view drop by at least
half, with a paired GPU/CPU capture and unchanged screenshots. The facade-atlas
upload queue must not regress.

### R2 — stop redrawing a static shadow map

`renderer.shadowMap.autoUpdate` is always true and the sun follows the camera,
so 95 shadow draws are re-rendered every frame. That is 23 % of stationary
main-thread time. Snap the light position/frustum to a world-space grid (which
also removes shimmer). Re-render only when:

- the snapped frustum moves;
- the sun direction changes;
- a shadow-casting publication lands inside the frustum; or
- a dynamic caster (vehicle, actor, tram) moves.

Dynamic casters either force an update or use a separate small dynamic shadow
pass; measure which is cheaper. Do not disable shadows. Fix the
`BuildingPassageMaterial` variant bug (`vPassageWorldPosition = worldPosition.xyz`
injected after `worldpos_vertex`, which declares `worldPosition` only under
`USE_SHADOWMAP`/envmap/transmission/spot-light defines) before any shadow-on/off
comparison.

### R3 — per-draw CPU hygiene

`renderer.render` is 52–60 % of main-thread time. Its self time is spread over
per-object work: `renderBufferDirect`, program/uniform setup, and three's
`WebGLGeometries.update`. That last one visits every attribute of every visible
geometry each frame (748 geometries, 2,224 attributes) and costs about 2 ms per
frame even with nothing uploading.

Levers, measured one at a time:

- Sort opaque draws by program then material to cut 160 program switches toward
  the 83 programs present.
- Freeze `matrixAutoUpdate` on all published static world content, not only
  render-packet/far-building/platform subtrees. Matrix work is currently
  0.3–0.4 ms per frame, so this is small.
- Batch or instance the small tail outside buildings: 98 `DecorGreenery` meshes,
  52 `TramRails` meshes, 49 terrain meshes.

R1 removes most of the geometry-check cost; R3 is the remainder.

### G1 — recompile only what actually changed

**Problem (measured 23 September).** Road generations recompiled every
existing owner whose padded source box (feature bbox + 32 m + width)
overlapped any changed bound. A temporary hash of each recompile's positions
and indices showed that 93–98 % of those recompiles reproduced identical
geometry, 40–60 % of each road generation's compile work. Walking back and
forth recompiled the same 44 owners on every pass. The same probe also found
the opposite fault. Footways and steps moved 0.46–1.37 m in height without
being selected by any change: a centreline grade change on a road without a
surface polygon, and terrain changing under terrain-draped service roads.
The box rule refreshed those only when an unrelated profile happened to
change nearby.

**Design (released in Station3D `v0.1.0-alpha.5`, planner `v0.1.0-alpha.6`, 25 September).** A receiver is stale exactly when
something it read changed, so both sides are made explicit:

- *Read evidence* (`core/ground-read-evidence.js`). Every road feature compile
  runs inside an evidence scope (`createRoadFeatureTask`). Sources record what
  they answer as it happens: a query point with its reach (on an 8 m grid, the
  largest reach per cell), reads keyed by OSM id, and named whole-source reads.
  Sources: `TerrainReference` (every source sample, corner-cache hits and fine
  lattice lookups), the road formation query primitives, the vertical
  alignment queries (including a join evaluator reused across steps) and
  structure publication readiness. Published entries keep the frozen
  evidence (`readEvidence`).
- *Change sets*, computed by diffing the read snapshots the previous road
  generation compiled against with the current ones:
  `roadFormationReadChangesSteps` (surface profiles by content, including
  readiness captured with the snapshot; centreline segments and grade by
  content and grade-profile identity), `roadAlignmentReadChangesSteps`
  (compiled alignments and their profile owners, which are reused by identity
  while unchanged; cut-out and clear-corridor regions),
  `roadStructurePublicationChanges`, and `terrainReadChanges` (the grid
  hierarchy by identity: mosaic items, composite base and details with their
  blend margins, detail rects and the pending detail window). The previous
  basis is the published receiver read (`previousReceivers`); terrain uses
  `roadReadTerrain`, which terrain-window republications carry forward
  unchanged. Every changed id and key carries a region, and anything that
  cannot be localised makes the set `full` with a reason.
- *Decision* (`roadOwnerGeometryDependency`). Source and own-grade changes
  still recompile. Rail, opening and other region changes keep the padded-box
  rule. Terrain, formation, alignment and structure changes are tested
  against the owner's evidence; owners without evidence fall back to the box
  test against the change regions. Owners deferred past the terrain window
  stay marked until a successor entry is published.

Completeness is tested as a property: for each source, any query whose
recorded evidence misses the change set between two real snapshots must give
the same answer from both (`road-formation-read-changes`,
`road-alignment-read-changes`, `terrain-read-changes`). Each test fails when
its diff or a recording site is removed.

**Runtime verification.** `?roadReadVerify=1` recompiles every owner the
evidence retains but the region rule would have rebuilt, compares geometry
hashes, and logs `read evidence missed a change` with the owner's evidence
and a terrain probe. It also counts identical versus changed output for the
recompiles the rules asked for (`usage.roads.sourceOwners.verifyRecompiled`).
Generation usage reports `readDependencies` by reason, `readChanges` (ids,
regions, full reason) and `readRetainedOwners`.

**Evidence (25 September, host load 3–14).** Verification, dense Zagreb walk
out and back and tram 6: 0 misses in every generation. The tram run verified
2,551 retained owners identical in one run; before terrain became evidence it
found 6 real misses (terrain revision advanced under service roads and steps),
which is how the terrain source was added. The recompiles the rules still ask
for are mostly real. One tram generation first recompiled 309 identical
owners: rebuilt profiles recreate their excavation regions (region records
holding rings of points), deeper than the profile comparison looked, so
identical profiles advanced their geometry generation and every reader of
their id. Comparing four levels deep fixed it: identical own-grade
recompiles fell from up to 135 to at most 8 per generation, still with 0
misses. What remains conservative is id-keyed reads of a road whose grade
really changed elsewhere along it (up to 78 identical in one generation), and
56–72 terrain region hits on the walk's first loads.

Alternating main (`9e09514`) and candidate, 180 s each, same URLs:

| Run | Existing owners recompiled | Road generations | Ground CPU | Frame p95, 90th percentile |
| --- | ---: | ---: | ---: | ---: |
| walk base a / b | 440 / 502 | 4 / 5 | 9.6 / 7.1 s | 158 / 197 ms |
| walk candidate a / b | 175 / 175 | 3 / 3 | 5.7 / 5.5 s | 50 / 25 ms |
| tram base a / b / c | 4,729 / 4,338 / 4,186 | 7 / 6 / 6 | 46.0 / 41.9 / 48.7 s | 47 / 58 / 40 ms |
| tram candidate a / b / c | 1,980 / 2,595 / 1,851 | 5 / 7 / 5 | 36.1 / 46.1 / 35.1 s | 50 / 35 / 59 ms |

On the tram the dominant costs are new owners, curb terrain draping and
paint; per generation the cleanest pair (c) spent 8.1 s (base) against 7.0 s
(candidate), with every road-related phase lower. The snapshot diffs cost
50 ms in total over five generations. Frame pacing on the tram is unchanged
within noise. Receipts: `zagreb-isochrone-main/performance/station3d/results/audit-2026-09-25/g1/`.

**Curbs: read evidence evaluated and rejected (26 September).** Curb tiles
are selected by every receiver region and re-drape whole 200 m tiles (tram 6:
21–43 tiles, ~2 s of ~7 s generation CPU). A candidate recorded each tile's
reads like a road receiver and selected tiles by evidence instead of road
source boxes. Against `v0.1.0-alpha.5` (alternating runs, load 3.6–9.0) it
still re-drew 93–99% of the tiles on the tram and changed nothing on the
walk; curb time differed within the base-to-base spread. A breakdown showed
why: every read-selected tile hits both a terrain region (2–7 detail windows
of ~1.1 km, 5–17 km² per generation) and a formation profile by id (440–620
changed profiles, mostly terrain-derived `points`, `baseTerrainCutout` and
`terrainExcavationRegions`). Of 68 re-drapes with a previous build to
compare, 42 moved kerb vertices by more than 5 cm (up to 6.1 m), 18 by
1–5 cm and only 5 by under 1 cm. The work is real, so the candidate was
dropped. Reusing per-run draped heights was also rejected: a run is a whole
road-union kerb ring (12,000 vertices across 28 roads on one tile). Receipts:
`zagreb-isochrone-main/performance/station3d/results/audit-2026-09-26/g1-curbs/`.

Still open:

- Terrain detail windows re-height square kilometres under built roads and
  curbs as the camera moves; that, not receiver selection, drives most
  tram generation CPU (see the curb breakdown above). Measured on tram 6:
  of the area each window move marked changed, ~40–45% was old/new window
  overlap whose heights differed only because each camera-centred window
  sampled the LiDAR on its own lattice, ~20–30% was trailing windows falling
  back to the base, and ~25–35% was fine terrain genuinely arriving.
  Fixed 1 m detail tiles were built and measured (26–27 September) and are
  parked, not released: one tile per 400 m terrain mesh tile, each requested
  with a 34 m apron snapped to the source lattice and kept as one grid for
  its life; the footprint is the mesh tiles meeting a ±200 m support square
  plus those along the first 700 m of the road ahead corridor (after
  reveal); tiles retire beyond 600 m once out of the footprint for 20 s, at
  most 16; landed tiles publish once per frame. The complete patch
  (`fixed-detail-tiles.patch`, applies to 6cfaaaa), probes and receipts are
  in `zagreb-isochrone-main/performance/station3d/results/audit-2026-09-26/terrain-tiles/`.
  Final clean A/B against the same code without tiles (tram 6, three
  alternating pairs, load 3.5–6.7): existing-road recompiles 2,290→823
  (−64%), but generation CPU 36.0→35.1 s (flat), median fps 71→69, median
  p95 25.0 ms both, readiness 24.1→28.9 s (an earlier startup-only A/B had
  31.9→26.6 s; the API was slow that day). Recompiles are not the cost:
  a tram generation spends ~6 s whatever it recompiles. Per run of six
  generations (both sides alike): curbs ~11 s (drape 8.2 s), ground paint
  ~7.5 s, roads ~8 s (road 4.7 s, formation 3.2 s), rails ~2 s. The tiles
  cut the road stages by ~1.5 s and nothing else.
  Lessons kept for any retry: geographic tiles must be chosen in mesh tiles
  (a mesh tile is fine only when fine cores cover it completely); the ahead
  corridor must not load during the world build (a tile landing mid-load
  re-published terrain and delayed readiness ~25 s); retirement needs time
  hysteresis (a wobbling lead point caused 74 revisions in 12 minutes);
  keeping tiles under the whole 1.4 km corridor raised p95 frame time
  25→32 ms.
- The parked curb and terrain changes removed different invalidation drivers.
  Curb selection still includes the 264 m padded boxes around changed road
  source tiles (`core/ground-generation-scope.js`); paint records follow road
  source revisions (`core/ground-surface-paint.js`), rather than height-only
  terrain revisions. This explains the limited measured gains. It does not
  establish that every loaded curb always rebuilds or an 11% CPU ceiling:
  owner counts alone do not measure the cost of existing versus new roads.
- Ground paint rework (28 September, included in Station3D `v0.1.0-alpha.6`):
  - The original 18 `dt11` publications averaged 1.254 s paint within 6.009 s
    generation CPU, 23.6 coarse blocks repainted and 4,438 polygon visits. This
    is excess repeated work, but 24 of 64 blocks does not prove a near-full
    repaint of populated coverage. The inferred 0.7 s validation cost and
    1.25→0.5 s prediction were not profiler measurements. The archived run also
    contains a terrain-worker failure, so it is not clean acceptance evidence.
  - Pure paint preparation now advances in 0.5 ms CPU slices, checking the
    clock after every operation with a 256-operation cap. Fresh validity checks
    occur between slices and before allocation, asynchronous preparation and
    publication. A frame-wide validity memo would be unsafe: the frame can
    contain a source edit or publication. One expensive operation can exceed
    the slice target; it is not a hard task-duration guarantee.
  - Identical owner replacements skip regional rebuilding; unchanged compiled
    polygons and complete plans are reused by the existing source-revision
    contract. Ownership moves and no-op publications retain their atomic
    metadata and stale-input checks.
  - Disjoint source rectangles accumulate into bounded per-page dirty blocks,
    including pending fine-page changes, shifts and rollback. The conservative
    material fallback bounds remain valid while those fine pages catch up.
  - A session cache shares source polygon triangulations across pages and
    generations, capped at 16 MiB and 8,192 entries. Removed/revised sources
    retire; eviction can cause later triangulation. Packet geometry remains
    page-local and preserves holes and material/source order.
  - Added engine-owned coverage for cancellation, source moves, same-source
    reuse, dirty-page rollback/shift, triangulation parity and capacity limits.
    All 471 tests, the build, release asset audit and packed install/vendor check
    pass. In a deterministic copied-fixture replay, unchanged recompiles copy
    388→0 source vertices; two separated edits repaint 4,992→1,920 pixels and
    triangulate 4→1 polygons. Coverage and holes match at 484 probe points per
    update. These are fixture work counts, not general speedup percentages.
  - Browser observations reached moving tram and stationary walk without engine
    errors. Tram publications with 2,401/2,752 paint records repainted 9/6 blocks
    on baseline versus 6/5 on the candidate; the candidate performed 625/962
    fresh triangulations versus baseline's 5,478/4,333. Raw timings are retained
    only as diagnostics: host load rose from 16–23 to 23–47, then 77–113 during
    walk, with paging. Tram baseline ran 120 s; candidate was saved early at
    113 s. Sources were cached by request, not a sealed replay. The baseline
    screenshot also shows missing ground/support coverage. These runs cannot
    pass a cross-mode appearance or frame-time gate.
  - Receipt: `performance/station3d/paint-2026-09-28.summary.json`; raw JSON,
    screenshots, response hashes, probe scripts and patch remain in the Zagreb
    consumer's `performance/station3d/results/paint-2026-09-28/`.
  - The follow-up frozen-source preflight did not start timing: the same pinned
    tram route had millimetre anchor drift, changing exact bbox request keys.
    The host was also paging at about 66 MiB/s. An explicitly unmeasured warmup
    extended the archived sources; a later walk visual check drained six ground
    publications without JavaScript errors but lacked seven building-mesh
    responses. These are preserved failures/limited checks, not acceptance.
    See `performance/station3d/paint-curb-2026-09-28.summary.json`.
  - Committed as `a8be0eb`, with main's foreign performance notes retained in
    `18dc78b` and integrated into candidate `85121b9`. Deterministic paint and
    curb replays were repeated against the committed tree and current main's
    runtime (`fc1e89b`), reproducing the work counts and exact query results.
  - The comparison harness now pins the first engine pose to the archived
    origin; native tram movement continues afterward. A sealed 1,659-response
    set still misses movement-dependent building and road tiles: a warmup route is not
    a complete request envelope. Native paging also continues. These diagnostic
    attempts cannot establish a speedup, appearance parity or post-stop liveness.
    Receipt: `performance/station3d/committed-2026-09-28.summary.json`.
  - Next: supply a complete frozen provider/request envelope and a quiet host
    before the acceptance comparison. Fail on missing sources before interpreting
    timing. Keep the cross-mode support, appearance and interaction gates open.
- Curb owner queries (28 September, included in Station3D `v0.1.0-alpha.6`):
  - Code reading identified a separate avoidable cost: every unique curb vertex
    searched every owner in its union, and distant owners fell back to scanning
    their whole centreline. The archived unions average 29.6 owner IDs per
    stored ring position, up to 62; draping was already time-sliced and already
    memoized repeated height lookups and owner-list joins.
  - Sets of at least eight owners now use the existing 80 m spatial index to
    select nearby owners. A strict distance proof permits early return; an
    unbounded fallback preserves distant queries without duplicate searches.
    Ties, captured snapshots and all owner read dependencies are retained.
  - An archived-source query replay compares 28,117 ring positions exactly:
    zero differences or null results, 4,382,434→3,557,589 segment projections
    (−18.8%) and 833,145→556,890 owner searches (−33.2%). The replay uses a
    deterministic terrain sampler and has 70 referenced IDs absent from both
    centreline indexes; it is not a production drape or frame-time claim.
    The complexity test goes red at 3,066→3,066 and green at 3,066→18;
    another test prevents duplicate work in the fallback.
  - Final branch includes main's package fixes through `fc1e89b`. Pinned-toolchain
    CI, 471 tests, release asset audit and packed install/vendor checks pass.
    The implementation is included in `v0.1.0-alpha.6`, but the performance
    gate remains open. Broad curb/terrain preparation and genuine
    new-road compilation remain potential improvements; no engine limit has
    been demonstrated. Keep this candidate fixed for the release comparison
    before adding another optimization.
- Rail and opening changes still use the padded-box rule.
- Receivers built by the ordinary per-tile path carry no evidence and use the
  box fallback.

### G2 — compile ground off the main thread

Even perfectly incremental, a moving observer continuously admits new owners.
The generator steps (road feature tasks, formation walls/collars, curb drape,
terrain cut, receiver faces) are pure computations over read snapshots, which
makes them worker candidates. Today only terrain and far-building render
packets use `workers/render-compiler-worker.js`.

- Move one family at a time (start with road feature geometry, the largest
  phase), transferring snapshot inputs and returning typed arrays.
- Keep admission, publication, Rapier collider creation and GPU upload on the
  main thread, bounded per frame. Worker results must carry generation identity
  and be discardable.

The payoff is both CPU (6–11 % of walking main-thread time in these runs, and
the largest queue CPU in every audited mode) and latency: wall time per road
generation is 5–13× its CPU time because it runs in 4–6 ms
per-frame slices behind rendering.

### R4 — high-DPI fragment cost

The same view measured 9.0 ms GPU at DPR 1 and 21.5 ms at DPR 1.5, so GPU time
scales with pixels. Freezing the shadow map changed nothing on the GPU. On a
Retina Mac at `high`, dense scenes therefore cannot hold 60 fps, and the
audit's DPR-1 captures do not show it. `core/quality-profile.js` has an
auto-DPR governor for `auto` only.

Steps:

- Measure GPU time per layer group with timer queries at DPR 1.5, hiding groups
  as a diagnostic only. Candidates: facade/standard materials, alpha-tested
  greenery and trees (≈720 k triangles, overdraw unmeasured), stencil ownership passes, MSAA.
- Offer an adaptive render scale that holds a GPU-time target for `high` on
  high-DPI displays.
- Reduce shader cost where it is measured: cheaper far-facade shading and
  foliage overdraw.

Do not silently lower everyone's default. Make it an explicit, documented
quality policy with before/after screenshots.

### L1, L2, L3 — later

- **L1.** Unchanged from the previous P8: reproduce the two reopen `isReady`
  exceptions with stacks, including close during active preparation, before any
  leak project.
- **L2.** Unchanged intent from P5/P6. Correction: there is **no altitude-based
  physics suppression**. Aircraft and boats skip the Rapier collider bubble at
  any altitude (`stepGtaSpecialVehicle` in `modes/gta.js`), while ground
  generations still prepare physics families. Validate landing and
  exit-to-walk against that fact.
- **L3.**
  - Walk support raycasts every merged building aggregate without a BVH
    (`getBuildingRoofY` in `modes/cab.js`, about 4 % of walking CPU). Use a
    per-region BVH or the existing surface registry.
  - Streetlamp regions draw with `frustumCulled = false` and sparse slot counts.
  - Texture upload calls run at about 180/s while walking; attribute them before
    batching.
  - `processedItems` counts attempts. The stuck queue above showed 368,902
    attempts for 171 items; add completion/retry/wait counters.
  - `otherTrainsFn()` has three independent callers (rendering, boarding,
    sounds); a shared per-frame snapshot only if profiled.
  - Negative-cache stable optional asset misses.

## Deferred or rejected directions

| Idea | Decision and reason | Reconsider only when |
| --- | --- | --- |
| Server-baked/precomputed whole world | **Deferred, not a demonstrated performance win.** Historical fully built on/off pairs showed no consistent advantage and increased payload. It does not remove texture residency, GPU uploads or driver stalls. G2 addresses the measured main-thread cost without a data migration. | A bounded pilot with versioned source identity, visual/entity/collision parity, lifecycle and paired measurements beats the current engine. |
| Road `BatchedMesh` prototype from July | **Rejected implementation.** Missed its draw/render gates, added triangles and removed selection/highlighting. Current owner-key batching supersedes it. | A different bounded prototype preserves semantics and demonstrates a measured win. |
| ECS/WebGPU/engine rewrite | **No current justification.** The measured costs (per-draw CPU, a static shadow pass, main-thread ground compilation, fragment cost at high DPI) are all addressable in the present architecture. | A narrower measured bottleneck cannot be solved inside it. |
| Globally fewer layers, lower quality, larger work budgets or unlimited caches | **Rejected shortcuts.** They trade away correctness/appearance or move cost elsewhere. R4's adaptive render scale is an explicit quality policy, not a benchmark switch. | An explicit product quality choice or a measured bounded policy. |
| More tram culling / first-time building batching / ordinary rail chunking | **Already done.** R1 targets a specific remaining tail (facade atlas pages, per-tile AO/drainage, entity meshes), not batching from scratch. | A new profile identifies a remaining specific exception. |
| Moving shadow cost to the GPU budget | **Not the lever.** Shadow-map freezing did not change GPU time; its cost is CPU submission (R2). | GPU attribution at high DPI shows shadow rasterisation mattering. |
| Static/dynamic cached shadow map (restore static depth, redraw moving casters) | **Rejected after implementation.** Full or rectangle depth restores cost +3–4 ms GPU per frame on ANGLE/Metal and halved frame rate from 120 to 60 Hz; traffic keeps casters moving every frame. | A backend where depth copies are cheap, or a separate dynamic-caster shadow term in the lighting shader. |
| Time-based cab smoothing as an FPS fix | **Not established.** Visual stability is separate from throughput. | A cadence-dependent wobble is reproduced, with pose correctness checked first. |
| Zebra ownership, crossing envelopes, rail material appearance, campaign-pack visual parity | **Correctness/appearance follow-ups, not ranked performance wins.** | Scope them as correctness work with the same no-regression gates. |

## Acceptance and maintenance

For each change, update its row here and the corresponding measured finding in
[audit.md](audit.md). "Done" requires code, focused deterministic tests and the
relevant measured cross-mode result, not a green isolated microbenchmark.

The minimum regression matrix is:

- dense walking at human and explorer speed, **including a stationary start that
  must drain** (S1);
- rail through stations/turnouts and terrain seams;
- slow road traffic/curbs;
- coastal boat/shore transitions;
- fast land flight with approach/landing.

Include Prijevoz and planner packaging, plus OSM checker and Consensus Builder
proposal selection/overlay workflows, when shared rendering/world APIs change.
Capture at DPR 1 **and** at the high-DPI cap.

Compare:

- frame intervals: p50/p95/p99, ≥50/100/250 ms events per minute, worst
  interval;
- **GPU time per frame and main-thread idle share**;
- draws, programs and program switches;
- startup latency, actual distance/coverage, catch-up time, queue age/debt;
- ground-generation CPU and wall time per publication;
- requests/bytes, resident resources and retained memory.

Agree scenario-specific acceptance thresholds before an experiment, and keep
prior receipts. No mode may lose support, scenery, selection or loading
correctness to improve another. Do not average away a regression.

Keep exactly these two canonical Markdown performance documents. Raw captures,
receipts and the 23 September probe scripts live in the Zagreb consumer under
`performance/station3d/results/audit-2026-09-23/` (ignored, local), next to the
22 September set.

## What changed from the 22 September list

- **New S1:** stationary delivery deadlock. It was invisible because every
  collector phase that "drained" did so only after movement.
- **Car collider failure re-reproduced.** The earlier claim that the failure is
  less visible in ground counters is now measured (`failed: 0`,
  `capacityBlocked: false`) and traced to the fixed-bubble path. Also new: rail
  dressing selects from every profile.
- **The 60 % "geometry-attribute loop" profile finding was mostly paging.** The
  same function is 11 % of walking and 20 % of stationary main-thread time on
  the same bundles. That is still real per-object cost (R1/R3), not upload
  volume: buffer uploads are small.
- **Buildings are the dominant draw source for a specific reason** (per-tile ×
  page facade atlas materials), replacing "isolate equivalent-detail costs".
- **The shadow pass is a CPU cost (R2), not a GPU one.**
- **High-DPI GPU cost** was absent from the audit, which used DPR 1 only (R4).
- **Ground generation** is quantified as the largest streaming CPU consumer, and
  its recompilation cause is identified (G1, G2), replacing "record why each
  generation was invalidated".
- **Corrections:** no altitude-based physics suppression exists; `otherTrainsFn()`
  has three callers; `FAR_MAX_PER_TILE` lives in `world/buildings-far.js`; the
  engine's own `tools/perf-trace.mjs` cannot run.
