# Coastal ground streaming recovery

Status: deployed as `1f5ffa246f0d927959e45048bc196d824e2cdfc6`; remote/public readback is retained in `output/ground-coastal-recovery-20260915/deployment/release-readback.json`.

The deployed coordinated-ground increment (`3c61a248`, with deployment repair
`5035de3e`) admitted coastal receivers without preserving local geometry storage.
A coastal clipping error rejects the shared generation, so it can also stop new
terrain from publishing. This correction precedes the separate appearance batch.

## Findings and correction

1. **Water storage precision — confirmed.** Actual water-adapter regression tests
   failed with `ground-topology-precision` at translated centres 4096.321 m and
   16000.321 m. The topology guard permits 0.2 mm for the operand storage round,
   within its total 1 mm displacement allowance. At 4096 m, the largest single-axis
   Float32 rounding error rises to about 0.244 mm. This is a rounding-risk boundary,
   not a claim that every coordinate beyond 4096 m fails.
   Sea, coast infill and quay factories now subtract nearby origins **before**
   Float32 conversion. Placement, opening bounds/planes, geometry reuse and water
   UV phase carry those origins. The transformed-mesh clipping path already
   supports source-local storage; its `worldMatrix` path must not also receive an
   independent translation origin.
2. **Support must retain the same local storage.** Mesh support capture previously
   transformed local meshes back into scene-space Float32 arrays, imposing another
   distance-dependent precision limit. Shared captured surfaces now carry their
   origin; support queries and station openings use double-precision scene
   coordinates, and the existing physics-bubble converter rebases the local faces.
   This applies to shared engine receivers, including transformed/instanced
   structures. It does not introduce campaign-specific world rules.
3. **Expired terrain requests — confirmed.** A resident tile awaiting deferred
   eviction could also remain in the pending rebuild requests. The old scope then
   requested both rebuilding and removing the same tile, violating unique
   admission. Scope selection now prunes expired requests without waiting for
   finalization, retains pinned and current-window work, and rejects a stale
   selection without overwriting a newer queue. Admission remains strict and its
   capacity is applied to the resulting disjoint sets.
4. **Rail cleanup — confirmed.** An ordinary preparation bailout returns `false`.
   `prepared?.discard()` attempts to call `discard` on that boolean and skips
   subsequent owner release. Both callers now guard the actual candidate; the
   coordinated caller releases admission/read ownership in `finally`.
5. **Stationary source expiry — confirmed in the shared streamer.** A loaded tile
   that left the ahead corridor received 15 seconds of grace, but keeping it for
   that grace did not schedule another eviction pass. With an unchanged camera
   tile, it could remain indefinitely. A deadline now wakes eviction at the
   earliest expiry, through the existing bounded teardown path. Frames before
   expiry do not rescan the tile table, and active dependency retention still
   takes precedence. The actual stationary `ensureAround()` regression is red
   before the correction and green afterwards.
6. **Released dependencies must wake eviction — confirmed.** The next native
   continuation released the stale curb and graph tiles but still retained 18
   obsolete road-surface tiles. Live inspection found no remaining dependency,
   delivery hold, grace stamp or scheduled eviction. Curb admission had requested
   those road tiles after the earlier window eviction; releasing that request did
   not schedule cleanup. The shared ownership rule now applies at release too:
   dropping the last dependency schedules an eviction pass at the current window.
   A red-to-green regression covers two owners, no intervening camera movement,
   and exactly-once removal after the final owner releases. This preserves active
   consumers and does not loosen terrain-evidence requirements.
7. **Do not re-admit an eviction backlog — confirmed.** The first paired check
   exposed serial post-movement updates: the candidate published generations 3–8
   during drain, versus 3–4 in the baseline, and missed the 180-second completion
   limit. Generations 4–8 removed 131, 21, 62, 68 and 311 road owners. A focused
   scheduling test reproduced the mechanism: admission could hold obsolete curb
   tiles before their bounded eviction finished, requesting their old roads again.
   Source-window reconciliation is now an admission prerequisite. It uses the
   existing shared eviction budget and defers sealing until eligible removals have
   drained. Valid grace, pins and active dependencies retain their usual meaning.
   The scheduling/dependency batch passes 46 tests. The corrected paired check
   drains with two post-timing publications in 33.5 seconds, with no build failures.

All existing geometry tolerances, publication boundaries and generation capacity
limits remain in force. Local position arrays retain their Float32 representation;
the correction adds origins, not a second full set of Float64 geometry buffers.

The session's geographic anchor and a mesh's storage origin serve different
purposes. The anchor is a stable latitude/longitude reference for scene metres;
the streamed window follows the observer, and mesh storage uses nearby origins.
GTA physics separately rebases its active bubble. The existing shared render-origin
implementation translates the scene root and camera only during rendering, then
restores CPU coordinates; its capability is currently enabled by the GTA preset,
not the planner-cab scene used here. It follows the physics origin while driving,
or rebases at a 2 km threshold otherwise. Generalizing that capability belongs in
the broader engine-defaults review. It cannot correct coordinates already rounded
incorrectly during CPU geometry preparation. Moving the geographic anchor is not
required for these corrections.

## Verification

- Initial headless receipts reproduce both the water precision failure and leaked
  rail terrain reads. The initial broader correction passed 174 relevant tests;
  the current isolated release subset passes **101 tests across its 11 test files**.
