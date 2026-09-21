# Station3D headed-testing audit — 15 September 2026

The ground-work session launched **59 headed browsers across 51 test invocations** today, from
midnight through the appearance V8 comparison (last scene open at 16:31, Europe/Paris). This
includes failed starts. It excludes unrelated sessions, headless tests, CDP attachments, individual
Chrome renderer/GPU processes and reopening a world inside the same browser. The 37 overnight
launches and 22 later launches have separate command/run receipts. A bounded check of delegated
session records found no additional launches beyond these inventories.

## Assessment

The amount of browser-driven iteration was excessive. Some checks found significant defects, but
that does not justify constructing the whole world again for each small diagnostic or repair.
Reusing an already loaded scene for several observations saves more than merely leaving Chrome
open while reloading the scene every time. Batch implementation and headless verification first.

| Work | Browser launches | Assessment of the approach |
|---|---:|---|
| Standalone loading, movement and allocation/profile iterations | 20 | Release timing and targeted profiling are useful; too many small changes went through full world reconstruction. Profile and investigate within a shared diagnostic session, then qualify the coherent batch. |
| Automated baseline/candidate performance comparisons | 12 | Four invocations: three pairs for the integrated release, then one pair each for coastal V4, coastal V5 and appearance V8. The runner launches a fresh process for every capture. Six separate pairs are not six independent features. Start with one pair per coherent candidate and expand for a failure, changed code or an inconclusive result. |
| Surface/appearance scene checks | 14 | Four release scene batches and ten appearance/diagnostic batches. Multiple poses already share one browser within each invocation; repeated invocations do not. Several diagnostic rebuilds were avoidable. |
| Coastal streaming checks | 6 | The regression requires travel coverage. One attempt used the wrong project/chainage; another stopped on the historical failure counter instead of allowing recovery. Those were avoidable setup/harness iterations. Later runs exposed actual recovery defects and verified the repaired build. |
| Open/close lifecycle checks | 7 | Each invocation already reuses one browser for all world-open/close cycles. Seven separate invocations reflect a mixture of failed attempts, diagnostics and fixes. They should have been consolidated around one diagnostic session and final qualification. |
| **Total** | **59** | **The full count was not necessary.** |

Concrete waste: Savska diagnosis, cut diagnosis and alignment diagnosis launched three browsers
at 11:27, 11:37 and 11:47. Those related observations could have been collected in one loaded
scene, avoiding at least two launches and two complete scene constructions. The wrong-route
coastal attempt at 13:15 was also avoidable. The loading candidate at 02:32 really launched a
browser but failed during display preflight before opening the application; it contributes to
the launch count, not successful coverage. The first complete-start baseline failed on the test's
paused-controller ordering and was rerun after correcting that sequence.

There is no evidence-based exact counterfactual number of launches that would have been sufficient.
Calling every failed capture unnecessary would conceal real bugs; calling every bug-finding capture
necessary would excuse inefficient debugging. The clearly avoidable examples above are a lower
bound, not a claim that the rest were all required.

## Why browsers were restarted

At the audited checkpoint, `tools/perf-trace.mjs` created Chrome and closed it in its final cleanup.
`tools/perf-paired.mjs` spawned a separate trace process for each baseline/candidate slot, so those
captures could not reuse Chrome. `tools/surface-audit-probe.mjs` keeps one persistent browser context across
poses, then closes it at the end of the invocation. `tools/perf-lifecycle.mjs` launches once before
its reopen loop. The counts above follow these actual lifetime boundaries.

The repository's instruction to close browsers when finished does not require closing between
related checks in an active batch. The overly narrow invocation boundaries were a workflow and
harness choice. No engine rule requires them.

Several correctness observations can share the same live world: support, visible surfaces,
marking height, openings, producer completion and screenshots. Different scenes can run
sequentially in the same browser. Baseline and candidate performance can also be measured
sequentially with controlled code/data, separate contexts where appropriate, equal warm-up and
one active 3D world. Context isolation alone does not reset browser-wide GPU/shader caches or
process memory. Fresh processes remain appropriate when measuring cold startup or process memory,
when launch flags change, or after a browser fault. Simultaneous 3D worlds compete for resources
and should not be used for acceptance timing.

