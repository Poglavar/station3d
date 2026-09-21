# Rain ambience — provenance

The runtime uses two unmodified MP3 loops from Ylmir's **Rain (loopable)** pack:

https://opengameart.org/content/rain-loopable

The author describes these as window recordings made with a mono microphone and
processed to stereo. The OpenGameArt submission lists CC0 as its only licence
and provides the same four authored loops in MP3 and OGG formats. Verified
2026-09-20.

| runtime file | source file | duration | use | licence |
|---|---|---:|---|---|
| `rain-light.mp3` | `4.mp3` from `Rain MP3.zip` | 37.5 s | quiet/drop-rich layer | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `rain-steady.mp3` | `1.mp3` from `Rain MP3.zip` | 27.0 s | steady-rain layer | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

Both files are the source pack's 44.1 kHz stereo, 192 kbit/s MP3 releases. The
runtime crossfades them by rain intensity and applies only live gain and shelter
filtering; the checked-in recordings are unchanged.

Source archive checksums used for this import:

- `1.mp3`: `da5f63758a4d74e10ab9dd1b0bed62aa4c06fd960af6a7cdb83266354d75204f`
- `4.mp3`: `f78456c719c01350e85d588c3709f50fc20d176cc2ea356fa41e24c7f7fae38d`
