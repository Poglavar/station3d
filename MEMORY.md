# Project memory

- Station3D is the temporary name for a reusable travel and game engine powered by OpenStreetMap and other open data.
- Downstream products consume exact Station3D versions at build time; Zagreb Prijevoz is the reference integration during the alpha period.
- Reusable world behavior stays in Station3D; Zagreb applications retain regional providers, host integration and authored campaign content.
- Original engine code and creator-authored vehicle models, including the reusable HŽ 7022, TMK 2400 and UTVA models, are MIT licensed; third-party audio retains its recorded terms.
- The public repository starts from a clean extraction snapshot without inherited commits, authored campaign content or automation attribution.
- Browser consumers receive a self-contained built directory through npm and vendor it into their own public tree.
- A ground generation may only require terrain evidence that is loaded or requested; road owners reaching past it are deferred (with their terrain cut), not failed (2026-09-23).
- Stationary sessions must wake the next road admission when deliveries are parked behind the handoff barrier; the wake is gated behind reveal so startup still waits only for observer tiles (2026-09-23).
- A static/dynamic cached shadow map was rejected: depth restores cost +3–4 ms GPU per frame on ANGLE/Metal; the shadow pass is only skipped when nothing it draws changed (2026-09-23).
- Performance timings are judged by tools/perf-probe.mjs windows without host paging; GPU timer values under vsync are distorted by GPU clock scaling (2026-09-23).
- Performance work may rethink shared engine architecture; remove demonstrably repeated work before larger rewrites, and keep predicted savings separate from quiet-host acceptance evidence (2026-09-28).
- Complete-source walk/rail replay and quiet-host alpha.6 acceptance precede the next worker or building-batching optimization; sealing response bytes alone does not prove route coverage (2026-10-08).
