# Station3D world glitch census

A state document, not a log. One row per named, reproducible glitch in how the
3D world forms and draws, with a pose where it shows, the instrument that
detects it, and a status. Progress is counted as rows closed. Update rows in
place; put narrative in the dated records under `docs/`, not here.

**Status vocabulary:** `open` · `fixed-local` (on `main`, not deployed) · `deployed`
· `verified-prod` (looked at on zagreb.lol) · `class` (a recurring failure family
kept for regression checks, no single open instance).

**Effort:** `quick` (hours, contained) · `medium` (a day, one subsystem) ·
`major` (design work or a plan step).

**Poses:** deep links use `/sloboda/@<lat>,<lon>/?heading=<deg>&pitch=<deg>&elevation=1&time=12`
(0 = north, clockwise). Audit poses from the 11 September spec: Jelačić
`45.813215,15.976903` h143.5 · Savska `45.80305,15.96705` h0 · Kružićeva
`45.805671,15.992536` h304 · Split Riva `43.50785,16.43915` h90.

**Instruments:** `__s3dSurfaceAudit()` (stacking: inversion, coplanar, floating,
void, duplicate) · `__s3dShoreAudit()` (paved shore ramping into the sea) ·
`__st3dDebug.state.cabState.groundGenerations.snapshot()` (localhost: which
generation is rejected and why) · the F overlay stutter log · eye.

## A. Formation and shape

| id | glitch | where | detector | status | effort |
|---|---|---|---|---|---|
| A1 | Terrain shards poke through pedestrian paving; precedence rests on a 4.3 cm offset and a 1,200-triangle drape cap (28 to 46 m shards on 1 m LiDAR) | Jelačić pose; OSM `-1493356001` | surface audit, inversion terrain-over-sidewalk 1,346 samples, worst 30.3 cm (11 Sep) | open | major (step 7 near-detail, or a terrain-conforming drape) |
| A2 | Opposite triangle diagonals sink paving under terrain even with identical corner heights (0.957 m in a 4×4 m cell) | any draped receiver | unit counterexample only | open design invariant | major (same fix as A1) |
| A3 | Terrain over sidewalk at every audited pose (Riva 463 samples 35.1 cm; Kružićeva 146, 26.3 cm; Riva edging 21, 1.04 m) | audit poses | surface audit | open, not re-captured since 11 Sep | medium (recapture first) |
| A4 | Floating sheets: sidewalk 58 at 40 cm (Jelačić), carriageway 28 at 41 cm (Savska), sidewalk 37 at 95 cm (Riva) | audit poses | surface audit, floating (30 cm proximity heuristic) | open | medium |
| A5 | Night pink pools and rings on draped roads: road ribbon coplanar with terrain, lamps light the z-fight; also lamp poles hanging under elevated formations, crack lines at collar seams | Rijeka hillside streets, any night pose | eye only, night | open, pre-existing since 31 Jul | medium (a formation under every draped road, or a night probe first) |
| A6 | Roads have no longitudinal profile: steep draped ways render as vertical asphalt sweeps with floating markings | any steep draped way | eye | open, deferred to the alignments worktree | major |
| A7 | Polygon holes get paved: `roads.js` paves only the outer ring | any pedestrian polygon with a courtyard hole | eye | open | quick |
| A8 | One-sided formation dressing: navy panels on cut walls, bright aprons under the walker lamp | Rijeka portal, night | eye, night | class (fixed with `pushTriangleFacing`, keep winding tests) | — |
| A9 | Rendered and civil terrain disagree by metres on ridges; produced an asphalt strip 2 m over the funicular deck | funicular, OSM way 482988746 | eye | suppressed by three rules; divergence remains | medium |
| A10 | Five service ways get synthesized underpass alignments, possibly bogus | Petra Kružića underpass `45.8057,15.9923` | eye | open, never checked | quick to check |
| A11 | Paved shore ramps into the sea instead of a quay face (promenades are paint, the quay classifier saw no landing) | Split Riva | `__s3dShoreAudit()` ramped-paved-shore | verified-prod 16 Sep (7 clean, 0 ramped) | — |
| A12 | Quay deck one step below the promenade where the shoreline segment is long and the LiDAR dips | Split Riva west | `__s3dShoreAudit()` | verified-prod 16 Sep (24 m pieces, apron maximum) | — |
| A13 | Tan unpaved blocks on paved squares are stair-stepped: paint cascade texels quantise every polygon edge near the camera | Split Riva, any square | eye | open | major (plan step 7 near-resolution gate) |
| A14 | The LiDAR water mask trims 3 to 4 m of quay edge, so the deck lands 4 m inland | Riva transect: LiDAR 0.94 to 1.12 m ASL, world evidence null within 3 to 4 m of the waterline | database probe | open | small change in cadastre-data, medium verification |
| A15 | Coast collar quads overlap in plan at bends and tripped the receiver clipping seam check, holding the world's ground | Split port | coordinator snapshot, `ground-topology-seam` with position | fixed-local 16 Sep (collar declares `overlappingFaces`) | — |

