# Station3D performance audit

Updated 23 September 2026. This and [next-steps.md](next-steps.md) are the only
current performance documents. Update them in place; keep dated measurements in
machine-readable receipts, not another audit or delivery tracker.

## Verdict

The engine already has substantial batching, cooperative construction, shared
streaming and coherent ground publication. Reimplementing those mechanisms is
not the next step. The highest-priority findings are **loading failures in GTA
ground/collision preparation and city-flight terrain evidence**. Next come
long frames and delayed completion of streamed world replacements. Open-water
flight is cheap to render; that does not establish city-flight performance.

This is a measured diagnostic audit, **not a controlled release benchmark**.
The shared Mac had substantial paging and varying native load. All measured
values below describe these exact runs; none establishes a general FPS promise,
a before/after speedup, or mobile readiness. The small relative CPU probe often
reported 100% clean coverage while native paging was active. That is insufficient
evidence of an uncontended machine.

## What was measured

- Headed Chrome 153, Apple M1 Pro/Metal WebGL2, 8 logical CPUs, 16 GB RAM.
- Fresh browser/profile per capture; one audit browser at a time. Viewport
  1600 × 1000, 1600 × 946 world canvas, DPR 1, high quality, antialiasing and
  shadows enabled, model terrain enabled, daylight fixed at 14:00.
- Current local application builds with the live, read-only Zagreb data provider
  at `https://zagreb.lol/prijevoz/api`. Local API captures with dropped responses
  were rejected. Fresh browser cache does **not** mean cold server/CDN cache.
- Normal product startup, then timed movement, then a stop/pause and observation
  of background work. Selected runs additionally waited for all declared
  producers, queues, building replacements and ground publications to drain.
- An external requestAnimationFrame observer recorded intervals and long tasks
  with `stats=0`. These are browser scheduling intervals, not direct GPU timing
  or proof of presentation of every frame. Diagnostic profiling is separate.
- Actual controller, position, travelled distance, terrain, quality, physics
  health, queue state, errors and screenshots were checked. Vehicle scenarios
  use authored spawn inputs to enter the requested controller, not fake movement
  or disabled collision. Car/boat throttle targets approximately 6 m/s.
- Walking uses the product's **25 m/s explorer speed**, reversing along a roughly
  55 m straight corridor. That is deliberately not a human-speed walking claim;
  story walking defaults to 1.8 m/s and needs its own future acceptance run.
- Heap samples are main-page V8 measurements, with backing storage reported
  separately; they are not whole-engine RAM or GPU memory. Native paging is
  system-wide and cannot be attributed solely to Station3D.

### Code identity and consumers

| Component | Tested source |
| --- | --- |
| Shared Station3D engine | `59f1dec43293e8c93545f5a548bdda3a804b4972`, alpha.2 |
| Zagreb host and Sloboda content | `13aa2d69c600b82ce2cc1bcf8c71e6f9867c45a1` |
| Universal Transit Planner | `0f84fbac20dca29b23f8c5f4466121e2a0bac721` |

Prijevoz walking/tram use the standard packaged engine. Sloboda car, boat and
aircraft use a content-overlay build of that engine; the overlay manifest is
authored content, not permission to implement separate terrain/collision rules.
Planner rail sessions use the standard package plus the planner's pose/data
adapter. OSM checker and Consensus Builder walking also consume the common
engine, but their complete host/proposal workflows were **not** separately
performance-certified by this mode matrix. Photo/reality-mesh mode, interiors,
night lighting, mobile hardware and long campaign play are outside this audit.

A lockfile was not sufficient proof: the planner's installed dependency still
contained the old initial-ground readiness gate despite its current pinned
commit. The first planner captures were rejected as current-engine evidence.
Only its **generated test distribution** was then atomically re-vendored from
the current engine. No dependency manifest or engine behavior was changed.

The current standard distribution and corrected planner distribution have
the same hash over sorted output paths and bytes:
`cdd475cbf8e14e390ea30eaa99699b713ec205b39b8325e65a983444ecf99a10`.
The Sloboda overlay hash is
`d6ba67999a21f7c73bb481b6a7b8be89267356ba71cebdaf5e8153e6bc77c756`.
The pre-correction planner hash was
`cc36a1fe70c048ee918b0964be80b85dc7b228935ccdab51b31374f7a01ee35d`.

## Fresh results

