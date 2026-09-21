# Ground appearance checkpoint — 15 September 2026

**State, 16 September: V15 is deployed as `0f73ef18`.** The underpass correction remains live independently as `08e9e294`. The standard clean-main deployment rebuilt 36 JavaScript files / 7,419,119 bytes, stamped 57 HTML asset attributes without changing JavaScript, and returned a successful cache purge. The public/server proof maps all 36 generated modules and 136 import edges to the frozen V15 build through 20 explicit filename renames; public bytes exactly match the server build.

**Current release decision:** V15 completes the two requested improvements and is deployed in `0f73ef18`. Its candidate-only
capture exits 0, matches the retained production scenario and sealed data, keeps its served-code
fingerprint unchanged, and drains all ground work without errors. Its saved view was inspected.
The original >50 ms count is retained below, but the user explicitly accepts brief 50–100 ms
hitches and says not to block release over roughly 60 ms. The count alone no longer holds this
increment. Larger pauses remain an explicit limitation; qualification is not a claim that they are fixed.

| Final V15 comparison, saved production reference | Production | V15 | Decision |
|---|---:|---:|---|
| Moving mean / p95 | 25.207 / 41.600 ms | 25.797 / 35.100 ms | Passes |
| Moving intervals over 50 ms | 106 | 89 | Passes, including duration normalization |
| Stationary mean / p95 | 25.517 / 33.640 ms | 27.000 / 34.190 ms | Passes |
| Stationary intervals over 50 ms | 18 | 29 | Descriptive; brief hitches accepted by user |
| Initial resource category peak sum | 795,146,543 B | 737,975,767 B | −7.19%, passes |

The severity breakdown makes the old count misleading as a release blocker: **22 of V15's 29
stationary hitches are below 100 ms** (13 at 50–67 ms; 9 at 67–100 ms). Seven exceed 100 ms versus
six on production: approximately 125, 200, 207, 259, 275, 276 and 510 ms. While moving, 12 intervals
exceed 100 ms versus production's five; the maximum is 507 ms. Those larger events are not hidden or
reclassified as brief hitches. Movement mean/p95, total >50 ms count and resource use remain within
the existing release limits. This bounded increment proceeds with the residual large-pause issue
recorded for further work; full-plan performance acceptance is not being declared.
Evidence: `candidate-v15-20260916/stutter-duration-review.json`. The raw original 50 ms gate failure
remains in `v15-review.json`, alongside the subsequent explicit release review.

The 40 matching waypoints differ by at most 2.28 m, endpoints by 1.00 m, with identical headings.
Both start with 1,118 buildings and finish with 1,359. Ground publications are 20 versus 16; both
finish with zero pending/failed work. All frames remain counted. Moving host coverage is 131/132
clean reference windows and 120/132 candidate windows; stationary coverage is 57/58 and 56/58.
Both phases meet the existing 90% requirement. Two contended stationary windows contribute to the
noisy tail and remain in every reported number. They are not used to subtract slow frames.

The half-second symptom remains: V15's native moving/stationary maxima are 506.8/510.0 ms. Its
largest saved moving framework frame is 513.1 ms and host-contended, with 469.4 ms in hooks
(pedestrians 287 ms, including walkers 285 ms; foot control 104 ms, including ground 103 ms).
Its largest saved stationary framework frame is 339 ms, including ground support 100 ms, rendering
153.9 ms and stall 64.1 ms. These are distinct measurements and nested labels overlap. The two
changes remove verified excess work; this capture does not show the broader stutter problem solved.
Further release work needs to isolate the remaining support/render spikes using the retained evidence.

V15 build: 36 JavaScript files / 7,419,119 bytes; fingerprint
`03c41d364706cb5578f9cacd0f4e7f9fcc19e0d04d77a1926fc24b8070e80516`.
The 69-check support batch and 29-check marking batch pass; overlapping test files are not added
into a new unique total. The prior full engine batch was not repeated. Evidence is
`candidate-v15-20260916/v15-review.json`, `v15-build-receipt.json` and the two headless logs.

The queued V14 production run was canceled as requested. V15 uses the existing production artifact,
not a new production capture. The idle reaper closed the first Chrome during editing; V15's first
connection attempt failed before creating a page. One replacement Chrome completed V15. This batch
therefore launched two Chrome processes and completed two candidate captures, with zero new completed
production captures. Both connection/cancellation records are retained. All owned browsers and
ports 8360/8361/8362/9227 are closed; the canceled coordinator and child are gone. No further
candidate, unchanged retry or third engine change is part of this bounded batch.

**Earlier count-based review:** the user accepted **20 stationary intervals over 50 ms** for this 60 s comparison, rounding the
previous 19.8 threshold. Other performance and validity requirements remain unchanged. V13's 22
intervals still exceed that limit.