## B. Hierarchy and stacking

| id | glitch | where | detector | status | effort |
|---|---|---|---|---|---|
| B1 | Duplicate published sidewalk: one relation polygon in two regional buckets (4,379 of 4,650 flagged samples); negative OSM ids fall back to `tile:<key>:<index>` identities | Split Riva | surface audit, duplicate | open; spec step 1 acceptance still requires zero | medium |
| B2 | Jelačić square appears in four regional aggregates at the same face index | Jelačić | inspector | open, not investigated | quick to check |
| B3 | `/roads/cab` does not clip to its bbox; taper context is bbox-dependent, so one way has different end shapes in adjacent responses | Koranska, Držićeva fixtures | fixture | open upstream | medium (API) |
| B4 | Height ladder non-monotonic: 14 candidate pairs near or below 3 mm, 12 without stencil arbitration | everywhere | ladder ratchet test (may only shrink) | open | medium |
| B5 | Coplanar carriageway and cycleway paint (Savska 502 samples up to 8.5 mm; Kružićeva road over cycleway 43, 10.9 cm) | Savska, Kružićeva | surface audit, coplanar | open; Savska capture unsettled | medium |
| B6 | The audit skips grade-separated claims, so conflicts within one elevated deck are invisible | any deck | audit defect | open | quick |
| B7 | The audit cannot certify what it reports: instanced and skinned meshes skipped, stencil assumed to pass depth, 15k to 53k unverified discard hits per run, `gpuVerified: false` | all runs | audit defect | open (spec step 0) | major |
| B8 | Backstop contract has no reader: `terrainBackstopReplacement` is written and never read; no pedestrian-precinct mask operation | roads | code | open | medium |
| B9 | Terrain revision does not reach all seated layers; y=0 modules unverified in terrain worlds | manholes, electrification, junction lifts | code | open | medium |
| B10 | Campaign replay loses stencil state; new paint needs capture and replay support | campaign packs | code | open until plan step 8 regenerates packs | major (planned) |
| B11 | Duplicate Glavni kolodvor slab and canopy box in the campaign world beside the landmark | Zagreb main station | eye | open | quick |

## C. Streaming, timing and generation

