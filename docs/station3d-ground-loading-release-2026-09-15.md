# Station3D world-construction release, 15 September 2026

Status: accepted for production release. The isolated package is based on `6d0d0812`.

This is an independently releasable part of the ground-engine work. It improves initial construction
and loading feedback on the existing production engine. The larger receiver/paving
compositor and the Kambelovac repair remain in the local coordinated-ground cutover.

## Changes

- Give construction a larger bounded allowance while the loading curtain blocks gameplay. Near
  construction can use 48 ms per frame during loading; the next interactive frame immediately
  resumes its ordinary budgets. An indivisible overrun is charged in full and prevents siblings
  from adding work to an exhausted allowance.
- Retire unused façade textures within both an entry limit and a time allowance. Active meshes
  and pending atlas paints keep their ownership pins. The existing 32 MiB idle allowance stays.
- Show measured progress of the current loading stage, concurrent task names, completed-task
  count, elapsed time and age of the last reported activity. Unknown work is indeterminate.
  The existing readiness and campaign-watchdog contracts are unchanged. English and Croatian
  strings are included.

There are no new dependencies, schema changes, physical-surface changes or campaign-bake changes.
The runtime patch covers the loading-only work allowance, resource cache, one cache-retirement
call in buildings, and loading presentation. Interactive scheduler logic and its budgets retain
production behavior. The remaining dirty ground-engine work is excluded.

## Verification

The isolated candidate is based on the exact production commit. All 105 distinct headless checks
pass across the loading, scheduling, resource ownership and import integration files. Tests for
loading overruns still exceed the enlarged allowance and confirm that the next interactive frame
returns to its ordinary budget. Production compilation emits 36 files / 6,937,605 bytes, with zero
warnings. The coordinated-ground modules are absent from this release's dependency graph.

The first attempted package also changed interactive scheduler admission. Its matched native check
improved ready time (13.920 s to 9.855 s) and startup source-façade cache peak (213.0 MB to 165.9 MB).
Movement mean/p95 remained within 10%, but the 30-second stationary phase after driving regressed
by 20.2%/35.9%. Both hosts were clean. The candidate constructed more scenery during that phase;
the different final poses and workloads do not isolate a single cause. This attempt was rejected.
Its interactive scheduler changes are excluded from the release, not accepted with a waived gate.

The completed native gate compares the narrowed candidate and the production source with the same sealed
v14 road/building data, paused fully constructed starting scene, car, controls, quality, viewport
and time of day. Startup, movement and stationary observations remain separate. Captures and
source verification are retained in `output/ground-loading-release-20260915/`.

| Observation | Production baseline | Accepted package |
|---|---:|---:|
| Loading hold cleared | 13.920 s | 10.784 s |
| Movement mean / p95 frame interval | 34.897 / 66.5 ms | 31.514 / 58.3 ms |
| Movement intervals over 50 ms | 253 | 176 |
| Post-movement stationary mean / p95 | 28.602 / 42.3 ms | 26.670 / 41.3 ms |
| Startup source-façade cache peak | 213.0 MB | 158.0 MB |
| Settled initial source-façade cache | 105.1 MB | 101.4 MB |

Both initial scenes contain 1,118 buildings; both captures have 47/47 clean timed host samples.
The loading hold's completion is the production readiness gate, not completion of all background
scenery. This single pair supports the limited release; it is not a general speedup guarantee.

The raw candidate capture retains one harness integrity flag because the queue **test** was corrected
while the browser started. The audit reproduces both recorded directory fingerprints by substituting
only the baseline/final `frame-chunk-queue.test.mjs`, with all other 1,531 file hashes identical.
No application source changed and every checked native response matched its source. This resolves
the flag without rerunning an unchanged browser case. No page, console or network errors were captured.
The raw result, exact fingerprint proof and reviewed gate decision are retained separately.

For this limited increment the gate is one compatible native comparison with no captured errors,
mean and p95 frame intervals within 10% in both movement and post-movement stationary phases,
no increase over 10% in movement intervals above 50 ms, and source-cache peak and settled bytes
within 5% of baseline. The stationary phase observes ongoing streaming, not a completely drained
final scene. This is not the multiscene, repeated-pair acceptance of the larger compositor.

This release does not complete the ground tracker's first paving cutover. Its remaining geometry,
full-scene performance and resource gates continue to apply to the coordinated-ground candidate.
