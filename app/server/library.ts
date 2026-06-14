import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import type { Database } from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import JSZip from 'jszip'
import mime from 'mime-types'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type {
  AppState,
  Bookmark,
  CategoryId,
  CreateCommentPayload,
  CreateRootPayload,
  CreateSourcePayload,
  DirectoryListing,
  EntryVariant,
  EntryFormat,
  LibraryEntry,
  MediaTrackCollection,
  MediaTrackKind,
  MediaTrackOption,
  MetadataQueueItem,
  SavedReadingPosition,
  ScanLogEntry,
  ScanStatus,
  ScanSummary,
  SearchResponse,
  SeriesComment,
  SeriesDetail,
  SeriesSummary,
  SessionUser,
  SourceFolder,
  SourceRoot,
  UpdateSourcePayload,
  UserSummary,
} from '../src/appTypes.ts'
import { categoryOrder } from '../src/appTypes.ts'
import { fileExists } from './database'
import { fetchRemoteMetadata } from './metadata'
import {
  compactWhitespace,
  createId,
  createSecretToken,
  escapeHtml,
  firstNumber,
  hashString,
  inferYear,
  joinInsideRoot,
  naturalCompare,
  nowIso,
  SESSION_TTL_MS,
  slugify,
  stripExtension,
} from './utils'

export type AppConfig = {
  appName: string
  bootstrapAdmin: string
  bootstrapPassword: string
  openSignup: boolean
  enableDemoSeed: boolean
  demoFilesRoot: string
  coversDirectory: string
  managedSourceRoot: ManagedSourceRootConfig | null
}

type ManagedSourceRootConfig = {
  label: string
  storagePath: string
  displayPath: string
}

type SourceRootRow = {
  id: string
  label: string
  path: string
}

type SourceFolderRow = {
  id: string
  root_id: string | null
  category: CategoryId
  relative_path: string
  path: string
  item_count: number
  last_scan_at: string | null
  last_scan_status: string | null
}

const parseCategoryId = (value: unknown): CategoryId => {
  if (typeof value !== 'string' || !categoryOrder.includes(value as CategoryId)) {
    throw new Error('Choose a valid media category.')
  }

  return value as CategoryId
}

const normalizePathAlias = (value: string) => {
  const trimmed = value.trim()

  if (!trimmed) {
    return ''
  }

  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/, '')
  return (normalized || '/').toLowerCase()
}

const joinDisplayPath = (basePath: string, relativePath: string) => {
  if (!relativePath || relativePath === '.') {
    return basePath
  }

  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/'
  const normalizedBase = basePath.replace(/[\\/]+$/, '')
  const normalizedRelative = relativePath.replace(/[\\/]+/g, separator)

  return `${normalizedBase}${separator}${normalizedRelative}`
}

const getManagedSourceRootAliases = (managedSourceRoot: ManagedSourceRootConfig) => {
  const displayBaseName =
    path.win32.basename(managedSourceRoot.displayPath.replace(/\//g, '\\')) ||
    path.posix.basename(managedSourceRoot.displayPath)

  return [
    managedSourceRoot.displayPath,
    managedSourceRoot.storagePath,
    managedSourceRoot.label,
    displayBaseName,
  ]
}

const resolveSourceRootPath = (config: AppConfig, inputPath: string) => {
  const trimmedPath = inputPath.trim()

  if (!trimmedPath) {
    return ''
  }

  const managedSourceRoot = config.managedSourceRoot

  if (managedSourceRoot) {
    const normalizedInput = normalizePathAlias(trimmedPath)
    const matchesManagedRoot = getManagedSourceRootAliases(managedSourceRoot).some(
      (alias) => normalizePathAlias(alias) === normalizedInput,
    )

    if (matchesManagedRoot) {
      return managedSourceRoot.storagePath
    }
  }

  return path.resolve(trimmedPath)
}

const isHostOnlyPath = (inputPath: string) => {
  const trimmedPath = inputPath.trim()

  return /^[\\/]{2}/.test(trimmedPath) || /^[A-Za-z]:[\\/]/.test(trimmedPath)
}

const isManagedSourceRootPath = (config: AppConfig, candidatePath: string) => {
  if (!config.managedSourceRoot) {
    return false
  }

  return path.resolve(candidatePath) === path.resolve(config.managedSourceRoot.storagePath)
}

const toDisplayMountedPath = (config: AppConfig, absolutePath: string) => {
  const managedSourceRoot = config.managedSourceRoot

  if (!managedSourceRoot) {
    return absolutePath
  }

  const resolvedCandidatePath = path.resolve(absolutePath)
  const resolvedManagedPath = path.resolve(managedSourceRoot.storagePath)

  if (resolvedCandidatePath === resolvedManagedPath) {
    return managedSourceRoot.displayPath
  }

  const relativePath = path.relative(resolvedManagedPath, resolvedCandidatePath)

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return absolutePath
  }

  return joinDisplayPath(managedSourceRoot.displayPath, relativePath)
}

const formatSourceRootNote = (sourceCount: number, managed: boolean) => {
  const linkedFoldersLabel = `${sourceCount} linked folder${sourceCount === 1 ? '' : 's'}`
  return managed ? `Available automatically from Docker, ${linkedFoldersLabel}` : linkedFoldersLabel
}

type SeriesRow = {
  id: string
  source_folder_id: string
  category: CategoryId
  title: string
  title_short: string
  year: number | null
  format: string
  status: string
  description: string
  folder_path: string
  cover_source: string
  metadata_source: string
  cover_path: string | null
  cover_mime: string | null
  banner_path: string | null
  banner_mime: string | null
  remote_provider: string | null
  remote_id: string | null
  external_url: string | null
  source_name: string | null
  source_role: string | null
  genres_json: string
  file_count: number
  last_scan_at: string | null
  tags_json: string
  metadata_refreshed_at: string | null
}

type MetadataOverrideRow = {
  series_id: string
  title: string | null
  year: number | null
  description: string | null
  cover_path: string | null
  cover_mime: string | null
  external_url: string | null
  source_name: string | null
  source_role: string | null
  base_title: string | null
  base_year: number | null
  base_description: string | null
  base_cover_path: string | null
  base_cover_mime: string | null
  base_cover_source: string | null
  base_external_url: string | null
  base_source_name: string | null
  base_source_role: string | null
  base_metadata_source: string | null
  updated_at: string
}

type EntryRow = {
  series_id: string
  id: string
  file_path?: string
  relative_path: string
  label: string
  title: string
  storage_file: string
  format: EntryFormat
  details: string
  size: number
  mtime_ms: number
  sort_order: number
  chapter_number: number | null
  season_number: number | null
  episode_number: number | null
}

type UserRow = {
  id: string
  username: string
  role: 'admin' | 'member'
  password_hash: string
}

type FileRecord = {
  path: string
  relativePath: string
  baseName: string
  extension: string
  size: number
  mtimeMs: number
}

type ScanDirectoryWarning = {
  path: string
  message: string
}

type ScanDirectoryResult = {
  files: FileRecord[]
  warnings: ScanDirectoryWarning[]
}

type ParsedEntry = {
  file: FileRecord
  groupKey: string
  groupFolder: string
  seriesTitle: string
  titleShort: string
  year: number | null
  seriesFormat: string
  status: string
  description: string
  tags: string[]
  entryLabel: string
  entryTitle: string
  format: EntryFormat
  details: string
  chapterNumber: number | null
  seasonNumber: number | null
  episodeNumber: number | null
  entryKind: 'episode' | 'chapter' | 'volume' | 'prologue' | 'supplemental' | 'entry'
  sequenceNumber: number | null
  hasStructuredOrder: boolean
  sortOrder: number
}

type ResolvedMediaTrack = MediaTrackOption & {
  filePath: string
}

type SeriesSpec = {
  key: string
  title: string
  titleShort: string
  category: CategoryId
  year: number | null
  format: string
  status: string
  description: string
  folderPath: string
  tags: string[]
  entries: ParsedEntry[]
}

type ScanResult = {
  scanRunId: string
  changedFiles: number
  scannedSourceIds: string[]
}

type ScanEventLevel = ScanLogEntry['level']

type ScanReporter = {
  onRunStarted?: (payload: {
    runId: string
    startedAt: string
    totalSources: number
  }) => void
  onProgress?: (payload: {
    runId: string
    totalSources: number
    completedSources: number
    currentSource: string | null
    currentSourceFilesDiscovered: number | null
    currentSourceSeriesTotal: number | null
    currentSourceSeriesCompleted: number
    currentSeries: string | null
    summary: string | null
  }) => void
  onEvent?: (event: ScanLogEntry) => void
  onRunFinished?: (payload: {
    runId: string
    finishedAt: string
    summary: string
    success: boolean
  }) => void
}

type SeriesPresentation = {
  year: number | null
  description: string
  coverPath: string | null
  coverMime: string | null
  bannerPath: string | null
  bannerMime: string | null
  coverSource: string
  metadataSource: string
  remoteProvider: string | null
  remoteId: string | null
  externalUrl: string | null
  sourceName: string | null
  sourceRole: string | null
  genres: string[]
  tags: string[]
  metadataRefreshedAt: string | null
}

const animeExtensions = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov'])
const mangaExtensions = new Set(['.cbz', '.pdf', '.epub'])
const novelExtensions = new Set(['.html', '.htm', '.md', '.pdf', '.epub', '.txt'])
const bookExtensions = new Set(['.pdf', '.epub', '.mobi', '.azw3', '.txt', '.md', '.html', '.htm'])
const magazineExtensions = new Set(['.pdf', '.epub', '.cbz', '.txt', '.md', '.html', '.htm'])
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const subtitleTrackExtensions = new Set(['.vtt', '.srt', '.ass', '.ssa'])
const audioTrackExtensions = new Set(['.aac', '.m4a', '.mp3', '.wav', '.ogg', '.opus', '.flac'])
const localCoverNames = [
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
  'cover.webp',
  'poster.jpg',
  'poster.jpeg',
  'poster.png',
  'poster.webp',
  'folder.jpg',
  'folder.png',
  'folder.webp',
] as const

const emptyMediaTracks = (): MediaTrackCollection => ({
  audio: [],
  subtitles: [],
})

const trackLanguageAliases: Record<string, string> = {
  en: 'English',
  eng: 'English',
  english: 'English',
  de: 'German',
  ger: 'German',
  deu: 'German',
  german: 'German',
  jp: 'Japanese',
  jpn: 'Japanese',
  ja: 'Japanese',
  japanese: 'Japanese',
  es: 'Spanish',
  spa: 'Spanish',
  spanish: 'Spanish',
  fr: 'French',
  fre: 'French',
  fra: 'French',
  french: 'French',
  it: 'Italian',
  ita: 'Italian',
  italian: 'Italian',
  pt: 'Portuguese',
  por: 'Portuguese',
  portuguese: 'Portuguese',
  commentary: 'Commentary',
  commentaries: 'Commentary',
  forced: 'Forced',
  signs: 'Signs',
  songs: 'Songs',
  dub: 'Dub',
  sub: 'Subtitles',
}

const entryVariantPriority: Record<CategoryId, Partial<Record<EntryFormat, number>>> = {
  anime: {
    video: 0,
  },
  manga: {
    cbz: 0,
    pdf: 1,
    epub: 2,
    html: 3,
    md: 4,
    txt: 5,
    video: 6,
  },
  novels: {
    html: 0,
    md: 1,
    epub: 2,
    pdf: 3,
    txt: 4,
    video: 5,
    cbz: 6,
  },
  books: {
    epub: 0,
    html: 1,
    md: 2,
    pdf: 3,
    txt: 4,
    video: 5,
    cbz: 6,
  },
  magazines: {
    pdf: 0,
    cbz: 1,
    epub: 2,
    html: 3,
    md: 4,
    txt: 5,
    video: 6,
  },
}

const supportedExtensionsByCategory: Record<CategoryId, Set<string>> = {
  anime: animeExtensions,
  manga: mangaExtensions,
  novels: novelExtensions,
  books: bookExtensions,
  magazines: magazineExtensions,
}

const categoryStatus: Record<CategoryId, string> = {
  anime: 'Ready to stream',
  manga: 'Ready to read',
  novels: 'Ready to read',
  books: 'Ready to read',
  magazines: 'Ready to read',
}

const categoryFormat: Record<CategoryId, string> = {
  anime: 'TV Series',
  manga: 'Manga',
  novels: 'Web Novel',
  books: 'Book',
  magazines: 'Magazine',
}

const upperExtension = (value: string) => value.replace('.', '').toUpperCase()

const cleanSeriesTitle = (value: string) => {
  let nextValue = compactWhitespace(value.replaceAll('_', ' '))

  while (/\s+\([^)]*\)\s*$/.test(nextValue)) {
    nextValue = nextValue.replace(/\s+\([^)]*\)\s*$/, '').trim()
  }

  return nextValue || compactWhitespace(value.replaceAll('_', ' '))
}

const deriveSeriesTitleFromFolderPath = (folderPath: string, fallbackTitle: string) => {
  const folderName = cleanSeriesTitle(path.basename(folderPath))
  return folderName || fallbackTitle
}

const stripAdminOverrideSuffix = (value: string) =>
  compactWhitespace(String(value || '').replace(/\s*•\s*admin override$/i, ''))

const withAdminOverrideSuffix = (value: string) => {
  const baseValue = stripAdminOverrideSuffix(value)
  return baseValue ? `${baseValue} • admin override` : 'Admin override'
}

const cleanEntryStemTitle = (value: string, prefix?: string) => {
  let nextValue = compactWhitespace(value.replaceAll('_', ' '))

  if (prefix && nextValue.toLowerCase().startsWith(prefix.toLowerCase())) {
    const trimmedPrefix = nextValue.slice(prefix.length).replace(/^[-:\s]+/, '').trim()
    if (trimmedPrefix) {
      nextValue = trimmedPrefix
    }
  }

  return nextValue
}

const stripLeadingEntryOrdinal = (value: string) => {
  const nextValue = compactWhitespace(value.replaceAll('_', ' ')).replace(
    /^(?:chapter|ch|volume|vol(?:ume)?|episode|ep|book)\s*\d+(?:\.\d+)?(?:\s*[:._-]\s*|\s+)+/i,
    '',
  ).trim()

  return nextValue || compactWhitespace(value.replaceAll('_', ' '))
}

const stripLeadingNamedEntryPrefix = (value: string) =>
  compactWhitespace(value.replaceAll('_', ' '))
    .replace(
      /^(?:prologue|epilogue|after(?:\s+story)?|afterstory|side(?:\s+story|stories)?|sidestory|interlude|extra|extras|bonus|special(?:s| chapter)?|omake|appendix)\s*\d*(?:\.\d+)?(?:\s*[:._-]\s*|\s+)+/i,
      '',
    )
    .trim()

const formatSequenceNumber = (value: number) =>
  Number.isInteger(value) ? padNumber(value) : String(value)

const seasonFolderMatchers = [
  /^(?:season|series|staffel)\s*0*(\d{1,2})$/i,
  /^s(?:eason)?\s*0*(\d{1,2})$/i,
]

const categorySourceAliases: Record<CategoryId, string[]> = {
  anime: ['anime', 'animes', 'shows', 'series'],
  manga: ['manga'],
  novels: ['novels', 'novel', 'webnovel', 'webnovels', 'lightnovel', 'lightnovels'],
  books: ['books', 'book', 'ebooks', 'ebook'],
  magazines: ['magazines', 'magazine', 'periodicals', 'periodical', 'zines', 'zine'],
}

const categoryCollectionWrapperMatchers: Partial<Record<CategoryId, RegExp[]>> = {
  anime: [
    /^(?:\d+\s*[.)-]?\s*)?cb$/i,
    /^(?:\d+\s*[.)-]?\s*)?fix(?:\s+|-)?naming$/i,
    /^(?:\d+\s*[.)-]?\s*)?(?:backup|backups|temp|temporary|incoming|unsorted|sorting|staging|rename|renaming)$/i,
  ],
}

const detectSeasonNumberFromSegment = (value: string) => {
  const normalizedValue = compactWhitespace(stripExtension(value).replaceAll('_', ' '))

  if (/^(?:specials?|ova|ovas|extra|extras)$/i.test(normalizedValue)) {
    return 0
  }

  for (const matcher of seasonFolderMatchers) {
    const match = normalizedValue.match(matcher)

    if (match) {
      return Number(match[1])
    }
  }

  return null
}

const isCategoryContainerSource = (sourceFolder: SourceFolderRow) => {
  const comparableSegment =
    sourceFolder.relative_path.split('/').filter(Boolean).pop() || path.basename(sourceFolder.path)
  const normalizedSegment = cleanSeriesTitle(comparableSegment).toLowerCase()

  return categorySourceAliases[sourceFolder.category].includes(normalizedSegment)
}

const isCollectionWrapperSegment = (category: CategoryId, value: string) => {
  const comparableSegment = compactWhitespace(value.replaceAll(/[._]+/g, ' '))
  const matchers = categoryCollectionWrapperMatchers[category] ?? []

  return matchers.some((matcher) => matcher.test(comparableSegment))
}

const isOrganizationalWrapperSource = (sourceFolder: SourceFolderRow) => {
  const comparableSegment =
    sourceFolder.relative_path.split('/').filter(Boolean).pop() || path.basename(sourceFolder.path)

  return isCollectionWrapperSegment(sourceFolder.category, comparableSegment)
}

const stripLeadingCollectionWrapperSegments = (category: CategoryId, segments: string[]) => {
  const remainingSegments = [...segments]
  const wrapperSegments: string[] = []

  while (remainingSegments.length > 1 && isCollectionWrapperSegment(category, remainingSegments[0])) {
    wrapperSegments.push(remainingSegments.shift() as string)
  }

  return {
    wrapperSegments,
    remainingSegments,
  }
}

