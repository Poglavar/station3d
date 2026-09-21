# Ground land-use migration — 16 September 2026

State: **deployed as `fe976f3538d707c60547792dbc81675474f2ec05`** on 16 September 2026.
Native performance and visual checks pass, and the served production bundles match the qualified
candidate. This completes delivery-tracker step 5 (technical-plan step 6) for this bounded increment.
Feature checkpoint `47a51b3b` remains on `ground-landuse-candidate-v3`.

Ordinary grass, parks, forests, paving, flowerbeds, sand, playgrounds and fitness surfaces now
publish immutable colour records through the existing ground compositor. The source polygons,
holes, same-level eligibility, category priority and transaction lifecycle remain explicit.
Paint does not add support, cut terrain or create a second height mesh. Trees and flowers retain
their source polygons and their existing separate construction. Water, shore geometry, fountains,
raised/grade-separated surfaces and structural terrain collars retain their physical paths.

Decorative land-use edging becomes bounded 14 cm coverage bands with the existing clamped miter.
It includes hole boundaries, uses the shared concrete pattern at stable world coordinates, and
removes independent terrain sampling and technical height staggering. The former per-ring 0.8 m
slab-joint UV layout is replaced by world-oriented stone grain; narrow-detail quality is checked
in the candidate view and the broader marking/detail acceptance remains delivery step 6.
Pedestrian-road edging and structural seam sealing remain with their respective producers.

The separate 1024² terrain-land-use canvas/texture, classifier and shader lookup are removed.
Generic urban ground and field patchwork remain base effects; explicit paint overrides them on
eligible receivers. Rail earthwork accepts only passive land-use recipes, preserving its former
land-use colouring without accepting road/parking paint or parking-detail support. Shader and
inspection eligibility use the same material policy.

The shared immutable pattern library grows from four to six 1024² RGBA layers: grass and soil
are added; paving, sport surfaces and edging reuse concrete. This adds 8 MiB retained CPU array
storage and approximately 10.67 MiB GPU storage including mips. Each old active land-use mask
used 4 MiB texture storage plus its canvas; a replacement held another mask. No new coverage
attachment or per-page pattern copy is introduced. Actual category peaks remain a native check.

Inspector category toggles enqueue a cooperative greenery colour update. A visibility revision
rejects stale preparation before publication. Empty metadata nodes keep the controls available;
retirement releases their visibility references, and session end removes the subscription.

## Evidence

- 117 grouped headless checks passed, followed by two production-adapter checks and one retained
  88-hole polygon packet check (120 distinct checks total). The adapter test fails on a colour-path
  height sample and verifies that hiding forest colour preserves vegetation source polygons.
- The retained holed paving fixture triangulates to its independently calculated outer-minus-hole
  area. Edging queries verify coverage inside, and absence outside, the 14 cm band.
- Root's per-response source replay adds 1,579 land-use/edging records at the saved Zagreb start,
  conservatively totaling 3,708 with V15's 2,129 retained records, below the unchanged 4,096 limit.
  Its largest decor bucket has 138 records / 5,786 vertices, below 2,048 / 131,072. The eight nearby
  response windows are assessed separately, not incorrectly unioned as one live decor window.
  Other routes have different road membership; this estimate does not replace runtime admission.
- Source/capacity evidence: `output/ground-landuse-release-20260916/capacity-replay-root.json` and
  its script. Earlier helper capacity reports are rejected and are not acceptance evidence.
- Native reference: the saved V15 candidate capture in
  `output/ground-appearance-release-20260915/candidate-v15-20260916/`. Its exact production identity
  is established by the existing V15 public/server bundle proof. No new production capture is needed.

The first native attempt is rejected: its walk missed a waypoint, and scope review found three
concurrent Split curb/road edits in the frozen input. Those files and their tests remain untouched
in the shared workspace and are excluded from the corrected V2 candidate. The retained failed
page subsequently reported an overloaded host, no ground/paint failures and fully drained ground
and paint; this is diagnostic evidence, not a valid performance comparison. The failure artifacts
remain in `output/ground-landuse-release-20260916/`.

V2 contains only the 29-path land-use scope, built from `3ed0bcfb`, with fingerprint
`6f38a66f30ff81b1f5a44dff414abec438f06a4326a1b3a93d47dbbd0d5f5a8b`.
Its 36 JavaScript outputs total 7,418,667 bytes. The corrected movement/stationary capture reuses
the saved reference, sealed V14 source data and the same Chrome. Brief 50–100 ms hitches
remain descriptive under the user's release direction; larger pauses and all raw frames remain
reported. Full-plan acceptance and campaign regeneration remain later steps.

V2 completed all 40 measured movement legs and the 60-second stationary phase with compatible
inputs, no console errors, 3,708 paint records and no failed or pending ground/paint work. Initial
resource category peaks sum to 1.27% above V15. Moving mean is 25.98 versus 25.80 ms; stationary
mean/p95 improve to 25.76/33.50 versus 27.00/34.19 ms. Moving p95 is 41.60 versus 35.10 ms (+18.5%),
so V2 is held under the existing 10% criterion. Both runs have 12 moving intervals over 100 ms;
V2's largest is 824.8 ms, with actor/support work dominating the corresponding framework frame.
Stationary intervals over 100 ms fall from seven to three. This does not resolve the larger
actor-update pauses.