V14 reuses the existing dense road-cell bounds tree for feet/tyre point support. Previously only
rectangle/detail queries used it; point support scanned every face in the cell. A retained road
query now tests **120 instead of 3,459 triangles (96.5% less)** and returns the identical height.
The narrow-phase predicate, edge tolerance, ceiling, support policy and publication snapshots stay
unchanged; no additional persistent index is allocated. The two added regressions cover retained
geometry against exhaustive queries plus non-indexed faces, edges, gaps and stacked support.
The relevant grouped batch passes **69/69** checks with a 30 s per-file timeout and real exit status.
Evidence: `v14-point-support-replay.json` and `headless-v14-point-support.log` in the existing output directory.

The 502.7 ms native moving interval is a separate measurement from the saved 498.2 ms framework
frame. That framework frame spends 299.1 ms in hooks (183 ms pedestrians, including 172 ms walkers;
76 ms foot control, including 70 ms ground support), 140 ms rendering and 58.8 ms stall. Nested
labels must not be added together. Related ground/actor spikes also exist on production. The query
change removes proven repeated work in that shared path; it does not establish that this one query
caused the entire pause or the stationary difference. V14 completed one candidate capture. The user then required baseline reuse; the queued production
capture was canceled before it started. The retained production capture from
`paired-v13-walk-extended-clean-20260916` remains the reference. New candidate checks reuse it when
code/data/scenario and host evidence remain suitable; refresh production only when those conditions
invalidate the reference. This user instruction supersedes the default adjacent-pair workflow.

V14 is valid, has unchanged served-code hashes and the same sealed cassette, and drains without
errors. Against that saved reference, moving mean/p95 is 27.026/42.000 ms versus 25.207/41.600 ms;
149 long intervals exceed the baseline-derived limit 116.6. Stationary mean/p95 passes, but 27 long
intervals exceed 20. Resource category peak sum is 6.89% lower. The old paired receipt is intentionally
incomplete; `paired-v14-20260916/v14-review.json` records the separate reused-baseline comparison,
including the lack of a coordinator-collected child exit code. The candidate artifact completed and
the child was observed exited before the scheduler was terminated. The saved view was inspected.

The largest stationary framework frame is 519.8 ms, including 235 ms attributed to
`decor:greenery:markings`, 124 ms foot-ground support and 128.5 ms rendering. Native rAF records a
separate 576.1 ms maximum. The marking span contains one uninterruptible whole-buffer conversion
and normal calculation. V15 replaces that loop with existing flat-normal calculations in chunks of
at most 2,000 triangles, checks the existing frame budget between chunks, and attaches the prepared
arrays without a second position-buffer copy. Geometry, normal direction and one-draw publication
are preserved. Cancellation closes preparation before reading remaining faces. The 29 relevant
checks pass, including comparison with installed Three.js on slopes and degenerate triangles.
This is the second and final engine change in this batch. Its completed candidate-only check uses the
saved production reference; browser lifecycle and the final decision are recorded above.

**Previous V13 result:** the user-requested extended rerun completes on unchanged V13/production builds and sealed data.
One Chrome serves both variants, baseline first, over twenty 80 m out/back camera laps and a separate
60 s stationary phase. Both captures and their pairing are valid; sources and served code remain
unchanged. Host coverage is 131/132 clean baseline windows and 128/130 candidate windows. Every frame,
including contention, stays in the statistics. Both saved views were inspected after timing.

| 16 September extended comparison | Production | Candidate | Decision |
|---|---:|---:|---|
| Moving duration | 134.754 s | 132.967 s | Same 40-waypoint route |
| Moving mean / p95 | 25.207 / 41.600 ms | 25.074 / 33.900 ms | Passes; p95 −18.5% |
| Moving intervals over 50 ms | 106 | 82 | Passes, also after duration normalization |
| Stationary mean / p95 | 25.517 / 33.640 ms | 25.745 / 33.600 ms | Passes |
| Stationary intervals over 50 ms | 18 | 22 | **Fails 20 limit** (original threshold 19.8) |
| Initial resource category peak sum | 795,146,543 B | 752,277,074 B | −5.39%, passes |

The previous moving-p95 rejection does not reproduce in this admitted longer pair. The unchanged
stationary-stutter result still holds the release, including with the accepted rounding to 20. The largest native moving interval is 502.7 ms on
candidate versus 300.6 ms on baseline; it remains included. The saved framework trace places the
largest candidate moving spike mainly in pedestrian/foot-ground hooks, with related baseline spikes.
Its largest stationary framework spike occurs with idle background queues, in rendering and stall
time (including a 66 ms `perf:windowUpdate`). These observations do not identify a causal defect behind
the four additional native stationary intervals, or justify another speculative shader change.

Both worlds are drained by the end of the stationary phase, confirmed by the subsequent two-second
stability check, with zero pending/failed ground work and no page errors. Publication counts are
20 versus 9; final detailed buildings are 1,359 versus 1,379. Initial coverage matches at 1,118.
Corresponding waypoints differ by at most 2.43 m, endpoints by 0.37 m, with identical headings.
Resource category peaks are not simultaneous process peaks; dense-road-index memory was not
remeasured. Dynamic actors/publication histories remain a limitation despite the controlled route.

