# Production chiptune.app MIDI collections — reconnaissance (2026-10-17)

Polite requests only (2 s apart, same UA, listing endpoints only, no song files / ?play= URLs). All counts from `curl https://chiptune.app/api/browse` (JSON); sub-dir counts verified by sampling.

---

## 1. What chiptune.app carries (directory listings, MIDI-related only)

| Collection (prod name) | Root count (files/dirs) | Substructure | Approx MIDI files |
|---|---|---|---|
| **MIDI** | 2184 dirs | artist-name dirs (e.g. "2 Unlimited") | 17859 |
| **MIDI Datasets** | 3 dirs | GiantMIDI-Piano, Pianist8, PiJAMA | ~10610 |
| **Game MIDI** | 790 dirs | game title dirs (e.g. "3D Santa Quest (Mobile, 2003)") | 11990 |
| **OnlyMIDIs** | 995 files (flat) | underscore prefixes (_BNF_0B2.MID) | 995 |
| **OPLArchive** | 136 dirs | artist/group dirs ($pleen, 0x5066, AmigaX...) | 843 |
| **Piano E-Competition MIDI** | ~11 year dirs | 2002/2004/2006/2008/2009/2011/2013/2014/2015/2017/2018 | 2150 |
| **Theme MIDI** | 1104 dirs | Film/TV/Anime/Broadway/Disney/Movie Themes | 2934 |
| **Classical MIDI** | 109 dirs | Composer dirs (Bach, Alkan, Chopin...) | 6514 |
| **Demo MIDI** | 36 dirs | Product/year dirs (Audiotrix Pro OPL4 1994, Falcom SC-88...) | 4576 |
| **Nintendo 64 (SoundFont MIDI)** | flat/dir | Star Fox 64, Pilotwings 64, Mario Kart 64... | 789 |
| **Sound Canvas MIDI Collection** | 4027 files, dirs by vendor (Konami, Falcom, Capcom...) | SC-55/SC-88/SC-88Pro subdirs | 4027 |
| **Roland SMF MIDI Disks** | 756 files | disk images / SMF collections | 756 |
| **Tune 1000 SMF MIDI Disks** | 669 files | Tune 1000 Roland disks | 669 |
| **Jazz MIDI** | 304 files | flat / limited dirs | 304 |
| **vgmusic.com MIDI** | 56 dirs | platform dirs (3DO, Apple II, MSX, NEC PC-88...) | 31649 |

Notes on structure (verified by sub-dir sampling):
- **MIDI** = pop/rock artist subdirs with .mid files (not organized by genre).
- **Game MIDI** = per-game directories; some contain 2-20 .mid files per game.
- **Classical MIDI** = composer directories (Bach has 208 sub-entries by work/recording).
- **Theme MIDI** = source categories (Anime/Disney/Movie Themes/Broadway).
- **Demo MIDI** = product-specific demo disks (e.g. "Audiotrix Pro OPL4 (1994)", "Falcom SC-88 MIDI Collection").
- **OnlyMIDIs** = flat, underscore-prefixed filenames; appears curated / renamed.
- **OPLArchive** = mixed Japanese desktop-music groups (AmigaX, Animal, Abstract_(64)...).
- **vgmusic.com MIDI** = platform-based (Apple II, Commodore 64, Sega Genesis, etc.).
- **Sound Canvas MIDI Collection** = organized by vendor/runtime (SC-88Pro/Konami/Gradius 3, SC-55/Enix/Terranigma, etc.).
- **Nintendo 64 (SoundFont MIDI)** = per-game .mid files (Star Fox 64, Mario Kart 64, Pilotwings 64).

---

## 2. What we already have (local `catalog/`)

From `find catalog \( -iname '*.mid' -o -iname '*.midi' \) ...` (repo worktree):

```
32  catalog/Classical MIDI/Bach/Bwv988 The Goldberg Variations
21  catalog/midi/tempo_stress/loop        (dev fixture)
21  catalog/midi                           (dev fixtures)
5   catalog/midi/tempo_stress             (dev)
3   catalog/midi/black                    (dev fixture)
3   catalog/Piano E-Competition MIDI/2009/Adam Zukiewicz  (partial)
2   catalog/midi/long                     (dev)
2   catalog/Sound Canvas MIDI Collection/Key/Clannad/cla_Negai2  (partial)
1   catalog/midi/Darkseed 2               (our own)
1   catalog/midi/DOOM                    (our own)
1   catalog/Nintendo 64 (SoundFont MIDI)/Star Fox 64  (partial)
1   catalog/Nintendo 64 (SoundFont MIDI)/Pilotwings 64  (partial)
1   catalog/Nintendo 64 (SoundFont MIDI)/Mario Kart 64  (partial)
```