## Workflow from this checkpoint

1. Batch related engine edits and run an explicit, nonempty list of relevant headless tests.
2. Reuse one diagnostic browser and loaded scene for related correctness observations. Visit other
   affected scenes sequentially. Close the browser when the batch ends; leave no idle 3D worlds.
3. On a failure, capture the necessary input/state once and move the repair/replay headlessly
   wherever possible. Do not launch another full browser for each additional property to inspect.
4. Run one baseline/candidate movement pair when a coherent release candidate is ready. Expand
   only when a failure, changed implementation or uncertain result calls for it. Keep profiling
   overhead outside the acceptance timing interval.
5. State the particular need for a fresh process before choosing one. Use an owned browser server
   for related captures, with fresh contexts and one active 3D world. Keep cold-process measurements
   separate when that is the quantity being measured.

No browser was launched for this audit. The appearance V8 pair finished with a receiver-candidate
capacity failure after streaming; it is not released. Its next repair is a headless reproduction,
not another headed diagnostic. The coastal recovery remains deployed as `1f5ffa24`.

A separate mistake launched three broad headless Node test runs from an empty test-file selection.
Those runs were stopped and excluded from verification. They do not add to the 59 headed launches,
but they did create resource contention and delay the V8 scene check. The corrected explicit
22-file run passed 154 tests. See the appearance checkpoint and `invalid-test-run-receipt.json`.

## Implemented reuse after the audit

The trace harness now accepts `--browser-ws` and disconnects its client at capture completion,
leaving the explicitly owned browser server alive. The paired manifest passes the same endpoint
to both captures. `--keep-browser-on-failure` also saves the runtime cause and retains the failed
page until explicitly closed, allowing several observations and fixture extraction without another
world construction. These options are opt-in; ordinary standalone captures retain their cleanup.

The V9 diagnostic captured the road-query failure and its published geometry in one loaded scene.
The failed page was then closed, its capture exited, and the same Chrome process accepted the V10
baseline/candidate comparison. The source/geometry repair and 157 scoped tests ran headlessly.
The original 59-launch tally above ends at 16:31 Paris and is not a claim about the later day's total.

## Launch ledger

Times below are Europe/Paris. Most are the first in-browser log, shortly after process creation;
`*` means the launch-command time is used. Each row is one browser lifetime. The allocation
profile at 04:05 is proved by contemporaneous transcript output/process inspection because its
log was overwritten by the next attempt. The paired rows are separate browsers, not tabs.