The table reports movement-window p95/p99/max intervals and counts of intervals
at least 100 ms. A 60 Hz frame budget is 16.7 ms; a 100 ms interval is a visible
hitch even when the average looks healthy. Different scenery and controller
speeds make these **scenario results, not a ranking of controller efficiency**.

| Scenario / receipt ID | Normal ready (s) | Movement (s / distance) | p95 / p99 / max (ms) | ≥100 ms | Interpretation |
| --- | ---: | --- | --- | ---: | --- |
| Dense explorer walk — `walk-high-3` | 19.75 | 60.13 / 1,491 m out/back | 23.7 / 33.0 / 323.9 | 3 | Current, no unexpected errors; still streaming. |
| Zagreb tram 6 — `tram-high-1` | 19.85 | 45.12 / 410 m | 30.3 / 54.1 / 906.5 | 8 | Current, normal station stops; successor ground still pending. |
| Planner train, project 153 — `train-current-high-1` | 48.49 | 60.17 / 1,168 m | 20.9 / 36.2 / 194.4 | 7 | Current engine; 15 missing consumer assets. |
| Planner project 13, offset 559.7 — `planner-current-high-1` | 63.30 | 45.57 / 488 m | 19.3 / 31.1 / 61.9 | 0 | Current engine; same consumer asset gaps, not fully drained. |
| Zagreb car — `car-high-1` | Failed | No accepted window | — | — | Rail-dressing collider overflow; no published ground. |
| Split car — `car-split-high-1` | Failed | No accepted window | — | — | Road-dressing collider overflow; no published ground. |
| Coastal boat — `boat-high-1` | 45.92 | 45.10 / 273 m | 14.2 / 21.4 / 198.2 | 1 | Current, healthy boat; ground and queues settled by end, one decor producer still pending. |
| Offshore aircraft — `airplane-high-1` | 10.80 | 60.19 / 5,459 m | 9.3 / 12.0 / 50.3 | 0 | Near the measured 120 Hz display cadence; open water only. |
| Split city aircraft — `airplane-city-high-1` | Failed | No accepted window | — | — | Road terrain evidence blocked; timeout reveal is not readiness. |

Ready time is the first sampled normal-ready state relative to page navigation,
not a precise GPU-present timestamp. Movement durations are the actual observer
windows. Collector/host delays extended project 13's nominal 20-second post-stop
phase to **80.93 seconds**; it must not be compared as a 20-second stationary test.

Walking eventually reached a fully drained scene approximately 80.1 seconds
after movement stopped; ground itself settled earlier, with other work still
pending. Its subsequent 20.3-second stationary sample had p95 23.6 ms, p99
49.9 ms and a 552 ms worst interval. It was not an empty scene: the final sampled
render counters were about 780 calls, 2.28 million triangles, 975 geometries and
537 textures. The shared-host caveat applies especially to this long tail.

The current railway run was still preparing ground with four pending changes
and 106 queued items about 115 seconds after movement ended. This proves slow
catch-up in the observed window, **not permanent livelock**. Train movement
covered about 1.17 km in a minute; the walking out-and-back remained within a
small area. They stress different aspects of the same streaming pipeline.

### Loading and correctness failures

**GTA collider capacity — confirmed, common engine.** Zagreb car spawn
45.8105, 15.96916 failed with `rail-formation-dressings collider exceeds its
complete coverage budget`. The world reached its loading timeout without a
published ground generation. A second car spawn on Split's Mišina street,
43.515575, 16.47115, failed for `formation-dressings` instead; diagnostics
reported `surface-collider-coverage-capacity`, a sampled `capacityBlocked=true` and no
published ground. These failed starts cannot supply healthy car FPS numbers.

`modes/gta.js` rejects truncated support; `core/gta-config.js` allows 8,000
dressing triangles in the 110 m road / 112 m rail bubbles.
`buildRoadFormationDressingTrimeshData()` in `core/gta-road-surface.js` selects
whole profiles by bounds and generates their wall/collar triangles until the
global cap. It does not clip individual triangles to the bubble or partition
this family into complete bounded chunks. The rejection is intentional safety;
accepting the first 8,000 triangles would create physical holes. The current
implementation needs bounded complete coverage, not simply a larger unchecked
limit. Rail-publication failure was also less visible in ground failure counters
than the road-generation failure; error propagation needs a regression test.

**Planner asset completeness — confirmed in the local packaged consumer.** The
fresh planner build requested missing facade metadata, a crowd-face image,
audio manifests and several horn/siren/music/ambience assets. It rendered and
moved, but these runs are degraded-consumer observations, not clean integration
passes. Optional provider facade-image 404s are a different category and were
not misclassified as engine exceptions. This audit does not assert that every
observed local asset omission is also present in production.

