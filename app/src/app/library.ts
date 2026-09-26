import type {
  AppState,
  Bookmark,
  CategoryId,
  SavedReadingPosition,
  ScanStatus,
  ScanSummary,
  SeriesSummary,
} from '../appTypes'
import { sortBookmarksByRecency } from '../bookmarkOrdering'
import { cacheDelete, cacheGet, cacheSet } from './cache'
import { createStore } from './store'

export type LibraryState = {
  ownerId: string | null
  library: SeriesSummary[]
  revision: string | null
  bookmarks: Bookmark[]
  readingPositions: Record<string, SavedReadingPosition>
  scanSummary: ScanSummary
  scanStatus: ScanStatus
  sourceRoots: AppState['sourceRoots']
  sourceFolders: AppState['sourceFolders']
  users: AppState['users']
  metadataQueue: AppState['metadataQueue']
  /** True once cached or live data has been applied. */
  loaded: boolean
  /** When the library was last confirmed with the server (ms). */
  syncedAt: number | null
}

export const emptyScanSummary: ScanSummary = {
  lastScanAt: null,
  changedFiles: 0,
  discoveredFiles: 0,
  parsedFiles: 0,
  reusedFiles: 0,
  unchangedFiles: 0,
  newFiles: 0,
  deletedFiles: 0,
  movedFiles: 0,
  processedSeries: 0,
  sourceRootCount: 0,
  sourceFolderCount: 0,
}

