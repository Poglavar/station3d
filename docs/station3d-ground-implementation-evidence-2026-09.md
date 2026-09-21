# Station3D ground implementation: verification history

Companion to the [implementation specification](station3d-ground-hierarchy-2026-09-11.md). These dated checkpoints preserve what each source version actually demonstrated, including rejected runs and superseded findings. They do not replace the current status and acceptance gates in the specification.

## Implementation evidence (12–14 September, work in progress)

**v69–v71, source admission and paint capacity:** v69 passes 1,733 tests and its native entrance
floor/lip checks agree with actual mesh faces. Its final vehicle record reaches 42,206 physics steps,
four wheel contacts, health 100 and zero recovery lifts, but ground work is still pending and the stopped
car drifts. This is support evidence, not completion or braking acceptance.

The v70 native run identified that completed tile downloads retained global network slots until
subscriber geometry finished. The corrected shared session releases those slots after body consumption,
retains a finite per-source delivery buffer, and drains a fixed queued-callback set before the coordinator
captures its change ledger. Later callbacks remain held for the successor; downstream publication
promises cannot deadlock admission. The expanded manifest includes the shared-session and network
scheduler tests: **1,765/1,765 pass across 218 files**, with unchanged source hashes. All road sources
settled after the initial four ground publications. Activating the parked car expanded the source window;
road and network delivery then drained, but ground generation 9 remained **failure-blocked** by
`Ground paint changed region capacity exceeded`. The native acceptance run therefore fails. Its saved
vehicle state retains four contacts, health 100 and zero recovery lifts at 15,417 physics steps.

v71 removes that contradictory 32-region admission limit: the paint index retains at most 256 regions
and 4,096 records; one transaction may include both old and new memberships (512 changed regions,
8,192 owner replacements). Existing texture, page, packet and draw budgets still apply. A forty-region
publication fails on frozen v70 and passes on v71, including rollback after a later receiver failure.
Moving all 256 regions preserves colour without another draw, and a 257th live region rejects without
changing the published index. **1,767/1,767 tests pass across 218 files**. The native v71 run subsequently exposed a
source-admission ordering error: a captured curb tile could lack a road-mask callback frozen out of the
same generation. It reached three publications and four rejected candidates, with another candidate still
preparing at closure. The paint capacity error did not recur, but this run does not establish settlement.
See [v70 native evidence](../output/surface-audit/ground-implementation/ground-stream-admission-v70/native/README.md)
and the [v71 headless receipt](../output/surface-audit/ground-implementation/ground-paint-admission-v71/broad/headless-validation-receipt.json).

**v72, dependency-ordered source admission:** source holds retain their captured tile membership,
while future unadmitted requests remain evictable. Admission freezes the finite curb set first, then
requests and retains exactly its road-mask dependencies before sealing the other road sources. Shared
network and per-source delivery budgets still apply. Cancellation releases both holds and dependency
retentions. The production entrypoint regression fails against frozen v71 before its missing mask is
requested, then passes with the ordered admission. **1,772/1,772 tests pass across 219 files**, with
1,587 source hashes unchanged. The [native receipt](../output/surface-audit/ground-implementation/ground-source-dependencies-v72/native/README.md)
records nine publications, no rejection/failure, and no pending ground, network or shared-source work at
03:55:48.496Z on 14 September. Vehicle support retains four contacts, health 100 and zero recovery lifts
after 23,023 physics steps. This is finite settlement evidence for one parked-car corridor expansion.
Generation 6 takes 100.159 seconds of preparation and generation 9 takes 13.8817 seconds; these are
elapsed times, including scheduler/readiness waits. Stopped-car drift remains. This is not comparable
movement-performance or braking acceptance.

**Planner capture, after v72:** the route/grade conversion is extracted into a pure cooperative compiler,
with explicit feature, coordinate, segment and terrain-probe limits. Eight independently captured frozen
v72 cases preserve route indices, joins, raw/absolute/relative heights and missing-evidence behavior.
A separate long-segment check verifies bounded probing, interior missing evidence, cancellation and
capacity rejection. All 42 focused planner/opening/publication tests pass. The planner generation adapter
and receiver material cutover remain unfinished; extraction alone does not complete that integration.

**v73, preparation instrumentation and rejected Jelačić run:** the frozen source passes
**1,776/1,776 tests across 220 files**, with 1,590 hashes unchanged. The coordinator records CPU time
around compiler visits separately from elapsed preparation, with a bounded phase table. At Jelačić,
generation 3 records 92.3408 seconds elapsed and 4.5915 seconds inside compiler visits. These are
diagnostic measurements only: the native frame later fails inside pedestrian support because five rail
opening-filter calls use the nonexistent `SURFACE_CLASS.TRACKBED`. The finite tram-support branch was
absent from the earlier Grić fixture. Ground queues continue on their separate scheduler and reach seven
publications with zero pending work, while the render hook throws before completing frames. Therefore
neither queue settlement nor the saved canvas establishes visual, movement or performance acceptance.
The [native failure record](../output/surface-audit/ground-implementation/ground-preparation-profile-v73/native/README.md)
preserves the error stacks and source identity.

**Curb dependency scope, after v73:** a curb source key/bounds/full invalidation now selects curbs
without invalidating upstream road receivers. Road/terrain changes still propagate to dependent curb
tiles, using the appropriate 200/400 metre source lattice and formation collar. The same complete
transaction and ordinary compilers remain in use; published query reuse and unchanged-rail preparation
are not yet optimized. A production-entrypoint VM regression reproduces frozen v73 expanding a curb
tile into road bounds and verifies the corrected scope, including full-curb and mixed-source changes.

**v74, corrected walking support and narrower curb scope:** **1,780/1,780 tests across 221 files** pass,
with 1,592 hashes unchanged. Separate finite tram and planner fixtures query the actual lower mesh floor
through an opening. The [native Jelačić checkpoint](../output/surface-audit/ground-implementation/ground-curb-scope-v74/native/README.md)
renders, publishes seven ground generations and drains ground/network queues without a ground failure.
The final curb-only generation builds zero road geometry but still takes 18.2186 seconds elapsed,
927.8 ms compiler CPU and 27,935 visits through the complete model graph. The 144-point local audit has
complete sampled ground/paint/support coverage and zero sampled violations, but reports an unresolved
rail-readiness flag and 145 unverified shader-discard hits. It does not pass compositor acceptance.

**v75, published receiver reads and curb-only preparation:** **1,785/1,785 tests across 222 files** pass,
with 1,594 hashes unchanged. The active read owner survives preparation lease release, shares immutable
query buffers, and changes identity inside the ordinary publication registry. Failure restores the old
identity; a successful successor invalidates old queries while retaining their buffers until outstanding
borrowers release them. Tests use real opening clipping and explicit upstream owner counts. The production
world/curb compiler regression changes one tile, preserves the other tile's exact root, prepares only
curb support for physics, and rolls back every visible/support change after an injected later failure.
All read/source/window owners are released. The production factory reuses this graph only for pure curb
changes; mixed updates retain complete source admission. The [native diagnostic](../output/surface-audit/ground-implementation/ground-published-reads-v75/native/README.md)
settles four full publications. A manually triggered one-tile curb generation then publishes in 249.6 ms
elapsed preparation, with 17.4 ms compiler CPU and 2,529 visits; no upstream compiler runs and the active
receiver-read revision remains 4. All ground/network work drains and the bounded error listener is empty.
The fourth full generation still takes 104.9315 seconds, and the rail gate isolates an unacknowledged
mapped-sea flag. This proves one native reuse path, not movement performance or complete acceptance.

**Rail readiness, after v75:** code inspection and a failing production-function regression identify
terrain dirty flags queued before coordinator takeover that were never acknowledged by managed publication.
Successful publication now consumes them; discarded preparation and newer source/sea revisions retain
their obligations. Mapped-sea structure changes also invalidate the managed rail owner instead of waiting
for the disabled former frame path. Three focused regressions pass; this change is not in frozen v75.

**Planner geometry preparation, after v75:** the existing civil geometry compiler now yields through
station-gap scans, portal neighbours, segment/instance preparation, position welding, normal generation
and bounds. Eight independent frozen v75 geometry cases preserve every recorded position/index/normal/
instance byte, enclosed span and marker placement. Source/route/box limits reject complete candidates;
cancellation disposes private meshes, unused materials and instance attributes. The first 4,096-segment
profile exposed 85.5/70.94 ms synchronous welds. After their replacement, the same fixture uses 7,001
visits, 247.8 ms total CPU, and a 1.66 ms largest visit, with no visit over 20/50 ms. Arithmetic probes
are 10.87/10.62 ms before/after; source hashes and raw timings are preserved under v76/profile. This is
headless CPU granularity evidence. The world still drains the generator synchronously until the planner
adapter is connected; native geometry/upload/publication acceptance remains open.

The compositor cutover and coherent terrain/receiver transaction are **not complete**. Code existence,
settled captures and release acceptance are recorded separately:

**Progress estimate, 14 September:** approximately **40% of the full implementation plan** by engineering
work remaining, not by test count or percentage of conflict samples removed. Steps 0–2 are largely
implemented and verified; step 3 is integrated but its live acceptance remains open; the first production slice in step 4
works but has open acceptance gates; the wider migrations and final rollout in steps 5–10 remain ahead.
The complete terrain/road/rail/curb/formation-mask/physics pipeline is now wired. Native groups have
published with active vehicle physics. A controlled whole-source height replacement exposed a missing
mesh-cache invalidation; the correction passes the real Worker regression and a native on-foot replacement.
Planner/authored/water openings and movement acceptance remain required. The historical checkpoints below describe what was
verified at each version; their then-open wiring gaps are superseded by this checkpoint.

The archived v51 regional-validity diagnostic records bootstrap road receiver
footprint supersession (`ground-generation-stale`) while the coordinator was
pending and `ground-dependency-busy`; it identifies the regional ground-current
path through the road feature/ring task. The focused feature/ring/footprint
regression passes. Native v52 completed bootstrap without captured errors, then
published a terrain-window generation with all six vehicle collider families,
967 bodies, four wheel contacts and no recovery lift. Its 88.9-second preparation
latency remains unacceptable as a performance result; it did not inject a terrain
height change or drive a controlled route. The
[v52 diagnostic](../output/surface-audit/ground-implementation/ground-regional-validation-v52/diagnostic/README.md)
records the capture limits.

**Consumer lifetime and scheduling (v53):** world geometry no longer reserves a
vehicle's collider window before civil preparation. Physics joins the prepared
world with a bounded road-query snapshot at its current position. Recentring
discards only that consumer's private query/allocation and retries against the
same world candidate. Ordinary collider refresh continues to use published
world data during the civil solve; final terrain/receiver/physics promotion stays
one transaction. A real Rapier test cancels an allocation, recentres all six
families by 500 m, then publishes support from the original private road
generation. Read windows have explicit cell/part caps and a maximum of eight
retained snapshots. Cancellation, clear and finalization release their references.
The coordinator also removes its 64-visit-per-frame throttle for trivial compiler
yields; existing scheduler time deadlines remain in force. A deterministic queue
test verifies both throughput and that time bound. The
[v53 headless receipt](../output/surface-audit/ground-implementation/ground-late-physics-v53/broad/headless-validation-receipt.json)
records **1,651/1,651 passing tests across 201 files**, with unchanged source hashes
and HEAD. Native source-update and movement acceptance remain open.

**Active height replacement and publication profiling (v54–v55):** the native v54
run completed both a +0.5 m terrain-source replacement and restoration with the
car's six collider families active. The car drove 58.50 m while generation 5 was
preparing; that same generation published. Four covered terrain probes rose by
0.5 m and returned to their original heights; the fifth remained an opening.
Across 41,003 observed frames, the five probes recorded zero mesh/query
mismatches (maximum numerical error below 1e-12 m). These are bounded probes,
not a full-scene topology certificate. The drive and replacement sequence had
22 frames with fewer than four wheel contacts, a maximum analytic/Rapier support
difference of 8.53 cm, and two recovery lifts totalling 0.594 m, including the
artificial upward terrain jump. Final health was 100 with four wheel contacts.
The later v56 capture below resolves the 8.53 cm diagnostic: it compared a
recovery hint with a different physical receiver. This v54 run alone did not
establish that distinction or close the physics gate.

Performance also remains open: the height generation took 283.3 seconds and
restoration 549.9 seconds, with different admitted source sets as streamed work
arrived. The maximum recorded publication boundary was 74.8 ms, and a preparation
visit reached 158.4 ms. The restoration CPU trace attributed 23.7 of 41.4 sampled
boundary milliseconds to repeated road dependency validation. The v55 correction
shares that immutable read across a synchronous compiler visit or full preflight,
then clears it at every yield and before mutation. A real multi-bucket regression
checks every admitted owner once per preflight, rejects an owner changed before
publication, retains old roots/support, and verifies a successful retry. The
[v55 headless receipt](../output/surface-audit/ground-implementation/ground-shared-preflight-v55/broad/headless-validation-receipt.json)
records **1,653/1,653 passing tests across 201 files**. The subsequent native v55 run
rejected bootstrap: the validation wrapper spread a frozen publication into a mutable object,
and the downstream road reader correctly refused it. This is a rejected candidate, not a
performance result. The [v54 diagnostic](../output/surface-audit/ground-implementation/ground-consumer-validation-v54/diagnostic/README.md)
records the complete evidence and its limits. Source restoration was verified
before the dedicated Chrome session closed.

**Contract-preserving validation (v56):** the wrapper now preserves property descriptors,
including the live publication-state accessor, and freezes the derived resource. A regression runs
that production wrapper through the real road renderer input capture and verifies
prepare → commit → rollback → commit → finalize. It failed on v55 and passes on v56.
The [v56 headless receipt](../output/surface-audit/ground-implementation/ground-frozen-contract-v56/broad/headless-validation-receipt.json)
records **1,661/1,661 passing tests across 202 files**, with unchanged source hashes during the run.
A physically copied native site subsequently completed bootstrap publication in 48.3 seconds,
the +0.5 m replacement in 339.0 seconds, and restoration in 303.0 seconds of preparation/publication
(398.7 seconds after requesting restoration, including preceding work). The car drove 59.53 m;
the height generation published during that drive. Across 45,104 observed frames, five terrain
probes had zero mesh/query mismatches; four returned exactly to their original sampled heights
and the fifth remained an opening. Final health was 100 with four wheel contacts. There were
16 frames with reduced contact and two recovery lifts totalling 0.599 m, including the artificial
upward step. These bounded probes do not certify the complete scene or all controller cases.

Six captured support discrepancies matched the visible tram bed to Rapier within 0.001 mm.
The recovery hint had sampled terrain beneath that bed; its 8.52 cm difference was not a
mesh/collider mismatch. The engine diagnostic now names that value `supportHintY` and the
comparison `hintToColliderDifferenceM`, and records the probe position. Actual receiver/physics
agreement retains its 1 mm acceptance tolerance.

The largest recorded publication boundary was 26.2 ms. During the profiled height capture,
ground preparation's largest item was 47 ms with zero items over 50 ms. Preparation latency is
still unacceptable, and separate physics/planning maxima remain open. This is not a matched
performance comparison: the viewport and admitted sources differ from v54. The
[v56 native evidence](../output/surface-audit/ground-implementation/ground-frozen-contract-v56/native/README.md)
records source closure, the drive, restoration, profile and limits. Chrome closed after restoration.