| id | glitch | where | detector | status | effort |
|---|---|---|---|---|---|
| C1 | Ground keeps arriving 41 to 139 s after driving stops | any drive | F overlay drain | open (tracker step 1 residual) | medium |
| C2 | Unexplained 300 ms stationary stall | stationary capture, release `3c61a248` | stutter log | open | medium |
| C3 | Half-second pauses while standing (7 over 100 ms per capture) | stationary | stutter log | open | medium |
| C4 | Actor, pedestrian and point-support pauses up to 285 to 510 ms | moving and stationary | stutter log | open, explicitly not claimed by the land-use release | medium |
| C5 | Pedestrian-support long frames (415 ms with 222 ms in pedestrian updates) | moving | stutter log | open | medium |
| C6 | Main-thread GC stall of 323 ms freeing 736 MB | early large stall | trace | open after the allocation microrelease | major |
| C7 | Load hold about 63 s in the qualified captures; 40 to 45 s at the Riva on 16 Sep; the bar is about one minute | any pose | `__s3dWorldLoadState` | open as a standing budget | — |
| C8 | Streamed corridor generations take minutes (218 s elapsed for 35 MB of road geometry) | long corridors | coordinator | open latency gate | major |
| C9 | A late rail-clearance callback blocks the next ground generation | rail corridors | coordinator | fixed-local only, not deployed | medium (deploy with its fan-out correction) |
| C10 | One layer's non-transient failure rejects the whole world's ground; busy and stale codes retried forever without a count | everywhere | coordinator snapshot only | open by design; three layers now settle permanent gaps | major (a rejection budget and visibility in the overlay) |
| C11 | Far skyline never fills in on long drives (far class budget 0 while near or delivery pend) | long drives | eye | partly fixed (aging), residual hole | medium |
| C12 | Stack overflow on long features leaves an empty world under a running cab: latent at five `push(...spread)` sites | photoreal, underground, civil envelope, streetlamps, buildings | page error | open at five sites | quick |
| C13 | Street rails arriving 70 to 100 s late | tram streets | rail bar vertex count over time | class (fixed 11 Sep) | — |
| C14 | Storage-precision and topology failures on real drive routes (Kambelovac start, retraced ring) | project 64 | coordinator | the 15 Sep repair is on prod; the family recurred at the Split port as C18 | medium |
| C15 | A kerb run with no terrain evidence cleared every kerb in its 400 m tile | Split port | console `published without N of M kerb runs` | fixed-local 16 Sep: only the union run with the gap is omitted (tiles −1_3 and 0_1 now keep 2 of 3 runs); the run returns on a later terrain revision | — |
| C16 | Rail and platform evidence rejections carried no location | rails, stations | coordinator | fixed-local 16 Sep (cell keys, stop and point) | — |
| C17 | A road ring's terrain NoData was judged permanent at the feature's centre, not at the failing sample: way 126354021 on the ferry pier (40 m) has 20 m data at its centre and NoData at its west end, so every generation was rejected `road-receiver-evidence-unavailable` and the port kept no ground on prod | Split ferry port, walking south from the Riva | coordinator snapshot; console `[roads] road N excluded … at x,z` once fixed | fixed-local 16 Sep (the ring task judges at its sample by the shared rule and names the point; the feature trusts it; a tunnel path above ground is excluded the same way) | — |
| C18 | Receiver storage rounding never settled: the union re-quantises every vertex to the 2^-40 m Boolean lattice, the storage offset of a coast collar triangle (Float32 vertices, double origin) has bits below it, so each pass "moved" and the four-pass limit rejected the generation (`ground-topology-precision`, a 2.6 m stadium cut by the 0.59 m steps way 1303175757) | Split ferry port, east pier | coordinator details `terrainStorage` (kept as `__tests__/fixtures/split-port-collar-storage.json`) | fixed-local 16 Sep (sub-lattice drift is not movement) | — |
| C19 | After a move, ground generations chain for minutes (18 s, 69 s, 36 s, 29 s wall; 6 s CPU each) and every building whose foundation was sampling waited on the road formation's pending build, which only clears when a generation publishes: 658 buildings stood still for 142 s, 1,335 twenty seconds after the chain ended. Standing still: zero generations | Split Riva, any move | `groundGenerations.snapshot()` beside `__s3dBuildingBuildState()` | fixed-local 17 Sep (a building waits only for a pending road change that reaches its footprint; the sampler reads published indexes; buildings now advance while a generation prepares, 714 → 946 during one, and the chain idles at 111 s instead of 152 s; a building inside the pending change waits at most the terrain gate's allowance, 8 s standing, then builds on the published generation and is re-checked when the formation publishes: after a 900 m move west the new tiles' buildings logged at +30 s instead of +110 s; then the wait became one 2 s clock per pending change shared by every building, because a tile job walks its buildings in turn and paid the allowance per building: the new area now stands at +21 s) | — |
| C20 | The moving 1 m window replaced its predecessor every 420 m, so the tiles behind the player fell back to the 20 m base and rebuilt with everything on them | any walk or drive | `[terrain] detail revision … N tile(s) changed` | fixed-local 17 Sep (the two most recent windows within 2 × halfSize + 420 m stay composed; the same 600 m move changes 3 terrain tiles instead of 5) | — |
| C21 | The coordinator's phase table overflowed at 128 raw labels (tile keys, ids, counters), so 3 of a generation's 6 s CPU landed in `other` | every generation | `lastPublication.preparation.phases` | fixed-local 17 Sep (labels normalised, cap 256) | — |
| C22 | A building tile job blocked on its first feature whose terrain evidence was still pending and re-selected it every flush, so the rest of the tile waited with it (two `overture/…` features at the west edge held their tiles 30 s) | Split, arriving at a new area | streaming report `deferring` label `[terrain-evidence-wait]` on the buildings queue with a rising count while siblings are unbuilt | fixed-local 17 Sep (a pending feature ranks below every runnable sibling, `dependencyPending`; the finalization item stays last) | — |
| C23 | Buildings arriving late in a new area is the ground generation's wall time, not build throughput (the 12 buildings/s reading was host load; clean, buildings build at 33/s when runnable). Generation 5 after a 900 m move: 34.0 s = 6.8 s CPU + 11.7 s waiting on 28 serial `terrain-receiver-compile` Worker jobs (~410 ms each, and the terrain step runs first so nothing overlaps it) + 15.6 s waiting for a scheduler turn | Split, 900 m move west | `lastPublication.preparation.phases` rows now carry `waitMs` and `schedulerMs` per phase; `starvedFlushes` per queue in the streaming report | partly fixed-local 17 Sep (C24, C25; refused frames gone; gen 5 wall 34.0 → 29.9 s in one run, 33.8 s in another on a host at load 6, so the wall time is noise-bound there); the serial Worker compile remains | medium (compile terrain tiles while the main-thread phases run, or cheaper fine-tile packets) |
| C24 | A queue whose jobs all waited on a dependency was marked budget-blocked after a sibling's overrun and took first admission next frame, refusing the runnable sibling: the ground generation lost 47% of its frames to the buildings queue's probes (starved flushes 255 → 574 in 5 s) | after any move | streaming report `starvedFlushes` rising on `ground-generation` while `buildings` only defers | fixed-local 17 Sep (only a queue with runnable jobs is starvable, `adaptiveAllowance`/`firstProgressQueue`; starved flushes stayed flat through whole generations in two runs) | — |
| C25 | The building tile re-check runs one check at a time, and the check waited unbounded for a pending road formation, so `ground-check -8_1` held every queued tile for 44 s across two generations | after a move, while a generation is pending | buildings queue `deferring` label `ground-check <tile>` with a rising count | fixed-local 17 Sep (waits only while the pending change reaches the tile, and only for the shared allowance; the publication re-check covers the rest) | — |
| C26 | A train could outrun the initial 49 terrain receivers while one mixed road/rail generation rebuilt the loaded corridor: Kambelovac → Split reached 1.26 million compiler steps / 74.8 s CPU with no successor terrain publication, leaving rails and buildings over the grey void | project 160, km 36+0 after starting at km 34+280 | `__s3dWorldLoadState().groundGeneration`, streaming report and screenshot | fixed-local 18 Sep: terrain/ground-window obligations are priority transactions using the published physical graph and exact cuts; they can preempt private mixed preparation, continue at transit speed, and leave the expensive physical closure pending until movement slows. The same run published seven generations and retained visible terrain at km 36+765 | — |
| C27 | A cutout triangle that touched a receiver only at its boundary acquired a microscopic area in the 1 mm storage halo, collapsed in Float32 and was reported as a lost opening (`ground-topology-precision`) | project 160 near km 36+7, terrain tile 3_4 boundary | coordinator `terrainStorage.kind=operand-collapse`; exact captured regression | fixed-local 18 Sep: storage loss is diagnosed only when the clipped operand has positive area inside the actual receiver; real interior openings still fail closed | — |
| C28 | The priority terrain window moved every 400 m, but coordinated mode disabled the rail layer's ordinary 1.2 km recenter. Rail meshes, exact cut openings and collision stayed at the initial center and ended after their 3.5 km radius; the cab then followed its authored profile under newly resident terrain | project 160, Kambelovac → Split, visible from km 40+7 after starting at km 34+280 | screenshots plus `__s3dRailFormationBuildReport().renderCenter` | fixed-local 19 Sep: the priority residency transaction recompiles the published rail feature set at the current center and atomically publishes rail, its cutouts, terrain and collision without consuming source changes. One continuous headed run reached km 40+807 with the cut open, rail visible, 24 publications and zero hard failures | — |
| C29 | At 70 km/h the road tile source stayed ahead of the train, but coordinated physical publication was disabled for every moving frame: 25 tiles / 255 road features were resident while the visible road publication remained at zero | project 160, km 41+175 after starting at km 40+705 | live source/publication inspection in one continued headed run | fixed-local 19 Sep: moving state no longer defers road/rail/curb source changes; small terrain/ground-window transactions still preempt the full successor. The same run retained 19 published tiles / 95 features beyond km 41+557 while source residency advanced | — |
| C30 | Coastal sea coverage suppressed every decor-water polygon in the 3 km greenery request, including the Jadro river even though the dedicated sea renderer intentionally accepts only oceans, bays and straits | Jadro, Split (`43.532849,16.487372`) | API feature inventory plus live scene inspection | fixed-local 19 Sep: sea/decor ownership is decided per polygon; marine polygons yield to the sea compositor while terrain-relative rivers/lakes remain. Jadro publishes 26,544 water vertices and seven shore meshes | — |
| C31 | Tunnel-portal reconciliation walked the complete 43,113-segment rail formation synchronously on every rebuild, producing recurring 193–203 ms `rail-construction:wholeSet:portalOpenings` queue items | project 160, Kambelovac → Split | performance overlay plus rail formation report | fixed-local 19 Sep: the whole-set pass uses the existing cooperative boundary-opening iterator and yields at its 0.5 ms work boundary; formation ownership and the final atomic publication are unchanged | — |
| C32 | The ground owner displayed a cumulative hard-failure count without its retained error code, so `4 failed` could not distinguish topology, capacity, source or cleanup failures after the console line had passed | all coordinated ground sessions | performance overlay versus coordinator `lastFailure` | fixed-local 19 Sep: a non-zero failed count includes the retained `lastFailure.code`; the current project 160 route run reached km 42+110 with 0 hard failures | — |
| C33 | Mapping a quantized world opening back to a transformed coast receiver produced two barycentric reconstructions of the same point 1.3 × 10^-11 m apart; the resulting zero-width triangle collapsed in Float32 and rejected the whole generation as `ground-topology-precision` | project 160 direct load at km 41+175, coast receiver source triangle 173 | retained `lastFailure.details` with exact and stored faces | fixed-local 19 Sep: transformed projection discards only faces with duplicate vertices within 1 nm before storage; the 1 mm fail-closed rule for real thin openings remains, and the exact-point generation publishes with 0 hard failures | — |

