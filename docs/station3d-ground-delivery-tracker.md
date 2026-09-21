# Ground engine delivery tracker

Updated: 16 September 2026. This is the short execution tracker. The
[ground hierarchy plan](station3d-ground-hierarchy-2026-09-11.md) remains the technical specification
and acceptance contract.

**Latest release:** step 5, land-use colour and decorative ground edges, is **deployed as `fe976f35`**.
All 124 distinct focused checks and the visual checks pass. The final candidate also avoids repeat
pattern uploads without increasing its allocation. Native performance passes against the saved V15 reference: moving mean/p95 is
24.90/33.80 ms versus 25.80/35.10 ms, resource category peaks grow 2.51%, and all ground work
drains without failures. The production checkout and public bundles are verified: all 36 modules
and 136 import edges match the qualified candidate, and cache purge succeeded. Earlier interrupted
attempts remain in the evidence. **Next: step 6, lane markings, zebras and near detail.**
See the [land-use release record](station3d-ground-landuse-2026-09-16.md).

**Previous release decision (step 4):** the bounded appearance increment is deployed as `0f73ef18`.
Two bounded optimizations are complete: point support uses the existing dense-cell tree (3,459 → 120
triangles in the retained query), and marking-buffer conversion/normals yield in chunks without the
redundant position copy. V15 passes movement, mean/p95 frame time, resources and complete drain.
The user accepts brief 50–100 ms hitches: 22 of 29 stationary hitches fall there, so the old >50 ms
count no longer blocks this increment. Seven exceed 100 ms versus production's six; moving counts
above 100 ms are 12 versus 5. The roughly half-second pauses remain a documented follow-up, not a
claimed fix. The two focused batches pass 69 and 29 checks (with overlapping files).
Production evidence is reused until code, data, scenario or host conditions make it unsuitable.
That release's owned browsers and temporary servers were closed. Steps 6–8 remain subsequent work.
Details are in the [appearance record](station3d-ground-appearance-2026-09-15.md).

**Where we are:** the first integrated ground/paving increment is **deployed**: engine commit
`3c61a248`, with deployment repair `5035de3e` and coastal precision/source recovery `1f5ffa24`.
All three adjacent production/candidate driving pairs meet the frame, stutter and initial resource
limits. Four scene checks settle, and five identical-route reopen cycles return every measured resource
to baseline. The
[integrated release record](station3d-ground-integrated-release-2026-09-15.md) is the authoritative
acceptance summary, including the isolated 300 ms stationary spike and the 41–139 s completion tail.
Wider surface appearance migrations remain separate work. The Sloboda city-label fix is already deployed
(`6d0d0812`).

**Separate release — deployed as `31803eb4`:** loading now reports measured stage progress,
active tasks and recent activity; unknown work is indeterminate. Construction receives more time
while the curtain blocks gameplay, and unused façade textures retire within a bounded time slice.
The isolated package passes 105 headless checks, production compilation and its native release gate.
In the matched capture, the loading hold clears in 10.784 s versus 13.920 s on production; movement
mean/p95 is 31.514/58.3 ms versus 34.897/66.5 ms; startup source-cache peak is 158.0 MB versus 213.0 MB.
Interactive scheduler changes were removed after the first candidate regressed while stationary.
The accepted package retains production's interactive scheduler and passes that phase too.
This improvement is live independently of the compositor; it does not complete step 3. The clean
production checkout, version-stamped assets, Cloudflare purge and public entrypoints were verified.
See the [scoped release and verification record](station3d-ground-loading-release-2026-09-15.md).

**Earlier bounded ground microrelease — deployed as `592859b62376f516c80f7b8e611b72f28e0449ff`:** scalar road projection, curb owner-ID serialization per build, and explicit triangle finite guards. It passes 14 focused tests; production emits 36 JavaScript outputs / 6,937,868 bytes. Git commit, public manifest and bundle match production, and Cloudflare was purged before public verification. Its normal comparison improves moving mean/p95/max to 31.433/57.43/100 ms versus 31.514/58.3/124.9 ms, but stationary over-50-ms count is 15 versus 12, so the full-plan gate remains open. See the [microrelease record](../output/ground-query-allocation-release-20260915/README.md).