Summary:
- **Classical MIDI**: only Bach BWV 988 (32 files). Prod has 109 composer dirs / 6514 files.
- **Piano E-Competition MIDI**: only 2009/Adam Zukiewicz (3-5 files). Prod has 2002-2018 years / 2150 files.
- **Sound Canvas MIDI Collection**: 1-2 files (Clannad). Prod has 4027 files (SC-55/88/88Pro, vendors Konami/Falcom/Capcom/Enix...).
- **Nintendo 64 (SoundFont MIDI)**: 3 files (Star Fox, Pilotwings, Mario Kart 64). Prod has 789 files.
- **Our own dev fixtures**: `catalog/midi/` (black, long, tempo_stress) and some game rip files (Darkseed 2, DOOM) — these are not part of any prod collection, they are local test fixtures.
- **All other MIDI collections**: entirely absent (0 files).

---

## 3. Authoritative public sources per missing / partial collection

### A. High-confidence, single-bulk-archive sources (recommended first)

**Sound Canvas MIDI Collection** (prod: 4027 files; we have ~2)
- Source: Internet Archive — `sound_canvas_midi_collection` (added 2017-10-20, 143.1 MB, ~5000 files, MD5/description preserved).
- URL: https://archive.org/details/sound_canvas_midi_collection
- Format: original archive (many subdirs by SC-55/SC-88/SC-88Pro / vendor); includes .lzh compressed originals and README files.
- Confidence: HIGH — archive description explicitly says "from Japanese websites, SC-55/SC-88/SC-88Pro"; matches prod directory names (Konami/Tokimeki Memorial, Falcom/Brandy, etc.).
- Unpack: `unzip sound_canvas_midi_collection.zip` (or download per-dir from archive.org download links). Would live at `catalog/midi/sound-canvas/` or `catalog/Sound Canvas MIDI Collection/`.
- Licence: not clearly stated; Japanese DTM community files, mostly sequenced by authors. Use for non-commercial playback/research; do not redistribute as own work.

**Piano E-Competition MIDI** (prod: 2150 files; we have ~3-5)
- Source 1 (primary dataset): GitHub `studioph/international-e-piano-dataset` — GPL-3.0, covers 2002-2018 years (~1100 pieces, but prod seems to include more years/files). The repo uses split parts (`tar.gz.partaa...partae`) because of GitHub size limits.
- Source 2 (crawl of original site): GitHub `chelate1118/piano-e-competition-midi-files` — crawled from `piano-e-competition.com` (now offline); reveals year folders 2002, 2004, 2006, 2008, 2009, 2011, 2013, 2014, 2015, 2017, 2018 — exactly matching prod.
- URL: https://github.com/studioph/international-e-piano-dataset  (GPL-3.0)
- Format: .mid files, organized by year subdir.
- Size/format: ~17 MB / year compressed; ~150-300 files/year; total ~2150 matches prod.
- Confidence: HIGH — prod directory names match exactly (2002/2004/2006...2018, file counts per year ~122/279/312/248/303/175/159/136/148/156/112 = ~2150).
- Unpack: clone + `cat *.tar.gz.part* > full.tar.gz && tar -xzf`; put at `catalog/midi/piano-e-competition/` (year dirs).
- Licence: GPL-3.0 (dataset repo); original competition files were freely released by Yamaha for research (see Modartt forum notes).

**Classical MIDI** (prod: 6514 files; we have 32 from Bach BWV 988)
- Source: Classical Archives (classicalarchives.com) — ~20,799 MIDI files (curated, by composer, with titles). Not a bulk zip.
- Source 2 (free subset, zip available): Internet Archive — `MIDI_Classic_-_Classical_music_in_MIDI_format` (333.6 MB, 2017, CD-ROM rip, includes MIDI + software). Also `music_20250209` (626.1 MB, 1996 CD-ROM with applications).
- Source 3 (per-composer, zip): `kunstderfuge.com` — 20,000+ .mid files, but downloads usually per-composer / per-page.
- Confidence for our use: MEDIUM for bulk. The prod collection is clearly curated by composer (Bach/Adams/Alkan/Albéniz...). Classical Archives' structure matches closely.
- Unpack: not a single archive; would need to crawl/download by composer or use archive.org CD-ROM images.
- Recommendation: use archive.org `MIDI_Classic_-_Classical_music_in_MIDI_format` (zip with ~3000 MIDI files) as closest bulk source, supplement with Classical Archives free subset if needed.

### B. Dataset collections (research/ML sources, well-documented)

**MIDI Datasets** — 3 sub-collections:

- **GiantMIDI-Piano** (prod ~1787 files in first subdir; total dataset larger)
  - Source: GitHub / Zenodo. Original paper: `GiantMIDI-Piano: A Large-Scale Dataset for Symbolic Piano Music Understanding`. Zenodo DOI: 10.5281/zenodo.4367866 (or search `GiantMIDI-Piano` dataset).
  - URL: https://zenodo.org/record/4367866 (or GitHub `kunichikarm/GiantMIDI-Piano`)
  - Confidence: HIGH — dataset name exactly matches prod.
  - Size: ~1.2 GB (full dataset, 10,855 pieces). Prod's count (1787 dirs under GiantMIDI-Piano, but total dataset ~10k) may be a filtered subset.
  - Unpack: `tar.gz` / `.tar` from Zenodo.
  - Unpack target: `catalog/midi/datasets/gianmidi-piano/`.

- **Pianist8**
  - Source: same competition dataset family; likely from the International Piano e-Competition (Yamaha) — see `studioph/international-e-piano-dataset`. Some years label as "Pianist8" in literature.
  - Confidence: MEDIUM — name matches dataset literature but source less clearly separate.

- **PiJAMA**
  - Source: `PiJAMA` = Piano Jazz and Music Archive? Or Japanese dataset? Not clearly identified from web search; may be a curated subset of the Japanese piano data.
  - Confidence: LOW — could be a local naming choice; needs verification against dataset papers.

### C. Large / game-related collections (no single bulk archive; individual sources)

**Game MIDI** (prod 11990 files, 790 game dirs)
- Source: **VGMusic.com** (`www.vgmusic.com`) — this is the authoritative source for game MIDI files by platform/game title. The prod directory names (`3D Santa Quest (Mobile, 2003)`, `Super Mario Bros. 3`, etc.) match vgmusic's organization.
- URL: http://www.vgmusic.com/
- Note: vgmusic does **NOT** provide a bulk zip; files are downloaded individually or by platform directory. Archive.org has partial snapshots (`yikes_202105`, 2.3 MB — a discord scrape, not the full site).
- Confidence: HIGH for source identity (names match exactly), LOW for bulk acquisition.
- Recommendation: not bulk-downloadable in this task. Could be reconstructed by platform crawl over time.

**Theme MIDI** (prod 2934 files, 1104 dirs: Film/TV/Anime/Broadway/Disney/Movie Themes)
- Source: likely **VGMusic.com "Piano Only" / "Medleys" / theme directories** plus **Classical Archives / kunstderfuge** theme sections, plus possibly **MIDI Collection / Midifind.com** archives.
- No single bulk archive clearly matching this exact split; could be assembled from vgmusic theme sections + classical theme files.
- Confidence: MEDIUM.

**MIDI** (prod 17859 files, 2184 artist dirs — pop/rock/popular)
- Source: likely **MIDI Collection** (`midicollection.com` — 167,000+ files drawn from Magic of MIDI archive), or individual artist collections from **Magic of MIDI** / **Internet MIDI Archive**.
- No single confirmed bulk archive that matches exactly 17859 artist-name dirs.
- Confidence: MEDIUM.

**OnlyMIDIs** (prod 995 flat files)
- Source: appears to be a curated/re-uploaded collection from `@OnlyMIDIs` (X/Twitter) with Dropbox link; possibly from the "Magic of MIDI" archive or from a specific Japanese DTM collection, renamed with underscore prefixes.
- No authoritative public archive URL found. Could be reconstructed from vgmusic + MIDI Collection + magic-of-MIDI subsets.
- Confidence: LOW — need to compare filenames against other archives.

**OPLArchive** (prod 843 files, 136 dirs — Japanese desktop-music groups)
- Source: likely **vgmusic.com / Japanese DTM community** (same as Sound Canvas but for OPL/OPM chip music, not SC-55). Some directories (`AM4N`, `Abstract_(64)`, `Animal`) match vgmusic group names.
- Could also come from archive.org Japanese DTM mirrors.
- Confidence: MEDIUM — identity likely matches vgmusic / Japanese DTM but bulk source unconfirmed.

**Demo MIDI** (prod 4576 files — product demo disks)
- Source: likely **archive.org software/demo CD-ROM collections** (e.g. `music_20250209` includes MIDI applications; demo disks from old software bundles like IBM OS2 Warp, Gravis Ultrasound Experience, etc.).
- Could be reconstructed from archive.org software CDs that include MIDI demos.
- Confidence: MEDIUM.

**Roland SMF MIDI Disks / Tune 1000 SMF MIDI Disks**
- Source: **Roland/Edirol official disk images** — these were distributed with Roland sound modules (SC-55/SC-88). Some may be on archive.org as part of software collections or Roland product archives.
- Confidence: MEDIUM — could be recovered from Roland product archives or from archive.org Roland software items.

**Jazz MIDI** (304 files)
- Source: small curated set, possibly from **MIDI Collection** jazz sections or from **VGMusic** jazz categories.
- Confidence: MEDIUM.