An earlier manual facade test from this session was found consuming nearly a full CPU core for over
70 minutes. The first extended attempt was interrupted before terminating that owned worker, runner
and shell; its evidence is preserved. The admitted pair starts after cleanup and reuses the same
Chrome. All owned browsers and servers are now closed; browser inventory is empty. No further rerun
or engine change was started before the user requested the bounded V14 improvement above. The harness's configurable repetition count passes 11 focused checks
with the paired-driver tests; no app build or completed engine test batch was repeated.
Evidence: `paired-v13-walk-extended-clean-20260916/v13-extended-review.json`, its raw artifacts and
`paired-v13-walk-extended-20260916/interruption-note.json` in the existing output directory.

**Earlier short comparison, 15 September:**
The controlled walking comparison reused the existing V13 build, production baseline and sealed data.
One Chrome served both captures, including movement, stationary behavior, resource use, visual state
and complete drain. Both saved views were inspected, then the browser and both owned servers closed.
No additional implementation, build, diagnostic capture or unchanged retry is scheduled.

Corresponding waypoints differ by at most 0.30 m, final positions by 0.18 m, with identical headings.
The existing on-foot camera controller moves at about 25 m/s: the four legs last only 13.4–13.6 s.
This is a short camera-path check, not ordinary walking-speed or long-duration acceptance. Production
fails host admission (11/13 clean measurement windows, 84.6%, versus the required 90%); candidate is
12/13 clean. All frames remain counted. Both publish four ground generations, finish with no pending
or failed ground work and report no page errors. Initial building counts are both 1,118; final counts
are 1,368/1,369. Dynamic actors still differ between captures.

| V13 controlled camera comparison | Production | Candidate | Raw result; baseline not admitted |
|---|---:|---:|---|
| Moving mean / p95 | 25.560 / 41.635 ms | 27.023 / 48.980 ms | +5.7% / +17.6%; p95 exceeds limit |
| Moving intervals over 50 ms | 17 in 13.649 s | 19 in 13.376 s | Exceeds limit, also after duration normalization |
| Stationary mean / p95 | 25.607 / 34.145 ms | 25.974 / 34.200 ms | Within limits |
| Stationary intervals over 50 ms | 18 | 17 | Within limit |
| Complete post-timing drain | 55.178 s | 67.596 s | Both finish |

The release remains held. The numerical rejection is preserved alongside failed host admission and
the short sampling duration; it is not a diagnosis of another shader/publication defect. Use the
saved `paired-v13-walk/v13-walk-review.json` and raw captures for follow-up. Do not create another
candidate or repeat the completed tests merely to pursue an unassigned outlier.
This is delivery tracker step 4 (technical plan milestone 5). Production includes the integrated
ground release, coastal precision/source recovery (`1f5ffa24`) and the underpass boundary correction
(`6d78916f`, deployed at `08e9e294`). V10's stationary-tail rejection remains recorded below.

V12 completes first-use shader bindings in the shared detached prewarmer, one linked program per
cooperative visit. It captures programs immediately after compilation: a different streamed object
changing a shared material's `currentProgram` cannot settle the wrong readiness fence. Both passes
of a transparent material remain covered. Renderer-local weak caching avoids repeat binding work;
failed diagnostics never enter the ready cache. Pedestrians retain their existing material leases
while using this shared binding step.

Mooring ropes now prepare their actual two-vertex line schema through the existing startup queue.
The program stays retained even when shoreline data and boats arrive after loading. Boats wait for
readiness; aircraft startup and paused streaming keep their existing behavior. Failed preparation
uses the shared retry coordinator, and cancellation fences disposal of the preparation geometry.
V12 did not change building publication policy. Its conditional diagnostic output records
owner/flags/material state, allowing the later investigation below to identify the facade family.

The grouped headless batch passes **273/273** checks across 39 explicit files. The original five
shared-binding regressions fail on V11; additional cases cover transparent passes, shader diagnostics,
paused boat publication, retries and cancellation. Candidate scope is 60 source/tool/test files;
all match the frozen checkout. The build emits 36 JavaScript files / 7,414,684 bytes, with website
fingerprint `afa10955074f3d1a9dd0b79d0941114d5561465a3026ff63ad9799103c29791c`.
`paired-v12` completed one candidate-first comparison against the unchanged production runtime,
using the sealed v14 data and one retained Chrome process. Both captures are valid; every frame is
retained, including the candidate's one and baseline's two contended measurement windows.

| V12 normal comparison | Production | Candidate | Decision |
|---|---:|---:|---|
| Moving mean / p95 | 25.097 / 33.4 ms | 26.378 / 34.3 ms | Within 10% |
| Moving intervals over 50 ms | 15 | 32 | Exceeds 16.5 limit |
| Stationary mean / p95 | 24.207 / 33.2 ms | 27.779 / 41.2 ms | Regresses 14.8% / 24.1% |
| Stationary intervals over 50 ms | 9 | 21 | Exceeds 10 limit |
| Complete post-timing drain | 98.370 s | 102.311 s | Both finish, zero failed generations |
| Initial resource category peak sum | 771,357,078 B | 756,322,155 B | −1.95%, within 5% |

