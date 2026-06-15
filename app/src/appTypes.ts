export const categoryOrder = ['anime', 'manga', 'novels', 'books', 'magazines'] as const

export type CategoryId = (typeof categoryOrder)[number]
export type Language = 'en' | 'de'
export type ViewId = 'bookmarks' | 'library' | 'search' | 'downloads' | 'series' | 'reader' | 'creator' | 'profile' | 'admin'
export type SeriesTabId = 'overview' | 'entries' | 'comments'
export type ScopeId = 'all' | CategoryId
export type Role = 'admin' | 'member'
export type EntryFormat = 'video' | 'cbz' | 'epub' | 'pdf' | 'md' | 'html' | 'txt'
export type ReaderViewMode = 'single' | 'spread'
export type ReaderLocationType = 'page' | 'percent'
export type MediaTrackKind = 'audio' | 'subtitle'

export type MediaTrackOption = {
  id: string
  kind: MediaTrackKind
  label: string
  fileName: string
  format: string
  url: string
  supported: boolean
  note?: string
}

export type MediaTrackCollection = {
  audio: MediaTrackOption[]
  subtitles: MediaTrackOption[]
}

export type ReaderProgress = {
  page: number
  endPage?: number
  totalPages: number
  viewMode?: ReaderViewMode
  locationType?: ReaderLocationType
  progressLabel?: string
  cueLabel?: string
}

export type SavedReadingPosition = {
  page: number
  totalPages?: number
  viewMode?: ReaderViewMode
  locationType?: ReaderLocationType
  progressLabel?: string
  cueLabel?: string
}

export type SessionUser = {
  id: string
  username: string
  role: Role
}

export type ScanSummary = {
  lastScanAt: string | null
  changedFiles: number
  sourceRootCount: number
  sourceFolderCount: number
}

export type ScanLogEntry = {
  id: string
  level: 'info' | 'success' | 'error'
  message: string
  createdAt: string
}

export type ScanStatus = {
  active: boolean
  runId: string | null
  startedAt: string | null
  finishedAt: string | null
  totalSources: number
  completedSources: number
  currentSource: string | null
  currentSourceFilesDiscovered: number | null
  currentSourceSeriesTotal: number | null
  currentSourceSeriesCompleted: number
  currentSeries: string | null
  summary: string | null
  events: ScanLogEntry[]
}

export type LibraryStats = {
  fileCount: number
  lastScanAt: string | null
}

export type SeriesSummary = {
  id: string
  title: string
  titleShort: string
  category: CategoryId
  year: number | null
  format: string
  status: string
  progressLabel: string
  description: string
  folder: string
  coverUrl: string | null
  bannerUrl: string | null
  coverSource: string
  metadataSource: string
  externalUrl: string | null
  sourceName: string | null
  sourceRole: string | null
  genres: string[]
  tags: string[]
  stats: LibraryStats
}

export type LibraryEntry = {
  id: string
  label: string
  title: string
  details: string
  chapterNumber: number | null
  seasonNumber: number | null
  episodeNumber: number | null
  preferredVariantId: string
  variants: EntryVariant[]
}

export type EntryVariant = {
  id: string
  variantLabel: string
  storageFile: string
  format: EntryFormat
  details: string
  fileUrl: string
  downloadUrl: string
  mediaTracks: MediaTrackCollection
}

export type OfflineDownloadTarget =
  | {
      type: 'entry'
      entryId: string
    }
  | {
      type: 'series'
      seriesId: string
    }

export type OfflineResourceKind = 'cbz-page' | 'file' | 'cover' | 'banner'

export type OfflineDownloadResource = {
  key: string
  kind: OfflineResourceKind
  entryId?: string
  seriesId?: string
  pageNumber?: number
  label: string
  url: string
  onlineUrl: string
  contentType: string
  size: number
  version: string
  required: boolean
}

export type OfflineManifestEntry = {
  entryId: string
  label: string
  title: string
  format: EntryFormat
  version: string
  pageCount: number | null
  resourceKeys: string[]
}

export type OfflineDownloadManifest = {
  protocolVersion: 1
  manifestId: string
  serverInstanceId: string
  ownerUserId: string
  ownerUsername: string
  target: OfflineDownloadTarget
  contentKey: string
  title: string
  seriesTitle: string
  subtitle: string
  category: CategoryId
  createdAt: string
  estimatedBytes: number
  resourceCount: number
  entryCount: number
  entries: OfflineManifestEntry[]
  resources: OfflineDownloadResource[]
}

