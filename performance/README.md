# Performance measurement

Status: **retired instructions**. The profiler described by the pre-extraction
version of this file depended on a downstream Zagreb checkout and is not present
in the public Station3D package. Do not cite those commands as a runnable engine
benchmark.

The current measured baseline, defect analysis, ranked backlog and acceptance
procedure are in
[`docs/performance-audit-2026-09-22.md`](../docs/performance-audit-2026-09-22.md).

A replacement benchmark should be package-owned, start a fresh headed browser,
accept a consumer-supplied URL, record cold and settled phases separately, and
emit machine/browser metadata alongside frame, queue, renderer, network and
lifecycle-memory results. Until that work is implemented, preserve raw evidence
outside the repository and record the exact manual method in each dated audit.
