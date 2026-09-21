# Underpass ground boundary release — 15 September 2026

**State: deployed as `08e9e294` (engine correction `6d78916f`).** The wider road/cycle/parking/construction
appearance batch remains unreleased because its stationary performance comparison did not clear
the recorded tail screen.

At Savska, the widthless underpass definition (`osm-1027705611`) used a 12 m half-width for terrain
removal but a 6 m half-width for its physical formation. Terrain therefore disappeared beyond the
replacement floor. Clipped opening runs also computed their end directions from the shortened run,
which could turn a curved boundary outside the structure.

The shared engine now resolves physical carriageway/formation dimensions once for terrain cuts,
structure rendering and physical structure queries. Opening rows use the same full-alignment frames
as the rendered floor. The separate radius used to associate road profiles is unchanged. An explicit
road replacement with omitted cross-section fields now emits its default physical floor. Genuine
portal openings and terrain above covered tunnel sections remain intact.

This package contains four runtime files, two regression files and the captured Savska fixture.
It does not include the pending appearance compositor migration or dense-detail road query index.
The capture-tool improvements ship separately: owned Chrome server reuse, retained failure evidence,
and an explicitly declared first variant for paired measurements. They change no simulator behavior.

## Evidence and limits

- The isolated production baseline plus these seven files passes **108/108 headless checks** across
  nine explicit test files, including real Three.js structure meshes, collider publication/rollback,
  curved openings, explicit/default dimensions, bridge/underpass evidence and alignment query costs.
- The captured cut regression tests more than 500 interior points against the renderer's actual
  floor triangles. Both previously missing parking probes are outside the repaired terrain cut,
  while the real portal remains open and the covered box retains its terrain roof.
- All four runtime files are byte-identical to the V8 version already checked in native Chrome at
  Savska. That capture verifies actual published terrain and walk support at the two gap probes
  (`−3.7774 m` and `−3.6928 m`). The broader appearance captures are not claimed as a standalone
  performance comparison of this smaller package. No additional headed run was made for extracting
  the already verified physical correction; its existing structure/generation paths remain in use.
- The separate capture helpers pass **12/12** focused checks. The retained-browser batch was closed;
  native `browser-reap --status` reported no automation browsers remaining.
- The production build passes: **36 JavaScript files / 7,391,787 bytes**. Frozen website fingerprint:
  `342aac0a1a1356b90c5d864d2abcbd95bdb0ebd0381f96049b0e019244fcaf41`.

The source hash inventory, explicit test lists/logs and frozen checkout are retained under
`output/ground-appearance-release-20260915/` and `/private/tmp/ground-underpass-release-20260915`.
No claim is made that every physical overlap or rail finding is fixed. Land-use migration,
remaining markings, rail appearance and final campaign regeneration remain later plan steps.

## Publication

Deployed from clean `main` at `08e9e294e39ef55cb65f76ea22bf636132f64158`; engine correction is `6d78916f`. The normal deployment rebuilt 36 JavaScript outputs / 7,391,787 bytes, stamped 57 HTML asset attributes without changing JavaScript, and returned a successful Cloudflare cache purge. The server/public proof covers all 36 emitted modules and 136 import edges: 20 explicit generated-name renames map the frozen build to the server build, then every normalized module byte and import target matches; public bytes exactly equal the server build. All emitted modules, including the entry and render compiler worker, returned 200 `application/javascript` with `no-cache`. The four runtime source modules also exactly match the frozen native Savska proof; receipt: `output/ground-appearance-release-20260915/deployment/underpass-runtime-source-readback-08e9e294.json`.