const resolveSeriesContext = (sourceFolder: SourceFolderRow, file: FileRecord) => {
  const segments = file.relativePath.split(path.sep).filter(Boolean)
  const { wrapperSegments, remainingSegments } = stripLeadingCollectionWrapperSegments(
    sourceFolder.category,
    segments,
  )
  const useSourceFolderAsSeriesRoot =
    !isCategoryContainerSource(sourceFolder) && !isOrganizationalWrapperSource(sourceFolder)
  const rawSeriesName = useSourceFolderAsSeriesRoot
    ? path.basename(sourceFolder.path)
    : remainingSegments[0] || stripExtension(file.baseName)
  const seriesTitle = cleanSeriesTitle(rawSeriesName)
  const nestedSegments = useSourceFolderAsSeriesRoot ? remainingSegments : remainingSegments.slice(1)
  const groupFolder = useSourceFolderAsSeriesRoot
    ? sourceFolder.path
    : remainingSegments[0]
      ? path.join(sourceFolder.path, ...wrapperSegments, remainingSegments[0])
      : path.dirname(file.path)

  return {
    rawSeriesName,
    seriesTitle,
    nestedSegments,
    groupFolder,
    usesSourceFolderAsSeriesRoot: useSourceFolderAsSeriesRoot,
  }
}

const detectSupplementalLabel = (value: string) => {
  const normalizedValue = compactWhitespace(value.replaceAll('_', ' ')).toLowerCase()

  if (/^prologue\b/.test(normalizedValue) || /\bprologue\b/.test(normalizedValue)) {
    return 'Prologue'
  }

  if (/\b(?:epilogue|after story|afterstory)\b/.test(normalizedValue)) {
    return 'Epilogue'
  }

  if (/\b(?:side story|side stories|sidestory)\b/.test(normalizedValue)) {
    return 'Side story'
  }

  if (/\binterlude\b/.test(normalizedValue)) {
    return 'Interlude'
  }

  if (/\b(?:special|specials|special chapter)\b/.test(normalizedValue)) {
    return 'Special'
  }

  if (/\b(?:extra|extras|bonus|omake|appendix)\b/.test(normalizedValue)) {
    return 'Extra'
  }

  return null
}

const detectAnimeSupplemental = (nestedSegments: string[], strippedName: string) => {
  const combinedValue = compactWhitespace(`${nestedSegments.join(' ')} ${strippedName}`)
  const mappings = [
    { matcher: /\bNCOP\s*0*(\d{1,3})\b/i, label: 'NCOP' },
    { matcher: /\bNCED\s*0*(\d{1,3})\b/i, label: 'NCED' },
    { matcher: /\bOP(?:ENING)?\s*0*(\d{1,3})\b/i, label: 'Opening' },
    { matcher: /\bED(?:ENDING)?\s*0*(\d{1,3})\b/i, label: 'Ending' },
    { matcher: /\bOVA\s*0*(\d{1,3})\b/i, label: 'OVA' },
    { matcher: /\bOAD\s*0*(\d{1,3})\b/i, label: 'OAD' },
    { matcher: /\bSPECIAL\s*0*(\d{1,3})\b/i, label: 'Special' },
    { matcher: /\bPV\s*0*(\d{1,3})\b/i, label: 'PV' },
    { matcher: /\bTRAILER\s*0*(\d{1,3})\b/i, label: 'Trailer' },
  ] as const

  for (const mapping of mappings) {
    const match = combinedValue.match(mapping.matcher)

    if (!match) {
      continue
    }

    const sequenceNumber = match[1] ? Number(match[1]) : 1

    return {
      label: `${mapping.label} ${padNumber(sequenceNumber)}`.trim(),
      sequenceNumber,
    }
  }

  if (/\bopenings?\b|\bendings?\b/i.test(combinedValue)) {
    return {
      label: 'Extra',
      sequenceNumber: 1,
    }
  }

  return null
}

const buildNarrativeSortOrder = (
  entryKind: ParsedEntry['entryKind'],
  sequenceNumber: number | null,
) => {
  if (entryKind === 'prologue') {
    return sequenceNumber != null ? sequenceNumber / 1000 : 0
  }

  if (entryKind === 'supplemental') {
    if (sequenceNumber != null && !Number.isInteger(sequenceNumber)) {
      return 100000 + sequenceNumber
    }

    return 200000 + (sequenceNumber ?? 0)
  }

  return 100000 + (sequenceNumber ?? 0)
}

const splitTrackSuffixTokens = (value: string) =>
  value
    .replace(/\[[^\]]+\]/g, ' ')
    .split(/[\s._-]+/)
    .map((token) => token.trim())
    .filter(Boolean)

const humanizeTrackLabel = (rawSuffix: string, fallbackLabel: string) => {
  if (!rawSuffix) {
    return fallbackLabel
  }

  const mappedTokens = splitTrackSuffixTokens(rawSuffix).map((token) => {
    const normalizedToken = token.toLowerCase()
    return trackLanguageAliases[normalizedToken] || token.toUpperCase()
  })

  return compactWhitespace(mappedTokens.join(' ')) || fallbackLabel
}

const buildTrackId = (kind: MediaTrackKind, trackFileName: string) =>
  `${kind}-${hashString(trackFileName.toLowerCase())}`

const isMatchingSidecarTrack = (videoBaseName: string, candidateBaseName: string) => {
  if (candidateBaseName === videoBaseName) {
    return true
  }

  const normalizedVideoBase = videoBaseName.toLowerCase()
  const normalizedCandidate = candidateBaseName.toLowerCase()

  return (
    normalizedCandidate.startsWith(`${normalizedVideoBase}.`) ||
    normalizedCandidate.startsWith(`${normalizedVideoBase} `) ||
    normalizedCandidate.startsWith(`${normalizedVideoBase}-`) ||
    normalizedCandidate.startsWith(`${normalizedVideoBase}_`)
  )
}

const buildResolvedMediaTracks = (entryId: string, filePath?: string | null): ResolvedMediaTrack[] => {
  if (!filePath || !fileExists(filePath)) {
    return []
  }

  const videoDirectory = path.dirname(filePath)
  const videoBaseName = stripExtension(path.basename(filePath))

  if (!fileExists(videoDirectory)) {
    return []
  }

  return fs
    .readdirSync(videoDirectory, { withFileTypes: true })
    .filter((directoryEntry) => directoryEntry.isFile())
    .map((directoryEntry) => {
      const extension = path.extname(directoryEntry.name).toLowerCase()
      const kind: MediaTrackKind | null = subtitleTrackExtensions.has(extension)
        ? 'subtitle'
        : audioTrackExtensions.has(extension)
          ? 'audio'
          : null

      if (!kind) {
        return null
      }

      const candidateBaseName = stripExtension(directoryEntry.name)
      if (!isMatchingSidecarTrack(videoBaseName, candidateBaseName)) {
        return null
      }

      const rawSuffix = candidateBaseName
        .slice(videoBaseName.length)
        .replace(/^[-._\s]+/, '')
        .trim()
      const fallbackLabel = kind === 'audio' ? 'Alternate audio' : 'Subtitle file'
      const label = humanizeTrackLabel(rawSuffix, fallbackLabel)
      const fileName = directoryEntry.name
      const note =
        kind === 'audio'
          ? 'External sidecar audio'
          : extension === '.vtt'
            ? 'WebVTT subtitle'
            : extension === '.srt'
              ? 'SRT subtitle converted for the browser player'
              : 'ASS subtitle converted for the browser player'

      return {
        id: buildTrackId(kind, fileName),
        kind,
        label,
        fileName,
        format: upperExtension(extension),
        url: `/api/media/track/${entryId}/${kind}/${buildTrackId(kind, fileName)}`,
        supported: true,
        note,
        filePath: path.join(videoDirectory, fileName),
      } satisfies ResolvedMediaTrack
    })
    .filter((track): track is ResolvedMediaTrack => Boolean(track))
    .sort((left, right) => naturalCompare(left.fileName, right.fileName))
}

const toMediaTrackOption = (track: ResolvedMediaTrack): MediaTrackOption => ({
  id: track.id,
  kind: track.kind,
  label: track.label,
  fileName: track.fileName,
  format: track.format,
  url: track.url,
  supported: track.supported,
  note: track.note,
})

const getMediaTracksForEntry = (
  entryId: string,
  format: EntryFormat,
  filePath?: string | null,
): MediaTrackCollection => {
  if (format !== 'video') {
    return emptyMediaTracks()
  }

  const tracks = buildResolvedMediaTracks(entryId, filePath)

  return {
    audio: tracks.filter((track) => track.kind === 'audio').map(toMediaTrackOption),
    subtitles: tracks.filter((track) => track.kind === 'subtitle').map(toMediaTrackOption),
  }
}

const resolveMediaTrackForEntry = (
  db: Database,
  entryId: string,
  kind: MediaTrackKind,
  trackId: string,
) => {
  const entry = db
    .prepare(`SELECT id, file_path, format FROM entries WHERE id = ? LIMIT 1`)
    .get(entryId) as { id: string; file_path: string; format: EntryFormat } | undefined

  if (!entry) {
    throw new Error('Requested media file was not found.')
  }

  const tracks = buildResolvedMediaTracks(entry.id, entry.file_path)
  const matchingTrack = tracks.find((track) => track.kind === kind && track.id === trackId)

  if (!matchingTrack || !fileExists(matchingTrack.filePath)) {
    throw new Error('Requested media track was not found.')
  }

  return matchingTrack
}

const padNumber = (value: number) => String(value).padStart(2, '0')

const formatFileSystemError = (error: unknown) =>
  error instanceof Error ? error.message : 'Unknown filesystem error'

const scanDirectory = (rootPath: string, allowedExtensions: Set<string>): ScanDirectoryResult => {
  const files: FileRecord[] = []
  const warnings: ScanDirectoryWarning[] = []

  const visit = (absolutePath: string, relativeDirectory: string) => {
    let directoryEntries: fs.Dirent[]

    try {
      directoryEntries = fs.readdirSync(absolutePath, { withFileTypes: true })
    } catch (error) {
      warnings.push({
        path: absolutePath,
        message: `Skipped directory: ${formatFileSystemError(error)}`,
      })
      return
    }

    directoryEntries.sort((left, right) => naturalCompare(left.name, right.name))

    for (const directoryEntry of directoryEntries) {
      if (directoryEntry.name.startsWith('.')) {
        continue
      }

      const entryAbsolutePath = path.join(absolutePath, directoryEntry.name)
      const entryRelativePath = relativeDirectory
        ? path.join(relativeDirectory, directoryEntry.name)
        : directoryEntry.name

      if (directoryEntry.isDirectory()) {
        visit(entryAbsolutePath, entryRelativePath)
        continue
      }

      const extension = path.extname(directoryEntry.name).toLowerCase()

      if (!allowedExtensions.has(extension)) {
        continue
      }

      let stats: fs.Stats

      try {
        stats = fs.statSync(entryAbsolutePath)
      } catch (error) {
        warnings.push({
          path: entryAbsolutePath,
          message: `Skipped file: ${formatFileSystemError(error)}`,
        })
        continue
      }

      files.push({
        path: entryAbsolutePath,
        relativePath: entryRelativePath,
        baseName: directoryEntry.name,
        extension,
        size: stats.size,
        mtimeMs: Math.floor(stats.mtimeMs),
      })
    }
  }

  if (fs.existsSync(rootPath)) {
    visit(rootPath, '')
  }

  return { files, warnings }
}

const parseAnimeEntry = (file: FileRecord, sourceFolder: SourceFolderRow): ParsedEntry => {
  const strippedName = stripExtension(file.baseName)
  const {
    rawSeriesName,
    seriesTitle: seriesTitleFromContext,
    nestedSegments,
    groupFolder,
    usesSourceFolderAsSeriesRoot,
  } = resolveSeriesContext(sourceFolder, file)
  const plexMatch = strippedName.match(
    /^(?<show>.+?) \((?<year>\d{4})\) - S(?<season>\d{1,2})E(?<episode>\d{1,3})(?: - (?<title>.+))?$/i,
  )
  const namedEpisodeMatch = strippedName.match(
    /^(?<show>.+?)(?:\s*-\s*)?(?:ep|episode)\s*(?<episode>\d{1,3})(?:\s*-\s*(?<title>.+))?$/i,
  )
  const folderSeasonNumber =
    nestedSegments
      .map((segment) => detectSeasonNumberFromSegment(segment))
      .find((seasonNumber) => seasonNumber != null) ?? null

  const seriesTitle = compactWhitespace(
    plexMatch?.groups?.show?.trim() ||
      namedEpisodeMatch?.groups?.show?.trim() ||
      seriesTitleFromContext,
  )
  const year = plexMatch?.groups?.year
    ? Number(plexMatch.groups.year)
    : inferYear(rawSeriesName) ?? inferYear(strippedName)
  const seasonNumber = plexMatch?.groups?.season
    ? Number(plexMatch.groups.season)
    : folderSeasonNumber
  const episodeNumber = plexMatch?.groups?.episode
    ? Number(plexMatch.groups.episode)
    : namedEpisodeMatch?.groups?.episode
      ? Number(namedEpisodeMatch.groups.episode)
      : null
  const cleanedFallbackTitle = compactWhitespace(
    strippedName.replace(/^\d{4}[-._ ]\d{2}[-._ ]\d{2}\s*-\s*/, ''),
  )
  const animeSupplemental = detectAnimeSupplemental(nestedSegments, cleanedFallbackTitle)
  const episodeTitle = compactWhitespace(
    plexMatch?.groups?.title?.trim() ||
      namedEpisodeMatch?.groups?.title?.trim() ||
      cleanEntryStemTitle(cleanedFallbackTitle, seriesTitle) ||
      cleanedFallbackTitle ||
      'Video file',
  )
  const groupKey = usesSourceFolderAsSeriesRoot
    ? `anime:${hashString(`${sourceFolder.id}:${normalizeGroupKeyPart(seriesTitle)}:${year ?? 'na'}`)}`
    : `anime:${hashString(`${sourceFolder.id}:${groupFolder.toLowerCase()}`)}`

  const isStructuredEpisode = episodeNumber != null

  return {
    file,
    groupKey,
    groupFolder,
    seriesTitle,
    titleShort: seriesTitle,
    year,
    seriesFormat: categoryFormat.anime,
    status: categoryStatus.anime,
    description:
      'Detected from folder structure and Plex-style episode filenames so your local naming remains the source of truth.',
    tags: ['Local library', 'Plex scan'],
    entryLabel: isStructuredEpisode
      ? `Episode ${padNumber(episodeNumber)}`
      : animeSupplemental?.label || 'Episode',
    entryTitle: animeSupplemental?.label === episodeTitle ? animeSupplemental.label : episodeTitle,
    format: 'video',
    details: isStructuredEpisode
      ? `${upperExtension(file.extension)} • S${padNumber(seasonNumber || 1)}E${padNumber(episodeNumber)}`
      : animeSupplemental
        ? `${upperExtension(file.extension)} • local extra video`
      : `${upperExtension(file.extension)} • local video file`,
    chapterNumber: null,
    seasonNumber,
    episodeNumber: isStructuredEpisode ? episodeNumber : null,
    entryKind: isStructuredEpisode ? 'episode' : animeSupplemental ? 'supplemental' : 'entry',
    sequenceNumber: isStructuredEpisode ? episodeNumber : animeSupplemental?.sequenceNumber ?? null,
    hasStructuredOrder: isStructuredEpisode || Boolean(animeSupplemental),
    sortOrder: isStructuredEpisode
      ? (seasonNumber || 1) * 1000 + episodeNumber
      : animeSupplemental
        ? 900000 + animeSupplemental.sequenceNumber
        : 0,
  }
}

const parseMangaEntry = (file: FileRecord, sourceFolder: SourceFolderRow): ParsedEntry => {
  const { rawSeriesName, seriesTitle, nestedSegments, groupFolder } = resolveSeriesContext(
    sourceFolder,
    file,
  )
  const strippedName = stripExtension(file.baseName)
  const volumeMatch = strippedName.match(/\b(?:v|vol(?:ume)?)\s*(\d{1,4})\b/i)
  const chapterMatch = strippedName.match(/\b(?:ch|chapter)\s*(\d{1,4}(?:\.\d+)?)(?=\b|[_\s:.-]|$)/i)
  const sequenceNumber = volumeMatch
    ? Number(volumeMatch[1])
    : chapterMatch
      ? Number(chapterMatch[1])
      : firstNumber(strippedName)
  const supplementalLabel = detectSupplementalLabel(`${nestedSegments.join(' ')} ${strippedName}`)
  const isPrologue = supplementalLabel === 'Prologue'
  const treatAsMainChapter =
    Boolean(chapterMatch) ||
    (!volumeMatch && !supplementalLabel && sequenceNumber != null)
  const entryKind: ParsedEntry['entryKind'] = volumeMatch
    ? 'volume'
    : isPrologue
      ? 'prologue'
      : supplementalLabel
        ? 'supplemental'
        : treatAsMainChapter
          ? 'chapter'
          : 'entry'
  const entryLabel = volumeMatch
    ? `Volume ${formatSequenceNumber(sequenceNumber ?? 1)}`
    : entryKind === 'chapter'
      ? `Chapter ${formatSequenceNumber(sequenceNumber ?? 1)}`
      : entryKind === 'prologue'
        ? 'Prologue'
        : supplementalLabel
          ? `${supplementalLabel}${sequenceNumber != null ? ` ${formatSequenceNumber(sequenceNumber)}` : ''}`
          : sequenceNumber != null
            ? `Entry ${formatSequenceNumber(sequenceNumber)}`
            : 'Entry'
  const cleanedNarrativeTitle = stripLeadingNamedEntryPrefix(cleanEntryStemTitle(strippedName, seriesTitle))
  const entryTitle =
    entryKind === 'volume'
      ? entryLabel
      : entryKind === 'chapter'
        ? stripLeadingEntryOrdinal(
            cleanEntryStemTitle(strippedName, `${seriesTitle} - Chapter ${sequenceNumber ?? 1}`),
          ) || entryLabel
        : cleanedNarrativeTitle || entryLabel

  return {
    file,
    groupKey: `manga:${hashString(`${sourceFolder.id}:${groupFolder}`)}`,
    groupFolder,
    seriesTitle,
    titleShort: seriesTitle,
    year: inferYear(rawSeriesName) ?? inferYear(strippedName),
    seriesFormat: categoryFormat.manga,
    status: categoryStatus.manga,
    description:
      'Folder-based manga indexing with archive-first reading, spread mode, and manual bookmarking for individual volumes or chapters.',
    tags: ['Local archive', 'Reader ready'],
    entryLabel,
    entryTitle,
    format: file.extension === '.pdf' ? 'pdf' : file.extension === '.epub' ? 'epub' : 'cbz',
    details: `${upperExtension(file.extension)} • local manga archive`,
    chapterNumber: entryKind === 'chapter' ? sequenceNumber ?? null : null,
    seasonNumber: null,
    episodeNumber: null,
    entryKind,
    sequenceNumber,
    hasStructuredOrder: true,
    sortOrder: buildNarrativeSortOrder(entryKind, sequenceNumber),
  }
}

