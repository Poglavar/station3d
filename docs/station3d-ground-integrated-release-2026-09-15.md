# First integrated Station3D ground release — 15 September 2026

Status: **deployed**. Ground engine: `3c61a2486c16406aabf10243f21e78c754b3f63e`;
publication repair: `5035de3efc5dda554c50046c8c11d6e40fcb972f`.
This record covers the first receiver-paving and shared-ground increment. The
[delivery tracker](station3d-ground-delivery-tracker.md) lists subsequent work; the
[ground hierarchy plan](station3d-ground-hierarchy-2026-09-11.md) retains the full contract.

## Result and scope

Paving paints its physical receiver instead of adding a competing draped colour surface. Terrain,
roads, rail formations, curbs, openings and physical support publish as coordinated generations in
the shared engine. Unchanged surveyed building tiles can retain their geometry, while buildings
whose actual foundation evidence changes are replaced. Loading construction uses the existing
curtain-time allowance and waits for the first ground publication before constructing buildings.

The increment also repairs the Trogir–Split terrain failure: changed camera windows can recover from
a failed generation, shared clipping rings count once within the existing vertex budget, and Float32
cut boundaries stabilize within the existing four-operation/1 mm limits. The supplied project 64
start and a 911 m forward approach pass; the entire journey has not been verified. Nested shelter
geometry now retires on close, eviction, replacement and mask removal without disposing borrowed
geometry or separately owned materials.

Road, cycle-surface, parking, construction, land-use, marking and rail **appearance** migrations
remain subsequent increments. Their physical adapters already participate in shared publication.
Campaign terrain/drawing bakes remain downstream outputs to regenerate after engine completion.

## Final performance comparison

Three interleaved, adjacent production/candidate pairs ran on 15 September against production
`592859b62376f516c80f7b8e611b72f28e0449ff`. All six captures are valid and all three pairs comparable;
code and sealed data stayed unchanged. All timed CPU-contention samples were clean (47–50 per
capture); native Chrome used the actual GPU with approximately 120.5 Hz display preflight.

Inputs: `/sloboda/@45.809025,15.9739/`, GTA car, heading 268.3°, terrain on, noon, high quality,
1600×1000 viewport, telemetry off. Each run starts after the same 1,118 buildings are fully built,
uses the same 52-second forward/brake control sequence, then measures 30 seconds stationary.
Traffic and resulting trajectories vary; final poses/building counts are not identical. Audit overlays,
readback and CPU profiling are off during timing. Whole-frame intervals include all work;
`renderer.render()` timing is CPU submission time, not a direct GPU timer.

All figures below are milliseconds; arrows run from production to candidate.

| Pair | Moving mean | Moving p95 | Moving intervals >50 ms | Stationary mean | Stationary p95 | Stationary intervals >50 ms |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 33.91 → 23.59 | 65.90 → 26.60 | 242 → 10 | 27.92 → 24.34 | 42.00 → 26.50 | 13 → 3 |
| 2 | 35.60 → 23.66 | 66.60 → 26.50 | 275 → 11 | 24.71 → 23.55 | 33.20 → 26.30 | 4 → 3 |
| 3 | 31.30 → 23.63 | 58.00 → 26.60 | 164 → 8 | 25.81 → 26.93 | 40.90 → 34.30 | 10 → 9 |

Every pair individually passes the existing 10% mean/p95 and
`max(baseline × 1.10, baseline + 1)` stutter limits. Moving mean improves 24.5–33.5%, p95 improves
54.1–60.2%, and moving intervals over 50 ms total 29 versus 681. Pair 3 stationary mean is 4.34%
higher, within the limit. No threshold was relaxed and no completed capture was excluded or retried
to obtain a better outcome.

The fully built starting point occurs at page time 54.6–54.7 s for the candidate versus 151.7–155.2 s
for production. This measures equal initial coverage. Earlier loading-curtain ready signals use
different completion thresholds and must not be substituted for this comparison.