**What this increment adds:** receiver paving, shared terrain/road/rail/curb publication and physical
support, bounded caches, terrain-window reuse, recovery after a failed terrain generation and complete
nested building-geometry cleanup. Road, parking, land-use, marking and rail colour migrations follow.

## Remaining steps

**Historical execution correction, 15 September:** step 4 was code-frozen at V13. The controlled comparison
reused that build and completed all related native checks in one browser session. Preserve that
evidence and the already completed headless/visual checks. Do not create another candidate, rebuild unchanged code, repeat
the completed scene matrix or turn an unassigned timing outlier into another engine change.
Preserve failures and stop to identify a demonstrated release blocker before expanding scope.
This check qualifies the bounded appearance increment; the final full-plan matrix remains step 8.

**16 September test hygiene correction:** an earlier manual facade test piped to `tail` left its
Node worker running at nearly one full CPU core for over 70 minutes. Ownership was confirmed and
the worker, runner and shell were terminated before restarting the requested comparison. Run focused
Node tests with `--test-timeout=30000`, preserve their real exit status, and confirm their processes
have exited before native timing. Do not treat a silent output pipe as a completed test.

Times are estimates of **remaining focused engineering effort**, including focused headless checks and
the relevant acceptance check. They are not elapsed session time or promised calendar deadlines.

| Step | Outcome | State | Remaining effort | Completion check |
|---|---|---|---:|---|
| 1 | Make streamed ground updates finish promptly | Release liveness/performance gates pass; latency improvement remains: complete drain takes 41–139 s after movement | Size a targeted latency batch from the retained traces | Changed ground publishes during movement, unrelated building tiles can be retained, and all finite queues drain. Reduce the remaining completion tail without increasing interactive work limits. |
| 2 | Finish consistency between ground, openings and physical support | Shared integration and coastal recovery deployed (`1f5ffa24`) | Broader scenario matrix remains in 8 | Terrain, road, rail, curb and physics consumers use shared publication. The final recovery build publishes after a 5 km coastal continuation and passes the completion/performance gate. |
| 3 | Qualify the first visible ground release | Deployed: `3c61a248` + publication repair `5035de3e` | Complete for this increment | Four scene checks, three adjacent performance pairs and five complete cleanup cycles pass within the documented scope. Publication uses the corrected HTML-only asset stamper. |
| 4 | Extend appearance composition to roads, cycle surfaces, parking and construction | V15 deployed as `0f73ef18`; underpass physical correction deployed as `08e9e294` | Both fixes are tested. V15 passes movement/resource/drain checks; 22 of 29 stationary hitches are below 100 ms, accepted by the user. Larger pauses remain recorded. The public/server proof covers 36 modules and 136 import edges. | These categories display their intended priority and colour while physical road shapes, support and reachability stay correct. Their duplicate colour paths are removed. |
| 5 | Migrate land-use colour and decorative ground edges | V3 deployed as `fe976f35`: 124 focused checks, native performance, visual checks and public bundle proof pass | Complete for this increment | Parks, forests, urban ground, polygon holes and shore appearance remain correct, with redundant drapes/sampling removed. |
| 6 | Finish lane markings, zebras and near detail | Pending receiver migrations | 3–6 h | Thin markings remain legible and stable at walking height and in motion. The chosen detail path has no duplicate near/far paint. |
| 7 | Migrate rail material appearance | After adjoining road appearance | 2–4 h | Tram and railway dressing use the shared receiver rules while steel, sleepers, physical ballast, platforms and bridge/tunnel support remain correct. |
| 8 | Remove obsolete paths, regenerate packs, finish defaults and final acceptance | After steps 6–7 | 4–7 h | Old migrated rules are removed; campaign packs are regenerated from the finished engine; repeated open/close cycles release resources; terrain-on defaults and explicit off behavior pass. |