const parseNovelEntry = (file: FileRecord, sourceFolder: SourceFolderRow): ParsedEntry => {
  const { rawSeriesName, seriesTitle, nestedSegments, groupFolder } = resolveSeriesContext(
    sourceFolder,
    file,
  )
  const strippedName = stripExtension(file.baseName)
  const chapterMatch = strippedName.match(
    /\bchapter\s*(\d{1,4}(?:\.\d+)?)(?:\b|[_\s:.-])+(.+)$/i,
  )
  const chapterNumber = chapterMatch ? Number(chapterMatch[1]) : firstNumber(strippedName)
  const supplementalLabel = detectSupplementalLabel(`${nestedSegments.join(' ')} ${strippedName}`)
  const isPrologue = supplementalLabel === 'Prologue'
  const entryKind: ParsedEntry['entryKind'] =
    isPrologue
      ? 'prologue'
      : supplementalLabel
        ? 'supplemental'
        : chapterMatch || chapterNumber != null
          ? 'chapter'
          : 'entry'
  const entryLabel =
    entryKind === 'chapter'
      ? `Chapter ${formatSequenceNumber(chapterNumber ?? 1)}`
      : entryKind === 'prologue'
        ? 'Prologue'
        : supplementalLabel
          ? `${supplementalLabel}${chapterNumber != null ? ` ${formatSequenceNumber(chapterNumber)}` : ''}`
          : chapterNumber != null
            ? `Entry ${formatSequenceNumber(chapterNumber)}`
            : 'Entry'
  const chapterTitle = compactWhitespace(
    entryKind === 'chapter'
      ? stripLeadingEntryOrdinal(chapterMatch?.[2] || cleanEntryStemTitle(strippedName, seriesTitle))
      : stripLeadingNamedEntryPrefix(cleanEntryStemTitle(strippedName, seriesTitle)),
  )
  const format =
    file.extension === '.html' || file.extension === '.htm'
      ? 'html'
      : file.extension === '.md'
        ? 'md'
        : file.extension === '.pdf'
          ? 'pdf'
          : file.extension === '.epub'
            ? 'epub'
            : 'txt'

  return {
    file,
    groupKey: `novel:${hashString(`${sourceFolder.id}:${groupFolder}`)}`,
    groupFolder,
    seriesTitle,
    titleShort: seriesTitle,
    year: inferYear(rawSeriesName) ?? inferYear(strippedName),
    seriesFormat: categoryFormat.novels,
    status: categoryStatus.novels,
    description:
      'Novel chapters mirror the folder structure, keeping local HTML, markdown, PDF, or EPUB files readable across desktop, tablet, and phone.',
    tags: ['Local text library', 'Responsive reader'],
    entryLabel,
    entryTitle: chapterTitle || entryLabel,
    format,
    details: `${upperExtension(file.extension)} • local chapter file`,
    chapterNumber: entryKind === 'chapter' ? chapterNumber ?? null : null,
    seasonNumber: null,
    episodeNumber: null,
    entryKind,
    sequenceNumber: chapterNumber,
    hasStructuredOrder: true,
    sortOrder: buildNarrativeSortOrder(entryKind, chapterNumber),
  }
}

const parseBookEntry = (file: FileRecord, sourceFolder: SourceFolderRow): ParsedEntry => {
  const strippedName = stripExtension(file.baseName)
  const separatorIndex = strippedName.indexOf(' - ')
  const author = separatorIndex >= 0 ? strippedName.slice(0, separatorIndex).trim() : ''
  const titlePart = separatorIndex >= 0 ? strippedName.slice(separatorIndex + 3).trim() : strippedName
  const title = compactWhitespace(titlePart.replace(/\s+\(\d{4}\)\s*$/, ''))
  const year = inferYear(strippedName)
  const format =
    file.extension === '.pdf'
      ? 'pdf'
      : file.extension === '.epub'
        ? 'epub'
        : file.extension === '.md'
          ? 'md'
          : file.extension === '.html' || file.extension === '.htm'
            ? 'html'
            : 'txt'

  return {
    file,
    groupKey: `book:${hashString(`${sourceFolder.id}:${file.relativePath}`)}`,
    groupFolder: path.dirname(file.path),
    seriesTitle: title,
    titleShort: title,
    year,
    seriesFormat: categoryFormat.books,
    status: categoryStatus.books,
    description: author
      ? `Local book file by ${author}.`
      : 'Single-file local book entry ready for the built-in reader.',
    tags: author ? ['Local book', author] : ['Local book'],
    entryLabel: 'Book',
    entryTitle: title,
    format,
    details: author ? `${upperExtension(file.extension)} • ${author}` : `${upperExtension(file.extension)} • local book file`,
    chapterNumber: null,
    seasonNumber: null,
    episodeNumber: null,
    entryKind: 'entry',
    sequenceNumber: 1,
    hasStructuredOrder: true,
    sortOrder: 1,
  }
}

const parseMagazineEntry = (file: FileRecord, sourceFolder: SourceFolderRow): ParsedEntry => {
  const { rawSeriesName, seriesTitle, groupFolder } = resolveSeriesContext(sourceFolder, file)
  const strippedName = stripExtension(file.baseName)
  const issueMatch = strippedName.match(/\b(?:issue|no\.?|number|#)\s*0*(\d{1,5})\b/i)
  const dateMatch = strippedName.match(/\b((?:19|20)\d{2})[ ._-]?(0[1-9]|1[0-2])?(?:[ ._-]?([0-3]\d))?\b/)
  const issueNumber = issueMatch ? Number(issueMatch[1]) : null
  const year = inferYear(rawSeriesName) ?? inferYear(strippedName)
  const issueDateLabel = dateMatch
    ? [dateMatch[1], dateMatch[2], dateMatch[3]].filter(Boolean).join('-')
    : null
  const issueLabel = issueNumber
    ? `Issue ${formatSequenceNumber(issueNumber)}`
    : issueDateLabel
      ? `Issue ${issueDateLabel}`
      : 'Issue'
  const issueTitle = stripLeadingEntryOrdinal(cleanEntryStemTitle(strippedName, seriesTitle))
  const sortOrder = issueNumber ?? (dateMatch ? Number(`${dateMatch[1]}${dateMatch[2] || '00'}${dateMatch[3] || '00'}`) : 1)
  const format =
    file.extension === '.cbz'
      ? 'cbz'
      : file.extension === '.pdf'
        ? 'pdf'
        : file.extension === '.epub'
          ? 'epub'
          : file.extension === '.md'
            ? 'md'
            : file.extension === '.html' || file.extension === '.htm'
              ? 'html'
              : 'txt'

  return {
    file,
    groupKey: `magazine:${hashString(`${sourceFolder.id}:${groupFolder}`)}`,
    groupFolder,
    seriesTitle,
    titleShort: seriesTitle,
    year,
    seriesFormat: categoryFormat.magazines,
    status: categoryStatus.magazines,
    description:
      'Magazine issues are grouped separately from books so periodicals stay easy to browse and resume.',
    tags: ['Local magazine', 'Reader ready'],
    entryLabel: issueLabel,
    entryTitle: issueTitle || issueLabel,
    format,
    details: `${upperExtension(file.extension)} • local magazine issue`,
    chapterNumber: issueNumber,
    seasonNumber: null,
    episodeNumber: null,
    entryKind: 'entry',
    sequenceNumber: issueNumber ?? null,
    hasStructuredOrder: true,
    sortOrder,
  }
}

const parseFileForSource = (file: FileRecord, sourceFolder: SourceFolderRow) => {
  if (sourceFolder.category === 'anime') {
    return parseAnimeEntry(file, sourceFolder)
  }

  if (sourceFolder.category === 'manga') {
    return parseMangaEntry(file, sourceFolder)
  }

  if (sourceFolder.category === 'novels') {
    return parseNovelEntry(file, sourceFolder)
  }

  if (sourceFolder.category === 'magazines') {
    return parseMagazineEntry(file, sourceFolder)
  }

  return parseBookEntry(file, sourceFolder)
}

const groupSeriesFromFiles = (sourceFolder: SourceFolderRow, files: FileRecord[]) => {
  const groupedSeries = new Map<string, SeriesSpec>()

  for (const file of files) {
    const parsedEntry = parseFileForSource(file, sourceFolder)
    const existingSeries = groupedSeries.get(parsedEntry.groupKey)

    if (existingSeries) {
      existingSeries.entries.push(parsedEntry)
      if (!existingSeries.year && parsedEntry.year) {
        existingSeries.year = parsedEntry.year
      }
      continue
    }

    groupedSeries.set(parsedEntry.groupKey, {
      key: parsedEntry.groupKey,
      title: parsedEntry.seriesTitle,
      titleShort: parsedEntry.titleShort,
      category: sourceFolder.category,
      year: parsedEntry.year,
      format: parsedEntry.seriesFormat,
      status: parsedEntry.status,
      description: parsedEntry.description,
      folderPath: parsedEntry.groupFolder,
      tags: parsedEntry.tags,
      entries: [parsedEntry],
    })
  }

  return [...groupedSeries.values()].map((series) => {
    const sortedEntries = [...series.entries].sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder
      }

      return naturalCompare(left.file.relativePath, right.file.relativePath)
    })

    if (series.category === 'anime') {
      let fallbackIndex = 1

      for (const entry of sortedEntries) {
        if (entry.hasStructuredOrder || entry.entryKind !== 'entry') {
          continue
        }

        entry.episodeNumber = fallbackIndex
        entry.entryLabel = `Episode ${padNumber(fallbackIndex)}`
        entry.details = `${upperExtension(entry.file.extension)} • local video file`
        entry.sequenceNumber = fallbackIndex
        entry.sortOrder = 1000 + fallbackIndex
        fallbackIndex += 1
      }
    }

    return {
      ...series,
      entries: sortedEntries,
    }
  })
}

const localCoverForDirectory = (directoryPath: string) => {
  for (const coverName of localCoverNames) {
    const coverPath = path.join(directoryPath, coverName)
    if (fileExists(coverPath)) {
      return coverPath
    }
  }

  if (!fs.existsSync(directoryPath)) {
    return null
  }

  const candidateFile = fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (fileName) =>
        imageExtensions.has(path.extname(fileName).toLowerCase()) &&
        /^(cover|poster|folder)(?:$|[ ._-])/i.test(stripExtension(fileName)),
    )
    .sort(naturalCompare)[0]

  if (candidateFile) {
    return path.join(directoryPath, candidateFile)
  }

  return null
}

const normalizeGroupKeyPart = (value: string) => compactWhitespace(value).toLowerCase()

const getVariantPriority = (category: CategoryId, format: EntryFormat) =>
  entryVariantPriority[category][format] ?? 99

const compareEntryVariants = (category: CategoryId, left: EntryRow, right: EntryRow) => {
  const priorityDifference =
    getVariantPriority(category, left.format) - getVariantPriority(category, right.format)

  if (priorityDifference !== 0) {
    return priorityDifference
  }

  const titleDifference = naturalCompare(left.storage_file, right.storage_file)
  if (titleDifference !== 0) {
    return titleDifference
  }

  return naturalCompare(left.relative_path, right.relative_path)
}

const buildLogicalEntryKey = (category: CategoryId, entry: EntryRow) => {
  if (category === 'anime') {
    if (entry.episode_number != null || entry.season_number != null) {
      return `anime:${entry.season_number ?? 1}:${entry.episode_number ?? entry.sort_order}`
    }

    return `anime:file:${normalizeGroupKeyPart(entry.relative_path)}`
  }

  if (category === 'novels') {
    if (entry.chapter_number != null) {
      return `novel:chapter:${entry.chapter_number}`
    }

    return `novel:file:${entry.sort_order}:${normalizeGroupKeyPart(entry.title)}`
  }

  if (category === 'manga') {
    if (entry.chapter_number != null) {
      return `manga:chapter:${entry.chapter_number}`
    }

    return `manga:entry:${entry.sort_order}:${normalizeGroupKeyPart(entry.label)}:${normalizeGroupKeyPart(entry.title)}`
  }

  if (category === 'magazines') {
    return `magazine:issue:${entry.sort_order}:${normalizeGroupKeyPart(entry.label)}:${normalizeGroupKeyPart(entry.title)}`
  }

  return `book:${normalizeGroupKeyPart(entry.title)}`
}

const buildLogicalEntryDetails = (
  category: CategoryId,
  preferredVariant: EntryVariant,
  variants: EntryVariant[],
) => {
  if (variants.length === 1) {
    return preferredVariant.details
  }

  const formatList = [...new Set(variants.map((variant) => variant.format.toUpperCase()))]
  const preferredLabel =
    category === 'novels' || category === 'books' || category === 'magazines'
      ? `${preferredVariant.format.toUpperCase()} preferred`
      : `${preferredVariant.format.toUpperCase()} default`

  return `${preferredLabel} • ${variants.length} files available (${formatList.join(', ')})`
}

const buildLogicalEntries = (category: CategoryId, entries: EntryRow[]): LibraryEntry[] => {
  const groupedEntries = new Map<string, EntryRow[]>()

  for (const entry of entries) {
    const groupKey = buildLogicalEntryKey(category, entry)
    const existingEntries = groupedEntries.get(groupKey)

    if (existingEntries) {
      existingEntries.push(entry)
      continue
    }

    groupedEntries.set(groupKey, [entry])
  }

  return [...groupedEntries.values()].map((groupEntries) => {
    const sortedVariants = [...groupEntries].sort((left, right) => compareEntryVariants(category, left, right))
    const preferredVariantRow = sortedVariants[0]
    const variants = sortedVariants.map(
      (variant, index): EntryVariant => ({
        id: variant.id,
        variantLabel: `v${index + 1}`,
        storageFile: variant.storage_file,
        format: variant.format,
        details: variant.details,
        fileUrl: `/api/media/file/${variant.id}${buildEntryMediaVersionSuffix(variant)}`,
        downloadUrl: `/api/media/file/${variant.id}${buildEntryMediaVersionSuffix(variant)}`,
        mediaTracks: getMediaTracksForEntry(variant.id, variant.format, variant.file_path),
      }),
    )
    const preferredVariant = variants[0]

    return {
      id: preferredVariant.id,
      label: preferredVariantRow.label,
      title: preferredVariantRow.title,
      details: buildLogicalEntryDetails(category, preferredVariant, variants),
      chapterNumber: preferredVariantRow.chapter_number,
      seasonNumber: preferredVariantRow.season_number,
      episodeNumber: preferredVariantRow.episode_number,
      preferredVariantId: preferredVariant.id,
      variants,
    }
  })
}

const buildEntryMediaVersionSuffix = (entry: Pick<EntryRow, 'mtime_ms' | 'size'>) => {
  const mtime = Number.isFinite(entry.mtime_ms) ? Math.round(entry.mtime_ms) : 0
  const size = Number.isFinite(entry.size) ? entry.size : 0

  return `?v=${encodeURIComponent(`${mtime}-${size}`)}`
}

const parseStoredJsonArray = (value: string | null | undefined) => {
  if (!value) {
    return [] as string[]
  }

  try {
    const parsedValue = JSON.parse(value) as unknown
    return Array.isArray(parsedValue) ? parsedValue.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return [] as string[]
  }
}

const fallbackCoverSources = new Set([
  'Pending cover generation',
  'PDF first-page fallback',
  'CBZ first-page fallback',
  'Generated fallback cover',
])

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const formatSourceLabelFromPath = (sourcePath: string) => {
  const parentName = path.basename(path.dirname(sourcePath))
  const currentName = path.basename(sourcePath)
  return `${parentName}/${currentName}`
}

const buildScanProgressSummary = (
  sourceLabel: string,
  seriesCompleted: number,
  seriesTotal: number,
  filesDiscovered: number,
  currentSeries?: string | null,
) => {
  const baseSummary = `Indexing ${sourceLabel}: ${seriesCompleted}/${seriesTotal} series`
  const fileSummary = `${filesDiscovered} ${filesDiscovered === 1 ? 'file' : 'files'} discovered`

  if (currentSeries) {
    return `${baseSummary} • ${fileSummary} • ${currentSeries}`
  }

  return `${baseSummary} • ${fileSummary}`
}

const shouldEmitSeriesCheckpoint = (completedSeries: number, totalSeries: number) =>
  completedSeries === 1 || completedSeries === totalSeries || completedSeries % 5 === 0