Median moving draw calls are 1,350 / 1,369 / 1,483.5 versus 1,274 / 1,210 / 1,122.5; median triangle
counts are 3.33 / 3.34 / 3.45 million versus 3.48 / 3.33 / 3.04 million. This release does not claim
draw-call reduction. Future appearance migrations must earn their own performance result.

## Resource and completion checks

At equivalent initial coverage, conservative sums of source-façade, atlas and geometry peaks,
including the new ground-dependency cache, change by **−0.49%, +2.69%, +3.37%**. All pass the +5%
unrelated-resource limit. These are sums of category peaks, not simultaneous memory measurements.
Candidate sums are 760,971,090 / 765,449,237 / 776,827,253 bytes. Final counts are not used for this
comparison because the candidate's extra drain period reaches different world coverage.

Retained paint allocation records show a 16,777,216-byte four-layer target, 49,152-byte material table,
and pattern textures using 22,369,616 GPU bytes including all mips. Their enumerated GPU total is
39,195,984 bytes within the separately accepted approximately 100 MB compositor allowance. Pattern
CPU backing uses 16,777,216 bytes with zero retained staging bytes. Base texture bytes are not added
again to the full-mip figure. Five complete identical-route reopen cycles return all measured scene,
renderer, shader-program, listener, timer and ground-owner resources to their warmed baseline;
every closed resource delta is zero, with no source/page errors or context loss.

The candidate publishes 5 / 6 / 4 ground generations, with zero failures, rejections or final pending
work. Ground and building queues fully drain. Additional drain after the measured 30-second stationary
phase is 36.478 / 109.145 / 11.113 s: approximately **66.5 / 139.1 / 41.1 s after driving stops**.
The tail is substantial and remains targeted latency work. These runs establish finite completion
and progress during movement, not prompt completion everywhere.

## Tail review and qualification decision

Candidate pair 3 includes one **300.3 ms stationary frame interval** (304.8 ms in the separate app
frame clock). It stays in all statistics. Attribution records 14.0 ms of hooks, 142.8 ms in render
submission and 147.9 ms outside/stall time; the latter labels include 91 ms of bench work and 25 ms
of window-update work. The bench implementation is unchanged from production. Candidate bench
maxima across the three runs are 5 / 5 / 91 ms, versus 18 / 15 / 22 ms on production. Render items
over 50 ms occur in both versions. No new recurring >50 ms item was established in these captures.

System memory compression/reactivation rises sharply around the outlier despite clean CPU-contention
samples. This is context, not proof of an external cause; the spike's cause remains unresolved.
The existing gate prohibits a new recurring long item or sustained regression. The isolated spike
was investigated, all per-pair numerical gates still pass with it included, queues drain and resource
ownership closes cleanly. The bounded increment is therefore **qualified for release**, with the spike
and long completion tails retained as follow-up work. Full-plan acceptance is still open.

## Correctness and visual evidence

The isolated full headless sweep passes 5,013 of 5,014 checks. Its sole failure is a foreign test
change asserting excluded map CSS; restoring that test to the production version makes all seven
tests in that file pass. The foreign CSS and root test edits remain untouched and outside the release.
Stale assertions were updated to the current contracts. Focused old-code negative checks fail for
the repaired road readiness, optional-landmark dependency and nested-geometry retirement defects.
Production compilation succeeds (36 JavaScript outputs, 7,388,745 bytes).

Jelačić, the embankment and Kružićeva settle with zero missing-paint, void, duplicate or floating-ground
samples in their recorded 14,400-point grids. Actual published-receiver GPU proof covers 4,045 paint
pixels and 51 hole samples; deliberately removing paint fails the paint assertions. The corrected
Donja Lomnica overpass settles. Its 124 historical audit "void" classifications hit terrain collars or
retaining walls excluded by that audit role, rather than missing rendered terrain; they are not direct
Rapier support tests. Existing road/parking/marking conflicts remain later migration work.