export const emptyScanStatus: ScanStatus = {
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

const emptyLibraryState = (ownerId: string | null = null): LibraryState => ({
  ownerId,
  library: [],
  revision: null,
  bookmarks: [],
  readingPositions: {},
  scanSummary: emptyScanSummary,
  scanStatus: emptyScanStatus,
  sourceRoots: [],
  sourceFolders: [],
  users: [],
  metadataQueue: [],
  loaded: false,
  syncedAt: null,
})

export const libraryStore = createStore<LibraryState>(emptyLibraryState())

export const resetLibrary = (ownerId: string | null = null) => {
  libraryStore.set(emptyLibraryState(ownerId))
}

/* -------------------------------------------------------------- caching -- */

const cacheVersion = 3
const libraryCacheKey = (userId: string) => `library:${userId}`
const readingCacheKey = (userId: string) => `reading:${userId}`

type CachedLibrary = {
  version: number
  revision: string | null
  library: SeriesSummary[]
  scanSummary: ScanSummary
  syncedAt: number | null
}

type CachedReading = {
  version: number
  bookmarks: Bookmark[]
  readingPositions: Record<string, SavedReadingPosition>
}

export const restoreLibraryCache = async (userId: string) => {
  const [cachedLibrary, cachedReading] = await Promise.all([
    cacheGet<CachedLibrary>(libraryCacheKey(userId)),
    cacheGet<CachedReading>(readingCacheKey(userId)),
  ])

  const library = cachedLibrary?.version === cacheVersion ? cachedLibrary : null
  const reading = cachedReading?.version === cacheVersion ? cachedReading : null

  if (!library && !reading) {
    return false
  }

  libraryStore.set((previous) => ({
    ...(previous.ownerId === userId ? previous : emptyLibraryState(userId)),
    ownerId: userId,
    library: library?.library ?? [],
    revision: library?.revision ?? null,
    scanSummary: library?.scanSummary ?? emptyScanSummary,
    syncedAt: library?.syncedAt ?? null,
    bookmarks: reading?.bookmarks ?? [],
    readingPositions: reading?.readingPositions ?? {},
    loaded: true,
  }))

  return true
}

let readingWriteTimer: ReturnType<typeof setTimeout> | null = null

export const persistReadingCache = (immediate = false) => {
  const write = () => {
    readingWriteTimer = null
    const state = libraryStore.get()

    if (!state.ownerId) {
      return
    }

    void cacheSet(readingCacheKey(state.ownerId), {
      version: cacheVersion,
      bookmarks: state.bookmarks,
      readingPositions: state.readingPositions,
    } satisfies CachedReading)
  }

  if (readingWriteTimer) {
    clearTimeout(readingWriteTimer)
  }

  if (immediate) {
    write()
    return
  }

  readingWriteTimer = setTimeout(write, 1500)
}

const persistLibraryCache = (state: LibraryState) => {
  if (!state.ownerId) {
    return
  }

  void cacheSet(libraryCacheKey(state.ownerId), {
    version: cacheVersion,
    revision: state.revision,
    library: state.library,
    scanSummary: state.scanSummary,
    syncedAt: state.syncedAt,
  } satisfies CachedLibrary)
}

export const clearLibraryCache = async (userId: string) => {
  await Promise.all([cacheDelete(libraryCacheKey(userId)), cacheDelete(readingCacheKey(userId))])
}

/* ------------------------------------------------------- applying state -- */

export type ReadingOverlay = {
  bookmarks: Bookmark[]
  positions: Record<string, SavedReadingPosition>
}

/**
 * Applies a server state response. Reading progress that has not reached the
 * server yet (`overlay`) wins over the server copy.
 */
export const applyServerState = (state: AppState, overlay: ReadingOverlay) => {
  if (!state.user) {
    return
  }

  const userId = state.user.id
  const previous = libraryStore.get()
  const sameOwner = previous.ownerId === userId
  const libraryChanged = !(state.libraryUnchanged && sameOwner)
  const overlayBySeries = new Map(overlay.bookmarks.map((bookmark) => [bookmark.seriesId, bookmark]))
  const bookmarks = sortBookmarksByRecency([
    ...state.bookmarks.filter((bookmark) => !overlayBySeries.has(bookmark.seriesId)),
    ...overlay.bookmarks,
  ])

  const next: LibraryState = {
    ownerId: userId,
    library: libraryChanged ? state.library : previous.library,
    revision: state.libraryRevision ?? (libraryChanged ? null : previous.revision),
    bookmarks,
    readingPositions: { ...state.readingPositions, ...overlay.positions },
    scanSummary: state.scanSummary,
    scanStatus: state.scanStatus,
    sourceRoots: state.sourceRoots,
    sourceFolders: state.sourceFolders,
    users: state.users,
    metadataQueue: state.metadataQueue,
    loaded: true,
    syncedAt: Date.now(),
  }

  libraryStore.set(next)

  if (libraryChanged || !sameOwner || previous.scanSummary.lastScanAt !== next.scanSummary.lastScanAt) {
    persistLibraryCache(next)
  }

  persistReadingCache()
}

export const setScanStatus = (scanStatus: ScanStatus) => {
  libraryStore.update({ scanStatus })
}

/* ------------------------------------------------------------ selectors -- */

let indexedLibrary: SeriesSummary[] | null = null
let seriesIndex = new Map<string, SeriesSummary>()

/** Series by id; rebuilt only when the library array changes. */
export const getSeriesIndex = (library: SeriesSummary[]) => {
  if (indexedLibrary !== library) {
    indexedLibrary = library
    seriesIndex = new Map(library.map((series) => [series.id, series]))
  }

  return seriesIndex
}

export const readerCategories = ['books', 'manga', 'novels', 'magazines'] as const satisfies readonly CategoryId[]

export const isReaderCategory = (category: CategoryId) =>
  (readerCategories as readonly CategoryId[]).includes(category)

let countedLibrary: SeriesSummary[] | null = null
let categoryCounts: Record<CategoryId, number> = { anime: 0, manga: 0, novels: 0, books: 0, magazines: 0 }

export const getCategoryCounts = (library: SeriesSummary[]) => {
  if (countedLibrary !== library) {
    countedLibrary = library
    categoryCounts = { anime: 0, manga: 0, novels: 0, books: 0, magazines: 0 }
    library.forEach((series) => {
      categoryCounts[series.category] += 1
    })
  }

  return categoryCounts
}