const appendScanEvent = (
  db: Database,
  scanRunId: string,
  level: ScanEventLevel,
  message: string,
  reporter?: ScanReporter,
) => {
  const event: ScanLogEntry = {
    id: createId('scan_event'),
    level,
    message,
    createdAt: nowIso(),
  }

  db.prepare(
    `
      INSERT INTO scan_events (id, scan_run_id, level, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(event.id, scanRunId, event.level, event.message, event.createdAt)

  reporter?.onEvent?.(event)
}

const getStoredScanStatus = (db: Database): ScanStatus => {
  const latestRun = db
    .prepare(
      `
        SELECT id, started_at, finished_at, status, summary
        FROM scan_runs
        ORDER BY started_at DESC
        LIMIT 1
      `,
    )
    .get() as
    | {
        id: string
        started_at: string
        finished_at: string | null
        status: string
        summary: string
      }
    | undefined

  if (!latestRun) {
    return {
      active: false,
      runId: null,
      startedAt: null,
      finishedAt: null,
      totalSources: 0,
      completedSources: 0,
      currentSource: null,
      currentSourceFilesDiscovered: null,
      currentSourceSeriesTotal: null,
      currentSourceSeriesCompleted: 0,
      currentSeries: null,
      summary: null,
      events: [],
    }
  }

  const events = db
    .prepare(
      `
        SELECT id, level, message, created_at
        FROM scan_events
        WHERE scan_run_id = ?
        ORDER BY created_at DESC
        LIMIT 120
      `,
    )
    .all(latestRun.id) as Array<{
    id: string
    level: ScanEventLevel
    message: string
    created_at: string
  }>

  return {
    active: latestRun.status === 'running',
    runId: latestRun.id,
    startedAt: latestRun.started_at,
    finishedAt: latestRun.finished_at,
    totalSources: 0,
    completedSources: 0,
    currentSource: null,
    currentSourceFilesDiscovered: null,
    currentSourceSeriesTotal: null,
    currentSourceSeriesCompleted: 0,
    currentSeries: null,
    summary: latestRun.summary || null,
    events: events
      .map((event) => ({
        id: event.id,
        level: event.level,
        message: event.message,
        createdAt: event.created_at,
      }))
      .reverse(),
  }
}

export const getLatestScanStatus = (db: Database) => getStoredScanStatus(db)

export const markInterruptedScans = (db: Database) => {
  const interruptedRuns = db
    .prepare(
      `
        SELECT id
        FROM scan_runs
        WHERE status = 'running'
      `,
    )
    .all() as Array<{ id: string }>

  if (!interruptedRuns.length) {
    return
  }

  const finishedAt = nowIso()
  const summary = 'Scan was interrupted before completion.'

  for (const run of interruptedRuns) {
    appendScanEvent(db, run.id, 'error', summary)
    db.prepare(
      `
        UPDATE scan_runs
        SET finished_at = ?, status = 'error', summary = ?
        WHERE id = ?
      `,
    ).run(finishedAt, summary, run.id)
  }
}

const getMetadataOverride = (db: Database, seriesId: string) =>
  db
    .prepare(
      `
        SELECT series_id, title, year, description, cover_path, cover_mime,
               external_url, source_name, source_role,
               base_title, base_year, base_description, base_cover_path, base_cover_mime,
               base_cover_source, base_external_url, base_source_name, base_source_role,
               base_metadata_source, updated_at
        FROM metadata_overrides
        WHERE series_id = ?
        LIMIT 1
      `,
    )
    .get(seriesId) as MetadataOverrideRow | undefined

const normalizeOptionalOverrideText = (value: string | null | undefined) => {
  const nextValue = compactWhitespace(String(value || ''))
  return nextValue || null
}

const applyMetadataOverrideToSeriesSpec = (series: SeriesSpec, metadataOverride?: MetadataOverrideRow) => {
  if (!metadataOverride) {
    return series
  }

  const overriddenTitle = normalizeOptionalOverrideText(metadataOverride.title) || series.title
  const overriddenDescription =
    normalizeOptionalOverrideText(metadataOverride.description) || series.description

  return {
    ...series,
    title: overriddenTitle,
    titleShort: cleanSeriesTitle(overriddenTitle),
    year: metadataOverride.year ?? series.year,
    description: overriddenDescription,
  }
}

const applyMetadataOverrideToPresentation = (
  presentation: SeriesPresentation,
  metadataOverride?: MetadataOverrideRow,
): SeriesPresentation => {
  if (!metadataOverride) {
    return presentation
  }

  const nextPresentation = { ...presentation }
  let hasMetadataTextOverride = false
  let hasCoverOverride = false

  if (metadataOverride.year != null) {
    nextPresentation.year = metadataOverride.year
    hasMetadataTextOverride = true
  }

  const overriddenDescription = normalizeOptionalOverrideText(metadataOverride.description)
  if (overriddenDescription) {
    nextPresentation.description = overriddenDescription
    hasMetadataTextOverride = true
  }

  const overriddenExternalUrl = normalizeOptionalOverrideText(metadataOverride.external_url)
  if (overriddenExternalUrl) {
    nextPresentation.externalUrl = overriddenExternalUrl
    hasMetadataTextOverride = true
  }

  const overriddenSourceName = normalizeOptionalOverrideText(metadataOverride.source_name)
  if (overriddenSourceName) {
    nextPresentation.sourceName = overriddenSourceName
    hasMetadataTextOverride = true
  }

  const overriddenSourceRole = normalizeOptionalOverrideText(metadataOverride.source_role)
  if (overriddenSourceRole) {
    nextPresentation.sourceRole = overriddenSourceRole
    hasMetadataTextOverride = true
  }

  if (metadataOverride.cover_path && fileExists(metadataOverride.cover_path)) {
    nextPresentation.coverPath = metadataOverride.cover_path
    nextPresentation.coverMime =
      metadataOverride.cover_mime || mime.lookup(metadataOverride.cover_path) || 'application/octet-stream'
    nextPresentation.coverSource = 'Admin override cover'
    hasCoverOverride = true
  }

  if (hasMetadataTextOverride) {
    nextPresentation.metadataSource = withAdminOverrideSuffix(nextPresentation.metadataSource)
  }

  if (hasMetadataTextOverride || hasCoverOverride) {
    nextPresentation.metadataRefreshedAt = metadataOverride.updated_at || nowIso()
  }

  return nextPresentation
}

const persistSeriesPresentation = (
  db: Database,
  seriesId: string,
  title: string,
  titleShort: string,
  presentation: SeriesPresentation,
) => {
  db.prepare(
    `
      UPDATE series
      SET title = ?,
          title_short = ?,
          year = ?,
          description = ?,
          cover_path = ?,
          cover_mime = ?,
          banner_path = ?,
          banner_mime = ?,
          cover_source = ?,
          metadata_source = ?,
          remote_provider = ?,
          remote_id = ?,
          external_url = ?,
          source_name = ?,
          source_role = ?,
          genres_json = ?,
          tags_json = ?,
          metadata_refreshed_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
  ).run(
    title,
    titleShort,
    presentation.year,
    presentation.description,
    presentation.coverPath,
    presentation.coverMime,
    presentation.bannerPath,
    presentation.bannerMime,
    presentation.coverSource,
    presentation.metadataSource,
    presentation.remoteProvider,
    presentation.remoteId,
    presentation.externalUrl,
    presentation.sourceName,
    presentation.sourceRole,
    JSON.stringify(presentation.genres),
    JSON.stringify(presentation.tags),
    presentation.metadataRefreshedAt,
    nowIso(),
    seriesId,
  )
}

const mapSeriesRowToPresentation = (series: SeriesRow): SeriesPresentation => ({
  year: series.year,
  description: series.description,
  coverPath: series.cover_path,
  coverMime: series.cover_mime,
  bannerPath: series.banner_path,
  bannerMime: series.banner_mime,
  coverSource: series.cover_source,
  metadataSource: series.metadata_source,
  remoteProvider: series.remote_provider,
  remoteId: series.remote_id,
  externalUrl: series.external_url,
  sourceName: series.source_name,
  sourceRole: series.source_role,
  genres: parseStoredJsonArray(series.genres_json),
  tags: parseStoredJsonArray(series.tags_json),
  metadataRefreshedAt: series.metadata_refreshed_at,
})

const buildSeriesSpecFromStoredSeries = (
  series: SeriesRow,
  entryRows: Array<
    Pick<
      EntryRow,
      | 'id'
      | 'file_path'
      | 'relative_path'
      | 'storage_file'
      | 'format'
      | 'details'
      | 'title'
      | 'label'
      | 'chapter_number'
      | 'season_number'
      | 'episode_number'
      | 'sort_order'
    > & { size: number; mtime_ms: number }
  >,
  preferredTitle?: string,
) : SeriesSpec => ({
  key: series.id,
  title: preferredTitle || series.title,
  titleShort: cleanSeriesTitle(preferredTitle || series.title),
  category: series.category,
  year: series.year,
  format: series.format,
  status: series.status,
  description: series.description,
  folderPath: series.folder_path,
  tags: parseStoredJsonArray(series.tags_json),
  entries: entryRows.map((entry) => ({
    file: {
      path: entry.file_path || '',
      relativePath: entry.relative_path,
      baseName: entry.storage_file,
      extension: path.extname(entry.file_path || '').toLowerCase(),
      size: entry.size,
      mtimeMs: entry.mtime_ms,
    },
    groupKey: series.id,
    groupFolder: series.folder_path,
    seriesTitle: preferredTitle || series.title,
    titleShort: cleanSeriesTitle(preferredTitle || series.title),
    year: series.year,
    seriesFormat: series.format,
    status: series.status,
    description: series.description,
    tags: parseStoredJsonArray(series.tags_json),
    entryLabel: entry.label,
    entryTitle: entry.title,
    format: entry.format,
    details: entry.details,
    chapterNumber: entry.chapter_number,
    seasonNumber: entry.season_number,
    episodeNumber: entry.episode_number,
    entryKind: series.category === 'anime' ? 'episode' : series.category === 'manga' ? 'volume' : 'chapter',
    sequenceNumber: entry.chapter_number ?? entry.episode_number ?? entry.season_number ?? null,
    hasStructuredOrder: true,
    sortOrder: entry.sort_order,
  })),
})

const isDefaultSeriesDescription = (series: SeriesSpec, currentDescription: string | null | undefined) =>
  !currentDescription || compactWhitespace(currentDescription) === compactWhitespace(series.description)

const extractBookAuthorHint = (series: SeriesSpec) => {
  const authorMatch = series.description.match(/^Local book file by (.+)\.$/i)
  return authorMatch?.[1]?.trim() || null
}

const sanitizeRemoteDescription = (value: string | null | undefined) =>
  compactWhitespace(String(value || ''))

const downloadRemoteAsset = async (
  assetUrl: string,
  outputBasePath: string,
): Promise<{ filePath: string; mimeType: string }> => {
  const response = await fetch(assetUrl, {
    headers: {
      Accept: 'image/*',
      'User-Agent': 'Orbital Library metadata cache',
    },
  })

  if (!response.ok) {
    throw new Error(`Asset download failed with ${response.status}`)
  }

  const contentType = response.headers.get('content-type') || mime.lookup(assetUrl) || 'image/jpeg'
  const assetMime = String(contentType).split(';')[0].trim()
  const extensionFromMime = mime.extension(assetMime)
  const extensionFromUrl = path.extname(new URL(assetUrl).pathname)
  const extension =
    (extensionFromMime ? `.${extensionFromMime}` : extensionFromUrl) || '.jpg'
  const outputPath = `${outputBasePath}${extension}`
  const assetBuffer = Buffer.from(await response.arrayBuffer())

  await fsPromises.writeFile(outputPath, assetBuffer)

  return {
    filePath: outputPath,
    mimeType: assetMime,
  }
}

const getGroupedEntryCountsBySeries = (
  db: Database,
  seriesRows: Array<Pick<SeriesRow, 'id' | 'category'>>,
) => {
  const groupedCounts = new Map<string, number>()

  if (seriesRows.length === 0) {
    return groupedCounts
  }

  const placeholders = seriesRows.map(() => '?').join(', ')
  const entryRows = db
    .prepare(
      `
        SELECT series_id, relative_path, label, title, sort_order, chapter_number, season_number, episode_number
        FROM entries
        WHERE series_id IN (${placeholders})
      `,
    )
    .all(...seriesRows.map((series) => series.id)) as Array<
      Pick<
        EntryRow,
        | 'series_id'
        | 'relative_path'
        | 'label'
        | 'title'
        | 'sort_order'
        | 'chapter_number'
        | 'season_number'
        | 'episode_number'
      >
    >
  const categoryBySeries = new Map(seriesRows.map((series) => [series.id, series.category]))
  const groupedKeysBySeries = new Map<string, Set<string>>()

  for (const entry of entryRows) {
    const category = categoryBySeries.get(entry.series_id)

    if (!category) {
      continue
    }

    const groupedKeys = groupedKeysBySeries.get(entry.series_id) ?? new Set<string>()
    groupedKeys.add(buildLogicalEntryKey(category, entry as EntryRow))
    groupedKeysBySeries.set(entry.series_id, groupedKeys)
  }

  for (const series of seriesRows) {
    groupedCounts.set(series.id, groupedKeysBySeries.get(series.id)?.size ?? 0)
  }

  return groupedCounts
}

const renderPdfCover = async (inputPath: string, outputPath: string) => {
  const documentData = new Uint8Array(await fsPromises.readFile(inputPath))
  const loadingTask = pdfjs.getDocument({
    data: documentData,
    useSystemFonts: true,
  })

  const pdfDocument = await loadingTask.promise

  try {
    const firstPage = await pdfDocument.getPage(1)
    const baseViewport = firstPage.getViewport({ scale: 1 })
    const scale = 500 / Math.max(baseViewport.width, 1)
    const viewport = firstPage.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const context = canvas.getContext('2d')

    await firstPage.render({ canvasContext: context, viewport }).promise
    await fsPromises.writeFile(outputPath, canvas.toBuffer('image/png'))
  } finally {
    await pdfDocument.destroy()
  }
}