export type OfflineDownloadEstimate = {
  target: OfflineDownloadTarget
  title: string
  subtitle: string
  category: CategoryId
  estimatedBytes: number
  resourceCount: number
  entryCount: number
}

export type OfflineCapabilities = {
  protocolVersion: 1
  serverInstanceId: string
  appName: string
  supports: {
    cbzPages: boolean
    wholeFiles: boolean
    seriesPackages: boolean
    rangeRequests: boolean
  }
}

export type OfflineDownloadStatus =
  | 'queued'
  | 'downloading'
  | 'ready'
  | 'partial'
  | 'failed'
  | 'stale'
  | 'deleting'

export type OfflineDownloadRecord = {
  id: string
  manifest: OfflineDownloadManifest
  ownerUserId: string
  ownerUsername: string
  status: OfflineDownloadStatus
  createdAt: string
  updatedAt: string
  completedAt: string | null
  downloadedBytes: number
  verifiedBytes: number
  resourceCount: number
  downloadedResourceCount: number
  failureReason: string | null
}

export type OfflineStorageSummary = {
  downloadedBytes: number
  verifiedBytes: number
  downloadCount: number
  readyCount: number
  partialCount: number
  browserUsageBytes: number | null
  browserQuotaBytes: number | null
  persistent: boolean | null
}

export type SeriesComment = {
  id: string
  user: string
  when: string
  text: string
}

export type SeriesDetail = SeriesSummary & {
  entries: LibraryEntry[]
  comments: SeriesComment[]
}

export type Bookmark = {
  seriesId: string
  category: CategoryId
  entryId: string
  entryIndex: number
  entryLabel: string
  entryTitle: string
  progress: string
  cue: string
  lastSeen: string
}

export type SourceRoot = {
  id: string
  label: string
  path: string
  note: string
  managed: boolean
}

export type SourceFolder = {
  id: string
  category: CategoryId
  path: string
  relativePath: string
  items: string
  status: string
  lastScanAt: string | null
}

export type UserSummary = {
  id: string
  name: string
  role: string
  status: string
}

export type MetadataQueueItem = {
  id: string
  category: CategoryId
  title: string
  coverUrl: string | null
  coverSource: string
  metadataSource: string
  sourceName: string | null
  summary: string
  status: string
  reason: string
}

export type AppState = {
  appName: string
  bootstrapAdmin: string
  openSignup: boolean
  user: SessionUser | null
  csrfToken: string | null
  scanSummary: ScanSummary
  scanStatus: ScanStatus
  library: SeriesSummary[]
  bookmarks: Bookmark[]
  readingPositions: Record<string, SavedReadingPosition>
  sourceRoots: SourceRoot[]
  sourceFolders: SourceFolder[]
  users: UserSummary[]
  metadataQueue: MetadataQueueItem[]
}

export type BootstrapState = {
  appName: string
  bootstrapAdmin: string
  openSignup: boolean
  user: SessionUser | null
  csrfToken: string | null
}

export type AuthPayload = {
  username: string
  password: string
}

export type CreateRootPayload = {
  label: string
  path: string
}

export type CreateSourcePayload = {
  rootId: string
  relativePath: string
  category: CategoryId
}

export type UpdateSourcePayload = {
  category: CategoryId
}

export type ResetPasswordPayload = {
  password: string
}

export type ChangePasswordPayload = {
  currentPassword: string
  newPassword: string
}

export type MetadataOverridePayload = {
  title?: string | null
  year?: number | null
  description?: string | null
  externalUrl?: string | null
  sourceName?: string | null
  sourceRole?: string | null
  coverImageUrl?: string | null
  clearCover?: boolean
}

export type CreateCommentPayload = {
  seriesId: string
  text: string
}

export type SetBookmarkPayload = {
  seriesId: string
  entryId: string
  entryIndex: number
  category: CategoryId
  progress: string
  cue: string
  position: SavedReadingPosition
}

export type DirectoryListing = {
  currentPath: string
  directories: Array<{
    name: string
    relativePath: string
  }>
}

export type SearchResponse = {
  results: SeriesSummary[]
}

export type SeriesResponse = {
  series: SeriesDetail
}

export type ScanStatusResponse = {
  scanStatus: ScanStatus
}

export type MediaTracksResponse = {
  mediaTracks: MediaTrackCollection
}
