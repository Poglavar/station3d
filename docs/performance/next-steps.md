# Station3D performance next steps

Updated 23 September 2026. Read [audit.md](audit.md) for measurements, completed
work, scope and limitations. This is the single active performance backlog.
S1–S3 and R1–R3 are implemented (see the status table); the remaining items are proposals.

The 23 September revision re-measured the 22 September claims against the same
served bundles (`cdd475cb…` standard, `d6ba6799…` Sloboda) and added frame-anatomy,
ground-generation, queue-liveness and draw-census probes. It found one liveness
bug that the previous list missed (S1), confirmed the car collider failure, and
replaced several "instrument first" items with measured, specific levers. See
"What changed" at the end for corrections to the previous version.

## Implementation status (`c98a73c` on `main`, deployed to zagreb.lol 23 September)

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
| L3a | Street lamps packed per region (`core/packed-instance-blocks.js`). Regions reserved 160 fixed slots per tile and drew up to the highest occupied slot, so empty zero-scaled slots were drawn. | Same view: 24,675 drawn lamp instances for 744 real → 744 for 744; main-pass indices 6.9 M → 5.8 M (−16 %). No new page errors. | Shipped in `532f3b5`. Frame time and GPU change not separable from noise (degenerate instances cost only vertex work). |
| R5 | Road surface triangulation made Delaunay before refinement (`core/delaunay-flip.js`, called from `refineTriangulatedSurfaceSteps`). Earcut fans long road polygons into needles, and midpoint refinement keeps triangle shape, so each needle became a fan of slivers whose count grew with its squared length. | Same view: `RoadSurface` triangles 502 k → 146 k (−71 %) over the same 168–170 k m²; triangles under 0.05 m² 204 k → 33 k. Main-pass indices 5.8 M → 4.9 M, back to the old engine's figure while carrying all its missing roads and lamps. Walk GPU median lower in 3/3 pairs (−0.5 to −1.3 ms; host paging). Screenshots unchanged apart from the randomly seeded asphalt texture. Refinement CPU unchanged (191 vs 183 ms for 300 rings); a third as many vertices to sample, build and upload. GTA car and city-flight starts load and drive. | Shipped in `2429557`. A flip on near-collinear Float32 points once folded two triangles onto one side of an edge; the guarded flip passes a 2,000-ring receiver-topology fuzz, and the regression test fails on the unguarded version. |

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

1. **Unblock correctness first:** S1 (stationary delivery deadlock) and S2
   (collider capacity / city-flight evidence). Both are loading failures, and
   S1 also corrupts every "drain" measurement.
2. **Make measurement trustworthy in parallel:** S3. It is small and stops the
   rest of the list being judged on noise.
3. **Take the cheap render wins:** R1 (building material/draw collapse), R2
   (static shadow caching), R3 (per-draw CPU hygiene). These are local changes
   with measurable counts.
4. **Attack the dominant streaming cost:** G1 (narrow road recompilation), then
   G2 (move ground compilation off the main thread). G2 is the largest potential
   moving-FPS and hitch win, and the largest project.
5. **Fix high-DPI fragment cost:** R4. It decides whether laptops reach 60 fps
   at all in dense views.
6. Later: lifecycle, readiness/lookahead policy and the small items.

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
| G1 / next | Make road ground generations incremental in practice: narrow `physicalDependencies`, cache per-owner results by complete identity — engine | M–L | High: stale support, missed seams | **High streaming payoff.** 234–436 of 252–463 compiled owners per generation carry a dependency flag (overlapping with 184–349 new owners). Exact invalidation removes the recompiles that change nothing; the achievable share needs measuring. |
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

Road generations are designed to retain unchanged owners
(`prepareRoadGroundGenerationSteps` in `world/roads.js`). The publication
`usage` shows why so much still recompiles:

| Generation | Owners compiled | New owners | Physical-dependency recompiles | Changed grades |
| --- | ---: | ---: | ---: | ---: |
| gen 3 | 463 | 349 | 436 | 16 |
| gen 5 | 252 | 184 | 234 | 8 |

Any existing owner whose bounds intersect a changed bound, with padding, is
recompiled.

Make dependency invalidation geometric and exact:

- Recompile a neighbour only when the terrain/formation evidence it actually
  sampled changed. Record per-owner evidence identities (terrain cell revisions,
  formation generation, receiver cut revision) and compare them.
- Cache per-owner compiled parts by complete identity.
- Coalesce arrivals (S1's scheduled admission is the natural batching point).

Each road generation currently also spends ~0.5 s in
`curb-generation:terrain-drape` over the whole curb set; apply the same
treatment there. Acceptance: in the out/back walk, compiled owners per
generation track new/changed owners, and total `ground-generation` CPU drops
proportionally with unchanged support/seam tests.

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