const extractCbzCover = async (inputPath: string, outputBasePath: string) => {
  const archive = await JSZip.loadAsync(await fsPromises.readFile(inputPath))
  const imageEntry = Object.values(archive.files)
    .filter((entry) => !entry.dir && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .sort((left, right) => naturalCompare(left.name, right.name))[0]

  if (!imageEntry) {
    throw new Error('No readable image page found in archive.')
  }

  const extension = path.extname(imageEntry.name).toLowerCase() || '.jpg'
  const outputPath = `${outputBasePath}${extension}`
  const imageBuffer = await imageEntry.async('nodebuffer')
  await fsPromises.writeFile(outputPath, imageBuffer)

  return {
    outputPath,
    mimeType: mime.lookup(outputPath) || 'image/jpeg',
  }
}

const writeFallbackCover = async (
  category: CategoryId,
  title: string,
  subtitle: string,
  outputPath: string,
) => {
  const categoryLabel = category.toUpperCase()
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="840" height="1200" viewBox="0 0 840 1200">
  <defs>
    <linearGradient id="bg" x1="0%" x2="100%" y1="0%" y2="100%">
      <stop offset="0%" stop-color="#111a27"/>
      <stop offset="100%" stop-color="#050912"/>
    </linearGradient>
    <linearGradient id="line" x1="0%" x2="100%" y1="0%" y2="0%">
      <stop offset="0%" stop-color="#59d7ff"/>
      <stop offset="100%" stop-color="#ffd27a"/>
    </linearGradient>
  </defs>
  <rect width="840" height="1200" rx="42" fill="url(#bg)"/>
  <rect x="56" y="56" width="728" height="1088" rx="34" fill="none" stroke="rgba(255,255,255,0.08)"/>
  <rect x="92" y="112" width="220" height="58" rx="29" fill="none" stroke="url(#line)" stroke-width="2"/>
  <text x="202" y="149" text-anchor="middle" fill="#70d8ff" font-size="28" font-family="Arial, sans-serif" letter-spacing="5">${escapeHtml(categoryLabel)}</text>
  <text x="92" y="334" fill="#f3f7ff" font-size="72" font-family="Arial, sans-serif" font-weight="700">${escapeHtml(title)}</text>
  <text x="92" y="406" fill="#95a8c2" font-size="32" font-family="Arial, sans-serif">${escapeHtml(subtitle)}</text>
  <line x1="92" y1="460" x2="748" y2="460" stroke="url(#line)" stroke-width="3"/>
  <text x="92" y="1036" fill="#7a8ea9" font-size="26" font-family="Arial, sans-serif">Generated local fallback cover</text>
</svg>`

  await fsPromises.writeFile(outputPath, svg)
}

const resolveSeriesPresentation = async (
  seriesId: string,
  series: SeriesSpec,
  existingSeries:
    | Pick<
        SeriesRow,
        | 'year'
        | 'description'
        | 'cover_path'
        | 'cover_mime'
        | 'banner_path'
        | 'banner_mime'
        | 'cover_source'
        | 'metadata_source'
        | 'remote_provider'
        | 'remote_id'
        | 'external_url'
        | 'source_name'
        | 'source_role'
        | 'genres_json'
        | 'tags_json'
        | 'metadata_refreshed_at'
      >
    | undefined,
  seriesChanged: boolean,
  coversDirectory: string,
  reporter?: ScanReporter,
  scanRunId?: string,
  db?: Database,
  metadataOverride?: MetadataOverrideRow,
  forceRemoteRefresh = false,
): Promise<SeriesPresentation> => {
  const localDirectoryCover = localCoverForDirectory(series.folderPath)
  const existingGenres = parseStoredJsonArray(existingSeries?.genres_json)
  const existingTags = parseStoredJsonArray(existingSeries?.tags_json)
  const existingBannerIsUsable =
    Boolean(existingSeries?.banner_path) && fileExists(existingSeries?.banner_path)
  const existingCoverIsUsable =
    Boolean(existingSeries?.cover_path) && fileExists(existingSeries?.cover_path)
  const hasMeaningfulRemoteMetadata =
    Boolean(existingSeries?.remote_provider) &&
    !isDefaultSeriesDescription(series, existingSeries?.description) &&
    (existingGenres.length > 0 || Boolean(existingSeries?.source_name) || Boolean(existingSeries?.external_url))

  let resolvedDescription = existingSeries?.description || series.description
  let resolvedYear = existingSeries?.year ?? series.year
  let resolvedMetadataSource = existingSeries?.metadata_source || 'Folder-derived metadata'
  let resolvedRemoteProvider = existingSeries?.remote_provider || null
  let resolvedRemoteId = existingSeries?.remote_id || null
  let resolvedExternalUrl = existingSeries?.external_url || null
  let resolvedSourceName = existingSeries?.source_name || null
  let resolvedSourceRole = existingSeries?.source_role || null
  let resolvedGenres = existingGenres
  let resolvedTags = existingTags.length > 0 ? existingTags : series.tags
  let resolvedMetadataRefreshedAt = existingSeries?.metadata_refreshed_at || null
  let resolvedBannerPath = existingSeries?.banner_path || null
  let resolvedBannerMime = existingSeries?.banner_mime || null

  const shouldFetchRemoteMetadata =
    series.category !== 'novels' &&
    series.category !== 'magazines' &&
    (forceRemoteRefresh ||
      !hasMeaningfulRemoteMetadata ||
      !existingBannerIsUsable ||
      (!localDirectoryCover &&
        (!existingCoverIsUsable || fallbackCoverSources.has(existingSeries?.cover_source || ''))))

  if (shouldFetchRemoteMetadata) {
    try {
      const remoteMetadata = await fetchRemoteMetadata({
        category: series.category,
        title: series.title,
        year: series.year,
        authorHint: series.category === 'books' ? extractBookAuthorHint(series) : null,
      })

      if (remoteMetadata) {
        if (db && scanRunId) {
          appendScanEvent(
            db,
            scanRunId,
            'info',
            `Matched ${remoteMetadata.provider} metadata for ${series.title}`,
            reporter,
          )
        }

        if (remoteMetadata.description) {
          resolvedDescription = sanitizeRemoteDescription(remoteMetadata.description)
        }

        if (resolvedYear == null && remoteMetadata.year != null) {
          resolvedYear = remoteMetadata.year
        }

        resolvedMetadataSource = `${remoteMetadata.provider} match`
        resolvedRemoteProvider = remoteMetadata.provider
        resolvedRemoteId = remoteMetadata.providerId
        resolvedExternalUrl = remoteMetadata.externalUrl
        resolvedSourceName = remoteMetadata.sourceName
        resolvedSourceRole = remoteMetadata.sourceRole
        resolvedGenres = remoteMetadata.genres
        resolvedTags = remoteMetadata.tags.length > 0 ? remoteMetadata.tags : resolvedTags
        resolvedMetadataRefreshedAt = nowIso()

        if (remoteMetadata.bannerImageUrl) {
          const bannerAsset = await downloadRemoteAsset(
            remoteMetadata.bannerImageUrl,
            path.join(coversDirectory, `${seriesId}-banner`),
          )
          resolvedBannerPath = bannerAsset.filePath
          resolvedBannerMime = bannerAsset.mimeType
        }

        if (!localDirectoryCover && remoteMetadata.coverImageUrl) {
          const coverAsset = await downloadRemoteAsset(
            remoteMetadata.coverImageUrl,
            path.join(coversDirectory, `${seriesId}-remote-cover`),
          )

          return applyMetadataOverrideToPresentation({
            year: resolvedYear,
            description: resolvedDescription,
            coverPath: coverAsset.filePath,
            coverMime: coverAsset.mimeType,
            bannerPath: resolvedBannerPath,
            bannerMime: resolvedBannerMime,
            coverSource: `${remoteMetadata.provider} cover cache`,
            metadataSource: resolvedMetadataSource,
            remoteProvider: resolvedRemoteProvider,
            remoteId: resolvedRemoteId,
            externalUrl: resolvedExternalUrl,
            sourceName: resolvedSourceName,
            sourceRole: resolvedSourceRole,
            genres: resolvedGenres,
            tags: resolvedTags,
            metadataRefreshedAt: resolvedMetadataRefreshedAt,
          }, metadataOverride)
        }
      }
    } catch {
      // Keep local or cached metadata when remote fetching fails.
    }
  }

  if (localDirectoryCover) {
    return applyMetadataOverrideToPresentation({
      year: resolvedYear,
      description: resolvedDescription,
      coverPath: localDirectoryCover,
      coverMime: mime.lookup(localDirectoryCover) || null,
      bannerPath: resolvedBannerPath,
      bannerMime: resolvedBannerMime,
      coverSource: 'Local image cover',
      metadataSource: resolvedMetadataSource,
      remoteProvider: resolvedRemoteProvider,
      remoteId: resolvedRemoteId,
      externalUrl: resolvedExternalUrl,
      sourceName: resolvedSourceName,
      sourceRole: resolvedSourceRole,
      genres: resolvedGenres,
      tags: resolvedTags,
      metadataRefreshedAt: resolvedMetadataRefreshedAt,
    }, metadataOverride)
  }

  if (!seriesChanged && existingCoverIsUsable) {
    return applyMetadataOverrideToPresentation({
      year: resolvedYear,
      description: resolvedDescription,
      coverPath: existingSeries?.cover_path || null,
      coverMime: existingSeries?.cover_mime || mime.lookup(existingSeries?.cover_path || '') || null,
      bannerPath: resolvedBannerPath,
      bannerMime: resolvedBannerMime,
      coverSource: existingSeries?.cover_path?.endsWith('.svg')
        ? 'Generated fallback cover'
        : existingSeries?.cover_source || 'Cached local cover',
      metadataSource: resolvedMetadataSource,
      remoteProvider: resolvedRemoteProvider,
      remoteId: resolvedRemoteId,
      externalUrl: resolvedExternalUrl,
      sourceName: resolvedSourceName,
      sourceRole: resolvedSourceRole,
      genres: resolvedGenres,
      tags: resolvedTags,
      metadataRefreshedAt: resolvedMetadataRefreshedAt,
    }, metadataOverride)
  }

  const firstEntry = series.entries[0]
  const outputBasePath = path.join(coversDirectory, seriesId)

  try {
    if (firstEntry && firstEntry.format === 'pdf') {
      const outputPath = `${outputBasePath}.png`
      await renderPdfCover(firstEntry.file.path, outputPath)

      return applyMetadataOverrideToPresentation({
        year: resolvedYear,
        description: resolvedDescription,
        coverPath: outputPath,
        coverMime: 'image/png',
        bannerPath: resolvedBannerPath,
        bannerMime: resolvedBannerMime,
        coverSource: 'PDF first-page fallback',
        metadataSource: resolvedMetadataSource,
        remoteProvider: resolvedRemoteProvider,
        remoteId: resolvedRemoteId,
        externalUrl: resolvedExternalUrl,
        sourceName: resolvedSourceName,
        sourceRole: resolvedSourceRole,
        genres: resolvedGenres,
        tags: resolvedTags,
        metadataRefreshedAt: resolvedMetadataRefreshedAt,
      }, metadataOverride)
    }

    if (firstEntry && firstEntry.format === 'cbz') {
      const archiveCover = await extractCbzCover(firstEntry.file.path, outputBasePath)

      return applyMetadataOverrideToPresentation({
        year: resolvedYear,
        description: resolvedDescription,
        coverPath: archiveCover.outputPath,
        coverMime: archiveCover.mimeType.toString(),
        bannerPath: resolvedBannerPath,
        bannerMime: resolvedBannerMime,
        coverSource: 'CBZ first-page fallback',
        metadataSource: resolvedMetadataSource,
        remoteProvider: resolvedRemoteProvider,
        remoteId: resolvedRemoteId,
        externalUrl: resolvedExternalUrl,
        sourceName: resolvedSourceName,
        sourceRole: resolvedSourceRole,
        genres: resolvedGenres,
        tags: resolvedTags,
        metadataRefreshedAt: resolvedMetadataRefreshedAt,
      }, metadataOverride)
    }
  } catch {
    // Fall back to generated SVG below.
  }

  const svgPath = `${outputBasePath}.svg`
  await writeFallbackCover(series.category, series.title, series.format, svgPath)

  return applyMetadataOverrideToPresentation({
    year: resolvedYear,
    description: resolvedDescription,
    coverPath: svgPath,
    coverMime: 'image/svg+xml',
    bannerPath: resolvedBannerPath,
    bannerMime: resolvedBannerMime,
    coverSource: 'Generated fallback cover',
    metadataSource: resolvedMetadataSource,
    remoteProvider: resolvedRemoteProvider,
    remoteId: resolvedRemoteId,
    externalUrl: resolvedExternalUrl,
    sourceName: resolvedSourceName,
    sourceRole: resolvedSourceRole,
    genres: resolvedGenres,
    tags: resolvedTags,
    metadataRefreshedAt: resolvedMetadataRefreshedAt,
  }, metadataOverride)
}

const buildProgressLabel = (category: CategoryId, entryCount: number) => {
  if (category === 'anime') {
    return `${entryCount} ${entryCount === 1 ? 'episode' : 'episodes'}`
  }

  if (category === 'manga') {
    return `${entryCount} ${entryCount === 1 ? 'volume' : 'volumes'}`
  }

  if (category === 'novels') {
    return `${entryCount} ${entryCount === 1 ? 'chapter' : 'chapters'}`
  }

  if (category === 'magazines') {
    return `${entryCount} ${entryCount === 1 ? 'issue' : 'issues'}`
  }

  return `${entryCount} ${entryCount === 1 ? 'book file' : 'book files'}`
}

const formatSourceItemCount = (category: CategoryId, count: number) => {
  if (category === 'anime') {
    return `${count} indexed series`
  }

  if (category === 'manga') {
    return `${count} indexed manga series`
  }

  if (category === 'novels') {
    return `${count} indexed novel series`
  }

  if (category === 'magazines') {
    return `${count} indexed magazine series`
  }

  return `${count} indexed books`
}

const pickNewestTimestamp = (...timestamps: Array<string | null | undefined>) =>
  timestamps.reduce<string | null>((newest, timestamp) => {
    if (!timestamp) {
      return newest
    }

    if (!newest) {
      return timestamp
    }

    const timestampTime = new Date(timestamp).getTime()
    const newestTime = new Date(newest).getTime()

    if (!Number.isFinite(timestampTime)) {
      return newest
    }

    if (!Number.isFinite(newestTime) || timestampTime > newestTime) {
      return timestamp
    }

    return newest
  }, null)

const buildMediaVersionSuffix = (
  media: { last_scan_at: string | null; metadata_refreshed_at?: string | null },
) => {
  const version = pickNewestTimestamp(media.last_scan_at, media.metadata_refreshed_at)

  return version ? `?v=${encodeURIComponent(version)}` : ''
}

const mapSeriesRowToSummary = (
  series: SeriesRow,
  entryCount = series.file_count,
): SeriesSummary => {
  const mediaVersion = buildMediaVersionSuffix(series)

  return {
    id: series.id,
    title: series.title,
    titleShort: series.title_short,
    category: series.category,
    year: series.year,
    format: series.format,
    status: series.status,
    progressLabel: buildProgressLabel(series.category, entryCount),
    description: series.description,
    folder: series.folder_path,
    coverUrl: series.cover_path ? `/api/media/cover/${series.id}${mediaVersion}` : null,
    bannerUrl: series.banner_path ? `/api/media/banner/${series.id}${mediaVersion}` : null,
    coverSource: series.cover_source,
    metadataSource: series.metadata_source,
    externalUrl: series.external_url,
    sourceName: series.source_name,
    sourceRole: series.source_role,
    genres: parseStoredJsonArray(series.genres_json),
    tags: parseStoredJsonArray(series.tags_json),
    stats: {
      fileCount: entryCount,
      lastScanAt: series.last_scan_at,
    },
  }
}

const getSourceRoots = (db: Database, config: AppConfig): SourceRoot[] => {
  const roots = db
    .prepare(
      `
        SELECT r.id, r.label, r.path, COUNT(s.id) AS source_count
        FROM source_roots r
        LEFT JOIN source_folders s ON s.root_id = r.id
        GROUP BY r.id
        ORDER BY r.label COLLATE NOCASE
      `,
    )
    .all() as Array<SourceRootRow & { source_count: number }>

  return roots.map((root) => ({
    id: root.id,
    label: root.label,
    path: toDisplayMountedPath(config, root.path),
    note: formatSourceRootNote(root.source_count, isManagedSourceRootPath(config, root.path)),
    managed: isManagedSourceRootPath(config, root.path),
  }))
}

const getSourceFolders = (db: Database, config: AppConfig): SourceFolder[] => {
  const sourceFolders = db
    .prepare(
      `
        SELECT id, root_id, category, path, relative_path, item_count, last_scan_at, last_scan_status
        FROM source_folders
        WHERE enabled = 1
        ORDER BY category, path
      `,
    )
    .all() as SourceFolderRow[]

  return sourceFolders.map((sourceFolder) => ({
    id: sourceFolder.id,
    category: sourceFolder.category,
    path: toDisplayMountedPath(config, sourceFolder.path),
    relativePath: sourceFolder.relative_path,
    items: formatSourceItemCount(sourceFolder.category, sourceFolder.item_count),
    status: sourceFolder.last_scan_status || 'Ready',
    lastScanAt: sourceFolder.last_scan_at,
  }))
}

const getUserSummaries = (db: Database): UserSummary[] =>
  (db
    .prepare(
      `
        SELECT id, username, role
        FROM users
        ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username COLLATE NOCASE
      `,
    )
    .all() as UserRow[]).map((user) => ({
    id: user.id,
    name: user.username,
    role: user.role === 'admin' ? 'Admin' : 'Member',
    status: user.role === 'admin' ? 'Protected' : 'Active',
  }))

const getMetadataQueue = (db: Database): MetadataQueueItem[] =>
  (db
    .prepare(
      `
        SELECT id, category, title, cover_source, metadata_source, remote_provider,
               source_name, description, cover_path, last_scan_at, metadata_refreshed_at
        FROM series
        ORDER BY
          CASE
            WHEN cover_source = 'Generated fallback cover' THEN 0
            WHEN metadata_source = 'Folder-derived metadata' THEN 1
            ELSE 2
          END,
          updated_at DESC
        LIMIT 16
      `,
    )
    .all() as Array<{
    id: string
    category: CategoryId
    title: string
    cover_source: string
    metadata_source: string
    remote_provider: string | null
    source_name: string | null
    description: string
    cover_path: string | null
    last_scan_at: string | null
    metadata_refreshed_at: string | null
  }>).map((item) => ({
    id: item.id,
    category: item.category,
    title: item.title,
    coverUrl: item.cover_path && fileExists(item.cover_path)
      ? `/api/media/cover/${item.id}${buildMediaVersionSuffix(item)}`
      : null,
    coverSource: item.cover_source,
    metadataSource: item.metadata_source,
    sourceName: item.source_name,
    summary: item.remote_provider
      ? `${item.cover_source} • ${item.metadata_source} • ${item.remote_provider}`
      : `${item.cover_source} • ${item.metadata_source}`,
    status:
      item.cover_source === 'Generated fallback cover' || item.metadata_source === 'Folder-derived metadata'
        ? 'Review'
        : 'Stable',
    reason:
      item.cover_source === 'Generated fallback cover'
        ? 'Fallback cover only'
        : item.metadata_source === 'Folder-derived metadata'
          ? 'No remote match yet'
          : !item.description
            ? 'Missing description'
            : 'Metadata cached',
  }))

const getScanSummary = (db: Database): ScanSummary => {
  const lastRun = db
    .prepare(
      `
        SELECT finished_at, changed_files
        FROM scan_runs
        WHERE status = 'success'
        ORDER BY started_at DESC
        LIMIT 1
      `,
    )
    .get() as { finished_at: string | null; changed_files: number } | undefined

  const rootCount = db.prepare(`SELECT COUNT(*) AS count FROM source_roots`).get() as {
    count: number
  }
  const folderCount = db.prepare(`SELECT COUNT(*) AS count FROM source_folders WHERE enabled = 1`).get() as {
    count: number
  }

  return {
    lastScanAt: lastRun?.finished_at ?? null,
    changedFiles: lastRun?.changed_files ?? 0,
    sourceRootCount: rootCount.count,
    sourceFolderCount: folderCount.count,
  }
}

const getBookmarks = (db: Database, userId: string): Bookmark[] =>
  (db
    .prepare(
      `
        SELECT b.series_id, b.category, b.entry_id, b.entry_index, b.progress, b.cue, b.last_seen,
               e.label AS entry_label, e.title AS entry_title
        FROM bookmarks b
        INNER JOIN entries e ON e.id = b.entry_id
        WHERE b.user_id = ?
        ORDER BY b.last_seen DESC
      `,
    )
    .all(userId) as Array<{
    series_id: string
    category: CategoryId
    entry_id: string
    entry_index: number
    progress: string
    cue: string
    last_seen: string
    entry_label: string
    entry_title: string
  }>).map((bookmark) => ({
    seriesId: bookmark.series_id,
    category: bookmark.category,
    entryId: bookmark.entry_id,
    entryIndex: bookmark.entry_index,
    entryLabel: bookmark.entry_label,
    entryTitle: bookmark.entry_title,
    progress: bookmark.progress,
    cue: bookmark.cue,
    lastSeen: bookmark.last_seen,
  }))

const getReadingPositions = (db: Database, userId: string) => {
  const readingPositions = db
    .prepare(
      `
        SELECT entry_id, page, total_pages, view_mode, location_type, progress_label, cue_label
        FROM reading_positions
        WHERE user_id = ?
      `,
    )
    .all(userId) as Array<{
    entry_id: string
    page: number
    total_pages: number | null
    view_mode: SavedReadingPosition['viewMode']
    location_type: SavedReadingPosition['locationType']
    progress_label: string | null
    cue_label: string | null
  }>

  return readingPositions.reduce<Record<string, SavedReadingPosition>>((accumulator, position) => {
    accumulator[position.entry_id] = {
      page: position.page,
      totalPages: position.total_pages ?? undefined,
      viewMode: position.view_mode ?? undefined,
      locationType: position.location_type ?? undefined,
      progressLabel: position.progress_label ?? undefined,
      cueLabel: position.cue_label ?? undefined,
    }

    return accumulator
  }, {})
}

export const bootstrapAdminUser = async (db: Database, config: AppConfig) => {
  const existingAdmin = db
    .prepare(`SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1`)
    .get(config.bootstrapAdmin) as { id: string } | undefined

  if (existingAdmin) {
    db.prepare(
      `UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?`,
    ).run(nowIso(), existingAdmin.id)
    return
  }

  const now = nowIso()
  const passwordHash = await bcrypt.hash(config.bootstrapPassword, 10)
  db.prepare(
    `
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, 'admin', ?, ?)
    `,
  ).run(createId('user'), config.bootstrapAdmin, passwordHash, now, now)
}

export const createSession = (db: Database, userId: string) => {
  const sessionId = createId('session')
  const csrfToken = createSecretToken()
  const expiresAt = Date.now() + SESSION_TTL_MS
  db.prepare(
    `
      INSERT INTO sessions (id, user_id, expires_at, csrf_token, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(sessionId, userId, expiresAt, csrfToken, nowIso())

  return { sessionId, expiresAt, csrfToken }
}

export const findSessionContext = (db: Database, sessionId: string | null | undefined) => {
  if (!sessionId) {
    return null
  }

  const session = db
    .prepare(
      `
        SELECT s.id, s.expires_at, s.csrf_token, u.id AS user_id, u.username, u.role
        FROM sessions s
        INNER JOIN users u ON u.id = s.user_id
        WHERE s.id = ?
      `,
    )
    .get(sessionId) as
    | {
        id: string
        expires_at: number
        csrf_token: string | null
        user_id: string
        username: string
        role: SessionUser['role']
      }
    | undefined

  if (!session) {
    return null
  }

  if (session.expires_at <= Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(session.id)
    return null
  }

  const csrfToken = session.csrf_token || createSecretToken()

  if (!session.csrf_token) {
    db.prepare(`UPDATE sessions SET csrf_token = ? WHERE id = ?`).run(csrfToken, session.id)
  }

  return {
    sessionId: session.id,
    csrfToken,
    user: {
      id: session.user_id,
      username: session.username,
      role: session.role,
    } satisfies SessionUser,
  }
}

export const findSessionUser = (db: Database, sessionId: string | null | undefined) =>
  findSessionContext(db, sessionId)?.user ?? null

export const clearSession = (db: Database, sessionId: string | null | undefined) => {
  if (!sessionId) {
    return
  }

  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId)
}