**3D opening geometry preparation (v56 onward, integration pending):** convex opening volumes now
clip actual receiver faces, including vertical walls and ceilings. This uses no viewport, texture or
DPR input. The shared receiver buffer adapter preserves source-face interpolation, normals, UV/color
seams and the original winding, rejects collapsed Float32 faces, caps output, and compacts buffers
before transfer. Actual Three and Rapier rays agree through a doorway and its retained lintel;
other focused cases cover slopes, overlapping volumes, protected islands, reversed winding,
adjacent face boundaries, cancellation and capacity rejection. Existing real Jelačić cut boundaries
and the bundled terrain Worker also pass after sharing the buffer adapter. These tests do **not**
yet establish planner/authored/water publication integration; that remains a step 3 requirement.
The [v57 receipt](../output/surface-audit/ground-implementation/ground-opening-volumes-v57/broad/headless-validation-receipt.json)
records **1,665/1,665 passing tests across 202 files**, with unchanged source hashes and HEAD.
Strict ceiling semantics also run through the actual terrain Worker, with an exact
coplanar fixture at y=0. The separate planner fixture retains a face at its y=1 ceiling
and clips one below it.

**Shared opening read and road adapter (v58):** a captured, immutable world-space opening read
now selects authored, station, planner and water boundaries using the existing surface claim
contract. A replacement excludes its own opening. Terrain layers, point queries and 3D receiver
clipping derive from that same read. Planner boundary preparation uses the actual civil join
function, including interpolated ramp joins and butt end caps; it rejects ambiguous or folded
joins. Its live producer has not yet adopted these boundaries.

The production road collector accepts this prepared read before render and collision buffers
split, and extracts retained terrain-cut boundaries from the resulting faces. The actual
publisher and Rapier test expose a replacement floor through the road, preserve neighbouring
support, and restore the previous world after an injected publication failure. This test first
rejected a T-junction in independently triangulated clipping fragments. Dissolving internal
fragment edges and reusing the existing validated polygon triangulator fixes the connectivity;
sloping-grid fixtures also validate closed hole boundaries. The
[v58 receipt](../output/surface-audit/ground-implementation/ground-opening-receivers-v58/broad/headless-validation-receipt.json)
records **1,678/1,678 passing tests across 204 files**, with unchanged source hashes and HEAD.
This is headless adapter evidence. Live opening producers and remaining receiver families still
need integration before native correctness or performance acceptance.

**First live authored opening participant (v59):** the shared ground graph now prepares the Grič
portal pose before solving road alignment, and supplies its captured opening to terrain, roads and
curbs. The actual instanced floor and shell supply a seventh, `authored-surfaces`, Rapier family.
Its visible pose, walking floor/wall queries, building passage, opening and physical faces publish
or roll back together. Adoption retires the former civil box colliders in the same transaction;
unchanged rigid geometry stays allocated. Curbs, ramps, seams and manholes clip before their render
and support buffers split. Tests use the actual Grič model, production publisher, Three raycasts
and real Rapier, including injected failure and cancellation after ticket creation. The
[v59 headless receipt](../output/surface-audit/ground-implementation/ground-authored-openings-v59/broad-r2/headless-validation-receipt.json)
records **1,682/1,682 passing tests across 205 files**, with unchanged source hashes and HEAD.

The first frozen v59 native startup **failed**: the new main-thread opening graph imports geometry
packages absent from the native HTML import maps. This is a rejected startup, not native acceptance.
The v60 maps supply the three geometry dependencies, and a full native module-graph regression
checks every HTML host, including a negative case with a required mapping removed. Subsequent
native runs reached the actual ground preparation and rejected two real receiver defects; they
are diagnostic evidence, not successful opening publication.

**Whole-receiver topology (v60–v62):** the v60 capture contains pre-existing zero-area connector
faces in a refined sidewalk. Preserve their source connectivity while keeping newly clipped faces
subject to the strict area/winding checks. The next v61 capture exposed a separate invariant:
**all incident triangles must use the same subdivision of a shared source edge**, including an
unchanged neighbour. Dissolving clipping fragments inside each triangle is insufficient. The
receiver compiler now gathers edge intersections across the complete bounded mesh and propagates
them to every incident face, with cooperative sorting/subdivision and the existing capacity limits.
Geometric identities remain separate from normal/UV vertices; unrelated coincident indexed
surfaces are not welded. This avoids both T-junctions and lost shading seams.

The captured 989-triangle sidewalk previously failed boundary extraction. The corrected result
has 999 triangles, of which one is the additional shared-edge split. Its retained area is
440.241787 m² versus 440.359810 m² before the opening. The regression independently raycasts the
original mesh to establish retained support, then checks the clipped Three and Rapier geometry
at 1,200 points for presence and height within 1 mm. Source order, opposite winding, cancellation
during conformity, capacity rejection and source-buffer immutability also pass. Expanding this
particular refined source to a nonindexed mesh loses required connectivity even before clipping;
that ambiguous input remains rejected. Separate valid nonindexed and UV-seam fixtures pass.
See the [captured native rejection](../output/surface-audit/ground-implementation/ground-gric-source-faces-v61/native/README.md)
and [real-receiver regression](../website/station-3d/__tests__/surface-opening-real-receiver.test.mjs).
The [v62 headless receipt](../output/surface-audit/ground-implementation/ground-edge-conformity-v62/broad/headless-validation-receipt.json)
records **1,689/1,689 tests across 207 files**, with unchanged source hashes and HEAD. Its native
run progressed past that sidewalk but rejected a different, nonindexed road-earthwork seam.
Projection triangulation produced a sliver whose three vertices all have provenance on one source
edge; Float32 rounding gave that one-dimensional fragment apparent area. These vertices now remain
shared-edge constraints without producing a surface face. The strict storage/winding guard on real
faces remains unchanged. The captured 168-face seam produces 176 valid faces, checked against the
original Three geometry and real Rapier with both vertical and face-normal rays. The
[v62 native diagnostic](../output/surface-audit/ground-implementation/ground-edge-conformity-v62/native/README.md)
is rejected evidence; native publication of the seam correction is still pending.

The shared curb/authored collision adapter also replaces centroid-radius rejection with conservative
triangle-bounds rejection. A large floor or wall intersecting the physics bubble must not disappear
because its centroid lies outside. An indexed/nonindexed regression includes a tangent wall, retained
large floor, distant geometry and indexed additional parts; real Three/Rapier rays agree within 1 mm.
Other authored/planner/water producers, rail and structural receiver clipping, and performance gates
remain open.

**Receiver batch representation (v63–v64):** the v63 frozen build passes clipping but rejects aggregate
assembly when a clipped seam is indexed and its retained neighbours are nonindexed. Index representation
is now a property of the complete prepared batch, not part of the fixed attribute schema. A batch with
any indexed part emits one indexed buffer; its implicit neighbours receive sequential indices during
the existing bounded copy stages. Fully nonindexed batches keep their previous layout. This preserves
one material/region draw and the original vertex/attribute buffers. Output admission counts all indices,
including those of retained neighbours. Tests cover both source orders, per-face picking/claim ranges,
removal of the final indexed owner, cooperative staging and exact rollback to the previous layout.
The captured native seam also runs through the production batcher with a retained nonindexed neighbour.
The [v63 headless receipt](../output/surface-audit/ground-implementation/ground-opening-edge-provenance-v63/broad-r2/headless-validation-receipt.json)
records **1,696/1,696 passing tests across 209 files** before that batch correction. Its
[native rejection](../output/surface-audit/ground-implementation/ground-opening-edge-provenance-v63/native/rejected-batch-schema.json)
does not establish complete publication; v64 native validation remains pending.

**Terrain storage domain (v65, 14 September):** v64 batch publication passed headless validation,
but native terrain preparation rejected Float32 slivers with `ground-topology-precision` and held
the old world. v65 normalizes captured cut operands once across the complete receiver storage
domain with a 1 mm halo; genuine input collapse is rejected before Boolean work and zero-area
stored fragments are omitted before triangulation. The captured tile expanded from 20,000 to
25,352 valid faces with unchanged source buffers. An independent 20,000-point check retained
19,087 points, removed 910, excluded 3 boundary points, and measured maximum height error
0.002515 mm. The [v65 broad receipt](../output/surface-audit/ground-implementation/ground-terrain-storage-domain-v65/broad/headless-validation-receipt.json)
records **1,712/1,712 passing tests across 212 files** with unchanged hashes.

The v65 native run did publish Grič generation, but this is diagnostic evidence only: first
preparation took 43.8 s and a later preparation 80 s; triangular road-earthwork/terrain
conflicts remained. The flat walking shortcut missed a 2 mm arch lip and selected tunnel floor
for a retained hill above. Vehicle claim activation occurred at 00:21:38Z; thereafter stationary
four-wheel contact recovery repeatedly lifted the vehicle by about 6 cm every 0.2 s. The saved
[static vehicle recovery artifact](../output/surface-audit/ground-implementation/ground-terrain-storage-domain-v65/native/static-vehicle-recovery.json)
reports 884 authored-surface triangles, 1,375 curb triangles, 12,773 road triangles, 741 fixed
bodies, 16,020 contact events, 32,039 impact events, 0.3 s discarded physics time, maximum
physics step 111.7 ms, maximum collider plan 107.4 ms, and the last player impact was lamp
`lamp:131118805:182:-374` at 444,648.84375 N. Health 88 was an actual lamp impact, not evidence
of ground damage. No visual, physics, movement, or performance acceptance is established.
The later unsealed receiver-mesh-read improvements are outside v65. Overall plan progress
remains approximately 40%; campaign bakes remain downstream.

**Authored support read (v66, 14 September):** the shared authored aggregate now publishes in
the native diagnostic. Exact captured Grič floor/lip geometry is available, but receiver conflicts
remain recorded in [conflicting-receivers.json](../output/surface-audit/ground-implementation/ground-authored-support-read-v66/native/conflicting-receivers.json).
At x=2.5 the walk result and analytic solved-road result are -0.113371157134 m, while the actual
Grič floor and captured read are about -0.226556606716 m; at x=5 the walk result is 1.112720021407 m from
`RoadAlignmentSurface:osm-431439467` face 0 while the floor remains -0.226556606716 m.
The v66 native browser run is closed. The actual controller activation timestamp was
2026-09-14T00:58:39.697Z. The recovery-ridge diagnostic reproduces invalid recovery: flat floor
recovery occurred 0 times, ridge recovery 36 times, and ridge without recovery 0 times over
360 steps. This is not native correctness, movement, or performance acceptance. Stage 3 and
the first production step of stage 4 remain active; overall progress remains approximately 40%.

**Physical floor corrections (v67, 14 September):** all 1,730 headless tests pass across 216
manifest files with unchanged source hashes. The native run now resolves both previously wrong
Grić entrance points to the actual floor, preserves the 2 mm arch lip, and retains the hill
above the tunnel. Procedural road structure floors consume the same opening topology and
publish their captured support in the shared aggregate; lateral walls retain their existing
collision adapter pending their own migration. See the [native record and exact probes](../output/surface-audit/ground-implementation/ground-physical-floor-v67/native/README.md).
Recovery probes now measure the actual physical chassis underside. The same native car records
42,437 physics steps, zero surface-recovery lifts, four wheel contacts and health 100, including
active physics during subsequent ground publications. Its position changed during later updates,
so this does not establish braking or seamless-update acceptance. Bootstrap and later preparation
delays of 71–236 seconds, further pending streamed work and broader visual conflicts remain open.

**Support query cost (v68, 14 September):** pedestrian support calls were raycasting the entire
rail group before rejecting sleepers, steel and fittings. Selecting eligible floor receivers
before intersection preserves all accepted hit tuples in 20 paired native probes, including
eight actual floor hits. The 12 ordinary actor queries cost 167.0 ms versus 2.4 ms in this narrow
diagnostic. The candidate passes all 1,731 headless tests; its native startup and matched movement
performance are not yet accepted. The frozen native build preserves the eight floor/lip/hill answers
and completes bootstrap in 40.36 seconds with no pending ground work or page errors. A normal-controller
walk over 258 frames follows the entrance floor and its 2 mm lip without becoming airborne; the
temporary 1.8 m/s speed is restored to Sloboda's 25 m/s free-roam setting afterwards. See the
[native record](../output/surface-audit/ground-implementation/ground-support-prefilter-v68/native/README.md).
These short movement checks establish entrance reachability; they do not establish complete tunnel
visuals or comparable scene performance. The query change preserves geometry, ownership, height
tolerances and sampling resolution. Stage 3 and the first production step of stage 4 remain active;
overall plan progress remains approximately 40%.

**Shared-engine integration (v48–v50, 13 September):** one coordinator captures source leases and
orders raw terrain → rail construction → road alignment/formation → final rail ownership → structures
→ rail/road/curb receivers → exact terrain topology → one optional six-family Rapier replacement.
All required members publish at the existing pre-controller boundary. Old and new rail collars/openings
enter the receiver dependency closure. An unchanged complete invalidation retained all 173 inventoried
terrain/road/rail/curb mesh publication identities. Failed deterministic/capacity candidates remain
blocked until new input; busy or superseded work uses bounded retries. Cleanup continues after an
individual release failure, and walk support caches observe successful publication before controller queries.

**Historical active physics and source replacement (v49–v50, superseded by v53):** physics admission retained the old support
region from the start of preparation. Previously the ordinary GTA collider refresh could replace that
region during the civil solve, invalidating every attempted successor. Moving beyond the retained region
released the admission so ordinary recentering could proceed. Real Rapier tests cover retention, release and
joint promotion; native v49 published complete groups with vehicle health 100 and four wheel contacts.
This does not establish moving-vehicle performance or the final terrain-update acceptance.

The v49 +0.5 m source replacement was **rejected**, with the old mesh/query support retained.
`TerrainReference.replaceGrid()` notified the coordinator, but only the streaming callers advanced mesh
cache signatures. With unchanged cutout shapes, the generic source API could therefore reuse old tiles
beside newly compiled neighbours; the seam validator correctly refused publication. In v50 the common
source-change handler owns these signatures and the neighbouring receiver halo. Streaming callers no
longer perform a second invalidation. Dirty tile bookkeeping is limited to resident/pending receivers.
The v50 on-foot diagnostic records the controlled +0.5 m publication with 12,844 observation frames and
five sample rays per frame, maximum terrain ray/query error below `1e-13 m`, and zero mismatches.
The four covered points moved by 0.5 m; the fifth stayed open in both mesh and receiver query. No vehicle
was active, so this does not measure vehicle contact or collider agreement. Preparation took 340.8 seconds;
the boundary took 26.5 ms. These are unsealed diagnostic timings, not accepted performance.
Its companion Jelačić audit covers all 14,400 samples but ran while the successor
was preparing (`ready=false`), so it describes retained visible ground rather than settled/release acceptance.
It records 97 claimed surfaces, including six parking/parking-marking flags, and retains the unknown-discard
caveat. See the [v50 diagnostic README](../output/surface-audit/ground-implementation/ground-receiver-cutouts-v50/diagnostic/README.md)
and [broad-r2 receipt](../output/surface-audit/ground-implementation/ground-receiver-cutouts-v50/broad-r2/headless-validation-receipt.json)
(1,617/1,617 headless tests; unchanged hashes). The v50 vehicle restore was subsequently rejected:
2,088 source owners were admitted but downstream preparation hit the ordinary 2,048-owner cap before
publication; the original restoration was not published before session close, while old elevated mesh/query
support and four-wheel health were held. This is not a native physics-update pass. Native v51 remains pending.
The v51 single canonical complete-generation owner limit is 16,384, while ordinary publication remains 2,048
and the 32 MiB geometry limit is preserved; the real 2,049-owner fixture passes. Overall progress remains
approximately 40%, with all-open performance and native-physics gates unchanged.
The real Worker test now exercises this handler and the production signature function; its former
revision-based signature stub could not expose this bug. The active-physics replacement remains unverified.

**Retained physical sidewalk cutouts (v50, native diagnostic recorded):** a same-level buffered sidewalk
retains its top, grade, collision and terrain seam. Its actual indexed boundary is prepared cooperatively,
cached with its road owner, and included in the same terrain publication as that receiver. Paint alone
does not authorize the cut; grade-separated receivers remain excluded. Final receiver cuts apply after
structural roof restoration. Region holes are local exclusions, so a hole in one receiver cannot restore
terrain removed by an independent opening. Terrain compiler 2.3.0 also supports height-bounded regions;
the planner/authored/water adapters have not yet adopted that capability.

