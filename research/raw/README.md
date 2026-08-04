# Raw research artifacts

This directory is **gitignored** apart from this file. It holds large downloaded source
material that we reference but do not redistribute.

## Contents (recreate locally as needed)

| File | Source | Purpose |
|---|---|---|
| `Expedition.pdf` | <https://www.expeditionmarine.com/downloads/documents/Expedition.pdf> | The official Expedition help manual — primary source for `docs/01-expedition-analysis/` |
| `Expedition.txt` | `pdftotext -layout Expedition.pdf Expedition.txt` | Searchable text extraction |

## Recreate

```bash
curl -o research/raw/Expedition.pdf https://www.expeditionmarine.com/downloads/documents/Expedition.pdf
pdftotext -layout research/raw/Expedition.pdf research/raw/Expedition.txt
```

## Why these aren't committed

They are third-party copyrighted material. We analyse and cite them under fair
use / fair dealing for interoperability and comparative research; we do not
redistribute them. Everything we concluded from them lives in `docs/`, in our own words,
with short attributed quotations.