export const loginUser = async (db: Database, username: string, password: string) => {
  const normalizedUsername = username.trim()

  if (!normalizedUsername) {
    throw new Error('Unknown username or password.')
  }

  const user = db
    .prepare(
      `
        SELECT id, username, role, password_hash
        FROM users
        WHERE lower(username) = lower(?)
        LIMIT 1
      `,
    )
    .get(normalizedUsername) as UserRow | undefined

  if (!user) {
    throw new Error('Unknown username or password.')
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash)

  if (!passwordMatches) {
    throw new Error('Unknown username or password.')
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role,
  } satisfies SessionUser
}

export const signupUser = async (db: Database, username: string, password: string) => {
  const normalizedUsername = username.trim()

  if (normalizedUsername.length < 2) {
    throw new Error('Username must be at least 2 characters long.')
  }

  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters long.')
  }

  const existingUser = db
    .prepare(`SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1`)
    .get(normalizedUsername) as { id: string } | undefined

  if (existingUser) {
    throw new Error('That username already exists.')
  }

  const now = nowIso()
  const passwordHash = await bcrypt.hash(password, 10)
  const userId = createId('user')

  db.prepare(
    `
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, 'member', ?, ?)
    `,
  ).run(userId, normalizedUsername, passwordHash, now, now)

  return {
    id: userId,
    username: normalizedUsername,
    role: 'member',
  } satisfies SessionUser
}

export const getAppState = (
  db: Database,
  config: AppConfig,
  user: SessionUser | null,
  liveScanStatus?: ScanStatus | null,
): AppState => {
  const seriesRows = user
    ? db
        .prepare(
          `
            SELECT id, source_folder_id, category, title, title_short, year, format, status,
                   description, folder_path, cover_source, metadata_source, cover_path, cover_mime,
                   banner_path, banner_mime, remote_provider, remote_id, external_url,
                   source_name, source_role, genres_json, file_count, last_scan_at, tags_json,
                   metadata_refreshed_at
            FROM series
            ORDER BY category, CASE WHEN year IS NULL THEN 999999 ELSE year END, title COLLATE NOCASE
          `,
        )
        .all() as SeriesRow[]
    : []
  const groupedEntryCounts = getGroupedEntryCountsBySeries(db, seriesRows)

  return {
    appName: config.appName,
    bootstrapAdmin: config.bootstrapAdmin,
    openSignup: config.openSignup,
    user,
    csrfToken: null,
    scanSummary: getScanSummary(db),
    scanStatus: liveScanStatus ?? getStoredScanStatus(db),
    library: seriesRows.map((series) => mapSeriesRowToSummary(series, groupedEntryCounts.get(series.id))),
    bookmarks: user ? getBookmarks(db, user.id) : [],
    readingPositions: user ? getReadingPositions(db, user.id) : {},
    sourceRoots: user?.role === 'admin' ? getSourceRoots(db, config) : [],
    sourceFolders: user?.role === 'admin' ? getSourceFolders(db, config) : [],
    users: user?.role === 'admin' ? getUserSummaries(db) : [],
    metadataQueue: user?.role === 'admin' ? getMetadataQueue(db) : [],
  }
}

export const getSeriesDetail = (db: Database, seriesId: string): SeriesDetail => {
  const series = db
    .prepare(
      `
        SELECT id, source_folder_id, category, title, title_short, year, format, status,
               description, folder_path, cover_source, metadata_source, cover_path, cover_mime,
               banner_path, banner_mime, remote_provider, remote_id, external_url,
               source_name, source_role, genres_json, file_count, last_scan_at, tags_json,
               metadata_refreshed_at
        FROM series
        WHERE id = ?
      `,
    )
    .get(seriesId) as SeriesRow | undefined

  if (!series) {
    throw new Error('Series not found.')
  }

  const entries = db
    .prepare(
      `
        SELECT series_id, id, relative_path, label, title, storage_file, format, details,
               sort_order, chapter_number, season_number, episode_number, file_path, size, mtime_ms
        FROM entries
        WHERE series_id = ?
        ORDER BY sort_order, label, title
      `,
    )
    .all(seriesId) as EntryRow[]
  const logicalEntries = buildLogicalEntries(series.category, entries)

  const comments = db
    .prepare(
      `
        SELECT c.id, u.username, c.text, c.created_at
        FROM comments c
        INNER JOIN users u ON u.id = c.user_id
        WHERE c.series_id = ?
        ORDER BY c.created_at DESC
      `,
    )
    .all(seriesId) as Array<{
    id: string
    username: string
    text: string
    created_at: string
  }>

  return {
    ...mapSeriesRowToSummary(series, logicalEntries.length),
    entries: logicalEntries,
    comments: comments.map(
      (comment): SeriesComment => ({
        id: comment.id,
        user: comment.username,
        text: comment.text,
        when: comment.created_at,
      }),
    ),
  }
}

export const saveMetadataOverride = async (
  db: Database,
  config: AppConfig,
  seriesId: string,
  input: {
    title?: string | null
    year?: number | null
    description?: string | null
    externalUrl?: string | null
    sourceName?: string | null
    sourceRole?: string | null
    coverImageUrl?: string | null
    clearCover?: boolean
  },
) => {
  const series = db
    .prepare(
      `
        SELECT id, source_folder_id, category, title, title_short, year, format, status,
               description, folder_path, cover_source, metadata_source, cover_path, cover_mime,
               banner_path, banner_mime, remote_provider, remote_id, external_url,
               source_name, source_role, genres_json, file_count, last_scan_at, tags_json,
               metadata_refreshed_at
        FROM series
        WHERE id = ?
      `,
    )
    .get(seriesId) as SeriesRow | undefined

  if (!series) {
    throw new Error('Series not found.')
  }

  const existingOverride = getMetadataOverride(db, seriesId)
  let overrideCoverPath = existingOverride?.cover_path || null
  let overrideCoverMime = existingOverride?.cover_mime || null

  if (input.clearCover) {
    overrideCoverPath = null
    overrideCoverMime = null
  }

  const coverImageUrl = normalizeOptionalOverrideText(input.coverImageUrl)
  if (coverImageUrl) {
    const parsedUrl = new URL(coverImageUrl)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Cover image URL must use http or https.')
    }

    const coverAsset = await downloadRemoteAsset(
      coverImageUrl,
      path.join(config.coversDirectory, `${seriesId}-override-cover`),
    )
    overrideCoverPath = coverAsset.filePath
    overrideCoverMime = coverAsset.mimeType
  }

  const nextOverride = {
    title: normalizeOptionalOverrideText(input.title),
    year: input.year ?? null,
    description: normalizeOptionalOverrideText(input.description),
    externalUrl: normalizeOptionalOverrideText(input.externalUrl),
    sourceName: normalizeOptionalOverrideText(input.sourceName),
    sourceRole: normalizeOptionalOverrideText(input.sourceRole),
    coverPath: overrideCoverPath,
    coverMime: overrideCoverMime,
  }

  const hasAnyOverride =
    nextOverride.title != null ||
    nextOverride.year != null ||
    nextOverride.description != null ||
    nextOverride.externalUrl != null ||
    nextOverride.sourceName != null ||
    nextOverride.sourceRole != null ||
    nextOverride.coverPath != null

  if (hasAnyOverride) {
    db.prepare(
      `
        INSERT INTO metadata_overrides (
          series_id, title, year, description, cover_path, cover_mime,
          external_url, source_name, source_role,
          base_title, base_year, base_description, base_cover_path, base_cover_mime,
          base_cover_source, base_external_url, base_source_name, base_source_role,
          base_metadata_source, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(series_id) DO UPDATE SET
          title = excluded.title,
          year = excluded.year,
          description = excluded.description,
          cover_path = excluded.cover_path,
          cover_mime = excluded.cover_mime,
          external_url = excluded.external_url,
          source_name = excluded.source_name,
          source_role = excluded.source_role,
          updated_at = excluded.updated_at
      `,
    ).run(
      seriesId,
      nextOverride.title,
      nextOverride.year,
      nextOverride.description,
      nextOverride.coverPath,
      nextOverride.coverMime,
      nextOverride.externalUrl,
      nextOverride.sourceName,
      nextOverride.sourceRole,
      existingOverride?.base_title ?? series.title,
      existingOverride?.base_year ?? series.year,
      existingOverride?.base_description ?? series.description,
      existingOverride?.base_cover_path ?? series.cover_path,
      existingOverride?.base_cover_mime ?? series.cover_mime,
      existingOverride?.base_cover_source ?? series.cover_source,
      existingOverride?.base_external_url ?? series.external_url,
      existingOverride?.base_source_name ?? series.source_name,
      existingOverride?.base_source_role ?? series.source_role,
      existingOverride?.base_metadata_source ?? stripAdminOverrideSuffix(series.metadata_source),
      nowIso(),
    )
  } else {
    db.prepare(`DELETE FROM metadata_overrides WHERE series_id = ?`).run(seriesId)
  }

  const storedOverride = hasAnyOverride ? getMetadataOverride(db, seriesId) : undefined
  const effectiveTitle = normalizeOptionalOverrideText(storedOverride?.title) || series.title
  const presentation = applyMetadataOverrideToPresentation(mapSeriesRowToPresentation(series), storedOverride)
  persistSeriesPresentation(db, seriesId, effectiveTitle, cleanSeriesTitle(effectiveTitle), presentation)
}

export const clearMetadataOverride = async (
  db: Database,
  config: AppConfig,
  seriesId: string,
) => {
  const metadataOverride = getMetadataOverride(db, seriesId)
  const series = db
    .prepare(
      `
        SELECT id, source_folder_id, category, title, title_short, year, format, status,
               description, folder_path, cover_source, metadata_source, cover_path, cover_mime,
               banner_path, banner_mime, remote_provider, remote_id, external_url,
               source_name, source_role, genres_json, file_count, last_scan_at, tags_json,
               metadata_refreshed_at
        FROM series
        WHERE id = ?
      `,
    )
    .get(seriesId) as SeriesRow | undefined

  if (!series) {
    throw new Error('Series not found.')
  }

  if (metadataOverride) {
    const restoredPresentation = {
      ...mapSeriesRowToPresentation(series),
      year: metadataOverride.base_year ?? series.year,
      description: metadataOverride.base_description ?? series.description,
      coverPath: metadataOverride.base_cover_path ?? series.cover_path,
      coverMime: metadataOverride.base_cover_mime ?? series.cover_mime,
      coverSource: metadataOverride.base_cover_source || series.cover_source,
      metadataSource: metadataOverride.base_metadata_source || stripAdminOverrideSuffix(series.metadata_source),
      externalUrl: metadataOverride.base_external_url ?? series.external_url,
      sourceName: metadataOverride.base_source_name ?? series.source_name,
      sourceRole: metadataOverride.base_source_role ?? series.source_role,
    } satisfies SeriesPresentation

    persistSeriesPresentation(
      db,
      seriesId,
      metadataOverride.base_title || deriveSeriesTitleFromFolderPath(series.folder_path, series.title),
      cleanSeriesTitle(metadataOverride.base_title || deriveSeriesTitleFromFolderPath(series.folder_path, series.title)),
      restoredPresentation,
    )
  }

  db.prepare(`DELETE FROM metadata_overrides WHERE series_id = ?`).run(seriesId)
  await refreshSeriesMetadata(db, config, seriesId)
}

export const refreshSeriesMetadata = async (
  db: Database,
  config: AppConfig,
  seriesId: string,
  options?: { preferFolderTitle?: boolean },
) => {
  const series = db
    .prepare(
      `
        SELECT id, source_folder_id, category, title, title_short, year, format, status,
               description, folder_path, cover_source, metadata_source, cover_path, cover_mime,
               banner_path, banner_mime, remote_provider, remote_id, external_url,
               source_name, source_role, genres_json, file_count, last_scan_at, tags_json,
               metadata_refreshed_at
        FROM series
        WHERE id = ?
      `,
    )
    .get(seriesId) as SeriesRow | undefined

  if (!series) {
    throw new Error('Series not found.')
  }

  const entries = db
    .prepare(
      `
        SELECT id, file_path, relative_path, storage_file, format, details, title, label,
               chapter_number, season_number, episode_number, sort_order, size, mtime_ms
        FROM entries
        WHERE series_id = ?
        ORDER BY sort_order, label, title
      `,
    )
    .all(seriesId) as Array<
      Pick<
        EntryRow,
        | 'id'
        | 'file_path'
        | 'relative_path'
        | 'storage_file'
        | 'format'
        | 'details'
        | 'title'
        | 'label'
        | 'chapter_number'
        | 'season_number'
        | 'episode_number'
        | 'sort_order'
      > & { size: number; mtime_ms: number }
    >

  const preferredTitle = options?.preferFolderTitle
    ? deriveSeriesTitleFromFolderPath(series.folder_path, stripAdminOverrideSuffix(series.title))
    : stripAdminOverrideSuffix(series.title)
  const metadataOverride = getMetadataOverride(db, seriesId)
  const seriesSpec = buildSeriesSpecFromStoredSeries(series, entries, preferredTitle)
  const effectiveSeries = applyMetadataOverrideToSeriesSpec(seriesSpec, metadataOverride)
  const presentation = await resolveSeriesPresentation(
    seriesId,
    effectiveSeries,
    series,
    true,
    config.coversDirectory,
    undefined,
    undefined,
    db,
    metadataOverride,
    true,
  )

  persistSeriesPresentation(db, seriesId, effectiveSeries.title, effectiveSeries.titleShort, presentation)
}

export const searchSeries = (db: Database, query: string, scope: 'all' | CategoryId): SearchResponse => {
  const likeQuery = `%${query.toLowerCase()}%`
  const results = db
    .prepare(
      `
        SELECT DISTINCT s.id, s.source_folder_id, s.category, s.title, s.title_short, s.year,
               s.format, s.status, s.description, s.folder_path, s.cover_source,
               s.metadata_source, s.cover_path, s.cover_mime, s.banner_path, s.banner_mime,
               s.remote_provider, s.remote_id, s.external_url, s.source_name, s.source_role,
               s.genres_json, s.file_count, s.last_scan_at, s.tags_json, s.metadata_refreshed_at
        FROM series s
        LEFT JOIN entries e ON e.series_id = s.id
        WHERE (? = 'all' OR s.category = ?)
          AND (
            lower(s.title) LIKE ?
            OR lower(s.description) LIKE ?
            OR lower(s.folder_path) LIKE ?
            OR lower(e.title) LIKE ?
            OR lower(e.storage_file) LIKE ?
          )
        ORDER BY s.title COLLATE NOCASE
        LIMIT 12
      `,
    )
    .all(scope, scope, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery) as SeriesRow[]
  const groupedEntryCounts = getGroupedEntryCountsBySeries(db, results)

  return {
    results: results.map((series) => mapSeriesRowToSummary(series, groupedEntryCounts.get(series.id))),
  }
}

export const addComment = (
  db: Database,
  user: SessionUser,
  payload: CreateCommentPayload,
) => {
  const now = nowIso()
  db.prepare(
    `
      INSERT INTO comments (id, series_id, user_id, text, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(createId('comment'), payload.seriesId, user.id, payload.text.trim(), now)

  return getSeriesDetail(db, payload.seriesId)
}

export const saveBookmark = (
  db: Database,
  user: SessionUser,
  payload: {
    seriesId: string
    entryId: string
    entryIndex: number
    category: CategoryId
    progress: string
    cue: string
    position: SavedReadingPosition
  },
) => {
  const entry = db
    .prepare(
      `
        SELECT id, series_id
        FROM entries
        WHERE id = ?
      `,
    )
    .get(payload.entryId) as { id: string; series_id: string } | undefined

  if (!entry || entry.series_id !== payload.seriesId) {
    throw new Error('Bookmark target entry was not found.')
  }

  const now = nowIso()
  db.prepare(
    `
      INSERT INTO reading_positions (
        user_id, entry_id, page, total_pages, view_mode, location_type, progress_label, cue_label
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, entry_id) DO UPDATE SET
        page = excluded.page,
        total_pages = excluded.total_pages,
        view_mode = excluded.view_mode,
        location_type = excluded.location_type,
        progress_label = excluded.progress_label,
        cue_label = excluded.cue_label
    `,
  ).run(
    user.id,
    payload.entryId,
    payload.position.page,
    payload.position.totalPages ?? null,
    payload.position.viewMode ?? null,
    payload.position.locationType ?? null,
    payload.position.progressLabel ?? null,
    payload.position.cueLabel ?? null,
  )

  db.prepare(
    `
      INSERT INTO bookmarks (
        user_id, series_id, entry_id, entry_index, category, progress, cue, last_seen
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, series_id) DO UPDATE SET
        entry_id = excluded.entry_id,
        entry_index = excluded.entry_index,
        category = excluded.category,
        progress = excluded.progress,
        cue = excluded.cue,
        last_seen = excluded.last_seen
    `,
  ).run(
    user.id,
    payload.seriesId,
    payload.entryId,
    payload.entryIndex,
    payload.category,
    payload.progress,
    payload.cue,
    now,
  )

  return {
    bookmarks: getBookmarks(db, user.id),
    readingPositions: getReadingPositions(db, user.id),
  }
}

export const removeBookmark = (db: Database, user: SessionUser, seriesId: string) => {
  const normalizedSeriesId = seriesId.trim()

  if (!normalizedSeriesId) {
    throw new Error('Missing series id.')
  }

  db.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND series_id = ?`).run(user.id, normalizedSeriesId)

  return {
    bookmarks: getBookmarks(db, user.id),
    readingPositions: getReadingPositions(db, user.id),
  }
}