**City-flight terrain evidence — confirmed blocked start, cause not fully isolated.**
At the same Split coordinate, an aircraft at 300 m failed to reach normal
readiness. Generation 4 retained predecessor 3, with two pending changes and
`sourceBlocked=true`: road 1087564470 lacked terrain evidence at local
`(2382.25, 239.04)` during road-surface preparation. There were no recorded
HTTP/page errors. The next investigation must distinguish missing source coverage,
an oversized profile/preparation extent and a scheduling dependency. This is not
the car collider overflow: the airborne session already had zero fixed/traffic
physics bodies. No healthy city-flight timing is claimed.

The repeated coastal boat run encountered a CORS/failed request for a far-building
tile. Its timings are retained but flagged as degraded input, not averaged into
a clean repeated baseline.

### Work, memory and attribution

**Resident cost and source delivery.** Peak moving main-page heap/backing-storage
samples were approximately 636/251 MiB for walking, 803/292 MiB for tram,
720/310 MiB for boat and 219/47 MiB for offshore aircraft. These are separate
peaks, not quantities to add into an engine-memory estimate. Across each entire
capture, walking transferred 23.1 MB encoded / 77.3 MB decoded (461 requests),
tram 35.7/200.7 MB (528), boat 22.5/47.8 MB (470) and aircraft 23.6/32.9 MB
(1,307). Capture lengths differ. Aircraft's 50 failed network records were all
cancellations, not 50 missing world tiles. The legacy code-byte classifier missed
the migrated vendor URLs; the receipt reclassifies actual `/vendor/station3d*`
responses. Local static bytes are not production-compressed download estimates.

The walking capture coincided with **4.20 GiB system swap-in and 6.88 GiB
swap-out**, and one-minute native load ranged 13.9–84.2 on eight CPUs. This is
why neither its 552 ms steady-view hitch nor another run's smoother average
can be assigned wholly to engine code.

**CPU / streaming diagnostic.** A separate stats-on walking profile contains
6,282 samples over 65.9 seconds. About 39.6 seconds of weighted leaf samples
resolve to Three.js's geometry-attribute update/check loop in
`chunk-M6YBZUHY.js` (zero-based line 3955, column 2931). It iterates attributes
and calls the attribute manager's `update`; this can perform version checks
without transferring new buffers. This identifies a path to instrument, **not
39.6 seconds of proven GPU upload**, and does not identify its owning world layer.
Record changed attributes/bytes and caller/layer identity before changing it.

Deduplicating cumulative stutter records by event timestamp within the actual
motion interval gives 33 events. Examples include a 317 ms frame with 178 ms
inside render and 89 ms of hooks; a 233 ms frame with a 53 ms ground-generation
queue interval; and a 135 ms frame with 109 ms in tile delivery. Foot/traffic
hooks and diagnostic `perf:frameEvidence` also grew during stalls. Attribution
is not isolated causation: the host was paging and diagnostics have overhead.
Do not count the profiler-start stalls as movement: the old diagnostic phase
label began about 3.9 seconds before actual input. Ablations occurred much later;
their cumulative snapshots must not relabel old stutter events.

**Dense fixed-view experiments.** After verified drain, four 5-second windows
per treatment were run in ABBA order. Values below aggregate the raw observer
frames, not percentiles of window averages. They are exploratory stats-on results.

| Diagnostic intervention | Mean A → B (ms) | p95 A → B (ms) | Decision |
| --- | --- | --- | --- |
| DPR 1 → 0.75 | 14.27 → 12.34 | 16.1 → 15.6 | Pixel/detail policy merits a controlled experiment; no default-quality change justified. |
| Shadows enabled → disabled | 14.27 → 14.71 | 16.0 → 17.7 | **Invalid shadow-cost comparison:** shader errors; no speedup established. |
| Streetlamps visible → hidden | 14.90 → 14.10 | 16.7 → 16.3 | Small/noisy signal, including an A hitch; do not prioritize from triangle count alone. |
| Buildings visible → hidden | 14.53 → 9.03 | 16.5 → 11.0 | Strongest exploratory dense-view signal; isolate equivalent-detail draw/material/attribute costs next. |