Both initial samples contain 1,118 buildings. Resource category peaks are not simultaneous process
peaks and exclude a fresh dense-road-index measurement. Final published ground totals are five and
four respectively. Source inputs match, but actual driven poses, traffic and publication counts
differ; the comparison cannot attribute every timing difference to one code change.

One focused diagnostic reused the same Chrome. It fails timing qualification (39/44 clean host
samples, 88.6%) and is used only for call-path evidence. It records `facadeWindowOverlay` on a
54.4 ms visible draw, including 47.4 ms in `getProgramInfoLog`. Source review finds a matching
bypass: late passage remasking publishes standalone facade meshes without detached preparation.
The flag identifies the visual family; it does not recover the building ID or prove the cause
of every normal-run outlier. The browser and both owned servers were closed after this diagnostic.

V13 moves this remasking into the existing building queue. It prepares source UVs, textures,
geometry, base/passage shader variants and first-use bindings before publishing. Old overlays stay
visible; merged owners swap only when their aggregate rebuild publishes. Revision, tile and session
ownership guard late results. Owned warmup materials preserve shader callbacks and survive pending
compiler fences. Warmup cloning also avoids serializing live shader metadata. The grouped headless
batch passes **329/329** checks across 46 explicit files, including publication, cancellation,
eviction, unchanged-mask, transform and material-lifetime contracts. The frozen V13 scope contains
63 source/tool/test paths; its build emits 36 JavaScript files / 7,418,279 bytes with fingerprint
`1773bd3c53a242edc42e617919548284305eaabc3fe0ae63b516addd31462d60`.
The candidate-first driving comparison completed against the same production baseline and data.
Both host/capture checks pass; both worlds publish four ground generations and drain without errors.

| V13 driving comparison | Production | Candidate | Numerical screen |
|---|---:|---:|---|
| Moving mean / p95 | 26.015 / 34.475 ms | 28.002 / 41.6 ms | Mean +7.6%; p95 +20.7%, fails |
| Moving intervals over 50 ms | 41 | 54 | Exceeds 45.1 limit |
| Stationary mean / p95 | 30.017 / 49.515 ms | 28.440 / 41.7 ms | Passes |
| Stationary intervals over 50 ms | 47 | 40 | Passes |
| Complete post-timing drain | 140.251 s | 130.317 s | Both finish |
| Initial resource category peak sum | 766,005,094 B | 747,193,172 B | −2.46%, passes |

**Route admission correction:** the saved moving snapshot has production vehicle health
22.2776/100, versus 100/100 for the candidate. The saved images show the production camera against
a building and the candidate on the road. End poses differ by about 31 m and 10.4°, and final detailed
building counts are 1,604 versus 1,381. Equal key holds did not reproduce an equal camera workload.
The old harness only rejected a destroyed vehicle; a new headless regression reproduces this admission
defect and the corrected validator rejects any damage to the authored pristine car.

The numerical failure remains recorded; this uncontrolled route cannot establish the magnitude or
cause of an engine regression. The subsequent comparison uses the existing distance-controlled
camera corridor, with the same engine, baseline, sealed data and unchanged frame/resource limits.
Its result and limitations are recorded at the top of this document. The driving evidence remains
an integration limitation; no engine change is being made merely to chase these unmatched timings.

All frames remain counted, including three contended candidate windows and one extra read-only CDP
state sample that landed during stationary timing. That observation adds possible overhead; it does
not justify excluding any interval. The normal screenshots were inspected, and the browser and both
owned servers are closed. See `paired-v13/v13-performance-review.json`,
`paired-v13-observer-note.json` and `route-validation-{red,fixed}-v13.log`.
The same batch fixes decor accounting that included an intentional frame wait in reported CPU work
and could add a second wait; its focused regression fails on V12 and passes with the correction.
No unchanged qualification retry is planned. V11's saved feature checkpoint `36313aca` is pushed
to `ground-appearance-candidate-v11`; neither V12 nor V13 has been merged or deployed.
Evidence: `headless-v12-scoped.log`, `v12-build-receipt.json`, `candidate-root-scope-sha256-v12.json`
and `paired-v12/`, `v12-render-cause-summary.json`, `decor-paint-yield-red.log` and
`decor-paint-yield-fixed.log` under `output/ground-appearance-release-20260915/`.

V11 rejects polygons outside repaint blocks before allocating triangulation copies. Rejected work
still yields, and the existing vertex limit is checked before rejection. Consecutive contributions
with identical material IDs and repaint regions share a draw; material changes, region changes and
the existing vertex cap split it. Source identities/revisions retain explicit index ranges in the
version-3 packet. Paint order, holes, receiver ownership and texture budgets are unchanged.

