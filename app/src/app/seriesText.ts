import type { Bookmark, CategoryId, EntryUnit, LibraryEntry, SavedReadingPosition, SeriesSummary } from '../appTypes'
import type { Strings } from '../i18n'

/* ---------------------------------------------------------------- titles -- */

export const seriesTitle = (series: Pick<SeriesSummary, 'title' | 'titleShort' | 'folder' | 'format'>) => {
  const folderLeaf = series.folder.split(/[\\/]/).filter(Boolean).pop() || ''
  return series.title.trim() || series.titleShort.trim() || folderLeaf.trim() || series.format.trim() || 'Untitled'
}

const localAuthorPattern = /^Local book file by (.+?)\.?$/i

/** The creator shown under a title, if the library knows one. */
export const seriesCreator = (series: Pick<SeriesSummary, 'sourceName'> & Partial<Pick<SeriesSummary, 'description'>>) =>
  series.sourceName?.trim() || series.description?.trim().match(localAuthorPattern)?.[1]?.trim() || null

// Descriptions the scanner writes when it knows nothing about a title.
const placeholderDescriptions = [
  /^Detected from folder structure and Plex-style/i,
  /^Folder-based manga indexing/i,
  /^Novel chapters mirror the folder structure/i,
  localAuthorPattern,
  /^Single-file local book entry/i,
  /^Magazine issues are grouped separately/i,
]

