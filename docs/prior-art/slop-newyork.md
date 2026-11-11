# Slop New York (mrdoob)

- Live: <https://mrdoob.github.io/slop-newyork/>
- Source: <https://github.com/mrdoob/slop-newyork> (MIT), commit `0049a49`,
  reviewed 2026-10-22.
- Stack: three.js dev branch, `WebGPURenderer` and TSL, classic scripts, no
  build step.

A drivable/walkable Manhattan (person, car, bicycle, helicopter) with traffic,
pedestrians, cascaded sun shadows, screen-space reflections and bloom. It
advertises 60 fps.

## Why its smoothness is not directly comparable

- **No runtime streaming or generation.** The whole island is built once at
  load from a 1.1 MB JavaScript data file (`js/nyc-geodata.js`), behind a
  loading screen. There is no tile delivery, ground generation or collision
  publication while moving, which are our largest sources of stutter (S1, G1,
  G2). The geometry is procedural massing rather than real per-building data,
  so this is not evidence for a precomputed world either (see "Deferred or
  rejected directions" in the backlog).
- **Pixel ratio is fixed at 1** (`renderer.setPixelRatio(1.0)` in `js/main.js`)
  with MSAA on. Our same-view GPU time was 9.0 ms at DPR 1 and 21.5 ms at DPR
  1.5 (R4), so the headline frame rate rests largely on this choice.
- WebGPU only; we render with WebGL.

## Ideas worth trying

### 1. Shadow-only proxy casters per cell — R2, R3

`js/scene-culling.js`, `setupSceneCulling` part 2.

- Large static casters (over 20 k triangles and over 600 m across) get
  position-only copies: no normals or UVs, one black `MeshBasicNodeMaterial`
  per face side, merged into 500 m cells (instanced sources stay instanced per
  cell).
- The copies live on a layer that only the shadow cascade cameras enable; the
  originals get `castShadow = false`. The shadow pass therefore draws a few
  merged cells instead of every caster mesh, and frustum culling of the cells
  limits it to what the cascades cover.
- Materials that move vertices or cut holes (alpha test, alpha map, position
  or mask nodes, transparency) are excluded and keep casting themselves
  (`proxyableMaterial`).

Relevance: our stationary shadow pass is 23 % of main-thread time and its cost
is CPU submission of about 95 draws per frame, not GPU raster (R2). Unlike the
rejected cached shadow map, this does not need a static shadow map or depth
copies, so moving traffic is unaffected. Here it would be a per-tile shadow
mesh built when a tile's buildings are published and disposed with the tile.
Passage materials (`BuildingPassageMaterial` discard) and alpha-tested greenery
would keep casting directly. Acceptance would be the R2 one: fewer shadow draws
and lower stationary main-thread time in a paired capture, with unchanged
shadows in screenshots.

### 2. Shared procedural facades with sub-pixel prefiltering — R1, R4

`js/tsl-materials.js`, `facadeCell` and the facade materials.

- Every facade of a style shares one material. Window grids, floors, ground
  floor shops and interior-mapped rooms are computed in the fragment shader
  from box-local or world coordinates; instances carry only parameters (size,
  tone, face treatments).
- The grid uses analytic anti-aliasing that settles to the mean coverage once
  a window period falls below a pixel, so distant facades do not moiré or
  shimmer while the camera moves.

Relevance: R1 counts about 170 `FacadeAtlas:*` meshes, each with its own
material (tile × atlas page). R1's planned `DataArrayTexture` atlas solves the
material count for real facade imagery; a shared procedural material could
cover generic buildings that have no imagery. The prefiltering idea applies to
any repeated facade pattern regardless. Cost: more fragment ALU, which works
against R4, so it should be limited to generic/far facades and measured at DPR
1.5.

### 3. Cull distance from projected size — R3

`js/scene-culling.js`, `instanceSize` and `setupSceneCulling` part 1.

- Island-wide instanced prop meshes are split into 250–600 m spatial chunks.
- Each prop type is hidden beyond the distance where it falls below about one
  or two pixels: `size × 1100 / distance`, using the 90th-percentile instance
  size, floored at the 300 m shadow reach. Unlit glowing props get three times
  the distance.

Relevance: a cheap, untuned rule for the small-mesh tail in R3
(`DecorGreenery`, `TramRails` and similar), if those are not already culled by
projected size.

## Smaller patterns

- **Fixed-capacity near-detail pools** (`js/buildings.js`, `update`).
  Cornices, water towers, HVAC, fire escapes and awnings live in instanced
  meshes of fixed capacity. They are refilled nearest-block-first only after
  the focus moves 18 m, and only the used prefix is uploaded
  (`addUpdateRange`). No allocation while moving.
- **Shadow-pass shader warm-up** (`js/main.js`). After `compileAsync` (16
  concurrent jobs, one per shared pipeline), one frame is rendered behind the
  loading screen with frustum culling off, which compiles the shadow-pass
  variants that `compileAsync` does not reach. Open check for us:
  `core/detached-gpu-prewarm.js` disables the shadow map while prewarming
  (`withOffscreenTarget`); confirm whether shadow depth programs are compiled
  elsewhere, or whether a new caster material hitches the first time it casts.
- **Half-resolution post effects.** SSR and bloom run at half resolution and
  SSR fades out between 180 and 360 m.
- **Simulation step clamp.** `dt` is clamped to 1–50 ms; telemetry uses wall
  time so slow frames still show.

## Does not transfer

- `StorageInstancedBufferAttribute` for instance matrices, discarding
  multisampled colour attachments, `ClusteredLighting` and the TSL post chain:
  all WebGPU-specific. The backlog has no current justification for a WebGPU
  rewrite.
- Building the whole world at load: our data is real, regional and streamed.