export const ensureConfiguredSourceRoot = (db: Database, config: AppConfig) => {
  const managedSourceRoot = config.managedSourceRoot

  if (!managedSourceRoot) {
    return
  }

  if (!fs.existsSync(managedSourceRoot.storagePath) || !fs.statSync(managedSourceRoot.storagePath).isDirectory()) {
    return
  }

  const existingRoot = db
    .prepare(`SELECT id FROM source_roots WHERE path = ? LIMIT 1`)
    .get(managedSourceRoot.storagePath) as { id: string } | undefined

  if (existingRoot) {
    return
  }

  db.prepare(
    `
      INSERT INTO source_roots (id, label, path, created_at)
      VALUES (?, ?, ?, ?)
    `,
  ).run(createId('root'), managedSourceRoot.label, managedSourceRoot.storagePath, nowIso())
}

export const createSourceRoot = (db: Database, config: AppConfig, payload: CreateRootPayload) => {
  const normalizedPath = resolveSourceRootPath(config, payload.path)

  if (!fs.existsSync(normalizedPath) || !fs.statSync(normalizedPath).isDirectory()) {
    if (isHostOnlyPath(payload.path)) {
      throw new Error(
        'That Windows or NAS path is not visible inside Docker yet. Mount it through MEDIA_HOST_DIR or compose.nas.yaml, then use the automatically available Library root.',
      )
    }

    throw new Error('Mounted root path does not exist or is not a directory.')
  }

  const existingRoot = db
    .prepare(`SELECT id FROM source_roots WHERE path = ? LIMIT 1`)
    .get(normalizedPath) as { id: string } | undefined

  if (existingRoot) {
    throw new Error(
      isManagedSourceRootPath(config, normalizedPath)
        ? 'That mounted root is already available from Docker.'
        : 'That mounted root already exists.',
    )
  }

  db.prepare(
    `
      INSERT INTO source_roots (id, label, path, created_at)
      VALUES (?, ?, ?, ?)
    `,
  ).run(createId('root'), payload.label.trim(), normalizedPath, nowIso())

  return getSourceRoots(db, config)
}

export const removeSourceRoot = (db: Database, config: AppConfig, rootId: string) => {
  const existingRoot = db
    .prepare(`SELECT id, path FROM source_roots WHERE id = ? LIMIT 1`)
    .get(rootId) as { id: string; path: string } | undefined

  if (!existingRoot) {
    throw new Error('Mounted root was not found.')
  }

  if (isManagedSourceRootPath(config, existingRoot.path)) {
    throw new Error('This mounted root comes from your Docker setup and cannot be removed here.')
  }

  db.prepare(`DELETE FROM source_roots WHERE id = ?`).run(rootId)
}

export const listDirectoriesForRoot = (
  db: Database,
  rootId: string,
  relativePath: string,
): DirectoryListing => {
  const root = db
    .prepare(`SELECT id, label, path FROM source_roots WHERE id = ? LIMIT 1`)
    .get(rootId) as SourceRootRow | undefined

  if (!root) {
    throw new Error('Mounted root not found.')
  }

  const directoryPath = joinInsideRoot(root.path, relativePath)

  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    return {
      currentPath: relativePath,
      directories: [],
    }
  }

  const directories = fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((directoryEntry) => directoryEntry.isDirectory() && !directoryEntry.name.startsWith('.'))
    .sort((left, right) => naturalCompare(left.name, right.name))
    .map((directoryEntry) => ({
      name: directoryEntry.name,
      relativePath: path
        .join(relativePath, directoryEntry.name)
        .replaceAll('\\', '/')
        .replace(/^\.\//, ''),
    }))

  return {
    currentPath: relativePath,
    directories,
  }
}

export const createSourceFolder = async (
  db: Database,
  config: AppConfig,
  payload: CreateSourcePayload,
) => {
  const category = parseCategoryId(payload.category)
  const root = db
    .prepare(`SELECT id, label, path FROM source_roots WHERE id = ? LIMIT 1`)
    .get(payload.rootId) as SourceRootRow | undefined

  if (!root) {
    throw new Error('Mounted root not found.')
  }

  const absolutePath = joinInsideRoot(root.path, payload.relativePath)

  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
    throw new Error('Selected source folder does not exist.')
  }

  const existingSource = db
    .prepare(`SELECT id FROM source_folders WHERE path = ? LIMIT 1`)
    .get(absolutePath) as { id: string } | undefined

  if (existingSource) {
    throw new Error('That source folder is already linked.')
  }

  const now = nowIso()
  const sourceId = createId('source')
  db.prepare(
    `
      INSERT INTO source_folders (
        id, root_id, category, relative_path, path, enabled, item_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
    `,
  ).run(sourceId, root.id, category, payload.relativePath, absolutePath, now, now)

  return {
    sourceId,
    sourceFolders: getSourceFolders(db, config),
  }
}

export const updateSourceFolderCategory = (
  db: Database,
  config: AppConfig,
  sourceId: string,
  payload: UpdateSourcePayload,
) => {
  const category = parseCategoryId(payload.category)
  const existingSource = db
    .prepare(`SELECT id, category FROM source_folders WHERE id = ? LIMIT 1`)
    .get(sourceId) as { id: string; category: CategoryId } | undefined

  if (!existingSource) {
    throw new Error('Linked folder was not found.')
  }

  if (existingSource.category !== category) {
    const now = nowIso()
    const updateCategory = db.transaction(() => {
      db.prepare(
        `
          UPDATE source_folders
          SET category = ?, last_scan_status = ?, updated_at = ?
          WHERE id = ?
        `,
      ).run(category, 'Needs rescan', now, sourceId)

      db.prepare(
        `
          UPDATE bookmarks
          SET category = ?
          WHERE series_id IN (
            SELECT id FROM series WHERE source_folder_id = ?
          )
        `,
      ).run(category, sourceId)

      db.prepare(
        `
          UPDATE series
          SET category = ?, status = ?, format = ?, updated_at = ?
          WHERE source_folder_id = ?
        `,
      ).run(category, categoryStatus[category], categoryFormat[category], now, sourceId)
    })

    updateCategory()
  }

  return {
    sourceFolders: getSourceFolders(db, config),
  }
}

export const removeSourceFolder = (db: Database, sourceId: string) => {
  const existingSource = db
    .prepare(`SELECT id FROM source_folders WHERE id = ? LIMIT 1`)
    .get(sourceId) as { id: string } | undefined

  if (!existingSource) {
    throw new Error('Linked folder was not found.')
  }

  db.prepare(`DELETE FROM source_folders WHERE id = ?`).run(sourceId)
}

const deleteSeriesNotInSet = (db: Database, sourceFolderId: string, keepSeriesIds: Set<string>) => {
  const existingSeries = db
    .prepare(`SELECT id FROM series WHERE source_folder_id = ?`)
    .all(sourceFolderId) as Array<{ id: string }>

  for (const series of existingSeries) {
    if (!keepSeriesIds.has(series.id)) {
      db.prepare(`DELETE FROM series WHERE id = ?`).run(series.id)
    }
  }
}

const upsertSeries = async (
  db: Database,
  config: AppConfig,
  sourceFolder: SourceFolderRow,
  series: SeriesSpec,
  existingSeriesByKey: Map<string, SeriesRow>,
  existingEntriesByPath: Map<string, { id: string; size: number; mtime_ms: number }>,
  reporter?: ScanReporter,
  scanRunId?: string,
) => {
  const now = nowIso()
  const existingSeries = existingSeriesByKey.get(series.key)
  const seriesId =
    existingSeries?.id ?? `${slugify(series.title)}-${hashString(series.key).slice(0, 8)}`
  const metadataOverride = getMetadataOverride(db, seriesId)
  const effectiveSeries = applyMetadataOverrideToSeriesSpec(series, metadataOverride)

  let seriesChanged = !existingSeries
  const seenEntryPaths = new Set<string>()
  let changedFiles = 0

  db.prepare(
    `
      INSERT INTO series (
        id, source_folder_id, series_key, category, title, title_short, year, format, status,
        description, folder_path, cover_path, cover_mime, banner_path, banner_mime,
        cover_source, metadata_source, remote_provider, remote_id, external_url,
        source_name, source_role, genres_json, tags_json, metadata_refreshed_at,
        file_count, last_scan_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(series_key) DO UPDATE SET
        source_folder_id = excluded.source_folder_id,
        category = excluded.category,
        title = excluded.title,
        title_short = excluded.title_short,
        year = excluded.year,
        format = excluded.format,
        status = excluded.status,
        description = excluded.description,
        folder_path = excluded.folder_path,
        banner_path = excluded.banner_path,
        banner_mime = excluded.banner_mime,
        remote_provider = excluded.remote_provider,
        remote_id = excluded.remote_id,
        external_url = excluded.external_url,
        source_name = excluded.source_name,
        source_role = excluded.source_role,
        genres_json = excluded.genres_json,
        tags_json = excluded.tags_json,
        metadata_refreshed_at = excluded.metadata_refreshed_at,
        file_count = excluded.file_count,
        last_scan_at = excluded.last_scan_at,
        updated_at = excluded.updated_at
    `,
  ).run(
    seriesId,
    sourceFolder.id,
    effectiveSeries.key,
    effectiveSeries.category,
    effectiveSeries.title,
    effectiveSeries.titleShort,
    effectiveSeries.year,
    effectiveSeries.format,
    effectiveSeries.status,
    effectiveSeries.description,
    effectiveSeries.folderPath,
    existingSeries?.cover_path ?? null,
    existingSeries?.cover_mime ?? null,
    existingSeries?.banner_path ?? null,
    existingSeries?.banner_mime ?? null,
    existingSeries?.cover_source ?? (existingSeries?.cover_path ? 'Cached local cover' : 'Pending cover generation'),
    existingSeries?.metadata_source ?? 'Folder-derived metadata',
    existingSeries?.remote_provider ?? null,
    existingSeries?.remote_id ?? null,
    existingSeries?.external_url ?? null,
    existingSeries?.source_name ?? null,
    existingSeries?.source_role ?? null,
    existingSeries?.genres_json ?? '[]',
    existingSeries?.tags_json ?? JSON.stringify(effectiveSeries.tags),
    existingSeries?.metadata_refreshed_at ?? null,
    effectiveSeries.entries.length,
    now,
    now,
    now,
  )

  for (const entry of effectiveSeries.entries) {
    const existingEntry = existingEntriesByPath.get(entry.file.path)
    const entryId = existingEntry?.id ?? `${slugify(effectiveSeries.title)}-${hashString(entry.file.path).slice(0, 10)}`
    const entryChanged =
      !existingEntry ||
      existingEntry.size !== entry.file.size ||
      existingEntry.mtime_ms !== entry.file.mtimeMs

    if (entryChanged) {
      seriesChanged = true
      changedFiles += 1
    }

    db.prepare(
      `
        INSERT INTO entries (
          id, series_id, source_folder_id, file_path, storage_file, relative_path, label, title,
          format, details, chapter_number, season_number, episode_number, sort_order, size,
          mtime_ms, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          series_id = excluded.series_id,
          source_folder_id = excluded.source_folder_id,
          storage_file = excluded.storage_file,
          relative_path = excluded.relative_path,
          label = excluded.label,
          title = excluded.title,
          format = excluded.format,
          details = excluded.details,
          chapter_number = excluded.chapter_number,
          season_number = excluded.season_number,
          episode_number = excluded.episode_number,
          sort_order = excluded.sort_order,
          size = excluded.size,
          mtime_ms = excluded.mtime_ms,
          updated_at = excluded.updated_at
      `,
    ).run(
      entryId,
      seriesId,
      sourceFolder.id,
      entry.file.path,
      entry.file.baseName,
      entry.file.relativePath,
      entry.entryLabel,
      entry.entryTitle,
      entry.format,
      entry.details,
      entry.chapterNumber,
      entry.seasonNumber,
      entry.episodeNumber,
      entry.sortOrder,
      entry.file.size,
      entry.file.mtimeMs,
      now,
      now,
    )

    seenEntryPaths.add(entry.file.path)
  }

  const existingSeriesEntries = db
    .prepare(`SELECT id, file_path FROM entries WHERE source_folder_id = ? AND series_id = ?`)
    .all(sourceFolder.id, seriesId) as Array<{ id: string; file_path: string }>

  for (const existingEntry of existingSeriesEntries) {
    if (!seenEntryPaths.has(existingEntry.file_path)) {
      db.prepare(`DELETE FROM entries WHERE id = ?`).run(existingEntry.id)
      seriesChanged = true
      changedFiles += 1
    }
  }

  const presentation = await resolveSeriesPresentation(
    seriesId,
    effectiveSeries,
    existingSeries,
    seriesChanged,
    config.coversDirectory,
    reporter,
    scanRunId,
    db,
    metadataOverride,
  )

  db.prepare(
    `
      INSERT INTO series (
        id, source_folder_id, series_key, category, title, title_short, year, format, status,
        description, folder_path, cover_path, cover_mime, banner_path, banner_mime,
        cover_source, metadata_source, remote_provider, remote_id, external_url,
        source_name, source_role, genres_json, tags_json, metadata_refreshed_at,
        file_count, last_scan_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(series_key) DO UPDATE SET
        source_folder_id = excluded.source_folder_id,
        category = excluded.category,
        title = excluded.title,
        title_short = excluded.title_short,
        year = excluded.year,
        format = excluded.format,
        status = excluded.status,
        description = excluded.description,
        folder_path = excluded.folder_path,
        cover_path = excluded.cover_path,
        cover_mime = excluded.cover_mime,
        banner_path = excluded.banner_path,
        banner_mime = excluded.banner_mime,
        cover_source = excluded.cover_source,
        metadata_source = excluded.metadata_source,
        remote_provider = excluded.remote_provider,
        remote_id = excluded.remote_id,
        external_url = excluded.external_url,
        source_name = excluded.source_name,
        source_role = excluded.source_role,
        genres_json = excluded.genres_json,
        tags_json = excluded.tags_json,
        metadata_refreshed_at = excluded.metadata_refreshed_at,
        file_count = excluded.file_count,
        last_scan_at = excluded.last_scan_at,
        updated_at = excluded.updated_at
    `,
  ).run(
    seriesId,
    sourceFolder.id,
    effectiveSeries.key,
    effectiveSeries.category,
    effectiveSeries.title,
    effectiveSeries.titleShort,
    presentation.year,
    effectiveSeries.format,
    effectiveSeries.status,
    presentation.description,
    effectiveSeries.folderPath,
    presentation.coverPath,
    presentation.coverMime,
    presentation.bannerPath,
    presentation.bannerMime,
    presentation.coverSource,
    presentation.metadataSource,
    presentation.remoteProvider,
    presentation.remoteId,
    presentation.externalUrl,
    presentation.sourceName,
    presentation.sourceRole,
    JSON.stringify(presentation.genres),
    JSON.stringify(presentation.tags),
    presentation.metadataRefreshedAt,
    effectiveSeries.entries.length,
    now,
    now,
    now,
  )

  return {
    seriesId,
    changedFiles,
  }
}