- Water tests cover 4.096 km, 16 km and ±100 km offsets, local GPU arrays, world UVs,
  exact authored/earthwork openings, neighbouring retained coast, CPU support,
  actual Three mesh intersections, and Rapier collision through the production
  physics converter. Cache reuse includes origins. These are geometry/contract
  tests, not proof of an entire country-wide runtime journey.
- Terrain tests execute both the pure scope selector and the actual world adapter,
  including a moved window without successful finalization and cancellation
  during cooperative selection. Existing publication/rollback tests also pass.
- The shared-streamer batch passes **39 tests**, including grace expiry while
  stationary, exactly-once eviction, no scan before expiry, and retained
  dependencies surviving until their owner releases them.
- Isolated candidate V5: base `eb65a388`, 26 scoped paths, website fingerprint
  `4a00a4d352e134fe64696ac582b54ec1b94fce08ebfb3ec582401e23ad851acf`.
  Build: 36 JavaScript files / 7,392,165 bytes. No appearance or unrelated edits
  are included.

Receipts are in [the coastal recovery directory](../output/ground-coastal-recovery-20260915/).

The initial native check identified the route numbering: Project 64 has an
11,422.284 m line joining Project 160 at Kaštel Kambelovac (Project 160 chainage
34,280.817 m). The diagnosis's 36–41 km chainages refer to that onward leg. Opening
Project 64 with those offsets clamps at its endpoint and is not a long-distance
reproduction. That attempt is retained explicitly as an invalid continuation.

The Project 160 continuation keeps the scene anchor at chainage 36,468.9 m and
changes the paused train's chainage through its actual pose function. The successful
run is `native-leg160-candidate-v4/receipt.json` (candidate code V3). At chainages
40,668.9 m and 41,468.9 m it published generations 4 and 8, drained the ground queue
to zero, and returned physical terrain evidence at all nine sampled points beside
the train. Resident terrain was 49 and 61 tiles respectively. Screenshots show the
track, surrounding terrain and coast; page errors were zero. The anchor was identical
at all three observations, with the final camera X exceeding 4.5 km.

Two road-terrain-evidence failures occurred while windows changed, then recovered
after obsolete source ownership expired. Their cumulative counter remains visible;
the final `failureBlocked` is false and `lastError` is null. No topology precision,
seam or road-bucket-capacity error occurred in this run. This does not establish
that every route/window combination is free of those other reported failures.

This is recovery evidence, not a continuous-driving performance claim: these were
controlled jumps, and complete ground settlement took 69 and 153 seconds. Reducing
that completion tail remains delivery step 1. The final V4 code differs only in
preserving the collider adapter's rejection of invalid raw coordinates before
adding a local origin; its red-to-green test and the 96-test isolated batch pass.
It does not alter the valid typed geometry exercised by the continuation.

The successful run captured 1,033 source fixtures (including reused inputs), source
hash `47c2f54343f820fa47ebab2e89f98bd7f89313f1f39bfa28ff4fc8c8d71132f9`, and
verified 614 served code responses against the frozen checkout.

## Matched performance

`paired-v5/receipt.json` accepts both captures: same sealed 9,716-entry source
cassette, high quality, 1600×1000 viewport, paused/fully built starts, the same
52-second driving controls and 30-second stationary phase. Each build's served
code is verified against its frozen checkout. The candidate is V5 above; the
baseline is `eb65a388`, whose engine is the deployed increment. This is one adjacent
pair, sufficient to clear this correction's regression screen, not a general FPS
benchmark for all places or hardware.

| Measurement | Baseline | Candidate V5 |
|---|---:|---:|
| Moving mean frame time | 26.66 ms | 26.62 ms |
| Moving p95 | 34.20 ms | 33.60 ms |
| Moving maximum | 128.9 ms | 109.4 ms |
| Moving intervals over 50 ms | 31 | 23 |
| Stationary mean frame time | 27.63 ms | 26.57 ms |
| Stationary p95 | 34.00 ms | 33.66 ms |
| Stationary maximum | 108.2 ms | 75.8 ms |
| Stationary intervals over 50 ms | 6 | 8 |
| Post-timing complete drain | 106.68 s | 33.47 s |
| Post-timing publications | 3 | 2 |

Candidate host-clean coverage is 51/51 moving and 29/29 stationary windows;
baseline is 46/48 and 29/29. Both finish with zero failed/pending ground work and
empty queues. Movement is effectively unchanged (−0.18% mean), stationary mean
improves 3.83%, and no new recurring queue owner over 50 ms appears. Existing
render/pedestrian long-frame work remains; the stationary long-interval count
rises from six to eight despite its lower maximum. The native-context receipt
also retains page-in activity rather than silently filtering it out.

## Final-build continuation

`native-final-v5/receipt.json` verifies the exact V5 code fingerprint above. The
paused train moves directly from chainage 36,468.9 m to 41,468.9 m with its geographic
anchor unchanged. Ground advances from generation 2 to 4, retains 49 terrain tiles,
drains to zero pending work, and supplies all nine nearby terrain samples. The old
bridge is absent from the new source window. One temporary road-evidence failure
recovers; `failureBlocked` is false and `lastError` is null. Ground settles after
the jump in 60.235 seconds. The screenshot shows the track and coastal ground.

The final run has zero page errors, 614 verified served-code responses and 1,039
captured source fixtures, hash
`7bb89f9b102d40fc8ff1befb59e620ae5eba1e996f6516122f5fa39ad7d85e20`.
This remains a controlled recovery check, not a claim of uninterrupted ground
coverage at every driving speed or a complete country-wide acceptance matrix.
All owned verification browsers were closed. Production read-back remains the
last release step.