Shadow disabling compiled an invalid `BuildingPassageMaterial` variant:
`worldPosition` was undeclared. `world/buildings.js` injects its passage varying
after Three.js's conditional world-position chunk. This is a variant-safety
follow-up, not evidence that the normal shadows-on run failed. Later hiding
experiments followed that error-bearing treatment; all need a fresh, error-free
confirmation. Hiding buildings removed approximately 390 draw calls, but missing
buildings are not an acceptable optimization or visual-parity result.

**Close/reopen.** After the long diagnostic session, then three short reopen/close
cycles, GC-controlled closed-state renderer counts stayed at 15 geometries,
24 textures and 33 programs. Warmed closed heap samples were 99.2, 100.2 and
100.5 MiB, with backing storage 36.5–37.1 MiB. The long first session had retained
more; these short subsequent sessions did not reproduce a monotonic large leak.
However, two reopen cycles emitted `Cannot read properties of undefined (reading
'isReady')`. No stack was captured in that precursor collector. Reproduce this
independently with stacks and cancellation instrumentation; lifecycle acceptance
**fails**, despite the resource counts. Three short cycles do not establish
long-route memory bounds. The portable collector now includes late errors in
final validation and starts CPU profiling before the movement phase.

Do not interpret scheduler `processedItems` as completed tiles. The counter in
`core/frame-chunk-queue.js` counts callback attempts, including repeat, defer
and dependency-wait steps. A queue can therefore show over 100,000 attempts
with little CPU time and fewer than 200 pending items. Use interval deltas,
pending age, completion/retry reasons and CPU together. Tile-delivery is outside
the initial-ready gate by design; its pending count alone does not prove a
ground failure.

Scene inventory is not GPU attribution either. Streetlamp instances use sparse,
fixed tile slots; `.count` reaches the highest occupied slot, including zeroed
gaps. The roughly 402,000 potential lamp triangles in the walking inventory are
not 402,000 visible triangles. Asynchronous warm-up renders can also overwrite
`renderer.info`; isolated one-call samples must not be mistaken for an empty
product frame. The diagnostic experiments above test hypotheses; they are not
permission to remove scenery.

### 23 September re-measurement

Same served bundles as above (`cdd475cb…`, `d6ba6799…`), engine `8f5c485`
(docs-only after alpha.2), Zagreb host `e87fb651`. The host was busier than on
22 September: load 6–18, and 13.3 of 14.3 GB swap in use. The repeated
collector walk was rejected by its own gate at 70 % clean host coverage. Numbers
below are diagnostic and were chosen for proportions and counts, not FPS claims.

- **Stationary delivery deadlock (new).** On a stationary dense-walk start,
  `tile-delivery` held 171 items for the whole observation (≥250 s in one run,
  ≥100 s in a second). They made 368,902 attempts at 315 ms total CPU, and the
  network was idle. Live source state showed four road-family sources with
  `admissionBarrier: true` and 19/95/38/19 pending callbacks. The barrier in
  `core/shared-tile-session.js` is removed only by the next admission, which
  those blocked deliveries would themselves trigger. Consequence: every
  "drained" phase in the 22 September captures was reached only after movement.
- **Car collider failure re-reproduced** with the identical message. During
  the failure, `groundGenerations.snapshot()` reported `failed: 0` and
  `capacityBlocked: false`: the error takes the fixed-bubble path, not the
  coordinator.
- **Ground generation.** Two 60 s out/back walks (55 m corridor, 25 m/s)
  published 10 and 5 generations for 9.5 s and 4.8 s of preparation CPU. Road
  generations cost 1.1–3.2 s CPU and 11–41 s wall each. They compiled 252–463
  owners, of which 184–349 were new and 234–436 carried the
  physical-dependency flag.
- **Main-thread anatomy.** Stationary, not drained: 22 % idle, `renderer.render`
  60 % (shadow pass 23 %, `WebGLGeometries.update` 20 % self). Walking: 2 %
  idle, `renderer.render` 52 %, the same attribute-check function 11 %. The
  22 September 60 % share for that function came from a profile with zero idle
  samples taken during heavy paging. The function is real per-object cost, not
  upload volume: buffer uploads were 15.4 MB over 30 s of walking.
- **Frame anatomy, dense walk view.** 528 main + 95 shadow draws, 160 program
  switches, 803 visible meshes, 1.63 M triangles. Buildings: 474 visible meshes
  over 180 materials. About 170 are per-tile × page `FacadeAtlas` meshes of
  30–120 triangles, and 42 are unbatched ~24-triangle entity meshes.