The three Zagreb scene captures precede the optional-landmark missing-evidence fix; none entered
that failing branch. The overpass capture includes that fix. Both precede the nested retirement and
loading-label fixes, which do not change those retained scene surfaces. They are scope-qualified
visual evidence, not captures claimed to share the final global fingerprint. Final performance and
lifecycle captures use the exact frozen candidate. Wider routes/modes, night/detail checks, regenerated
campaign packs, final terrain defaults and the final device check remain in the full plan.

## Reproducibility and publication

- Frozen website fingerprint: `e6d94720612ec1aab0f33fb329691f042df158bcb77d6e0b1949e90910496f5b`.
- Locally tested built entry SHA-256: `f1b58b1f0459d653f2438dbb66004448f0f19ca7e8f1bb84cb19a86390804cd9`.
- Sealed input cassette v14: 9,716 complete responses; manifest hash `fbb8f8c957041498f5115f0af6172f65ffd0d6ecf9373cad4a1d154f46ed6e40`.
- [Final paired evidence and decision](../output/surface-audit/ground-implementation/ground-release-paired-v1-20260915/README.md), with raw captures, native host samples and the unchanged-input receipt.
- [Five-cycle lifecycle evidence](../output/surface-audit/ground-implementation/ground-release-package-20260915/lifecycle-v7-README.md) and [old/new geometry ownership checks](../output/surface-audit/ground-implementation/ground-release-package-20260915/building-geometry-README.md).
- [Trogir–Split repair evidence](../output/terrain-train-project64-repair-20260915/README.md); production entrypoint is [project 64](https://zagreb.lol/prijevoz/transit.html?project=64&st3d=planner-cab&line=1&offset=11390&dir=1).

The large raw `output/` artifacts are local evidence and are not deployment assets. The release
excludes unrelated map CSS, its dependent test change, import/data scripts and local secrets.

### Deployment defect found and repaired

The initial publication's global `?v=` cache-version replacement also matched executable minified
JavaScript: `v===null?v=I:...` became `v===null?v=3c61a24:...`, an invalid numeric token. One public
chunk was corrupted. Artifact comparison found the difference; content-type and HTTP 200 checks alone
had passed. The valid chunk was atomically restored from the server's clean build, Cloudflare was
purged, and the repaired public ES module matched the clean bytes and passed syntax checking.

Commit `5035de3e` replaces the global rewrite with HTML parsing that changes only version parameters
in `src`/`href` attributes. It preserves emitted JavaScript, inline script/style bodies, raw text,
comments, entities and quoting. Four focused tests pass, including the exact offending expression;
all 21 tracked HTML pages parse, and repeated stamping is idempotent. The captured corrupt public
artifact independently fails ES-module parsing with `SyntaxError: Invalid or unexpected token`.
This deployment repair changes no engine code and does not require repeating its native performance runs.

Local and server builds use different generated chunk filenames. Verification therefore compares
the complete emitted code and import graph, and separately checks public bytes against the server
build, rather than treating an entry hash or equal bundle size as sufficient. Deployment and repair
receipts are retained in the local release evidence directory.

**Final publication verification passes:** all 36 emitted JavaScript files (7,388,745 bytes), all
136 manifest import edges and the three additional Draco JavaScript files are accounted for. An
explicit bijection of 20 generated filenames reproduces every server file byte for byte from the
tested local code; stable entries, code and import positions remain intact. Every canonical public
JavaScript file matches the server build, all 39 files pass ES-module syntax checking, and the formerly
corrupt chunk also matches at its normal URL without a verification query. The public entry SHA-256 is
`f0be0e2f0d1be60a80eae0934e47a949128f2e8e1ae90a9b39f7b91259e804b1`.
See the [exact code/import proof](../output/surface-audit/ground-implementation/ground-release-package-20260915/publication-final/exact-graph-proof.json)
and [public/syntax receipt](../output/surface-audit/ground-implementation/ground-release-package-20260915/publication-final/release-verification-receipt.json).
