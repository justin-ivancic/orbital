# Future Library Metadata Notes

This note captures follow-up ideas for richer book metadata, AI-assisted tagging,
and creator/source pages. These are not implemented yet.

## Goals

- Let books carry meaningful genre/theme tags such as `philosophy`, `economics`,
  `fantasy`, `sci-fi`, `history`, `politics`, `psychology`, and similar.
- Prefer reading metadata from the original source file when possible.
- Optionally write metadata back to the source file so the tags travel with the file,
  not only with the app database.
- Support later filtering and sorting by:
  - tags
  - author
  - studio
  - publisher / imprint
  - translator / adapter where relevant
- Add creator/source profile pages so clicking an author or studio shows all related
  releases in the local library.

## Recommended Approach

Do not make "write directly into the original file" the only storage path.

Safer default:

- Read metadata from source files when available.
- Store normalized metadata in the app database.
- Allow optional write-back per file type when supported and explicitly enabled.
- Keep a sidecar fallback for formats that are awkward or unsafe to rewrite.

Why:

- Some formats are easy to read but risky to rewrite in place.
- Large files should not be rewritten unnecessarily.
- NAS libraries may contain read-only or externally managed files.
- AI tagging should be reversible and auditable.

## Metadata Storage Layers

Use a layered model in this order:

1. Local file metadata
2. Local sidecar metadata file
3. Manual admin override in app
4. AI-suggested tags accepted by admin
5. Online metadata match
6. App fallback parsing from filename/folder structure

That gives us a clear precedence order and keeps manual corrections stable.

## Book Metadata Plan

### Read from source files

Support first:

- PDF
  - title
  - author
  - subject
  - keywords
  - XMP metadata where present
- EPUB
  - title
  - creator
  - subject tags
  - language
  - publisher
- CBZ / manga archives
  - sidecar metadata first
  - later ComicInfo.xml if present

Likely read-only or lower priority at first:

- MOBI / AZW / other Kindle-related formats

### Write back to source files

Phase this carefully:

- EPUB write-back is the cleanest early target.
- PDF write-back should only happen through a dedicated metadata step and should
  preserve the original file contents safely.
- For unsupported or risky formats, write a sidecar instead.

## Suggested Sidecar Format

Use one sidecar metadata file per series or book when source-file write-back is not
available or not enabled.

Candidate names:

- `metadata.json`
- `.orbital-library.json`
- `ComicInfo.xml` for compatible manga archives later

Suggested fields:

- `title`
- `sortTitle`
- `author`
- `authors`
- `studio`
- `publisher`
- `year`
- `tags`
- `summary`
- `series`
- `volume`
- `chapter`
- `language`
- `sourceUrl`
- `overrideCover`

## AI Tagging Workflow

Desired future flow:

1. Admin selects a folder or the whole books library.
2. AI reads filename, embedded metadata, summary, and optionally OCR/text sample.
3. AI proposes normalized tags.
4. Admin approves, edits, or rejects suggestions.
5. Accepted tags go into:
   - app database
   - source-file metadata when safe and enabled
   - otherwise sidecar metadata

Important constraints:

- AI suggestions should never silently overwrite manual tags.
- Keep provenance for each field:
  - file
  - sidecar
  - manual
  - AI
  - online

## Creator / Source Profiles

Future entities to support:

- Author
- Studio
- Publisher
- Translator
- Imprint / Label

Desired UX:

- Each series/book card can show a creator/source chip.
- Clicking the chip opens a creator profile page.
- The profile page lists all local releases associated with that creator.
- The same person/entity should merge across categories when appropriate.

Examples:

- Books: `Ludwig von Mises`
- Anime: studio name
- Manga: author / artist pair
- Novels: author, translator, or publisher if known

## Data Model Ideas

Possible future tables:

- `creators`
- `creator_aliases`
- `series_creators`
- `entry_creators`
- `tags`
- `series_tags`
- `entry_tags`
- `metadata_sources`
- `metadata_overrides`

Needed behavior:

- normalized slug for creator pages
- alias merging
- one creator may have multiple roles
- one series may have multiple creators

## Search / Filter UX

Future additions:

- filter books by tag
- filter library by creator
- sort by author
- sort by year
- sort by title
- sort by recently added
- combine search with tag filters

Nice UI ideas:

- tag chips on book detail pages
- tag filter row in books category
- creator chip under title
- "More from this author/studio" section

## Incremental Scan Notes

When scanning books and series:

- detect source metadata changes via mtime / size / fingerprint
- re-read tags only when the file or sidecar changed
- do not re-run expensive extraction on every scan
- keep derived metadata cache separate from the source files

## Suggested Rollout Order

### Phase 1

- Read embedded metadata from PDF and EPUB
- Store normalized tags in the database
- Show tags on book detail pages
- Add books category tag filtering

### Phase 2

- Add manual admin tag editor
- Add sidecar metadata support
- Add author display and author filtering

### Phase 3

- Add creator profile pages
- Add manga/anime/novel creator fields
- Add AI-assisted tag suggestions with admin review

### Phase 4

- Optional write-back into supported source formats
- Provenance viewer for metadata origin
- bulk metadata tools

## Open Questions

- Should write-back be disabled by default for safety?
- Should AI tagging write into source files automatically, or only after approval?
- Should tags live at the book level, series level, or both?
- How should multi-author works be displayed in compact cards?
- For anime, should the visible creator field prefer studio, director, or source material author?

## Recommendation

When this work starts, begin with read + display + filter.

That gives immediate value without risking source files. After that, add manual
editing, then sidecars, then optional write-back, and only later AI-assisted bulk
tagging.