The focused **216/216** headless checks pass across 31 explicit files, including four new regressions
that fail on V10. An offline replay of nine retained road tiles (357 footprints, two representative
class recipes) preserves exact source triangles and repaint regions. Submissions change from
176 to 172, 540 to 423 and 400 to 210 at widths 128, 1,024 and 4,096 m respectively; geometry and
texture bytes are identical. This packet-only replay does not reproduce complete world eligibility
or establish frame performance. The frozen candidate emits 36 JavaScript files / 7,413,686 bytes;
website fingerprint: `3018b973a17041d2e0ef4a7631b24b0820ce795107c298c07fb78513097744d1`.
`paired-v11` uses the current production runtime, sealed v14 data and one retained Chrome process
for a candidate-first comparison of startup, movement, stationary cadence and complete drain.
Evidence: `headless-v11-scoped.log`, `paint-packet-work-replay-v11.json`, `v11-build-receipt.json`
and `paired-v11/`, under `output/ground-appearance-release-20260915/`.

Both V11 captures are valid; all frames, including the candidate's two contended measurement
windows, remain counted. Each publishes four ground generations, drains all work and reports no
page errors or failed ground generations. Movement mean/p95 is 27.179/35.525 ms versus production
25.144/33.4 ms (+8.1%/+6.4%). Its 44 intervals over 50 ms exceed the 23.1 limit against production's
21. Stationary mean/p95 is 25.523/33.5 ms versus 24.914/33.4 ms, with 10 versus 12 long intervals;
the stationary screen passes. Complete post-timing drain is 85.053 versus 65.702 seconds.
Initial resource category peak sums change +0.35%; these exclude a fresh V11 measurement of the
dense road index. The unchanged texture budget and V10's separately measured index remain recorded.

V11 reduces observed paint submissions to 12,603 from V10 confirmation's 16,247, with 20 page
publications in each. Ground generation 4 records 8.005 versus 9.155 seconds of CPU work. Different
driven paths/publication inputs prevent attributing all of that difference to the patch. The remaining
moving outliers spend most of their time in rendering. A separate slow-draw/CPU diagnostic reuses
the same Chrome; it cannot qualify performance. No unchanged qualification rerun is planned.
See `v11-performance-review.json` and `v11-paint-construction-comparison.json`.

The targeted diagnostic completed in the same Chrome and its saved street view was inspected.
It caught a 58.9 ms `getProgramInfoLog` inside a 61.1 ms visible building draw, and a 36.8 ms
call inside the mooring-rope draw. No slow paint-page draw appears among its 29 recorded slow calls.
This identifies late shader preparation as a concrete follow-up, not a complete explanation of
every outlier in the normal comparison. The installed Three.js source confirms that `compileAsync`
waits for linking, while `getUniforms`/`getAttributes` perform lazy first-use queries. The generic
`prewarmDetachedObject` helper stops after linking; `createQueuedShaderWarmup` already completes
those bindings for pedestrians. Ordinary building parts and mooring ropes require a publication-path
review as well; adding a call to the generic helper alone cannot cover a path that never uses it.

The next bounded batch must establish this shared invariant: a streamed visual's actual shader
variant and first-use bindings are ready before its first visible draw, through the existing
cooperative preparation and cancellation fences. Retain shader error reporting, geometry limits,
actor readiness and session cleanup. First reproduce the missed paths headlessly; do not assume
the observed building material's source from its numeric material ID. The V11 normal comparison
stays rejected. Evidence: `v11-render-diagnostic.json`, `.cpuprofile`, `.png` and
`v11-render-cause-summary.json`. One Chrome process served the two normal captures and the diagnostic;
it was closed afterward and native browser inventory was empty.

The batch adds road, cycle, parking and construction material coverage to the shared compositor.
Ordinary road shapes remain physical; eligible cycle colour and decorative parking/construction
sheets become paint. Road and decor producers publish immutable owner sets through the same cache
transaction. Triangle packing batches repeated cycle quads. The four mask layers and four pattern
slots retain their existing capacities.

The frozen first candidate passes 184 focused checks across 25 files. Native comparison uses the
same sealed v14 source data and the exact deployed-ground baseline. This exposed defects that the
headless checks did not establish:

- **Missing receivers at Savska.** Removing the old parking sheet exposes 30 additional sampled
  gaps. At local `(24.5, 57.5)`, the candidate has parking material intent but no terrain receiver
  or walk support; its hidden catch-all plane is not valid coverage. Repair the actual cut/replacement
  contract. Do not add an offset sheet to hide the gap.
- **Parking stripe height.** The first adapter used an evidence-only height helper, placing some
  stripes 13–22 mm below retained road tops. A focused production-function regression now guards
  the observed case. Correct placement must read the appropriate published physical receiver,
  without actor recovery policy, speculative terrain or a lazy formation rebuild.
- **Incomplete acceptance observation.** One embankment capture reported settled while decor paint
  was still absent. Its apparent conflict improvement cannot qualify the migration. Include the
  relevant decor source/build/publication state in completion checks; published paint alone cannot
  prove that all expected producers arrived.