The saved native receiver sample contains 89,653 triangles in 247 same-level sidewalk parts. Boundary
extraction produces 247 regions with 16,639 boundary vertices, avoiding one cutout operand per triangle.
Float32 refinement can collapse or invert extremely thin faces while preserving indexed connectivity:
the largest inverted-face width in that sample is 0.061 mm. The boundary compiler retains connectivity,
reports this loss and rejects folds or coincident-height disagreement above the existing 1 mm precision
limit. Saved real buffers, independent face-centroid coverage, holes/islands, capacity and cancellation
tests cover the compiler. These are geometry diagnostics, not GPU visibility or performance acceptance.

The [v48 broad-r2 receipt](../output/surface-audit/ground-implementation/ground-native-coordinator-v48/broad-r2/headless-validation-receipt.json)
records **1,605 passing tests across 195 files**, with 1,537 JS/MJS source hashes plus package/server
hashes unchanged during the run. It includes actual source/receiver/Three/Rapier publication, cleanup,
real captured cut boundaries, and a 34-bucket replacement retaining the previous world through every
preparation yield. Complete generations explicitly admit up to 256 road buckets/source tiles while
retaining the independent 32 MiB road geometry ceiling; the ordinary small road transaction limit remains 32.

The [native diagnostic](../output/surface-audit/ground-implementation/ground-native-coordinator-v48/diagnostic/README.md)
records the first successful complete generation, 49 published terrain tiles, 2.57 MiB retained receiver
buffers (4.15 MiB observed peak), and no publication failures. Independent Three raycasts match nullable
receiver/evidence height queries at all 961 sampled points, including four openings. Its 2.2 ms maximum
boundary commit is diagnostic, not paired performance evidence. This capture has no active vehicle
colliders and is not sealed release acceptance. Its audit also predates the correction that prevents an
analytic formation mask from concealing an uncut triangle in the exact-terrain material variant.

Two native failures corrected the preparation contract. Real formation polygons caused recursive/output-ring
failures in `polyclip-ts`; terrain clipping now uses pinned `clipper2-ts` 2.0.1-18 with bounded integer
coordinates, Earcut and independent directed-boundary/Float32 validation. The captured polygons remain
regression fixtures; another Boolean implementation and direct point coverage provide independent checks.
The receiver compiler formerly retained maximum-capacity backing buffers through typed-array subviews;
it now grows bounded working storage and returns exact-size buffers using cooperative copies. Both captured
large terrain requests compile to approximately 1.05 MiB each. Hard limits remain rejection ceilings,
not per-tile preallocations. No device dimensions participate in these contracts.

| Milestone | Implemented work | Evidence and remaining gate |
|---|---|---|
| 0 | Audit v3 retains material groups, per-part aggregate ownership, negative-ID intent, same-deck comparisons, duplicates within one mesh, and hashed raw CPU hit stacks. Local source/render/support readiness and spatial fingerprints replace count-only settlement. Unsupported instance/batch/skin bounds are recomputed; only intersecting or unknown bounds enter skipped counts, with the full skipped inventory retained. | Counterexample, replay, contract and recording tests pass. All seven v5 poses settled without page errors or missing coverage. The candidate fails the frozen Grič count gate described below. CPU intent/stack results do not establish GPU visibility or physical support. |
| 1 | Full road-source variants share one owner; explicit part provenance can split it. Exact content revisions, deterministic selection, collision-checked hashes, tile membership, pending leases and stale-publication rejection are implemented. | Real Koranska/Držićeva variants, both arrival orders, eviction/reload and ownership-boundary tests pass. All seven candidate v5 poses have zero duplicate interiors. The wider foundation budget is still not accepted. Retaining a source hole does not repair the old colour-mesh renderer's lost-hole path. |
| 2 | Terrain bounds enter the bounded curb dependency scan and durable publication ledger. Curbs and manholes rebuild together; cancelled/failed builds retain the obligation. | A controlled +0.5 m terrain-source injection moved 68 matched curb positions by 0.422–0.500 m and four manholes by 0.471–0.473 m. Collision positions matched rebuilt profiles; eight other tile roots stayed unchanged. The injection did not rebuild the displayed terrain, so this verifies dependent refresh, not whole-frame coherency. |
| Formation dependencies | Formation sources now share deterministic revision/part selection with roads. Same-ID source changes invalidate geometry caches. One staged compiler serves synchronous and cooperative callers. `RoadFormationModel.preparePublicationSteps()` now yields `{read, inputs, isCurrent, commit, rollback, discard, finalize}`; the same compiler prepares geometry-version, change and cache tables before the final pointer swap, and active queries cannot steal the held candidate. Neighbour discovery includes collars, old profiles stay stable, and contracted cutouts restore after removal. Completed per-road geometry generations drive bounded render rebuilds and stale-build rejection. Road parts request their own formation profile. Shared-wall suppression runs during cooperative preparation without changing published flags. Failed road rebuilds retain their obligation with bounded retries. Rail reuse shares compiled geometry while detaching mutable flags and alignment/run/access references. | Behavioral tests cover source replacement, exact-duplicate reuse, explicit parts, late neighbours with disjoint paved footprints, cutout restoration and the actual Grič inputs. Deferred rail tests preserve active flags at every yield and retain zero terrain resampling for unchanged features. A native Grič v6 capture has the same 545 flagged samples as candidate v5, but predates the latest changes listed below. A real production road-geometry plus Three raycast-registry test verifies swap/rollback. This prepared API is isolated; live terrain/masks/road/rail/curb/physics coordination remains unfinished. Time-sliced snapshot index copying checks each member against a 1 ms budget, while the compiled query graph remains one revision. These are dependency repairs; they do not complete step 3. |
| 3 prerequisites | The surface registry has `prepareBatch()`. GTA stages requested terrain, road, rail and curb collider replacements together as disabled Rapier bodies, preserving old support on allocation/capacity/staleness failure. The live road aggregate driver now joins its mesh, exact query index and affected GTA road colliders at the shared pre-controller boundary. Immutable terrain snapshots and a bounded tiled terrain query publication are also implemented. | Real Rapier raycast/resource and production-builder-boundary tests pass. Active capacity remains 1,200 colliders; staging is capped at 102. Actual worker packets, independent triangle queries and real Three/Rapier batch tests verify query/mesh/collider agreement and rollback in isolation. Coordinated live terrain, road, rail, curb, mask and physics promotion remains unfinished. |
| 4 production paving slice | `ground-composite-plan.js` supplies source planning/invalidation. Complete receiver-bound polygons produce R8 material IDs. Receiver shading reads immutable recipes and original repeating patterns, with captured roughness/metalness and normal influence. `ground-paint-update.js` plans bounded overlap copies and dirty-block replay; a fixed target pool, three-cascade layout and bounded cache controller reuse allocations and the shader program. Joined cache/query/Three/Rapier publication retires the old draped meshes. Physical road tops now have the correct orientation for receiver shading. | The v34 broad headless checks, native GPU v10 proof and matched Jelačić v34 static comparison below pass. Near repeating detail is restored; static flags fall from 2,302 to 24. Comparable movement, temporal/cascade appearance and wider shared-engine cutover remain open. Campaign bakes follow the completed engine work. |
| Performance tooling | Added authored-car `gta-drive` and dense-road scenarios, three interleaved native pairs, exact served-module/cache checks and sealed API replay. Existing bundled ABBA behavior is retained. | All 12 v34 captures pass harness admission. Survey movement improves; the settled scene costs 5–9% more in sampled frame-window time. One settled pair fails the stutter-count gate, and movement queue drain and individual-frame p95/p99 remain unverified. Full performance acceptance is open. |

**Current checkpoint (13 September):** ordinary same-level pedestrian
paving enters one shared receiver-bound material cache. Source/query publication, retirement of the old
draped meshes and affected road colliders use the common boundary. Raised or grade-separated surfaces
keep physical geometry. Regional source movement and eviction preserve ownership without repainting
unchanged pixels. The audit retains material intent and physical support as separate observations.

The [v34 headless receipt](../output/surface-audit/ground-implementation/ground-rail-scheduling-v34/broad/headless-validation-receipt.json)
records **1,438 passing tests across 172 files**, with unchanged hashes for 1,448 JS/MJS files and HEAD
`76f3346372647f2d3ae36f89808f45ea455cb144` during the run at 01:03 UTC on 13 September. This includes
actual road compiler orientation, independent frozen rail geometry, bounded queue work and cancellation
tests. The vehicle installer test with two independent session registries remains included.
Paint submissions share a 1 ms / eight-operation frame budget across source and detail work; this measures
CPU/driver submission, not GPU execution time.

The [v30 matched static comparison](../output/surface-audit/ground-implementation/ground-support-v30/fixed-pose-comparison.json)
is valid evidence of improvement at Jelačić: **2,302 → 123 flagged samples (94.7% fewer)**, with all 14,400
terrain, expected-paint, visible-ground and support samples covered on both sides. Inversions fell from
1,671 to 99, coplanar conflicts from 569 to 24, and floating samples from 62 to zero. Both runs have zero
page errors, identical detectors/options and sealed `sources-v7` responses, and remain paused at X/Z 0/0.
The screenshots were inspected: the competing white/grey paving patches disappear. Most remaining flags
involve painted terrain against retained buffered-sidewalk or road meshes; they cannot be dismissed as
unrelated structures or rail edges. Coverage counts establish presence, not complete terrain/physics
height agreement or conflict resolution. The paving slice and wider underpass/embankment gates remain open.

The v30 screenshots also show softer near-field paver detail. Its 128 m / 2,048-texel fine page has a
6.25 cm texel, so flattening the repeating bitmap into that page limits its detail. Material appearance
parity remains open: preserve fine repeating material detail in receiver shading, with the compositor
selecting coverage/material ownership, or demonstrate an adequately budgeted sampling alternative.
Do not change physical receivers or collision to solve this presentation issue. Any shader/texture change
must include its retained and staging allocations and repeat the affected performance comparison.

**13 September material correction, verified in isolation and the static production slice:** separate categorical coverage from
repeating material detail. Pages now store exact R8 material IDs; zero means uncovered. Receiver shading
looks up the immutable recipe and samples its original repeating pattern with explicit gradients. The
four-tap coverage filter rejects lower ranks before blending; an interior with four equal IDs shades its
material once. World UV phase is reduced in CPU double precision, and page bounds follow the floating
render origin without changing ownership or rebuilding pages. The old baked-albedo attachment is removed.

The paving slice reserves four 1,024² RGBA8 pattern layers, including full mip chains, for active and staged
material revisions. Referenced layers cannot be overwritten; preparation copies at most 16 rows or submits
one layer upload per scheduler item. A missing, changed-without-revision or over-capacity pattern rejects
the candidate. Retiring a page releases its pattern lease, while the original shared bitmap stays with its
existing owner. This changes material representation only; physical receivers and collision retain the
same contract. Temporal/cascade appearance and comparable movement remain acceptance gates.