| # | Time | Work | Purpose |
|---:|---|---|---|
| 1 | 00:03:15 | Standalone performance/profiling | Complete-start baseline: paused-controller timeout |
| 2 | 00:13:31 | Standalone performance/profiling | Complete-start candidate |
| 3 | 00:20:13 | Standalone performance/profiling | Complete-start baseline rerun |
| 4 | 00:32:39 | Standalone performance/profiling | Building-drain candidate |
| 5 | 00:43:23 | Standalone performance/profiling | Roof-query candidate |
| 6 | 00:53:09 | Standalone performance/profiling | Resource-bound candidate |
| 7 | 02:16:13 | Standalone performance/profiling | Loading-release baseline |
| 8 | 02:21:53 | Standalone performance/profiling | Loading-release candidate 1 |
| 9 | 02:32:00* | Standalone performance/profiling | Loading candidate 2: browser closed in preflight |
| 10 | 02:34:31 | Standalone performance/profiling | Loading candidate 2 rerun |
| 11 | 03:19:05 | Standalone performance/profiling | Owner-budget movement diagnostic |
| 12 | 03:24:17 | Standalone performance/profiling | Owner-budget CPU profile |
| 13 | 04:05:22 | Standalone performance/profiling | Allocation profile, first attempt |
| 14 | 04:09:44 | Standalone performance/profiling | Allocation profile, second attempt |
| 15 | 04:28:43 | Standalone performance/profiling | Allocation-fix candidate |
| 16 | 04:38:24 | Standalone performance/profiling | Allocation microrelease candidate |
| 17 | 05:08:37 | Standalone performance/profiling | Building-reuse candidate |
| 18 | 05:22:21 | Standalone performance/profiling | Building-startup diagnostic |
| 19 | 05:37:26 | Standalone performance/profiling | Building-loading candidate |
| 20 | 05:43:15 | Standalone performance/profiling | Building-loading production baseline |
| 21 | 05:48:15* | Scene checks | Release scenes, first batch |
| 22 | 05:56:00* | Scene checks | Release scenes, replay |
| 23 | 06:11:12* | Scene checks | Release scenes, corrected batch |
| 24 | 06:20:59* | Lifecycle | Lifecycle v1 |
| 25 | 06:27:39* | Scene checks | Overpass follow-up |
| 26 | 06:29:12* | Lifecycle | Lifecycle v2 |
| 27 | 06:31:02* | Lifecycle | Lifecycle v3 |
| 28 | 06:36:54* | Lifecycle | Lifecycle geometry diagnostic |
| 29 | 06:51:11* | Lifecycle | Lifecycle v5 |
| 30 | 06:58:12* | Lifecycle | Lifecycle program diagnostic |
| 31 | 07:09:34* | Lifecycle | Lifecycle v7 |
| 32 | 07:16:17 | Performance pairs | Integrated-release performance pairs — baseline 1 |
| 33 | 07:20:24 | Performance pairs | Integrated-release performance pairs — candidate 1 |
| 34 | 07:23:26 | Performance pairs | Integrated-release performance pairs — baseline 2 |
| 35 | 07:27:31 | Performance pairs | Integrated-release performance pairs — candidate 2 |
| 36 | 07:31:45 | Performance pairs | Integrated-release performance pairs — baseline 3 |
| 37 | 07:35:48 | Performance pairs | Integrated-release performance pairs — candidate 3 |
| 38 | 11:01:43 | Scene checks | appearance-scenes |
| 39 | 11:06:27 | Scene checks | appearance-baseline-scenes |
| 40 | 11:13:43 | Scene checks | appearance-scenes-v2 |
| 41 | 11:27:31 | Scene checks | appearance-savska-diagnosis |
| 42 | 11:37:32 | Scene checks | appearance-cut-diagnosis |
| 43 | 11:47:39 | Scene checks | appearance-alignment-diagnosis |
| 44 | 12:07:58 | Scene checks | appearance-repaired-scenes-v5 |
| 45 | 12:13:55 | Scene checks | appearance-repaired-scenes-v6 |
| 46 | 12:39:36 | Scene checks | appearance-receiver-scenes-v7 |
| 47 | 13:15:48 | Coastal checks | coastal-native-v1 |
| 48 | 13:18:38 | Coastal checks | coastal-leg160-v1 |
| 49 | 13:25:47 | Coastal checks | coastal-leg160-v2 |
| 50 | 13:42:05 | Coastal checks | coastal-leg160-v3 |
| 51 | 15:02:20 | Coastal checks | coastal-leg160-v4 |
| 52 | 15:08:51 | Performance pairs | coastal-paired-v4 — baseline |
| 53 | 15:12:25 | Performance pairs | coastal-paired-v4 — candidate |
| 54 | 15:27:29 | Performance pairs | coastal-paired-v5 — baseline |
| 55 | 15:31:51 | Performance pairs | coastal-paired-v5 — candidate |
| 56 | 15:35:43 | Coastal checks | coastal-final-v5 |
| 57 | 16:21:52 | Scene checks | appearance-native-v8 |
| 58 | 16:28:29 | Performance pairs | appearance-paired-v8 — baseline |
| 59 | 16:31:37 | Performance pairs | appearance-paired-v8 — candidate |

The [machine-readable ledger](../output/ground-appearance-release-20260915/headed-launch-ledger-2026-09-15.json)
contains command IDs, source-log paths and timestamp provenance. Supporting inventories are
`today-overnight-executed-checks.json`, `today-overnight-check-evidence.json`,
`today-headed-job-inventory.json` and `today-later-browser-toolcalls.json` in that same directory.
The root transcript is session `01a091ba-f731-7643-9e0c-3da0ccdd09cf`; its filename starts on
11 September, but only records dated 15 September in Europe/Paris were counted. Owner birth
records and periodic reaper observations were not treated as launch records.