**Forecast:** the first integrated release is deployed. The earlier total-hour forecasts and 42%
estimate remain withdrawn. The estimates for steps 4–8 are planning ranges for focused work, not a
reliable calendar ETA. The next implementation batch is step 6. Reuse the qualified V3 capture
as the new production reference and test only the changed candidate; do not repeat the completed
browser matrix after minor edits.

## Current checkpoint

**Coastal regression priority, 15 September:** a reported long-distance failure
interrupts the appearance batch. Local corrections preserve water/support storage
origins, prune expired terrain requests before admission, and release rail owners
on preparation bailouts. The shared streamer also schedules cleanup when grace
expires or the final dependency releases. The current isolated subset passes 101
tests. Project 160 continuation now publishes and drains at +4.2 km and +5 km from
its unchanged anchor; all nine nearby terrain support samples remain present.
The first matched check was rejected: extra post-movement source removals produced
six publications during drain instead of two, exceeding 180 seconds. Admission now
drains expired source membership before holding the next batch. The corrected
pair passes: moving mean 26.62 versus 26.66 ms, stationary 26.57 versus 27.63 ms,
and complete post-movement drain 33.47 versus 106.68 seconds. The exact final build
also passed a direct 5 km coastal continuation, publishing 49 terrain tiles with
nine supported samples and zero pending ground work. Deployed as `1f5ffa246f0d927959e45048bc196d824e2cdfc6`; see the
[coastal recovery record](station3d-ground-coastal-recovery-2026-09-15.md).
At that earlier checkpoint, the appearance batch was not yet released. Its V7 rejection produced a retained 79-face parking
fixture; V8 fixes the zero-area fragment proliferation and uses local stripe storage. Both native
scenes settle with complete decor and no page errors. The Savska support probes are restored and
the embankment stripe follows the receiver. The explicit 22-file batch passes 154/154 tests.
The adjacent movement comparison against the deployed coastal engine rejects V8: decor construction
exceeds the parking-detail receiver-candidate capacity after streaming. Ground publishes but the
complete world cannot drain. V9 reproduces the incorrect broad-query capacity accounting headlessly
and repairs it with separate finite query/intersection bounds. V9 then fails its finite query-work budget during initial decor construction. V10 indexes dense
road buckets and returns identical captured faces with 95% fewer records. Its 157 scoped tests
and production build passed; the stationary-tail rejection is recorded in the active step-4 section below. Physical overlaps and rail findings remain
recorded; no claim of a zero-violation world is made.

**Final release comparison, 15 September:** three interleaved pairs against production `592859b6`
use the same sealed data, route, noon lighting, high quality and 1600×1000 viewport. All captures are
valid, inputs remain unchanged and all timed CPU-contention samples are clean. Moving mean improves
by 24.5–33.5%, moving p95 by 54.1–60.2%, and moving intervals over 50 ms total **29 versus 681**.
Every individual moving and stationary mean/p95/stutter gate passes; initial resource growth is
−0.49%, +2.69% and +3.37% at the same 1,118-building coverage. Five reopen cycles have zero retained
resource deltas. All candidate ground/building queues drain with zero failed generations.

The third stationary capture includes one 300.3 ms interval. It remains in all statistics; its cause
is unresolved, and no new recurring counterpart was found across the three pairs. Complete background
drain still takes approximately 41–139 s after driving stops. These are explicit follow-up limitations,
not reasons to call the whole ground plan finished. The
[release record](station3d-ground-integrated-release-2026-09-15.md) preserves the figures, evidence
provenance, qualification decision and remaining scope.

**Historical step 4 evidence (road/cycle/parking/construction appearance).**
V15 is the current qualified checkpoint; its updated tolerance and baseline-reuse decision are above. The following
paragraphs retain the earlier V13/V14 evidence.
The 16 September extended pair on unchanged V13 is admitted, after removing a confirmed leaked test
process. Moving mean/p95 is 25.074/33.900 ms versus 25.207/41.600 ms; long intervals are 82 versus 106.
Stationary mean/p95 passes, but 22 long intervals versus 18 exceed the accepted limit of 20 (originally 19.8). Both worlds drain
without errors; initial resource category peaks are 5.39% lower. The release remains held on that
single numerical gate; the saved outliers do not establish a causal engine defect. Both views were
inspected and all owned browser/server processes closed. V14 now addresses proven repeated work in shared ground queries; its combined comparison is pending. The paragraphs below retain earlier results.