## D. Data and coverage

| id | glitch | where | detector | status | effort |
|---|---|---|---|---|---|
| D1 | Audit provenance unproven: detail source is `best-available`, Savska unsettled | audit runs | — | open | medium |
| D2 | 97% of Split building heights are invented from area; a 5×9 m house is a 3.2 m box | Split | — | open | major (data) |
| D3 | Flat terrain west of lon 15.6344 with buildings on it | Žumberak strip | eye | open | data |
| D4 | Far skyline table empty on prod at Vis, Osijek, Pula, Dubrovnik | those cities | eye | open | manual sync |
| D5 | Prod data is a manual second job; a key-only diff cannot see a stale row | everywhere | — | structural risk | medium (tooling) |
| D6 | Velika Gorica has no GDI buildings, so procedural facades | Velika Gorica | eye | open | data |
| D7 | 20 m grid appears at Split beyond the ±550 m LiDAR window while roads and curbs reach 700 m; the ferry pier has LiDAR at 2.2 m but the 20 m grid there is NoData at two of three samples, so every port failure of 16 Sep (C15, C17, the bridge ramp 469508851) is a 20 m artefact that a window covering the generation scope would remove | Split port | coordinator, evidence probe, `dgu_lidar_dmr` vs `dgu_dem` | open policy question | decision |

