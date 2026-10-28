# rime-cantonese (vendored data)

Two dictionary files from [rime-cantonese](https://github.com/rime/rime-cantonese), the
Cantonese input schema maintained by the Cantonese Computational Linguistics Infrastructure
Development Workgroup ([CanCLID](https://github.com/CanCLID)). They are the source of the
Jyutping readings that Phonetic Assistance shows over Chinese characters.

| File | What it holds |
| --- | --- |
| `jyut6ping3.chars.dict.yaml` | Every character's readings, with how often each is used |
| `jyut6ping3.words.dict.yaml` | Words and their readings |

- **Version:** commit [`259f0e4`](https://github.com/rime/rime-cantonese/tree/259f0e48bba840c3a2e0d117539e96937f3d89bc)
  (dictionary version 2026.08.10), copied unchanged.
- **Licence:** [Creative Commons Attribution 4.0 International](LICENSE-CC-BY). The
  project's only ODbL file, `jyut6ping3.maps`, is not used.

The extension does not ship these files. At build time `scripts/build-jyutping-dict.mjs`
reads them and writes the much smaller `dist/jyutping-yue.tsv.gz`.

They are kept here rather than installed because rime-cantonese is not published to npm,
and its repository cannot be installed as a package.

## Updating

Download both files from the commit you want, replace them here, update the commit above,
then run `npm run build` and `npm test`.