V12 passes 273 headless checks and completes shared shader bindings/mooring-line startup, but its
normal comparison remains held. Moving mean/p95 pass; moving long intervals are 32 versus 15.
Stationary mean/p95 regress 14.8%/24.1%, with 21 versus 9 long intervals. Both worlds drain without
failed ground generations; initial resource category peaks are 1.95% lower at the same building
coverage. One Chrome process served both normal captures and one diagnostic, then was closed.

The diagnostic identifies a cold window-overlay draw. A matching late passage repaint path bypasses
detached preparation. V13 puts that replacement through the existing queue, retains the old facade
until GPU readiness and aggregate publication, and checks revision/eviction/session ownership.
The grouped headless batch passes 329 checks across 46 files; the 63-path frozen candidate compiles.
The native driving comparison completed; its raw moving p95 and long-frame screens fail, while
stationary and resource screens pass. The saved baseline drive ends at 22% vehicle health against
a building, versus 100% health and an on-road candidate. End poses differ by 31 m/10.4° and final
building coverage by 223 buildings. The old survival-only admission rule missed this uncontrolled
route; a red→green headless regression now rejects damage. The subsequent distance-controlled
camera comparison matches waypoints within 0.30 m, but production fails host admission (84.6% clean)
and candidate raw moving p95 is 48.98 versus 41.635 ms. Its movement window is only about 13.5 s;
this does not qualify performance. Both worlds publish four generations and drain without errors.
The build stays frozen; no unchanged retry or speculative engine fix is scheduled.
The batch also corrects decor frame-wait accounting. All comparison browsers/servers are closed.
The diagnostic's host qualification failed, so it supplies call-path evidence only. V11 checkpoint
`36313aca` is pushed on its feature branch. No appearance candidate has been merged or deployed.

The earlier V10 appearance batch remains unreleased. Two valid counterbalanced pairs keep movement within the
mean/p95 limits and drain all work, but stationary long intervals total 24 versus 17 (limit 18.7).
Post-timing completion takes 105–110 s versus baseline 69–77 s. No more unchanged comparisons are
planned; address construction cost before the next appearance qualification.

V11 now skips off-block triangulation and batches consecutive identical paint materials while
preserving source ownership and finite limits. All 216 focused headless checks pass; a retained
357-footprint replay preserves exact geometry and reduces middle/far-page submissions from
540/400 to 423/210. Its completed production pair passes movement mean/p95 and the stationary
screens, but moving intervals over 50 ms are 44 versus 21 (limit 23.1). Both worlds drain without
errors; completion is 85.053 versus 65.702 seconds. A targeted render diagnostic in the same Chrome
identified late first-use shader work, leading to V12 above. No unchanged qualification rerun is planned.

The verified underpass physical width/frame correction is deployed as `08e9e294` (engine correction
`6d78916f`). The isolated package passes 108 headless checks and compiles; its four runtime files
exactly match the retained native Savska coverage proof. The release rebuilt 36 JavaScript modules /
7,391,787 bytes, purged Cloudflare, and verified all 36 public modules and 136 import edges against
the frozen candidate under an explicit 20-name generated-chunk bijection. See the [underpass release record](station3d-underpass-ground-release-2026-09-15.md)
and [appearance comparison](station3d-ground-appearance-2026-09-15.md).
Step 1 retains completion-latency work; the wider acceptance matrix and regenerated campaign packs
remain in step 8.