export const runScan = async (
  db: Database,
  config: AppConfig,
  sourceId?: string,
  reporter?: ScanReporter,
): Promise<ScanResult> => {
  const scanRunId = createId('scan')
  const startedAt = nowIso()
  db.prepare(
    `INSERT INTO scan_runs (id, started_at, status, changed_files, summary) VALUES (?, ?, 'running', 0, '')`,
  ).run(scanRunId, startedAt)

  try {
    const sourceFolders = db
      .prepare(
        `
          SELECT id, root_id, category, relative_path, path, item_count, last_scan_at, last_scan_status
          FROM source_folders
          WHERE enabled = 1
            ${sourceId ? 'AND id = ?' : ''}
          ORDER BY category, path
        `,
      )
      .all(...(sourceId ? [sourceId] : [])) as SourceFolderRow[]

    if (sourceId && sourceFolders.length === 0) {
      throw new Error('Linked folder was not found for scanning.')
    }

    reporter?.onRunStarted?.({
      runId: scanRunId,
      startedAt,
      totalSources: sourceFolders.length,
    })
    appendScanEvent(
      db,
      scanRunId,
      'info',
      `Starting scan of ${sourceFolders.length} linked ${sourceFolders.length === 1 ? 'folder' : 'folders'}`,
      reporter,
    )

    let changedFiles = 0
    const scannedSourceIds: string[] = []
    let completedSources = 0

    for (const sourceFolder of sourceFolders) {
      const sourceLabel = formatSourceLabelFromPath(sourceFolder.path)
      const sourceStartedAt = nowIso()

      db.prepare(
        `
          UPDATE source_folders
          SET last_scan_status = ?, updated_at = ?
          WHERE id = ?
        `,
      ).run('Scanning', sourceStartedAt, sourceFolder.id)

      reporter?.onProgress?.({
        runId: scanRunId,
        totalSources: sourceFolders.length,
        completedSources,
        currentSource: sourceLabel,
        currentSourceFilesDiscovered: null,
        currentSourceSeriesTotal: null,
        currentSourceSeriesCompleted: 0,
        currentSeries: null,
        summary: `Scanning ${sourceLabel}`,
      })
      appendScanEvent(
        db,
        scanRunId,
        'info',
        `Scanning ${sourceLabel}`,
        reporter,
      )

      const scanResult = scanDirectory(
        sourceFolder.path,
        supportedExtensionsByCategory[sourceFolder.category],
      )
      const { files } = scanResult
      const warningCount = scanResult.warnings.length

      for (const warning of scanResult.warnings.slice(0, 25)) {
        appendScanEvent(
          db,
          scanRunId,
          'error',
          `${warning.message} (${warning.path})`,
          reporter,
        )
      }

      if (warningCount > 25) {
        appendScanEvent(
          db,
          scanRunId,
          'error',
          `Skipped ${warningCount - 25} additional unreadable ${warningCount - 25 === 1 ? 'entry' : 'entries'} in ${sourceLabel}`,
          reporter,
        )
      }

      const groupedSeries = groupSeriesFromFiles(sourceFolder, files)
      reporter?.onProgress?.({
        runId: scanRunId,
        totalSources: sourceFolders.length,
        completedSources,
        currentSource: sourceLabel,
        currentSourceFilesDiscovered: files.length,
        currentSourceSeriesTotal: groupedSeries.length,
        currentSourceSeriesCompleted: 0,
        currentSeries: null,
        summary: `Discovered ${files.length} ${files.length === 1 ? 'file' : 'files'} in ${sourceLabel}`,
      })
      appendScanEvent(
        db,
        scanRunId,
        'info',
        `Queued ${sourceLabel}: ${files.length} ${files.length === 1 ? 'file' : 'files'} across ${groupedSeries.length} ${groupedSeries.length === 1 ? 'series' : 'series'}${warningCount > 0 ? `, ${warningCount} skipped` : ''}`,
        reporter,
      )
      const existingSeries = db
        .prepare(
          `
            SELECT id, source_folder_id, category, title, title_short, year, format, status,
                   description, folder_path, cover_source, metadata_source, cover_path, cover_mime,
                   banner_path, banner_mime, remote_provider, remote_id, external_url,
                   source_name, source_role, genres_json, file_count, last_scan_at, tags_json,
                   metadata_refreshed_at, series_key
            FROM series
            WHERE source_folder_id = ?
          `,
        )
        .all(sourceFolder.id) as Array<{
          series_key: string
        } & SeriesRow>
      const existingEntries = db
        .prepare(`SELECT id, file_path, size, mtime_ms FROM entries WHERE source_folder_id = ?`)
        .all(sourceFolder.id) as Array<{ id: string; file_path: string; size: number; mtime_ms: number }>

      const existingSeriesByKey = new Map(
        existingSeries.map((series) => [series.series_key, series]),
      )
      const existingEntriesByPath = new Map(
        existingEntries.map((entry) => [entry.file_path, entry]),
      )
      const keptSeriesIds = new Set<string>()
      let sourceChangedFiles = 0

      for (const [seriesIndex, series] of groupedSeries.entries()) {
        const seriesCompletedBeforeCurrent = seriesIndex
        reporter?.onProgress?.({
          runId: scanRunId,
          totalSources: sourceFolders.length,
          completedSources,
          currentSource: sourceLabel,
          currentSourceFilesDiscovered: files.length,
          currentSourceSeriesTotal: groupedSeries.length,
          currentSourceSeriesCompleted: seriesCompletedBeforeCurrent,
          currentSeries: series.title,
          summary: buildScanProgressSummary(
            sourceLabel,
            seriesCompletedBeforeCurrent,
            groupedSeries.length,
            files.length,
            series.title,
          ),
        })
        const upsertResult = await upsertSeries(
          db,
          config,
          sourceFolder,
          series,
          existingSeriesByKey,
          existingEntriesByPath,
          reporter,
          scanRunId,
        )
        keptSeriesIds.add(upsertResult.seriesId)
        changedFiles += upsertResult.changedFiles
        sourceChangedFiles += upsertResult.changedFiles
        const completedSeries = seriesIndex + 1
        reporter?.onProgress?.({
          runId: scanRunId,
          totalSources: sourceFolders.length,
          completedSources,
          currentSource: sourceLabel,
          currentSourceFilesDiscovered: files.length,
          currentSourceSeriesTotal: groupedSeries.length,
          currentSourceSeriesCompleted: completedSeries,
          currentSeries: completedSeries < groupedSeries.length ? series.title : null,
          summary: buildScanProgressSummary(
            sourceLabel,
            completedSeries,
            groupedSeries.length,
            files.length,
            completedSeries < groupedSeries.length ? series.title : null,
          ),
        })
        if (shouldEmitSeriesCheckpoint(completedSeries, groupedSeries.length)) {
          appendScanEvent(
            db,
            scanRunId,
            'info',
            `Indexed ${sourceLabel}: ${completedSeries}/${groupedSeries.length} series${series.title ? ` • ${series.title}` : ''}`,
            reporter,
          )
        }
        await yieldToEventLoop()
      }

      deleteSeriesNotInSet(db, sourceFolder.id, keptSeriesIds)

      db.prepare(
        `
          UPDATE source_folders
          SET item_count = ?, last_scan_at = ?, last_scan_status = ?, updated_at = ?
          WHERE id = ?
        `,
      ).run(groupedSeries.length, nowIso(), 'Ready', nowIso(), sourceFolder.id)

      scannedSourceIds.push(sourceFolder.id)
      completedSources += 1
      reporter?.onProgress?.({
        runId: scanRunId,
        totalSources: sourceFolders.length,
        completedSources,
        currentSource: null,
        currentSourceFilesDiscovered: files.length,
        currentSourceSeriesTotal: groupedSeries.length,
        currentSourceSeriesCompleted: groupedSeries.length,
        currentSeries: null,
        summary: `Finished ${sourceLabel}`,
      })
      appendScanEvent(
        db,
        scanRunId,
        'success',
        `Finished ${sourceLabel}: ${groupedSeries.length} series, ${files.length} files, ${sourceChangedFiles} changes`,
        reporter,
      )
      await yieldToEventLoop()
    }

    const finishedAt = nowIso()
    const successSummary = `${scannedSourceIds.length} source folder${scannedSourceIds.length === 1 ? '' : 's'} scanned`
    db.prepare(
      `
        UPDATE scan_runs
        SET finished_at = ?, status = 'success', changed_files = ?, summary = ?
        WHERE id = ?
      `,
    ).run(finishedAt, changedFiles, successSummary, scanRunId)
    appendScanEvent(
      db,
      scanRunId,
      'success',
      `${successSummary} with ${changedFiles} changed ${changedFiles === 1 ? 'file' : 'files'}`,
      reporter,
    )
    reporter?.onRunFinished?.({
      runId: scanRunId,
      finishedAt,
      summary: successSummary,
      success: true,
    })

    return {
      scanRunId,
      changedFiles,
      scannedSourceIds,
    }
  } catch (error) {
    const finishedAt = nowIso()
    const errorMessage = error instanceof Error ? error.message : 'Unknown scan error'
    appendScanEvent(
      db,
      scanRunId,
      'error',
      errorMessage,
      reporter,
    )
    db.prepare(
      `
        UPDATE scan_runs
        SET finished_at = ?, status = 'error', summary = ?
        WHERE id = ?
      `,
    ).run(finishedAt, errorMessage, scanRunId)
    reporter?.onRunFinished?.({
      runId: scanRunId,
      finishedAt,
      summary: errorMessage,
      success: false,
    })
    throw error
  }
}

export const resetUserPassword = async (
  db: Database,
  userId: string,
  password: string,
) => {
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters long.')
  }

  const now = nowIso()
  const passwordHash = await bcrypt.hash(password, 10)
  const result = db.prepare(
    `
      UPDATE users
      SET password_hash = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(passwordHash, now, userId)

  if (result.changes !== 1) {
    throw new Error('User account not found.')
  }

  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId)
}

export const changeUserPassword = async (
  db: Database,
  userId: string,
  currentPassword: string,
  nextPassword: string,
  currentSessionId?: string | null,
) => {
  if (nextPassword.length < 6) {
    throw new Error('Password must be at least 6 characters long.')
  }

  const user = db
    .prepare(
      `
        SELECT id, password_hash
        FROM users
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(userId) as Pick<UserRow, 'id' | 'password_hash'> | undefined

  if (!user) {
    throw new Error('User account not found.')
  }

  const passwordMatches = await bcrypt.compare(currentPassword, user.password_hash)

  if (!passwordMatches) {
    throw new Error('Current password is incorrect.')
  }

  const now = nowIso()
  const passwordHash = await bcrypt.hash(nextPassword, 10)

  db.prepare(
    `
      UPDATE users
      SET password_hash = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(passwordHash, now, userId)

  if (currentSessionId) {
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ?`).run(userId, currentSessionId)
  } else {
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId)
  }
}

const convertSrtToVtt = (input: string) => {
  const normalized = input.replace(/\r/g, '').trim()
  const converted = normalized.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
    (fullMatch: string) => fullMatch.replace(',', '.'),
  )

  return `WEBVTT\n\n${convertedSrtBlockSpacing(converted)}`
}

const convertedSrtBlockSpacing = (input: string) => input.replace(/\n{3,}/g, '\n\n')

const splitAssDialogue = (value: string, expectedParts: number) => {
  const parts: string[] = []
  let remaining = value

  for (let index = 0; index < expectedParts - 1; index += 1) {
    const commaIndex = remaining.indexOf(',')

    if (commaIndex === -1) {
      parts.push(remaining)
      remaining = ''
      break
    }

    parts.push(remaining.slice(0, commaIndex))
    remaining = remaining.slice(commaIndex + 1)
  }

  parts.push(remaining)
  return parts.map((part) => part.trim())
}

const convertAssTimestampToVtt = (value: string) => {
  const match = value.trim().match(/^(?<hours>\d+):(?<minutes>\d{2}):(?<seconds>\d{2})[.](?<centiseconds>\d{2})$/)

  if (!match?.groups) {
    return '00:00:00.000'
  }

  const hours = String(Number(match.groups.hours)).padStart(2, '0')
  const minutes = match.groups.minutes
  const seconds = match.groups.seconds
  const milliseconds = String(Number(match.groups.centiseconds) * 10).padStart(3, '0')

  return `${hours}:${minutes}:${seconds}.${milliseconds}`
}

const stripAssFormatting = (value: string) =>
  value
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .trim()

const convertAssToVtt = (input: string) => {
  const lines = input.replace(/\r/g, '').split('\n')
  let inEventsSection = false
  let formatColumns: string[] = []
  const cues: string[] = []

  for (const line of lines) {
    if (/^\[events\]/i.test(line)) {
      inEventsSection = true
      continue
    }

    if (!inEventsSection) {
      continue
    }

    if (/^format:/i.test(line)) {
      formatColumns = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((column) => column.trim().toLowerCase())
      continue
    }

    if (!/^dialogue:/i.test(line) || formatColumns.length === 0) {
      continue
    }

    const values = splitAssDialogue(line.slice(line.indexOf(':') + 1).trim(), formatColumns.length)
    const startIndex = formatColumns.indexOf('start')
    const endIndex = formatColumns.indexOf('end')
    const textIndex = formatColumns.indexOf('text')

    if (startIndex === -1 || endIndex === -1 || textIndex === -1) {
      continue
    }

    const cueText = stripAssFormatting(values[textIndex] || '')
    if (!cueText) {
      continue
    }

    cues.push(
      `${convertAssTimestampToVtt(values[startIndex] || '')} --> ${convertAssTimestampToVtt(values[endIndex] || '')}\n${cueText}`,
    )
  }

  return `WEBVTT\n\n${cues.join('\n\n')}`.trim()
}

export const resolveEntryTrack = (
  db: Database,
  entryId: string,
  kind: MediaTrackKind,
  trackId: string,
) => resolveMediaTrackForEntry(db, entryId, kind, trackId)

export const getEntrySidecarMediaTracks = (
  db: Database,
  entryId: string,
) => {
  const entry = db
    .prepare(`SELECT id, file_path, format FROM entries WHERE id = ? LIMIT 1`)
    .get(entryId) as { id: string; file_path: string; format: EntryFormat } | undefined

  if (!entry) {
    throw new Error('Requested media file was not found.')
  }

  return getMediaTracksForEntry(entry.id, entry.format, entry.file_path)
}

export const renderSubtitleTrackForBrowser = async (
  db: Database,
  entryId: string,
  trackId: string,
) => {
  const track = resolveMediaTrackForEntry(db, entryId, 'subtitle', trackId)
  const input = await fsPromises.readFile(track.filePath, 'utf8')
  const extension = path.extname(track.filePath).toLowerCase()

  if (extension === '.vtt') {
    return input.startsWith('WEBVTT') ? input : `WEBVTT\n\n${input.trim()}`
  }

  if (extension === '.srt') {
    return convertSrtToVtt(input)
  }

  return convertAssToVtt(input)
}

export const resolveEntryFilePath = (db: Database, entryId: string) => {
  return resolveEntryMediaFile(db, entryId).filePath
}

export const resolveEntryMediaFile = (db: Database, entryId: string) => {
  const entry = db
    .prepare(`SELECT id, file_path, format, size, mtime_ms FROM entries WHERE id = ? LIMIT 1`)
    .get(entryId) as
    | {
        id: string
        file_path: string
        format: EntryFormat
        size: number
        mtime_ms: number
      }
    | undefined

  if (!entry || !fileExists(entry.file_path)) {
    throw new Error('Requested media file was not found.')
  }

  return {
    entryId: entry.id,
    filePath: entry.file_path,
    format: entry.format,
    size: entry.size,
    mtimeMs: entry.mtime_ms,
  }
}

export const resolveSeriesCoverPath = (db: Database, seriesId: string) => {
  const series = db
    .prepare(`SELECT id, cover_path, cover_mime FROM series WHERE id = ? LIMIT 1`)
    .get(seriesId) as { id: string; cover_path: string | null; cover_mime: string | null } | undefined

  if (!series || !fileExists(series.cover_path)) {
    throw new Error('Requested cover was not found.')
  }

  return {
    filePath: series.cover_path as string,
    mimeType: series.cover_mime || mime.lookup(series.cover_path as string) || 'application/octet-stream',
  }
}

export const resolveSeriesBannerPath = (db: Database, seriesId: string) => {
  const series = db
    .prepare(`SELECT id, banner_path, banner_mime FROM series WHERE id = ? LIMIT 1`)
    .get(seriesId) as { id: string; banner_path: string | null; banner_mime: string | null } | undefined

  if (!series || !fileExists(series.banner_path)) {
    throw new Error('Requested banner was not found.')
  }

  return {
    filePath: series.banner_path as string,
    mimeType: series.banner_mime || mime.lookup(series.banner_path as string) || 'application/octet-stream',
  }
}

export const maybeSeedDemoContent = async (db: Database, config: AppConfig) => {
  if (!config.enableDemoSeed) {
    return
  }

  if (!fileExists(config.demoFilesRoot)) {
    return
  }

  const potentialSources: Array<{ category: CategoryId; relativePath: string }> = [
    { category: 'anime', relativePath: 'anime' },
    { category: 'manga', relativePath: 'manga' },
    { category: 'novels', relativePath: 'novels' },
    { category: 'books', relativePath: 'books' },
    { category: 'magazines', relativePath: 'magazines' },
  ]

  const existingRoot = db
    .prepare(`SELECT id, path FROM source_roots WHERE path = ? LIMIT 1`)
    .get(config.demoFilesRoot) as { id: string; path: string } | undefined

  const existingRootCount = db.prepare(`SELECT COUNT(*) AS count FROM source_roots`).get() as {
    count: number
  }
  const existingSourceCount = db.prepare(`SELECT COUNT(*) AS count FROM source_folders`).get() as {
    count: number
  }
  const existingSeriesCount = db.prepare(`SELECT COUNT(*) AS count FROM series`).get() as {
    count: number
  }
  const existingScanCount = db.prepare(`SELECT COUNT(*) AS count FROM scan_runs`).get() as {
    count: number
  }
  const hasExistingLibrarySetup =
    existingRootCount.count > 0 ||
    existingSourceCount.count > 0 ||
    existingSeriesCount.count > 0 ||
    existingScanCount.count > 0

  if (existingRoot) {
    return
  }

  if (hasExistingLibrarySetup) {
    return
  }

  const rootId = existingRoot?.id ?? createId('root')

  if (!existingRoot) {
    db.prepare(
      `
        INSERT INTO source_roots (id, label, path, created_at)
        VALUES (?, ?, ?, ?)
      `,
    ).run(rootId, 'Demo files', config.demoFilesRoot, nowIso())
  }

  const existingSourcePaths = new Set(
    (
      db.prepare(`SELECT path FROM source_folders WHERE root_id = ?`)
        .all(rootId) as Array<{ path: string }>
    ).map((row) => row.path),
  )
  let addedSource = false

  for (const potentialSource of potentialSources) {
    const absolutePath = path.join(config.demoFilesRoot, potentialSource.relativePath)

    if (!fileExists(absolutePath)) {
      continue
    }

     if (existingSourcePaths.has(absolutePath)) {
      continue
    }

    db.prepare(
      `
        INSERT INTO source_folders (
          id, root_id, category, relative_path, path, enabled, item_count, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
      `,
    ).run(
      createId('source'),
      rootId,
      potentialSource.category,
      potentialSource.relativePath,
      absolutePath,
      nowIso(),
      nowIso(),
    )
    addedSource = true
  }

  const libraryCount = db.prepare(`SELECT COUNT(*) AS count FROM series`).get() as { count: number }
  const successfulScan = db
    .prepare(`SELECT id FROM scan_runs WHERE status = 'success' LIMIT 1`)
    .get() as { id: string } | undefined

  if (addedSource || libraryCount.count === 0 || !successfulScan) {
    await runScan(db, config)
  }
}
