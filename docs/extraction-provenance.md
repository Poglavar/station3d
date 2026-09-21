# Extraction provenance

Station3D was extracted from the `main` branch of
`Poglavar/zagreb-isochrone` at source commit
`8d86c0878e81a0db4c07b48254e9a32cfe2a470d`.

The initial filter retained these paths and their history:

```text
.gitignore
package.json
package-lock.json
website/station-3d/
website/model-viewer.html
website/serve.py
website/station3d-links.js
website/tram-switch-utils.js
website/tunnel-cover-rule.js
website/shared/transit-station-models.js
tools/build-station3d.mjs
tools/sync-structure-models.mjs
tools/update-model-codes.mjs
tools/publish-station3d-campaign-pack.mjs
tools/model_viewer_blender.py
tools/model_viewer_assets.py
tools/perf-trace.mjs
docs/adding-a-location.md
docs/*station3d*
performance/README.md
```

The public repository starts with one clean extraction commit. Inherited
commits, excluded binary blobs, co-author trailers and automation identities
were not carried into the public history. No remote was assigned during the
local extraction.

## Baseline validation

At this checkpoint:

- `npm run build:station3d` succeeds.
- The bundle contains 35 JavaScript outputs totaling 7,476,315 bytes.
- The complete inherited test command executes 4,694 assertions: 4,574 pass
  and 120 fail because intentionally omitted downstream files are still
  referenced by host-integration tests.
- The source checkout remained clean and unchanged.

The regional source checkout remains unchanged and retains the complete
development history and excluded downstream content.