The [native GPU v10 proof](../output/surface-audit/ground-implementation/paint-proof-native-v10/report.json)
compared **262,144 pixels** against direct sampling of the original texture, at magnification and
minification and at both ordinary and distant world coordinates: zero mismatches and zero byte error.
A separate 2 km render-origin shift changed colour bytes by at most one unit. Rank, holes, removal,
incremental page copies, stacked receivers and unchanged support checks also pass. The isolated standard
shader has three paint samplers. The later [v31 movement inventory](../output/surface-audit/ground-implementation/ground-material-v31/paired-final/movement-review.json)
finds five linked paint programs with **9, 14, 14, 9 and 9 active sampler units** in each candidate capture.
The fullest terrain variants include the existing terrain, urban, formation, cutout, environment and
shadow inputs. Counting the whole linked program conservatively bounds its fragment use below that
context's sixteen-unit limit. This verifies the captured variants, not every future shader combination.
The [provenance record](../output/surface-audit/ground-implementation/paint-proof-native-v10/provenance.json)
contains 19 matched, noncached requests, zero console/page errors and no changed source bytes. Chrome 153
used ANGLE Metal on the M1 Pro. Five page cleanup cycles retained zero geometries and two world-lifetime
textures (the pattern array and Three's shared DFG LUT); this is not a whole-session heap measurement.
The prior v9 capture remains rejected for a fixture favicon 404, fixed explicitly before v10.

The [v31 matched production comparison](../output/surface-audit/ground-implementation/ground-material-v31/fixed-pose-comparison.json)
retains **2,302 → 123 flags**, the same complete 14,400-sample coverage, identical detectors/options and
sealed static inputs. Both screenshots were inspected: v31 restores near paver detail without restoring
the competing white/grey patches. This is static appearance and coverage evidence, not a timing result.

**13 September orientation correction, verified headlessly and in the native production slice:** the road polygon compiler mapped
ShapeGeometry's XY plane to world XZ without reversing triangle winding. That reflection pointed its
tops downward; two-sided rendering concealed the mistake, but the paint shader's underside exclusion
then also excluded those road tops. The shared compiler now reverses the final triangle indices after
refinement, preserving the original tessellation, sampled relief and world UVs exactly. Reversing the
seed indices first changed refinement tie choices; an independent frozen nonlinear-height fixture
caught that, and the final-index correction passes it.
Four tests running the real flat, terrain-draped, engineered and aligned builders failed on downward
normals before the fix and pass afterwards, for both input ring orders. They also verify unchanged
heights and world UVs, visibility from above, underside rejection and independent deck ownership.
The [v34 matched native comparison](../output/surface-audit/ground-implementation/ground-rail-scheduling-v34/fixed-pose-comparison.json)
records **2,302 → 24 flags (99.0% fewer)** with all 14,400 terrain, expected-paint, visible-ground and
support samples present, identical detectors/options/inputs, and zero page errors. The screenshot was
inspected and near paving remains clear. The v34 raw report retains eleven inversions and thirteen coplanar samples
concern retained path heights, passive edging and parking markings; they are still outstanding ground
conflicts. Presence coverage does not establish complete terrain/physics height coherency.

| Current paving allocation estimate | Retained/staging maximum |
|---|---:|
| Four 2,048² R8 ownership layers, including the one successor | 16,777,216 B (16 MiB) |
| Four 1,024² RGBA8 repeating patterns, including every mip through 1² | 22,369,616 B (21.33 MiB) |
| Three page-local float material tables | 49,152 B |
| Total compositor textures | 39,195,984 B (37.38 MiB) |
| Existing 512² paver and 1,024² concrete source textures, including mips | 6,990,504 B (6.67 MiB), shared with other world materials |

These are format calculations, not measured driver allocations. CPU storage separately includes the
16 MiB pattern array and at most one 4 MiB canvas read during cooperative preparation, plus packet,
source and geometry storage already bounded elsewhere. Pattern mip generation is included in the upload
operation and must be measured; fewer stored bytes alone do not establish better frame time. The final
device check remains downstream of the shared-engine work.

Earlier unpaused static candidates moved and requested data beyond their recorded corpus; they remain
rejected. The static observer now pauses through normal simulation control after the vehicle actually
exists, verifies the pose throughout, and leaves render/build queues running. The first v29 driving
diagnostic retained all 21,466 road triangles in six colliders, but missing recorded responses and an
unavailable optional host-load reader rejected it. These diagnostic runs do not establish a performance
improvement.

The [completed v30 matrix review](../output/surface-audit/ground-implementation/ground-support-v30/paired/paired-review-v2.json)
retains all 12 scheduled captures. All six settled captures and three candidate drives are valid, but
two baseline drives lack recorded responses. Settled pair frame-median deltas are mixed: about +7.7%,
+13.3% and −14.8%. These are medians of sampled frame-average windows; their p95 values are not
individual-frame percentiles. The sole valid driving pair also covered different distances and speeds
under the same timed keys after the movement fix. **It does not establish comparable movement acceptance.**

Review also found that `rails:build` cell phase timers survived cooperative yields and counted intervening
frames as work. A behavioral test reproduced a 3 ms operation reported as 203 ms after a 200 ms wait;
the timer now starts per queue invocation. The old 177–284 ms rail-build phase readings cannot be used as
individual-item CPU timings. Other frame and owner measurements remain in the raw captures.

The current timing comparison uses a measured spatial corridor, with captured start and completed waypoints,
and a separate settled Jelačić case. Both frozen builds completed the full route preflight with 63 sampled
movement windows, four accepted waypoints, identical origins and no page/data errors. Every inherited
response remained unchanged, and the union was sealed as movement `sources-v6` (2,515 entries,
SHA-256 `e531c63cd4db8cdd6b58a835bdaadd377adcfc292aa6a16084d6d2ce544d9eb6`) before timing.
A 50 m route pilot was too short at the existing 25 m/s free-roam survey speed and is retained only as a
diagnostic. The replacement 400 m route runs twice out and back (approximately 64 s of movement).
The [v31 movement review](../output/surface-audit/ground-implementation/ground-material-v31/paired-final/movement-review.json)
retains all six accepted movement captures, each with the same origin and four completed waypoints.
Sampled frame-window median deltas are **+2.7%, +4.3% and +5.5%**. Actual single-call rail collar/wall
work reaches **53, 53 and 137 ms** in the three candidate runs; the 137 ms call occupies a 168.6 ms frame.
Those direct invocation timings are separate from the repaired cell phase timer above. All runs still
have pending work after the thirty-second settlement interval. Consequently these captures do not
establish overall performance acceptance. The matrix was deliberately stopped during its seventh slot
after the orientation and rail scheduling defects were identified; complete captures and the interrupted
slot are retained, without outcome-selected retries.

Rail collars, retaining walls, clipping/filtering, buffer copying and wall collider boxes now prepare
through the shared queue against one captured ground generation. Startup, movement, source, style and
crossing refreshes use that deferred path and keep the old complete geometry until CPU preparation and
GPU prewarm finish. Mesh positions, UVs, normals and collider boxes match an independent frozen v31
fixture with cut/fill, shared walls, clipped openings, steep collars, window filtering and multiple chunks.
Cancellation and errors release unattached materials/geometries; tests verify stale jobs never publish.
The v33 native check preserved the 24-flag result but exposed excessive scheduling latency from a small
item/frame cap. The v34 adapter batches at most 64 bounded generator steps or 0.25 ms per callback, under
the queue's 1 ms interactive frame allowance. Fixed 24,000-vertex mesh chunks still bound indivisible
normal/bounds and wall-UV work. The time allowance is cooperative, not a hard preemption guarantee.
The v34 native appearance/settlement check passes with the same 24 flags and complete sample coverage.
Its [first movement matrix review](../output/surface-audit/ground-implementation/ground-rail-scheduling-v34/paired/movement-review.json)
retains six captures: five pass harness admission, while baseline run 3 lacks two API responses at a
route-end tile boundary. The matrix was deliberately interrupted during slot 7. The first two pairs'
sampled frame-window medians improve by 3.3% and 14.4%; the invalid third pair supplies no comparison.
Candidate rail-dressing queue callback maxima are 6.0, 4.9 and 4.7 ms, with zero callbacks over 50 ms.
These queue maxima accumulate from startup through capture and are not movement-only measurements.
The first candidate retains an 834 ms frame marked host-busy, primarily attributed to pedestrian work;
it is neither removed from the result nor established as a compositor regression.
**There is still no overall performance acceptance.**

The replacement replay corpus adds continuous route/near-ring/look-ahead coverage, including the full
5 m along/across waypoint allowance, using the frozen engine's exact tile-bbox serialization. Its
[coverage receipt](../output/surface-audit/ground-implementation/ground-rail-scheduling-v34/source-coverage/extension-receipt.json)
records 312 added responses and 2,515 unchanged inherited responses. The
[four source-only native preflights](../output/surface-audit/ground-implementation/ground-rail-scheduling-v34/source-coverage/preflight-receipt.json)
pass for both frozen builds and both scenarios, without page/data errors. The corpus is sealed at 2,827
responses, SHA-256 `377736c25f6344705e4057e306d60583da61333db2cd26182d8b00c2d774a217`.
The timing harness correctly rejects recording runs as diagnostic-only; that verdict is preserved and
does not prevent their use to verify source coverage. The replacement
[12-capture matrix and raw-data review](../output/surface-audit/ground-implementation/ground-rail-scheduling-v34/paired-source-v7/review.json)
completed on 13 September at 02:38 UTC. Every capture passes harness admission, with matching source/code
hashes and no page/data errors. All six movement captures have 63 clean host windows. Two settled
candidate captures each retain one busy host window out of 59; no frames are removed.

| Scenario/pair | Baseline window median | Candidate window median | Change | Baseline/candidate stutters |
|---|---:|---:|---:|---:|
| 400 m survey 1 | 31.80 ms | 26.11 ms | −17.9% | 110 / 22 |
| 400 m survey 2 | 33.15 ms | 25.75 ms | −22.3% | 157 / 34 |
| 400 m survey 3 | 31.38 ms | 26.84 ms | −14.5% | 119 / 66 |
| Jelačić settled 1 | 22.35 ms | 23.51 ms | +5.2% | 18 / 22 |
| Jelačić settled 2 | 21.28 ms | 23.23 ms | +9.2% | 10 / 9 |
| Jelačić settled 3 | 21.97 ms | 23.38 ms | +6.4% | 20 / 15 |

These are medians of all sampled **frame-average windows**, not individual-frame percentiles. The
movement protocol is a 25 m/s on-foot survey, not physical car driving. Candidate rail-dressing callback
maxima are 4.4–4.6 ms in the movement captures and 4.7–5.3 ms in the settled captures, accumulated since
queue creation, with no callbacks over 50 ms. Separate rail-cell callbacks exceed 50 ms during some
startup runs in both builds; the raw review retains them. All settled-scene queues drain. The 30-second
post-movement phase leaves pending work in both builds, so it does not prove finite queue drain.
The first settled pair fails the retained stutter-count gate (22 versus a 19.8 ceiling). Its single
host-busy stutter remains included; it does not by itself explain the excess. Reported settled draw
counts are essentially unchanged. **Overall performance acceptance remains open**, including the true
individual-frame p95/p99, longer streaming/drain, physical driving and full engine coordination gates.

**Ownership-mask boundary integration (v35, headless and fixed-pose native verification passed):** the live terrain adapter now
prepares the replacement texture through the existing terrain queue and exposes a reversible mask entry.
Its texture, center, enabled state and publication metadata switch at the shared pre-controller boundary;
the previous texture retires only after the whole batch succeeds. Clearing the mask uses that boundary too.
Cancellation before upload, after upload and while waiting releases the private texture once. A failed
upload retains the old mask and one failed obligation until inputs change. Nine behavioral tests exercise
the production driver and actual registry, including rollback after a later support failure and a partially
failed commit. Registry shutdown now also discards staged texture/query/physics entries that have no
Three scene root. Reintroducing only the old `stagedRoot` guard in an isolated Node loader makes the new
shutdown regression fail; the unchanged working tree then passes **50 focused tests**. The
[v35 broad receipt](../output/surface-audit/ground-implementation/ground-mask-boundary-v35/broad-r2/headless-validation-receipt.json)
records **1,447 passing tests across 173 files**, with unchanged hashes for 1,449 non-ignored JS/MJS source
files. The source test manifest excludes ignored generated distributions; the native freeze records
their unchanged inherited hashes separately. This change is not included in the frozen v34 timing candidate.

The [native v35 review](../output/surface-audit/ground-implementation/ground-mask-boundary-v35/native-review.json)
pins the same source corpus, pose and options as v34. The retained image was inspected: paving detail and
coverage remain intact, with **24 flags (11 inversions, 13 coplanar)** and 14,400 covered terrain, expected
paint, visible-ground and support samples. There are no page/data errors. The mask's published and active
revisions agree, with no pending mask task or publication. Of 70 observed texture initializations,
69 tracked textures retired and one remained active; every initialization disabled mip generation.
Maximum `initTexture()` CPU submission was 0.2 ms, and the shared ground boundary's maximum commit was
0.7 ms across this capture. Neither measures completed GPU work or driver residency. The visible M1 Pro
Metal session closed cleanly. Two earlier probe attempts failed before scene readiness and are retained
as rejected artifacts; the successful probe polls the renderer's live export synchronously.
Movement, complete dependency coordination and five-cycle teardown remain separate gates.

The 3,072² ownership mask uses `LinearFilter` without mip selection. Its unused mip generation is disabled:
one RGBA8 level is 36 MiB, and old plus prewarmed replacement is at most 72 MiB of mask texture storage,
separate from the compositor allocation table and CPU canvases. This is a layout estimate, not driver
residency measurement. The adapter makes the mask joinable; **it does not yet prove that the formation
model's replacement geometry/support is ready, or join that replacement to the mask batch**. The full
terrain/dependent transaction below remains required.

**Terrain collider preparation (v36, headless and fixed-pose native verification passed):** moving
terrain refreshes now use cooperative sampling, vertex/triangle preparation and cutout-index construction
through the existing GTA queue. The terrain read, lattice spacing and physics origin are captured once;
terrain changes, pending detail windows, road geometry/publication revisions, rail crossing mutations and
rendered-rail replacement invalidate an unfinished candidate. Cutout queries detach their ring coordinates.
An explicit candidate can supply its own retained terrain read and cutout query without querying live
ground. Vehicle entry drains the same compiler before chassis allocation. The flat-mode callback still
has no snapshot API, so its fixed 33×33 height capture remains synchronous; do not present this as a
complete bounded-work guarantee for every ground provider.

The [v36 headless receipt](../output/surface-audit/ground-implementation/ground-collider-preparation-v36/broad/headless-validation-receipt.json)
records **1,461 passing tests across 174 files**, with unchanged hashes for 1,450 non-ignored JS/MJS
files. Three pre-refactor geometry fixtures remain byte-identical. The actual moving GTA driver plus
Rapier verifies old support through preparation, boundary-only promotion, cancellation, seven source/origin
invalidations and release of captured reads. An explicit-candidate test caught and removed an accidental
live cutout-provider lookup. These checks establish preparation and lifetime behavior, not full step 3.
Individual formation-profile queries and Rapier installation still require native cost checks; the
seven-point cutout heuristic and the complete terrain/dependent publication group remain unresolved.

The [native v36 review](../output/surface-audit/ground-implementation/ground-collider-preparation-v36/native-review.json)
verifies identical pose, options and recorded sources against v35: **24 flags (11 inversions, 13 coplanar)**,
all 14,400 terrain/paint/visible-ground/support samples covered, and zero page/data errors. Six live GTA
bubble generations published; preparation, failure and fixed-build/retirement queues were empty at capture.
The inspected image preserves paving detail. The mask and shared boundary settled, with 70 of 71 observed
mask textures retired and one active. The boundary's observed maximum commit was 11.7 ms; this diagnostic
capture is not paired clean-host timing evidence. It does not establish physical driving, movement
performance or full-generation coherency. The automation browser closed after capture.

**Curb boundary and shared physics adapter (v37):** live curb builds and evictions now prepare detached
geometry, exact support buffers and the affected GTA replacement before the common boundary. Tile readiness
and rebuild acknowledgement follow the successful complete swap. Cancellation and rollback preserve old
support and newer rebuild obligations; stale eviction attempts retain a bounded retry obligation. The CPU
compiler checks its budget per triangle and splits profiles, ramps, seams and manholes into at most 24,000
vertices per mesh. Shared materials survive outstanding asynchronous shader preparation during teardown.
The former road-only physics joining API is replaced by `captureGroundPublicationRegion(families)`: one
capture can prepare all six ground families into one disabled collider reservation. Explicit missing family
reads and truncated coverage are rejected. This is a shared engine API; screen dimensions do not enter it.

The [v37 headless receipt](../output/surface-audit/ground-implementation/ground-curb-boundary-v37/broad/headless-validation-receipt.json)
records **1,474 passing tests across 176 files**, with 1,454 non-ignored JS/MJS hashes unchanged during the
run. Actual Three.js/Rapier tests cover the live curb publication generator, failed swaps, cancellation and
empty replacement; multi-tile tests retain unchanged support and combine changed rows into one physics
request. The [native review](../output/surface-audit/ground-implementation/ground-curb-boundary-v37/native-review.json)
uses frozen code `6f29c884…` and the same source cassette/pose as v36: 24 flags, all 14,400 ground/support
samples covered, 665 curb triangles without truncation, and no pending/failed curb or physics work. The
inspected image preserves paving detail. The boundary completed 366 publications with no failures; its
1.2 ms observed maximum is diagnostic, not paired movement performance evidence. The browser closed.
Full terrain/road/rail dependency coordination, opening topology, movement and repeated teardown remain
required before declaring step 3 complete. The first broad run's obsolete source-text assertion is retained
as a rejected receipt and replaced by a compiled visible/support collar witness.

**Rail publication boundary (v38–39):** full and partial rail rebuilds now prepare changed cell roots,
the sampled alignment, walk support, rendered coverage and affected GTA families as one reversible group.
Unchanged cells retain their owners; protected cells retain their complete previous support. A new
formation stays private through geometry and GPU preparation. Actual Three.js/Rapier tests exercise
every preparation yield, failed commits, stale cancellation, empty replacement and partial rebuilds.
The [v39 broad receipt](../output/surface-audit/ground-implementation/ground-rail-boundary-v39/broad/headless-validation-receipt.json)
records **1,486 passing tests in 178 files** with unchanged source hashes during the run.

The v38 native attempt is retained as rejected: a superseded collider request could remain failed while
paused because its retry depended on simulation time. v39 runs the existing bounded wall-clock retry in
that state, including its three-attempt cap. The [root native review](../output/surface-audit/ground-implementation/ground-rail-boundary-v39/native-review.json)
verifies frozen code `589f0aff…`, identical sources/pose/options/coverage to v37, 24 flags, zero page errors,
two GTA bubble publications, 468 rail and 665 curb triangles without truncation, and no pending/failed
physics work. The inspected image retains continuous paving and detail. The boundary recorded 347
publications, one cancellation and no failures; its 1.9 ms maximum is diagnostic. The browser closed.
Crossing-only profile mutation, complete terrain dependency coordination, opening topology and movement
acceptance remain open; this fixed pose does not complete step 3 or the performance gate.

**Private crossing generations (v40):** road-driven wall suppression and opening flags now change a
private compiled rail successor. The aligned track geometry is retained; wall/collar chunks, the formation
read, civil fingerprint, coverage, crossing acknowledgements and matching GTA dressing inputs publish
together. Failed commits restore every old chunk, including suffixed chunks. Unchanged flag passes
acknowledge their inputs without replacing the formation or trackbed index. Detection and flag scans yield
through unsuccessful searches too, and unavailable terrain evidence no longer becomes an at-grade crossing.
Nested opening intervals are copied and frozen in captured reads. Headless tests exercise private flags
at every yield, exact owner release, stale inputs, changed/no-op passes, and Three.js/Rapier rollback.

The [v40 broad receipt](../output/surface-audit/ground-implementation/ground-crossing-boundary-v40/broad/headless-validation-receipt.json)
has **1,510 passing tests in 181 files**, with unchanged hashes. The inspected
[native capture](../output/surface-audit/ground-implementation/ground-crossing-boundary-v40/native-review.json)
uses frozen code `a06ff4ec…` and the same sources/pose/options/coverage as v39: 24 flags, zero page errors,
settled rail/physics work, two GTA bubbles, and no truncation. It records 356 boundary publications with no
failures/cancellations; 0.7 ms maximum is diagnostic. This pose has zero active rail formation dressing
triangles, so it establishes startup/readiness and paving continuity, while the changed-wall witnesses are
headless. Full terrain dependency coordination, structural opening cases and performance acceptance remain.

**Prepared road alignments (v41):** the existing vertical alignment compiler now yields through axis
indexing, terrain readiness, profile/grade solving, station sorting, companion matching and opening rings.
`RoadVerticalAlignmentModel.preparePublicationSteps()` exposes the prepared query plus reversible
commit/rollback/discard/finalize operations. Active queries retain their previous generation after admission,
including after cancellation; missing terrain rejects the successor rather than deleting the active profile.
Unchanged local alignments retain their original sampler. Suspended query preparation is closed on disposal,
and candidate consumers explicitly retain their read when they outlive publication.

The [v41 broad receipt](../output/surface-audit/ground-implementation/ground-alignment-preparation-v41/broad/headless-validation-receipt.json)
records **1,527 passing tests in 183 files**, with unchanged source hashes during the run. Actual registry
and frame-boundary tests cover an upstream promotion followed by alignment commit, later-member failure,
exact rollback and retry. Lifetime tests include the real retained terrain provider. Four independent frozen
geometry fixtures and [120 varied comparisons](../output/surface-audit/ground-implementation/ground-alignment-preparation-v41/geometry-comparison.json)
match v40 profile rows, companion ownership, portal/cutout geometry and query outputs exactly. The original
invalid fixture capture and the broad run with an obsolete fixed-yield assumption are retained as rejected
evidence. This prepares the alignment dependency API; live terrain coordination and native movement
acceptance are still open. No new native or performance result is claimed by this checkpoint.

**Shared cutout topology and receiver support (v42):** the terrain Worker can now compile ordered
formation cuts, protected areas and later openings into the actual receiver triangles. The source
lattice remains explicit for height/diagonal validation; a source-face index lets physics select nearby
cells from the clipped receiver without repeating a polygon operation. The prepared terrain provider
retains those exact buffers across commit/rollback and old readers, with a separate mandatory receiver
byte budget that counts backing buffers and staging peaks. Missing receiver tiles reject support;
a fully cut, known tile is a valid empty result. This contract does not accommodate old campaign bakes.

The compiler uses pinned `polyclip-ts` 0.16.8, Earcut 3.2.3 and `robust-predicates` 2.0.4. It normalizes
nonzero-winding paths, applies the ordered operations, and intersects each source triangle once.
Independent coverage probes caught valid star/crossing paths rejected by the first operation order.
Exact collinear junctions are now subdivided before directed-boundary validation; an equal-area
overlapping triangulation is explicitly rejected. Float32 storage must preserve face orientation and
the 1 mm coordinate/height tolerance. Indexed boundary exclusion proves constant winding in interior
cells; small holes and protected islands inside a cell still enter clipping.

The [v42 broad receipt](../output/surface-audit/ground-implementation/ground-topology-v42/broad/headless-validation-receipt.json)
records **1,547 passing tests in 185 files**, with source, package and dev-server hashes unchanged.
A real Worker runs the native bundle, transfers the source/receiver buffers, then the actual Three.js
upload, prepared terrain provider and Rapier agree on the small-opening counterexample. Tests also cover
chunk selection, missing coverage, capacity failure, rollback and retained receiver memory. Native
development bundles the same Worker on request because Workers do not inherit a page import map;
production already bundles that entry. No extra Worker or main-thread clipping path is introduced.

The [local cost probe](../output/surface-audit/ground-implementation/ground-topology-v42/benchmark-isolated-host.json)
measured an approximately **11.8 ms maximum individual clipping call** for the 100-vertex star on a
clean host. This is why the new operation runs in the existing terrain Worker. Earlier in-process host
readings were affected by Node/V8 tier changes and are retained as rejected timing evidence. The isolated
probe is not native movement acceptance, nor evidence that the live opening race is fixed. **Live requests
still need the captured cutout generation, and the complete terrain/dependent group remains unconnected.**
The tested complexity limits are not yet the live regional admission budget. Step 3 remains incomplete.

**Prepared dependency consumption, v43 (13 September):** road formation accepts a captured terrain,
rail and alignment graph; road rendering consumes its prepared query and inputs without advancing the
active model or replacing the ordinary build cache. Commit guards distinguish the member's own state
from an earlier member's promotion. Cancellation/disposal tests retain old support, close partial read
owners and reject resumed cancelled generators; retained render reads survive producer retirement.
The [headless receipt](../output/surface-audit/ground-implementation/ground-dependency-preparation-v43/broad/headless-validation-receipt.json)
records **1,552 passing tests in 186 files** with unchanged source hashes. The rejected first run could
not bind its localhost HTTP fixture inside the sandbox; the same manifest passed with local binding
enabled. A subsequent focused HTTP check strengthens GET/HEAD header, body and cleanup assertions.
These adapters support the complete group; receiver assembly and live coordinator wiring remain open.

**Road receiver preparation, v44 (13 September):** the production road geometry collector now feeds
private aggregate, support and footprint replacements without changing active source tables. Paint
owner changes use the same compositor compiler and remain private until commit. A two-owner test uses
the actual Three/query/Rapier adapters to move one road between buckets while retaining its neighbor,
observes old output at every preparation yield, injects a late group failure, and verifies rollback/retry.
Cancellation tests also caught a conflict between coordinator ids and ordinary road revision counters;
both paths now allocate publication tickets from the same sequence. An older pending bucket group must
settle before its source parts can be admitted as retained inputs. The
[headless receipt](../output/surface-audit/ground-implementation/ground-receiver-preparation-v44/broad/headless-validation-receipt.json)
records **1,558 passing tests in 187 files**, with unchanged source hashes. The first live paving path
uses the extracted collector and strengthened paint ownership checks. The complete receiver replacement
adapter still needs the live coordinator; this is neither step 3 completion nor native acceptance.

**Receiver input transactions, v45 (13 September):** roads and curbs now admit captured source
membership and prepare their actual geometry against the supplied ground generation. Tile membership,
support and geometry commit together; missing height evidence preserves the old receiver. Rail preparation
uses the ordinary visual compiler but hands its reversible entries to the shared group, without acquiring
an independent physics reservation. Cancellation and late failure release retained inputs and admission
leases. Tests observe actual Three/query geometry through preparation, rollback and retry, and combine
rail and curb collider families in one Rapier reservation. The
[headless receipt](../output/surface-audit/ground-implementation/ground-receiver-inputs-v45/broad/headless-validation-receipt.json)
records **1,568 passing tests in 188 files**, with unchanged hashes for 1,524 JS/MJS files, package metadata
and the development server. The initial rejected run contained two obsolete source assertions; corrected
assertions and the entire manifest passed. These are shared preparation adapters; live coordination and
native acceptance remain open.

**Structure transactions, v46 (13 September):** the existing civil compiler now accepts the prepared
road read for pillar clearance and produces reversible deck, tunnel, wall and collar entries. Source
road removal requires the matching compiled alignment rows/definition on the actual root, as well as OSM
membership. The mask commit also accepts an earlier member's successful promotion after the shared
preflight. Actual Three geometry tests translate complete bridge/underpass receivers by 4 m, preserve
old geometry at every yield, roll both structures back after a late failure, and verify unchanged-root
reuse and cancellation/resource cleanup. The
[broad receipt](../output/surface-audit/ground-implementation/ground-structure-transaction-v46/broad/headless-validation-receipt.json)
records **1,571 passing tests in 189 files**, with source/package/server hashes unchanged.
The [native checkpoint](../output/surface-audit/ground-implementation/ground-structure-transaction-v46/native-review.json)
uses the sealed Jelačić inputs and a frozen development Worker bundle with recorded input hashes. It
retains **24 flags**, all four 14,400-sample coverage counts, 468 rail-bed and 665 curb collider triangles,
and zero page errors or pending/failed physics work. The inspected paving image retains near detail;
the owned browser closed. This verifies the normal path after the adapters/refactors, not live whole-group
cutover, changed-structure native acceptance or movement performance.

**Terrain receiver and civil order preparation, v47 (13 September):** the real development Worker now
feeds a prepared multi-tile receiver/query transaction through the ordinary terrain upload path. Tests
retain old tiles during preparation, preserve a small opening within a coarse triangle in both drawing
and support, roll back a late group failure, and retry against a later captured source. Rail construction
and final road-induced withdrawals have separate retained reads; an actual underpass removes batter
support only from the final receiver. Path rendering consumes that final read while road profile inputs
keep construction ground. The
[broad receipt](../output/surface-audit/ground-implementation/ground-terrain-order-v47/broad/headless-validation-receipt.json)
records **1,576 passing tests in 190 files**, with unchanged source/package/server hashes. These are
headless preparation and lifetime checks; live coordinator activation and native movement acceptance
remain required.

The native road capture demonstrated why the old 8,000-triangle collider cap is insufficient: complete
110 m bubbles contained 16,620 and 23,400 triangles. The shared compiler now admits up to 65,536 triangles,
partitions native meshes at 4,096 triangles, and prepares movement refreshes through `FrameChunkQueue`
before the common boundary. Overflow retains old complete support. The total active/staging collider caps
remain 1,200/102, with at most 96 road chunks. The
[recorded geometry check](../output/surface-audit/ground-implementation/ground-support-v29/recorded-road-parity.json)
preserves every triangle and matches 5,043 real Rapier rays across three recorded bubbles; the largest
uses six chunks and 1,123,200 bytes of final vertex/index buffers. That figure excludes Rapier's internal
allocation and temporary compiler storage. Tests also caught and fixed a Rapier staging hazard: every
new collider must be disabled explicitly when construction spans physics steps, even with a disabled parent.

**Movement invariant:** preparing a private replacement must not stop a vehicle that still has complete
committed coverage. The initial queued implementation incorrectly reused the unsupported-ground stop path
and cleared velocity during ordinary refreshes. The v30 controller now continues physics inside the
intersection of the committed ground families' coverage, allowing for the vehicle footprint, travel over one
maximum physics interval and a 1 m margin. It holds at missing evidence or the coverage edge. Coverage
metadata publishes and rolls back with its collider set; an explicitly compiled empty family differs from a
missing family. A failed refresh retries at most three times for unchanged source evidence and refresh cell;
sub-metre driving cannot restart the retry loop. Actual controller and Rapier tests cover these cases.
Native verification of this correction and comparable movement acceptance remain open, as does the full
terrain/road/rail/curb/mask coordinator. Screen size and device policy do not enter these rules.

At **11:37 UTC**, the selected broad ground and rail group passed **1,121 tests, zero failures** across
135 test files (`/tmp/station3d-ground-road-aggregate-current.log`; exact deduplicated selection in
`/tmp/station3d-ground-road-aggregate-files.txt`). It includes the latest live aggregate, curb rollback/retry,
prepared geometry-batcher and rendered-support tests, alongside foundation, formation, compositor planning,
Rapier staging and audit/performance harness contracts. This is headless behavioral evidence, not measured
WebGL frame time or complete repository release acceptance. The count differs from the earlier 1,120-test
run because three behavioral aggregate tests replace two source-shape assertions. The remaining changed
registry call-site assertion is corrected and passes. Focused selections overlap this broad run and must
not be added to its count.

The tiled terrain query prototype retains a sampler per published mesh tile, preserves the session datum,
validates the actual packet's vertices and triangle diagonal, and checks both coarse and fine edge knots.
A seam mismatch rejects the region and requires its dependency set to expand. Limits cover tile count,
changed tiles, source snapshots, retained read views, source buffers and tessellation. An explicit owner
can capture the active or prepared tile table. Derived callbacks acquire their own `retain(owner)` handle;
the shared height queries remain immutable until the last retained owner calls `release()`.
Retained readers count toward the old/new source peak, deduplicated by buffer identity. Cancelled candidates
cannot hide buffers still owned by a consumer, and closing the session revokes those reads. Eleven focused
terrain tests cover these limits, worker triangles, seams and Three/Rapier publication. This is **not an
accounting of all CPU caches or GPU resources**. The active world still uses raw `TerrainReference`;
the tiled provider has not replaced it. The generic capture helper forwards explicit read owners.
Candidate preparation yields;
commit swaps a prepared table, and notification follows the complete registry batch. Registry `prepareBatch()`
now accepts explicit rootless clear entries; row/group `isCurrent` guards run at preparation and publication.
Failed, stale or cancelled groups retain old roots and support, while rootless non-mesh staging is discarded once.
An explicit `false` commit result rejects and rolls back the group; ordinary no-op mutations use void callbacks.

Road query snapshots require captured upstream callbacks and detach publication readiness. They do not
inherit a live terrain/alignment callback or copy the mutable compiler/cache object. The formation dressing
query cache now lives in a WeakMap so a read-only profile can be queried without acquiring mutable fields.
Road polygons, bike paint, path seams and pedestrian edging now receive explicit captured ground inputs.

The live road input factory, formation compiler, render-input cache, road/bicycle builders and curb
preparation now carry explicit retained-read handles. Cancellation, supersession, ordinary publication,
group rollback/discard/finalize and session disposal release the appropriate owners. The shared capture
keeps one waiting-job owner until its last consumer finishes; replacing the cache cannot invalidate a
consumer that has not yet received its result. Readers share compiled arrays and callbacks; acquiring a
handle does not copy those arrays. Alignment caches retain each distinct terrain sampler required by
their reused analytic profiles. Alignment query views and road-structure jobs retain those dependencies
independently. Pillar bases and approach walls use the alignment's captured sampler. Stale structure jobs
cancel before another stage can publish. Rail factories also transfer their captured terrain to the model;
retained rail query views keep independent owners when the model retires. Superseded and failed candidate
models release their inputs. The curb rail-cut index keys on the shared profile array plus revision/mutation,
so distinct read handles do not rebuild the same index and changed crossing flags still invalidate it.

A failed rail compilation now retains its rebuild obligation and old published model without resuming a
failed iterator or throwing on every subsequent frame. Changed inputs allow a new attempt. Read-capacity
failure also reacts to a monotonic release counter exposed by the tiled provider, read in O(1); it records
that counter after cleaning up its own attempt, so self-cleanup cannot create a retry loop. The preload
diagnostic exposes the pending failure.

The main deferred rail visual refresh now retains the shared road/curb input graph for its trackbed,
terrain resampling, dressing and structures. Its proposal-mask read also preserves LineString decisions,
including authored rail exemptions. Preparation advances through the existing delivery stages, then
rechecks input currentness before publication. Changed inputs discard the detached candidate and preserve
one replacement obligation; exceptions keep a failed obligation until input/capacity changes. Cancellation
closes an unfinished shared capture and releases its owners. Road invalidation consults bounded change
histories over the rail render window; an unrelated road publication does not alone restart that work.
Rail support memoization uses source identity plus compiled geometry/publication revisions, so retained
query facades can reuse endpoint answers without hiding readiness changes. Viaduct road-clearance tests
receive that captured road view.

The subsequent v18 change covers the three deferred partial paths too: embedded-tram resampling,
crossing collars/walls and standalone viaduct/tunnel refreshes retain their captured inputs until
completion or cancellation. Crossing replacements now use the existing GPU delivery queue before swap.
Upload exceptions become recorded failures instead of recreating the upload on every frame. Stale embedded
work retains its original bounds and intervening road changes; it checks captured source-array identity
as well as query inputs. Its array publication enqueues both support and cell rebuilds without yielding
between those obligations. Those dependent queues still publish independently: this is **not** full
mesh/support coherency. Source terrain, road-index/water evidence, synchronous road-carried tram updates,
GTA consumers and the complete dependent publication remain separate.

At **16:21 UTC**, v18 passed **1,322 tests across 158 files**, with zero failures or skipped/cancelled
tests. The selection, log, receipt and before/after hashes are in
`output/surface-audit/ground-implementation/ground-rail-partial-read-v18/`; all 1,438 inventoried
runtime/test/tool files stayed unchanged. This is the worktree over `6c14b59e`, including uncommitted ground
changes. Thirty-one overlapping lifetime tests include actual retained query graphs and the actual upload
queue callback, with geometry/GPU factories represented by orchestration spies. They verify old chunk
retention until readiness, stale candidate disposal, last-owner release, failure recovery, 60 unchanged
failure visits without requeue, and both embedded dependency notifications before the next yield. The
stronger tests exposed two fixture assumptions (retired producers must reject publication; sampled heights
need numerical tolerance), which were corrected without relaxing the runtime guards. This is headless
evidence only; the v17 native capture below predates these partial-path changes.

Streamed raw, captured and tiled query providers now expose `sampleStepMForBounds()`: an origin-aligned common subdivision
over the complete collider footprint, with a maximum of 256 tile visits. For 4 m/20 m it returns 4 m;
for 8 m/20 m it also returns 4 m, rather than the incompatible minimum of 8 m. GTA rejects invalid or
over-budget grids before sampling or allocating them. Its geometry cap is 131,072 vertices, separately
from collider-body limits. Real Rapier raycasts verify a mixed 8 m/20 m piecewise-planar fixture.
These are admission bounds, **not** measured preparation-time budgets. GTA's construction and
ordinary publication are still synchronous/independent; this does not complete coordinated publication.

At **16:53 UTC**, v19 passed **1,328 tests across 159 files**, with zero failures or skipped/cancelled tests.
Its manifest, log and receipt are in `output/surface-audit/ground-implementation/ground-terrain-lattice-v19/`;
all 1,440 inventoried source/test/tool files stayed unchanged over `6c14b59e` plus these uncommitted changes.
The temporary v20 adapter for existing baked triangles was removed following the downstream-bake clarification;
its receipt does not describe the current implementation. Existing campaign providers must be regenerated
with the final receiver/support contract, including grid topology and cuts where applicable. Headless results
do not establish native production or movement acceptance.

At **15:16 UTC**, the preceding broad selection passed **1,310 tests across 158 files**, with zero failures
or skipped/cancelled tests. The exact selection, log and before/after hashes are retained in
`output/surface-audit/ground-implementation/ground-rail-visual-read-v17/`; all 1,438 inventoried source/test
files stayed unchanged during that run. This validates the worktree over `6c14b59e`, including uncommitted
ground changes, rather than the earlier checkpoint alone. The preceding 1,303-test run had one child-process
timeout and one obsolete rail source-shape assertion; the next 1,310-test run had one obsolete proposal
mask assertion. Those failed runs remain in the logs. The proposal assertion now executes the actual compiler's
selection prefix to verify captured masks and authored rail ownership. No readiness or performance gate was relaxed.

The frozen v17 desktop Jelačić capture reached settled readiness at **15:31:24 UTC** with no page
errors and no pending rail work. The live frame boundary published 49 terrain updates, with zero failures
or cancellations. All 14,400 samples were captured; **2,302 remained flagged**, matching the earlier
Jelačić capture. The inspected screenshot still shows overlapping paving, so the hierarchy fix is incomplete.
This one stationary native capture validates loading/settlement only: no surface-count budget was requested,
and it is not a movement or GPU-memory performance pass. Startup/settlement ran on a loaded host;
do not interpret the observed 0.3 ms maximum boundary commit as a comparative improvement over v15.
The native files are in `output/surface-audit/ground-implementation/ground-rail-visual-read-v17-native/`.
Its frozen app hash is `486aea5d31d9d94c033bbc09e4e3b72285eabce8cfcfab82e2753dac0f3d7e47`, using the same
sealed `sources-v2` cassette (`6c15a25914a52e550904afd781de8fadfa9b90c77b13841b3f445108f0725dfe`). The receipt lists
18 owned runtime overlays on frozen v15; unrelated later campaign/lift work was excluded. The dedicated
Chrome was closed and its absence verified after capture.

The v17 overlapping rail visual focused selection passed **83 tests** across four files. Nineteen lifetime tests
exercise the real tiled terrain provider, road cache retirement, delayed consumers, partial admission
failure, alignment reuse, curb cancellation, rail retirement/failure/recovery and the production structure
queue with the real frame scheduler. The new rail visual tests execute the actual preparation/currentness
functions with real retained query graphs; geometry emission and GPU upload are orchestration spies.
These are overlapping headless selections, not a movement or performance pass. Tests must retain a callback beyond its producer's retirement and
then verify that releasing its last consumer removes the old source from the retained-buffer budget.
Concurrent feature builds share one cooperative query-capture job, including its in-progress work.
Completed views are reused; local road-publication changes are checked through bounded histories so a
distant owner does not restart an unrelated partial road. Tests change terrain between actual geometry
slices, verify every vertex against the old queries, and exercise concurrent capture and cancellation.
Other builders and the common terrain/receiver promotion still need integration.

Checkpoint `73959798dcb3f7f1b47dba92a53e9dac70202a7e` was committed and pushed to `main` on
2026-09-12. Its exact staged tree passed **1,151 tests across 141 files**, after resolving the test
export's root and `tests/` dependency directories. This checkpoint includes only this ground task's
114 source, documentation and regression-fixture files. It does not establish movement-performance
acceptance or finish the shared coordinator/compositor. Work described below after this checkpoint
requires its own validation.

The subsequent owned-footprint, proposal-mask and GTA adapter state passed **1,278 tests across 155
files**. The retained selection is `/tmp/station3d-ground-publication-current-files.txt` and the log is
`/tmp/station3d-ground-publication-current.log`. This selection explicitly includes the actual GTA adapter,
fixed-surface transaction and terrain/road generation tests; the preceding 1,245-test selection omitted
those GTA transaction files and must not be cited as validation of that adapter.

The combined terrain/road test now uses an actual worker packet, the production road geometry builder,
the owned candidate terrain read, real Three raycasts and real Rapier colliders. A failure after physics
promotion must restore every old root/query/collider before any observer runs; retry promotes matching
heights within 1 mm and teardown releases every retained view. This test first exposed a road query
rebuilding and publishing a new profile after rollback. `preparePublicationSteps()` now transfers
publication authority for the model's lifetime: cancelling a candidate does not hand that authority
back to incidental queries. The live coordinator must provide its prepared ground view to candidate
builders; the road feature task now accepts that input explicitly. This test remains an isolated
integration boundary, not proof that the running world uses the transaction.

Curbs now use the shared captured terrain/road/rail/alignment views through preparation and later
draping, with captured planner and rendered-rail inputs. Stale work retains the old output. Curb
publication entries can join a registry batch; rollback restores render and collision maps and their
revision, while rebuild acknowledgement follows the complete batch. Real registry/Three tests reject a
later dependency and a clear, preserve an unrelated tile publication, and verify a successful retry.
Initial curb builds now retain a durable obligation too: a failing regression showed a stale initial
build could otherwise disappear without another request. Superseded completions cannot release the newer
request. These latest curb changes have focused headless evidence; they are not in the frozen v11 browser
candidate, and live cross-layer coordination and browser validation remain outstanding.

The existing geometry batcher now prepares bounded owner replacements in affected buckets using its
ordinary assembly compiler. Preparation retains the active owner/dirty tables; commit requires every
candidate output to be complete, and rollback restores old tables and pending dirty work. Explicit limits
cover changed buckets/owners, retained parts and output bytes. Eighteen batcher tests cover byte/range
parity, clear/add/replace, cancellation, stale inputs, no-op requests and capacity rejection. The rendered
road support index likewise has a sparse prepared cell/owner transaction and bounded captured query
window; six support tests verify stacked decks, local invalidation, rollback after a later publication
failure, scope/capacity rejection and teardown. These APIs reuse the existing geometry compiler and
triangle query implementation. The batcher's prepared owner replacement remains an integration API.

Live road aggregate publication now prepares sparse support tables within its existing frame driver and
returns a registry entry with reversible mesh/support/picking state. Readiness follows whole-batch success;
stale candidates leave the old aggregate intact. Three behavioral tests execute the actual adapter and frame
driver with Three, the triangle index and entity registry: an injected later dependency failure restores
old support and picking, retry/clear preserve an independent deck, cancellation releases staging, and
failures back off for at most three attempts before requiring changed input. Two former source-shape tests
are replaced by that behavioral coverage. Private support staging is capped at 2,048 owners, 4,096 cells and
131,072 cell memberships. These provisional engineering limits require movement measurement; they
are not a measured bound on commit time. Road-only connected dependency groups and
the shared query/GTA successor are now coded, with cumulative admission limits of 32 MiB, 32 buckets and 2,048 owners;
GPU prewarm performs at most one step per scheduler frame. This is engineering admission evidence, not performance
proof. Native proof of the new paint/mesh integration and full-scene movement evidence remain open. The v13 one-pose browser
diagnostic below exercises this live adapter.

After that checkpoint, road ground-cover footprints now travel with completed ring geometry and stage
with their aggregate's support entry. Preparation owns the projected coordinates and yields per point;
commit/rollback replaces one bucket's footprint table, and a successful finalization schedules a repaint
only when coverage changed. Height-only rebuilds reuse the old coordinates without another mask repaint.
Cancellation, failed publication, source replacement and eviction no longer append orphan road footprints.
The provisional admission limits are 2,048 owners and 131,072 projected points per bucket; these bound
this preparation, not total world CPU memory or measured performance. Production painter, ring
compiler and aggregate-boundary tests exercise the handoffs. The existing 2048² canvas repaint is still
throttled and building pads still use their older session list: this is footprint ownership integration,
not atomic GPU mask/terrain/physics publication or complete ground-cover lifetime cleanup.

Proposal masks now expose a shared immutable read per revision. Proposal insertion owns its coordinates,
holes and bounds; a road task retains that read across yields and rejects changed proposals before
publication. A stale masked-out/no-data result must also reject its tile, even though it has no candidate
mesh: otherwise an obsolete decision could retire the visible road. Behavioral tests cover those absent
outputs as well as changed masks, caller mutation, holes, snapshot reuse and session reset. These are
captured input decisions; proposal rendering and all other mask consumers still need the common commit.

The actual GTA adapter now returns a reversible prepared collider entry, using the same builders as its
ordinary refresh path. It captures the Rapier world, origin and resource count, allows only one staged
set, and releases it before world teardown. Whole-batch prevalidation checks source inputs; the commit
checks its owned resources without rejecting an upstream member that just promoted the agreed candidate.
Rollback restores bodies, bookkeeping and consumed-input obligations; finalization acknowledges inputs
and retires disabled old bodies. Real Rapier tests cover later-member failure, retry, origin changes and
teardown. The v25 road adapter now supplies the prepared rendered-road query window to the same collider
compiler. Its generator yields after 128 scanned triangles, including rejected/far triangles. It replaces
nearby road support with the road aggregate at the pre-controller boundary, acknowledges the new query
revision synchronously, and skips collider replacement for unchanged distant cells. An authoritative empty
rendered set removes support; it cannot revive the analytic formation fallback. A staged result exceeding
its complete-coverage budget rejects the group instead of publishing truncated support. These counts are
engineering admission bounds, not measured preparation costs; dense-region liveness still needs native
validation. Existing immediate callers use the same compiler, and their older capacity behavior remains a
separate limit to address. Terrain, rail, curbs and GPU masks are not yet members of this road transaction.

The v25-r2 [headless receipt](../output/surface-audit/ground-implementation/ground-road-boundary-v25/broad-r2/headless-validation-receipt.json)
records **1,374 passing tests across 165 files**, zero failures/cancellations/skips, at
**19:54:43–19:54:48 UTC**, on Node 24.10.0. HEAD remained `d429296d1e5b59dc3650276f40025db62d34f467`;
all 1,433 inventoried JS/MJS files remained unchanged. Tests execute the actual road frame driver and GTA
adapter with Three raycasts, the query registry and real Rapier bodies. They verify old support during
preparation, same-boundary promotion/removal, later-member rollback and unchanged distant colliders.
This is headless behavioral evidence, not native streaming or movement-performance acceptance.

The later v26-r2 [headless receipt](../output/surface-audit/ground-implementation/ground-road-groups-v26/broad-r2/headless-validation-receipt.json) records **1,379/1,379 passing tests across 165 files**, with unchanged inventoried JS/MJS hashes. It covers the connected road group driver and its bounded admission/prewarm behavior; it does not close the paint/mesh production cutover or provide native full-scene or movement evidence.

The v25 native-r2 attempt was rejected because the GTA module called `recordLayerFrameMs` without
importing it. The headless VM fixture had supplied that global and therefore masked the integration error.
GTA now receives the road caller's measurement callback, and acquires publication ownership inside that
callback so a reporting failure after allocation can still release the staged Rapier resources. Focused
cleanup and failure tests cover that path. The subsequent v25-r3 native capture was also rejected: Jelačić never settled after the
`RoadSurface:sidewalk#0@-10/r-1_-1` staged road collider exceeded the complete **8,000-triangle** support
budget. The active collider had 7,083 triangles before the rejected successor; the wider rendered query
registry had 1,079 owners, 1,336 parts and 478 cells. Those registry counts are not the collider's local
coverage counts. The capture retained four pending readiness items and is not movement
or acceptance evidence. A terrain publication-slot contention error seen in that run was corrected locally
and covered by 14 focused terrain-packet/terrain-ground-publication tests; no native recheck was run.

Terrain uploads now hand their exact captured compiler input and a reversible tile-map entry to a shared
frame publication boundary. The boundary holds one ready batch, publishes at most one per frame after
coordinate restoration/startup and before controller queries, and cancels pending work before physics
teardown. The existing worker admission still allows one terrain tile in flight. `ground:publish` records
the synchronous commit cost in frame telemetry; a single slot is not proof that each driver operation fits
the frame budget. Behavioral tests execute the actual cab frame prefix and terrain adapter with real worker
packets and Three roots. The public terrain reference still changes early, and terrain currently submits
individual tiles: this is the live commit boundary, not completion of the source-intent/published-query split
or the whole terrain/road/rail/curb/mask/physics transaction.

The frame-boundary worktree run passed **1,287 tests across 157 files**; selection and log are retained as
`/tmp/station3d-ground-frame-current-files.txt` and `/tmp/station3d-ground-frame-v15-current.log`. The existing
packet-delivery tests now use the real registry/boundary and explicitly wait for promotion, including a
newer source revision whose compiler input has not yet been installed. A subsequent focused five-test
terrain-adapter run also executes the actual compiler-installation function with delayed acknowledgements.

Live rail builds now capture their terrain and stop inputs before yielding. Road vertical alignments
compile their cached rows and analytic approaches against the same captured terrain; bounded terrain
invalidation preserves unaffected compiled alignments. The cooperative road-formation compiler captures
terrain, rail and alignment read views and retains its old published callbacks throughout preparation.
Civil-ground snapshots require explicit providers and preserve both nullable evidence and authority order.
These changes prevent mixed inputs inside the compilers and the connected road geometry tasks; the complete
cross-layer publication transaction is still unfinished. Alignment compilation itself is still synchronous.

Detached terrain tile roots now prewarm their actual Three.js materials and geometry before publication.
Cancellation retains a material until outstanding shader preparation has settled. This does not fix the
existing early terrain-query swap or establish a bound on every driver operation at first visible draw.

Portable fixtures include the complete [Jelačić polygon and terrain crop](../website/station-3d/__tests__/fixtures/ground-jelacic-source.json),
[real full-road variants](../website/station-3d/__tests__/fixtures/ground-road-full-variants.json), and
[three Grič roads with a retained terrain lattice](../website/station-3d/__tests__/fixtures/ground-gric-formation.json).
The Grič lattice contains 59 × 62 rendered 4 m nodes derived from the verified fine-source body
`d4188c32c76870dcb4a504db248103e0890c411430e60e09969dc7c20c6d028c`; its isolated anchor datum is explicitly
recorded and is not presented as the live session's initial base-grid datum. Large cassettes and native
captures remain ignored local evidence under `output/surface-audit/ground-implementation/`.

### Frozen scene comparison

The current [foundation budget](../performance/station3d/surface-audit.budget.json) is schema v2, using audit
v3 and `intersecting-or-unknown-world-bounds-v1`. It was frozen at **05:55:15.598 UTC** before candidate v5
started, from the complete `baseline-scope-v5` capture. It retains baseline nonduplicate type/pair/gap and
uncertainty limits, coverage minima, and a zero-duplicate requirement. Unique-sample limits replay the raw
stacks with duplicate records excluded; overlapping type totals are not added together.

- Baseline code SHA-256: `2c6644aab51d9ab02f6bc406c35bb91cf502c9f459a78f04871d9e250afd6388`.
- Source-cassette SHA-256: `6c15a25914a52e550904afd781de8fadfa9b90c77b13841b3f445108f0725dfe`.
- Frozen budget SHA-256: `43afec0932cd2058def7f5d378709947f3f5dd674788e31c87d36ade0519c3e4`.

At `time=12`, elevation 1 and a 1400 × 900 viewport, every v5 pose sampled 14,400 cells and settled with
zero page errors and zero local pending/failed work. Candidate duplicates are zero in all seven poses:
Jelačić removed 8,164 duplicate records and Split removed 4,378. The remaining budget failure is Grič:
**540 → 545 unique flagged cells; 16 → 21 floating records**, with the corresponding road/road pair limit
also exceeded. Other type/pair, coverage and scoped-uncertainty gates pass. See the
[baseline](../output/surface-audit/ground-implementation/baseline-scope-v5/summary.json) and
[candidate](../output/surface-audit/ground-implementation/candidate-scope-v5/summary.json) receipts.

Five Grič cells differ because the baseline includes an additional Mesnička earthwork-collar hit between
two road tops. An earlier complete baseline also lacked those hits, so the difference is not sufficient
to attribute a new physical regression to duplicate removal. Retained real inputs show the collar changes
from 264 to 246 to 240 vertices as neighbours arrive. The new geometry-generation checks connect that
completed model change to the retained mesh. A separate synthetic regression demonstrates the missed
collar dependency outside the inner polygon bounds. Neither finding makes the five height conflicts pass.

The [Grič v6 diagnostic](../output/surface-audit/ground-implementation/gric-formation-v6/summary.json)
completed at **06:41:41 UTC**, ready/settled with no page errors: 471 inversion, 58 coplanar, 21 floating,
zero duplicate, 545 unique flagged cells and 110 skipped surfaces. Its frozen overlay contains the formation
dependency changes available at 06:39 UTC on top of candidate v5. It predates the MultiPolygon part-order
correction, shared-wall/read-snapshot/retry changes, rail generation reuse repair and GTA/paint prototype
work. It was a one-pose
correctness capture without a count budget; **it is not seven-pose or release acceptance**. The frozen
budget has not been changed to accommodate it.

The [seven-pose v7 capture](../output/surface-audit/ground-implementation/candidate-publication-v7/summary.json)
completed at **08:15:22 UTC**, with every pose ready and settled, no page errors and zero duplicate interiors.
Its code SHA-256 is `d4acfefb4989519bb8febaa735c61d81201144d304a967f8fbf0d16c72389b2b`.
All seven unique flagged counts match candidate v5. It still fails the three Grič gates and additionally
fails the rail-pose skipped-surface limit: **94 → 96** (54 → 56 instanced; 40 batched in both).
The retained skipped inventories have different vehicle/building bounds and membership; their semantic
effect has not been established. The uncertainty failure remains a failure. This frozen candidate includes
rail-generation/input repairs and terrain GPU preparation, but predates the later road-alignment,
civil-ground and road-input snapshot work. It is not acceptance of the current working tree.

Historical evidence remains available: earlier v2 captures had incomplete aggregate ownership, a rejected
source-identity candidate treated full geometry variants as separate owners, and an initial v4 run did
not settle during another session's campaign bake. Complete v4 candidates had zero duplicates but exposed
a global skipped-mesh count unrelated to the audit bounds; scoped v5 replaces that metric. Earlier facade
404 handling and an import through the wrong live URL prefix also invalidated capture attempts. These
reports are diagnostics, not interchangeable baselines. The [stack replay tool](../tools/surface-audit-replay.mjs)
reproduces the corrected saved Jelačić counts from all 14,400 hashed hit stacks.

The source cassette records exact bytes, content types and HTTP status. Only the verified optional
`/api/building-facade/<numeric-id>` image endpoint may replay 404 and normalize its timestamp cache key;
missing ground responses reject capture. A partially recorded cassette cannot serve as frozen replay.

The separate `movement-sources-v1/` cassette is sealed with **2,457 exact responses**, source hash
`59ac3777d70296df6109b0a409fa0154c6631375da80ac256e2dffe49ce5b899` and an `admission-provenance.json` receipt.
All five source-recording scenarios completed without browser errors; the dense settled scene succeeded
on a full rerun after an earlier attempt was manually stopped. Walking also verified served-code bytes;
the other four recordings omitted `--code-dir` and are only source diagnostics. Drive and Split additionally
failed the clean-host timing threshold. Recording does **not** count as a performance measurement.
A shared Sloboda asset-base fix prevents deep-link preload requests from
receiving the HTML shell as CSS; the movement baseline includes that same two-file fix, with fingerprint
`2c7a874d796d03f71920b8e5955eb441e84f543bde9c80f85dca3d21a9b74913` and its own overlay receipt.
The original audit baseline and frozen budget remain unchanged. Strict native replay must verify source
coverage and served bytes for every scenario; three accepted baseline/candidate pairs per scenario remain
outstanding.

The seven-pose `candidate-road-inputs-v9` audit was stopped after host load reached `76.16/46.52/26.29`; its owned Chrome process was verified gone. The partial run had three poses ready/settled with zero errors. Grič was ready but unsettled, with 545 flagged samples and pending road/curb/rail work; the rail pose was unfinished and later poses did not run. This is partial diagnostic evidence only, not a seven-pose result or performance attribution. The audit remains unaccepted; the prior frozen-code details follow:
`213b8e274c1d8cb570dd5f308fd709179eaf1ef23cbead2419318ada9c453b49`. Its overlay adds the captured road compiler
and renderer inputs, shared preparation and the common Sloboda asset fix to v7. V8 was frozen but never
run after review found duplicated in-progress preparation. No v9 acceptance result is claimed yet.

The single-Grič `gric-road-inputs-v10` diagnostic completed at 09:46:31 UTC against frozen code hash
`7a94156a69aeec3507e3a8451a801d2954a33229bd942bc40b15856158cf4054`. It was ready and settled with
545 flagged samples and zero page errors, but recorded eight publication failures caused by idempotent
`Map.delete` returning false for absent structure clears. The original harness marked it valid because it
did not inspect the historical failure counter; the corrected gate rejects this diagnostic. Its separate
[adjudication](../output/surface-audit/ground-implementation/gric-road-inputs-v10/adjudication.json) preserves
the original result. The later void-callback fix is after the v10 freeze. This remains diagnostic evidence
only, not acceptance or performance proof. Both fresh validation and cached-report admission now require
an explicit zero publication-failure counter, even when the scene has subsequently settled.

The [single-Grič v11 check](../output/surface-audit/ground-implementation/gric-road-inputs-v11/summary.json)
completed at **09:56:35 UTC**, ready and settled, with 545 flagged samples, zero page errors and zero
recorded publication failures. Frozen code hash
`9bc3564b71217811d2488200e33fad8903d4af015cfd6241f9fe185e13d98371` includes the corrected structure-clear
callback and was checked with the stricter audit gate. This is one pose without a surface-count budget;
it does not establish seven-pose or performance acceptance. The terrain read-lifetime API is not included
in that frozen candidate and is not connected to the live world.

### Rejected movement comparison

The first native v11 matrix stopped before launching a browser: the sealed replay data did not contain
the requested tram shape. The actual shared-position opener falls back to a random matching trip;
the cassette has 112 candidates with different remaining routes. The corrected frozen harness chooses
the first production fallback deterministically for both builds, restores randomness immediately after
the synchronous opener returns, and records/checks the actual stops and compiled path in the comparison
contract. It changes neither rendered build nor recorded API bodies. The failed zero-run receipt is
retained under `paired-road-inputs-v11`.

The replacement matrix started at **10:24:54 UTC** under `paired-road-inputs-v11-pinned`, with 30 scheduled
slots across five scenarios. Its frozen harness manifest hash is
`178a4fb39d0effb2c81e0573131f1c257aec81251153318c7f3e000a03f706c3`.
The first walking runs exposed missing recorded tile responses in both builds; some also failed clean-host
coverage. The first candidate dense-scene run timed out waiting for settled ground. The matrix was stopped
at **10:59:33 UTC**, after 14 completed slots: two candidate walking captures and one baseline dense capture
were individually valid, with **zero accepted comparable pairs**. The incomplete receipt and
`stop-adjudication.json` are retained; postflight confirms unchanged inputs, and the job/browser processes
were verified gone. Expand and reseal a new source cassette, investigate the readiness timeout, then repeat
the fixed comparison. Do not fill missing responses with empty data or modify the sealed corpus.
**There is no accepted movement-performance conclusion yet.**

A separate two-pose curb diagnostic, `curb-inputs-v12`, used frozen code
`3418df7d36f2bf434aa90ea44e8da6a224e56b95f9afb5e3d67b4801c18de542` and the established scene cassette.
It reached world readiness at Jelačić but had one pending local dependency when the laptop's browser reaper
killed Chrome at **11:05:22 UTC**, about two minutes after launch. The report has no completed audit and
Grič was not reached; it is rejected. The reaper log identifies the interruption, but the reason for killing
such a young browser is not yet established. This is neither a visual pass nor evidence of an application
crash.

The preserved [retry](../output/surface-audit/ground-implementation/curb-inputs-v12-retry1/summary.json)
completed both poses on the same frozen code and source hashes. Jelačić settled at **11:24:09 UTC** with
14,400 samples, 2,302 flagged cells, zero duplicate interiors, zero page errors and zero publication failures.
Grič settled at **11:26:18 UTC** with 545 flagged cells and zero publication failures, but its 677 missing-fixture
errors (98 distinct requests) reject that capture. All reported page errors concern missing replay data;
the retained pose/options match v11. Matching local counts do not validate a scene missing requested data.
The owned Chrome exited cleanly. This provides a completed Jelačić diagnostic for captured curb inputs;
Grič and the complete frozen-budget comparison remain unaccepted.

The [v13 Jelačić diagnostic](../output/surface-audit/ground-implementation/road-publication-v13/summary.json)
completed at **11:43:25 UTC**, with code hash
`374d39215b04fdf9feff3fab06215edfe3bd6cc0a70e94ab080c6331970ce531` and the unchanged scene-cassette hash.
Its [overlay receipt](../output/surface-audit/ground-implementation/road-publication-v13/overlay.txt) records
the frozen v12 clone plus six current adapter/support/test files. The capture was ready and locally settled,
with no page errors, zero publication failures and zero duplicate interiors. Its 2,302 flagged cells
(1,671 inversion, 569 coplanar, 62 floating) match v12; the retained screenshot still shows the unresolved
colour-surface conflicts. The owned browser exited. This is a completed one-pose correctness diagnostic
for the live road publication adapter, not the wider count budget, a terrain-update experiment or a
movement-performance result.

The [v14 Jelačić diagnostic](../output/surface-audit/ground-implementation/ground-cover-mask-v14/summary.json)
completed at **12:26:57 UTC**, with code hash
`2181dfbe9b3f1bc6ecf404ef7b0410a1cebca18f1fc75116ec0353fd8626f90c` and the same sealed source cassette.
Its [overlay receipt](../output/surface-audit/ground-implementation/ground-cover-mask-v14/overlay.txt) adds
the road-footprint and proposal-mask changes to v13. It was ready and settled with no page errors, 2,302
flagged cells (1,671 inversion, 569 coplanar, 62 floating), and zero void, duplicate or missing-paint flags.
The [retained settlement](../output/surface-audit/ground-implementation/ground-cover-mask-v14/zagreb-jelacic-paving.settlement.json)
contains the actual registry counters: 1,496 begun, 1,476 published, 18 cleared, 731 retired, two discarded,
and zero failures, stale rejections, conflicts or claim errors. The screenshot still shows unresolved paving
overlap. The browser was closed. This validates that limited initial-load path; v14 predates the later GTA
adapter and terrain frame-boundary changes and establishes no movement-performance result.

The [v15 frame-boundary capture](../output/surface-audit/ground-implementation/ground-frame-boundary-v15/summary.json)
and its [instrumented retry](../output/surface-audit/ground-implementation/ground-frame-boundary-v15-retry1/summary.json)
were both **rejected for unsettled rail dependencies**, at 13:08:24 and 13:21:41 UTC. They reached world
readiness with no page errors and the same 2,302 flagged cells, but did not finish the five-minute settlement
gate. Code hash `159e69be64d9464e3c66ffe9ccc4b0cd9dbb701b5ff48b4e08ec4960640a03f9` retains the v14
sources plus the GTA adapter, shared cab boundary and terrain handoff. Concurrent passenger-lift edits in
the working `cab.js` were added after this freeze and are excluded from this native evidence.

The retry's [actual boundary snapshot](../output/surface-audit/ground-implementation/ground-frame-boundary-v15-retry1/zagreb-jelacic-paving.ground-boundary.json)
records 49 terrain publications, zero pending/failed/cancelled batches, and an active, visible session. The
remaining flags were `streamedRailDirty` and `pendingRailFormationBuild`; the terrain-revision flag was false.
Its maximum measured synchronous commit was **53 ms**. These diagnostics prove that the new boundary ran,
not that the whole ground group settled or that its frame cost passed. Other road/building work remained
queued. Host load was elevated, and a subsequent process snapshot showed other Chrome rendering activity;
neither observation by itself establishes the cause. Investigate the rail backlog and obtain clean-host
timing evidence before acceptance. Both owned browsers were closed. The retry retains the probe hash and
overlay receipt, and the probe now records boundary/rail wait reasons even for rejected captures.

### Native paint proof

The corrected [receipt](../output/surface-audit/ground-implementation/paint-proof-native-v2/report.json),
[source/artifact hashes](../output/surface-audit/ground-implementation/paint-proof-native-v2/provenance.json)
and [screenshot](../output/surface-audit/ground-implementation/paint-proof-native-v2/screenshot.png), captured
at **16:38 UTC on 12 September**, come from headed Chrome 153 on **ANGLE Metal / Apple M1 Pro**, Three.js r184, using the isolated
[proof fixture](../website/station-3d/__tests__/fixtures/ground-paint-proof.html).

The original v1 proof passed latitude/longitude to `geoToLocal` in reverse order. Its CPU and GPU used
the same distorted source, so it established raster/ownership agreement but did not establish correct
geographic placement or dimensions. That receipt remains as historical evidence. The two headless fixture
projections and native fixture are corrected; a recorded audit coordinate now independently guards axis order.
Do not reuse the v1 Jelačić pixel totals as proof of the corrected projection.

Rank/holes, reversed arrival, removal exposing the lower paint, receiver-isolated deck paint and both real
Jelačić source cases produced zero mismatches against independent CPU coverage. The original 82/15-vertex
source checked **65,361 pixel centres**, excluding 175 boundary samples. The newly retained plaza/footway
pair checked **65,332 pixel centres**, excluding 204 boundary samples. Exclusions use the advertised raster
subpixel precision fixed before reading pixels; the full CPU ownership comparison includes those centres.
The new [portable source fixture](../website/station-3d/__tests__/fixtures/ground-jelacic-receiver.json)
retains exact polygon `-1493356001` (237 vertices, 14 holes) and footway `707219360` (37 vertices), decoded
from sealed binary `/roads/cab` responses. Both are tagged paving stones; no synthetic OSM relation link
is inferred. Independent triangle-area checks preserve all holes, and the recorded overlap selects the
canonical plaza paint in both delivery orders. These are the source owners for the first production slice.
The v21 native survey found terrain as the PATH input at all **14,382** plaza and **90** footway sample
centres, with complete terrain evidence and zero height difference; holes were excluded from the paved
footprint. It is a sampled diagnostic, not a complete boundary/contact proof. Its first run reached settled
readiness but the added survey script omitted a required bounds argument and failed. The corrected second
run completed the survey without page errors but missed the fixed settlement deadline while rail-cell
preparation remained pending. Both captures retain 2,302 flagged audit samples and are rejected as acceptance
runs. Their scripts/results are in `output/surface-audit/ground-implementation/ground-jelacic-receiver-v21/`.
The survey's rail revision guard used `cabState.railFormation`, which can lag the active rail world model;
its `unchanged` field does not prove that every actual input stayed unchanged. Both owned browsers closed.
The page uses RGBA8 linear albedo/coverage plus nearest-sampled R8 style ID, with no mip/depth/stencil/MSAA
attachments: 20,480 bytes at 64² or 327,680 bytes at 256². Those are page allocations, not a complete cache budget.

A physical slope, elevated deck and separate underside retained lighting and receiver isolation, including
an under-deck view. Raycast heights were unchanged by painting, and a 2 km render-origin rebase had zero
pixel-byte difference with lighting held constant. Five build/dispose cycles on the same warmed renderer
returned to zero geometries and one shared Three.js DFG LUT texture. The fifteen served files were frozen
and hashed with no changes during capture; the corrected fixture's served hash matched the worktree.
The canvas drawing buffer was 512². Browser errors were empty and the dedicated Chrome's absence was
verified after closing it. An earlier rebase fixture incorrectly translated its hemisphere-light direction;
that rejected receipt is preserved separately with v1.

These results prove the isolated albedo-page mechanism. They do not prove full recipe parity, streaming
cache behavior, production surface coverage, campaign support or performance. All later cutover gates below
remain applicable. The host was heavily contended (load average 131 at the before reading); the recorded
draw/preparation timings cannot support a performance comparison.

The v3 [native receipt](../output/surface-audit/ground-implementation/paint-proof-native-v3/report.json) at
**17:33:01 UTC** adds repeating albedo textures, while retaining all six earlier coverage cases and the
physical/cleanup checks. Two 64² tests compare **8,192 pixels** against independently computed sRGB-to-linear
colour and rotated/offset UV coordinates, including a page around (100,000 m, −200,000 m). Both have zero
mismatches and zero maximum byte error. Retiring pages never disposed their shared source bitmap.
Seventeen headless tests cover immutable recipe inputs across yields and rejection of malformed/missing
textures. The [provenance](../output/surface-audit/ground-implementation/paint-proof-native-v3/provenance.json)
retains all fifteen served source hashes and no-cache responses; no source changed, browser errors were
empty, and process absence was verified after closing Chrome 153 on M1 Pro/Metal. Its drawing buffer was
512² at DPR 1. This validates the textured albedo path, **not** actual paving detail/roughness/normal parity,
production binding or cache performance. Source bitmap storage remains part of the world resource budget,
in addition to the five bytes per page texel reported above.

The v22 [headless receipt](../output/surface-audit/ground-implementation/ground-paint-texture-v22/headless-validation-receipt.json)
records **1,337 passing tests across 160 files**, zero failures/cancellations/skips, on Node 24.10.0 at
**17:36:04–17:36:07 UTC**. All 1,440 inventoried files had unchanged before/after hashes. This covers the
post-campaign-scope correction and textured-packet work; it is headless evidence, not movement performance.

The v4 [native receipt](../output/surface-audit/ground-implementation/paint-proof-native-v4/report.json) at
**17:54:33 UTC** verifies incremental page updates against independent CPU colour/coverage expectations:
**6,144 pixels across six cases, zero mismatches**. Cases cover diagonal movement, a moved polygon with
a hole, removal revealing the lower material, clearing all contributors, and a teleport outside the
receiver. The 32² diagonal case copies 576 texels and repaints 448; each work item handles at most 64
pixels. Every destination texel is initialized before publication, both attachments agree, old published
bytes stay unchanged during preparation, and actual GL framebuffer plus Three render state are restored.
Six successors reuse exactly two target pairs. All preceding texture/physical/disposal checks still pass.
The [provenance](../output/surface-audit/ground-implementation/paint-proof-native-v4/provenance.json) records
seventeen matching no-cache source responses, zero browser errors, unchanged frozen files and closed
Chrome 153/M1 Pro Metal. This small native check proves copying/clearing semantics, **not** full-size
allocation cost, source-query scaling, cascade scheduling or movement performance.

The target pool admits a fixed retained/staging count before allocation. Three retained 2048² RGBA8+R8
pages plus one shared successor have **80 MiB (83.9 MB)** of logical attachment storage; this excludes
source bitmaps, geometry, other receiver pages and driver overhead. It fits the approximate desktop
allowance only if those remaining costs also fit. This is an allocation calculation, not a measured
device budget. Production work uses the existing frame scheduler; the new page task does not schedule
itself or publish partially completed ranks.

The v5 [native receipt](../output/surface-audit/ground-implementation/paint-proof-native-v5/report.json) at
**18:09:00 UTC** repeats those checks with a persistent painter. Its actual Three GPU program ID remains
`0` across all six incremental cases, and shader preparation is invoked once for the entire proof.
Page retirement now releases temporary geometry and its target lease while preserving the world-owned
paint material; closing the painter disposes that material. A new headless lifecycle test covers a busy
painter, cancellation, context loss/restoration and release of the staging lease. The
[provenance](../output/surface-audit/ground-implementation/paint-proof-native-v5/provenance.json) records
seventeen unchanged served files, zero browser errors and verified browser exit. This removes an
avoidable program-lifetime cost; it does not establish a frame-time improvement.

The v23 [headless receipt](../output/surface-audit/ground-implementation/ground-paint-incremental-v23/headless-validation-receipt.json)
records **1,343 passing tests across 161 files**, with zero failures/cancellations/skips, at
**17:53:11–17:53:25 UTC**. Its 764 unchanged hashes cover the manifest tests, core/world JavaScript and
tools; this narrower inventory excludes the other website directories. It predates the persistent-painter
change, which has the focused/native checks above.

The v6 [native receipt](../output/surface-audit/ground-implementation/paint-proof-native-v6/report.json) at
**18:26:32 UTC** repeats the incremental, textured and physical checks using one texture-array target.
Six successors reuse two layers of its RGBA8+R8 attachments: **6,144 incremental pixels, zero mismatches**,
unchanged active bytes during preparation, and one retained paint program. Ground and elevated-deck
bindings also use different layers of the same array. The subsequent material-parameter and cascade
binding changes are not part of this receipt. Its [provenance](../output/surface-audit/ground-implementation/paint-proof-native-v6/provenance.json)
contains seventeen matching no-cache responses, no browser errors or changed frozen files; the screenshot
was inspected and owned Chrome process absence checked. No capture HEAD was recorded, so a later HEAD
must not be assigned retroactively. This proves small array-layer copying and receiver isolation, not
full-size allocation cost, the combined terrain shader budget or movement performance.

The [v7 native receipt](../output/surface-audit/ground-implementation/paint-proof-native-v7/report.json) at
**18:52:27 UTC** verifies three simultaneous cascade layers through the actual standard-material shader.
Diagnostic GPU output matches the near/middle/far roughness and metalness recipes and confirms that zero
normal influence removes the base normal-map perturbation. Clearing paint restores the base factors and
normal. The [v8 receipt](../output/surface-audit/ground-implementation/paint-proof-native-v8/report.json) at
**19:16:18 UTC** additionally invalidates fine, fine+middle, and all three pages; their exact GPU bytes
match middle, far, and unpainted material respectively. Both retain the earlier independent single-page
movement/copy/removal, texture, stacked-receiver and cleanup checks. The three-cascade binding uses two
array samplers plus one 3,072-byte material-table texture. The isolated native shader has five active
samplers including its normal map and Three's DFG lookup, against that desktop context's limit of sixteen;
this does not establish the combined terrain shader's sampler budget. The [v8 provenance](../output/surface-audit/ground-implementation/paint-proof-native-v8/provenance.json)
records eighteen unchanged served files, no browser errors and browser cleanup. These remain small native
shader tests, not full-size allocation, live source cutover or movement-performance acceptance.

The v24 [headless receipt](../output/surface-audit/ground-implementation/ground-paint-cache-v24/headless-validation-receipt.json)
records **1,363 passing tests across 164 files**, zero failures/cancellations/skips, at
**19:18:45–19:18:49 UTC**. All 1,433 inventoried JS/MJS hashes remained unchanged. Cache lifecycle tests use
a manual queue and controlled painter with the real publication registry, boundary and target pool. They
cover publication, source removal during an in-flight build, coarse/fine invalidation, rollback, finite
retries and resource retirement. The cache controller uses the shared FrameChunkQueue in production code,
but neither those isolated tests nor the v7/v8 native fixture execute its live world scheduling. Source
producers and physical retirement still need to join paint publication; the newer v25 road/physics
transaction above is one part of that integration, not a completed paving cutover.

### v78 planner backstop geometry checkpoint

The v78 frozen planner capture records the prior ramp backstop defect: the old cut half-width was 3.70 m, but wall ends were 3.65 m and floor width was 3.40 m; a frozen geometry ray at x=60, z=3.69 missed support. The current swept-floor geometry reaches the ±3.70 m civil miters and reports y=-5.05 at the probe. Focused backstop, station-gap, and cancellation coverage is reported 8/8 passing. Non-floor frozen geometry matches and changed floors were checked independently. No full v78 broad suite or native run has been completed; this remains focused geometry evidence.

### v79/v80 planner publication checkpoint

The v79 broad scope completed 1,858/1,858 tests across 242 files with stable hashes; v79 native evidence remains a prepublication startup-blocked artifact. v80 completed 1,859/1,859 tests across the same 242-file scope with stable hashes and corrected the local-level planner ramp startup deadlock. Its frozen native fixture settled generation 3 with 3 published, 0 pending/preparing/failed; the last publication elapsed 74,414.7 ms with 5,802.9 ms recorded CPU. Actual PlannerTunnelFloors probes agree with opening boundaries, but the walking query still returns the analytic value outside the physical floor edge and at the floor probes, so walking correctness remains open. Full-update performance remains unaccepted; these timings are not matched-baseline evidence.

### v81 planner support checkpoint

The v81 broad receipt records **1,860/1,860 passing tests across 242 files** with stable hashes (1,613 hashed files; HEAD `76f3346372647f2d3ae36f89808f45ea455cb144`). The physical native freeze contains 3,636 regular files with zero mismatches and a documented `node_modules` symlink. Its frozen server is `ground-v81-frozen-8330` at `http://localhost:8330`; the actual worker route returned 282,067 bytes of JavaScript, SHA-256 `726b80a2cf1f3d6ed90c6c20718aacdcaf12f91a3889cfad802322c8c1c934bb`, and the vendor module returned JavaScript with no-cache headers.

The native ground coordinator settled generation 3 with 3 published, 0 pending, 0 preparing, and 0 failures. The last generation took 74.5699 seconds elapsed, 5,808.5 ms recorded CPU, and 221,033 visits; this is diagnostic timing without matched performance evidence. Floor probes show actual floor, planner support, and walking support agreeing inside the authored floor. Planner support is null outside the floor edge while the full walking query recovers ordinary outside terrain, so this is not native gap-null walking acceptance. A normal `KeyS` move recorded 25.185 m, exact final support, and zero ground misses. The ramp screenshot was viewed as scene evidence only.

The rail/civil mismatch remains qualified: the fixture deliberately supplies no-`elevationMode` local levels with terrain enabled. The normal caller `website/transit.js:12632` emits absolute EVRF2000 for terrain-model mode, `asl` for photo mode, and `{}` only for flat mode. The fixture result is therefore an ambiguous or unsupported API combination, not a demonstrated regression in normal absolute-mode planner sessions. Full visual and movement-performance acceptance remain open.

### v82 curb terrain-drape scheduling checkpoint

The v82 broad receipt records **1,862/1,862 passing tests across 242 files** with 1,613 unchanged hashes and unchanged HEAD. The physical freeze contains 3,636 regular files with zero mismatches. On the same mixed-mode ground-ramp fixture, baseline and candidate final mesh/support hashes are identical across 57 meshes and 21 supports. The baseline forced full refresh recorded 41,784.8 ms elapsed, 5,539.1 ms CPU and 220,067 visits; the candidate recorded 35,919.0 ms, 4,932.9 ms CPU and 97,897 visits, with identical 1,479 owners, 21 source tiles, 121 dependency buckets, 100 geometry buckets and 23,654,216 geometry bytes. The separate settled captures were not a matched comparison. This is a single stationary scheduling pair, useful for localization only; it does not establish height, movement, GPU or performance acceptance.

### v82 production paint and movement diagnostics

The v82 production paint readback used the actual `TerrainTileMesh:-1:-1` shader/material and published pages: **4,045 paver pixels and 51 intentional-hole pixels across 4,096 samples, with 0 mismatches**. Disabling paint caused all 4,045 expected paver pixels to fail while all 4,096 surface pixels still rendered. This is one physical receiver with production shader/page coverage, not full-scene occlusion proof and not a change to the CPU audit's `gpuVerified: false` basis. A 34-sample walk recorded exact support and 0 misses while generation was pending; the two screenshots were taken at different poses after 25.795 m and are not a matched lighting pair.

The movement capacity diagnostic rejected generation 6 at `replacement-budget` (`Geometry replacement output capacity exceeded`), retained generation 5, and recorded 12 queued network requests. Queue drain and movement acceptance remain failed/open; no closure claim is made.

### v83 complete-road capacity replay

The v83 broad receipt records **1,862/1,862 tests across 242 files**, with 1,613 unchanged source hashes and unchanged HEAD. Two process-only mutations that remove the outer or inner forwarding of `maxGeometryBytes` both fail the behavioral road publication test. The complete ground candidate now has a separate 64 MiB road output ceiling; ordinary aggregate groups retain their 32 MiB ceiling and uploads retain their existing slices. Capacity errors include output/limit byte counts and a typed code.

The normal corridor-turn replay publishes generation 5 with **42,169,244 road bytes**, 2,550 changed owners, 40 source tiles, 237 dependency buckets and 197 geometry buckets. It records 301,657.4 ms elapsed and 10,726.9 ms compiler CPU. The capture at 07:56:33 UTC reports host clean ×1.10, but this is a diagnostic run without a matched baseline. A 25.847 m normal-control walk has 34 exact support samples with no misses; the final position still agrees with support after publication. The predecessor-to-successor swap itself was not continuously sampled.

The road capacity failure is resolved for this case, but **queue-drain acceptance still fails**. After publication the shared owner has four pending families and no active build. All road sources have drained, while `rails.groundReady()` is false: a late pillar-clearance promise leaves `pendingRailVisualRefresh: 'requested'` on the ordinary publisher, whose frame hook is disabled in managed mode. The captured world retains valid support and reports no generation failures. v84 routes this producer through the shared coordinator; its native replay is pending. The final attempted browser capture found no `__st3dDebug`; the successful state captures above are the evidence, and Chrome was closed.

### 14 September coastal publication checkpoint

The [coastal checkpoint](../output/surface-audit/ground-implementation/ground-water-coherence/README.md)
records 177 passing focused tests across 21 files (0.95 s) and successful production bundle compilation.
Water openings, private coastal construction, prepared-road quay classification and final clipped coastal
support now join the shared publication boundary. Actual coast/quay factories and Rapier cover publication,
rollback, cancellation, removal, authored openings, changed earthworks and geometry/mask reuse. Station
coverage includes the actual instanced surface-cut access builder through a 7.18 m deep cut.

Native acceptance remains open. A dense synthetic shoreline exposed a Float32 collapse, fixed by
triangulating the stored boundary. The unsimplified 2,048-vertex diagnostic still required 1.36 s compiler
CPU across cooperative visits; a cold simplified run had a 27.9 ms maximum visit. These do not pass the
engine movement/frame gate. No new browser run followed the automatic approval-review usage-limit rejection.