- **GPU timer queries** (`EXT_disjoint_timer_query_webgl2`): 9.0 ms per frame
  at DPR 1 (1600 × 946) and 21.5 ms at DPR 1.5 (2400 × 1419), in separate
  sessions. Freezing shadow-map updates did not reduce GPU time (22.2 ms). With
  an emulated device scale factor, frame intervals were pinned at 33.3 ms
  whatever the ablation, so only the GPU timer is usable from that run.
- **Claims corrected:**
  - There is no altitude-based aircraft physics suppression; special vehicles
    skip the Rapier bubble at every altitude.
  - `otherTrainsFn()` has three callers.
  - The engine's `tools/perf-trace.mjs` fails at import, because its helper
    modules exist only in the Zagreb consumer.

**Branch `perf-next` candidate (same day, uncommitted).** Against the same
consumer and provider, with the candidate vendored into a cloned consumer:
- The stationary walk drains, where baseline stays at 170–171 held deliveries.
- The Zagreb car, Split car and Split city-flight starts all reach normal
  readiness and move.
- Visible building materials fell 136 → 51 in the census view.
- Program switches per frame fell 158 → 126.
- The shadow pass is skipped when nothing it draws changed.
- A static/dynamic shadow cache was measured and rejected: +3–4 ms GPU per
  frame on ANGLE/Metal.

Timing comparisons are still owed: every window in this period had paging or
load above 1.5 per CPU. Details and the remaining work are in
[next-steps.md](next-steps.md).

Raw captures, CPU profiles and the probe scripts are preserved locally in the
Zagreb consumer under `performance/station3d/results/audit-2026-09-23/`
(ignored). The resulting priorities are in [next-steps.md](next-steps.md).

## Improvements already present

These are current source findings. Historical gains justify retaining them;
old before/after numbers are not transplanted into today's mode matrix.

| Status | Implemented mechanism / source |
| --- | --- |
| Done | Regional owner-key geometry batches, building material families and aggregate publication with picking ownership: `core/geometry-batch.js`, `core/aggregate-gate.js`, `world/buildings.js`. The old per-building-material/whole-city-draw-call diagnosis is not the current starting point. |
| Done | Ordinary rail render cells, signatures and bounded replacement; instanced structural details: `core/rail-render-cells.js`, `world/rails.js`. Structural/elevated culling may still merit a targeted profile. |
| Done | Cooperative frame queues with priority classes and far-work progress; staged decode/build/upload/retirement: `core/frame-chunk-queue.js`, `core/shared-tile-session.js`. A queue still cannot preempt one oversized synchronous operation. |
| Done | Shared tile fetching, bounded detail tiles, cooperative building decode, view-prioritized near delivery and retained ahead tiles: `core/tile-stream.js`, `core/shared-tile-session.js`. |
| Done | Worker-backed render/terrain compilation and rail GPU prewarming. “Move everything to a worker” is not a new diagnosis and cannot remove all main-thread upload/publication costs. |
| Done | Common ground generation/publication, renderer/support/backstop coordination, rollback and previous-world retention: `world/ground-generations.js`, `core/ground-generation-coordinator.js`, `core/surface-publication-registry.js`, `modes/cab.js`. New overflow failures show that this architecture still needs robust bounded producers. |
| Done | Fine terrain participates in initial evidence, bounded moving detail windows and shared mesh/sampler surfaces: `world/terrain.js`, `core/terrain-grid.js`. NoData is not zero elevation. |
| Done | Current initial-ground settlement gate: `core/initial-world-support.js`. It fixes premature reveal; observer-local readiness is still a proposed latency improvement, not already delivered. |
| Done downstream | Planner height/pitch share the full-precision chainage/profile sample. The previous audit measured a 148 mm mismatch reduced to numerical noise; this is a prior correctness result, not a new FPS measurement. |
| Done | Other-tram creation/retention radii of 1,400/1,500 m, one new mesh per update, two-phase updates and model LOD: `vehicles/tram.js`, `models/vehicles/tram.js`. Do not re-propose “cull before creating every tram” as unfinished. |
| Done | Higher construction throughput behind the opaque loading curtain, with interactive budgets retained. A prior experiment enlarging interactive budgets was reverted after regression. |
| Done | Byte/count-bounded caches, scalar/reused road queries, owner/bounds reuse, medium-quality facade/atlas limits and quality/DPR policies. These remain constraints; indiscriminate cache growth is not a free optimization. |
| Partial | Road/parking and landuse appearance integration, exact receiver-following ordinary markings. Zebra owner identity, crossing envelopes, rail appearance and final cross-mode visual parity remain correctness/appearance follow-ups, not demonstrated performance wins. |