Publication verification caught a separate deployment defect: a global cache-version text rewrite
matched a JavaScript ternary assignment and corrupted one emitted chunk. The valid asset was restored
immediately and Cloudflare purged. `5035de3e` replaces that rewrite with parsing of HTML `src`/`href`
attributes; JavaScript and inline script bodies remain unchanged. Four focused regression tests pass,
and all 21 tracked HTML pages pass the parser/idempotence check. The release record retains the incident
and final artifact verification; the accepted engine code and performance inputs were unchanged.

## Earlier acceptance checkpoints

The dated entries below explain the fixes leading to this release. Their pending/failing statuses
describe those earlier captures; the current release decision is recorded above.

**Earlier normal comparison, 15 September:** the combined building dependency/startup/loading batch
passes 152 focused tests and compilation. Exact foundation inputs now decide whether surveyed
buildings need replacement; construction waits for the first ground publication, and atlas uploads
use the existing loading allowance. At the same initial 1,118 buildings, the adjacent clean-host pair
records movement mean/p95 of **23.57/26.60 ms versus production 31.30/58.36 ms**, and stationary
**23.81/26.40 versus 26.42/41.53 ms**. Candidate intervals over 50 ms are 12 moving and 2 stationary,
versus 172 and 9. Four generations publish without errors; complete world drain takes 63.456 s after
movement. Forty-two unchanged building tiles retain their meshes; four require replacement.

The conservative initial building-resource peak sum, including the new dependency cache, is
801,435,425 bytes versus 763,648,252 bytes (+4.948%). This clears that screen with a narrow margin;
it is a sum of category peaks, not simultaneous memory or full multi-scene resource acceptance.
The isolated release package is built. Paving, embankment and underpass captures settle with full
ground/support coverage and no void, duplicate or missing-paint samples; the Jelačić GPU paint/holes
proof passes. Parking and terrain/road diagnostic conflicts remain for subsequent migrations.
Donja Lomnica exposed a global retry on unavailable Grič terrain 10 km away. Missing evidence now
defers only that optional landmark, preserving any published shell/opening/support together; 69
focused tests pass, including an old-code failing regression. Its native replay reaches ready in
29.386 s and settles without errors; the historical retaining-wall audit classifications remain.
Five complete sessions release all measured ground owner pools, sources, listeners and queued work,
but expose **six retained GPU geometries per close**. The ownership trace identifies a nested
`StopShelter` group missed by top-level building geometry disposal. Close, tile eviction, replacement
and mask removal now retire descendant geometry once while preserving separately owned materials;
26 focused checks pass and all five new regressions fail against the previous removal paths.
The native recheck passes all five cycles with identical Sloboda route setup: every measured resource
delta is zero, all ground owner pools release, and there are no source/page errors or context loss.
An earlier one-program plateau used generic reopens with different entry options; it is not reproduced
with the route controller. The final three interleaved performance pairs are running. The full headless
sweep passes 5,013 checks; its one excluded foreign-CSS assertion is restored to the production version
and passes all seven focused checks. Stale test contracts and four missing loading labels are corrected.
**No integrated ground release has been deployed.**
See the [batch and adjacent comparison](../output/surface-audit/ground-implementation/ground-building-loading-v14/README.md).

**Active: steps 1–2 verification and step 3 scene acceptance.** The engine foundation is implemented;
acceptance of the integrated ground release remains open. Wider appearance migrations have not started.

**15 September, Trogir–Split terrain failure:** the user's project 64 start reproduced a
non-converging Float32 cut boundary before driving. The shared compiler now nodes edges through
occupied storage cells; the coordinator accepts changed camera windows after a failed generation,
and tile signatures count shared clipping rings once. The source-vertex ceiling and physical opening
checks remain. The exact start loads; a separate **911 m forward approach** publishes six generations
and drains ground work with zero ground/browser errors. Seventy-one focused tests and production
compilation pass. This closes the reproduced failure, not step 1's wider frame/resource gate or the
whole Trogir–Split journey. The repair is local, not deployed. See the
[diagnosis, regression and native receipts](../output/terrain-train-project64-repair-20260915/README.md).

