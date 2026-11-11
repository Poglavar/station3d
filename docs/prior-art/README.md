# Prior art

Notes on techniques from other projects that may apply to Station3D, one file
per project. These are leads, not decisions: an idea becomes work only when it
is moved into the [performance backlog](../performance/next-steps.md) (or the
relevant design document) and measured there.

Each entry records:

- the project, its URL, the commit reviewed and the date;
- why its results are or are not comparable with ours (renderer, data scale,
  streaming, pixel ratio);
- each idea with the source file it comes from, the Station3D backlog item it
  bears on, and what would have to hold for it to work here;
- what does not transfer, so it is not re-evaluated later.

Do not copy code from these projects without checking its licence and recording
it in `THIRD_PARTY_NOTICES.md`.

| Project | Reviewed | Main lessons |
| --- | --- | --- |
| [Slop New York](slop-newyork.md) | 2026-10-22, `0049a49` | Shadow-only proxy casters per cell; shared procedural facades with sub-pixel prefiltering; screen-size cull distances |