## Contracts every optimization must preserve

1. Shared engine world rules apply by default to every appropriate session.
   Consumers provide world data and authored objects, not competing terrain,
   collision, streaming or ground-removal implementations.
2. Appearance, support and backstop cutting are separate ownership channels.
   Same-level precedence must not erase bridges, tunnels or other vertical bands.
   Missing evidence stays missing; zero is a valid height, not a fallback.
3. Publish compatible terrain, road/rail/curb support and collider generations
   together. Retain the previous complete world until the successor is ready;
   never claim success after truncation, missing layers or a timeout.
4. Bound input bytes, staged resources, cache retention, individual work items and
   combined publication peaks. Keep cancellation, disposal and finite catch-up
   after stopping. Average frame time alone cannot establish these properties.
5. Preserve model/entity identity, picking, proposal overlays and authored
   openings. Faster rendering with missing scenery or broken selection fails.

## Evidence, reproduction and limits

The Zagreb consumer repository preserves the compact
[measurement and retirement receipt](https://github.com/Poglavar/zagreb-isochrone/blob/main/performance/station3d/audit-2026-09-22.summary.json)
and the [headed collector](https://github.com/Poglavar/zagreb-isochrone/blob/main/tools/perf-modes-audit.mjs).
Those are optional downstream audit tooling, not engine installation dependencies.
The receipt includes all 15 capture dispositions, actual frame statistics,
source/output fingerprints, network and memory totals, diagnostic results and
hashes of 42 raw JSON/PNG/profile artifacts. Raw captures remain local and ignored
under `performance/station3d/results/audit-2026-09-22/` in that repository; they
were not deleted or represented as published evidence.

From the Zagreb consumer checkout, with the matching no-cache host on port 8091
and, for planner scenarios, the generated planner distribution on port 8341:

```sh
node tools/perf-modes-audit.mjs --help
node tools/perf-modes-audit.mjs --run --scenario walk --label walk-repeat \
  --seconds 60 --drain-timeout 0 --drain-after 120
```

Repeat with `tram`, `train`, `planner`, `car`, `boat` and `airplane`. Exact URLs
and overrides for both failed Split starts are in each receipt's `config`.
The collector requires `--run`, launches one headed browser and closes it on
completion. `--engine-root`, `--planner-root`, origin/provider and output options
are explicit. Rebuild/install/vendor the intended package before testing and
verify the output hash. This audit corrected the planner's generated vendor
directory only; its stale `node_modules` install still needs correction.

The initial local-API attempt, stale planner dependency attempts and the early
walking pilots remain in raw evidence with rejection reasons. Early walking
input was controlled from the external process and reached a wall; screenshot
overhead also contaminated its nominal window. They are not the walking result
in the table. The later collector times movement and reversals inside the page
and puts screenshots outside the measured movement phase.

Future candidate comparisons must replay the same recorded source responses,
same controller/camera/route/quality/DPR, same observer and time-adjacent ABBA
runs on a suitably quiet host. Keep every run, including failures. Record
native memory pressure alongside the CPU probe; do not silently select the
fastest samples or treat a CPU-only pass as GPU/memory isolation.

Measure cold startup, at least three minutes of moving streaming, a bounded
post-stop drain and a separately verified stationary phase. Require actual
distance and visible coverage, no new errors, no capacity failures, no damaged
test vehicle, and unchanged interaction/support correctness. Include repeated
close/reopen and both memory-limited and desktop hardware before release claims.
Neither this audit nor an engine unit-test pass covers that full future matrix.

Repository verification: 261/261 engine tests passed; the engine build and asset
release audit passed with zero review-required bundle inputs; the packed-tarball
install/vendor consumer fixture passed. Its first attempt was stopped during
a silent npm install wait; a network-enabled retry with bounded fetch timeouts
completed. Twenty focused downstream audit-tool/measurement tests also passed.
These checks validate tooling/package contracts, not the failed city starts or
a cross-mode no-regression performance claim.

Forty-eight competing Markdown audits/plans/trackers are retired across the
engine and Zagreb repositories. Their exact paths, content hashes and source
Git revisions are in the receipt. Tracked history remains recoverable with
`git show <recorded-revision>:<recorded-path>` in the indicated repository.
Installation, licensing, model ownership, campaign content, operational tooling
and unrelated reports are intentionally preserved. No engine fix, commit, push
or deployment is part of this documentation/audit change.