The latest completed [scheduler admission check](../output/surface-audit/ground-implementation/ground-scheduler-admission/README.md)
reaches proper ready in **51.642 s**, publishes eight generations without a ground failure, and drains
all queues **207.450 s after movement stops**. All 46 timed host samples are clean. The capture is
**invalid for performance acceptance** because six road-surface responses were missing from the
recording. It establishes finite completion of the available inputs, with a long completion tail.

The current [requested-source batch](../output/surface-audit/ground-implementation/ground-requested-source-batch/README.md)
addresses the remaining fragmentation: one requested corridor was arriving across several expensive
ground generations. Managed admission now captures a bounded set of already requested tiles, waits
for their source callbacks, then compiles their complete dependency set. New requests belong to a
successor. Existing frame, network and decoded-input limits remain. The old code fails the captured
admission regression; **52 focused checks and production compilation pass**. Its integrated driving capture is now valid: **50.632 s to ready, five publications, no captured
errors, all 50 timed host samples clean, and ground/scheduler drain 136.542 s after movement stops**. The
completion tail remains substantial. The matched pair is source/route compatible: movement mean/p95 is
31.789/58.3 ms on main versus 25.492/34.1 ms on the candidate, with 163/13 intervals over 50 ms;
settled mean/p95 is 24.210/33.4 versus 24.039/26.9 ms, with 8/0 over 50 ms. Candidate readiness remains
50.632 s and the tail remains substantial, so this is not deployable. Short diagnostics attribute
most extra draws to buildings and rails. Final loaded-building counts were collected at different
drain stages and cannot explain timed draw differences; resource qualification needs fully settled
coverage. Later captures again contain long pedestrian-support frames; the earlier isolated spike is not evidence that this tail is resolved.

The active scheduler correction now distinguishes **dependency waits** from ordinary next-frame
yields. Held building jobs lend their unused share while keeping a small retry allowance; GPU/frame
pacing retains its normal budget. **74 focused checks and production compilation pass.** The broader
experiment timed out and its timing was followed by a 30 Hz display preflight on low battery, so it
provides no performance pass or reliable regression attribution. Power is restored. The current-main
comparison has finished: both initial scenes contain 1,118 buildings. Movement mean/p95 is
**33.520/64.780 ms on main versus 29.689/40.900 ms on the candidate**, with 212/32 intervals over 50 ms.
Settled mean/p95 is 29.634/45.480 versus 31.694/34.400 ms. This is one compatible pair, not full acceptance.

The completion audit found a missing dependency: building replacement slots and aggregate uploads
were absent from the post-timing drain check. The candidate still had **41 pending terrain rebuilds
and two active building replacements** when ground and scheduled queues became idle. The earlier
requested-source capture has the same evidence gap. Those results establish ground publication and
timed movement behavior, **not complete world drain**. Both startup and post-timing checks now include
building construction, replacements, invalidations and aggregate assembly; 13 focused harness checks
pass. The targeted continuation of the same frozen candidate **passes complete world drain**:
four ground publications, 1,411 loaded buildings, zero construction/replacement/aggregate backlog,
no captured errors and 49/49 clean timed host samples. The full drain is stable **90.917 s after
movement stops**. This is finite completion, not a claim of instantaneous streaming.
This continuation used draw-attribution diagnostics; the duration includes instrumentation effects
and does not establish normal-runtime throughput.

The recurring long-frame investigation found roof queries testing hidden replacement triangles and
missing already-computed aggregate bounding boxes. Both are corrected without changing roof-support
eligibility. Forty-seven focused geometry/support/harness tests and production compilation pass.
Its draw-attribution diagnostic capture still contains a 381.7 ms movement interval, and full drain takes 137.983 s after
movement stops. The correction is geometrically sound; it does not solve the frame tail.