The same capture exposed 12 pattern uploads for six immutable images. Ready slots were forgotten
whenever the final page lease released, although the full CPU/GPU array stayed allocated. The
correction retains those ready slots within the existing six-layer allocation, reuses them across
temporary ownership gaps, and evicts only unused identities absent from the complete incoming
request. Partial cancelled preparations are discarded; session disposal releases every resident
slot. Four added lifecycle regressions pass in a 33-check focused pattern/cache/material batch
(124 distinct checks across this increment).

V3 is the final code candidate, fingerprint
`daa5bb4b535dadd10e258497d6f44d9ee20ebe21eeb8d83372896a676a151204`, with 36 JavaScript outputs /
7,418,834 bytes. Its retained runtime confirms six uploads and six resident slots after repeated
publication, with no paint errors. Its first timing attempt is invalid: the host probe reported a
10.5× slowdown, and the walk stopped after exceeding the waypoint tolerance (5.75 m versus 5 m).
The failure and retained raw cadence/diagnostics are preserved. No application error was recorded.
Other active automation sessions were `fix`, `audit` and `shore`; this establishes concurrent
work, not a proof of which process caused the slowdown. Browser-reap closed the owned Chrome at
02:25:11 local time as `aged-out` after 30 minutes, after diagnostics were saved.

The next attempt on 16 September was stopped by external browser cleanup before movement began.
The reaper logged the browser's age as four minutes, below its loaded 30-minute age limit.
Its log labels forced global cleanup as `aged-out` too, so it cannot identify whether `--all`
or session-end cleanup triggered the shutdown. No application error preceded it; the failure
artifact is retained as an interrupted attempt, not performance evidence.

## Final V3 qualification

The candidate-only capture completed with the other test browsers closed. It reused the exact V3
build and saved V15 reference, sealed V14 responses, the same 40 movement legs and 60-second
stationary phase. Code hashes before/after and fixture provenance match; both phases are valid.
All raw intervals remain included. Clean-host coverage is 96.2% moving and 98.3% stationary
(reference: 90.9% and 96.6%). Both runs start with 1,118 buildings and finish with 1,359.

| Measurement | Saved production V15 | Final V3 |
|---|---:|---:|
| Moving mean / p95 | 25.80 / 35.10 ms | 24.90 / 33.80 ms |
| Moving intervals over 100 ms / maximum | 12 / 506.8 ms | 7 / 285.3 ms |
| Stationary mean / p95 | 27.00 / 34.19 ms | 25.01 / 33.30 ms |
| Stationary intervals over 100 ms / maximum | 7 / 510.0 ms | 4 / 215.7 ms |
| Loading hold | 64.48 s | 62.91 s |
| Final ground drain after stationary phase | 2.12 s | 2.08 s |
| Immutable pattern uploads | 4 for four images | 6 for six images |

Initial resource category peaks sum to 2.51% above the reference, within the 5% limit. This is
a sum of per-category peaks, not a simultaneous process-memory measurement. All ground/paint
queues drain, with zero failed generations, zero paint failures and no console errors. All
mean/p95 comparisons pass the existing 10% limit. Larger pauses remain visible: the worst
moving framework frame combines rendering, stall time and tile decoding; other retained frames
include pedestrian and point-support work. This increment does not claim to fix those systems.

Evidence: `candidate-v3-qualification.json`, `v3-qualification-review.json` and
`command-v3-qualification.json` under `output/ground-landuse-release-20260916/`.
The final street and lawn views were inspected in the same Chrome session. The real inspector
category change hides and restores lawn colour; the selected physical ground height remains
exactly unchanged, with no paint failures or page errors and still only six pattern uploads.
The settled restored view preserves the lawn boundary and surrounding paving. The visual script
initially assumed a nonexistent record-bounds field, then needed to open the inspector before
its controls populated; these were corrected in the check script without changing engine code
or repeating performance. Final evidence is `v3-visual.json`, `v3-landuse-visible.png`,
`v3-landuse-hidden.png` and `v3-landuse-restored-settled.png`. The owned Chrome is closed.

Release decision: **qualified and deployed for this bounded land-use increment**. Commit
`fe976f3538d707c60547792dbc81675474f2ec05` is pushed to `main` and served in production.
The server checkout is clean, Cloudflare purge succeeded, and public deployment checks pass.
All 36 emitted JavaScript modules and 136 import edges match the qualified V3 build after the
explicit mapping of 20 generated filenames. Every public module matches the server bytes exactly;
the public readback uses normal URLs without a cache-busting query. Total JavaScript is 7,418,834
bytes. This verifies the deployed artifact, rather than relying on the deploy command's status.

Release evidence is in `output/ground-landuse-release-20260916/deployment/`:
`deployment-receipt.json`, `v3-bundle-graph-proof-fe976f35.json` and
`v3-release-readback-fe976f35.json`. Owned browsers and candidate servers are closed;
the clean candidate/deployment checkouts are retained. The wider plan and its final scenario
matrix, near-detail migration and campaign regeneration remain separate work.