## F. Player controller

| id | glitch | where | detector | status | effort |
|---|---|---|---|---|---|
| F1 | Falling into the mapped sea without a canopy found no support (LiDAR NoData, no floor), so the 6 m floor guard parked the walker 5.5 m under the water; only a parachutist was clamped to the surface | Riva basin, jump off the quay | eye, altitude readout | fixed-local 16 Sep (`seaSurfaceSupportY`: anyone over the mapped sea stands on the water; support above it still wins) | — |

## E. Remaining plan steps (tracker numbering; spec numbering in brackets)

| step | scope | acceptance | closes rows |
|---|---|---|---|
| 1, 2 residual (3) | streamed ground updates finish promptly; broader scenario matrix | changed ground publishes during movement; finite queues drain; shorter tail | C1, C14 |
| 4 residual (5) | tram-corridor colour with adjoining rail dressing | verified beside step 7 | — |
| 6 (7) | markings, zebras and near detail; near-resolution and temporal gate in the native renderer | legible at 5 m, walker eye height and oblique views; no swimming, shimmer, seams or duplicate near/far paint | A13, A1 (partly) |
| 7 (8) | rail material dressing | street-running, ballasted, crossing and bridge/tunnel rails keep support and geometry; prepass removed only when its readers are accounted for | — |
| 8 (9, 10) | remove obsolete paths, regenerate packs, terrain on by default for transit, final matrix | migrated colour pairs have direct tests; a zero ladder count from deleting offsets is not proof; no regression at `elevation=1` | B10, B4 |

Spec step 0, repairing the audit before trusting its budget, is still the
standing obligation behind B6 and B7.

## Next batch

Quick wins first, then the two mediums that remove the most visible faults:

1. C12 five latent spread sites, A7 polygon holes, B6 deck-internal conflicts, B11 duplicate slab.
2. A3 and A4 recapture at the four poses on today's main, then ratchet the budget.
3. A5 night coplanar roads: a night probe at one Rijeka pose, then the formation rule.
4. B1 duplicate sidewalk identity.
