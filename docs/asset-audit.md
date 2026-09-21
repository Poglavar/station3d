# Asset and license audit

Status: the packaged-media allowlist and public-bundle source audit cleared on
21 September 2026. The release command must continue to pass before every
public tag or npm publication.

The MIT license covers original Station3D code and the creator-authored vehicle
models explicitly listed in `models/vehicles/LICENSE.md`. Other data, audio,
images, fonts, models and generated artifacts retain their own licenses and are
represented separately in `THIRD_PARTY_NOTICES.md` and the machine-readable
asset manifest.

## Inventory snapshot

The extraction audit originally found approximately:

| Area | Size | Notable contents |
| --- | ---: | --- |
| `assets/campaign` | 48 MB | Portraits, blueprint and hundreds of campaign voice takes |
| `audio` | 31 MB | 742 MP3 and 11 WAV files across campaign and generic runtime audio |
| `models` | 129 MB | Runtime factories, GLB/JSON exports, Blender sources and review renders |
| `models/characters` | 37 MB | Viktorija campaign study and MakeHuman-derived sources |
| `models/structures` | 10 MB | Generated Croatian structures and Toranj studies |
| `models/vehicles` | 80 MB | Runtime models plus regional vehicle studies and renders |

Those campaign, regional and authoring-study paths were removed before the
public-history root was created. They remain available in the unchanged source
repository and are not part of Station3D.

The npm package uses the allowlist in `assets.manifest.json`, enforced by
`tools/audit-assets.mjs` and `tools/verify-package.mjs`. It contains reviewed
generic audio, seven generic road-fleet JSON models—hatchback, sedan, SUV, van,
box truck, city bus and pickup—and the UTVA runtime GLB. The project creator
confirmed authorship of these assets and of the procedural TMK 2400 and HŽ 7022
models, and released them under MIT.

## Source history

The public repository begins with a clean extraction snapshot. Its root commit
contains no inherited commits, excluded media blobs, co-author trailers or
automation identities. The unchanged regional source repository remains the
private provenance record.

The production metafile currently reports no review-required inputs. TMK 2400,
HŽ 7022 and UTVA are deliberately retained as creator-authored, MIT-licensed
reusable vehicle models. The campaign foot-pursuer implementation, authored
campaign/set-piece modules and their legacy tests were removed from Station3D;
their unchanged originals remain in the downstream Zagreb repository.

## Proposed disposition

### Engine candidates

These may remain once their provenance records are normalized:

- Original procedural JavaScript geometry and generic model factories.
- Generic CC0/public-domain effects with existing source records: birds, dog
  barks, fireworks, fish splash, rain, car engine, boats/aircraft, track clangs,
  train sounds and dog panting.
- The tyre-skid loop under CC BY 3.0, provided the distributed asset retains its
  attribution and license notice rather than being described as MIT.
- MakeHuman-derived graphical assets where the pinned inputs are confirmed as
  CC0. The MakeHuman application is AGPL, but its bundled graphical assets and
  generated output are documented separately as CC0; no MakeHuman program code
  should be copied into Station3D.

Keeping a legally reusable asset does not mean it belongs in the core package.
Large optional audio and models should normally be downloadable asset packs.

### Zagreb or campaign packages

Keep these out of the initial engine repository, even if individual files may
eventually be publishable:

- `assets/campaign/**`, including portraits, blueprint and voice takes.
- Toranj campaign music, enemy music and authored announcements.
- Locally synthesized pedestrian conversations until the output terms of the
  system voices are recorded; the script also mixes generic, Zagreb and Split
  content.
- Viktorija, Toranj crown/eagle and other campaign studies.
- Named Croatian structures and the generated structure snapshot.
- Unreviewed regional liveries and study renders. The runtime TMK 2400, HŽ 7022
  and UTVA models are cleared as creator-authored MIT assets; their names
  identify depicted subjects and imply no affiliation or trademark licence.

### Remove from public Git history

- Superseded `*.take-*.mp3` voice attempts and other editing intermediates.
- Review renders and large editable studies that are not needed to build or run
  the engine. Cleared authoring sources can later live in a separate asset repo.
- Files with no source, author and license record.
- Generated files whose canonical source remains in a different repository,
  unless they are deliberately republished as a versioned downstream package.

History removal must happen with `git filter-repo` before the first public
remote is created. Deleting files in a later commit would leave every blob in
the public history.

## Data licensing

- Engine code must not embed a Zagreb API or data license assumption.
- OSM-derived databases and world packs require ODbL attribution and an offer
  of the applicable derived database or reproducible alteration method.
- Overture themes must carry their theme and upstream attribution metadata;
  Overture base/building data currently includes ODbL sources.
- DGU/GDI and other regional sources belong in downstream provider or world-pack
  manifests until their exact redistribution terms are recorded.
- Each provider or world pack must supply attribution metadata, and the host
  must display it visibly. The engine exposes that metadata but does not yet
  render a universal attribution control of its own.

## License layout

The intended structure is:

```text
LICENSE                         # MIT license for original code
THIRD_PARTY_NOTICES.md
assets.manifest.json            # source, author, license, changes, package
```