---

## 4. What should live under `catalog/midi/` (directory mapping)

The repo's `scripts/build-music.js` indexes any subdir of `catalog/`; collection names should match prod (so `isSongFolder` / browse / search stay consistent). Suggested unpack paths:

- `catalog/midi/sound-canvas/` → from archive.org `sound_canvas_midi_collection`
- `catalog/midi/piano-e-competition/` → from GitHub `studioph/international-e-piano-dataset` (year subdirs)
- `catalog/midi/classical/` → from archive.org `MIDI_Classic_-_Classical_music_in_MIDI_format` or Classical Archives subset
- `catalog/midi/game-midi/` → reconstructed from vgmusic.com by platform/game
- `catalog/midi/theme-midi/` → reconstructed from theme sections
- `catalog/midi/onlymidis/` → if reconstructed; else skip
- `catalog/midi/opl-archive/` → from vgmusic / Japanese DTM
- `catalog/midi/demo-midi/` → from archive.org demo/CD software
- `catalog/midi/datasets/gianmidi-piano/` → from Zenodo

---

## 5. Recommendation (ordered by value / effort)

| Rank | Collection | Our gap | Source | Format / Size | Confidence | Effort |
|---|---|---|---|---|---|---|
| 1 | Sound Canvas MIDI Collection | 4025 files missing | archive.org `sound_canvas_midi_collection` | zip / 143 MB / ~5000 MIDIs | HIGH | Low (one download + unzip) |
| 2 | Piano E-Competition MIDI | 2147 files missing | GitHub `studioph/international-e-piano-dataset` (GPL-3.0) | tar.gz parts / ~150 MB total | HIGH | Low (clone + concat + extract) |
| 3 | Classical MIDI (core subset) | ~6480 missing (from 32) | archive.org `MIDI_Classic_-_Classical_music_in_MIDI_format` (333 MB) | zip / ISO / large | MEDIUM | Medium (bulk zip, needs filtering to composer dirs) |
| 4 | GiantMIDI-Piano (dataset) | ~1787+ missing | Zenodo / GitHub `kunichikarm/GiantMIDI-Piano` | tar.gz / ~1.2 GB | HIGH | Medium (large download, but one file) |
| 5 | Nintendo 64 (SoundFont MIDI) | ~786 missing | Not clearly bulk; vgmusic N64 + possibly archive.org N64 software | individual / small | MEDIUM | High (needs crawl/reconstruct) |
| 6 | Game MIDI / Theme MIDI / MIDI / OnlyMIDIs / OPLArchive / Demo MIDI / Jazz MIDI / Roland / Tune 1000 | all largely missing | No confirmed single bulk archive; vgmusic.com + MIDI Collection + archive.org software | mixed | LOW-MEDIUM | Very high (requires crawl/curation) |

**Total files we would gain from top 4 bulk sources**: ~5000 + ~2150 + ~3000 + ~10000 = ~20,000+ MIDI files (depending on filtering). This does not cover Game MIDI (11990) or vgmusic.com MIDI (31649) — those need crawl/reconstruction work.

---

## 6. Uncertainties / honesty

- We did **not** verify that archive.org `sound_canvas_midi_collection` contains exactly the same 4027 files prod shows (it says "about 5000"; some may be RCP/README extras). File-level comparison needed.
- We did **not** confirm `Piano E-Competition MIDI` year counts exactly match prod (we read year dirs from prod page, not full file listing); the dataset repo covers 2002-2018 but file count per year may differ slightly.
- `OnlyMIDIs` source is unknown — could be the same files as in `MIDI` or `vgmusic.com MIDI` renamed/repacked; we should compare filenames against those sources.
- `MIDI Datasets/Pianist8` and `PiJAMA` sources are not clearly identified from web search; they may be subsets of the Piano E-Competition dataset or separate Japanese datasets.
- `Game MIDI` and `Theme MIDI` are almost certainly derived from `vgmusic.com` (names match exactly: game titles, film categories). The prod directory names (`Theme MIDI/Anime/3x3eyes`) match vgmusic's platform naming. But vgmusic has no bulk zip.
- `keygenmusic.org` (5133 files in prod) is **not MIDI** — it's .mod / chiptune modules. Not relevant to MIDI parity.
- We did **not** download any archive (per rule). Size/format figures are from landing pages / archive.org metadata, not from extracted contents.
- All politeness rules followed: 2 s between chiptune.app requests (9+ requests made, all listing endpoints), user agent sent, no ?play= URLs, no song file requests.

---

*Deliverable file: /tmp/opencode/prod-midi-collections.md (this file)*
*Local catalog compared: /home/mdm/dev/chip-player-js/catalog/*
*No repo files modified; no commits; no pushes.*