- **Startup liveness.** One Savska attempt timed out before first complete ground construction.
  A diagnostic rerun publishes two generations and drains. The failed attempt remains retained;
  its missing coordinator trace prevents attribution. Subsequent diagnostics record that state.

The underpass has now been reproduced exactly without a browser. Its captured definition
(`osm-1027705611`) has no supplied width: the old cut compiler used a 12 m half-width while the
structure renderer used a 6 m formation half-width. Shared physical cross-section resolution now
feeds both; the broader profile-association radius remains separate. Cut-run boundary frames also
use the full alignment samples, matching the wall/floor rows. An explicit replacement with absent
cross-section fields now still emits its default physical floor. The old baseline fails the parking
gap regression. The repaired cut stays inside actual renderer floor triangles in the headless replay,
while preserving the real portal and terrain over the covered box.

Retained parking markings use the published ordinary road triangle registry and terrain
receiver directly, using the same claim eligibility as material binding. Actor recovery and lazy
formation queries are excluded. The detached decor build checks the road publication revision as
well as terrain before publishing. A fixed set of producer states records pending, published, valid
empty and failed outcomes; stale jobs cannot complete their successor. Native audit and performance
settlement include those states. Historical baselines expose only in-flight decor activity, and the
comparison receipt explicitly identifies that weaker observation.

The combined headless run covered 335 tests: 334 passed and one static wiring assertion required an
update for the returned publication result. The affected wiring and real structure tests then passed
11/11, including the added missing-cross-section regression. These results do not qualify the
batch for release without the native checks below.

The first repaired native attempt (v5) correctly refused settlement: decor had valid source
terrain at its request centre (`Y=0`) but no clipped terrain receiver there. The existing availability
check treated that intentional opening as missing source data and waited indefinitely. Request
admission now uses the retained source evidence; actual placements continue to require their own
physical receiver. A real-function regression covers this case, missing data, terrain/road revisions
and explicit flat mode; 19 focused checks pass. The stopped v5 attempt is retained as rejected
completion evidence.

Frozen v6 completes both native scenes with all seven decor producers published and no reported
ground/producer failures. The two previously missing parking probes have actual published terrain
and walk support at `−3.7774 m` and `−3.6928 m`. Savska's sampled void count falls from baseline 723
to 708; the remaining historical void classifications require their own interpretation and are not
a claim that every sampled gap is harmless. Embankment retains complete sampled coverage.

| Scene | Baseline inversions / coplanars | v6 inversions / coplanars | v6 floating / void / duplicate paint |
|---|---:|---:|---:|
| Savska | 23 / 506 | 1 / 6 | 32 / 708 / 0 |
| Embankment | 98 / 114 | 1 / 22 | 0 / 0 / 3 |

The v6 review nevertheless rejects the appearance batch as unfinished. Although stripe vertices
now sample the correct height, their independent triangles cross receiver facet boundaries and
dip up to 9.5 mm below the receiver between vertices. Road/terrain transition faces also retain pale
material wedges through parking coverage. Neither defect is solved by increasing the stripe offset.

The v7 geometry repair clips each stripe footprint to the actual published terrain/road facets,
then removes portions obscured by higher receiver planes. This preserves cut holes, splits at
crossing planes and produces a single stripe cover even when receivers coincide. Output coordinates
are stored as Float32 before height interpolation. The existing terrain source-face and road-cell
indices supply candidates; there is no scene raycast or full-world geometry scan. Source, candidate,
fragment, comparison and output capacities bound the cooperative compiler. It keeps one merged
marking draw and records construction usage.

Ordinary road earthwork and seam faces receive the same material composition as adjoining terrain.
Their structural class stays intact; their material's minimum paint rank is zero. Grade-separated
earthworks, concrete retaining structures and rail earthworks remain separate. Actual collar/seam
triangles join the road registry's atomic publication. Collars stay non-drivable, and explicit
non-supporting seams remain excluded from point support; the detail query can still see their real
visible triangles. The headless integration batch passes 85/85 checks, including dense interior
projection checks at 1 µm tolerance, area/duplicate coverage, holes, registry lifetime, renderer
collection and publication rollback.

A subsequent control-flow correction (v8) makes compiler cancellation on a superseded receiver
request refresh rather than latch a current decor failure. Receiver readiness is rechecked at
cooperative yields instead of repeatedly within an uninterrupted slice. It changes no geometry
output; the 11 affected projection/publication checks pass.

The frozen v7 native check rejected the embankment build: overlapping receiver boundaries
produced zero-area fragments that exhausted the existing 1,024-fragment capacity. The captured
79-face input is now a durable regression fixture. Excluding zero-area subtraction fragments
reduces its peak to 18 fragments, with 687 output vertices and 4,150 comparisons, without raising
the capacity. Interior coverage, an independent highest-receiver oracle and stored footprint
area verify the replay; zero-width shared edges cannot multiply into new area.

