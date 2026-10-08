# Procedural crowd-face atlas

`crowd-faces.png` is generated locally by
`scripts/generate-crowd-face-atlas.mjs` from the first-party rasterizer in
`core/crowd-face-atlas.js` and face definitions in
`core/person-appearance.js`. The rasterizer creates the image pixels directly;
it uses no third-party image, model, dataset, or provider input.

The generator, source definitions, and generated atlas are original Station3D
material under the repository MIT license.

Regenerate with the repository's pinned Node toolchain from its root:
`node website/station-3d/scripts/generate-crowd-face-atlas.mjs --write`.