The subsequent [bounded façade-cache retirement](../output/surface-audit/ground-implementation/ground-resource-bound-v14/README.md)
reduces the startup source-cache peak from 585.5 MB to 206.4 MB at the same initial 1,118 buildings.
It also creates more façade entries during construction (2,335 versus 1,660), so eviction/recreation
cost must be considered. This capture used **draw-attribution diagnostics**, not the normal timing
observer. Its diagnostic movement mean/p95/max is 36.570/50.100/708.100 ms, and full world drain
finishes 330.175 s after movement stops. Instrumentation also reduces the adaptive scheduler's
available time; neither figure establishes normal-runtime performance. The source/route contract is valid, 47/48 timed host samples
are clean and no errors are captured, but the actual driven pose/coverage differs. These runs do not
isolate the cause of the worse timing. The new candidate has no performance acceptance; further
cache tuning must address recreation as well as bytes. Steps 2–3 still need integrated scene and
resource qualification. No additional ground delivery step is marked complete.

The follow-up long diagnostic verified a 322.819 ms main-thread GC union in the earliest large stall,
with heap changing from 1,313,790,800 to 577,440,924 bytes (736,349,876 bytes freed). The short CPU
diagnostic max of 84.7 ms did not reproduce it. The long diagnostic missed one v14 terrain response
and combined geometry/paint dependency admission reached 257 against a 256 geometry capacity, so it
is diagnostic rather than timing acceptance. The road fix separates the existing geometry-256 and
paint-512 budgets (22 focused tests pass). v15 extends v14 by one response with all prior inputs
unchanged. The frozen v15 allocation diagnostic is recorded in [ground-allocations-v15](../output/surface-audit/ground-implementation/ground-allocations-v15/README.md). It estimates allocation volume but is invalid for native acceptance because traffic collisions destroyed or made the moving ground vehicle unavailable; later stalls remain unresolved. The normal integrated capture is recorded below; the heap-profile follow-up remains allocation-only.

The new [allocation-fix integrated capture](../output/surface-audit/ground-implementation/ground-allocation-fix-v14/README.md) is valid normal-timing evidence with 50/50 clean host samples: movement mean/p95/max is 24.276/33.1/93.1 ms versus production 31.514/58.3/124.9 ms, with 11 versus 176 intervals over 50 ms. Stationary mean/p95/max is 24.070/26.3/200.6 versus 26.670/41.3/91.7 ms. Six ground publications had zero failures; finite world drain was 144.725 s after movement (30 s settle plus 114.725 s post-timing drain). Actual driven paths and updates differ, so the longer drain is not attributed causally to the patch. The source-façade peak remains 212,721,695 bytes versus 158,001,314 bytes, and the stationary tail remains open. The bounded allocation microrelease is now deployed as `592859b62376f516c80f7b8e611b72f28e0449ff`; see the [release record](../output/ground-query-allocation-release-20260915/README.md). The full compositor gate remains open.

**Earlier owner-bound correction:** merged building meshes now retain each building's assembly-time
bounds for native raycasts, avoiding unrelated triangle tests over streets. Interactive queues
account for their shares against the original class allowance, so later callbacks can use the
remaining allowance without increasing frame or class limits. **111 focused checks and production
compilation pass.** Its normal-timing capture is valid, with 49/49 clean host samples and no errors.
Against the deployed loading release's retained reference, movement mean/p95 improves from
31.514/58.300 to 24.110/32.500 ms; four generations publish and full world drain is stable
78.660 seconds after movement stops. The same capture still has a 415.4 ms frame interval, charging
about 222 ms to pedestrian updates, and a 220.0 MB source-façade peak versus 158.0 MB in the reference.
The release gate remains open. A separate CPU profile targets the remaining stall; it cannot replace
normal timing evidence. See the [batch receipt](../output/surface-audit/ground-implementation/ground-owner-budget-v14/README.md).

The replay input gap has been handled as a complete driving envelope: sealed v14 covers all five road
endpoint families plus their detailed building/facade dependencies. All **9,716 response bodies** are
verified, with every v13 response unchanged. It is test data, not an increase in application requests.
The user's correction from 1,198 road requests to 65 stands; no request-count optimization is warranted.

### Evidence already retained

