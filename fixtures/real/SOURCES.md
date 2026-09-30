# Real files, for tests

Public files from NOAA, downloaded on 2026-09-30 with the owner's approval (needs.md D8).
They check the decoders on data the agencies actually publish, not only on files built
here to the layout. Each file is kept byte for byte as it was served, and
`.gitattributes` stops git from changing its line endings. Tests read them from
`src/realFiles.test.ts` and the module tests beside it.

| File | What | From | Licence | SHA-256 |
|---|---|---|---|---|
| `gfs-portland-20260930-00z-f006.grb2` | GFS 0.25°, run 2026-09-30 00Z, +6 h: 10 m U and V wind and MSLP, 41–46° N, 287.5–292.5° E. NOMADS repacks a filtered subset as simple packing (5.0). | [NOMADS GRIB filter](https://nomads.ncep.noaa.gov/gribfilter.php?ds=gfs_0p25), `filter_gfs_0p25.pl` | US government work, public domain | `c3527d17…7e273b` |
| `gfs-global-1p00-20260930-00z-f006-prmsl-ugrd10.grb2` | Two whole global messages from GFS 1°, the same run: MSLP and 10 m U, cut from `gfs.t00z.pgrb2.1p00.f006` by the byte ranges in its `.idx`. These keep NCEP's own packing: complex packing with second-order spatial differencing (5.3). | [NOMADS](https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/), HTTP range requests | Public domain | `c794035c…d0f30b` |
| `gfs-portland-1p00-20260930-00z-f006-subset.grb2` | The same two fields over 41–46° N, 287–293° E, repacked by NOMADS (wgrib2) as simple packing. Our decode of the global messages must equal NOAA's decode of them at every shared point. | NOMADS GRIB filter, `filter_gfs_1p00.pl` | Public domain | `5fff3055…530dd8` |
| `WMM2025.COF` | World Magnetic Model 2025 coefficients (identical to the package's `WMM.COF`). | [NOAA NCEI](https://www.ncei.noaa.gov/products/world-magnetic-model/wmm-coefficients), `WMM2025COF.zip` | Public domain | `dfa85978…75582f` |
| `WMM2025_TestValues.txt` | NCEI's official test values for WMM2025: declination, inclination and the field at set points and dates. | the same zip | Public domain | `e6975b09…4f5819` |
| `US5PWMDC.zip` | NOAA ENC **Portland Harbor and Vicinity**, 1:12,000: base cell `.000` (edition 5) and update `.001`, with NOAA's catalogue, readme and **user agreement**, unmodified. | [NOAA ENC downloads](https://charts.noaa.gov/ENCs/ENCs.shtml), `https://www.charts.noaa.gov/ENCs/US5PWMDC.zip` | Official NOAA product. Redistribution is allowed, and the agreement asks that copies carry it and point to NOAA's site. The zip carries `USERAGREEMENT.TXT`, and this line points to the site. A copy is **not** an official ENC and is not for navigation. | `708d73ad…babb54` |
| `RNC-14983.zip` | NOAA raster chart **14983, Northern Light Lake** (Minnesota), 1:42,240, BSB 3.0, as NOAA published it in June 2010 (edition 9), with its user agreement. It uses a Lambert conformal conic projection, with WPX/PWX polynomials and 77 reference points. NOAA withdrew its RNCs in 2025, so this is the Internet Archive's copy of NOAA's own file. | `http://www.charts.noaa.gov/RNCs/14983.zip` via [the Wayback Machine](http://web.archive.org/web/20100608230120id_/http://www.charts.noaa.gov/RNCs/14983.zip) | NOAA product, public domain; not for navigation | `3087ef5c…759ceb` |
| `coops-8418150-harcon.json` | NOAA CO-OPS harmonic constants for **Portland, ME (8418150)**, metres. | [CO-OPS metadata API](https://api.tidesandcurrents.noaa.gov/mdapi/prod/), `stations/8418150/harcon.json?units=metric` | Public domain | `0c9ccdbf…5ed9e7` |
| `coops-8418150-datums.json` | Its datums, metres. | the same API, `datums.json?units=metric` | Public domain | `96d8ef71…a42be9` |
| `coops-8418150-predictions-20261001-07.json` | NOAA's own hourly predictions for 1–7 October 2026, MLLW, metres, GMT. | [CO-OPS data API](https://api.tidesandcurrents.noaa.gov/api/prod/), `product=predictions` | Public domain | `a732d022…114ee4` |

Full hashes: `sha256sum fixtures/real/*`.