V8 also gives the merged parking-marking mesh a window-local storage origin. Clipping and
receiver queries retain scene coordinates in double precision; XZ is localized before Float32
storage, then height is evaluated at the actual stored position. Legacy formation markings join
the same local mesh. The affected projection/terrain/publication batch passes 30/30, including
translated receivers at 4.096 km, 16 km and 100 km and invalid-origin rejection. This does not
add a draw call or increase a geometry/work capacity.

The V8 comparison starts from coastal engine `1f5ffa24` (documentation checkpoint `2c4b6161`).
Its 47 scoped files are frozen separately from other local edits. Candidate website fingerprint:
`40cfd50333567ef8c18f46ff22a2d5941dfed03d4e90e6cf9d49060a1b22bd25`.
The explicit 22-file appearance batch passes **154/154** in 2.14 seconds, with actual process exit
zero (`headless-v8-scoped-verified.log`). An accidental broad Node discovery run, caused by an empty
file selection, is retained as `headless-v8-final.log` but is **not** verification evidence. Its
three remaining process groups were identified by their command lines/output descriptors and
stopped; no group remained and no unexpected repository changes were found. See
`invalid-test-run-receipt.json` for the execution correction.

Both V8 native scenes finish with ground/decor published, queues drained and zero page errors.
Savska's two gap probes retain support at `−3.7774 m` and `−3.6928 m`. Embankment parking stripes
follow the receiver at the intended +2 mm rather than dipping below it; close and walking-height
images were inspected. Construction stays within the existing limits: embankment peaks at 156
receiver candidates/248 fragments and 141,405 output vertices; Savska peaks at 187/76 and 277,959
vertices. These are cooperative construction totals, not new per-frame work.

The raw audit remains conservative about thin markings and overlapping physical receivers:

| V8 scene | Inversion | Coplanar | Floating | Void | Duplicate paint | Missing paint |
|---|---:|---:|---:|---:|---:|---:|
| Savska | 0 | 11 | 34 | 708 | 5 | 0 |
| Embankment | 1 | 40 | 0 | 0 | 18 | 0 |

Of embankment's 40 coplanar samples, 38 are retained parking markings at +2 mm (previous worst
gap −9.5 mm); the other two are the retained rail finding. Its 15 additional duplicate-paint
observations are cycle/sidewalk colour applied to existing collar/terrain overlaps. This is not
proof that the physical overlap is harmless and does not waive the later physical/rail review.
The movement comparison uses `paired-v8.manifest.json` and the same sealed source cassette as
the deployed coastal check. The baseline capture is valid, but the candidate fails after movement:
the parking-detail projector throws `Detail receiver candidate capacity exceeded` during decor
construction. Ground generation 4 publishes, but the decor producer fails and the complete-world
drain cannot pass. The candidate's timing numbers therefore do not qualify this release. Evidence:
`paired-v8/receipt.json` and `paired-v8/candidate-gta-drive-1-attempt-1.log`.

Three new duplicate-paint classifications at the embankment occur over unchanged physical
road/terrain height stacks. They are not evidence of added road geometry, but neither are they proof
that the existing physical overlap is harmless. The audit's `:paint` entries describe colour on
the same physical draw, alongside a non-colour support observation; they are not additional
meshes. V8 records actual mesh, triangle, source identity and effective visibility at these
locations; the broader physical-overlap review remains open.

V9 reproduces a capacity-contract defect headlessly through the production terrain-query API:
a diagonal stripe queries four valid terrain source cells containing 512 facets, but only a small
subset intersects the stripe. V8 rejects it before testing those intersections. The repair applies
the unchanged 256-face envelope limit after exact footprint clipping. Raw query work, including
empty cooperative checkpoints, has a separate generation-wide 4,194,304-step bound; pairwise work,
fragments and output retain their previous limits. Pairwise bounds now use clipped footprints.
The regression verifies full stripe area, single-surface coverage and interpolated height. An
additional test proves that an infinite empty provider fails at the query budget and is closed.
This reproduces the faulty contract, not a retained geometry snapshot from the moving V8 failure;
the exact route must still establish that its failure is repaired.

The frozen V9 candidate matches all 47 scoped paths. Website fingerprint:
`9d21d58bcb7d15880708c6de9f9cce2f4f3ad7d029b01de400c9c364518e4a84`.
Its explicit 22-file test run passes **156/156**, exit 0, in 2.18 seconds. Production compilation
passes and emits 36 JavaScript files / 7,412,196 bytes. Receipts: `headless-v9-scoped.log`,
`headless-v9-test-paths.txt`, `candidate-root-scope-sha256-v9.txt`, `candidate-build-v9.log`.

The first V9 paired invocation stopped before world loading: the baseline's display preflight was
29.5 Hz against the 55 Hz minimum. The Mac was then observed on battery at 18%. An explicit
`--candidate-code` argument also still named V8; it was corrected before any candidate ran, and
the replacement command asserts that each native code directory belongs to its declared build.
The rejected attempt is retained in `paired-v9`; no performance claim follows from it. After power reconnection, `paired-v9-qualified` produced a valid baseline but rejected V9 at initial
decor construction. Its road lookup exhausted the new finite query-work budget; the 256-face
intersection limit was no longer the blocker. See the
[headed-testing audit](station3d-headed-testing-audit-2026-09-15.md). This parking detail repair does
not complete the later lane/zebra/near-detail milestone. Device work remains last.