/** The description worth showing, or an empty string for scanner placeholders. */
export const seriesDescription = (text: string | null | undefined) => {
  const trimmed = text?.trim() ?? ''
  return placeholderDescriptions.some((pattern) => pattern.test(trimmed)) ? '' : trimmed
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Entry titles often repeat the series name and the label ("Dune - Chapter 3:
 * Arrival"). Only the distinctive part is shown next to the label.
 */
export const entryDisplayTitle = (entry: Pick<LibraryEntry, 'title' | 'label'>, series?: Pick<SeriesSummary, 'title'>) => {
  let title = entry.title.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()

  if (series?.title) {
    const seriesPattern = new RegExp(`^${escapeRegExp(series.title.trim())}\\s*(?:[-–:,.]\\s*)?`, 'i')
    title = title.replace(seriesPattern, '').trim()
  }

  title = title
    .replace(/^(?:vol(?:ume)?|v)\.?\s*\d+(?:\.\d+)?\s*(?:[-–:.]\s*)?(?=ch)/i, '')
    .replace(/^(?:chapter|ch|volume|vol|episode|ep|issue|book|part)\.?\s*\d+(?:\.\d+)?\s*(?:[-–:.]\s*|$)/i, '')
    .trim()

  const comparableLabel = entry.label.toLowerCase().replace(/\b0+(\d)/g, '$1')
  const comparableTitle = title.toLowerCase().replace(/\b0+(\d)/g, '$1')

  return comparableTitle && comparableTitle !== comparableLabel ? title : ''
}

const labelWords: Array<[RegExp, keyof Strings['labels']]> = [
  [/^chapter\b/i, 'chapter'],
  [/^volume\b/i, 'volume'],
  [/^issue\b/i, 'issue'],
  [/^episode\b/i, 'episode'],
  [/^book\b/i, 'book'],
  [/^part\b/i, 'part'],
  [/^prologue\b/i, 'prologue'],
  [/^epilogue\b/i, 'epilogue'],
  [/^extra\b/i, 'extra'],
  [/^special\b/i, 'special'],
  [/^side story\b/i, 'sideStory'],
  [/^interlude\b/i, 'interlude'],
  [/^entry\b/i, 'entry'],
]

/** "Chapter 007" → "Chapter 7" (or "Kapitel 7"). */
export const entryLabel = (label: string, t: Strings) => {
  const trimmed = label.trim().replace(/\b0+(\d)/g, '$1')

  for (const [pattern, key] of labelWords) {
    if (pattern.test(trimmed)) {
      return trimmed.replace(pattern, t.labels[key])
    }
  }

  return trimmed
}

/* ----------------------------------------------------------------- units -- */

export const defaultEntryUnit = (category: CategoryId): EntryUnit => {
  switch (category) {
    case 'anime':
      return 'episode'
    case 'magazines':
      return 'issue'
    case 'books':
      return 'book'
    default:
      return 'chapter'
  }
}

export const entryUnitOf = (series: Pick<SeriesSummary, 'category' | 'entryUnit'>, entries?: LibraryEntry[]): EntryUnit => {
  if (entries?.length && series.category === 'manga') {
    const volumes = entries.filter((entry) => /^volume\b/i.test(entry.label)).length
    const chapters = entries.filter((entry) => /^chapter\b/i.test(entry.label)).length
    return volumes > chapters ? 'volume' : 'chapter'
  }

  return series.entryUnit ?? defaultEntryUnit(series.category)
}

export const formatUnitCount = (unit: EntryUnit, count: number, t: Strings) => {
  switch (unit) {
    case 'volume':
      return t.units.volumes(count)
    case 'issue':
      return t.units.issues(count)
    case 'episode':
      return t.units.episodes(count)
    case 'book':
      return count === 1 ? t.units.books(1) : t.units.parts(count)
    default:
      return t.units.chapters(count)
  }
}

/** The short line under a cover: the author of a book, or the size of a series. */
export const titleMeta = (series: SeriesSummary, t: Strings) => {
  if (series.category === 'books' && series.stats.fileCount <= 1) {
    return seriesCreator(series) ?? (series.year ? String(series.year) : '')
  }

  return formatUnitCount(entryUnitOf(series), series.stats.fileCount, t)
}

/** "Chapter" / "Volume" as a noun for headings such as the contents list. */
export const unitHeading = (unit: EntryUnit, t: Strings) => {
  switch (unit) {
    case 'volume':
      return t.series.volumesHeading
    case 'issue':
      return t.series.issuesHeading
    case 'episode':
      return t.series.episodesHeading
    case 'book':
      return t.series.contents
    default:
      return t.series.chaptersHeading
  }
}

/* -------------------------------------------------------------- progress -- */

export type ProgressSummary = {
  /** 0–1 across the whole title. */
  ratio: number
  /** Where the reader is, e.g. "Chapter 12 · p. 14 of 40". */
  where: string
  /** What is left, e.g. "83 chapters". */
  remaining: string | null
  finished: boolean
}

const positionRatio = (position: SavedReadingPosition | undefined) => {
  if (!position) {
    return 0
  }

  if (position.locationType === 'percent') {
    return Math.min(1, Math.max(0, position.page / 100))
  }

  const total = position.totalPages ?? 0
  return total > 0 ? Math.min(1, Math.max(0, position.page / total)) : 0
}

const positionText = (position: SavedReadingPosition | undefined, t: Strings) => {
  if (!position) {
    return null
  }

  if (position.locationType === 'percent') {
    const percent = Math.round(position.page)
    return percent > 0 ? t.reader.percent(percent) : t.progress.started
  }

  const total = position.totalPages ?? 0
  return total > 1 ? t.progress.pageOf(position.page, total) : null
}

export const summarizeProgress = (
  bookmark: Bookmark,
  series: Pick<SeriesSummary, 'category' | 'entryUnit' | 'stats'>,
  position: SavedReadingPosition | undefined,
  t: Strings,
): ProgressSummary => {
  const entryTotal = Math.max(1, series.stats.fileCount)
  const entryIndex = Math.min(entryTotal - 1, Math.max(0, bookmark.entryIndex))
  const withinEntry = positionRatio(position)
  const unit = entryUnitOf(series)
  const pageText = positionText(position, t)

  if (entryTotal === 1) {
    return {
      ratio: withinEntry,
      where: pageText ?? t.progress.started,
      remaining: null,
      finished: withinEntry >= 0.995,
    }
  }

  const ratio = Math.min(1, (entryIndex + withinEntry) / entryTotal)
  const remainingEntries = entryTotal - entryIndex - 1
  const label = entryLabel(bookmark.entryLabel, t)

  return {
    ratio,
    where: pageText ? `${label} · ${pageText}` : label,
    remaining: remainingEntries > 0 ? formatUnitCount(unit, remainingEntries, t) : null,
    finished: remainingEntries === 0 && withinEntry >= 0.995,
  }
}

/* ---------------------------------------------------------------- topics -- */

const genericTags = new Set([
  'Local library',
  'Plex scan',
  'Local archive',
  'Reader ready',
  'Local text library',
  'Responsive reader',
  'Local book',
])

export const normalizeToken = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

/** Topics (subjects and genres) that are useful for filtering. */
export const seriesTopics = (series: Pick<SeriesSummary, 'tags' | 'genres' | 'sourceName' | 'description'>) => {
  const creatorName = seriesCreator(series)
  const creator = creatorName ? normalizeToken(creatorName) : ''
  const topics = new Map<string, string>()

  for (const raw of [...series.genres, ...series.tags]) {
    const topic = raw.trim()
    const key = normalizeToken(topic)

    if (!topic || !key || genericTags.has(topic) || (creator && (key === creator || key.includes(creator)))) {
      continue
    }

    const existing = topics.get(key)

    // Keep the nicer spelling when the same topic appears twice ("Mathematics" over "mathematics").
    if (!existing || (existing === existing.toLowerCase() && topic !== topic.toLowerCase())) {
      topics.set(key, topic)
    }
  }

  return [...topics.values()]
}

/* -------------------------------------------------------------- creators -- */

export type CreatorProfile = {
  key: string
  name: string
  role: string | null
  categories: CategoryId[]
  series: SeriesSummary[]
}

let profileSource: SeriesSummary[] | null = null
let profileCache = new Map<string, CreatorProfile>()

export const creatorProfiles = (library: SeriesSummary[]) => {
  if (profileSource === library) {
    return profileCache
  }

  const profiles = new Map<string, CreatorProfile>()

  library.forEach((series) => {
    const name = seriesCreator(series)
    const key = name ? normalizeToken(name) : ''

    if (!name || !key) {
      return
    }

    const profile = profiles.get(key) ?? { key, name, role: series.sourceRole, categories: [], series: [] }

    if (!profile.categories.includes(series.category)) {
      profile.categories.push(series.category)
    }

    profile.role ??= series.sourceRole
    profile.series.push(series)
    profiles.set(key, profile)
  })

  profiles.forEach((profile) => {
    profile.series.sort((left, right) =>
      (left.year ?? 9999) - (right.year ?? 9999) || left.title.localeCompare(right.title),
    )
  })

  profileSource = library
  profileCache = profiles
  return profiles
}

export const creatorKey = (name: string) => normalizeToken(name)

/* ----------------------------------------------------------- hashing -- */

/** A small stable hash for choosing a fallback-cover colour. */
export const hashIndex = (value: string, modulo: number) => {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return Math.abs(hash) % modulo
}