- [Station and flat-mode consistency](../output/surface-audit/ground-implementation/ground-entrypoints-verified/README.md):
  the 6 m station cut, 36 instanced treads and flat planner support agree with actual meshes within 1 mm;
  both entrypoints reach ready and drain. These are bounded static checks, not the complete release.
- [Coastal consistency](../output/surface-audit/ground-implementation/ground-native-fixed/README.md):
  seven publications drain without captured errors; a 41.44 m normal promenade walk has no support miss,
floor guard or airborne sample. Coastal openings and support use the shared publication boundary.
- [Completed loading checkpoint](../output/surface-audit/ground-implementation/ground-loading-complete-view/README.md):
  the finite initial ring and view build behind the curtain. Loading gets a larger bounded allowance;
  movement budgets apply after reveal. The prior native checkpoint reaches ready in 65.38 s with no
  data/ground backlog. The unchanged pose stays idle; a 40.38 m normal walk has no support miss.
- [Three valid walking pairs](../output/surface-audit/ground-implementation/ground-current-main-walk-v11/README.md):
  an earlier candidate improves movement mean frame time by 5.3–13.0% and p95 by 32.6–33.4% against
  current main. All timed host samples and replay inputs are clean. This is retained evidence for that
  candidate, not acceptance of the later source-batching change or all scene modes.
- [Driving terrain correction](../output/surface-audit/ground-implementation/ground-drive-retraced-ring/README.md):
  an exactly retraced path was misidentified as a real opening lost in Float32 storage. Exact boundary
  cancellation corrects it without changing the 1 mm limit or discarding real openings. The captured
  fixture fails the old compiler; 67 focused checks and subsequent native driving verify the correction.

Earlier diagnostics, rejected captures and detailed implementation evidence remain in the
[technical specification](station3d-ground-hierarchy-2026-09-11.md) and linked checkpoint directories.

### What happens next

1. Complete the prepared V9 movement/resource pair once desktop timing conditions are valid. The
   query-capacity repair passes headless checks; retain the existing Savska and embankment evidence.
2. Review that result and release the coherent appearance increment if it qualifies. Expand checks
   only for a failure, changed code or an inconclusive result.
3. Continue land-use, marking/detail and rail appearance in steps 5–7, followed by the final matrix,
   downstream campaign regeneration and cleanup in step 8.

The [15 September headed-testing audit](station3d-headed-testing-audit-2026-09-15.md) records the
excessive restart/diagnostic loop and the revised batch-and-reuse workflow.

## How progress will be reported

Use these step numbers in every status report: what became complete, what is active, what remains
before the next deployable increment, and whether the effort forecast changed. Update this file at
each coherent checkpoint. “Implemented,” “verified locally,” “deployable” and “deployed” are distinct
states. A passing test count alone does not complete a delivery step.

Batch related edits and run their fast headless checks together. Use one integrated browser gate per
coherent candidate, then repeat only the failing or materially changed case. If a step exceeds its
upper effort estimate or reveals a new architectural prerequisite, report the cause and revise the
tracker before expanding the next batch. Wider appearance migrations remain behind step 3 acceptance.

Original specification mapping: shipped foundations = original steps 0–2; tracker steps 1–2 = remaining
original step 3; tracker step 3 = original step 4 acceptance; tracker steps 4–7 = original steps 5–8;
tracker step 8 = original steps 9–10.

**Building reuse v14 checkpoint:** the valid normal observer capture records 23.88794/26.76/83.1 ms movement mean/p95/max versus 24.52304/26.6/192.2 ms stationary, with 10 and 4 intervals over 50 ms respectively. Four ground publications had zero failures; full world drain was 67.529 s after movement. Dependency checks retained 44 tile checks and changed 36, with 3,281,920 bytes peak/current under the 10,485,760-byte cap. Different publication paths prevent a causal comparison with the earlier six-publication capture. See the [building reuse v14 evidence](../output/surface-audit/ground-implementation/ground-building-reuse-v14/README.md). The recurring stationary render stall and pending native render diagnostic keep the integrated gate open; 97 headless checks pass.