The retained diagnostic browser supplied six published road parts for a narrow parking query.
Headless replay visits 4,340 records to return 108 faces: most work rejects remote triangles inside
50 m buckets. V10 adds a compact Float64 bounds tree to dense triangle buckets, prepared with the
existing private road support index before publication. Small buckets remain direct scans. The tree
uses at most 16 additional bytes per cell-triangle entry and copies no position buffers; point
support still reads the same authoritative triangles. Traversal yields cooperative checkpoints and
remains subject to the finite query budget. No geometry or capacity is enlarged.

The captured query now visits **224 records (94.8% fewer)** and returns the exact same 108 faces.
The regression also compares cell-boundary queries with an independent full-triangle scan and
checks deduplication and capacity rejection. A one-process diagnostic records 100 queries at
5.52 ms versus 74.72 ms; this is an algorithm check, not a whole-engine performance claim.
The explicit 22-file batch passes **157/157**, exit 0, in 2.29 seconds. V10 compilation emits
36 JavaScript files / 7,413,531 bytes. Its final scope contains 51 paths (including the reusable comparison harness); the frozen website fingerprint is:
`641efb3e792ace97199460f6e55b6970206a0f616f7d4b79a999ffa22e48a716`.

`paired-v10-qualified` checks startup, actual movement, stationary cadence, resources and complete drain
using the sealed source cassette and a single retained Chrome server. Each side gets a fresh
context; closing one capture no longer launches another browser. Failed startup captures now
retain their runtime cause and can keep the diagnostic page open for inspection. The V9 failed
page was closed after extraction; the same Chrome process then accepted the V10 comparison.
The first `paired-v10` attempt lost its browser during baseline drain and never ran the candidate.
The resumed pair declares candidate-first ordering so a candidate construction failure cannot waste
another baseline run; six focused harness checks pass. V8's affected-scene visual evidence is retained.
The first valid pair passes movement: candidate mean/p95 is 26.405/34.2 ms versus baseline
26.561/41.6 ms, with 40 versus 56 intervals over 50 ms. Stationary mean/p95 is 27.601/34.2 ms
versus 25.217/33.4 ms, but long intervals are 13 versus 5. Both worlds fully drain with no errors
(candidate 109.536 s, baseline 76.887 s). This is not yet a release qualification. One declared
reverse-order pair (`paired-v10-confirmation`) uses the same code/data and retained Chrome;
all four captures will be reviewed, including the first stationary-tail difference. The recorded
review plan excludes repeated unchanged runs selected for a passing outcome.


The declared reverse-order comparison is complete. Both receipts are valid and their inputs remain
unchanged. All four captures are retained; no further unchanged rerun is planned.

| Across both orders | Baseline | V10 candidate |
|---|---:|---:|
| Moving mean / p95 | 26.077 / 34.3 ms | 26.501 / 34.2 ms |
| Moving intervals >50 ms | 81 | 75 |
| Stationary mean / p95 | 25.148 / 33.3 ms | 27.136 / 34.1 ms |
| Stationary intervals >50 ms | 17 | 24 |
| Complete post-timing drain, each run | 76.887 / 69.062 s | 109.536 / 105.379 s |

Movement mean changes +1.6%, stationary mean +7.9%, and p95 stays within 10%. The pooled stationary
long-interval count exceeds its 18.7 limit; **the appearance batch is held**. The new projection
finishes without capacity failures and all seven decor producers publish, but construction cost
needs further work. No new recurring >50 ms main-thread phase is identified in these timed traces.
The lifetime `greenery:paint-publication` step maximum can include a `deferFrame` wait because that
branch does not reset its step clock; it is not sufficient evidence of a 72 ms CPU operation.

Initial building-resource category peak sums change +2.10% and −3.01%. A read after timing measures
8,312,320 additional bytes of road bounds trees in the published 1 km anchor neighbourhood; adding
that amount to the first candidate's category sum gives +3.17%. These are scoped estimates and a
live index allocation, not a whole-process simultaneous memory peak. Paint texture allocation
remains 16,777,216 bytes.

The already verified physical underpass boundary correction is deployed separately as `08e9e294`
(engine correction `6d78916f`); see the [underpass release record](station3d-underpass-ground-release-2026-09-15.md).
Its four runtime files exactly match the retained V8 native physical coverage evidence. The appearance
migration and its dense-query index stay uncommitted while their construction/performance issue is addressed.

Evidence is retained under `output/ground-appearance-release-20260915/`: `baseline-scenes-v1`,
`scenes-v1`, rejected `scenes-v2`, `savska-diagnosis`, `cut-diagnosis`, `alignment-diagnosis`, versioned build fingerprints and focused test
logs. Native private-camera views are diagnostic views of the loaded production scene; they do not
replace walking-height or movement acceptance. V8 is rejected for release by the movement failure.
