import {
  Component,
  startTransition,
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type FocusEvent,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
} from 'react'
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Check,
  ChevronRight,
  Compass,
  Download,
  FolderOpen,
  HardDrive,
  KeyRound,
  Languages,
  LayoutGrid,
  Library as LibraryIcon,
  List as ListIcon,
  LogOut,
  MoreVertical,
  Pause,
  Play,
  RefreshCw,
  Search as SearchIcon,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react'
import './App.css'
import { ApiError, api, normalizeAppState, normalizeSeriesDetail } from './api'
import { AuthenticatedResourceImage } from './AuthenticatedResourceImage'
import type {
  AppState,
  Bookmark,
  BootstrapState,
  CategoryId,
  EntryFormat,
  EntryVariant,
  Language,
  LibraryEntry,
  OfflineDownloadManifest,
  OfflineDownloadRecord,
  OfflineDownloadTarget,
  OfflineStorageSummary,
  ReaderProgress,
  ReaderSettings,
  SavedReadingPosition,
  ScanLogEntry,
  ScanStatus,
  SessionUser,
  ScopeId,
  SeriesDetail,
  SeriesSummary,
  SeriesTabId,
  ViewId,
} from './appTypes'
import { categoryOrder } from './appTypes'
import {
  selectNewerBookmarksForSync,
  sortBookmarksByRecency,
} from './bookmarkOrdering'
import {
  defaultReaderSettings,
  migrateLegacyCbzSettings,
  normalizeReaderSettings,
  settingsForFormat,
} from './readerSettings'
import {
  createOfflineDownloadRecord,
  copyOfflineResources,
  deleteAllOfflineDownloadsForUser,
  deleteOfflineDownload,
  getOfflineDownload,
  getLastOfflineProfile,
  getOfflineResourceInventory,
  getOfflineReadingState,
  getOfflineResourceUrl,
  getOfflineStorageSummary,
  listOfflineDownloads,
  putOfflineDownload,
  putOfflineReadingState,
  putOfflineResource,
  requestOfflineStoragePersistence,
} from './offlineStorage'
import {
  isOfflineResourceComplete,
  isRetryableOfflineDownloadError,
  mergeOfflineDownloadRecord,
  mergeOfflineManifestWithStoredResources,
  offlineRetryDelay,
  OfflineDownloadCancelledError,
  OfflineResourceIntegrityError,
  planReusableOfflineResources,
  mergeOfflineLibrary,
  waitForOfflineRetry,
} from './offlineDownloads'
import { ReaderVariantMenu } from './ReaderVariantMenu'
import { useAuthenticatedResourceUrl } from './authenticatedResource'
import {
  clearImageCache,
  getImageCacheSummary,
  imageCacheChangedEvent,
  runImageCacheSelfTest,
  type ImageCacheSummary,
  type ImageCacheSelfTestResult,
} from './imageCache'
import {
  appRoutePath,
  categoryForRoute,
  isProtectedRoute,
  isReaderRoute,
  isSeriesRoute,
  parseAppRoute,
  readerBeginningLocation,
  readerContentSessionKey,
  routeForLocation,
  routeView,
  safeInternalDestination,
  shouldReplaceReaderNavigation,
  type AppRoute,
  type LibraryRouteCategory,
} from './routing'
import {
  androidAppVersionCode,
  androidAppVersionName,
  isNativeApp,
  resolveApiUrl,
} from './platform'

const CbzReader = lazy(() => import('./LocalFileReaders').then((module) => ({ default: module.CbzReader })))
const EpubReader = lazy(() => import('./LocalFileReaders').then((module) => ({ default: module.EpubReader })))
const HtmlChapterReader = lazy(() => import('./LocalFileReaders').then((module) => ({ default: module.HtmlChapterReader })))
const PdfEmbed = lazy(() => import('./LocalFileReaders').then((module) => ({ default: module.PdfEmbed })))
const TextFileReader = lazy(() => import('./LocalFileReaders').then((module) => ({ default: module.TextFileReader })))
const VideoPlayer = lazy(() => import('./VideoPlayer').then((module) => ({ default: module.VideoPlayer })))

const emptyLibrary: SeriesSummary[] = []
const emptyOfflineReadingStateUpdatedAt = new Date(0).toISOString()
const emptyMetadataReviewItems: AppState['metadataQueue'] = []
const defaultReaderCategory: CategoryId = 'books'
const readerCategoryOrder = categoryOrder.filter((category) => category !== 'anime')
const readerScopeOrder: ScopeId[] = ['all', ...readerCategoryOrder]
const isReaderCategory = (category: CategoryId) => category !== 'anime'
const resolveReaderCategory = (category: CategoryId) =>
  isReaderCategory(category) ? category : defaultReaderCategory
const isOfflineLocalResourceUrl = (url: string) =>
  /^(?:blob|capacitor|data|file):/i.test(url) || url.startsWith('/__orbital_offline/')

const offlineStateForProfile = (offlineProfile: SessionUser) => {
  const bootstrapState: BootstrapState = {
    appName: 'Orbital Library',
    bootstrapAdmin: '',
    openSignup: false,
    user: offlineProfile,
    csrfToken: null,
  }

  const appState: AppState = {
    appName: bootstrapState.appName,
    bootstrapAdmin: bootstrapState.bootstrapAdmin,
    openSignup: false,
    user: offlineProfile,
    csrfToken: null,
    scanSummary: {
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
    },
    scanStatus: emptyScanStatus,
    library: [],
    bookmarks: [],
    readingPositions: {},
    sourceRoots: [],
    sourceFolders: [],
    users: [],
    metadataQueue: [],
  }

  return { bootstrapState, appState }
}
const sourceCategoryOptions = (currentCategory: CategoryId) =>
  [...new Set([currentCategory, ...readerCategoryOrder])]
const readerChromeInteractionSelector = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'summary',
  'details',
  'video',
  'audio',
  '[role="button"]',
  '.reader-overlay',
  '.document-frame__toolbar',
  '.cbz-viewer__toolbar',
  '.epub-reader__toolbar',
  '.html-reader__toolbar',
  '.reader-settings__sheet',
  '.variant-menu__panel',
  '.cbz-viewer__settings-menu',
].join(', ')

const isReaderChromeInteractionTarget = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(readerChromeInteractionSelector))

const appStateCacheVersion = 2
const maxCachedSeriesDetails = 24
const appStateCachePrefix = `orbital:reader-cache:v${appStateCacheVersion}`
const legacyAppStateCachePrefix = 'orbital:reader-cache:'
let legacyAppStateCachePruned = false
const readerSessionStorageKeyPrefixes = [legacyAppStateCachePrefix, 'video-progress:']
const readerPersistentStorageKeyPrefixes = [
  legacyAppStateCachePrefix,
  'cbz-reader-settings:',
  'video-progress:',
]

type RouteNavigationOptions = {
  replace?: boolean
  preserveScroll?: boolean
  focusMain?: boolean
}

type OrbitalHistoryState = {
  orbitalIndex?: number
  orbitalReaderReturnIndex?: number
  orbitalReaderReturnPath?: string
  orbitalScroll?: [number, number]
}

type RouteTransition = {
  focusMain: boolean
  kind: 'initial' | 'push' | 'replace' | 'pop'
  preserveScroll: boolean
  restoreScroll: [number, number] | null
}

type ReaderProgressState = {
  progress: ReaderProgress
  variantId: string
}

type RouteLinkProps = {
  ariaCurrent?: 'page'
  ariaLabel?: string
  children: ReactNode
  className?: string
  navigate: (route: AppRoute, options?: RouteNavigationOptions) => void
  onNavigate?: () => void
  route: AppRoute
  title?: string
}

const RouteLink = ({
  ariaCurrent,
  ariaLabel,
  children,
  className,
  navigate,
  onNavigate,
  route,
  title,
}: RouteLinkProps) => (
  <a
    aria-current={ariaCurrent}
    aria-label={ariaLabel}
    className={className}
    href={appRoutePath(route)}
    onClick={(event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }

      event.preventDefault()
      onNavigate?.()
      navigate(route)
    }}
    title={title}
  >
    {children}
  </a>
)

const historyState = (): OrbitalHistoryState => {
  const state = window.history.state
  return state && typeof state === 'object' ? state as OrbitalHistoryState : {}
}

const categoryRouteId = (category: CategoryId): LibraryRouteCategory =>
  resolveReaderCategory(category) as LibraryRouteCategory

const routeReadingPosition = (
  route: AppRoute,
  savedPosition: SavedReadingPosition | null,
): SavedReadingPosition | null => {
  if (route.name !== 'reader' && route.name !== 'offlineReader') {
    return savedPosition
  }

  if (route.page == null && route.percent == null) {
    return savedPosition
  }

  return {
    ...savedPosition,
    page: route.page ?? route.percent ?? savedPosition?.page ?? 0,
    locationType: route.percent != null ? 'percent' : 'page',
  }
}

type CachedReaderState = {
  version: number
  userId: string
  savedAt: string
  library: AppState['library']
  bookmarks: AppState['bookmarks']
  readingPositions: AppState['readingPositions']
  scanSummary: AppState['scanSummary']
  scanStatus: AppState['scanStatus']
  seriesCache: Record<string, SeriesDetail>
}

const emptyScanStatus: ScanStatus = {
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

const getAppStateCacheKey = (userId: string) => `${appStateCachePrefix}:${userId}`

const getReaderCacheStorage = () => window.localStorage

const clearStorageKeysByPrefix = (storage: Storage, prefixes: string[]) => {
  Object.keys(storage)
    .filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
    .forEach((key) => storage.removeItem(key))
}

const pruneLegacyPersistentReaderCaches = () => {
  if (typeof window === 'undefined' || legacyAppStateCachePruned) {
    return
  }

  legacyAppStateCachePruned = true

  try {
    clearStorageKeysByPrefix(window.localStorage, ['video-progress:'])
    Object.keys(window.localStorage)
      .filter(
        (key) =>
          key.startsWith(legacyAppStateCachePrefix) &&
          !key.startsWith(appStateCachePrefix),
      )
      .forEach((key) => window.localStorage.removeItem(key))
  } catch {
    // Storage may be unavailable; cache cleanup is best-effort.
  }
}

const clearCachedReaderState = (userId?: string | null) => {
  if (typeof window === 'undefined' || !userId) {
    return
  }

  try {
    window.localStorage.removeItem(getAppStateCacheKey(userId))
  } catch {
    // Storage may be unavailable; the server remains authoritative.
  }
}

const clearReaderSessionCaches = () => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    clearStorageKeysByPrefix(window.sessionStorage, readerSessionStorageKeyPrefixes)
  } catch {
    // Storage may be unavailable; the server session remains authoritative.
  }
}

const resetOrbitalLocalCaches = async () => {
  if (typeof window === 'undefined') {
    return
  }

  clearReaderSessionCaches()

  try {
    clearStorageKeysByPrefix(window.localStorage, readerPersistentStorageKeyPrefixes)
  } catch {
    // Browser storage can be blocked; continue with the rest of the reset.
  }

  if ('caches' in window) {
    try {
      const cacheNames = await window.caches.keys()
      await Promise.all(cacheNames.map((cacheName) => window.caches.delete(cacheName)))
    } catch {
      // Cache Storage is best-effort and may be unavailable in private contexts.
    }
  }

  if ('serviceWorker' in navigator) {
    try {
      const originScopePrefix = `${window.location.origin}/`
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(
        registrations
          .filter((registration) => registration.scope.startsWith(originScopePrefix))
          .map((registration) => registration.unregister()),
      )
    } catch {
      // Orbital does not currently register a service worker; this keeps future resets robust.
    }
  }

  await clearImageCache()
}

const readCachedReaderState = (bootstrapState: BootstrapState) => {
  if (typeof window === 'undefined' || !bootstrapState.user) {
    return null
  }

  pruneLegacyPersistentReaderCaches()

  try {
    const rawCache = getReaderCacheStorage().getItem(getAppStateCacheKey(bootstrapState.user.id))

    if (!rawCache) {
      return null
    }

    const cache = JSON.parse(rawCache) as Partial<CachedReaderState>

    if (
      cache.version !== appStateCacheVersion ||
      cache.userId !== bootstrapState.user.id ||
      !Array.isArray(cache.library) ||
      !Array.isArray(cache.bookmarks) ||
      !cache.readingPositions ||
      !cache.scanSummary
    ) {
      return null
    }

    const appState = normalizeAppState({
      appName: bootstrapState.appName,
      bootstrapAdmin: bootstrapState.bootstrapAdmin,
      openSignup: bootstrapState.openSignup,
      user: bootstrapState.user,
      csrfToken: bootstrapState.csrfToken,
      scanSummary: cache.scanSummary,
      scanStatus: cache.scanStatus?.active ? emptyScanStatus : cache.scanStatus || emptyScanStatus,
      library: cache.library,
      bookmarks: cache.bookmarks,
      readingPositions: cache.readingPositions,
      sourceRoots: [],
      sourceFolders: [],
      users: [],
      metadataQueue: [],
    })

    const seriesCache = cache.seriesCache && typeof cache.seriesCache === 'object'
      ? Object.fromEntries(
          Object.entries(cache.seriesCache).map(([seriesId, series]) => [
            seriesId,
            normalizeSeriesDetail(series),
          ]),
        )
      : {}

    return {
      appState,
      seriesCache,
    }
  } catch {
    return null
  }
}

const writeCachedReaderState = (
  appState: AppState,
  seriesCache: Record<string, SeriesDetail>,
) => {
  if (typeof window === 'undefined' || !appState.user || appState.scanStatus.active) {
    return
  }

  const validSeriesIds = new Set(appState.library.map((series) => series.id))
  const cachedSeriesEntries = Object.entries(seriesCache)
    .filter(([seriesId]) => validSeriesIds.has(seriesId))
    .slice(-maxCachedSeriesDetails)

  const cache: CachedReaderState = {
    version: appStateCacheVersion,
    userId: appState.user.id,
    savedAt: new Date().toISOString(),
    library: appState.library,
    bookmarks: appState.bookmarks,
    readingPositions: appState.readingPositions,
    scanSummary: appState.scanSummary,
    scanStatus: appState.scanStatus,
    seriesCache: Object.fromEntries(cachedSeriesEntries),
  }

  try {
    pruneLegacyPersistentReaderCaches()
    getReaderCacheStorage().setItem(getAppStateCacheKey(appState.user.id), JSON.stringify(cache))
  } catch {
    // Browser storage can be disabled or full; the live API state remains authoritative.
  }
}

const pruneSeriesCacheForLibrary = (
  previousCache: Record<string, SeriesDetail>,
  library: SeriesSummary[],
) => {
  const summariesById = new Map(library.map((series) => [series.id, series]))

  return Object.fromEntries(
    Object.entries(previousCache).filter(([seriesId, cachedSeries]) => {
      const summary = summariesById.get(seriesId)

      return Boolean(
        summary &&
          cachedSeries.stats.lastScanAt === summary.stats.lastScanAt &&
          cachedSeries.coverUrl === summary.coverUrl &&
          cachedSeries.bannerUrl === summary.bannerUrl &&
          cachedSeries.title === summary.title,
      )
    }),
  )
}

const ui = {
  en: {
    brandName: 'Orbital Library',
    demoTag: 'Full stack preview',
    privateLibrary: 'Private library',
    authPrompt: 'Sign in to continue.',
    signIn: 'Sign in',
    createAccount: 'Create account',
    username: 'Username',
    password: 'Password',
    currentPassword: 'Current password',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    changePassword: 'Change password',
    accountSettings: 'Account settings',
    appVersion: 'App version',
    androidApp: 'Android app',
    webApp: 'Web app',
    passwordChangeHelp: 'Update your own password here. Admin resets stay available in Admin.',
    androidAppDownload: 'Download Android app',
    androidAppDownloadBody: 'Install or update Orbital directly on this device while you are online.',
    passwordChangeSuccess: 'Password updated.',
    passwordMismatch: 'New password and confirmation do not match.',
    resetLocalCache: 'Reset local cache',
    resetLocalCacheBusy: 'Resetting cache...',
    resetLocalCacheHelp: 'Clears this device’s reader cache and reloads Orbital. Server bookmarks, accounts, and scans stay intact.',
    downloadsTitle: 'Downloads',
    downloadsBody: 'Downloaded items live only on this device so Orbital can open them offline.',
    downloadsEmpty: 'Nothing downloaded on this device yet.',
    downloadsStorage: 'Device storage',
    downloadsReady: 'Available offline',
    downloadsPartial: 'Needs attention',
    downloadsActive: 'Downloading',
    downloadsQueued: 'Queued to retry',
    downloadsPaused: 'Paused',
    downloadsAll: 'All downloads',
    downloadForOffline: 'Download',
    preparingOfflineDownload: 'Preparing update...',
    preparingOfflineUpdate: (current: number, total: number) => `Preparing update ${current} / ${total}`,
    downloadSeries: 'Download series',
    downloadProgress: (current: number, total: number) => `Downloading ${current} / ${total}`,
    downloadEntry: 'Download chapter',
    downloadBook: 'Download book',
    downloadAgain: 'Download again',
    openOffline: 'Open offline',
    deleteDownload: 'Delete download',
    deleteAllDownloads: 'Delete all downloads',
    requestPersistentStorage: 'Protect downloads',
    persistentStorageGranted: 'Protected by browser storage',
    persistentStorageHelp: 'Ask the browser not to evict downloaded media when space is low.',
    offlineMode: 'Offline mode',
    offlineModeHelp: 'The server is unreachable. Your cached catalogue and bookmarks remain visible; only downloaded items can be read offline.',
    offlineOnly: 'Online only',
    offlineOnlyTitle: 'Not downloaded for offline reading',
    offlineOnlyBody: 'This item is still visible from your cached catalogue, but its content is not stored on this device. Reconnect and download it first.',
    offlineDownloadedReaderBody: 'This item is downloaded on this device. Open the offline copy to read it now.',
    downloadedBytes: 'Downloaded',
    estimatedBytes: 'Estimated',
    verifiedBytes: 'Verified',
    browserStorageUsed: 'Browser storage used',
    browserStorageQuota: 'Browser storage limit',
    coverStorage: 'Cover images stored',
    coverStorageHelp: 'Covers that appeared on this device are kept locally for offline browsing.',
    coverStorageBackend: (backend: string) => `Cover storage backend: ${backend}.`,
    testCoverStorage: 'Test cover storage',
    testCoverStorageBusy: 'Testing cover storage...',
    testCoverStoragePassed: (backend: string, bytes: number) =>
      `Temporary cover-storage test passed: ${backend}, ${bytes} bytes verified and removed.`,
    testCoverStorageFailed: (error: string) => `Cover storage test failed: ${error}`,
    clearCoverStorage: 'Free cover space',
    clearCoverStorageBusy: 'Freeing cover space...',
    clearCoverStorageConfirm: 'Remove the locally stored cover images? They can be downloaded again when you browse the library online.',
    downloadFailed: 'Download failed',
    downloadStale: 'Server copy changed',
    repairDownload: 'Repair',
    cancelDownload: 'Cancel download',
    downloadCancelled: 'Download cancelled. Completed content was kept.',
    downloadsDeviceOnly: 'Server files, bookmarks, and accounts stay unchanged.',
    searchPlaceholder: 'Search every shelf, series, and file',
    scopes: {
      all: 'All media',
      anime: 'Anime',
      manga: 'Manga',
      novels: 'Novels',
      magazines: 'Magazines',
      books: 'Books',
    },
    nav: {
      bookmarks: 'Bookmarks',
      downloads: 'Downloads',
      anime: 'Anime',
      manga: 'Manga',
      novels: 'Novels',
      magazines: 'Magazines',
      books: 'Books',
    },
    mobileNav: {
      library: 'Library',
      discover: 'Discover',
      search: 'Search',
      downloads: 'Downloads',
      profile: 'Profile',
    },
    profile: 'Profile',
    admin: 'Admin',
    profileMenu: 'Settings',
    librarySort: 'Last read',
    sortBy: 'Sort by',
    sortTitle: 'Name',
    sortYear: 'Year',
    viewMode: 'View',
    gridView: 'Grid',
    listView: 'List',
    accountActions: 'Account',
    adminTools: 'Admin tools',
    quickResults: 'Quick results',
    searchTitle: 'Search',
    searchNoMatches: 'No matches yet.',
    searching: 'Searching...',
    searchAction: 'Search',
    skipToContent: 'Skip to content',
    clearSearch: 'Clear',
    closeSearch: 'Close search',
    dismissError: 'Dismiss error',
    filters: 'Filters',
    activeFilter: 'Active filter',
    clearFilter: 'Clear filter',
    closeFilters: 'Close filters',
    moreMenu: 'More',
    welcome: 'Bookmarks',
    bookmarksHero: 'Continue by category',
    bookmarksHome: 'Default home',
    bookmarksBody:
      'Each signed-in user lands on category-separated bookmarks first so resuming feels immediate on desktop, tablet, and phone.',
    overview: 'Overview',
    entries: 'Entries',
    comments: 'Comments',
    entryLabel: 'Label',
    entryTitle: 'Title',
    entryDetails: 'Details',
    entryAction: 'Action',
    resume: 'Resume',
    openSeries: 'Open series',
    bookmarkActions: 'Bookmark actions',
    removeBookmark: 'Remove bookmark',
    openReader: 'Open reader',
    previousEntry: 'Previous chapter',
    previousEntryShort: 'Prev',
    nextEntry: 'Next chapter',
    nextEntryShort: 'Next',
    setBookmark: 'Set bookmark',
    setBookmarkShort: 'Bookmark',
    bookmarked: 'Bookmarked',
    bookmarkedShort: 'Saved',
    back: 'Back',
    notFoundTitle: 'Page not found',
    notFoundBody: 'This address does not match a page in Orbital.',
    itemUnavailableTitle: 'This item is no longer available',
    itemUnavailableBody:
      'It may have been moved, renamed on disk, or removed during a library scan.',
    downloadUnavailableTitle: 'This download is unavailable',
    downloadUnavailableBody:
      'The device copy may have been removed, changed, or not finished downloading.',
    permissionDeniedTitle: 'Admin access required',
    permissionDeniedBody: 'This page is available only to an Orbital administrator.',
    returnBookmarks: 'Return to bookmarks',
    browseCategory: 'Browse this category',
    openDownloadsPage: 'Open downloads',
    libraryTitle: 'Shelf browsing',
    libraryBody:
      'Cover-first cards, compact metadata, and search that can span every linked folder or just one category.',
    seriesActions: 'Series actions',
    localCover: 'Cover source',
    onlineMatch: 'Metadata source',
    lastScan: 'Last scan',
    scanMode: 'Incremental scan',
    sourceRoots: 'Mounted roots',
    sourceFolders: 'Linked folders',
    addMediaFolder: 'Import media',
    addMediaFolderBody: 'Add one folder to the library in three steps. Existing imports stay editable below.',
    importStepType: 'Type',
    importStepFolder: 'Folder',
    importStepReview: 'Review',
    importTypeTitle: 'What are you adding?',
    importTypeBody: 'Pick the library section this folder should appear in. You can change this later.',
    importFolderTitle: 'Choose the folder',
    importFolderBody: 'Browse your mounted archive, then continue to review.',
    importReviewTitle: 'Ready to import',
    importReviewBody: 'This folder will be added to the selected section and scanned immediately.',
    importNextFolder: 'Choose folder',
    importReviewAction: 'Review import',
    importBack: 'Back',
    importChange: 'Change',
    importStorage: 'Storage',
    importStorageDetails: 'Storage details',
    importCurrentPath: 'Current path',
    importExistingTitle: 'Current imports',
    importExistingEmpty: 'No media folders linked yet.',
    importAlreadyLinkedHelp: 'This folder is already linked. Use Current imports to rescan or move it.',
    importOpenFolderFirst: 'Open a folder before reviewing the import.',
    importMainArchive: 'Main archive',
    importDockerRoot: 'Docker media root',
    folderCategory: 'Media type',
    folderLocation: 'Folder location',
    selectedFolder: 'Selected folder',
    selectedRootFolder: 'Root folder',
    addAndScanFolder: 'Add folder and scan',
    folderAlreadyLinked: 'Already added',
    openFolder: 'Open',
    folderPathInput: 'Paste folder path',
    folderPathPlaceholder: './library/books or media/books',
    useFolderPath: 'Go to folder',
    linkedMediaFolders: 'Media folders',
    changeFolderCategory: 'Move to',
    rescanFolder: 'Rescan folder',
    advancedRoots: 'Advanced mounted roots',
    folderBrowserEmpty: 'No folders inside this location.',
    nativePickerUnavailable:
      'Native Windows folder pickers cannot pass host paths into a Docker web app, so this browser shows folders that are already mounted into the container.',
    folderPathOutsideRoot: 'That folder is outside the selected mounted root.',
    scanChanges: 'Scan now',
    refreshMetadata: 'Rescan all',
    users: 'User accounts',
    resetPassword: 'Reset password',
    unlinkFolder: 'Unlink folder',
    unlinkRoot: 'Unmount root',
    metadataQueue: 'Metadata queue',
    metadataReview: 'Metadata review',
    metadataEditor: 'Metadata editor',
    metadataSearchPlaceholder: 'Find a series to edit metadata',
    metadataReason: 'Review reason',
    metadataCurrentState: 'Current state',
    metadataOverrideTitle: 'Override title',
    metadataOverrideYear: 'Override year',
    metadataOverrideDescription: 'Override description',
    metadataOverrideSourceName: 'Override source name',
    metadataOverrideSourceRole: 'Override source role',
    metadataOverrideExternalUrl: 'Override source URL',
    metadataOverrideCoverUrl: 'Override cover image URL',
    metadataSave: 'Save override',
    metadataClear: 'Clear override',
    metadataRefresh: 'Refresh match',
    metadataOpenSeries: 'Open series page',
    metadataNoItems: 'No review items right now.',
    metadataNoSelection: 'Pick a review item or search for any series to edit its metadata.',
    synopsis: 'Synopsis',
    genres: 'Genres',
    sourceDetails: 'Source details',
    creatorProfile: 'Creator profile',
    creatorWorks: 'Works in library',
    creatorCategories: 'Categories',
    openCreatorPage: 'Open creator page',
    moreFromCreator: 'More from this creator',
    noRelatedCreatorTitles: 'No other linked titles from this creator yet.',
    libraryDetails: 'Library details',
    sourceLabel: 'Source',
    sourceRole: 'Role',
    booksTopics: 'Book topics',
    allTopics: 'All topics',
    openSourcePage: 'Open source page',
    scanActivity: 'Scan activity',
    scanProgress: 'Progress',
    linkedFolderProgress: 'Linked folders',
    filesDiscovered: 'Files discovered',
    detectedSeries: 'Detected series',
    indexedSeries: 'Indexed series',
    currentSource: 'Current source',
    currentSeries: 'Current series',
    scanLogEmpty: 'No scan events yet.',
    scanInProgress: 'Scan in progress',
    scanIdle: 'No active scan right now.',
    scanRawLog: 'Raw event log',
    scanRawLogHelp: 'Browser and server scan events, shown as reported.',
    scanRawLogEmpty: 'No raw scan lines yet. Start a scan to stream events here.',
    scanStartQueued: 'Browser requested a scan start; waiting for server status.',
    scanRequestLost: 'Browser request failed, but the scan may still be running. Polling server status',
    commentsEmpty: 'No comments yet.',
    language: 'Language',
    searchCount: 'matches',
    searchHint:
      'Search checks series titles, paths, and entry names. Keep it global by default or narrow to one category when you need to.',
    loading: 'Loading library...',
    loadingSeries: 'Loading series...',
    addComment: 'Add comment',
    commentPlaceholder: 'Leave a series-level comment for other users in your home network.',
    postComment: 'Post comment',
    mountedRootLabel: 'Mounted root label',
    mountedRootPath: 'Mounted root path',
    addMountedRoot: 'Add mounted root',
    configuredRootHelp:
      'Docker-mounted roots appear here automatically. Use the form only for extra paths that already exist inside the container.',
    configuredRootLocked: 'This root comes from your Docker setup.',
    browseFolders: 'Browse linked root',
    linkCurrentFolder: 'Link current folder',
    currentFolder: 'Current folder',
    browseUp: 'Up one folder',
    categoryToLink: 'Category to link',
    resetPasswordPrompt: 'Enter a new password for this user',
    logout: 'Log out',
    noLibrary: 'No linked media yet. Add a mounted root and link category folders in the admin page.',
    scanReady: 'Ready',
    openOriginal: 'Open original file',
    authErrorFallback: 'Unable to reach the server right now.',
  },
  de: {
    brandName: 'Orbital Library',
    demoTag: 'Full-Stack-Vorschau',
    privateLibrary: 'Private Bibliothek',
    authPrompt: 'Melde dich an, um fortzufahren.',
    signIn: 'Anmelden',
    createAccount: 'Account erstellen',
    username: 'Benutzername',
    password: 'Passwort',
    currentPassword: 'Aktuelles Passwort',
    newPassword: 'Neues Passwort',
    confirmPassword: 'Passwort bestätigen',
    changePassword: 'Passwort ändern',
    accountSettings: 'Kontoeinstellungen',
    appVersion: 'App-Version',
    androidApp: 'Android-App',
    webApp: 'Web-App',
    passwordChangeHelp: 'Hier kannst du dein eigenes Passwort ändern. Admin-Resets bleiben im Admin-Bereich.',
    androidAppDownload: 'Android-App herunterladen',
    androidAppDownloadBody: 'Orbital direkt auf diesem Gerät installieren oder aktualisieren, solange du online bist.',
    passwordChangeSuccess: 'Passwort aktualisiert.',
    passwordMismatch: 'Neues Passwort und Bestätigung stimmen nicht überein.',
    resetLocalCache: 'Lokalen Cache zurücksetzen',
    resetLocalCacheBusy: 'Cache wird zurückgesetzt...',
    resetLocalCacheHelp: 'Leert den Reader-Cache auf diesem Gerät und lädt Orbital neu. Server-Lesezeichen, Accounts und Scans bleiben erhalten.',
    downloadsTitle: 'Downloads',
    downloadsBody: 'Heruntergeladene Inhalte liegen nur auf diesem Geraet, damit Orbital sie offline oeffnen kann.',
    downloadsEmpty: 'Auf diesem Geraet ist noch nichts heruntergeladen.',
    downloadsStorage: 'Geraetespeicher',
    downloadsReady: 'Offline verfuegbar',
    downloadsPartial: 'Braucht Aufmerksamkeit',
    downloadsActive: 'Laedt herunter',
    downloadsQueued: 'Wird erneut versucht',
    downloadsPaused: 'Pausiert',
    downloadsAll: 'Alle Downloads',
    downloadForOffline: 'Herunterladen',
    preparingOfflineDownload: 'Update wird vorbereitet...',
    preparingOfflineUpdate: (current: number, total: number) => `Update wird vorbereitet ${current} / ${total}`,
    downloadSeries: 'Serie herunterladen',
    downloadProgress: (current: number, total: number) => `Wird geladen ${current} / ${total}`,
    downloadEntry: 'Kapitel herunterladen',
    downloadBook: 'Buch herunterladen',
    downloadAgain: 'Erneut herunterladen',
    openOffline: 'Offline oeffnen',
    deleteDownload: 'Download loeschen',
    deleteAllDownloads: 'Alle Downloads loeschen',
    requestPersistentStorage: 'Downloads schuetzen',
    persistentStorageGranted: 'Vom Browser geschuetzt',
    persistentStorageHelp: 'Bitte den Browser, heruntergeladene Medien bei wenig Speicher nicht automatisch zu entfernen.',
    offlineMode: 'Offline-Modus',
    offlineModeHelp: 'Der Server ist nicht erreichbar. Dein zwischengespeicherter Katalog und deine Lesezeichen bleiben sichtbar; nur heruntergeladene Inhalte können offline gelesen werden.',
    offlineOnly: 'Nur online',
    offlineOnlyTitle: 'Nicht für Offline-Lesen heruntergeladen',
    offlineOnlyBody: 'Dieser Eintrag ist aus deinem zwischengespeicherten Katalog sichtbar, aber sein Inhalt liegt nicht auf diesem Gerät. Verbinde dich erneut und lade ihn zuerst herunter.',
    offlineDownloadedReaderBody: 'Dieser Eintrag ist auf diesem Gerät heruntergeladen. Öffne die Offline-Kopie, um ihn jetzt zu lesen.',
    downloadedBytes: 'Heruntergeladen',
    estimatedBytes: 'Geschaetzt',
    verifiedBytes: 'Geprueft',
    browserStorageUsed: 'Browser-Speicher genutzt',
    browserStorageQuota: 'Browser-Speicherlimit',
    coverStorage: 'Gespeicherte Titelbilder',
    coverStorageHelp: 'Titelbilder, die auf diesem Gerät angezeigt wurden, bleiben zum Offline-Durchsuchen lokal gespeichert.',
    coverStorageBackend: (backend: string) => `Speicherort für Titelbilder: ${backend}.`,
    testCoverStorage: 'Titelbildspeicher testen',
    testCoverStorageBusy: 'Titelbildspeicher wird getestet...',
    testCoverStoragePassed: (backend: string, bytes: number) =>
      `Temporärer Titelbildspeicher-Test erfolgreich: ${backend}, ${bytes} Bytes geprüft und entfernt.`,
    testCoverStorageFailed: (error: string) => `Titelbildspeicher-Test fehlgeschlagen: ${error}`,
    clearCoverStorage: 'Titelbildspeicher freigeben',
    clearCoverStorageBusy: 'Titelbildspeicher wird freigegeben...',
    clearCoverStorageConfirm: 'Gespeicherte Titelbilder von diesem Gerät entfernen? Sie können beim nächsten Online-Besuch erneut geladen werden.',
    downloadFailed: 'Download fehlgeschlagen',
    downloadStale: 'Server-Kopie geaendert',
    repairDownload: 'Reparieren',
    cancelDownload: 'Download abbrechen',
    downloadCancelled: 'Download abgebrochen. Fertige Inhalte bleiben erhalten.',
    downloadsDeviceOnly: 'Server-Dateien, Lesezeichen und Accounts bleiben unveraendert.',
    searchPlaceholder: 'Alle Regale, Serien und Dateien durchsuchen',
    scopes: {
      all: 'Alle Medien',
      anime: 'Anime',
      manga: 'Manga',
      novels: 'Novels',
      magazines: 'Magazine',
      books: 'Bücher',
    },
    nav: {
      bookmarks: 'Lesezeichen',
      downloads: 'Downloads',
      anime: 'Anime',
      manga: 'Manga',
      novels: 'Novels',
      magazines: 'Magazine',
      books: 'Bücher',
    },
    mobileNav: {
      library: 'Bibliothek',
      discover: 'Entdecken',
      search: 'Suche',
      downloads: 'Downloads',
      profile: 'Profil',
    },
    profile: 'Profil',
    admin: 'Admin',
    profileMenu: 'Einstellungen',
    librarySort: 'Zuletzt gelesen',
    sortBy: 'Sortieren',
    sortTitle: 'Name',
    sortYear: 'Jahr',
    viewMode: 'Ansicht',
    gridView: 'Raster',
    listView: 'Liste',
    accountActions: 'Account',
    adminTools: 'Admin-Werkzeuge',
    quickResults: 'Schnellergebnisse',
    searchTitle: 'Suche',
    searchNoMatches: 'Noch keine Treffer.',
    searching: 'Suche...',
    searchAction: 'Suche',
    skipToContent: 'Zum Inhalt springen',
    clearSearch: 'Leeren',
    closeSearch: 'Suche schlieÃŸen',
    dismissError: 'Fehler schliessen',
    filters: 'Filter',
    activeFilter: 'Aktiver Filter',
    clearFilter: 'Filter lÃ¶schen',
    closeFilters: 'Filter schlieÃŸen',
    moreMenu: 'Mehr',
    welcome: 'Lesezeichen',
    bookmarksHero: 'Nach Kategorie fortsetzen',
    bookmarksHome: 'Standard-Startseite',
    bookmarksBody:
      'Jeder eingeloggte Nutzer landet zuerst auf getrennten Lesezeichen pro Kategorie, damit das Fortsetzen auf Desktop, Tablet und Handy sofort klappt.',
    overview: 'Übersicht',
    entries: 'Einträge',
    comments: 'Kommentare',
    entryLabel: 'Label',
    entryTitle: 'Titel',
    entryDetails: 'Details',
    entryAction: 'Aktion',
    resume: 'Fortsetzen',
    bookmarkActions: 'Lesezeichen-Aktionen',
    removeBookmark: 'Lesezeichen entfernen',
    openSeries: 'Serie öffnen',
    openReader: 'Reader öffnen',
    previousEntry: 'Vorheriges Kapitel',
    previousEntryShort: 'Zur',
    nextEntry: 'Nächstes Kapitel',
    nextEntryShort: 'Vor',
    setBookmark: 'Lesezeichen setzen',
    setBookmarkShort: 'Merken',
    bookmarked: 'Gespeichert',
    bookmarkedShort: 'Gespeichert',
    back: 'Zurück',
    notFoundTitle: 'Seite nicht gefunden',
    notFoundBody: 'Diese Adresse gehört zu keiner Seite in Orbital.',
    itemUnavailableTitle: 'Dieses Medium ist nicht mehr verfügbar',
    itemUnavailableBody:
      'Es wurde möglicherweise verschoben, auf dem Datenträger umbenannt oder bei einem Scan entfernt.',
    downloadUnavailableTitle: 'Dieser Download ist nicht verfügbar',
    downloadUnavailableBody:
      'Die Gerätekopie wurde möglicherweise entfernt, geändert oder noch nicht vollständig geladen.',
    permissionDeniedTitle: 'Administratorzugriff erforderlich',
    permissionDeniedBody: 'Diese Seite ist nur für Orbital-Administratoren verfügbar.',
    returnBookmarks: 'Zurück zu den Lesezeichen',
    browseCategory: 'Diese Kategorie durchsuchen',
    openDownloadsPage: 'Downloads öffnen',
    libraryTitle: 'Regalansicht',
    libraryBody:
      'Cover-zentrierte Karten, kompakte Metadaten und eine Suche, die über alle verknüpften Ordner oder nur eine Kategorie gehen kann.',
    seriesActions: 'Serienaktionen',
    localCover: 'Cover-Quelle',
    onlineMatch: 'Metadaten-Quelle',
    lastScan: 'Letzter Scan',
    scanMode: 'Inkrementeller Scan',
    sourceRoots: 'Eingehängte Wurzeln',
    sourceFolders: 'Verknüpfte Ordner',
    addMediaFolder: 'Medien importieren',
    addMediaFolderBody: 'Fuege einen Ordner in drei Schritten zur Bibliothek hinzu. Bestehende Importe bleiben unten editierbar.',
    importStepType: 'Typ',
    importStepFolder: 'Ordner',
    importStepReview: 'Pruefen',
    importTypeTitle: 'Was fuegst du hinzu?',
    importTypeBody: 'Waehle den Bibliotheksbereich fuer diesen Ordner. Du kannst das spaeter aendern.',
    importFolderTitle: 'Ordner waehlen',
    importFolderBody: 'Durchsuche dein eingebundenes Archiv und pruefe danach den Import.',
    importReviewTitle: 'Bereit zum Import',
    importReviewBody: 'Dieser Ordner wird zum gewaehlten Bereich hinzugefuegt und direkt gescannt.',
    importNextFolder: 'Ordner waehlen',
    importReviewAction: 'Import pruefen',
    importBack: 'Zurueck',
    importChange: 'Aendern',
    importStorage: 'Speicherort',
    importStorageDetails: 'Speicher-Details',
    importCurrentPath: 'Aktueller Pfad',
    importExistingTitle: 'Aktuelle Importe',
    importExistingEmpty: 'Noch keine Medienordner verknuepft.',
    importAlreadyLinkedHelp: 'Dieser Ordner ist bereits verknuepft. Nutze Aktuelle Importe zum Scannen oder Verschieben.',
    importOpenFolderFirst: 'Oeffne zuerst einen Ordner, bevor du den Import pruefst.',
    importMainArchive: 'Hauptarchiv',
    importDockerRoot: 'Docker-Medienwurzel',
    folderCategory: 'Medientyp',
    folderLocation: 'Ordnerort',
    selectedFolder: 'Ausgewaehlter Ordner',
    selectedRootFolder: 'Wurzelordner',
    addAndScanFolder: 'Ordner hinzufuegen und scannen',
    folderAlreadyLinked: 'Schon hinzugefuegt',
    openFolder: 'Oeffnen',
    folderPathInput: 'Ordnerpfad einfuegen',
    folderPathPlaceholder: './library/books oder media/books',
    useFolderPath: 'Zum Ordner',
    linkedMediaFolders: 'Medienordner',
    changeFolderCategory: 'Verschieben nach',
    rescanFolder: 'Ordner scannen',
    advancedRoots: 'Erweiterte Wurzeln',
    folderBrowserEmpty: 'Keine Ordner an diesem Ort.',
    nativePickerUnavailable:
      'Native Windows-Ordnerdialoge koennen keine Host-Pfade in eine Docker-Web-App uebergeben. Dieser Browser zeigt Ordner, die bereits im Container eingebunden sind.',
    folderPathOutsideRoot: 'Dieser Ordner liegt ausserhalb der ausgewaehlten Wurzel.',
    scanChanges: 'Jetzt scannen',
    refreshMetadata: 'Alles rescannen',
    users: 'Benutzerkonten',
    resetPassword: 'Passwort zurücksetzen',
    unlinkFolder: 'Ordner trennen',
    unlinkRoot: 'Wurzel aushängen',
    metadataQueue: 'Metadaten-Warteschlange',
    metadataReview: 'Metadaten-Prüfung',
    metadataEditor: 'Metadaten-Editor',
    metadataSearchPlaceholder: 'Serie für Metadatenbearbeitung finden',
    metadataReason: 'Prüfgrund',
    metadataCurrentState: 'Aktueller Stand',
    metadataOverrideTitle: 'Titel überschreiben',
    metadataOverrideYear: 'Jahr überschreiben',
    metadataOverrideDescription: 'Beschreibung überschreiben',
    metadataOverrideSourceName: 'Quellnamen überschreiben',
    metadataOverrideSourceRole: 'Quellrolle überschreiben',
    metadataOverrideExternalUrl: 'Quell-URL überschreiben',
    metadataOverrideCoverUrl: 'Cover-Bild-URL überschreiben',
    metadataSave: 'Override speichern',
    metadataClear: 'Override löschen',
    metadataRefresh: 'Match aktualisieren',
    metadataOpenSeries: 'Serienseite öffnen',
    metadataNoItems: 'Aktuell keine Review-Einträge.',
    metadataNoSelection: 'Wähle einen Review-Eintrag oder suche eine Serie, um ihre Metadaten zu bearbeiten.',
    synopsis: 'Inhalt',
    genres: 'Genres',
    sourceDetails: 'Quellinfos',
    creatorProfile: 'Creator-Profil',
    creatorWorks: 'Werke in der Bibliothek',
    creatorCategories: 'Kategorien',
    openCreatorPage: 'Creator-Profil öffnen',
    moreFromCreator: 'Mehr von dieser Quelle',
    noRelatedCreatorTitles: 'Noch keine weiteren verknüpften Titel von dieser Quelle.',
    libraryDetails: 'Bibliotheksinfos',
    sourceLabel: 'Quelle',
    sourceRole: 'Rolle',
    booksTopics: 'Buchthemen',
    allTopics: 'Alle Themen',
    openSourcePage: 'Quellseite öffnen',
    scanActivity: 'Scan-Aktivität',
    scanProgress: 'Fortschritt',
    linkedFolderProgress: 'Verknüpfte Ordner',
    filesDiscovered: 'Gefundene Dateien',
    detectedSeries: 'Erkannte Serien',
    indexedSeries: 'Indizierte Serien',
    currentSource: 'Aktuelle Quelle',
    currentSeries: 'Aktuelle Serie',
    scanLogEmpty: 'Noch keine Scan-Ereignisse.',
    scanInProgress: 'Scan läuft',
    scanIdle: 'Aktuell läuft kein Scan.',
    scanRawLog: 'Roh-Log',
    scanRawLogHelp: 'Browser- und Server-Scanereignisse, direkt aus dem Status.',
    scanRawLogEmpty: 'Noch keine Rohzeilen. Starte einen Scan, um Events hier zu sehen.',
    scanStartQueued: 'Browser hat den Scan-Start angefragt; warte auf Serverstatus.',
    scanRequestLost: 'Browser-Request fehlgeschlagen, aber der Scan kann trotzdem laufen. Serverstatus wird weiter abgefragt',
    commentsEmpty: 'Noch keine Kommentare.',
    language: 'Sprache',
    searchCount: 'Treffer',
    searchHint:
      'Die Suche prüft Serientitel, Pfade und Eintragsnamen. Standardmäßig bleibt sie global oder du grenzt sie auf eine Kategorie ein.',
    loading: 'Bibliothek wird geladen...',
    loadingSeries: 'Serie wird geladen...',
    addComment: 'Kommentar hinzufügen',
    commentPlaceholder: 'Hinterlasse einen Kommentar auf Serienebene für andere Nutzer in deinem Heimnetz.',
    postComment: 'Kommentar senden',
    mountedRootLabel: 'Name der eingebundenen Wurzel',
    mountedRootPath: 'Pfad der eingebundenen Wurzel',
    addMountedRoot: 'Eingebundene Wurzel hinzufügen',
    browseFolders: 'Verknüpfte Wurzel durchsuchen',
    linkCurrentFolder: 'Aktuellen Ordner verknüpfen',
    currentFolder: 'Aktueller Ordner',
    browseUp: 'Eine Ebene hoch',
    categoryToLink: 'Kategorie zum Verknüpfen',
    resetPasswordPrompt: 'Neues Passwort für diesen Nutzer eingeben',
    logout: 'Abmelden',
    noLibrary: 'Noch keine Medien verknüpft. Füge im Admin-Bereich zuerst Wurzeln und Kategorie-Ordner hinzu.',
    scanReady: 'Bereit',
    openOriginal: 'Originaldatei öffnen',
    authErrorFallback: 'Der Server ist gerade nicht erreichbar.',
    configuredRootHelp:
      'Von Docker bereitgestellte Wurzeln erscheinen hier automatisch. Das Formular brauchst du nur fuer zusaetzliche Pfade, die im Container bereits sichtbar sind.',
    configuredRootLocked: 'Diese Wurzel stammt aus deinem Docker-Setup.',
  },
} as const

type AppIconName =
  | 'library'
  | 'discover'
  | 'download'
  | 'search'
  | 'profile'
  | 'read'
  | 'settings'
  | 'key'
  | 'admin'
  | 'logout'
  | 'language'
  | 'chevronRight'
  | 'close'
  | 'more'
  | 'back'
  | 'up'
  | 'folder'
  | 'hardDrive'
  | 'pause'
  | 'play'
  | 'refresh'
  | 'check'
  | 'trash'
  | 'grid'
  | 'list'
  | 'filter'
  | 'offline'

const appIconComponents: Record<AppIconName, LucideIcon> = {
  admin: ShieldCheck,
  back: ArrowLeft,
  check: Check,
  chevronRight: ChevronRight,
  close: X,
  discover: Compass,
  download: Download,
  filter: SlidersHorizontal,
  folder: FolderOpen,
  grid: LayoutGrid,
  hardDrive: HardDrive,
  key: KeyRound,
  language: Languages,
  library: LibraryIcon,
  list: ListIcon,
  logout: LogOut,
  more: MoreVertical,
  offline: WifiOff,
  pause: Pause,
  play: Play,
  profile: UserRound,
  read: BookOpen,
  refresh: RefreshCw,
  search: SearchIcon,
  settings: SettingsIcon,
  trash: Trash2,
  up: ArrowUp,
}

const AppIcon = ({ className = '', name }: { className?: string; name: AppIconName }) => {
  const Icon = appIconComponents[name]

  return (
    <Icon
      aria-hidden="true"
      className={className ? `app-icon ${className}` : 'app-icon'}
      focusable="false"
      strokeWidth={1.9}
    />
  )
}

type CreatorProfile = {
  key: string
  name: string
  role: string | null
  categories: CategoryId[]
  series: SeriesSummary[]
}

type MountedRootSummary = AppState['sourceRoots'][number]
type ImportStepId = 'type' | 'folder' | 'review'

const normalizeFolderInput = (value: string) =>
  value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')

const joinMountedDisplayPath = (basePath: string, relativePath: string) => {
  if (!relativePath) {
    return basePath
  }

  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/'
  const normalizedBase = basePath.replace(/[\\/]+$/, '')
  const normalizedRelative = relativePath.replace(/[\\/]+/g, separator).replace(/^[\\/]+/, '')

  return `${normalizedBase}${separator}${normalizedRelative}`
}

const resolveRelativeFolderInput = (value: string, root: MountedRootSummary) => {
  const normalizedValue = normalizeFolderInput(value)
  const normalizedRoot = normalizeFolderInput(root.path)

  if (!normalizedValue) {
    return ''
  }

  const comparableValue = normalizedValue.toLowerCase()
  const comparableRoot = normalizedRoot.toLowerCase()

  if (comparableValue === comparableRoot) {
    return ''
  }

  if (comparableRoot && comparableValue.startsWith(`${comparableRoot}/`)) {
    return normalizedValue.slice(normalizedRoot.length + 1).replace(/^\/+/, '')
  }

  if (/^[a-z]:\//i.test(normalizedValue) || normalizedValue.startsWith('/')) {
    return null
  }

  return normalizedValue.replace(/^\/+/, '')
}

const getFolderLeafLabel = (relativePath: string) => {
  const segments = relativePath.split('/').filter(Boolean)
  return segments[segments.length - 1] || '/'
}

const formatRelativeTime = (value: string | null, language: Language) => {
  if (!value) {
    return language === 'de' ? 'Noch nicht gescannt' : 'Not scanned yet'
  }

  const target = new Date(value)
  const diffMs = target.getTime() - Date.now()
  const minutes = Math.round(diffMs / 60000)
  const rtf = new Intl.RelativeTimeFormat(language === 'de' ? 'de-DE' : 'en-US', {
    numeric: 'auto',
  })

  if (Math.abs(minutes) < 60) {
    return rtf.format(minutes, 'minute')
  }

  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 48) {
    return rtf.format(hours, 'hour')
  }

  const days = Math.round(hours / 24)
  return rtf.format(days, 'day')
}

const formatDateTime = (value: string | null, language: Language) => {
  if (!value) {
    return language === 'de' ? 'Noch nicht' : 'Not yet'
  }

  return new Intl.DateTimeFormat(language === 'de' ? 'de-DE' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

const formatCountLabel = (category: CategoryId, count: number, language: Language) => {
  if (language === 'de') {
    if (category === 'anime') return `${count} ${count === 1 ? 'Episode' : 'Episoden'}`
    if (category === 'manga') return `${count} ${count === 1 ? 'Band' : 'Bände'}`
    if (category === 'novels') return `${count} ${count === 1 ? 'Kapitel' : 'Kapitel'}`
    if (category === 'magazines') return `${count} ${count === 1 ? 'Ausgabe' : 'Ausgaben'}`
    return `${count} ${count === 1 ? 'Datei' : 'Dateien'}`
  }

  if (category === 'anime') return `${count} ${count === 1 ? 'episode' : 'episodes'}`
  if (category === 'manga') return `${count} ${count === 1 ? 'volume' : 'volumes'}`
  if (category === 'novels') return `${count} ${count === 1 ? 'chapter' : 'chapters'}`
  if (category === 'magazines') return `${count} ${count === 1 ? 'issue' : 'issues'}`
  return `${count} ${count === 1 ? 'file' : 'files'}`
}

const formatBytes = (value: number | null | undefined, language: Language) => {
  if (!Number.isFinite(value) || value == null || value < 0) {
    return language === 'de' ? 'Unbekannt' : 'Unknown'
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  const formatter = new Intl.NumberFormat(language === 'de' ? 'de-DE' : 'en-US', {
    maximumFractionDigits: unitIndex === 0 ? 0 : size >= 100 ? 0 : 1,
  })

  return `${formatter.format(size)} ${units[unitIndex]}`
}

const getOfflineTargetKey = (target: OfflineDownloadTarget) =>
  target.type === 'entry' ? `entry:${target.entryId}` : `series:${target.seriesId}`

const isOfflineDownloadActive = (record: OfflineDownloadRecord) =>
  record.status === 'queued' || record.status === 'downloading'

const getPrimaryResourceForEntry = (
  manifest: OfflineDownloadManifest,
  entryId: string,
) => {
  const manifestEntry = manifest.entries.find((entry) => entry.entryId === entryId)

  if (!manifestEntry) {
    return null
  }

  return manifest.resources.find((resource) => resource.key === manifestEntry.resourceKeys[0]) ?? null
}

const offlineResourceUrl = (resource: OfflineDownloadManifest['resources'][number]) =>
  isNativeApp ? resolveApiUrl(resource.url) : getOfflineResourceUrl(resource.key)

const buildOfflinePagesForEntry = (
  manifest: OfflineDownloadManifest,
  entryId: string,
) => {
  const manifestEntry = manifest.entries.find((entry) => entry.entryId === entryId)

  if (!manifestEntry || manifestEntry.format !== 'cbz') {
    return null
  }

  return manifestEntry.resourceKeys
    .map((resourceKey, index) => {
      const resource = manifest.resources.find((item) => item.key === resourceKey)

      if (!resource || resource.kind !== 'cbz-page') {
        return null
      }

      return {
        archiveIndex: index,
        name: resource.label,
        url: offlineResourceUrl(resource),
      }
    })
    .filter((page): page is { archiveIndex: number; name: string; url: string } => Boolean(page))
}

const buildOfflineSeriesDetail = (record: OfflineDownloadRecord): SeriesDetail => {
  const { manifest } = record
  const coverResource = manifest.resources.find((resource) => resource.kind === 'cover')
  const bannerResource = manifest.resources.find((resource) => resource.kind === 'banner')
  const seriesId =
    manifest.target.type === 'series'
      ? manifest.target.seriesId
      : manifest.resources.find((resource) => resource.seriesId)?.seriesId || manifest.manifestId
  const variants = manifest.entries.map((entry): LibraryEntry => {
    const primaryResource = getPrimaryResourceForEntry(manifest, entry.entryId)
    const fileUrl = primaryResource ? offlineResourceUrl(primaryResource) : '#'

    return {
      id: entry.entryId,
      label: entry.label,
      title: entry.title,
      details: `${entry.format.toUpperCase()} offline copy`,
      chapterNumber: null,
      seasonNumber: null,
      episodeNumber: null,
      preferredVariantId: entry.entryId,
      variants: [
        {
          id: entry.entryId,
          variantLabel: 'offline',
          storageFile: entry.title,
          format: entry.format,
          details: `${entry.format.toUpperCase()} offline copy`,
          fileUrl,
          downloadUrl: fileUrl,
          mediaTracks: { audio: [], subtitles: [] },
        },
      ],
    }
  })

  return {
    id: seriesId,
    title: manifest.seriesTitle,
    titleShort: manifest.seriesTitle,
    category: manifest.category,
    year: null,
    format: manifest.entries.map((entry) => entry.format.toUpperCase()).join(', '),
    status: record.status === 'ready' ? 'Downloaded' : record.status,
    progressLabel: `${manifest.entryCount} offline ${manifest.entryCount === 1 ? 'item' : 'items'}`,
    description: manifest.subtitle,
    folder: 'This device',
    coverUrl: coverResource ? offlineResourceUrl(coverResource) : null,
    bannerUrl: bannerResource ? offlineResourceUrl(bannerResource) : null,
    coverSource: 'Offline package',
    metadataSource: 'Offline package',
    externalUrl: null,
    sourceName: null,
    sourceRole: null,
    genres: [],
    tags: [],
    stats: {
      fileCount: manifest.entryCount,
      lastScanAt: record.completedAt,
    },
    entries: variants,
    comments: [],
  }
}

const buildReaderLocation = (
  category: CategoryId,
  progress: ReaderProgress,
  entryLabel: string,
) => {
  if (progress.locationType === 'percent' && progress.progressLabel && progress.cueLabel) {
    return {
      progress: progress.progressLabel,
      cue: progress.cueLabel,
    }
  }

  if (category === 'manga' && progress.viewMode === 'spread') {
    const spreadEnd =
      progress.endPage ?? (progress.page === 1 ? 1 : Math.min(progress.page + 1, progress.totalPages))
    const rangeLabel =
      spreadEnd === progress.page ? `Page ${progress.page}` : `Pages ${progress.page}-${spreadEnd}`

    return {
      progress: `${rangeLabel} of ${progress.totalPages}`,
      cue: `Bookmark set at ${rangeLabel.toLowerCase()} in spread mode`,
    }
  }

  if (category === 'anime') {
    return {
      progress: entryLabel,
      cue: `Bookmark set on ${entryLabel}`,
    }
  }

  return {
    progress: `Page ${progress.page} of ${progress.totalPages}`,
    cue: `Bookmark set at page ${progress.page}`,
  }
}

const savedPositionToReaderProgress = (
  position: SavedReadingPosition | null | undefined,
): ReaderProgress | null => {
  if (!position) {
    return null
  }

  return {
    page: position.page,
    totalPages: position.totalPages ?? 1,
    viewMode: position.viewMode,
    locationType: position.locationType,
    progressLabel: position.progressLabel,
    cueLabel: position.cueLabel,
  }
}

class ReaderErrorBoundary extends Component<
  { children: ReactNode; fallback: (message: string | null) => ReactNode; resetKey: string },
  { message: string | null }
> {
  state = { message: null }

  static getDerivedStateFromError(error: unknown) {
    return {
      message: error instanceof Error ? error.message : 'The reader hit a browser rendering issue.',
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Reader crashed', error, info.componentStack)
  }

  componentDidUpdate(previousProps: { resetKey: string }) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.message) {
      this.setState({ message: null })
    }
  }

  render() {
    if (this.state.message) {
      return this.props.fallback(this.state.message)
    }

    return this.props.children
  }
}

const genericLocalTags = new Set([
  'Local library',
  'Plex scan',
  'Local archive',
  'Reader ready',
  'Local text library',
  'Responsive reader',
  'Local book',
])

const formatDisplayEntryTitle = (title: string) => {
  const trimmedTitle = title.trim()
  const cleanedTitle = trimmedTitle.replace(
    /^(?:chapter|ch|volume|vol(?:ume)?|episode|ep|book)\s*\d+(?:\.\d+)?(?:\s*[:._-]\s*|\s+)+/i,
    '',
  ).trim()

  return cleanedTitle || trimmedTitle
}

const getBookmarkProgressHint = (bookmark: Bookmark) => {
  const progress = bookmark.progress.trim()

  if (!progress) {
    return null
  }

  if (progress === bookmark.entryLabel) {
    return null
  }

  if (/^(?:chapter|book)\s+start$/i.test(progress)) {
    return null
  }

  return progress
}

const shouldUseEntryBookmarkProgress = (category: CategoryId) =>
  category === 'manga' || category === 'novels' || category === 'magazines'

const getBookmarkEntryLabel = (category: CategoryId, language: Language) => {
  if (language === 'de') {
    return category === 'magazines' ? 'Ausgabe' : 'Kapitel'
  }

  return category === 'magazines' ? 'Issue' : 'Chapter'
}

const getBookmarkEntryUnit = (category: CategoryId, count: number, language: Language) => {
  if (language === 'de') {
    return category === 'magazines' ? (count === 1 ? 'Ausgabe' : 'Ausgaben') : 'Kapitel'
  }

  if (category === 'magazines') {
    return count === 1 ? 'issue' : 'issues'
  }

  return count === 1 ? 'chapter' : 'chapters'
}

const formatBookmarkRemaining = (category: CategoryId, remaining: number, language: Language) => {
  if (remaining <= 0) {
    return language === 'de' ? 'Abgeschlossen' : 'Complete'
  }

  const unit = getBookmarkEntryUnit(category, remaining, language)
  return language === 'de' ? `${remaining} ${unit} übrig` : `${remaining} ${unit} left`
}

const formatSeasonLabel = (seasonNumber: number, language: Language) => {
  if (seasonNumber === 0) {
    return language === 'de' ? 'Specials' : 'Specials'
  }

  return language === 'de' ? `Staffel ${seasonNumber}` : `Season ${seasonNumber}`
}

const getVisibleSeriesTags = (series: SeriesSummary) => {
  const filteredTags =
    series.metadataSource === 'Folder-derived metadata'
      ? series.tags
      : series.tags.filter((tag) => !genericLocalTags.has(tag))

  return filteredTags.slice(0, 8)
}

const normalizeBrowseToken = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

const getSeriesTopicTags = (series: SeriesSummary) => {
  const visibleTags = getVisibleSeriesTags(series)
  const combined = [...visibleTags, ...series.genres]
  const deduped = new Set<string>()
  const localAuthorHint =
    series.category === 'books'
      ? series.description.match(/^Local book file by (.+?)(?:\.)?$/i)?.[1]?.trim() || ''
      : ''
  const normalizedSourceNames = [series.sourceName || '', localAuthorHint]
    .map((value) => normalizeBrowseToken(value))
    .filter(Boolean)

  for (const tag of combined) {
    const normalizedTag = tag.trim()
    if (!normalizedTag) {
      continue
    }

    const normalizedTagKey = normalizeBrowseToken(normalizedTag)
    const normalizedTagTokens = normalizedTagKey.split('-').filter(Boolean)
    const matchesKnownSourceName = normalizedSourceNames.some((sourceName) => {
      if (
        normalizedTagKey === sourceName ||
        normalizedTagKey.includes(sourceName) ||
        sourceName.includes(normalizedTagKey)
      ) {
        return true
      }

      const sourceTokens = sourceName.split('-').filter(Boolean)
      return sourceTokens.length > 0 && sourceTokens.every((token) => normalizedTagTokens.includes(token))
    })

    if (
      genericLocalTags.has(normalizedTag) ||
      matchesKnownSourceName
    ) {
      continue
    }

    deduped.add(normalizedTag)
  }

  return [...deduped]
}

const getSeriesSourceText = (series: SeriesSummary) => {
  if (series.sourceName) {
    return series.sourceRole ? `${series.sourceRole}: ${series.sourceName}` : series.sourceName
  }

  return series.metadataSource
}

const getSeriesDisplayTitle = (series: SeriesSummary) => {
  const folderLeaf = series.folder.split(/[\\/]/).filter(Boolean).pop() || ''

  return (
    series.title.trim() ||
    series.titleShort.trim() ||
    folderLeaf.trim() ||
    series.format.trim() ||
    'Untitled'
  )
}

const getLocalSearchTokens = (query: string) =>
  query
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2)

const matchesSeriesMetadataQuery = (series: SeriesSummary, query: string) => {
  const tokens = getLocalSearchTokens(query)

  if (!tokens.length) {
    return false
  }

  const searchableText = [
    getSeriesDisplayTitle(series),
    series.description,
    series.folder,
    series.metadataSource,
    series.sourceName,
    series.sourceRole,
    series.year?.toString(),
    ...series.genres,
    ...series.tags,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase()

  return tokens.every((token) => searchableText.includes(token))
}

const getAvailableAnimeSeasons = (series: SeriesDetail | null) => {
  if (!series || series.category !== 'anime') {
    return []
  }

  return [...new Set(series.entries.map((entry) => entry.seasonNumber).filter((seasonNumber): seasonNumber is number => seasonNumber != null))].sort(
    (left, right) => left - right,
  )
}

const findEntrySelection = (
  series: SeriesDetail | null,
  targetId?: string | null,
): { entry: LibraryEntry; variant: EntryVariant } | null => {
  if (!series?.entries.length) {
    return null
  }

  const resolvePreferredVariant = (entry: LibraryEntry) =>
    entry.variants.find((variant) => variant.id === entry.preferredVariantId) || entry.variants[0]

  if (!targetId) {
    const firstEntry = series.entries[0]
    const preferredVariant = resolvePreferredVariant(firstEntry)

    return preferredVariant ? { entry: firstEntry, variant: preferredVariant } : null
  }

  for (const entry of series.entries) {
    if (entry.id === targetId) {
      const preferredVariant = resolvePreferredVariant(entry)
      return preferredVariant ? { entry, variant: preferredVariant } : null
    }

    const matchedVariant = entry.variants.find((variant) => variant.id === targetId)
    if (matchedVariant) {
      return { entry, variant: matchedVariant }
    }
  }

  const firstEntry = series.entries[0]
  const preferredVariant = resolvePreferredVariant(firstEntry)

  return preferredVariant ? { entry: firstEntry, variant: preferredVariant } : null
}

function App() {
  const [currentRoute, setCurrentRoute] = useState<AppRoute>(routeForLocation)
  const currentView: ViewId = routeView(currentRoute)
  const currentRoutePath = appRoutePath(currentRoute)
  const initialCategory = categoryForRoute(currentRoute) ?? defaultReaderCategory
  const [language, setLanguage] = useState<Language>('en')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>(
    currentRoute.name === 'signup' ? 'signup' : 'login',
  )
  const [bootstrapState, setBootstrapState] = useState<BootstrapState | null>(null)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [bootLoading, setBootLoading] = useState(true)
  const [stateError, setStateError] = useState<string | null>(null)
  const [cachedStateNeedsRefresh, setCachedStateNeedsRefresh] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [passwordChangeBusy, setPasswordChangeBusy] = useState(false)
  const [cacheResetBusy, setCacheResetBusy] = useState(false)
  const [passwordChangeError, setPasswordChangeError] = useState<string | null>(null)
  const [passwordChangeSuccess, setPasswordChangeSuccess] = useState<string | null>(null)
  const [offlineMode, setOfflineMode] = useState(false)
  const [offlineDownloads, setOfflineDownloads] = useState<OfflineDownloadRecord[]>([])
  const [offlineDownloadsLoaded, setOfflineDownloadsLoaded] = useState(false)
  const [offlineStorageSummary, setOfflineStorageSummary] =
    useState<OfflineStorageSummary | null>(null)
  const [imageCacheSummary, setImageCacheSummary] =
    useState<ImageCacheSummary | null>(null)
  const [imageCacheBusy, setImageCacheBusy] = useState(false)
  const [imageCacheTestBusy, setImageCacheTestBusy] = useState(false)
  const [imageCacheTestResult, setImageCacheTestResult] =
    useState<ImageCacheSelfTestResult | null>(null)
  const [offlineFilter, setOfflineFilter] = useState<'active' | 'ready' | 'attention' | 'all'>('all')
  const [offlineBusyIds, setOfflineBusyIds] = useState<Record<string, string>>({})
  const [offlineResumeTick, setOfflineResumeTick] = useState(0)
  const offlineRunningTargetsRef = useRef(new Set<string>())
  const offlineAbortControllersRef = useRef(new Map<string, AbortController>())
  const offlineRunCompletionRef = useRef(new Map<string, Promise<void>>())
  const offlineDeleteAllInProgressRef = useRef(false)
  const offlineRefreshRequestRef = useRef(0)
  const offlineRetryTimersRef = useRef(new Map<string, number>())
  const offlineAutoResumeGuardRef = useRef(new Set<string>())
  const deletedOfflineDownloadIdsRef = useRef(new Set<string>())
  const startOfflineDownloadRef = useRef<(
    target: OfflineDownloadTarget,
    options?: { autoResume?: boolean },
  ) => Promise<void>>(async () => undefined)
  const [offlineReaderDownloadId, setOfflineReaderDownloadId] = useState<string | null>(
    currentRoute.name === 'offlineReader' ? currentRoute.downloadId : null,
  )
  const [persistentStorageBusy, setPersistentStorageBusy] = useState(false)
  const [currentCategory, setCurrentCategory] = useState<CategoryId>(initialCategory)
  const [bookmarkFilter, setBookmarkFilter] = useState<ScopeId>(
    currentRoute.name === 'bookmarks' ? currentRoute.scope : 'all',
  )
  const [openBookmarkMenuKey, setOpenBookmarkMenuKey] = useState<string | null>(null)
  const [removingBookmarkSeriesId, setRemovingBookmarkSeriesId] = useState<string | null>(null)
  const [bookTopicFilters, setBookTopicFilters] = useState<string[]>(
    currentRoute.name === 'library' ? currentRoute.topics : [],
  )
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(
    isSeriesRoute(currentRoute) ? currentRoute.seriesId : null,
  )
  const [selectedCreatorKey, setSelectedCreatorKey] = useState<string | null>(
    currentRoute.name === 'creator' ? currentRoute.creatorKey : null,
  )
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(
    currentRoute.name === 'reader' || currentRoute.name === 'offlineReader'
      ? currentRoute.entryId
      : null,
  )
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    currentRoute.name === 'reader' || currentRoute.name === 'offlineReader'
      ? currentRoute.variantId
      : null,
  )
  const [selectedSeasonNumber, setSelectedSeasonNumber] = useState<number | null>(
    currentRoute.name === 'series' ? currentRoute.season : null,
  )
  const [activeTab, setActiveTab] = useState<SeriesTabId>(
    currentRoute.name === 'series' ? currentRoute.tab : 'entries',
  )
  const [searchQuery, setSearchQuery] = useState(
    currentRoute.name === 'search' ? currentRoute.query : '',
  )
  const [searchScope, setSearchScope] = useState<ScopeId>(
    currentRoute.name === 'search' ? currentRoute.scope : 'all',
  )
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchResults, setSearchResults] = useState<SeriesSummary[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [topbarHidden, setTopbarHidden] = useState(false)
  const [discoverSort, setDiscoverSort] = useState<'title' | 'year'>(
    currentRoute.name === 'library' ? currentRoute.sort : 'title',
  )
  const [discoverViewMode, setDiscoverViewMode] = useState<'grid' | 'list'>('grid')
  const [seriesCache, setSeriesCache] = useState<Record<string, SeriesDetail>>({})
  const [seriesError, setSeriesError] = useState<string | null>(null)
  const [seriesErrorStatus, setSeriesErrorStatus] = useState<number | null>(null)
  const [readerProgressState, setReaderProgressState] =
    useState<ReaderProgressState | null>(null)
  const [readerPreferences, setReaderPreferences] =
    useState<Record<string, ReaderSettings>>({})
  const [readerResumePosition, setReaderResumePosition] =
    useState<SavedReadingPosition | null>(null)
  const [readerResumeVariantId, setReaderResumeVariantId] = useState<string | null>(null)
  const [bookmarkJustSet, setBookmarkJustSet] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [rootLabel, setRootLabel] = useState('Media root')
  const [rootPath, setRootPath] = useState('')
  const [adminBusy, setAdminBusy] = useState(false)
  const [scanClientNotice, setScanClientNotice] = useState<ScanLogEntry | null>(null)
  const [scanPollUntil, setScanPollUntil] = useState<number | null>(null)
  const [metadataSearchQuery, setMetadataSearchQuery] = useState('')
  const [selectedMetadataSeriesId, setSelectedMetadataSeriesId] = useState<string | null>(null)
  const [metadataTitleDraft, setMetadataTitleDraft] = useState('')
  const [metadataYearDraft, setMetadataYearDraft] = useState('')
  const [metadataDescriptionDraft, setMetadataDescriptionDraft] = useState('')
  const [metadataSourceNameDraft, setMetadataSourceNameDraft] = useState('')
  const [metadataSourceRoleDraft, setMetadataSourceRoleDraft] = useState('')
  const [metadataExternalUrlDraft, setMetadataExternalUrlDraft] = useState('')
  const [metadataCoverUrlDraft, setMetadataCoverUrlDraft] = useState('')
  const [selectedRootId, setSelectedRootId] = useState<string>('')
  const [browsePath, setBrowsePath] = useState('')
  const [browseCategory, setBrowseCategory] = useState<CategoryId>('books')
  const [manualFolderPath, setManualFolderPath] = useState('')
  const [importStep, setImportStep] = useState<ImportStepId>('type')
  const [directoryListing, setDirectoryListing] = useState<{
    currentPath: string
    directories: Array<{ name: string; relativePath: string }>
  }>({
    currentPath: '',
    directories: [],
  })
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const mobileSearchInputRef = useRef<HTMLInputElement | null>(null)
  const lastScrollYRef = useRef(0)
  const historyIndexRef = useRef(0)
  const routeScrollPositionsRef = useRef(new Map<number, [number, number]>())
  const routeTransitionRef = useRef<RouteTransition>({
    focusMain: true,
    kind: 'initial',
    preserveScroll: false,
    restoreScroll: null,
  })
  const mainShellRef = useRef<HTMLElement | null>(null)
  const lastAutoSaveKeyRef = useRef<string | null>(null)
  const initializedReaderResumeKeyRef = useRef<string | null>(null)
  const readerTouchStartRef = useRef<{ edge: 'left' | 'right' | null; x: number; y: number } | null>(null)
  const lastReaderTouchToggleRef = useRef(0)
  const readerChromeTimerRef = useRef<number | null>(null)
  const readerPreferenceLoadsRef = useRef(new Set<string>())
  const readerPreferenceSaveTimersRef = useRef(new Map<string, number>())
  const pendingReaderPreferencesRef = useRef(new Map<string, ReaderSettings>())
  const scanStreamWasActiveRef = useRef(false)
  const cacheWriteTimerRef = useRef<number | null>(null)
  const [readerChromeVisible, setReaderChromeVisible] = useState(true)

  const navigateRoute = useCallback(
    (nextRoute: AppRoute, options: RouteNavigationOptions = {}) => {
      const nextPath = appRoutePath(nextRoute)
      const currentPath = `${window.location.pathname}${window.location.search}`

      if (nextPath === currentPath) {
        return
      }

      const currentRouteAtNavigation = routeForLocation()
      const currentHistoryState = historyState()
      const currentIndex = historyIndexRef.current
      const currentScroll: [number, number] = [window.scrollX, window.scrollY]
      routeScrollPositionsRef.current.set(currentIndex, currentScroll)
      window.history.replaceState(
        {
          ...currentHistoryState,
          orbitalIndex: currentIndex,
          orbitalScroll: currentScroll,
        } satisfies OrbitalHistoryState,
        '',
        currentPath,
      )

      const replace = Boolean(options.replace) ||
        shouldReplaceReaderNavigation(currentRouteAtNavigation, nextRoute)
      const nextIndex = replace ? currentIndex : currentIndex + 1
      const nextScroll: [number, number] = options.preserveScroll ? currentScroll : [0, 0]
      const nextHistoryState: OrbitalHistoryState = {
        ...currentHistoryState,
        orbitalIndex: nextIndex,
        orbitalScroll: nextScroll,
      }

      if (isReaderRoute(nextRoute)) {
        if (!isReaderRoute(currentRouteAtNavigation)) {
          nextHistoryState.orbitalReaderReturnIndex = currentIndex
          nextHistoryState.orbitalReaderReturnPath = currentPath
        }
      } else {
        delete nextHistoryState.orbitalReaderReturnIndex
        delete nextHistoryState.orbitalReaderReturnPath
      }

      if (replace) {
        window.history.replaceState(nextHistoryState, '', nextPath)
      } else {
        window.history.pushState(nextHistoryState, '', nextPath)
      }

      historyIndexRef.current = nextIndex
      routeScrollPositionsRef.current.set(nextIndex, nextScroll)
      routeTransitionRef.current = {
        focusMain: options.focusMain ?? !options.preserveScroll,
        kind: replace ? 'replace' : 'push',
        preserveScroll: Boolean(options.preserveScroll),
        restoreScroll: null,
      }
      startTransition(() => setCurrentRoute(nextRoute))
    },
    [],
  )

  useLayoutEffect(() => {
    const initialState = historyState()
    const initialIndex = initialState.orbitalIndex ?? 0
    const initialScroll: [number, number] = initialState.orbitalScroll ?? [
      window.scrollX,
      window.scrollY,
    ]

    historyIndexRef.current = initialIndex
    routeScrollPositionsRef.current.set(initialIndex, initialScroll)
    window.history.replaceState(
      {
        ...initialState,
        orbitalIndex: initialIndex,
        orbitalScroll: initialScroll,
      } satisfies OrbitalHistoryState,
      '',
      window.location.href,
    )

    const previousScrollRestoration = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'

    const handlePopState = (event: PopStateEvent) => {
      routeScrollPositionsRef.current.set(
        historyIndexRef.current,
        [window.scrollX, window.scrollY],
      )
      const nextState =
        event.state && typeof event.state === 'object'
          ? event.state as OrbitalHistoryState
          : {}
      const nextIndex = nextState.orbitalIndex ?? 0

      historyIndexRef.current = nextIndex
      routeTransitionRef.current = {
        focusMain: true,
        kind: 'pop',
        preserveScroll: false,
        restoreScroll:
          routeScrollPositionsRef.current.get(nextIndex) ??
          nextState.orbitalScroll ??
          [0, 0],
      }
      startTransition(() => setCurrentRoute(routeForLocation()))
    }

    const rememberCurrentScroll = () => {
      const currentScroll: [number, number] = [window.scrollX, window.scrollY]
      routeScrollPositionsRef.current.set(historyIndexRef.current, currentScroll)
      window.history.replaceState(
        {
          ...historyState(),
          orbitalIndex: historyIndexRef.current,
          orbitalScroll: currentScroll,
        } satisfies OrbitalHistoryState,
        '',
        window.location.href,
      )
    }

    window.addEventListener('popstate', handlePopState)
    window.addEventListener('pagehide', rememberCurrentScroll)

    return () => {
      window.history.scrollRestoration = previousScrollRestoration
      window.removeEventListener('popstate', handlePopState)
      window.removeEventListener('pagehide', rememberCurrentScroll)
    }
  }, [])

  const text = ui[language]
  const deferredSearch = useDeferredValue(searchQuery.trim())
  const sessionUser = appState?.user ?? bootstrapState?.user ?? null
  const authenticated = Boolean(sessionUser)
  const library = appState?.library ?? emptyLibrary
  const activeOfflineDownload =
    offlineReaderDownloadId
      ? offlineDownloads.find((record) => record.id === offlineReaderDownloadId) ?? null
      : null
  const activeOfflineSeries = useMemo(
    () => (activeOfflineDownload ? buildOfflineSeriesDetail(activeOfflineDownload) : null),
    [activeOfflineDownload],
  )
  const readyOfflineDownloads = useMemo(
    () => offlineDownloads.filter((record) => record.status === 'ready'),
    [offlineDownloads],
  )
  const readyOfflineLibrary = useMemo(
    () => readyOfflineDownloads.map((record) => buildOfflineSeriesDetail(record)),
    [readyOfflineDownloads],
  )
  const getReadyOfflineDownloadForEntry = useCallback(
    (entryId: string | null | undefined) => {
      if (!entryId) {
        return null
      }

      return readyOfflineDownloads.find((record) => (
        record.manifest.entries.some((entry) => entry.entryId === entryId)
      )) ?? null
    },
    [readyOfflineDownloads],
  )
  const getReadyOfflineDownloadForSeries = useCallback(
    (series: SeriesSummary | null | undefined, seriesDetail: SeriesDetail | null | undefined) => {
      if (!series) {
        return null
      }

      const directSeriesDownload = readyOfflineDownloads.find((record) => (
        record.manifest.target.type === 'series' && record.manifest.target.seriesId === series.id
      ))

      if (directSeriesDownload) {
        return directSeriesDownload
      }

      const entries = seriesDetail?.entries ?? []
      if (series.category === 'books' && entries.length === 1) {
        return getReadyOfflineDownloadForEntry(entries[0].preferredVariantId)
      }

      return readyOfflineDownloads.find((record) => (
        record.manifest.resources.some((resource) => resource.seriesId === series.id)
      )) ?? null
    },
    [getReadyOfflineDownloadForEntry, readyOfflineDownloads],
  )

  useEffect(() => {
    if (cacheWriteTimerRef.current) {
      window.clearTimeout(cacheWriteTimerRef.current)
      cacheWriteTimerRef.current = null
    }

    if (
      offlineMode ||
      cachedStateNeedsRefresh ||
      !authenticated ||
      !appState?.user ||
      appState.scanStatus.active
    ) {
      return
    }

    cacheWriteTimerRef.current = window.setTimeout(() => {
      writeCachedReaderState(appState, seriesCache)
      if (isNativeApp && appState.user) {
        void putOfflineReadingState({
          ownerUserId: appState.user.id,
          bookmarks: appState.bookmarks,
          readingPositions: appState.readingPositions,
          updatedAt: new Date().toISOString(),
        }).catch(() => undefined)
      }
      cacheWriteTimerRef.current = null
    }, 500)

    return () => {
      if (cacheWriteTimerRef.current) {
        window.clearTimeout(cacheWriteTimerRef.current)
        cacheWriteTimerRef.current = null
      }
    }
  }, [appState, authenticated, cachedStateNeedsRefresh, offlineMode, seriesCache])

  const visibleLibrary = useMemo(
    () => library.filter((series) => isReaderCategory(series.category)),
    [library],
  )
  const readerLibraryForDisplay = useMemo(
    () => offlineMode
      ? mergeOfflineLibrary(
          visibleLibrary,
          readyOfflineLibrary.filter((series) => isReaderCategory(series.category)),
        )
      : visibleLibrary,
    [offlineMode, readyOfflineLibrary, visibleLibrary],
  )

  const selectedSeriesDetail = selectedSeriesId ? seriesCache[selectedSeriesId] ?? null : null
  const selectedSeriesSummary =
    readerLibraryForDisplay.find((series) => series.id === selectedSeriesId) ??
    selectedSeriesDetail ??
    (activeOfflineSeries?.id === selectedSeriesId ? activeOfflineSeries : null)
  const selectedSeriesDisplayTitle = selectedSeriesSummary
    ? getSeriesDisplayTitle(selectedSeriesSummary)
    : null
  const { url: selectedSeriesBannerUrl } = useAuthenticatedResourceUrl(
    selectedSeriesSummary?.bannerUrl ?? null,
    { cacheMode: 'image', offlineOnly: offlineMode, ownerUserId: sessionUser?.id },
  )
  const scanStatus = appState?.scanStatus ?? null
  const scanIsActive = Boolean(scanStatus?.active)
  const selectedSeries =
    (selectedSeriesId ? seriesCache[selectedSeriesId] : null) ||
    (activeOfflineSeries?.id === selectedSeriesId ? activeOfflineSeries : null)
  const currentEntry =
    selectedSeries?.entries.find((entry) => entry.id === selectedEntryId) ??
    selectedSeries?.entries[0] ??
    null
  const currentVariant =
    currentEntry?.variants.find((variant) => variant.id === selectedVariantId) ??
    currentEntry?.variants.find((variant) => variant.id === currentEntry.preferredVariantId) ??
    currentEntry?.variants[0] ??
    null
  const readerProgress =
    currentVariant && readerProgressState?.variantId === currentVariant.id
      ? readerProgressState.progress
      : null
  const availableAnimeSeasons = getAvailableAnimeSeasons(selectedSeries)
  const visibleSeriesEntries =
    selectedSeries?.category === 'anime' && availableAnimeSeasons.length > 1 && selectedSeasonNumber != null
      ? selectedSeries.entries.filter((entry) => entry.seasonNumber === selectedSeasonNumber)
      : selectedSeries?.entries ?? []
  const selectedEntryIndex = currentEntry
    ? selectedSeries?.entries.findIndex((entry) => entry.id === currentEntry.id) ?? 0
    : 0
  const currentSavedPosition =
    currentVariant && appState?.readingPositions
      ? appState.readingPositions[currentVariant.id]
      : undefined
  const currentReaderStartPosition =
    currentVariant && readerResumeVariantId === currentVariant.id
      ? readerResumePosition
      : currentSavedPosition ?? null
  const defaultCurrentReaderSettings =
    selectedSeriesSummary && currentVariant
      ? defaultReaderSettings(selectedSeriesSummary.category, currentVariant.format)
      : defaultReaderSettings(defaultReaderCategory, 'pdf')
  const currentReaderSettings =
    selectedSeriesSummary && currentVariant
      ? settingsForFormat(
          readerPreferences[selectedSeriesSummary.id] ?? defaultCurrentReaderSettings,
          selectedSeriesSummary.category,
          currentVariant.format,
        )
      : defaultCurrentReaderSettings
  const currentOfflinePages = useMemo(
    () =>
      activeOfflineDownload?.status === 'ready' && currentVariant
        ? buildOfflinePagesForEntry(activeOfflineDownload.manifest, currentVariant.id)
        : null,
    [activeOfflineDownload?.manifest, activeOfflineDownload?.status, currentVariant],
  )
  const metadataReviewItems = appState?.metadataQueue ?? emptyMetadataReviewItems

  useEffect(() => {
    setReaderPreferences({})
    readerPreferenceLoadsRef.current.clear()
    readerPreferenceSaveTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    readerPreferenceSaveTimersRef.current.clear()
    pendingReaderPreferencesRef.current.clear()
  }, [sessionUser?.id])

  useEffect(() => {
    if (
      !authenticated ||
      offlineMode ||
      currentView !== 'reader' ||
      !selectedSeriesSummary ||
      !currentVariant
    ) {
      return
    }

    const seriesId = selectedSeriesSummary.id
    if (
      Object.prototype.hasOwnProperty.call(readerPreferences, seriesId) ||
      readerPreferenceLoadsRef.current.has(seriesId)
    ) {
      return
    }

    let disposed = false
    readerPreferenceLoadsRef.current.add(seriesId)

    void api.getReaderPreference(seriesId)
      .then((response) => {
        if (disposed) {
          return
        }

        const fallback = defaultReaderSettings(
          selectedSeriesSummary.category,
          currentVariant.format,
        )
        let preference = response.preference
          ? normalizeReaderSettings(response.preference, fallback)
          : fallback

        if (!response.preference && currentVariant.format === 'cbz') {
          try {
            const legacyStorageKey = `cbz-reader-settings:${seriesId}`
            const legacySettings = window.localStorage.getItem(legacyStorageKey)
            const migratedPreference = legacySettings
              ? migrateLegacyCbzSettings(JSON.parse(legacySettings), fallback)
              : null

            if (migratedPreference) {
              preference = migratedPreference
              void api.setReaderPreference(seriesId, migratedPreference).then(() => {
                window.localStorage.removeItem(legacyStorageKey)
              })
            }
          } catch {
            // Invalid or unavailable legacy storage must not block the reader.
          }
        }

        setReaderPreferences((previousPreferences) => ({
          ...previousPreferences,
          [seriesId]: preference,
        }))
      })
      .catch((loadError) => {
        if (!disposed) {
          setStateError(
            loadError instanceof Error
              ? loadError.message
              : 'Reader preferences could not be loaded.',
          )
        }
      })
      .finally(() => {
        readerPreferenceLoadsRef.current.delete(seriesId)
      })

    return () => {
      disposed = true
    }
  }, [
    authenticated,
    currentVariant,
    currentView,
    offlineMode,
    readerPreferences,
    selectedSeriesSummary,
  ])

  const handleReaderSettingsChange = useCallback(
    (nextSettings: ReaderSettings) => {
      if (!selectedSeriesSummary || !currentVariant) {
        return
      }

      const seriesId = selectedSeriesSummary.id
      const normalizedSettings = settingsForFormat(
        normalizeReaderSettings(nextSettings, defaultCurrentReaderSettings),
        selectedSeriesSummary.category,
        currentVariant.format,
      )

      setReaderPreferences((previousPreferences) => ({
        ...previousPreferences,
        [seriesId]: normalizedSettings,
      }))

      if (offlineMode) {
        return
      }

      pendingReaderPreferencesRef.current.set(seriesId, normalizedSettings)
      const existingTimer = readerPreferenceSaveTimersRef.current.get(seriesId)
      if (existingTimer != null) {
        window.clearTimeout(existingTimer)
      }

      const timer = window.setTimeout(() => {
        readerPreferenceSaveTimersRef.current.delete(seriesId)
        const pendingSettings = pendingReaderPreferencesRef.current.get(seriesId)
        pendingReaderPreferencesRef.current.delete(seriesId)

        if (!pendingSettings) {
          return
        }

        void api.setReaderPreference(seriesId, pendingSettings).catch((saveError) => {
          setStateError(
            saveError instanceof Error
              ? saveError.message
              : 'Reader preferences could not be saved.',
          )
        })
      }, 300)

      readerPreferenceSaveTimersRef.current.set(seriesId, timer)
    },
    [
      currentVariant,
      defaultCurrentReaderSettings,
      offlineMode,
      selectedSeriesSummary,
    ],
  )

  useEffect(
    () => () => {
      readerPreferenceSaveTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      readerPreferenceSaveTimersRef.current.clear()
      pendingReaderPreferencesRef.current.forEach((settings, seriesId) => {
        void api.setReaderPreference(seriesId, settings, { keepalive: true })
      })
      pendingReaderPreferencesRef.current.clear()
    },
    [],
  )

  useEffect(() => {
    setFilterSheetOpen(false)
    setSearchOpen(false)

    switch (currentRoute.name) {
      case 'login':
        setAuthMode('login')
        return
      case 'signup':
        setAuthMode('signup')
        return
      case 'bookmarks':
        setBookmarkFilter(currentRoute.scope)
        setOfflineReaderDownloadId(null)
        return
      case 'downloads':
        setOfflineReaderDownloadId(null)
        return
      case 'search':
        setSearchQuery(currentRoute.query)
        setSearchScope(currentRoute.scope)
        setOfflineReaderDownloadId(null)
        return
      case 'library':
        setCurrentCategory(currentRoute.category)
        setBookTopicFilters(currentRoute.category === 'books' ? currentRoute.topics : [])
        setDiscoverSort(currentRoute.sort)
        setSearchQuery('')
        setOfflineReaderDownloadId(null)
        return
      case 'series':
        setCurrentCategory(currentRoute.category)
        setSelectedSeriesId(currentRoute.seriesId)
        setActiveTab(currentRoute.tab)
        setSelectedSeasonNumber(currentRoute.season)
        setOfflineReaderDownloadId(null)
        return
      case 'reader':
        setCurrentCategory(currentRoute.category)
        setSelectedSeriesId(currentRoute.seriesId)
        setSelectedEntryId(currentRoute.entryId)
        setSelectedVariantId(currentRoute.variantId)
        setOfflineReaderDownloadId(null)
        return
      case 'offlineReader':
        setOfflineReaderDownloadId(currentRoute.downloadId)
        setSelectedEntryId(currentRoute.entryId)
        setSelectedVariantId(currentRoute.variantId)
        return
      case 'creator':
        setSelectedCreatorKey(currentRoute.creatorKey)
        setOfflineReaderDownloadId(null)
        return
      case 'root':
      case 'profile':
      case 'admin':
      case 'notFound':
        setOfflineReaderDownloadId(null)
    }
  }, [currentRoute])

  useEffect(() => {
    if (currentRoute.name === 'notFound') {
      return
    }

    const browserPath = `${window.location.pathname}${window.location.search}`
    if (browserPath !== currentRoutePath) {
      navigateRoute(currentRoute, {
        replace: true,
        preserveScroll: true,
        focusMain: false,
      })
    }
  }, [currentRoute, currentRoutePath, navigateRoute])

  useEffect(() => {
    if (!appState || !isSeriesRoute(currentRoute)) {
      return
    }

    const summary = library.find((series) => series.id === currentRoute.seriesId)
    if (
      !summary ||
      !isReaderCategory(summary.category) ||
      summary.category === currentRoute.category
    ) {
      return
    }

    navigateRoute(
      {
        ...currentRoute,
        category: categoryRouteId(summary.category),
      },
      { replace: true, preserveScroll: true, focusMain: false },
    )
  }, [appState, currentRoute, library, navigateRoute])

  useEffect(() => {
    if (
      currentRoute.name !== 'reader' ||
      !selectedSeries ||
      selectedSeries.id !== currentRoute.seriesId
    ) {
      return
    }

    const routedEntry = selectedSeries.entries.find(
      (entry) =>
        entry.id === currentRoute.entryId ||
        entry.variants.some((variant) => variant.id === currentRoute.entryId),
    )
    if (!routedEntry) {
      return
    }

    const requestedVariantId =
      currentRoute.variantId ??
      routedEntry.variants.find((variant) => variant.id === currentRoute.entryId)?.id ??
      null
    const requestedVariant = requestedVariantId
      ? routedEntry.variants.find((variant) => variant.id === requestedVariantId) ?? null
      : null
    const nextVariant =
      requestedVariant ??
      routedEntry.variants.find((variant) => variant.id === routedEntry.preferredVariantId) ??
      routedEntry.variants[0] ??
      null

    setSelectedEntryId(routedEntry.id)
    setSelectedVariantId(nextVariant?.id ?? null)

    const canonicalVariantId =
      nextVariant && nextVariant.id !== routedEntry.preferredVariantId
        ? nextVariant.id
        : null
    if (
      canonicalVariantId !== currentRoute.variantId ||
      routedEntry.id !== currentRoute.entryId
    ) {
      navigateRoute(
        {
          ...currentRoute,
          entryId: routedEntry.id,
          variantId: canonicalVariantId,
        },
        { replace: true, preserveScroll: true, focusMain: false },
      )
    }
  }, [currentRoute, navigateRoute, selectedSeries])

  useEffect(() => {
    if (
      currentRoute.name !== 'offlineReader' ||
      !activeOfflineDownload ||
      activeOfflineDownload.status !== 'ready' ||
      !activeOfflineSeries
    ) {
      return
    }

    const routedEntry = activeOfflineSeries.entries.find(
      (entry) => entry.id === currentRoute.entryId,
    )
    if (!routedEntry) {
      return
    }

    const requestedVariant = currentRoute.variantId
      ? routedEntry.variants.find((variant) => variant.id === currentRoute.variantId) ?? null
      : null
    const nextVariant =
      requestedVariant ??
      routedEntry.variants.find((variant) => variant.id === routedEntry.preferredVariantId) ??
      routedEntry.variants[0] ??
      null

    startTransition(() => {
      setSeriesCache((previousCache) => ({
        ...previousCache,
        [activeOfflineSeries.id]: activeOfflineSeries,
      }))
      setSelectedSeriesId(activeOfflineSeries.id)
      setCurrentCategory(activeOfflineSeries.category)
      setSelectedEntryId(routedEntry.id)
      setSelectedVariantId(nextVariant?.id ?? null)
    })

    const canonicalVariantId =
      nextVariant && nextVariant.id !== routedEntry.preferredVariantId
        ? nextVariant.id
        : null
    if (canonicalVariantId !== currentRoute.variantId) {
      navigateRoute(
        {
          ...currentRoute,
          variantId: canonicalVariantId,
        },
        { replace: true, preserveScroll: true, focusMain: false },
      )
    }
  }, [
    activeOfflineDownload,
    activeOfflineSeries,
    currentRoute,
    navigateRoute,
  ])

  const metadataSearchResults = metadataSearchQuery.trim()
    ? library
        .filter((series) => matchesSeriesMetadataQuery(series, metadataSearchQuery))
        .slice(0, 10)
    : []
  const selectedMetadataSeries =
    (selectedMetadataSeriesId
      ? library.find((series) => series.id === selectedMetadataSeriesId) ?? null
      : null) ||
    (metadataReviewItems[0]
      ? library.find((series) => series.id === metadataReviewItems[0].id) ?? null
      : null)
  const creatorProfiles = Object.values(
    readerLibraryForDisplay.reduce<Record<string, CreatorProfile>>((profiles, series) => {
      if (!series.sourceName) {
        return profiles
      }

      const key = normalizeBrowseToken(series.sourceName)
      if (!key) {
        return profiles
      }

      const existingProfile = profiles[key]
      if (existingProfile) {
        if (!existingProfile.categories.includes(series.category)) {
          existingProfile.categories.push(series.category)
          existingProfile.categories.sort(
            (left, right) => categoryOrder.indexOf(left) - categoryOrder.indexOf(right),
          )
        }

        existingProfile.series.push(series)
        if (!existingProfile.role && series.sourceRole) {
          existingProfile.role = series.sourceRole
        }
        return profiles
      }

      profiles[key] = {
        key,
        name: series.sourceName,
        role: series.sourceRole,
        categories: [series.category],
        series: [series],
      }
      return profiles
    }, {}),
  )
    .map((profile) => ({
      ...profile,
      series: [...profile.series].sort((left, right) => left.title.localeCompare(right.title)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const selectedCreatorProfile =
    (selectedCreatorKey
      ? creatorProfiles.find((profile) => profile.key === selectedCreatorKey) ?? null
      : null)
  const selectedSeriesCreatorProfile =
    selectedSeriesSummary?.sourceName
      ? creatorProfiles.find((profile) => profile.key === normalizeBrowseToken(selectedSeriesSummary.sourceName || '')) ?? null
      : null
  const relatedCreatorSeries = selectedSeriesSummary
    ? (selectedSeriesCreatorProfile?.series.filter((series) => series.id !== selectedSeriesSummary.id) ?? []).slice(0, 6)
    : []
  const bookTopicOptions = [...new Set(
    readerLibraryForDisplay
      .filter((series) => series.category === 'books')
      .flatMap((series) => getSeriesTopicTags(series)),
  )].sort((left, right) => left.localeCompare(right))

  const toBootstrapState = (nextState: AppState | BootstrapState): BootstrapState => ({
    appName: nextState.appName,
    bootstrapAdmin: nextState.bootstrapAdmin,
    openSignup: nextState.openSignup,
    user: nextState.user,
    csrfToken: nextState.csrfToken,
  })

  useEffect(() => {
    let active = true
    let remoteLoadStarted = false

    const applyOfflineProfile = async (offlineProfile: SessionUser) => {
      const localState = offlineStateForProfile(offlineProfile)
      const readingState = await getOfflineReadingState(offlineProfile.id).catch(() => null)
      const cachedReaderState = readCachedReaderState(localState.bootstrapState)
      const hasPersistedOfflineReadingState = Boolean(
        readingState && readingState.updatedAt !== emptyOfflineReadingStateUpdatedAt,
      )
      const offlineBookmarks = hasPersistedOfflineReadingState
        ? readingState?.bookmarks ?? []
        : cachedReaderState?.appState.bookmarks ?? []
      const offlineReadingPositions = hasPersistedOfflineReadingState
        ? readingState?.readingPositions ?? {}
        : cachedReaderState?.appState.readingPositions ?? {}
      const cachedAppState = cachedReaderState?.appState
      const restoredAppState: AppState = cachedAppState
        ? {
            ...cachedAppState,
            appName: localState.appState.appName,
            bootstrapAdmin: localState.appState.bootstrapAdmin,
            openSignup: false,
            user: offlineProfile,
            csrfToken: null,
            scanStatus: cachedAppState.scanStatus.active ? emptyScanStatus : cachedAppState.scanStatus,
            sourceRoots: [],
            sourceFolders: [],
            users: [],
            metadataQueue: [],
          }
        : localState.appState
      api.setCsrfToken(null)
      setBootstrapState(localState.bootstrapState)
      setSeriesCache(cachedReaderState?.seriesCache ?? {})
      setAppState(
        {
          ...restoredAppState,
          bookmarks: offlineBookmarks,
          readingPositions: offlineReadingPositions,
        },
      )
      setOfflineMode(true)
      const currentLocation = routeForLocation()
      if (
        currentLocation.name !== 'bookmarks' &&
        currentLocation.name !== 'downloads' &&
        currentLocation.name !== 'offlineReader'
      ) {
        navigateRoute({ name: 'bookmarks', scope: 'all' }, { replace: true })
      }
      setCachedStateNeedsRefresh(false)
      setStateError(text.offlineModeHelp)
    }

    const loadRemoteBootstrap = async () => {
      if (remoteLoadStarted) {
        return
      }

      remoteLoadStarted = true

      try {
        const nextState = await api.getBootstrap()

        if (!active) {
          return
        }

        api.setCsrfToken(nextState.csrfToken)
        setBootstrapState(nextState)
        setOfflineMode(false)
        const cachedReaderState = readCachedReaderState(nextState)

        if (cachedReaderState) {
          setAppState(cachedReaderState.appState)
          setSeriesCache(cachedReaderState.seriesCache)
          setCachedStateNeedsRefresh(true)
        } else {
          setCachedStateNeedsRefresh(true)
        }

        setStateError(null)
      } catch (error) {
        if (active) {
          setStateError(
            error instanceof ApiError && error.status != null
              ? error.message
              : text.offlineModeHelp,
          )
        }
      }
    }

    const loadBootstrap = async () => {
      setBootLoading(true)

      const localProfile = isNativeApp
        ? await getLastOfflineProfile().catch(() => null)
        : null

      if (localProfile) {
        await applyOfflineProfile(localProfile)
        setBootLoading(false)

        if (navigator.onLine) {
          void loadRemoteBootstrap()
        }

        window.addEventListener('online', loadRemoteBootstrap)
        return
      }

      try {
        const nextState = await api.getBootstrap()

        if (!active) {
          return
        }

        api.setCsrfToken(nextState.csrfToken)
        setBootstrapState(nextState)
        setOfflineMode(false)
        const cachedReaderState = readCachedReaderState(nextState)

        if (cachedReaderState) {
          setAppState(cachedReaderState.appState)
          setSeriesCache(cachedReaderState.seriesCache)
          setCachedStateNeedsRefresh(true)
        }

        setStateError(null)
      } catch (error) {
        if (!active) {
          return
        }

        const offlineProfile = await getLastOfflineProfile().catch(() => null)

        if (offlineProfile) {
          await applyOfflineProfile(offlineProfile)
          return
        }

        setStateError(error instanceof Error ? error.message : text.authErrorFallback)
      } finally {
        if (active) {
          setBootLoading(false)
        }
      }
    }

    void loadBootstrap()

    return () => {
      active = false
      window.removeEventListener('online', loadRemoteBootstrap)
    }
  }, [navigateRoute, text.authErrorFallback, text.offlineModeHelp])

  useEffect(() => {
    if (offlineMode) {
      setCachedStateNeedsRefresh(false)
      return
    }

    if (!bootstrapState?.user) {
      setCachedStateNeedsRefresh(false)
      return
    }

    if (appState && !cachedStateNeedsRefresh) {
      return
    }

    let active = true

    const syncLocalReadingState = async (nextState: AppState) => {
      if (!isNativeApp || !nextState.user) {
        return nextState
      }

      const localState = await getOfflineReadingState(nextState.user.id)
      if (!localState.bookmarks.length) {
        return nextState
      }

      try {
        const bookmarksToSync = selectNewerBookmarksForSync(
          localState.bookmarks,
          nextState.bookmarks,
        )

        for (const bookmark of bookmarksToSync) {
          await api.setBookmark({
            seriesId: bookmark.seriesId,
            entryId: bookmark.entryId,
            entryIndex: bookmark.entryIndex,
            category: bookmark.category,
            progress: bookmark.progress,
            cue: bookmark.cue,
            position: localState.readingPositions[bookmark.entryId] || { page: 1 },
            lastSeen: bookmark.lastSeen,
          })
        }

        return bookmarksToSync.length ? await api.getState() : nextState
      } catch {
        return nextState
      }
    }

    const loadState = async () => {
      try {
        const nextState = await api.getState()

        if (!active) {
          return
        }

        api.setCsrfToken(nextState.csrfToken)
        const syncedState = await syncLocalReadingState(nextState)
        if (!active) {
          return
        }

        api.setCsrfToken(syncedState.csrfToken)
        setBootstrapState(toBootstrapState(syncedState))
        setAppState(syncedState)
        setCachedStateNeedsRefresh(false)
        setSeriesCache((previousCache) => pruneSeriesCacheForLibrary(previousCache, syncedState.library))
        setStateError(null)
      } catch (error) {
        if (!active) {
          return
        }

        setStateError(error instanceof Error ? error.message : text.authErrorFallback)
      }
    }

    void loadState()

    return () => {
      active = false
    }
  }, [appState, bootstrapState, cachedStateNeedsRefresh, offlineMode, text.authErrorFallback])

  useEffect(() => {
    if (bootLoading || !bootstrapState) {
      return
    }

    if (!authenticated) {
      if (currentRoute.name === 'root') {
        navigateRoute({ name: 'login', next: null }, { replace: true })
        return
      }

      if (currentRoute.name === 'signup') {
        if (!bootstrapState.openSignup) {
          navigateRoute({ name: 'login', next: null }, { replace: true })
        }
        return
      }

      if (currentRoute.name === 'login') {
        return
      }

      if (isProtectedRoute(currentRoute)) {
        navigateRoute(
          {
            name: 'login',
            next: `${window.location.pathname}${window.location.search}`,
          },
          { replace: true },
        )
      }
      return
    }

    if (currentRoute.name === 'root' || currentRoute.name === 'signup') {
      navigateRoute({ name: 'bookmarks', scope: 'all' }, { replace: true })
      return
    }

    if (currentRoute.name === 'login') {
      const destination = currentRoute.next
        ? parseAppRoute(new URL(currentRoute.next, window.location.origin))
        : null

      navigateRoute(
        destination && isProtectedRoute(destination)
          ? destination
          : { name: 'bookmarks', scope: 'all' },
        { replace: true },
      )
    }
  }, [
    authenticated,
    bootLoading,
    bootstrapState,
    currentRoute,
    navigateRoute,
  ])

  const refreshOfflineDownloads = useCallback(async () => {
    const refreshRequest = ++offlineRefreshRequestRef.current

    if (!sessionUser) {
      if (refreshRequest !== offlineRefreshRequestRef.current) {
        return
      }
      setOfflineDownloads([])
      setOfflineStorageSummary(null)
      setImageCacheSummary(null)
      setOfflineDownloadsLoaded(true)
      return
    }

    setOfflineDownloadsLoaded(false)

    try {
      const [downloads, summary, covers] = await Promise.all([
        listOfflineDownloads(sessionUser.id),
        getOfflineStorageSummary(sessionUser.id),
        getImageCacheSummary(sessionUser.id),
      ])

      if (refreshRequest !== offlineRefreshRequestRef.current) {
        return
      }

      setOfflineDownloads(downloads)
      setOfflineStorageSummary(summary)
      setImageCacheSummary(covers)
    } catch (error) {
      if (refreshRequest === offlineRefreshRequestRef.current && !offlineMode) {
        setStateError(error instanceof Error ? error.message : text.authErrorFallback)
      }
    } finally {
      if (refreshRequest === offlineRefreshRequestRef.current) {
        setOfflineDownloadsLoaded(true)
      }
    }
  }, [offlineMode, sessionUser, text.authErrorFallback])

  useEffect(() => {
    void refreshOfflineDownloads()
  }, [refreshOfflineDownloads])

  useEffect(() => {
    if (currentView !== 'downloads' || !sessionUser) {
      return
    }

    void getImageCacheSummary(sessionUser.id).then(setImageCacheSummary).catch(() => undefined)
  }, [currentView, sessionUser])

  useEffect(() => {
    if (!sessionUser || currentView !== 'downloads') {
      return
    }

    let refreshTimer: number | null = null
    const handleImageCacheChanged = (event: Event) => {
      const ownerUserId = (event as CustomEvent<{ ownerUserId?: string }>).detail?.ownerUserId
      if (ownerUserId !== sessionUser.id) {
        return
      }

      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer)
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        void getImageCacheSummary(sessionUser.id).then(setImageCacheSummary).catch(() => undefined)
      }, 150)
    }

    window.addEventListener(imageCacheChangedEvent, handleImageCacheChanged)
    return () => {
      window.removeEventListener(imageCacheChangedEvent, handleImageCacheChanged)
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer)
      }
    }
  }, [currentView, sessionUser])

  useEffect(() => {
    const shouldPollForTransportRecovery =
      scanPollUntil != null && Date.now() < scanPollUntil

    if (scanPollUntil != null && !scanIsActive && !shouldPollForTransportRecovery) {
      setScanPollUntil(null)
      return
    }

    if (
      !authenticated ||
      appState?.user?.role !== 'admin' ||
      (!scanIsActive && !shouldPollForTransportRecovery)
    ) {
      return
    }

    let active = true
    let timeout = 0

    const pollState = async () => {
      try {
        const { scanStatus: nextScanStatus } = await api.getScanStatus()

        if (!active) {
          return
        }

        setAppState((previousState) =>
          previousState
            ? {
                ...previousState,
                scanStatus: nextScanStatus,
              }
            : previousState,
        )

        if (!nextScanStatus.active && (scanIsActive || scanPollUntil != null)) {
          const nextState = await api.getState()

          if (!active) {
            return
          }

          api.setCsrfToken(nextState.csrfToken)
          setBootstrapState(toBootstrapState(nextState))
          setAppState(nextState)
          setSeriesCache((previousCache) => pruneSeriesCacheForLibrary(previousCache, nextState.library))
          setScanClientNotice(null)
        }

        const shouldKeepPolling =
          nextScanStatus.active ||
          (scanPollUntil != null && Date.now() < scanPollUntil)

        if (shouldKeepPolling) {
          timeout = window.setTimeout(pollState, nextScanStatus.active ? 1250 : 2000)
        } else if (scanPollUntil != null) {
          setScanPollUntil(null)
        }
      } catch {
        if (active) {
          const shouldRetry =
            scanIsActive || (scanPollUntil != null && Date.now() < scanPollUntil)

          if (shouldRetry) {
            timeout = window.setTimeout(pollState, 2000)
          } else if (scanPollUntil != null) {
            setScanPollUntil(null)
          }
        }
      }
    }

    timeout = window.setTimeout(pollState, 1250)

    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [appState?.user?.role, authenticated, scanIsActive, scanPollUntil])

  useEffect(() => {
    if (
      !authenticated ||
      appState?.user?.role !== 'admin' ||
      typeof EventSource === 'undefined'
    ) {
      return
    }

    let active = true
    scanStreamWasActiveRef.current = false
    const eventSource = new EventSource('/api/admin/scan/events', { withCredentials: true })

    const refreshFullState = async () => {
      try {
        const nextState = await api.getState()

        if (!active) {
          return
        }

        api.setCsrfToken(nextState.csrfToken)
        setBootstrapState({
          appName: nextState.appName,
          bootstrapAdmin: nextState.bootstrapAdmin,
          openSignup: nextState.openSignup,
          user: nextState.user,
          csrfToken: nextState.csrfToken,
        })
        setAppState(nextState)
        setSeriesCache((previousCache) => pruneSeriesCacheForLibrary(previousCache, nextState.library))
      } catch {
        setScanPollUntil(Date.now() + 30000)
      }
    }

    eventSource.addEventListener('status', (message) => {
      const nextScanStatus = JSON.parse((message as MessageEvent<string>).data) as ScanStatus
      const wasActive = scanStreamWasActiveRef.current
      scanStreamWasActiveRef.current = nextScanStatus.active

      setAppState((previousState) =>
        previousState
          ? {
              ...previousState,
              scanStatus: nextScanStatus,
            }
          : previousState,
      )

      if (!nextScanStatus.active && wasActive) {
        setScanPollUntil(null)
        setScanClientNotice(null)
        void refreshFullState()
      }
    })

    eventSource.addEventListener('error', () => {
      setScanPollUntil(Date.now() + 30000)
    })

    return () => {
      active = false
      eventSource.close()
    }
  }, [appState?.user?.role, authenticated])

  useEffect(() => {
    if (!selectedSeries || selectedSeries.category !== 'anime') {
      setSelectedSeasonNumber(null)
      return
    }

    const seasons = getAvailableAnimeSeasons(selectedSeries)

    if (seasons.length <= 1) {
      setSelectedSeasonNumber(seasons[0] ?? null)
      return
    }

    setSelectedSeasonNumber((previousSeasonNumber) =>
      previousSeasonNumber != null && seasons.includes(previousSeasonNumber)
        ? previousSeasonNumber
        : seasons[0],
    )
  }, [selectedSeries])

  useEffect(() => {
    if (!authenticated || !deferredSearch) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }

    let active = true
    setSearchLoading(true)

    void api
      .search(deferredSearch, searchScope)
      .then((response) => {
        if (active) {
          setSearchResults(response.results)
        }
      })
      .catch(() => {
        if (active) {
          setSearchResults([])
        }
      })
      .finally(() => {
        if (active) {
          setSearchLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [authenticated, deferredSearch, searchScope])

  useEffect(() => {
    if (!isReaderCategory(currentCategory)) {
      setCurrentCategory(defaultReaderCategory)
    }
  }, [currentCategory])

  useEffect(() => {
    if (bookmarkFilter !== 'all' && !isReaderCategory(bookmarkFilter)) {
      setBookmarkFilter('all')
    }
  }, [bookmarkFilter])

  useEffect(() => {
    setOpenBookmarkMenuKey(null)
  }, [bookmarkFilter, currentView])

  useEffect(() => {
    if (searchScope !== 'all' && !isReaderCategory(searchScope)) {
      setSearchScope('all')
    }
  }, [searchScope])

  useEffect(() => {
    if (!isReaderCategory(browseCategory)) {
      setBrowseCategory(defaultReaderCategory)
    }
  }, [browseCategory])

  useEffect(() => {
    if (!authenticated || currentView === 'reader' || searchOpen || filterSheetOpen) {
      setTopbarHidden(false)
      return
    }

    const mobileQuery = window.matchMedia('(max-width: 900px)')

    const syncTopbar = () => {
      if (!mobileQuery.matches) {
        setTopbarHidden(false)
        return
      }

      const nextScrollY = window.scrollY
      const delta = nextScrollY - lastScrollYRef.current

      if (nextScrollY < 32 || delta < -8) {
        setTopbarHidden(false)
      } else if (nextScrollY > 120 && delta > 8) {
        setTopbarHidden(true)
      }

      lastScrollYRef.current = nextScrollY
    }

    lastScrollYRef.current = window.scrollY
    window.addEventListener('scroll', syncTopbar, { passive: true })
    mobileQuery.addEventListener('change', syncTopbar)
    syncTopbar()

    return () => {
      window.removeEventListener('scroll', syncTopbar)
      mobileQuery.removeEventListener('change', syncTopbar)
    }
  }, [authenticated, currentView, filterSheetOpen, searchOpen])

  useEffect(() => {
    if (!appState?.sourceRoots.length) {
      setSelectedRootId('')
      setBrowsePath('')
      setDirectoryListing({ currentPath: '', directories: [] })
      return
    }

    setSelectedRootId((previousRootId) => {
      const existingRoot = appState.sourceRoots.find((root) => root.id === previousRootId)
      const managedRoot = appState.sourceRoots.find((root) => root.managed)

      if (existingRoot?.managed) {
        return existingRoot.id
      }

      return (managedRoot || existingRoot || appState.sourceRoots[0]).id
    })
  }, [appState?.sourceRoots])

  useEffect(() => {
    if (
      currentView !== 'admin' ||
      !authenticated ||
      appState?.user?.role !== 'admin' ||
      !selectedRootId
    ) {
      return
    }

    let active = true

    void api
      .listDirectories(selectedRootId, browsePath)
      .then((listing) => {
        if (active) {
          setDirectoryListing(listing)
        }
      })
      .catch(() => {
        if (active) {
          setDirectoryListing({ currentPath: browsePath, directories: [] })
        }
      })

    return () => {
      active = false
    }
  }, [appState?.user?.role, authenticated, browsePath, currentView, selectedRootId])

  useEffect(() => {
    if (
      !selectedSeriesId ||
      !authenticated ||
      offlineMode ||
      seriesCache[selectedSeriesId] ||
      activeOfflineSeries?.id === selectedSeriesId
    ) {
      return
    }

    let active = true
    setSeriesError(null)
    setSeriesErrorStatus(null)

    void api
      .getSeries(selectedSeriesId)
      .then((response) => {
        if (!active) {
          return
        }

        setSeriesCache((previousCache) => ({
          ...previousCache,
          [response.series.id]: response.series,
        }))
        setSeriesErrorStatus(null)
        setSelectedEntryId((previousEntryId) => previousEntryId || response.series.entries[0]?.id || null)
        setSelectedVariantId((previousVariantId) => {
          if (
            previousVariantId &&
            response.series.entries.some((entry) =>
              entry.variants.some((variant) => variant.id === previousVariantId),
            )
          ) {
            return previousVariantId
          }

          return response.series.entries[0]?.preferredVariantId || null
        })
      })
      .catch((error) => {
        if (active) {
          setSeriesError(error instanceof Error ? error.message : text.loadingSeries)
          setSeriesErrorStatus(error instanceof ApiError ? error.status : null)
        }
      })
    return () => {
      active = false
    }
  }, [activeOfflineSeries?.id, authenticated, offlineMode, selectedSeriesId, seriesCache, text.loadingSeries])

  useEffect(() => {
    if (!selectedSeries || !selectedSeries.entries.length) {
      setSelectedEntryId(null)
      setSelectedVariantId(null)
      return
    }

    const routedEntryId =
      currentRoute.name === 'reader' || currentRoute.name === 'offlineReader'
        ? currentRoute.entryId
        : null
    if (
      routedEntryId &&
      !selectedSeries.entries.some(
        (entry) =>
          entry.id === routedEntryId ||
          entry.variants.some((variant) => variant.id === routedEntryId),
      )
    ) {
      return
    }

    const resolvedSelection = findEntrySelection(selectedSeries, selectedEntryId)

    if (!resolvedSelection) {
      setSelectedEntryId(selectedSeries.entries[0].id)
      setSelectedVariantId(selectedSeries.entries[0].preferredVariantId)
      return
    }

    if (resolvedSelection.entry.id !== selectedEntryId) {
      setSelectedEntryId(resolvedSelection.entry.id)
    }

    setSelectedVariantId((previousVariantId) => {
      if (
        previousVariantId &&
        resolvedSelection.entry.variants.some((variant) => variant.id === previousVariantId)
      ) {
        return previousVariantId
      }

      return resolvedSelection.variant.id
    })
  }, [currentRoute, selectedEntryId, selectedSeries])

  useEffect(() => {
    if (!currentEntry) {
      setSelectedVariantId(null)
      return
    }

    if (!selectedVariantId || !currentEntry.variants.some((variant) => variant.id === selectedVariantId)) {
      setSelectedVariantId(currentEntry.preferredVariantId)
    }
  }, [currentEntry, selectedVariantId])

  useEffect(() => {
    if (activeOfflineSeries?.id === selectedSeriesId) {
      return
    }

    if (isSeriesRoute(currentRoute)) {
      if (selectedSeriesId !== currentRoute.seriesId) {
        setSelectedSeriesId(currentRoute.seriesId)
      }
      return
    }

    if (selectedSeriesId !== null) {
      setSelectedSeriesId(null)
    }
  }, [activeOfflineSeries?.id, currentRoute, selectedSeriesId])

  useEffect(() => {
    if (selectedMetadataSeriesId && library.some((series) => series.id === selectedMetadataSeriesId)) {
      return
    }

    setSelectedMetadataSeriesId(metadataReviewItems[0]?.id || library[0]?.id || null)
  }, [library, metadataReviewItems, selectedMetadataSeriesId])

  useEffect(() => {
    if (!selectedMetadataSeries) {
      return
    }

    setMetadataTitleDraft(selectedMetadataSeries.title)
    setMetadataYearDraft(selectedMetadataSeries.year != null ? String(selectedMetadataSeries.year) : '')
    setMetadataDescriptionDraft(selectedMetadataSeries.description)
    setMetadataSourceNameDraft(selectedMetadataSeries.sourceName || '')
    setMetadataSourceRoleDraft(selectedMetadataSeries.sourceRole || '')
    setMetadataExternalUrlDraft(selectedMetadataSeries.externalUrl || '')
    setMetadataCoverUrlDraft('')
  }, [selectedMetadataSeries])

  useEffect(() => {
    if (currentView === 'reader') {
      return
    }

    const progress = savedPositionToReaderProgress(currentSavedPosition)
    setReaderProgressState(
      currentVariant && progress
        ? { progress, variantId: currentVariant.id }
        : null,
    )
  }, [currentSavedPosition, currentVariant, currentView])

  const clearReaderChromeTimer = useCallback(() => {
    if (readerChromeTimerRef.current == null) {
      return
    }

    window.clearTimeout(readerChromeTimerRef.current)
    readerChromeTimerRef.current = null
  }, [])

  const revealReaderChrome = useCallback(() => {
    clearReaderChromeTimer()
    setReaderChromeVisible(true)
  }, [clearReaderChromeTimer])

  const toggleReaderChrome = useCallback(() => {
    clearReaderChromeTimer()
    setReaderChromeVisible((visible) => !visible)
  }, [clearReaderChromeTimer])

  useEffect(() => {
    if (currentView !== 'reader') {
      clearReaderChromeTimer()
      setReaderChromeVisible(true)
      return
    }

    revealReaderChrome()

    return clearReaderChromeTimer
  }, [
    clearReaderChromeTimer,
    currentEntry?.id,
    currentVariant?.id,
    currentView,
    revealReaderChrome,
  ])

  useEffect(() => {
    const currentVariantId = currentVariant?.id ?? null
    const routedEntryId =
      currentRoute.name === 'reader' || currentRoute.name === 'offlineReader'
        ? currentRoute.entryId
        : null
    const resumeKey =
      currentView === 'reader' && routedEntryId === currentEntry?.id
        ? readerContentSessionKey(currentRoute, currentVariantId)
        : null

    if (!resumeKey || !currentVariantId) {
      initializedReaderResumeKeyRef.current = null
      return
    }

    if (initializedReaderResumeKeyRef.current === resumeKey) {
      return
    }
    initializedReaderResumeKeyRef.current = resumeKey

    const savedPosition = appState?.readingPositions?.[currentVariantId] ?? null
    const resumePosition = routeReadingPosition(currentRoute, savedPosition)

    setReaderResumeVariantId(currentVariantId)
    setReaderResumePosition(resumePosition)
    const progress = savedPositionToReaderProgress(resumePosition)
    setReaderProgressState(progress ? { progress, variantId: currentVariantId } : null)
    setBookmarkJustSet(false)
    lastAutoSaveKeyRef.current = null
  }, [
    appState?.readingPositions,
    currentRoute,
    currentEntry?.id,
    currentVariant?.id,
    currentView,
  ])

  useEffect(() => {
    setBookmarkJustSet(false)
  }, [selectedEntryId, selectedVariantId])

  useLayoutEffect(() => {
    if (!authenticated) {
      return
    }

    const transition = routeTransitionRef.current
    if (transition.preserveScroll) {
      return
    }

    let frame = 0
    let correctionFrame = 0
    let timeout = 0
    const targetScroll = transition.restoreScroll ?? [0, 0]

    const applyRoutePosition = () => {
      window.scrollTo({
        top: targetScroll[1],
        left: targetScroll[0],
        behavior: 'auto',
      })
    }

    applyRoutePosition()
    frame = window.requestAnimationFrame(() => {
      applyRoutePosition()
      if (transition.focusMain) {
        mainShellRef.current?.focus({ preventScroll: true })
      }
      correctionFrame = window.requestAnimationFrame(applyRoutePosition)
      timeout = window.setTimeout(applyRoutePosition, 120)
    })

    return () => {
      window.cancelAnimationFrame(frame)
      window.cancelAnimationFrame(correctionFrame)
      window.clearTimeout(timeout)
    }
  }, [authenticated, currentRoutePath])

  const categoryLabel = (category: CategoryId) => text.scopes[category]

  const applyState = (nextState: AppState) => {
    api.setCsrfToken(nextState.csrfToken)
    setBootstrapState(toBootstrapState(nextState))
    setAppState(nextState)
    setCachedStateNeedsRefresh(false)
    setSeriesCache((previousCache) => pruneSeriesCacheForLibrary(previousCache, nextState.library))
    if (isSeriesRoute(currentRoute)) {
      setSelectedSeriesId(currentRoute.seriesId)
    }
  }

  const handleAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const payload = {
      username: String(formData.get('username') || ''),
      password: String(formData.get('password') || ''),
    }

    try {
      setAuthBusy(true)
      setAuthError(null)
      const nextState =
        authMode === 'signup' ? await api.signup(payload) : await api.login(payload)

      applyState(nextState)
      const requestedDestination =
        currentRoute.name === 'login' && currentRoute.next
          ? parseAppRoute(new URL(currentRoute.next, window.location.origin))
          : null
      navigateRoute(
        requestedDestination && isProtectedRoute(requestedDestination)
          ? requestedDestination
          : { name: 'bookmarks', scope: 'all' },
        { replace: true },
      )
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAuthBusy(false)
    }
  }

  const handleLogout = async () => {
    offlineAbortControllersRef.current.forEach((controller) => controller.abort())
    offlineRetryTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    offlineRetryTimersRef.current.clear()

    if (cacheWriteTimerRef.current) {
      window.clearTimeout(cacheWriteTimerRef.current)
      cacheWriteTimerRef.current = null
    }

    await api.logout()
    await clearImageCache(sessionUser?.id)
    clearCachedReaderState(sessionUser?.id)
    clearReaderSessionCaches()
    const nextBootstrap = await api.getBootstrap()
    api.setCsrfToken(nextBootstrap.csrfToken)
    setBootstrapState(nextBootstrap)
    setCachedStateNeedsRefresh(false)
    setAppState(null)
    setSeriesCache({})
    setSearchQuery('')
    setSearchOpen(false)
    setFilterSheetOpen(false)
    setSelectedVariantId(null)
    setReaderResumeVariantId(null)
    setReaderResumePosition(null)
    setReaderProgressState(null)
    navigateRoute({ name: 'login', next: null }, { replace: true })
  }

  const handleResetLocalCache = async () => {
    setCacheResetBusy(true)

    if (cacheWriteTimerRef.current) {
      window.clearTimeout(cacheWriteTimerRef.current)
      cacheWriteTimerRef.current = null
    }

    setSeriesCache({})
    setReaderProgressState(null)
    setReaderResumeVariantId(null)
    setReaderResumePosition(null)

    await resetOrbitalLocalCaches()

    const resetUrl = new URL(window.location.href)
    resetUrl.searchParams.set('cacheReset', String(Date.now()))
    window.location.replace(resetUrl.toString())
  }

  const updateOfflineRecord = async (record: OfflineDownloadRecord) => {
    await putOfflineDownload(record)
    setOfflineDownloads((previousDownloads) => {
      const withoutRecord = previousDownloads.filter((download) => download.id !== record.id)
      return [record, ...withoutRecord].sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      )
    })
    if (sessionUser) {
      Promise.all([
        getOfflineStorageSummary(sessionUser.id),
        getImageCacheSummary(sessionUser.id),
      ]).then(([summary, covers]) => {
        setOfflineStorageSummary(summary)
        setImageCacheSummary(covers)
      }).catch(() => undefined)
    }
  }

  const setOfflineBusy = (busyKey: string, label: string | null) => {
    setOfflineBusyIds((previousBusyIds) => {
      const nextBusyIds = { ...previousBusyIds }

      if (label) {
        nextBusyIds[busyKey] = label
      } else {
        delete nextBusyIds[busyKey]
      }

      return nextBusyIds
    })
  }

  const clearOfflineRetryTimer = (busyKey: string) => {
    const timer = offlineRetryTimersRef.current.get(busyKey)

    if (timer == null) {
      return
    }

    window.clearTimeout(timer)
    offlineRetryTimersRef.current.delete(busyKey)
  }

  const startOfflineDownload = async (
    target: OfflineDownloadTarget,
    options: { autoResume?: boolean } = {},
  ) => {
    if (!sessionUser) {
      if (!options.autoResume) {
        setStateError(text.authErrorFallback)
      }
      return
    }

    if (offlineDeleteAllInProgressRef.current) {
      return
    }

    const busyKey = getOfflineTargetKey(target)

    if (offlineRunningTargetsRef.current.has(busyKey)) {
      return
    }

    if (options.autoResume) {
      offlineAutoResumeGuardRef.current.add(busyKey)
    } else {
      offlineAutoResumeGuardRef.current.delete(busyKey)
    }

    clearOfflineRetryTimer(busyKey)
    offlineRunningTargetsRef.current.add(busyKey)
    const controller = new AbortController()
    offlineAbortControllersRef.current.set(busyKey, controller)
    let resolveRunCompletion: () => void = () => undefined
    const runCompletion = new Promise<void>((resolve) => {
      resolveRunCompletion = resolve
    })
    offlineRunCompletionRef.current.set(busyKey, runCompletion)
    let record = offlineDownloads.find(
      (download) => getOfflineTargetKey(download.manifest.target) === busyKey,
    ) ?? null
    let replacementRecords: OfflineDownloadRecord[] = []
    let downloadStateStarted = record?.status !== 'ready'
    setOfflineBusy(busyKey, text.downloadForOffline)

    try {
      await requestOfflineStoragePersistence().catch(() => null)
      const manifest = await api.createOfflineManifest(target, controller.signal)
      deletedOfflineDownloadIdsRef.current.delete(manifest.manifestId)

      const storedRecord = await getOfflineDownload(manifest.manifestId)
      const candidateRecords = Array.from(
        new Map(
          [
            ...offlineDownloads,
            ...(storedRecord ? [storedRecord] : []),
          ]
            .filter((download) => (
              download.ownerUserId === sessionUser.id &&
              getOfflineTargetKey(download.manifest.target) === busyKey
            ))
            .map((download) => [download.id, download] as const),
        ).values(),
      )
      const existingRecord = candidateRecords.find(
        (download) => download.id === manifest.manifestId,
      ) ?? null
      replacementRecords = candidateRecords.filter(
        (download) => download.id !== manifest.manifestId,
      )

      if (replacementRecords.length) {
        setOfflineBusy(busyKey, text.preparingOfflineDownload)
      }
      const storedResources = await getOfflineResourceInventory(manifest.manifestId)
      const previousPackages = await Promise.all(
        replacementRecords.map(async (download) => ({
          downloadId: download.id,
          resources: await getOfflineResourceInventory(download.id),
        })),
      )
      const reusableResources = planReusableOfflineResources(
        manifest,
        previousPackages,
        storedResources,
      )

      const reusableBySource = new Map<string, typeof reusableResources>()

      for (const reusable of reusableResources) {
        const sourceTransfers = reusableBySource.get(reusable.sourceDownloadId) ?? []
        sourceTransfers.push(reusable)
        reusableBySource.set(reusable.sourceDownloadId, sourceTransfers)
      }

      let copiedResourceCount = 0

      for (const [sourceDownloadId, sourceTransfers] of reusableBySource) {
        if (controller.signal.aborted) {
          throw new OfflineDownloadCancelledError()
        }

        let copiedResources: typeof storedResources = []

        try {
          copiedResources = await copyOfflineResources(
            sourceDownloadId,
            manifest.manifestId,
            sessionUser.id,
            sourceTransfers.map((transfer) => transfer.resource),
          )
        } catch {
          // If local reuse fails, the normal download path repairs the resources.
        }
        const copiedByKey = new Map(
          copiedResources.map((copied) => [copied.resource.key, copied]),
        )

        for (const reusable of sourceTransfers) {
          const copied = copiedByKey.get(reusable.resource.key)

          if (!copied) {
            continue
          }

          storedResources.push(copied)
          copiedResourceCount += 1
          setOfflineBusy(
            busyKey,
            text.preparingOfflineUpdate(copiedResourceCount, reusableResources.length),
          )
        }
      }

      const merged = mergeOfflineManifestWithStoredResources(manifest, storedResources)

      record = mergeOfflineDownloadRecord(
        manifest,
        existingRecord,
        merged.completedResources,
        merged.manifest,
        createOfflineDownloadRecord,
      )
      downloadStateStarted = true
      await updateOfflineRecord(record)
      const storedByKey = new Map(storedResources.map((stored) => [stored.resource.key, stored]))
      setOfflineBusy(
        busyKey,
        manifest.target.type === 'series'
          ? text.downloadProgress(record.downloadedResourceCount, record.resourceCount)
          : text.downloadForOffline,
      )

      for (const resource of manifest.resources) {
        if (controller.signal.aborted) {
          throw new OfflineDownloadCancelledError()
        }

        const stored = storedByKey.get(resource.key)

        if (isOfflineResourceComplete(resource, stored)) {
          continue
        }

        let attempt = 0
        let blob: Blob | null = null

        while (!blob) {
          try {
            const response = await api.fetchResource(resource.url, controller.signal)
            blob = await response.blob()

            if (resource.size > 0 && blob.size !== resource.size) {
              throw new OfflineResourceIntegrityError(resource.label)
            }
          } catch (error) {
            if (controller.signal.aborted) {
              throw new OfflineDownloadCancelledError()
            }

            if (!isRetryableOfflineDownloadError(error) || attempt >= 3) {
              throw error
            }

            attempt += 1
            setOfflineBusy(
              busyKey,
              manifest.target.type === 'series'
                ? text.downloadProgress(record.downloadedResourceCount, record.resourceCount)
                : text.downloadForOffline,
            )
            await waitForOfflineRetry(offlineRetryDelay(attempt), controller.signal)
          }
        }

        const localResource = await putOfflineResource(record.id, record.ownerUserId, resource, blob)
        storedByKey.set(resource.key, {
          resource: localResource,
          size: blob.size,
        })
        record = {
          ...record,
          manifest: {
            ...record.manifest,
            resources: record.manifest.resources.map((candidate) =>
              candidate.key === localResource.key ? localResource : candidate,
            ),
          },
          status: 'downloading',
          retryAt: null,
          downloadedBytes: record.downloadedBytes + blob.size,
          verifiedBytes: record.verifiedBytes + (resource.size || blob.size),
          downloadedResourceCount: record.downloadedResourceCount + 1,
          updatedAt: new Date().toISOString(),
        }
        setOfflineBusy(
          busyKey,
          manifest.target.type === 'series'
            ? text.downloadProgress(record.downloadedResourceCount, record.resourceCount)
            : text.downloadForOffline,
        )
        await updateOfflineRecord(record)
      }

      record = {
        ...record,
        status: 'ready',
        completedAt: new Date().toISOString(),
        failureReason: null,
        retryAt: null,
        updatedAt: new Date().toISOString(),
      }
      await updateOfflineRecord(record)
      await Promise.all(
        replacementRecords
          .filter((download) => download.id !== record?.id)
          .map((download) => deleteOfflineDownload(download.id).catch(() => undefined)),
      )
      offlineAutoResumeGuardRef.current.delete(busyKey)
    } catch (error) {
      const cancelled = error instanceof OfflineDownloadCancelledError || controller.signal.aborted
      const retryable = isRetryableOfflineDownloadError(error)
      const message = error instanceof Error ? error.message : text.downloadFailed
      offlineAutoResumeGuardRef.current.add(busyKey)

      if (
        downloadStateStarted &&
        record &&
        !deletedOfflineDownloadIdsRef.current.has(record.id)
      ) {
        const nextRetryAt = retryable && !cancelled
          ? new Date(Date.now() + 15000).toISOString()
          : null
        record = {
          ...record,
          status: cancelled
            ? 'paused'
            : message.toLowerCase().includes('stale')
              ? 'stale'
              : retryable
                ? 'queued'
                : record.downloadedResourceCount > 0
                  ? 'partial'
                  : 'failed',
          failureReason: cancelled ? text.downloadCancelled : message,
          retryAt: nextRetryAt,
          completedAt: null,
          updatedAt: new Date().toISOString(),
        }
        await updateOfflineRecord(record).catch(() => undefined)
      }

      if (!options.autoResume && !cancelled) {
        setStateError(message)
      }
    } finally {
      offlineRunningTargetsRef.current.delete(busyKey)
      offlineAbortControllersRef.current.delete(busyKey)
      offlineRunCompletionRef.current.delete(busyKey)
      resolveRunCompletion()
      setOfflineBusy(busyKey, null)
      void refreshOfflineDownloads()
    }
  }

  startOfflineDownloadRef.current = startOfflineDownload

  useEffect(() => {
    if (!authenticated || offlineMode || !sessionUser || !offlineDownloadsLoaded) {
      return
    }

    const now = Date.now()

    offlineDownloads.forEach((record) => {
      const busyKey = getOfflineTargetKey(record.manifest.target)

      if (
        !['queued', 'downloading', 'partial'].includes(record.status) ||
        offlineRunningTargetsRef.current.has(busyKey)
      ) {
        return
      }

      const retryAt = record.retryAt ? Date.parse(record.retryAt) : now

      if (retryAt > now) {
        if (!offlineRetryTimersRef.current.has(busyKey)) {
          const timer = window.setTimeout(() => {
            offlineRetryTimersRef.current.delete(busyKey)
            setOfflineResumeTick((currentTick) => currentTick + 1)
          }, retryAt - now)
          offlineRetryTimersRef.current.set(busyKey, timer)
        }
        return
      }

      const guarded = offlineAutoResumeGuardRef.current.has(busyKey)
      const isScheduledRetry = record.status === 'queued' && Boolean(record.retryAt)

      if (guarded && !isScheduledRetry) {
        return
      }

      void startOfflineDownloadRef.current(record.manifest.target, { autoResume: true })
    })
  }, [
    authenticated,
    offlineDownloads,
    offlineDownloadsLoaded,
    offlineMode,
    offlineResumeTick,
    sessionUser,
  ])

  useEffect(() => {
    const nudgeOfflineResume = () => {
      setOfflineResumeTick((currentTick) => currentTick + 1)
    }

    window.addEventListener('online', nudgeOfflineResume)
    document.addEventListener('visibilitychange', nudgeOfflineResume)

    return () => {
      window.removeEventListener('online', nudgeOfflineResume)
      document.removeEventListener('visibilitychange', nudgeOfflineResume)
    }
  }, [])

  useEffect(() => () => {
    offlineRetryTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    offlineRetryTimersRef.current.clear()
  }, [])

  const handleCancelDownload = async (record: OfflineDownloadRecord) => {
    if (offlineDeleteAllInProgressRef.current) {
      return
    }

    const busyKey = getOfflineTargetKey(record.manifest.target)
    offlineAutoResumeGuardRef.current.add(busyKey)
    clearOfflineRetryTimer(busyKey)
    offlineAbortControllersRef.current.get(busyKey)?.abort()

    if (!offlineRunningTargetsRef.current.has(busyKey)) {
      await updateOfflineRecord({
        ...record,
        status: 'paused',
        failureReason: text.downloadCancelled,
        retryAt: null,
        completedAt: null,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined)
      await refreshOfflineDownloads()
    }
  }

  const handleDeleteDownload = async (downloadId: string) => {
    if (offlineDeleteAllInProgressRef.current) {
      return
    }

    const download = offlineDownloads.find((record) => record.id === downloadId)
    let runCompletion: Promise<void> | undefined

    if (download) {
      const busyKey = getOfflineTargetKey(download.manifest.target)
      offlineAutoResumeGuardRef.current.add(busyKey)
      clearOfflineRetryTimer(busyKey)
      deletedOfflineDownloadIdsRef.current.add(downloadId)
      offlineAbortControllersRef.current.get(busyKey)?.abort()
      runCompletion = offlineRunCompletionRef.current.get(busyKey)
    }

    setOfflineBusy(downloadId, text.deleteDownload)

    try {
      await runCompletion
      await deleteOfflineDownload(downloadId)
      if (offlineReaderDownloadId === downloadId) {
        setOfflineReaderDownloadId(null)
        navigateRoute({ name: 'downloads' }, { replace: true })
      }
      await refreshOfflineDownloads()
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setOfflineBusy(downloadId, null)
    }
  }

  const handleDeleteAllDownloads = async () => {
    if (!sessionUser || offlineDeleteAllInProgressRef.current) {
      return
    }

    offlineDeleteAllInProgressRef.current = true
    const runCompletions: Promise<void>[] = []
    const activeBusyKeys = new Set([
      ...offlineRunningTargetsRef.current,
      ...offlineAbortControllersRef.current.keys(),
      ...offlineRunCompletionRef.current.keys(),
    ])

    activeBusyKeys.forEach((busyKey) => {
      offlineAutoResumeGuardRef.current.add(busyKey)
      clearOfflineRetryTimer(busyKey)
      offlineAbortControllersRef.current.get(busyKey)?.abort()
      const runCompletion = offlineRunCompletionRef.current.get(busyKey)

      if (runCompletion) {
        runCompletions.push(runCompletion)
      }
    })

    offlineDownloads.forEach((record) => {
      const busyKey = getOfflineTargetKey(record.manifest.target)
      offlineAutoResumeGuardRef.current.add(busyKey)
      deletedOfflineDownloadIdsRef.current.add(record.id)
      clearOfflineRetryTimer(busyKey)
      offlineAbortControllersRef.current.get(busyKey)?.abort()
    })

    setOfflineBusy('all-downloads', text.deleteAllDownloads)

    try {
      await Promise.all(runCompletions)
      await deleteAllOfflineDownloadsForUser(sessionUser.id)
      setOfflineReaderDownloadId(null)
      await refreshOfflineDownloads()
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      offlineDeleteAllInProgressRef.current = false
      setOfflineBusy('all-downloads', null)
    }
  }

  const handleRequestPersistentStorage = async () => {
    setPersistentStorageBusy(true)

    try {
      await requestOfflineStoragePersistence()
      await refreshOfflineDownloads()
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setPersistentStorageBusy(false)
    }
  }

  const handleClearImageCache = async () => {
    if (!sessionUser || imageCacheBusy || imageCacheSummary?.storedBytes === 0) {
      return
    }

    if (!window.confirm(text.clearCoverStorageConfirm)) {
      return
    }

    setImageCacheBusy(true)

    try {
      await clearImageCache(sessionUser.id)
      setImageCacheSummary(await getImageCacheSummary(sessionUser.id))
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setImageCacheBusy(false)
    }
  }

  const handleTestImageCache = async () => {
    if (!sessionUser || imageCacheTestBusy) {
      return
    }

    setImageCacheTestBusy(true)
    setImageCacheTestResult(null)

    try {
      const result = await runImageCacheSelfTest(sessionUser.id)
      setImageCacheTestResult(result)
      setImageCacheSummary(await getImageCacheSummary(sessionUser.id))
    } catch (error) {
      setImageCacheTestResult({
        passed: false,
        backend: 'none',
        bytesWritten: 0,
        bytesRead: 0,
        storedBytes: imageCacheSummary?.storedBytes ?? 0,
        imageCount: imageCacheSummary?.imageCount ?? 0,
        error: error instanceof Error ? error.message : text.authErrorFallback,
      })
    } finally {
      setImageCacheTestBusy(false)
    }
  }

  const openOfflineDownload = (record: OfflineDownloadRecord, preferredEntryId?: string | null) => {
    if (record.status !== 'ready') {
      return
    }

    const offlineSeries = buildOfflineSeriesDetail(record)
    const entryToOpen =
      preferredEntryId
        ? offlineSeries.entries.find((entry) => (
            entry.id === preferredEntryId || entry.preferredVariantId === preferredEntryId
          )) ?? offlineSeries.entries[0]
        : offlineSeries.entries[0]

    startTransition(() => {
      setSeriesCache((previousCache) => ({
        ...previousCache,
        [offlineSeries.id]: offlineSeries,
      }))
      setOfflineReaderDownloadId(record.id)
      setSelectedSeriesId(offlineSeries.id)
      setCurrentCategory(offlineSeries.category)
      setSelectedEntryId(entryToOpen?.id ?? null)
      setSelectedVariantId(entryToOpen?.preferredVariantId ?? null)
      setReaderProgressState(null)
      setReaderResumePosition(null)
      setReaderResumeVariantId(entryToOpen?.preferredVariantId ?? null)
      setSearchOpen(false)
    })

    if (entryToOpen) {
      navigateRoute({
        name: 'offlineReader',
        downloadId: record.id,
        entryId: entryToOpen.id,
        page: null,
        percent: null,
        variantId: null,
      })
    }
  }

  function primeReaderResume(variantId: string | null, route: AppRoute = currentRoute) {
    const savedPosition = variantId ? appState?.readingPositions?.[variantId] ?? null : null
    const resumePosition = routeReadingPosition(route, savedPosition)

    setReaderResumeVariantId(variantId)
    setReaderResumePosition(resumePosition)
    const progress = savedPositionToReaderProgress(resumePosition)
    setReaderProgressState(
      variantId && progress ? { progress, variantId } : null,
    )
    setBookmarkJustSet(false)
    lastAutoSaveKeyRef.current = null
  }

  const moveEntry = async (direction: -1 | 1) => {
    if (!selectedSeries || !currentEntry) {
      return
    }

    const currentIndex = selectedSeries.entries.findIndex((entry) => entry.id === currentEntry.id)
    const nextIndex = Math.min(
      Math.max(currentIndex + direction, 0),
      selectedSeries.entries.length - 1,
    )

    if (nextIndex === currentIndex) {
      return
    }

    const nextEntry = selectedSeries.entries[nextIndex]
    const nextVariant =
      nextEntry?.variants.find((variant) => variant.id === nextEntry.preferredVariantId) ??
      nextEntry?.variants[0] ??
      null

    if (!nextEntry) {
      return
    }

    await persistCurrentReaderPosition(false)

    const beginningLocation = readerBeginningLocation(nextVariant?.format)

    const nextRoute: AppRoute =
      currentRoute.name === 'offlineReader'
        ? {
            name: 'offlineReader',
            downloadId: currentRoute.downloadId,
            entryId: nextEntry.id,
            ...beginningLocation,
            variantId: null,
          }
        : {
            name: 'reader',
            category: categoryRouteId(selectedSeries.category),
            seriesId: selectedSeries.id,
            entryId: nextEntry.id,
            ...beginningLocation,
            variantId: null,
          }

    setSelectedEntryId(nextEntry?.id || null)
    setSelectedVariantId(nextVariant?.id ?? null)
    primeReaderResume(nextVariant?.id ?? null, nextRoute)
    navigateRoute(nextRoute)
  }

  const handleReaderProgressChange = (progress: ReaderProgress) => {
    const variantId = currentVariant?.id
    if (!variantId) {
      return
    }

    setReaderProgressState((previousState) => {
      const previousProgress =
        previousState?.variantId === variantId ? previousState.progress : null
      if (
        previousProgress?.page === progress.page &&
        previousProgress?.endPage === progress.endPage &&
        previousProgress?.totalPages === progress.totalPages &&
        previousProgress?.viewMode === progress.viewMode &&
        previousProgress?.locationType === progress.locationType &&
        previousProgress?.progressLabel === progress.progressLabel &&
        previousProgress?.cueLabel === progress.cueLabel
      ) {
        return previousState
      }

      return { progress, variantId }
    })
  }

  const persistCurrentReaderPosition = useCallback(async (manual = false, keepalive = false) => {
    if (!selectedSeriesSummary || !currentEntry || !currentVariant || !appState?.user) {
      return
    }

    const currentProgress =
      readerProgress ||
      (currentReaderStartPosition
        ? {
            page: currentReaderStartPosition.page,
            totalPages: currentReaderStartPosition.totalPages ?? 1,
            viewMode: currentReaderStartPosition.viewMode,
            locationType: currentReaderStartPosition.locationType,
            progressLabel: currentReaderStartPosition.progressLabel,
            cueLabel: currentReaderStartPosition.cueLabel,
          }
        : {
            page: selectedSeriesSummary.category === 'novels' ? 0 : 1,
            totalPages: 1,
          })

    const bookmarkSummary = buildReaderLocation(
      selectedSeriesSummary.category,
      currentProgress,
      currentEntry.label,
    )

    const payload = {
      seriesId: selectedSeriesSummary.id,
      entryId: currentVariant.id,
      entryIndex: selectedEntryIndex,
      category: selectedSeriesSummary.category,
      progress: bookmarkSummary.progress,
      cue: bookmarkSummary.cue,
      position: {
        page: currentProgress.page,
        totalPages: currentProgress.totalPages,
        viewMode: currentProgress.viewMode,
        locationType: currentProgress.locationType,
        progressLabel: currentProgress.progressLabel,
        cueLabel: currentProgress.cueLabel,
      },
    }

    const saveKey = JSON.stringify(payload)

    if (!manual && lastAutoSaveKeyRef.current === saveKey) {
      return
    }

    lastAutoSaveKeyRef.current = saveKey

    if (offlineReaderDownloadId) {
      const existingState = await getOfflineReadingState(appState.user.id)
      const nextBookmark = {
        seriesId: payload.seriesId,
        category: payload.category,
        entryId: payload.entryId,
        entryIndex: payload.entryIndex,
        entryLabel: currentEntry.label,
        entryTitle: currentEntry.title,
        progress: payload.progress,
        cue: payload.cue,
        lastSeen: new Date().toISOString(),
      } satisfies Bookmark
      const nextState = await putOfflineReadingState({
        ownerUserId: appState.user.id,
        bookmarks: [
          ...existingState.bookmarks.filter((bookmark) => bookmark.seriesId !== payload.seriesId),
          nextBookmark,
        ],
        readingPositions: {
          ...existingState.readingPositions,
          [payload.entryId]: payload.position,
        },
        updatedAt: existingState.updatedAt,
      })

      setAppState((previousState) =>
        previousState
          ? {
              ...previousState,
              bookmarks: nextState.bookmarks,
              readingPositions: nextState.readingPositions,
            }
          : previousState,
      )

      if (manual) {
        setBookmarkJustSet(true)
      }

      if (navigator.onLine && !offlineMode) {
        setCachedStateNeedsRefresh(true)
      }
      return
    }

    const response = await api.setBookmark(payload, { keepalive })

    setAppState((previousState) =>
      previousState
        ? {
            ...previousState,
            bookmarks: response.bookmarks,
            readingPositions: response.readingPositions,
          }
        : previousState,
    )

    if (manual) {
      setBookmarkJustSet(true)
    }
  }, [
    appState?.user,
    currentEntry,
    currentReaderStartPosition,
    currentVariant,
    offlineMode,
    offlineReaderDownloadId,
    readerProgress,
    selectedEntryIndex,
    selectedSeriesSummary,
  ])

  const handleSetBookmark = async () => {
    await persistCurrentReaderPosition(true)
  }

  const handleRemoveBookmark = async (seriesId: string) => {
    try {
      setRemovingBookmarkSeriesId(seriesId)

      if (offlineMode && appState?.user) {
        const existingState = await getOfflineReadingState(appState.user.id)
        const nextState = await putOfflineReadingState({
          ownerUserId: appState.user.id,
          bookmarks: existingState.bookmarks.filter((bookmark) => bookmark.seriesId !== seriesId),
          readingPositions: existingState.readingPositions,
          updatedAt: existingState.updatedAt,
        })
        setAppState((previousState) =>
          previousState
            ? {
                ...previousState,
                bookmarks: nextState.bookmarks,
                readingPositions: nextState.readingPositions,
              }
            : previousState,
        )
        setOpenBookmarkMenuKey(null)
        return
      }

      const response = await api.removeBookmark(seriesId)

      setAppState((previousState) =>
        previousState
          ? {
              ...previousState,
              bookmarks: response.bookmarks,
              readingPositions: response.readingPositions,
            }
          : previousState,
      )
      setOpenBookmarkMenuKey(null)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setRemovingBookmarkSeriesId(null)
    }
  }

  useEffect(() => {
    if (
      !isReaderRoute(currentRoute) ||
      !selectedSeriesSummary ||
      !currentEntry ||
      !currentVariant ||
      !appState?.user
    ) {
      return
    }

    const timeout = window.setTimeout(() => {
      void persistCurrentReaderPosition(false)
    }, 1400)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [
    appState?.user,
    currentEntry,
    currentVariant,
    currentRoute,
    persistCurrentReaderPosition,
    readerProgress,
    selectedEntryIndex,
    selectedSeriesSummary,
  ])

  useEffect(() => {
    if (!isReaderRoute(currentRoute)) {
      return
    }

    const persistBeforeLeaving = () => {
      void persistCurrentReaderPosition(false, true).catch(() => undefined)
    }
    const persistWhenHidden = () => {
      if (document.visibilityState === 'hidden') {
        persistBeforeLeaving()
      }
    }

    window.addEventListener('pagehide', persistBeforeLeaving)
    document.addEventListener('visibilitychange', persistWhenHidden)

    return () => {
      window.removeEventListener('pagehide', persistBeforeLeaving)
      document.removeEventListener('visibilitychange', persistWhenHidden)
    }
  }, [currentRoute, persistCurrentReaderPosition])

  useEffect(() => {
    if (
      (currentRoute.name !== 'reader' && currentRoute.name !== 'offlineReader') ||
      !readerProgress ||
      !currentEntry ||
      !currentVariant
    ) {
      return
    }

    const isPercentPosition =
      readerProgress.locationType === 'percent' ||
      ['epub', 'html', 'md', 'txt'].includes(currentVariant.format)
    const position = Math.max(0, Math.round(readerProgress.page))
    const variantId =
      currentVariant.id !== currentEntry.preferredVariantId
        ? currentVariant.id
        : null
    const nextRoute: AppRoute = {
      ...currentRoute,
      entryId: currentEntry.id,
      page: isPercentPosition ? null : Math.max(1, position),
      percent: isPercentPosition ? Math.min(100, position) : null,
      variantId,
    }

    navigateRoute(nextRoute, {
      replace: true,
      preserveScroll: true,
      focusMain: false,
    })
  }, [
    currentEntry,
    currentRoute,
    currentVariant,
    navigateRoute,
    readerProgress,
  ])

  const handleReaderBack = async () => {
    await persistCurrentReaderPosition(false)

    const currentHistoryState = historyState()
    const returnPath = safeInternalDestination(currentHistoryState.orbitalReaderReturnPath)

    if (returnPath) {
      const returnUrl = new URL(returnPath, window.location.origin)
      const returnRoute = parseAppRoute(returnUrl)

      if (!isReaderRoute(returnRoute)) {
        const returnIndex = currentHistoryState.orbitalReaderReturnIndex

        if (
          Number.isSafeInteger(returnIndex) &&
          returnIndex != null &&
          returnIndex >= 0 &&
          returnIndex < historyIndexRef.current
        ) {
          window.history.go(returnIndex - historyIndexRef.current)
          return
        }

        navigateRoute(returnRoute, { replace: true })
        return
      }
    }

    const fallbackRoute: AppRoute =
      currentRoute.name === 'offlineReader'
        ? { name: 'downloads' }
        : selectedSeriesSummary && isReaderCategory(selectedSeriesSummary.category)
          ? {
              name: 'series',
              category: categoryRouteId(selectedSeriesSummary.category),
              seriesId: selectedSeriesSummary.id,
              tab: 'entries',
              season: null,
            }
          : { name: 'bookmarks', scope: 'all' }

    navigateRoute(fallbackRoute, { replace: true })
  }

  const handleReaderTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]

    if (!touch) {
      return
    }

    const edge =
      touch.clientX <= 26 ? 'left' : touch.clientX >= window.innerWidth - 26 ? 'right' : null

    readerTouchStartRef.current = {
      edge,
      x: touch.clientX,
      y: touch.clientY,
    }
  }

  const handleReaderTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const start = readerTouchStartRef.current
    const touch = event.changedTouches[0]
    readerTouchStartRef.current = null

    if (!start || !touch) {
      return
    }

    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    const moved = Math.abs(deltaX) > 12 || Math.abs(deltaY) > 12
    const isEdgeSwipe = start.edge && Math.abs(deltaY) <= 72 && Math.abs(deltaX) >= 84

    if (isEdgeSwipe && start.edge === 'left' && deltaX > 0) {
      void handleReaderBack()
      return
    }

    if (isEdgeSwipe && start.edge === 'right' && deltaX < 0) {
      void moveEntry(1)
      return
    }

    if (!moved && !isReaderChromeInteractionTarget(event.target)) {
      lastReaderTouchToggleRef.current = Date.now()
      toggleReaderChrome()
    }
  }

  const handleReaderClick = (event: MouseEvent<HTMLDivElement>) => {
    if (Date.now() - lastReaderTouchToggleRef.current < 450) {
      return
    }

    if (isReaderChromeInteractionTarget(event.target)) {
      return
    }

    toggleReaderChrome()
  }

  const handlePostComment = async () => {
    if (!selectedSeries || !commentDraft.trim()) {
      return
    }

    try {
      setCommentBusy(true)
      const response = await api.addComment({
        seriesId: selectedSeries.id,
        text: commentDraft,
      })
      setSeriesCache((previousCache) => ({
        ...previousCache,
        [response.series.id]: response.series,
      }))
      setCommentDraft('')
    } finally {
      setCommentBusy(false)
    }
  }

  const handleAddMountedRoot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    try {
      setAdminBusy(true)
      const nextState = await api.createRoot({
        label: rootLabel,
        path: rootPath,
      })
      applyState(nextState)
      setRootPath('')
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleLinkCurrentFolder = async () => {
    if (!selectedRootId) {
      return
    }

    try {
      setAdminBusy(true)
      const nextState = await api.createSource({
        rootId: selectedRootId,
        relativePath: directoryListing.currentPath,
        category: browseCategory,
      })
      applyState(nextState)
      setImportStep('type')
      setBrowsePath('')
      setManualFolderPath('')
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleUseManualFolderPath = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const selectedRoot = appState?.sourceRoots.find((root) => root.id === selectedRootId)
    if (!selectedRoot) {
      return
    }

    const nextPath = resolveRelativeFolderInput(manualFolderPath, selectedRoot)
    if (nextPath == null) {
      setStateError(text.folderPathOutsideRoot)
      return
    }

    setStateError(null)
    setBrowsePath(nextPath)
    setImportStep('folder')
  }

  const handleUpdateSourceCategory = async (sourceId: string, category: CategoryId) => {
    try {
      setAdminBusy(true)
      const nextState = await api.updateSource(sourceId, { category })
      applyState(nextState)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleUnlinkRoot = async (rootId: string) => {
    try {
      setAdminBusy(true)
      const nextState = await api.deleteRoot(rootId)
      applyState(nextState)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleRunScan = async (sourceId?: string) => {
    setScanClientNotice({
      id: `client-scan-start-${Date.now()}`,
      level: 'info',
      message: text.scanStartQueued,
      createdAt: new Date().toISOString(),
    })
    setScanPollUntil(Date.now() + 60000)

    try {
      setAdminBusy(true)
      const nextState = await api.runScan(sourceId)
      applyState(nextState)
      setStateError(null)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : text.authErrorFallback

      setScanClientNotice({
        id: `client-scan-error-${Date.now()}`,
        level: 'error',
        message: `${text.scanRequestLost}: ${errorMessage}`,
        createdAt: new Date().toISOString(),
      })
      setScanPollUntil(Date.now() + 60000)

      try {
        const nextState = await api.getState()
        applyState(nextState)
      } catch {
        // Keep the raw scan log notice visible while the recovery poll retries.
      }
    } finally {
      setAdminBusy(false)
    }
  }

  const handleChangePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const formData = new FormData(event.currentTarget)
    const currentPassword = String(formData.get('currentPassword') || '')
    const newPassword = String(formData.get('newPassword') || '')
    const confirmPassword = String(formData.get('confirmPassword') || '')

    setPasswordChangeError(null)
    setPasswordChangeSuccess(null)

    if (newPassword !== confirmPassword) {
      setPasswordChangeError(text.passwordMismatch)
      return
    }

    try {
      setPasswordChangeBusy(true)
      const nextState = await api.changePassword({
        currentPassword,
        newPassword,
      })
      applyState(nextState)
      event.currentTarget.reset()
      setPasswordChangeSuccess(text.passwordChangeSuccess)
    } catch (error) {
      setPasswordChangeError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setPasswordChangeBusy(false)
    }
  }

  const handleUnlinkSourceFolder = async (sourceId: string) => {
    try {
      setAdminBusy(true)
      const nextState = await api.deleteSource(sourceId)
      applyState(nextState)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleResetPassword = async (userId: string) => {
    const nextPassword = window.prompt(text.resetPasswordPrompt)

    if (!nextPassword) {
      return
    }

    try {
      setAdminBusy(true)
      const nextState = await api.resetPassword(userId, { password: nextPassword })
      applyState(nextState)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleSelectMetadataSeries = (seriesId: string) => {
    setSelectedMetadataSeriesId(seriesId)
  }

  const handleSaveMetadataOverride = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!selectedMetadataSeries) {
      return
    }

    try {
      setAdminBusy(true)
      const nextState = await api.saveMetadataOverride(selectedMetadataSeries.id, {
        title: metadataTitleDraft,
        year: metadataYearDraft.trim() ? Number(metadataYearDraft) : null,
        description: metadataDescriptionDraft,
        sourceName: metadataSourceNameDraft,
        sourceRole: metadataSourceRoleDraft,
        externalUrl: metadataExternalUrlDraft,
        coverImageUrl: metadataCoverUrlDraft,
      })
      applyState(nextState)
      setMetadataCoverUrlDraft('')
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleClearMetadataOverride = async () => {
    if (!selectedMetadataSeries) {
      return
    }

    try {
      setAdminBusy(true)
      const nextState = await api.clearMetadataOverride(selectedMetadataSeries.id)
      applyState(nextState)
      setMetadataCoverUrlDraft('')
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleRefreshMetadataMatch = async () => {
    if (!selectedMetadataSeries) {
      return
    }

    try {
      setAdminBusy(true)
      const nextState = await api.refreshSeriesMetadata(selectedMetadataSeries.id)
      applyState(nextState)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleSearchBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setSearchOpen(false)
    }
  }

  const updateSearchQuery = (query: string) => {
    setSearchQuery(query)
    if (currentRoute.name === 'search') {
      navigateRoute(
        { ...currentRoute, query },
        { replace: true, preserveScroll: true, focusMain: false },
      )
    }
  }

  const updateSearchScope = (scope: ScopeId) => {
    setSearchScope(scope)
    if (currentRoute.name === 'search') {
      navigateRoute(
        { ...currentRoute, scope },
        { replace: true, preserveScroll: true, focusMain: false },
      )
    }
  }

  const updateBookmarkScope = (scope: ScopeId) => {
    setBookmarkFilter(scope)
    navigateRoute(
      { name: 'bookmarks', scope },
      { replace: true, preserveScroll: true, focusMain: false },
    )
  }

  const updateLibraryRoute = (
    next: Partial<Pick<Extract<AppRoute, { name: 'library' }>, 'topics' | 'sort'>>,
  ) => {
    const route: Extract<AppRoute, { name: 'library' }> =
      currentRoute.name === 'library'
        ? currentRoute
        : {
            name: 'library',
            category: categoryRouteId(currentCategory),
            topics: bookTopicFilters,
            sort: discoverSort,
          }

    if (next.topics) {
      setBookTopicFilters(next.topics)
    }
    if (next.sort) {
      setDiscoverSort(next.sort)
    }

    navigateRoute(
      { ...route, ...next },
      { replace: true, preserveScroll: true, focusMain: false },
    )
  }

  const updateSeriesSeason = (season: number) => {
    setSelectedSeasonNumber(season)
    if (currentRoute.name === 'series') {
      navigateRoute(
        { ...currentRoute, season },
        { replace: true, preserveScroll: true, focusMain: false },
      )
    }
  }

  const updateReaderVariant = (variantId: string) => {
    setSelectedVariantId(variantId)
    primeReaderResume(variantId)

    if (
      (currentRoute.name === 'reader' || currentRoute.name === 'offlineReader') &&
      currentEntry
    ) {
      navigateRoute(
        {
          ...currentRoute,
          variantId: variantId === currentEntry.preferredVariantId ? null : variantId,
          page: null,
          percent: null,
        },
        { replace: true, preserveScroll: true, focusMain: false },
      )
    }
  }

  const openSearch = () => {
    const mobileSearch = window.matchMedia('(max-width: 900px)').matches

    if (mobileSearch) {
      navigateRoute({
        name: 'search',
        query: searchQuery,
        scope: searchScope,
      })
      setSearchOpen(false)
    } else {
      setSearchOpen(true)
    }

    window.requestAnimationFrame(() => {
      if (mobileSearch) {
        window.requestAnimationFrame(() => mobileSearchInputRef.current?.focus())
      } else {
        searchInputRef.current?.focus()
      }
    })
  }

  const renderPoster = (series: SeriesSummary, compact = false, showCover = authenticated) => {
    const hasCover = showCover && Boolean(series.coverUrl)
    const displayTitle = getSeriesDisplayTitle(series)

    return (
      <div
        className={`poster ${compact ? 'poster--compact' : ''} ${hasCover ? 'poster--covered' : ''}`}
      >
        {hasCover && (
          <AuthenticatedResourceImage
            alt=""
            cacheKey={`cover:${series.id}`}
            className="poster__image"
            decoding="async"
            loading={offlineMode || compact ? 'eager' : 'lazy'}
            onError={(event) => {
              event.currentTarget.style.display = 'none'
            }}
            offlineOnly={offlineMode}
            ownerUserId={sessionUser?.id}
            sourceUrl={series.coverUrl || ''}
          />
        )}
        <span className="poster__badge">{categoryLabel(series.category)}</span>
        <div className="poster__spark" />
        <div className="poster__copy">
          <span>{series.year || series.format}</span>
          <strong>{series.titleShort.trim() || displayTitle}</strong>
        </div>
      </div>
    )
  }

  const seriesRoute = (
    series: SeriesSummary,
    tab: SeriesTabId = 'entries',
  ): AppRoute => ({
    name: 'series',
    category: categoryRouteId(series.category),
    seriesId: series.id,
    tab,
    season: null,
  })

  const readerRoute = (
    series: SeriesSummary,
    entryId: string,
  ): AppRoute => ({
    name: 'reader',
    category: categoryRouteId(series.category),
    seriesId: series.id,
    entryId,
    page: null,
    percent: null,
    variantId: null,
  })

  const renderSeriesCard = (series: SeriesSummary) => {
    const displayTitle = getSeriesDisplayTitle(series)

    return (
      <RouteLink
        className="series-card"
        key={series.id}
        navigate={navigateRoute}
        route={seriesRoute(series)}
      >
        {renderPoster(series)}
        <div className="series-card__body">
          <div className="series-card__topline">
            <span className="section-kicker">{categoryLabel(series.category)}</span>
            <div className="chip-row">
              {offlineMode && (
                <span className="chip">
                  {getReadyOfflineDownloadForSeries(series, seriesCache[series.id] ?? null)
                    ? text.downloadsReady
                    : text.offlineOnly}
                </span>
              )}
              <span className="series-card__progress">{series.progressLabel}</span>
            </div>
          </div>
          <h3 className="series-card__title">{displayTitle}</h3>
          <p className="series-card__description">{series.description}</p>
          <div className="meta-row series-card__meta">
            <span>{series.year || series.format}</span>
            <span>{formatCountLabel(series.category, series.stats.fileCount, language)}</span>
            <span>{getSeriesSourceText(series)}</span>
          </div>
        </div>
      </RouteLink>
    )
  }

  const currentEntryOfflineTarget = currentVariant
    ? ({
        type: 'entry',
        entryId: currentVariant.id,
      } satisfies OfflineDownloadTarget)
    : null
  const currentEntryOfflineDownload = currentVariant
    ? getReadyOfflineDownloadForEntry(currentVariant.id)
    : null
  const currentEntryDownloadBusy = currentEntryOfflineTarget
    ? offlineBusyIds[getOfflineTargetKey(currentEntryOfflineTarget)]
    : null
  const readerToolbarAccessory =
    currentVariant ? (
      <>
        {currentEntry && currentEntry.variants.length > 1 && (
          <ReaderVariantMenu
            onSelect={updateReaderVariant}
            selectedVariantId={currentVariant.id}
            variants={currentEntry.variants}
          />
        )}
        {!offlineReaderDownloadId && currentEntryOfflineTarget && (
          <button
            className="ghost-button"
            disabled={Boolean(currentEntryDownloadBusy)}
            onClick={() => (
              currentEntryOfflineDownload
                ? openOfflineDownload(currentEntryOfflineDownload, currentVariant.id)
                : void startOfflineDownload(currentEntryOfflineTarget)
            )}
            type="button"
          >
            <AppIcon name={currentEntryOfflineDownload ? 'offline' : 'download'} />
            {currentEntryDownloadBusy ||
              (currentEntryOfflineDownload
                ? text.openOffline
                : getEntryDownloadLabel(currentVariant.format, selectedSeriesSummary?.category ?? currentCategory))}
          </button>
        )}
      </>
    ) : null

  const filteredCategoryLibrary = readerLibraryForDisplay.filter((series) => {
    if (series.category !== currentCategory) {
      return false
    }

    if (currentCategory === 'books' && bookTopicFilters.length > 0) {
      const seriesTopics = getSeriesTopicTags(series)

      return bookTopicFilters.some((topic) => seriesTopics.includes(topic))
    }

    return true
  })
  const sortedCategoryLibrary = [...filteredCategoryLibrary].sort((left, right) => {
    if (discoverSort === 'year') {
      const leftYear = left.year ?? Number.MAX_SAFE_INTEGER
      const rightYear = right.year ?? Number.MAX_SAFE_INTEGER

      if (leftYear !== rightYear) {
        return leftYear - rightYear
      }
    }

    return left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' })
  })
  const visibleSearchResults = searchResults.filter((series) => isReaderCategory(series.category))
  const libraryResults = deferredSearch !== '' ? visibleSearchResults : sortedCategoryLibrary
  const scopedSearchLibrary =
    searchScope === 'all'
      ? []
      : readerLibraryForDisplay
          .filter((series) => series.category === searchScope)
          .sort((left, right) => left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' }))

  const searchPreview = visibleSearchResults.slice(0, currentView === 'search' ? 50 : 10)
  const searchPageBrowseResults = deferredSearch === '' ? scopedSearchLibrary : []
  const seriesDetailLoading = Boolean(
    selectedSeriesId &&
    authenticated &&
    !offlineMode &&
    !seriesCache[selectedSeriesId] &&
    activeOfflineSeries?.id !== selectedSeriesId,
  )
  const routedSeriesMissing =
    Boolean(appState) &&
    !cachedStateNeedsRefresh &&
    isSeriesRoute(currentRoute) &&
    !readerLibraryForDisplay.some(
      (series) =>
        series.id === currentRoute.seriesId &&
        isReaderCategory(series.category),
    ) &&
    !(selectedSeriesDetail?.id === currentRoute.seriesId && isReaderCategory(selectedSeriesDetail.category)) &&
    selectedSeriesId === currentRoute.seriesId &&
    !seriesDetailLoading &&
    seriesErrorStatus === 404
  const routedEntryMissing =
    currentRoute.name === 'reader' &&
    !cachedStateNeedsRefresh &&
    selectedSeries?.id === currentRoute.seriesId &&
    !selectedSeries.entries.some(
      (entry) =>
        entry.id === currentRoute.entryId ||
        entry.variants.some((variant) => variant.id === currentRoute.entryId),
    )
  const routedOfflineDownloadUnavailable =
    currentRoute.name === 'offlineReader' &&
    offlineDownloadsLoaded &&
    (!activeOfflineDownload || activeOfflineDownload.status !== 'ready')
  const routedOfflineEntryMissing =
    currentRoute.name === 'offlineReader' &&
    activeOfflineSeries != null &&
    !activeOfflineSeries.entries.some((entry) => entry.id === currentRoute.entryId)
  const routedCreatorMissing =
    currentRoute.name === 'creator' &&
    Boolean(appState) &&
    !cachedStateNeedsRefresh &&
    !creatorProfiles.some((profile) => profile.key === currentRoute.creatorKey)
  const routePermissionDenied =
    currentRoute.name === 'admin' && appState?.user?.role !== 'admin'
  const routeProblem =
    currentRoute.name === 'notFound'
      ? {
          body: text.notFoundBody,
          title: text.notFoundTitle,
          type: 'notFound' as const,
        }
      : routePermissionDenied
        ? {
            body: text.permissionDeniedBody,
            title: text.permissionDeniedTitle,
            type: 'permission' as const,
          }
        : routedOfflineDownloadUnavailable || routedOfflineEntryMissing
          ? {
              body: text.downloadUnavailableBody,
              title: text.downloadUnavailableTitle,
              type: 'download' as const,
            }
          : routedSeriesMissing || routedEntryMissing || routedCreatorMissing
            ? {
                body: text.itemUnavailableBody,
                title: text.itemUnavailableTitle,
                type: 'item' as const,
              }
            : null
  const bookmarks = appState?.bookmarks ?? []
  const readerBookmarks = bookmarks.filter((bookmark) => isReaderCategory(bookmark.category))
  const filteredBookmarks =
    bookmarkFilter === 'all'
      ? readerBookmarks
      : readerBookmarks.filter((bookmark) => bookmark.category === bookmarkFilter)
  const sortedBookmarks = sortBookmarksByRecency(filteredBookmarks)
  const getBookmarkStats = (bookmark: Bookmark, series: SeriesSummary) => {
    const entryTotal = Math.max(series.stats.fileCount, bookmark.entryIndex + 1, 1)
    const entryCurrent = Math.min(entryTotal, Math.max(bookmark.entryIndex + 1, 1))
    const entryRemaining = Math.max(entryTotal - entryCurrent, 0)
    const entryRatio = Math.max(0.02, Math.min(1, entryCurrent / entryTotal))

    if (shouldUseEntryBookmarkProgress(series.category)) {
      const entryLabel = getBookmarkEntryLabel(series.category, language)
      const remainingText = formatBookmarkRemaining(series.category, entryRemaining, language)

      return {
        current: entryCurrent,
        total: entryTotal,
        remaining: entryRemaining,
        ratio: entryRatio,
        mobileCurrent: String(entryCurrent),
        mobileSuffix: `/ ${entryTotal}`,
        cue:
          entryRemaining > 0
            ? `${entryLabel} ${entryCurrent} / ${entryTotal} - ${remainingText}`
            : `${entryLabel} ${entryCurrent} / ${entryTotal}`,
      }
    }

    const pageMatch = bookmark.progress.match(/pages?\s+(\d+)(?:-\d+)?\s+of\s+(\d+)/i)

    if (pageMatch) {
      const current = Number(pageMatch[1])
      const total = Math.max(Number(pageMatch[2]), current, 1)
      const remaining = Math.max(total - current, 0)

      return {
        current,
        total,
        remaining,
        ratio: Math.max(0.02, Math.min(1, current / total)),
        mobileCurrent: String(current),
        mobileSuffix: `/ ${total}`,
        cue:
          remaining > 0
            ? `Page ${current} / ${total} - ${remaining} ${remaining === 1 ? 'page' : 'pages'} left`
            : `Page ${current} / ${total}`,
      }
    }

    const percentMatch = bookmark.progress.match(/(\d+(?:\.\d+)?)%/)

    if (percentMatch) {
      const current = Math.round(Number(percentMatch[1]))
      const total = 100

      return {
        current,
        total,
        remaining: Math.max(total - current, 0),
        ratio: Math.max(0.02, Math.min(1, current / total)),
        mobileCurrent: `${current}%`,
        mobileSuffix: null,
        cue: bookmark.progress,
      }
    }

    return {
      current: entryCurrent,
      total: entryTotal,
      remaining: entryRemaining,
      ratio: entryRatio,
      mobileCurrent: String(entryCurrent),
      mobileSuffix: `/ ${entryTotal}`,
      cue: bookmark.progress,
    }
  }
  function getEntryDownloadLabel(format: EntryFormat, category: CategoryId) {
    if (category === 'manga' || format === 'cbz') {
      return text.downloadEntry
    }

    return text.downloadBook
  }
  const pageTitle =
    currentView === 'notFound'
      ? text.notFoundTitle
      : currentView === 'bookmarks'
      ? text.nav.bookmarks
      : currentView === 'downloads'
        ? text.downloadsTitle
      : currentView === 'library'
        ? `${text.libraryTitle} / ${text.scopes[currentCategory]}${
            currentCategory === 'books' && bookTopicFilters.length > 0 ? ` / ${bookTopicFilters.join(', ')}` : ''
          }`
        : currentView === 'search'
          ? text.searchTitle
          : currentView === 'series'
            ? selectedSeriesDisplayTitle || text.loadingSeries
            : currentView === 'reader'
              ? `${selectedSeriesDisplayTitle || text.loadingSeries} / ${currentEntry?.label || ''}`
              : currentView === 'creator'
                ? selectedCreatorProfile?.name || text.creatorProfile
                : currentView === 'profile'
                  ? text.profile
                  : text.admin
  const pageBody =
    currentView === 'bookmarks'
      ? text.bookmarksBody
      : currentView === 'downloads'
        ? text.downloadsBody
      : currentView === 'library'
        ? text.libraryBody
        : currentView === 'search'
          ? text.searchHint
          : currentView === 'series'
            ? selectedSeriesSummary?.description || text.loadingSeries
            : currentView === 'reader'
              ? (currentEntry ? formatDisplayEntryTitle(currentEntry.title) : text.loadingSeries)
              : currentView === 'creator'
                ? selectedCreatorProfile
                  ? `${selectedCreatorProfile.series.length} ${text.creatorWorks}`
                  : text.creatorProfile
                : currentView === 'profile'
                  ? text.passwordChangeHelp
                  : currentView === 'notFound'
                    ? text.notFoundBody
                    : 'Mounted roots, linked folders, user resets, and metadata review stay in the admin area.'

  useEffect(() => {
    const title = !authenticated
      ? authMode === 'signup'
        ? text.createAccount
        : text.signIn
      : routeProblem?.title ?? pageTitle

    document.title = `${title} — ${text.brandName}`
  }, [
    authMode,
    authenticated,
    pageTitle,
    routeProblem?.title,
    text.brandName,
    text.createAccount,
    text.signIn,
  ])

  const renderRouteProblem = () => {
    if (!routeProblem) {
      return null
    }

    const category =
      isSeriesRoute(currentRoute)
        ? currentRoute.category
        : currentCategory

    return (
      <div className="page page--route-state">
        <article className="panel panel--padded route-state" role="status">
          <p className="section-kicker">{text.brandName}</p>
          <h1>{routeProblem.title}</h1>
          <p>{routeProblem.body}</p>
          <div className="route-state__actions">
            {routeProblem.type === 'download' && (
              <RouteLink
                className="primary-button"
                navigate={navigateRoute}
                route={{ name: 'downloads' }}
              >
                {text.openDownloadsPage}
              </RouteLink>
            )}
            {routeProblem.type === 'permission' && (
              <RouteLink
                className="primary-button"
                navigate={navigateRoute}
                route={{ name: 'profile' }}
              >
                {text.profile}
              </RouteLink>
            )}
            {routeProblem.type === 'item' && isReaderCategory(category) && (
              <RouteLink
                className="primary-button"
                navigate={navigateRoute}
                route={{
                  name: 'library',
                  category: categoryRouteId(category),
                  topics: [],
                  sort: discoverSort,
                }}
              >
                {text.browseCategory}
              </RouteLink>
            )}
            <RouteLink
              className="ghost-button"
              navigate={navigateRoute}
              route={{ name: 'bookmarks', scope: 'all' }}
            >
              {text.returnBookmarks}
            </RouteLink>
          </div>
        </article>
      </div>
    )
  }

  const renderBookmarks = () => {
    const bookmarkLibrary = readerLibraryForDisplay
    const bookmarkLibraryLoading = offlineMode && !offlineDownloadsLoaded && bookmarkLibrary.length === 0

    return (
      <div className="page page--bookmarks">
      <section className="toolbar-panel toolbar-panel--bookmarks">
        <div>
          <p className="section-kicker">{text.welcome}</p>
          <h2>
            <span className="desktop-only">{text.bookmarksHero}</span>
            <span className="mobile-only">{text.mobileNav.library}</span>
          </h2>
        </div>
        <button className="sort-pill" type="button">
          {text.librarySort}
        </button>
        <div className="bookmark-filter-bar" aria-label="Bookmark categories">
          {readerScopeOrder.map((scope) => (
            <button
              aria-pressed={bookmarkFilter === scope}
              className={`tab-button ${bookmarkFilter === scope ? 'is-active' : ''}`}
              key={scope}
              onClick={() => updateBookmarkScope(scope)}
              type="button"
            >
              {text.scopes[scope]}
            </button>
          ))}
        </div>
      </section>

      {bookmarkLibraryLoading ? (
        <article aria-live="polite" className="panel panel--padded">{text.loading}</article>
      ) : bookmarkLibrary.length === 0 ? (
        <article className="panel panel--padded">{text.noLibrary}</article>
      ) : (
        <section className="bookmark-list">
          {sortedBookmarks.length === 0 ? (
            <article className="panel panel--padded">No manual bookmark set yet.</article>
          ) : (
            sortedBookmarks.map((bookmark) => {
              const series = bookmarkLibrary.find((item) => item.id === bookmark.seriesId)

              if (!series) {
                return null
              }

              const bookmarkOfflineDownload = getReadyOfflineDownloadForEntry(bookmark.entryId)
              const displayTitle = getSeriesDisplayTitle(series)
              const progressHint = shouldUseEntryBookmarkProgress(series.category)
                ? null
                : getBookmarkProgressHint(bookmark)
              const bookmarkStats = getBookmarkStats(bookmark, series)
              const bookmarkMenuKey = `${bookmark.seriesId}-${bookmark.entryId}`
              const bookmarkMenuOpen = openBookmarkMenuKey === bookmarkMenuKey

              return (
                <article
                  className={`bookmark-card bookmark-card--list ${bookmarkMenuOpen ? 'is-menu-open' : ''}`}
                  key={`${bookmark.seriesId}-${bookmark.entryId}`}
                >
                  {bookmarkOfflineDownload ? (
                    <button
                      aria-label={`${text.resume}: ${displayTitle}`}
                      className="bookmark-card__primary"
                      onClick={() => openOfflineDownload(bookmarkOfflineDownload, bookmark.entryId)}
                      type="button"
                    >
                      {renderPoster(series, true)}
                      <span className="bookmark-card__progress-track" aria-hidden="true">
                        <span style={{ width: `${bookmarkStats.ratio * 100}%` }} />
                      </span>
                      <span className="bookmark-card__mobile-meta">
                        <strong>{bookmarkStats.mobileCurrent}</strong>
                        {bookmarkStats.mobileSuffix && <span>{bookmarkStats.mobileSuffix}</span>}
                      </span>
                    </button>
                  ) : (
                    <RouteLink
                      ariaLabel={`${text.resume}: ${displayTitle}`}
                      className="bookmark-card__primary"
                      navigate={navigateRoute}
                      route={readerRoute(series, bookmark.entryId)}
                    >
                      {renderPoster(series, true)}
                      <span className="bookmark-card__progress-track" aria-hidden="true">
                        <span style={{ width: `${bookmarkStats.ratio * 100}%` }} />
                      </span>
                      <span className="bookmark-card__mobile-meta">
                        <strong>{bookmarkStats.mobileCurrent}</strong>
                        {bookmarkStats.mobileSuffix && <span>{bookmarkStats.mobileSuffix}</span>}
                      </span>
                    </RouteLink>
                  )}
                  <div className="bookmark-card__content">
                    <div className="bookmark-card__topline">
                      <span className="section-kicker">{categoryLabel(series.category)}</span>
                      <div className="chip-row">
                        {progressHint && <span className="chip">{progressHint}</span>}
                        {bookmarkOfflineDownload
                          ? <span className="chip">{text.downloadsReady}</span>
                          : offlineMode && <span className="chip">{text.offlineOnly}</span>}
                      </div>
                    </div>
                    <div className="bookmark-card__headline">
                      <div>
                        <h4>{displayTitle}</h4>
                        <p>{bookmark.entryLabel}</p>
                      </div>
                    </div>
                    <p className="bookmark-card__cue">{bookmarkStats.cue}</p>
                    <div className="bookmark-card__actions">
                      {bookmarkOfflineDownload ? (
                        <button
                          className="primary-button"
                          onClick={() => openOfflineDownload(bookmarkOfflineDownload, bookmark.entryId)}
                          type="button"
                        >
                          <AppIcon name="offline" />
                          {text.resume}
                        </button>
                      ) : (
                        <RouteLink
                          className="primary-button"
                          navigate={navigateRoute}
                          route={readerRoute(series, bookmark.entryId)}
                        >
                          <AppIcon name="read" />
                          {text.resume}
                        </RouteLink>
                      )}
                      <RouteLink
                        className="ghost-button"
                        navigate={navigateRoute}
                        route={seriesRoute(series)}
                      >
                        <AppIcon name="chevronRight" />
                        {text.openSeries}
                      </RouteLink>
                    </div>
                  </div>
                  <button
                    aria-expanded={bookmarkMenuOpen}
                    aria-label={`${text.bookmarkActions}: ${displayTitle}`}
                    className="bookmark-card__menu"
                    onClick={() => setOpenBookmarkMenuKey((currentKey) => (
                      currentKey === bookmarkMenuKey ? null : bookmarkMenuKey
                    ))}
                    type="button"
                  >
                    <AppIcon name="more" />
                  </button>
                  {bookmarkMenuOpen && (
                    <div className="bookmark-card__menu-panel">
                      <RouteLink
                        navigate={navigateRoute}
                        onNavigate={() => {
                          setOpenBookmarkMenuKey(null)
                        }}
                        route={seriesRoute(series)}
                      >
                        <AppIcon name="chevronRight" />
                        {text.openSeries}
                      </RouteLink>
                      <button
                        disabled={removingBookmarkSeriesId === series.id}
                        onClick={() => void handleRemoveBookmark(series.id)}
                        type="button"
                      >
                        <AppIcon name="close" />
                        {text.removeBookmark}
                      </button>
                    </div>
                  )}
                </article>
              )
            })
          )}
        </section>
      )}
      </div>
    )
  }

  const renderDownloads = () => {
    const filteredDownloads = offlineDownloads.filter((record) => {
      if (offlineFilter === 'active') {
        return isOfflineDownloadActive(record)
      }

      if (offlineFilter === 'ready') {
        return record.status === 'ready'
      }

      if (offlineFilter === 'attention') {
        return ['failed', 'partial', 'stale', 'paused'].includes(record.status)
      }

      return true
    })
    const storageRatio =
      offlineStorageSummary?.browserQuotaBytes && offlineStorageSummary.browserQuotaBytes > 0
        ? Math.min(1, (offlineStorageSummary.browserUsageBytes || 0) / offlineStorageSummary.browserQuotaBytes)
        : 0
    const allDownloadsBusy = Boolean(offlineBusyIds['all-downloads'])

    return (
      <div className="page page--downloads">
        {offlineMode && (
          <article className="panel panel--padded offline-mode-banner">
            <span className="settings-row__icon">
              <AppIcon name="offline" />
            </span>
            <div>
              <strong>{text.offlineMode}</strong>
              <p>{text.offlineModeHelp}</p>
            </div>
          </article>
        )}

        <section className="downloads-hero">
          <div>
            <p className="section-kicker">{text.downloadsStorage}</p>
            <h2>{formatBytes(offlineStorageSummary?.downloadedBytes ?? 0, language)}</h2>
            <p>{text.downloadsDeviceOnly}</p>
          </div>
          <div className="downloads-storage-card">
            <div className="downloads-storage-card__row">
              <span>{text.downloadedBytes}</span>
              <strong>{formatBytes(offlineStorageSummary?.downloadedBytes ?? 0, language)}</strong>
            </div>
            <div className="downloads-storage-card__row">
              <span>{text.verifiedBytes}</span>
              <strong>{formatBytes(offlineStorageSummary?.verifiedBytes ?? 0, language)}</strong>
            </div>
            <div className="downloads-storage-card__row">
              <span>{text.coverStorage}</span>
              <strong>
                {formatBytes(imageCacheSummary?.storedBytes ?? 0, language)}
                {imageCacheSummary?.imageCount ? ` · ${imageCacheSummary.imageCount}` : ''}
              </strong>
            </div>
            <div className="downloads-storage-card__row">
              <span>{text.browserStorageUsed}</span>
              <strong>{formatBytes(offlineStorageSummary?.browserUsageBytes, language)}</strong>
            </div>
            <div className="downloads-storage-meter" aria-hidden="true">
              <span style={{ width: `${storageRatio * 100}%` }} />
            </div>
            <div className="downloads-storage-card__row">
              <span>{text.browserStorageQuota}</span>
              <strong>{formatBytes(offlineStorageSummary?.browserQuotaBytes, language)}</strong>
            </div>
            <div className="downloads-storage-card__actions">
              <button
                className="ghost-button ghost-button--small"
                disabled={persistentStorageBusy || offlineStorageSummary?.persistent === true}
                onClick={() => void handleRequestPersistentStorage()}
                type="button"
              >
                <AppIcon name="hardDrive" />
                {offlineStorageSummary?.persistent ? text.persistentStorageGranted : text.requestPersistentStorage}
              </button>
              <button
                className="ghost-button ghost-button--small"
                disabled={!offlineDownloads.length || Boolean(offlineBusyIds['all-downloads'])}
                onClick={() => void handleDeleteAllDownloads()}
                type="button"
              >
                <AppIcon name="trash" />
                {text.deleteAllDownloads}
              </button>
              <button
                className="ghost-button ghost-button--small"
                disabled={!imageCacheSummary?.storedBytes || imageCacheBusy}
                onClick={() => void handleClearImageCache()}
                type="button"
              >
                <AppIcon name="trash" />
                {imageCacheBusy ? text.clearCoverStorageBusy : text.clearCoverStorage}
              </button>
              <button
                className="ghost-button ghost-button--small"
                disabled={imageCacheTestBusy}
                onClick={() => void handleTestImageCache()}
                type="button"
              >
                <AppIcon name="hardDrive" />
                {imageCacheTestBusy ? text.testCoverStorageBusy : text.testCoverStorage}
              </button>
            </div>
            <p className="helper-text">{text.persistentStorageHelp}</p>
            <p className="helper-text">{text.coverStorageHelp}</p>
            {imageCacheSummary?.backend && (
              <p className="helper-text">
                {text.coverStorageBackend(imageCacheSummary.backend)}
              </p>
            )}
            {imageCacheSummary?.lastError && (
              <p className="auth-error">
                Cover storage could not be inspected: {imageCacheSummary.lastError}
              </p>
            )}
            {imageCacheSummary?.lastWriteError && (
              <p className="auth-error">
                Cover storage error: {imageCacheSummary.lastWriteError}
              </p>
            )}
            {imageCacheTestResult && (
              <p className={imageCacheTestResult.passed ? 'auth-success' : 'auth-error'}>
                {imageCacheTestResult.passed
                  ? text.testCoverStoragePassed(
                      imageCacheTestResult.backend,
                      imageCacheTestResult.bytesRead,
                    )
                  : text.testCoverStorageFailed(imageCacheTestResult.error || 'Unknown error.')}
              </p>
            )}
          </div>
        </section>

        <section className="bookmark-filter-bar downloads-filter-bar" role="tablist" aria-label={text.downloadsTitle}>
          {[
            { id: 'all' as const, label: text.downloadsAll },
            { id: 'active' as const, label: text.downloadsActive },
            { id: 'ready' as const, label: text.downloadsReady },
            { id: 'attention' as const, label: text.downloadsPartial },
          ].map((item) => (
            <button
              className={`tab-button ${offlineFilter === item.id ? 'is-active' : ''}`}
              key={item.id}
              onClick={() => setOfflineFilter(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </section>

        <section className="downloads-list">
          {filteredDownloads.length === 0 ? (
            <article className="panel panel--padded">{text.downloadsEmpty}</article>
          ) : (
            filteredDownloads.map((record) => {
              const progressRatio = record.manifest.estimatedBytes
                ? Math.min(1, record.downloadedBytes / record.manifest.estimatedBytes)
                : record.resourceCount
                  ? record.downloadedResourceCount / record.resourceCount
                  : 0
              const statusLabel =
                record.status === 'ready'
                  ? text.downloadsReady
                  : record.status === 'downloading'
                    ? text.downloadsActive
                    : record.status === 'queued'
                      ? text.downloadsQueued
                      : record.status === 'paused'
                        ? text.downloadsPaused
                    : record.status === 'stale'
                      ? text.downloadStale
                      : record.status === 'failed'
                        ? text.downloadFailed
                        : record.status
              const targetBusy = offlineBusyIds[getOfflineTargetKey(record.manifest.target)]
              const rowBusy = offlineBusyIds[record.id] || targetBusy
              const activeDownload = isOfflineDownloadActive(record)

              return (
                <article className={`download-card download-card--${record.status}`} key={record.id}>
                  <div className="download-card__main">
                    <div className="download-card__icon">
                      <AppIcon name={record.status === 'ready' ? 'download' : activeDownload ? 'refresh' : 'offline'} />
                    </div>
                    <div>
                      <div className="download-card__topline">
                        <span className="section-kicker">{categoryLabel(record.manifest.category)}</span>
                        <span className="chip">{statusLabel}</span>
                      </div>
                      <h3>{record.manifest.title}</h3>
                      <p>{record.manifest.subtitle}</p>
                    </div>
                  </div>
                  <div className="download-card__meter" aria-hidden="true">
                    <span style={{ width: `${progressRatio * 100}%` }} />
                  </div>
                  <div className="download-card__stats">
                    <span>
                      {text.downloadedBytes}: {formatBytes(record.downloadedBytes, language)}
                    </span>
                    <span>
                      {text.estimatedBytes}: {formatBytes(record.manifest.estimatedBytes, language)}
                    </span>
                    <span>
                      {record.downloadedResourceCount} / {record.resourceCount}
                    </span>
                  </div>
                  {record.failureReason && <p className="download-card__error">{record.failureReason}</p>}
                  <div className="download-card__actions">
                    <button
                      className="primary-button"
                      disabled={record.status !== 'ready' || allDownloadsBusy}
                      onClick={() => openOfflineDownload(record)}
                      type="button"
                    >
                      <AppIcon name="read" />
                      {text.openOffline}
                    </button>
                    <button
                      className="ghost-button"
                      disabled={allDownloadsBusy || Boolean(rowBusy)}
                      onClick={() => void startOfflineDownload(record.manifest.target)}
                      type="button"
                    >
                      <AppIcon name="refresh" />
                      {record.status === 'ready' ? text.downloadAgain : text.repairDownload}
                    </button>
                    {activeDownload && (
                      <button
                        className="ghost-button"
                        disabled={allDownloadsBusy || (record.status !== 'queued' && !offlineRunningTargetsRef.current.has(getOfflineTargetKey(record.manifest.target)) && !targetBusy)}
                        onClick={() => void handleCancelDownload(record)}
                        type="button"
                      >
                        <AppIcon name="pause" />
                        {text.cancelDownload}
                      </button>
                    )}
                    <button
                      className="ghost-button"
                      disabled={allDownloadsBusy || Boolean(rowBusy)}
                      onClick={() => void handleDeleteDownload(record.id)}
                      type="button"
                    >
                      <AppIcon name="trash" />
                      {text.deleteDownload}
                    </button>
                  </div>
                </article>
              )
            })
          )}
        </section>
      </div>
    )
  }

  const renderProfile = () => (
    <div className="page page--profile">
      <section className="profile-hero-panel">
        <span className="profile-avatar-large">
          {appState?.user?.username.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <p className="section-kicker">{text.profile}</p>
          <h2>{appState?.user?.username || text.profile}</h2>
          <p className="helper-text">{text.passwordChangeHelp}</p>
        </div>
      </section>

      <section className="settings-section">
        <h3>{text.accountActions}</h3>
        <div className="settings-list">
          <div className="settings-row">
            <span className="settings-row__icon">
              <AppIcon name="profile" />
            </span>
            <div>
              <strong>{text.accountSettings}</strong>
              <p>{appState?.user?.role || 'member'}</p>
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-row__icon">
              <AppIcon name="settings" />
            </span>
            <div>
              <strong>{text.appVersion}</strong>
              <p>
                {isNativeApp
                  ? `${text.androidApp} ${androidAppVersionName} (build ${androidAppVersionCode})`
                  : text.webApp}
              </p>
            </div>
          </div>

          <div className="settings-row settings-row--split">
            <span className="settings-row__icon">
              <AppIcon name="language" />
            </span>
            <div>
              <strong>{text.language}</strong>
              <p>{language.toUpperCase()}</p>
            </div>
            <div className="language-toggle">
              <button
                className={language === 'en' ? 'is-active' : ''}
                onClick={() => setLanguage('en')}
                type="button"
              >
                EN
              </button>
              <button
                className={language === 'de' ? 'is-active' : ''}
                onClick={() => setLanguage('de')}
                type="button"
              >
                DE
              </button>
            </div>
          </div>

          {appState?.user?.role === 'admin' && (
            <RouteLink
              className="settings-row settings-row--button"
              navigate={navigateRoute}
              route={{ name: 'admin' }}
            >
              <span className="settings-row__icon">
                <AppIcon name="admin" />
              </span>
              <div>
                <strong>{text.adminTools}</strong>
                <p>{text.scanMode}</p>
              </div>
              <span className="settings-row__chevron">
                <AppIcon name="chevronRight" />
              </span>
            </RouteLink>
          )}

          <RouteLink
            className="settings-row settings-row--button"
            navigate={navigateRoute}
            route={{ name: 'downloads' }}
          >
            <span className="settings-row__icon">
              <AppIcon name="download" />
            </span>
            <div>
              <strong>{text.downloadsTitle}</strong>
              <p>{text.downloadsBody}</p>
            </div>
            <span className="settings-row__chevron">
              <AppIcon name="chevronRight" />
            </span>
          </RouteLink>

          <a
            className="settings-row settings-row--button"
            download="orbital-android.apk"
            href={resolveApiUrl(`/api/mobile/app.apk?v=${androidAppVersionCode}`)}
          >
            <span className="settings-row__icon">
              <AppIcon name="download" />
            </span>
            <div>
              <strong>{text.androidAppDownload}</strong>
              <p>{text.androidAppDownloadBody}</p>
            </div>
            <span className="settings-row__chevron">
              <AppIcon name="chevronRight" />
            </span>
          </a>

          <button
            className="settings-row settings-row--button"
            disabled={cacheResetBusy}
            onClick={() => void handleResetLocalCache()}
            type="button"
          >
            <span className="settings-row__icon">
              <AppIcon name="refresh" />
            </span>
            <div>
              <strong>{cacheResetBusy ? text.resetLocalCacheBusy : text.resetLocalCache}</strong>
              <p>{text.resetLocalCacheHelp}</p>
            </div>
            <span className="settings-row__chevron">
              <AppIcon name="chevronRight" />
            </span>
          </button>

          <button className="settings-row settings-row--button" onClick={() => void handleLogout()} type="button">
            <span className="settings-row__icon">
              <AppIcon name="logout" />
            </span>
            <div>
              <strong>{text.logout}</strong>
              <p>{text.brandName}</p>
            </div>
            <span className="settings-row__chevron">
              <AppIcon name="chevronRight" />
            </span>
          </button>
        </div>
      </section>

      <section className="bookmark-settings-grid">
        <article className="panel panel--padded account-panel">
          <div className="panel__header">
            <div>
              <h3>{text.changePassword}</h3>
              <p className="helper-text">{text.passwordChangeHelp}</p>
            </div>
            <span className="settings-row__icon">
              <AppIcon name="key" />
            </span>
          </div>
          <form className="auth-form account-password-form" onSubmit={handleChangePassword}>
            <label>
              <span>{text.currentPassword}</span>
              <input
                autoCapitalize="none"
                autoComplete="current-password"
                autoCorrect="off"
                name="currentPassword"
                spellCheck={false}
                type="password"
              />
            </label>
            <label>
              <span>{text.newPassword}</span>
              <input
                autoCapitalize="none"
                autoComplete="new-password"
                autoCorrect="off"
                name="newPassword"
                spellCheck={false}
                type="password"
              />
            </label>
            <label>
              <span>{text.confirmPassword}</span>
              <input
                autoCapitalize="none"
                autoComplete="new-password"
                autoCorrect="off"
                name="confirmPassword"
                spellCheck={false}
                type="password"
              />
            </label>

            {passwordChangeError && <p className="auth-error">{passwordChangeError}</p>}
            {passwordChangeSuccess && <p className="auth-success">{passwordChangeSuccess}</p>}

            <button className="primary-button" disabled={passwordChangeBusy} type="submit">
              {text.changePassword}
            </button>
          </form>
        </article>
      </section>
    </div>
  )

  const renderSearchPage = () => (
    <div className="page page--search">
      <section className="mobile-search-page">
        <div className="mobile-search-page__bar">
          <AppIcon name="search" />
          <input
            ref={mobileSearchInputRef}
            onChange={(event) => updateSearchQuery(event.target.value)}
            placeholder={text.searchPlaceholder}
            value={searchQuery}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          {searchQuery && (
            <button className="ghost-button ghost-button--small" onClick={() => updateSearchQuery('')} type="button">
              <AppIcon name="close" />
              {text.clearSearch}
            </button>
          )}
        </div>

        <div className="mobile-search-page__header">
          <h2>{text.searchTitle}</h2>
        </div>

        <div className="search-popover__scope">
          {readerScopeOrder.map((scope) => (
            <button
              className={`scope-button ${searchScope === scope ? 'is-active' : ''}`}
              key={scope}
              onClick={() => updateSearchScope(scope)}
              type="button"
            >
              {text.scopes[scope]}
            </button>
          ))}
        </div>

        <div className="mobile-search-page__results">
          {deferredSearch === '' ? (
            searchPageBrowseResults.length > 0 ? (
              <section className="series-grid series-grid--shelf search-scope-grid">
                {searchPageBrowseResults.map((series) => renderSeriesCard(series))}
              </section>
            ) : null
          ) : searchLoading ? (
            <article className="panel panel--padded search-state">{text.searching}</article>
          ) : searchPreview.length === 0 ? (
            <article className="panel panel--padded search-state">{text.searchNoMatches}</article>
          ) : (
            searchPreview.map((series) => (
              <RouteLink
                className="search-result"
                key={series.id}
                navigate={navigateRoute}
                onNavigate={() => {
                  setSearchOpen(false)
                }}
                route={seriesRoute(series)}
              >
                {renderPoster(series, true)}
                <div>
                  <strong>{getSeriesDisplayTitle(series)}</strong>
                  <p>{categoryLabel(series.category)} • {series.progressLabel}</p>
                </div>
              </RouteLink>
            ))
          )}
        </div>
      </section>
    </div>
  )

  const renderLibrary = () => (
    <div className="page page--library">
      <section className="toolbar-panel">
        <div>
          <p className="section-kicker">{text.libraryTitle}</p>
          <h2>
            <span className="desktop-only">{pageTitle}</span>
            <span className="mobile-only">{text.mobileNav.discover}</span>
          </h2>
        </div>
        <div className="chip-row discover-meta-row">
          <span className="chip chip--accent">{text.scopes[currentCategory]}</span>
          <span className="chip">
            {libraryResults.length} {text.searchCount}
          </span>
          <span className="chip">
            {deferredSearch !== '' ? `Scope: ${text.scopes[searchScope]}` : text[discoverViewMode === 'grid' ? 'gridView' : 'listView']}
          </span>
        </div>
        <div className="discover-controls">
          <div className="segmented-control" aria-label={text.sortBy}>
            <button
              className={discoverSort === 'title' ? 'is-active' : ''}
              onClick={() => updateLibraryRoute({ sort: 'title' })}
              type="button"
            >
              {text.sortTitle}
            </button>
            <button
              className={discoverSort === 'year' ? 'is-active' : ''}
              onClick={() => updateLibraryRoute({ sort: 'year' })}
              type="button"
            >
              {text.sortYear}
            </button>
          </div>
          <div className="segmented-control" aria-label={text.viewMode}>
            <button
              className={discoverViewMode === 'grid' ? 'is-active' : ''}
              onClick={() => setDiscoverViewMode('grid')}
              type="button"
            >
              {text.gridView}
            </button>
            <button
              className={discoverViewMode === 'list' ? 'is-active' : ''}
              onClick={() => setDiscoverViewMode('list')}
              type="button"
            >
              {text.listView}
            </button>
          </div>
        </div>
        {currentCategory === 'books' && bookTopicOptions.length > 0 && deferredSearch === '' && (
          <div className="library-filter-summary">
            <button className="ghost-button" onClick={() => setFilterSheetOpen(true)} type="button">
              <AppIcon name="filter" />
              {text.filters}
            </button>
            <span className="chip">
              {bookTopicFilters.length === 0
                ? text.allTopics
                : `${text.activeFilter}: ${bookTopicFilters.length === 1 ? bookTopicFilters[0] : `${bookTopicFilters.length} selected`}`}
            </span>
          </div>
        )}
      </section>

      <nav className="discover-tabs" aria-label={text.mobileNav.discover}>
        {readerCategoryOrder.map((category) => (
          <RouteLink
            ariaCurrent={currentCategory === category ? 'page' : undefined}
            className={`discover-tab ${currentCategory === category ? 'is-active' : ''}`}
            key={category}
            navigate={navigateRoute}
            route={{
              name: 'library',
              category: categoryRouteId(category),
              topics: [],
              sort: discoverSort,
            }}
          >
            {text.nav[category]}
          </RouteLink>
        ))}
      </nav>

      {currentCategory === 'books' && filterSheetOpen && (
        <div className="sheet-backdrop" role="presentation" onMouseDown={() => setFilterSheetOpen(false)}>
          <section
            aria-label={text.booksTopics}
            aria-modal="true"
            className="filter-sheet"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="filter-sheet__header">
              <div>
                <p className="section-kicker">{text.booksTopics}</p>
                <h3>{text.filters}</h3>
              </div>
              <button className="ghost-button ghost-button--small" onClick={() => setFilterSheetOpen(false)} type="button">
                <AppIcon name="close" />
                {text.closeFilters}
              </button>
            </div>
            <div className="filter-sheet__actions">
              <button
                className={`tab-button ${bookTopicFilters.length === 0 ? 'is-active' : ''}`}
                onClick={() => {
                  updateLibraryRoute({ topics: [] })
                }}
                type="button"
              >
                {bookTopicFilters.length === 0 && <AppIcon name="check" />}
                {text.allTopics}
              </button>
              {bookTopicFilters.length > 0 && (
                <button
                  className="ghost-button ghost-button--small"
                  onClick={() => updateLibraryRoute({ topics: [] })}
                  type="button"
                >
                  <AppIcon name="close" />
                  {text.clearFilter}
                </button>
              )}
            </div>
            <div className="filter-sheet__list" role="listbox" aria-multiselectable="true">
              {bookTopicOptions.map((topic) => (
                <button
                  aria-selected={bookTopicFilters.includes(topic)}
                  className={`filter-sheet__option ${bookTopicFilters.includes(topic) ? 'is-active' : ''}`}
                  key={topic}
                  onClick={() => {
                    updateLibraryRoute({
                      topics: bookTopicFilters.includes(topic)
                        ? bookTopicFilters.filter((filter) => filter !== topic)
                        : [...bookTopicFilters, topic],
                    })
                  }}
                  role="option"
                  type="button"
                >
                  <span>{topic}</span>
                  {bookTopicFilters.includes(topic) && (
                    <span>
                      <AppIcon name="check" />
                      Selected
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      <section className={`series-grid ${discoverViewMode === 'grid' ? 'series-grid--shelf' : ''}`}>
        {libraryResults.map((series) => renderSeriesCard(series))}
      </section>
    </div>
  )

  const renderOverviewTab = () => {
    if (!selectedSeriesSummary) {
      return null
    }

    const visibleTags = getVisibleSeriesTags(selectedSeriesSummary)
    const seriesOfflineTarget = {
      type: 'series',
      seriesId: selectedSeriesSummary.id,
    } satisfies OfflineDownloadTarget
    const seriesOfflineBusy = offlineBusyIds[getOfflineTargetKey(seriesOfflineTarget)]
    const seriesOfflineDownload = getReadyOfflineDownloadForSeries(selectedSeriesSummary, selectedSeries)

    return (
      <div className="series-tab-grid">
        <article className="panel panel--padded series-overview-panel">
          <h3>{text.synopsis}</h3>
          <p className="series-overview-panel__description">{selectedSeriesSummary.description}</p>
          {selectedSeriesSummary.genres.length > 0 && (
            <div className="chip-row">
              {selectedSeriesSummary.genres.map((genre) => (
                <span className="chip chip--accent" key={genre}>
                  {genre}
                </span>
              ))}
            </div>
          )}
          {visibleTags.length > 0 && (
            <div className="chip-row">
              {visibleTags.map((tag) => (
                selectedSeriesSummary.category === 'books' ? (
                  <RouteLink
                    className="chip-button chip"
                    key={tag}
                    navigate={navigateRoute}
                    route={{
                      name: 'library',
                      category: 'books',
                      topics: [tag],
                      sort: discoverSort,
                    }}
                  >
                    {tag}
                  </RouteLink>
                ) : (
                  <span className="chip" key={tag}>
                    {tag}
                  </span>
                )
              ))}
            </div>
          )}
        </article>

        <article className="panel panel--padded">
          <h3>{text.sourceDetails}</h3>
          <dl className="detail-list">
            {selectedSeriesSummary.sourceName && selectedSeriesCreatorProfile && (
              <div>
                <dt>{text.sourceLabel}</dt>
                <dd>
                  <RouteLink
                    className="link-button"
                    navigate={navigateRoute}
                    route={{
                      name: 'creator',
                      creatorKey: selectedSeriesCreatorProfile.key,
                    }}
                  >
                    {selectedSeriesSummary.sourceName}
                  </RouteLink>
                </dd>
              </div>
            )}
            {selectedSeriesSummary.sourceRole && (
              <div>
                <dt>{text.sourceRole}</dt>
                <dd>{selectedSeriesSummary.sourceRole}</dd>
              </div>
            )}
            <div>
              <dt>{text.onlineMatch}</dt>
              <dd>{selectedSeriesSummary.metadataSource}</dd>
            </div>
            {selectedSeriesSummary.year && (
              <div>
                <dt>Year</dt>
                <dd>{selectedSeriesSummary.year}</dd>
              </div>
            )}
          </dl>
          {selectedSeriesSummary.externalUrl && (
            <div className="series-overview-panel__actions">
              <a
                className="ghost-button"
                href={selectedSeriesSummary.externalUrl}
                rel="noreferrer"
                target="_blank"
              >
                {text.openSourcePage}
              </a>
            </div>
          )}
        </article>

        <article className="panel panel--padded">
          <h3>{text.moreFromCreator}</h3>
          {selectedSeriesCreatorProfile ? (
            <div className="action-stack">
              <RouteLink
                className="ghost-button"
                navigate={navigateRoute}
                route={{
                  name: 'creator',
                  creatorKey: selectedSeriesCreatorProfile.key,
                }}
              >
                {text.openCreatorPage}
              </RouteLink>
              {relatedCreatorSeries.length > 0 ? (
                relatedCreatorSeries.map((series) => (
                  <RouteLink
                    className="list-link-button"
                    key={series.id}
                    navigate={navigateRoute}
                    route={seriesRoute(series)}
                  >
                    <span>{getSeriesDisplayTitle(series)}</span>
                    <span>{formatCountLabel(series.category, series.stats.fileCount, language)}</span>
                  </RouteLink>
                ))
              ) : (
                <p className="helper-text">{text.noRelatedCreatorTitles}</p>
              )}
            </div>
          ) : (
            <p className="helper-text">{text.noRelatedCreatorTitles}</p>
          )}
        </article>

        <article className="panel panel--padded">
          <h3>{text.seriesActions}</h3>
          <div className="action-stack">
            {selectedSeries?.entries[0] ? (
              <RouteLink
                className="primary-button"
                navigate={navigateRoute}
                route={readerRoute(selectedSeriesSummary, selectedSeries.entries[0].id)}
              >
                {text.openReader}
              </RouteLink>
            ) : (
              <button className="primary-button" disabled type="button">
                {text.loadingSeries}
              </button>
            )}
            <button
              className="ghost-button"
              disabled={offlineMode || Boolean(seriesOfflineBusy)}
              onClick={() => (
                seriesOfflineDownload
                  ? openOfflineDownload(seriesOfflineDownload)
                  : void startOfflineDownload(seriesOfflineTarget)
              )}
              type="button"
            >
              <AppIcon name={seriesOfflineDownload ? 'offline' : 'download'} />
              {seriesOfflineBusy || (seriesOfflineDownload ? text.openOffline : text.downloadSeries)}
            </button>
            <RouteLink
              className="ghost-button"
              navigate={navigateRoute}
              route={seriesRoute(selectedSeriesSummary, 'comments')}
            >
              {text.comments}
            </RouteLink>
            <RouteLink
              className="ghost-button"
              navigate={navigateRoute}
              route={{ name: 'bookmarks', scope: 'all' }}
            >
              {text.welcome}
            </RouteLink>
          </div>
        </article>

        <article className="panel panel--padded">
          <h3>{text.libraryDetails}</h3>
          <dl className="detail-list">
            <div>
              <dt>{text.localCover}</dt>
              <dd>{selectedSeriesSummary.coverSource}</dd>
            </div>
            <div>
              <dt>{text.entryDetails}</dt>
              <dd>{selectedSeriesSummary.format}</dd>
            </div>
            <div>
              <dt>{text.lastScan}</dt>
              <dd>{formatRelativeTime(selectedSeriesSummary.stats.lastScanAt, language)}</dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd>{selectedSeriesSummary.folder}</dd>
            </div>
          </dl>
        </article>
      </div>
    )
  }

  const renderEntriesTab = () => {
    if (!selectedSeries) {
      return (
        <article className="panel panel--padded">
          <h3>{offlineMode ? text.offlineOnlyTitle : (seriesError || text.loadingSeries)}</h3>
          <p>{offlineMode ? text.offlineOnlyBody : text.loadingSeries}</p>
        </article>
      )
    }

    const seriesOfflineTarget = {
      type: 'series',
      seriesId: selectedSeries.id,
    } satisfies OfflineDownloadTarget
    const seriesOfflineBusy = offlineBusyIds[getOfflineTargetKey(seriesOfflineTarget)]
    const seriesOfflineDownload = getReadyOfflineDownloadForSeries(selectedSeries, selectedSeries)

    return (
      <div className="panel panel--padded">
        <div className="entry-table__toolbar">
          <div>
            <p className="section-kicker">{text.entries}</p>
            <p className="helper-text">
              {formatCountLabel(selectedSeries.category, selectedSeries.entries.length, language)}
            </p>
          </div>
          <button
            className="ghost-button"
            disabled={offlineMode || Boolean(seriesOfflineBusy)}
            onClick={() => (
              seriesOfflineDownload
                ? openOfflineDownload(seriesOfflineDownload)
                : void startOfflineDownload(seriesOfflineTarget)
            )}
            type="button"
          >
            <AppIcon name={seriesOfflineDownload ? 'offline' : 'download'} />
            {seriesOfflineBusy || (seriesOfflineDownload ? text.openOffline : text.downloadSeries)}
          </button>
        </div>
        {selectedSeries.category === 'anime' && availableAnimeSeasons.length > 1 && (
          <div className="season-filter-bar" role="tablist" aria-label="Anime seasons">
            {availableAnimeSeasons.map((seasonNumber) => (
              <button
                className={`tab-button ${selectedSeasonNumber === seasonNumber ? 'is-active' : ''}`}
                key={seasonNumber}
                onClick={() => updateSeriesSeason(seasonNumber)}
                type="button"
              >
                {formatSeasonLabel(seasonNumber, language)}
              </button>
            ))}
          </div>
        )}
        <table className="entry-table">
          <thead>
            <tr>
              <th>{text.entryLabel}</th>
              <th>{text.entryTitle}</th>
              <th>{text.entryDetails}</th>
              <th>{text.entryAction}</th>
            </tr>
          </thead>
          <tbody>
            {visibleSeriesEntries.map((entry) => {
              const entryOfflineTarget = {
                type: 'entry',
                entryId: entry.preferredVariantId,
              } satisfies OfflineDownloadTarget
              const entryOfflineBusy = offlineBusyIds[getOfflineTargetKey(entryOfflineTarget)]
              const entryOfflineDownload = getReadyOfflineDownloadForEntry(entry.preferredVariantId)
              const preferredFormat =
                entry.variants.find((variant) => variant.id === entry.preferredVariantId)?.format ||
                entry.variants[0]?.format ||
                'pdf'

              return (
                <tr key={entry.id}>
                  <td data-label={text.entryLabel}>{entry.label}</td>
                  <td data-label={text.entryTitle}>{formatDisplayEntryTitle(entry.title)}</td>
                  <td data-label={text.entryDetails}>{entry.details}</td>
                  <td data-label={text.entryAction}>
                    <div className="entry-table__actions">
                      <RouteLink
                        className="ghost-button"
                        navigate={navigateRoute}
                        route={readerRoute(selectedSeries, entry.id)}
                      >
                        {text.openReader}
                      </RouteLink>
                      <button
                        className="ghost-button"
                        disabled={Boolean(entryOfflineBusy)}
                        onClick={() => (
                          entryOfflineDownload
                            ? openOfflineDownload(entryOfflineDownload, entry.preferredVariantId)
                            : void startOfflineDownload(entryOfflineTarget)
                        )}
                        type="button"
                      >
                        <AppIcon name={entryOfflineDownload ? 'offline' : 'download'} />
                        {entryOfflineBusy ||
                          (entryOfflineDownload
                            ? text.openOffline
                            : getEntryDownloadLabel(preferredFormat, selectedSeries.category))}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  const renderCommentsTab = () => (
    <div className="comment-list">
      <article className="panel panel--padded comment-form">
        <h3>{text.addComment}</h3>
        <textarea
          className="comment-form__textarea"
          onChange={(event) => setCommentDraft(event.target.value)}
          placeholder={text.commentPlaceholder}
          value={commentDraft}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className="comment-form__actions">
          <button
            className="primary-button"
            disabled={commentBusy || !commentDraft.trim()}
            onClick={() => void handlePostComment()}
            type="button"
          >
            {text.postComment}
          </button>
        </div>
      </article>

      {!selectedSeries || selectedSeries.comments.length === 0 ? (
        <article className="panel panel--padded">{text.commentsEmpty}</article>
      ) : (
        selectedSeries.comments.map((comment) => (
          <article className="comment-card" key={comment.id}>
            <div className="comment-card__header">
              <strong>{comment.user}</strong>
              <span>{formatDateTime(comment.when, language)}</span>
            </div>
            <p>{comment.text}</p>
          </article>
        ))
      )}
    </div>
  )

  const renderSeries = () => {
    if (!selectedSeriesSummary) {
      return <article className="panel panel--padded">{seriesError || text.loadingSeries}</article>
    }

    const seriesCountLabel = formatCountLabel(
      selectedSeriesSummary.category,
      selectedSeriesSummary.stats.fileCount,
      language,
    )

    return (
      <div className="page page--series">
        <section className={`series-hero ${selectedSeriesBannerUrl ? 'series-hero--banner' : ''}`}>
          {selectedSeriesBannerUrl && (
            <div
              aria-hidden="true"
              className="series-hero__banner"
              style={{ backgroundImage: `url(${selectedSeriesBannerUrl})` }}
            />
          )}
          <div className="series-hero__poster">{renderPoster(selectedSeriesSummary)}</div>
          <div className="series-hero__content">
            <div className="series-hero__header">
              <div>
                <p className="section-kicker">{categoryLabel(selectedSeriesSummary.category)}</p>
                <h2>{selectedSeriesDisplayTitle}</h2>
              </div>
              <div className="series-hero__header-actions">
                {selectedSeriesSummary.externalUrl && (
                  <a
                    className="ghost-button ghost-button--small"
                    href={selectedSeriesSummary.externalUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {text.openSourcePage}
                  </a>
                )}
                <span className="status-pill status-pill--ok">{selectedSeriesSummary.status}</span>
              </div>
            </div>

            <p>{selectedSeriesSummary.description}</p>

            <div className="chip-row">
              <span className="chip chip--accent">{selectedSeriesSummary.progressLabel}</span>
              {offlineMode && (
                <span className="chip">
                  {getReadyOfflineDownloadForSeries(selectedSeriesSummary, selectedSeries)
                    ? text.downloadsReady
                    : text.offlineOnly}
                </span>
              )}
              {selectedSeriesSummary.sourceName && selectedSeriesCreatorProfile && (
                <RouteLink
                  className="chip-button chip"
                  navigate={navigateRoute}
                  route={{
                    name: 'creator',
                    creatorKey: selectedSeriesCreatorProfile.key,
                  }}
                >
                  {getSeriesSourceText(selectedSeriesSummary)}
                </RouteLink>
              )}
              {seriesCountLabel !== selectedSeriesSummary.progressLabel && (
                <span className="chip">{seriesCountLabel}</span>
              )}
              {selectedSeriesSummary.year && <span className="chip">{selectedSeriesSummary.year}</span>}
              <span className="chip">
                {text.lastScan}: {formatRelativeTime(selectedSeriesSummary.stats.lastScanAt, language)}
              </span>
              {selectedSeriesSummary.genres.slice(0, 3).map((genre) => (
                <span className="chip" key={genre}>
                  {genre}
                </span>
              ))}
            </div>

            <nav className="tab-row" aria-label={selectedSeriesDisplayTitle || text.entries}>
              <RouteLink
                ariaCurrent={activeTab === 'overview' ? 'page' : undefined}
                className={`tab-button ${activeTab === 'overview' ? 'is-active' : ''}`}
                navigate={navigateRoute}
                route={seriesRoute(selectedSeriesSummary, 'overview')}
              >
                {text.overview}
              </RouteLink>
              <RouteLink
                ariaCurrent={activeTab === 'entries' ? 'page' : undefined}
                className={`tab-button ${activeTab === 'entries' ? 'is-active' : ''}`}
                navigate={navigateRoute}
                route={seriesRoute(selectedSeriesSummary, 'entries')}
              >
                {text.entries}
              </RouteLink>
              <RouteLink
                ariaCurrent={activeTab === 'comments' ? 'page' : undefined}
                className={`tab-button ${activeTab === 'comments' ? 'is-active' : ''}`}
                navigate={navigateRoute}
                route={seriesRoute(selectedSeriesSummary, 'comments')}
              >
                {text.comments}
              </RouteLink>
            </nav>
          </div>
        </section>

        {activeTab === 'overview' && renderOverviewTab()}
        {activeTab === 'entries' && renderEntriesTab()}
        {activeTab === 'comments' && renderCommentsTab()}
      </div>
    )
  }

  const renderCreator = () => {
    if (!selectedCreatorProfile) {
      return <article className="panel panel--padded">{text.creatorProfile}</article>
    }

    return (
      <div className="page page--creator">
        <section className="toolbar-panel creator-hero">
          <div>
            <p className="section-kicker">{text.creatorProfile}</p>
            <h2>{selectedCreatorProfile.name}</h2>
            <p className="creator-hero__body">
              {selectedCreatorProfile.role
                ? `${selectedCreatorProfile.role} • ${selectedCreatorProfile.series.length} ${text.creatorWorks}`
                : `${selectedCreatorProfile.series.length} ${text.creatorWorks}`}
            </p>
          </div>
          <div className="chip-row">
            {selectedCreatorProfile.role && <span className="chip chip--accent">{selectedCreatorProfile.role}</span>}
            {selectedCreatorProfile.categories.map((category) => (
              <RouteLink
                className="chip-button chip"
                key={category}
                navigate={navigateRoute}
                route={{
                  name: 'library',
                  category: categoryRouteId(category),
                  topics: [],
                  sort: discoverSort,
                }}
              >
                {text.scopes[category]}
              </RouteLink>
            ))}
            <span className="chip">
              {selectedCreatorProfile.series.length} {text.creatorWorks}
            </span>
          </div>
        </section>

        <section className="series-grid">{selectedCreatorProfile.series.map((series) => renderSeriesCard(series))}</section>
      </div>
    )
  }

  const renderReaderPreview = () => {
    if (
      offlineMode &&
      currentEntry &&
      currentVariant &&
      !isOfflineLocalResourceUrl(currentVariant.fileUrl)
    ) {
      return (
        <article className="panel panel--padded">
          <h3>{currentEntryOfflineDownload ? text.downloadsReady : text.offlineOnlyTitle}</h3>
          <p>
            {currentEntryOfflineDownload
              ? text.offlineDownloadedReaderBody
              : text.offlineOnlyBody}
          </p>
          {currentEntryOfflineDownload && (
            <button
              className="primary-button"
              onClick={() => openOfflineDownload(currentEntryOfflineDownload, currentEntry.id)}
              type="button"
            >
              <AppIcon name="offline" />
              {text.openOffline}
            </button>
          )}
        </article>
      )
    }

    if (!selectedSeriesSummary || !currentEntry || !currentVariant) {
      if (offlineMode) {
        return (
          <article className="panel panel--padded">
            <h3>{text.offlineOnlyTitle}</h3>
            <p>{text.offlineOnlyBody}</p>
          </article>
        )
      }

      return <article className="panel panel--padded">{text.loadingSeries}</article>
    }

    const onNextEntry =
      selectedSeries && selectedEntryIndex < selectedSeries.entries.length - 1
        ? () => void moveEntry(1)
        : undefined

    if (selectedSeriesSummary.category === 'anime') {
      return (
        <div className="reader-layout">
          <VideoPlayer variant={currentVariant} />
        </div>
      )
    }

    if (currentVariant.format === 'cbz') {
      return (
        <div className="reader-layout">
          <CbzReader
            entryId={currentVariant.id}
            fileUrl={currentVariant.fileUrl}
            offlinePages={currentOfflinePages ?? undefined}
            initialPage={currentReaderStartPosition?.page ?? 1}
            onNextEntry={onNextEntry}
            onSettingsChange={handleReaderSettingsChange}
            onProgressChange={handleReaderProgressChange}
            settings={currentReaderSettings}
            toolbarAccessory={readerToolbarAccessory}
            title={formatDisplayEntryTitle(currentEntry.title)}
          />
        </div>
      )
    }

    if (currentVariant.format === 'md' || currentVariant.format === 'txt') {
      return (
        <div className="reader-layout">
          <TextFileReader
            fileUrl={currentVariant.fileUrl}
            format={currentVariant.format}
            initialProgress={currentReaderStartPosition?.page ?? 0}
            onNextEntry={onNextEntry}
            onSettingsChange={handleReaderSettingsChange}
            onProgressChange={handleReaderProgressChange}
            settings={currentReaderSettings}
            toolbarAccessory={readerToolbarAccessory}
            title={formatDisplayEntryTitle(currentEntry.title)}
          />
        </div>
      )
    }

    if (currentVariant.format === 'pdf') {
      return (
        <div className="reader-layout">
          <PdfEmbed
            fileUrl={currentVariant.fileUrl}
            initialPage={currentReaderStartPosition?.page ?? 1}
            onNextEntry={onNextEntry}
            onSettingsChange={handleReaderSettingsChange}
            onProgressChange={handleReaderProgressChange}
            settings={currentReaderSettings}
            toolbarAccessory={readerToolbarAccessory}
            title={formatDisplayEntryTitle(currentEntry.title)}
          />
        </div>
      )
    }

    if (currentVariant.format === 'html') {
      return (
        <div className="reader-layout">
          <HtmlChapterReader
            fileUrl={currentVariant.fileUrl}
            initialProgress={currentReaderStartPosition?.page ?? 0}
            onNextEntry={onNextEntry}
            onSettingsChange={handleReaderSettingsChange}
            onProgressChange={handleReaderProgressChange}
            settings={currentReaderSettings}
            toolbarAccessory={readerToolbarAccessory}
            title={formatDisplayEntryTitle(currentEntry.title)}
          />
        </div>
      )
    }

    if (currentVariant.format === 'epub') {
      return (
        <div className="reader-layout">
          <EpubReader
            fileUrl={currentVariant.fileUrl}
            initialProgress={currentReaderStartPosition?.page ?? 0}
            onNextEntry={onNextEntry}
            onSettingsChange={handleReaderSettingsChange}
            onProgressChange={handleReaderProgressChange}
            settings={currentReaderSettings}
            toolbarAccessory={readerToolbarAccessory}
            title={formatDisplayEntryTitle(currentEntry.title)}
          />
        </div>
      )
    }

    return (
      <div className="reader-layout">
        <article className="novel-card">
          <span className="section-kicker">{currentVariant.format.toUpperCase()}</span>
          <h3>{formatDisplayEntryTitle(currentEntry.title)}</h3>
          <p>
            This entry format is stored and indexed correctly, but it does not have a dedicated in-app renderer yet.
          </p>
          <div className="bookmark-card__actions">
            {readerToolbarAccessory}
            <button
              className="ghost-button"
              onClick={() => window.open(currentVariant.downloadUrl, '_blank', 'noopener,noreferrer')}
              type="button"
            >
              {text.openOriginal}
            </button>
          </div>
        </article>
      </div>
    )
  }

  const renderReader = () => {
    const readerTitle = currentEntry
      ? `${currentEntry.label}: ${formatDisplayEntryTitle(currentEntry.title)}`
      : text.loadingSeries
    const progressLabel =
      readerProgress?.progressLabel ||
      currentReaderStartPosition?.progressLabel ||
      (readerProgress ? buildReaderLocation(currentCategory, readerProgress, currentEntry?.label || '').progress : null) ||
      currentReaderStartPosition?.cueLabel ||
      currentEntry?.label ||
      ''
    const readerResetKey = `${currentVariant?.id ?? 'no-variant'}-${currentEntry?.id ?? 'no-entry'}`
    const renderReaderCrashFallback = (message: string | null) => (
      <div className="reader-layout">
        <article className="novel-card">
          <span className="section-kicker">{currentVariant?.format.toUpperCase() || 'Reader'}</span>
          <h3>{currentEntry ? formatDisplayEntryTitle(currentEntry.title) : text.loadingSeries}</h3>
          <p>
            This reader hit a browser rendering issue. The original file can still be opened directly.
          </p>
          {message && <p className="helper-text">{message}</p>}
          <div className="bookmark-card__actions">
            {currentVariant && (
              <button
                className="ghost-button"
                onClick={() => window.open(currentVariant.downloadUrl, '_blank', 'noopener,noreferrer')}
                type="button"
              >
                {text.openOriginal}
              </button>
            )}
          </div>
        </article>
      </div>
    )

    return (
      <div
        className={`page page--reader ${readerChromeVisible ? 'reader-chrome-visible' : 'reader-chrome-hidden'}`}
        onClick={handleReaderClick}
        onTouchEnd={handleReaderTouchEnd}
        onTouchStart={handleReaderTouchStart}
      >
        <section className="reader-overlay reader-overlay--top">
          <button
            className="reader-overlay__button"
            onClick={() => void handleReaderBack()}
            type="button"
          >
            <AppIcon name="back" />
            <span>{text.back}</span>
          </button>
          <div className="reader-overlay__title">
            <span>{selectedSeriesDisplayTitle || text.loadingSeries}</span>
            <strong>{readerTitle}</strong>
          </div>
        </section>

        <div className="reader-stage">
          <ReaderErrorBoundary
            fallback={renderReaderCrashFallback}
            key={readerResetKey}
            resetKey={readerResetKey}
          >
            <Suspense fallback={<article className="panel panel--padded">{text.loadingSeries}</article>}>
              {renderReaderPreview()}
            </Suspense>
          </ReaderErrorBoundary>
        </div>

        <section className="reader-overlay reader-overlay--bottom">
          <button
            aria-label={text.previousEntry}
            className="ghost-button"
            disabled={!selectedSeries || selectedEntryIndex === 0}
            onClick={() => moveEntry(-1)}
            type="button"
          >
            <AppIcon name="back" />
            <span className="reader-overlay__button-label" data-short-label={text.previousEntryShort}>
              {text.previousEntry}
            </span>
          </button>
          <div className="reader-overlay__progress">
            {progressLabel && <span>{progressLabel}</span>}
            <button
              aria-label={bookmarkJustSet ? text.bookmarked : text.setBookmark}
              className="primary-button"
              onClick={() => void handleSetBookmark()}
              type="button"
            >
              <AppIcon name="check" />
              <span
                className="reader-overlay__button-label"
                data-short-label={bookmarkJustSet ? text.bookmarkedShort : text.setBookmarkShort}
              >
                {bookmarkJustSet ? text.bookmarked : text.setBookmark}
              </span>
            </button>
          </div>
          <button
            aria-label={text.nextEntry}
            className="ghost-button"
            disabled={!selectedSeries || selectedEntryIndex === (selectedSeries.entries.length || 1) - 1}
            onClick={() => moveEntry(1)}
            type="button"
          >
            <span className="reader-overlay__button-label" data-short-label={text.nextEntryShort}>
              {text.nextEntry}
            </span>
            <AppIcon name="chevronRight" />
          </button>
        </section>
      </div>
    )
  }

  const renderScanLog = () => {
    const sourceProgressRatio =
      scanStatus?.currentSourceSeriesTotal && scanStatus.currentSourceSeriesTotal > 0
        ? Math.min(
            1,
            (scanStatus.currentSourceSeriesCompleted || 0) / scanStatus.currentSourceSeriesTotal,
          )
        : 0
    const rawScanEvents = [
      ...(scanStatus?.events || []),
      ...(scanClientNotice ? [scanClientNotice] : []),
    ].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
    const rawScanLines = [
      scanStatus?.runId
        ? `[${formatDateTime(scanStatus.startedAt, language)}] RUN ${scanStatus.runId} ${
            scanStatus.active ? 'running' : 'finished'
          }${scanStatus.summary ? ` - ${scanStatus.summary}` : ''}`
        : null,
      ...rawScanEvents.map(
        (event) =>
          `[${formatDateTime(event.createdAt, language)}] ${event.level.toUpperCase()} ${event.message}`,
      ),
    ].filter((line): line is string => Boolean(line))

    return (
      <article className="panel panel--padded admin-scan-log">
        <div className="panel__header">
          <h3>{text.scanActivity}</h3>
          <span>{scanIsActive ? text.scanInProgress : text.scanIdle}</span>
        </div>

        <div className="admin-scan-log__summary">
          <div className="chip-row">
            <span className={`chip ${scanIsActive ? 'chip--accent' : ''}`}>
              {scanIsActive
                ? `${scanStatus?.completedSources || 0} / ${scanStatus?.totalSources || 0}`
                : text.scanReady}
            </span>
            {scanStatus?.summary && <span className="chip">{scanStatus.summary}</span>}
            {scanStatus?.finishedAt && !scanIsActive && (
              <span className="chip">
                {text.lastScan}: {formatRelativeTime(scanStatus.finishedAt, language)}
              </span>
            )}
          </div>

          <div className="admin-scan-log__live">
            <div className="admin-scan-log__progress-bar" aria-hidden="true">
              <span style={{ width: `${sourceProgressRatio * 100}%` } satisfies CSSProperties} />
            </div>

            <dl className="detail-list detail-list--inline admin-scan-log__metrics">
              <div>
                <dt>{text.linkedFolderProgress}</dt>
                <dd>
                  {scanStatus?.completedSources || 0} / {scanStatus?.totalSources || 0}
                </dd>
              </div>
              <div>
                <dt>{text.filesDiscovered}</dt>
                <dd>{scanStatus?.currentSourceFilesDiscovered?.toLocaleString() ?? '—'}</dd>
              </div>
              <div>
                <dt>{text.detectedSeries}</dt>
                <dd>{scanStatus?.currentSourceSeriesTotal?.toLocaleString() ?? '—'}</dd>
              </div>
              <div>
                <dt>{text.indexedSeries}</dt>
                <dd>
                  {scanStatus?.currentSourceSeriesTotal
                    ? `${scanStatus.currentSourceSeriesCompleted} / ${scanStatus.currentSourceSeriesTotal}`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>{text.currentSource}</dt>
                <dd>{scanStatus?.currentSource || '—'}</dd>
              </div>
              <div>
                <dt>{text.currentSeries}</dt>
                <dd>{scanStatus?.currentSeries || '—'}</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="admin-scan-log__events">
          {scanStatus?.events.length ? (
            scanStatus.events
              .slice()
              .reverse()
              .map((event) => (
                <div className="admin-scan-log__event" key={event.id}>
                  <span className={`status-pill admin-scan-log__level admin-scan-log__level--${event.level}`}>
                    {event.level}
                  </span>
                  <div className="admin-scan-log__event-body">
                    <strong>{event.message}</strong>
                    <span>{formatDateTime(event.createdAt, language)}</span>
                  </div>
                </div>
              ))
          ) : (
            <div className="admin-scan-log__empty">{text.scanLogEmpty}</div>
          )}
        </div>

        <div className="admin-scan-log__raw">
          <div className="admin-scan-log__raw-header">
            <strong>{text.scanRawLog}</strong>
            <span>{text.scanRawLogHelp}</span>
          </div>
          {rawScanLines.length ? (
            <pre>{rawScanLines.join('\n')}</pre>
          ) : (
            <div className="admin-scan-log__empty">{text.scanRawLogEmpty}</div>
          )}
        </div>
      </article>
    )
  }

  const renderMetadataReview = () => (
    <article className="panel panel--padded metadata-review">
      <div className="panel__header">
        <h3>{text.metadataReview}</h3>
        <span>{metadataReviewItems.length} items</span>
      </div>
      <div className="admin-list metadata-review__list">
        {metadataReviewItems.length ? (
          metadataReviewItems.map((item) => (
            <button
              className={`admin-row admin-row--button metadata-review__item ${
                selectedMetadataSeries?.id === item.id ? 'metadata-review__item--active' : ''
              }`}
              key={item.id}
              onClick={() => handleSelectMetadataSeries(item.id)}
              type="button"
            >
              {item.coverUrl ? (
                <AuthenticatedResourceImage
                  alt=""
                  className="metadata-review__cover"
                  ownerUserId={sessionUser?.id}
                  sourceUrl={item.coverUrl}
                />
              ) : (
                <div className="metadata-review__cover metadata-review__cover--empty" />
              )}
              <div className="metadata-review__body">
                <strong>{item.title}</strong>
                <p>{item.summary}</p>
                <div className="chip-row">
                  <span className="chip">{categoryLabel(item.category)}</span>
                  <span className={`status-pill ${item.status === 'Review' ? 'admin-scan-log__level--info' : 'status-pill--ok'}`}>
                    {item.status}
                  </span>
                </div>
              </div>
              <span className="metadata-review__reason">{item.reason}</span>
            </button>
          ))
        ) : (
          <div className="admin-scan-log__empty">{text.metadataNoItems}</div>
        )}
      </div>
    </article>
  )

  const renderMetadataEditor = () => (
    <article className="panel panel--padded metadata-editor">
      <div className="panel__header">
        <h3>{text.metadataEditor}</h3>
        <span>{selectedMetadataSeries ? categoryLabel(selectedMetadataSeries.category) : '—'}</span>
      </div>

      <label className="metadata-editor__search">
        <span>{text.quickResults}</span>
        <input
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          onChange={(event) => setMetadataSearchQuery(event.target.value)}
          placeholder={text.metadataSearchPlaceholder}
          type="search"
          value={metadataSearchQuery}
        />
      </label>

      {metadataSearchResults.length > 0 && (
        <div className="metadata-editor__results">
          {metadataSearchResults.map((series) => (
            <button
              className="ghost-button ghost-button--small"
              key={series.id}
              onClick={() => {
                handleSelectMetadataSeries(series.id)
                setMetadataSearchQuery('')
              }}
              type="button"
            >
              {getSeriesDisplayTitle(series)}
            </button>
          ))}
        </div>
      )}

      {selectedMetadataSeries ? (
        <>
          <div className="metadata-editor__summary">
            {selectedMetadataSeries.coverUrl ? (
              <AuthenticatedResourceImage
                alt=""
                className="metadata-editor__cover"
                ownerUserId={sessionUser?.id}
                sourceUrl={selectedMetadataSeries.coverUrl}
              />
            ) : (
              <div className="metadata-editor__cover metadata-editor__cover--empty" />
            )}
            <div className="metadata-editor__summary-body">
              <strong>{selectedMetadataSeries.title}</strong>
              <p>{selectedMetadataSeries.description}</p>
              <dl className="detail-list">
                <div>
                  <dt>{text.metadataCurrentState}</dt>
                  <dd>{selectedMetadataSeries.coverSource} • {selectedMetadataSeries.metadataSource}</dd>
                </div>
                <div>
                  <dt>{text.metadataReason}</dt>
                  <dd>
                    {metadataReviewItems.find((item) => item.id === selectedMetadataSeries.id)?.reason || 'Metadata cached'}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <form className="admin-form metadata-editor__form" onSubmit={handleSaveMetadataOverride}>
            <label>
              <span>{text.metadataOverrideTitle}</span>
              <input onChange={(event) => setMetadataTitleDraft(event.target.value)} type="text" value={metadataTitleDraft} />
            </label>
            <label>
              <span>{text.metadataOverrideYear}</span>
              <input onChange={(event) => setMetadataYearDraft(event.target.value)} type="number" value={metadataYearDraft} />
            </label>
            <label>
              <span>{text.metadataOverrideSourceName}</span>
              <input onChange={(event) => setMetadataSourceNameDraft(event.target.value)} type="text" value={metadataSourceNameDraft} />
            </label>
            <label>
              <span>{text.metadataOverrideSourceRole}</span>
              <input onChange={(event) => setMetadataSourceRoleDraft(event.target.value)} type="text" value={metadataSourceRoleDraft} />
            </label>
            <label>
              <span>{text.metadataOverrideExternalUrl}</span>
              <input onChange={(event) => setMetadataExternalUrlDraft(event.target.value)} type="url" value={metadataExternalUrlDraft} />
            </label>
            <label>
              <span>{text.metadataOverrideCoverUrl}</span>
              <input onChange={(event) => setMetadataCoverUrlDraft(event.target.value)} type="url" value={metadataCoverUrlDraft} />
            </label>
            <label className="metadata-editor__textarea">
              <span>{text.metadataOverrideDescription}</span>
              <textarea
                onChange={(event) => setMetadataDescriptionDraft(event.target.value)}
                rows={8}
                value={metadataDescriptionDraft}
              />
            </label>

            <div className="action-stack metadata-editor__actions">
              <button className="primary-button" disabled={adminBusy || scanIsActive} type="submit">
                {text.metadataSave}
              </button>
              <button
                className="ghost-button"
                disabled={adminBusy || scanIsActive}
                onClick={() => void handleRefreshMetadataMatch()}
                type="button"
              >
                {text.metadataRefresh}
              </button>
              <button
                className="ghost-button"
                disabled={adminBusy || scanIsActive}
                onClick={() => void handleClearMetadataOverride()}
                type="button"
              >
                {text.metadataClear}
              </button>
              <RouteLink
                className="ghost-button"
                navigate={navigateRoute}
                route={seriesRoute(selectedMetadataSeries, 'overview')}
              >
                {text.metadataOpenSeries}
              </RouteLink>
            </div>
          </form>
        </>
      ) : (
        <div className="admin-scan-log__empty">{text.metadataNoSelection}</div>
      )}
    </article>
  )

  const renderAdmin = () => {
    const sourceRoots = appState?.sourceRoots || []
    const linkedSourceFolders = appState?.sourceFolders || []
    const hasManagedRoot = sourceRoots.some((root) => root.managed)
    const rootOptions = [...sourceRoots].sort((left, right) => Number(right.managed) - Number(left.managed))
    const selectedRoot = sourceRoots.find((root) => root.id === selectedRootId) || rootOptions[0] || null
    const currentFolderLabel = directoryListing.currentPath || '/'
    const selectedFolderDisplayPath = selectedRoot
      ? joinMountedDisplayPath(selectedRoot.path, directoryListing.currentPath)
      : ''
    const selectedFolderAlreadyLinked =
      selectedFolderDisplayPath !== '' &&
      linkedSourceFolders.some(
        (folder) =>
          normalizeFolderInput(folder.path).toLowerCase() ===
          normalizeFolderInput(selectedFolderDisplayPath).toLowerCase(),
      )
    const canReviewFolder = Boolean(selectedRootId && directoryListing.currentPath)
    const importSteps: Array<{ id: ImportStepId; label: string }> = [
      { id: 'type', label: text.importStepType },
      { id: 'folder', label: text.importStepFolder },
      { id: 'review', label: text.importStepReview },
    ]
    const rootTitle = (root: MountedRootSummary) => (root.managed ? text.importMainArchive : root.label)
    const rootSubtitle = (root: MountedRootSummary) => (root.managed ? text.importDockerRoot : root.note)

    return (
      <div className="page page--admin">
        <section className="admin-grid">
          <article className="panel panel--padded media-import-panel">
            <div className="panel__header media-import-panel__header">
              <div>
                <h3>{text.addMediaFolder}</h3>
                <p>{text.addMediaFolderBody}</p>
              </div>
            </div>

            <div className="import-stepper" role="tablist" aria-label={text.addMediaFolder}>
              {importSteps.map((step, index) => (
                <button
                  aria-selected={importStep === step.id}
                  className={`import-stepper__item${importStep === step.id ? ' import-stepper__item--active' : ''}`}
                  key={step.id}
                  onClick={() => setImportStep(step.id)}
                  role="tab"
                  type="button"
                >
                  <span>{index + 1}</span>
                  {step.label}
                </button>
              ))}
            </div>

            <div className="media-import-layout">
              <div className="import-flow-card">
                {importStep === 'type' ? (
                  <section className="import-step-panel">
                    <div className="import-step-panel__header">
                      <span>{text.importStepType}</span>
                      <h4>{text.importTypeTitle}</h4>
                      <p>{text.importTypeBody}</p>
                    </div>
                    <div className="source-category-picker" aria-label={text.folderCategory} role="radiogroup">
                      {readerCategoryOrder.map((category) => (
                        <button
                          aria-checked={browseCategory === category}
                          className={`source-category-picker__option${browseCategory === category ? ' source-category-picker__option--active' : ''}`}
                          key={category}
                          onClick={() => {
                            setBrowseCategory(category)
                            setImportStep('folder')
                          }}
                          role="radio"
                          type="button"
                        >
                          <span>{categoryLabel(category)}</span>
                          <small>
                            {library.filter((series) => series.category === category).length}{' '}
                            {language === 'de' ? 'Titel' : 'titles'}
                          </small>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}

                {importStep === 'folder' ? (
                  <section className="import-step-panel">
                    <div className="import-step-panel__header">
                      <span>{text.importStepFolder}</span>
                      <h4>{text.importFolderTitle}</h4>
                      <p>{text.importFolderBody}</p>
                    </div>

                    <div className="import-storage-strip">
                      <span>{text.importStorage}</span>
                      <div className="import-storage-options">
                        {rootOptions.map((root) => (
                          <button
                            className={`import-storage-option${selectedRootId === root.id ? ' import-storage-option--active' : ''}`}
                            disabled={adminBusy || scanIsActive}
                            key={root.id}
                            onClick={() => {
                              setSelectedRootId(root.id)
                              setBrowsePath('')
                              setManualFolderPath('')
                            }}
                            type="button"
                          >
                            <strong>{rootTitle(root)}</strong>
                            <small>{rootSubtitle(root)}</small>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="folder-browser">
                      <div className="folder-browser__bar">
                        <div>
                          <span>{text.importCurrentPath}</span>
                          <strong>{currentFolderLabel}</strong>
                        </div>
                        <button
                          className="ghost-button ghost-button--small"
                          disabled={!selectedRootId || browsePath === '' || scanIsActive}
                          onClick={() => setBrowsePath(browsePath.split('/').slice(0, -1).join('/'))}
                          type="button"
                        >
                          <AppIcon name="up" />
                          {text.browseUp}
                        </button>
                      </div>

                      <div className="folder-browser__list">
                        {directoryListing.directories.length ? (
                          directoryListing.directories.map((directory) => (
                            <button
                              className="folder-browser__item"
                              key={directory.relativePath}
                              onClick={() => setBrowsePath(directory.relativePath)}
                              type="button"
                            >
                              <div>
                                <strong>{directory.name}</strong>
                                <p>{directory.relativePath}</p>
                              </div>
                              <span>
                                <AppIcon name="folder" />
                                {text.openFolder}
                              </span>
                            </button>
                          ))
                        ) : (
                          <p className="folder-browser__empty">{text.folderBrowserEmpty}</p>
                        )}
                      </div>
                    </div>

                    <details className="import-storage-details">
                      <summary>{text.importStorageDetails}</summary>
                      <dl className="detail-list">
                        <div>
                          <dt>{text.importStorage}</dt>
                          <dd>{selectedRoot ? `${rootTitle(selectedRoot)} - ${selectedRoot.path}` : text.sourceRoots}</dd>
                        </div>
                        <div>
                          <dt>{text.selectedFolder}</dt>
                          <dd>{selectedFolderDisplayPath || '/'}</dd>
                        </div>
                      </dl>
                      <form className="admin-form" onSubmit={handleUseManualFolderPath}>
                        <label>
                          <span>{text.folderPathInput}</span>
                          <div className="admin-inline-control">
                            <input
                              autoCapitalize="none"
                              autoCorrect="off"
                              onChange={(event) => setManualFolderPath(event.target.value)}
                              placeholder={text.folderPathPlaceholder}
                              spellCheck={false}
                              value={manualFolderPath}
                            />
                            <button className="ghost-button" disabled={!selectedRoot || adminBusy || scanIsActive} type="submit">
                              {text.useFolderPath}
                            </button>
                          </div>
                        </label>
                      </form>
                    </details>

                    <div className="import-actions">
                      <button className="ghost-button" onClick={() => setImportStep('type')} type="button">
                        <AppIcon name="back" />
                        {text.importBack}
                      </button>
                      <button
                        className="primary-button"
                        disabled={!canReviewFolder}
                        onClick={() => setImportStep('review')}
                        type="button"
                      >
                        {text.importReviewAction}
                      </button>
                    </div>
                    {!canReviewFolder ? <p className="helper-text">{text.importOpenFolderFirst}</p> : null}
                  </section>
                ) : null}

                {importStep === 'review' ? (
                  <section className="import-step-panel">
                    <div className="import-step-panel__header">
                      <span>{text.importStepReview}</span>
                      <h4>{text.importReviewTitle}</h4>
                      <p>{selectedFolderAlreadyLinked ? text.importAlreadyLinkedHelp : text.importReviewBody}</p>
                    </div>
                    <div className="import-review-card">
                      <div>
                        <span>{text.folderCategory}</span>
                        <strong>{categoryLabel(browseCategory)}</strong>
                      </div>
                      <div>
                        <span>{text.selectedFolder}</span>
                        <strong>{getFolderLeafLabel(directoryListing.currentPath)}</strong>
                        <p>{selectedFolderDisplayPath || currentFolderLabel}</p>
                      </div>
                      <div>
                        <span>{text.importStorage}</span>
                        <strong>{selectedRoot ? rootTitle(selectedRoot) : text.sourceRoots}</strong>
                      </div>
                    </div>
                    <div className="import-actions">
                      <button className="ghost-button" onClick={() => setImportStep('folder')} type="button">
                        <AppIcon name="back" />
                        {text.importBack}
                      </button>
                      <button
                        className="primary-button"
                        disabled={!canReviewFolder || !selectedRootId || adminBusy || scanIsActive || selectedFolderAlreadyLinked}
                        onClick={() => void handleLinkCurrentFolder()}
                        type="button"
                      >
                        {selectedFolderAlreadyLinked ? text.folderAlreadyLinked : text.addAndScanFolder}
                      </button>
                    </div>
                  </section>
                ) : null}
              </div>

              <aside className="import-existing">
                <div className="import-existing__header">
                  <div>
                    <span>{text.linkedFolderProgress}</span>
                    <h4>{text.importExistingTitle}</h4>
                  </div>
                  <button className="ghost-button ghost-button--small" disabled={adminBusy || scanIsActive} onClick={() => void handleRunScan()} type="button">
                    <AppIcon name="refresh" />
                    {text.refreshMetadata}
                  </button>
                </div>
                <div className="import-existing__list">
                  {linkedSourceFolders.map((folder) => (
                    <div className="source-folder-card" key={folder.id}>
                      <button
                        aria-label={`${text.unlinkFolder}: ${folder.path}`}
                        className="admin-row__dismiss"
                        disabled={adminBusy || scanIsActive}
                        onClick={() => void handleUnlinkSourceFolder(folder.id)}
                        title={text.unlinkFolder}
                        type="button"
                      >
                        <AppIcon name="close" />
                      </button>
                      <div className="source-folder-card__main">
                        <strong>{getFolderLeafLabel(folder.relativePath) || categoryLabel(folder.category)}</strong>
                        <p>{folder.items} - {folder.status} - {formatRelativeTime(folder.lastScanAt, language)}</p>
                        <small>{folder.path}</small>
                      </div>
                      <div className="source-folder-card__controls">
                        <label>
                          <span>{text.changeFolderCategory}</span>
                          <select
                            className="admin-select admin-select--compact"
                            disabled={adminBusy || scanIsActive}
                            onChange={(event) => void handleUpdateSourceCategory(folder.id, event.target.value as CategoryId)}
                            value={folder.category}
                          >
                            {sourceCategoryOptions(folder.category).map((category) => (
                              <option key={category} value={category}>
                                {categoryLabel(category)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="ghost-button ghost-button--small"
                          disabled={adminBusy || scanIsActive}
                          onClick={() => void handleRunScan(folder.id)}
                          type="button"
                        >
                          <AppIcon name="refresh" />
                          {text.rescanFolder}
                        </button>
                      </div>
                    </div>
                  ))}
                  {!linkedSourceFolders.length ? (
                    <p className="folder-browser__empty">{text.importExistingEmpty}</p>
                  ) : null}
                </div>
              </aside>
            </div>
          </article>

          <details className="panel panel--padded advanced-roots" open={!hasManagedRoot}>
            <summary>{text.advancedRoots}</summary>
            {hasManagedRoot ? <p>{text.configuredRootHelp}</p> : null}
            <form className="admin-form" onSubmit={handleAddMountedRoot}>
              <label>
                <span>{text.mountedRootLabel}</span>
                <input
                  onChange={(event) => setRootLabel(event.target.value)}
                  value={rootLabel}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>{text.mountedRootPath}</span>
                <input
                  onChange={(event) => setRootPath(event.target.value)}
                  value={rootPath}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
              <button className="primary-button" disabled={adminBusy || scanIsActive} type="submit">
                {text.addMountedRoot}
              </button>
            </form>
            <div className="admin-list">
              {sourceRoots.map((root) => (
                <div className="admin-row admin-row--dismissible" key={root.id}>
                  <button
                    aria-label={
                      root.managed
                        ? `${text.configuredRootLocked} ${root.path}`
                        : `${text.unlinkRoot}: ${root.path}`
                    }
                    className="admin-row__dismiss"
                    disabled={root.managed || adminBusy || scanIsActive}
                    onClick={() => void handleUnlinkRoot(root.id)}
                    title={root.managed ? text.configuredRootLocked : text.unlinkRoot}
                    type="button"
                  >
                    <AppIcon name="close" />
                  </button>
                  <div>
                    <strong>{root.label}</strong>
                    <p>{root.path}</p>
                  </div>
                  <span>{root.note}</span>
                </div>
              ))}
            </div>
          </details>

          <article className="panel panel--padded">
            <div className="panel__header">
              <h3>{text.users}</h3>
              <span>Open signup enabled</span>
            </div>
            <div className="admin-list">
              {(appState?.users || []).map((user) => (
                <div className="admin-row" key={user.id}>
                  <div>
                    <strong>{user.name}</strong>
                    <p>{user.role}</p>
                  </div>
                  <div className="admin-row__meta">
                    <span>{user.status}</span>
                    <button
                      className="ghost-button ghost-button--small"
                      onClick={() => void handleResetPassword(user.id)}
                      type="button"
                    >
                      {text.resetPassword}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </article>

          {renderMetadataReview()}
          {renderMetadataEditor()}
        </section>
        {renderScanLog()}
      </div>
    )
  }

  if ((bootLoading || (authenticated && !appState)) && !appState) {
    return (
      <div className="auth-shell auth-shell--loading">
        <main aria-live="polite" className="auth-panel auth-panel--loading">
          <div className="auth-panel__brand">
            <span aria-hidden="true" className="auth-panel__mark">O</span>
            <div>
              <p className="section-kicker">{text.privateLibrary}</p>
              <h1>{text.brandName}</h1>
            </div>
          </div>
          <p>{stateError || text.loading}</p>
        </main>
      </div>
    )
  }

  if (!authenticated) {
    return (
      <div className="auth-shell">
        <main aria-labelledby="auth-title" className="auth-panel">
          <header className="auth-panel__header">
            <div className="auth-panel__brand">
              <span aria-hidden="true" className="auth-panel__mark">O</span>
              <div>
                <p className="section-kicker">{text.privateLibrary}</p>
                <h1 id="auth-title">{text.brandName}</h1>
              </div>
            </div>
            <p className="auth-panel__intro">{text.authPrompt}</p>
          </header>

          {bootstrapState?.openSignup && (
            <div
              aria-label={text.accountSettings}
              className="segmented-control auth-panel__mode"
              role="group"
            >
              <RouteLink
                className={authMode === 'login' ? 'is-active' : ''}
                navigate={navigateRoute}
                route={{
                  name: 'login',
                  next: currentRoute.name === 'login' ? currentRoute.next : null,
                }}
              >
                {text.signIn}
              </RouteLink>
              <RouteLink
                className={authMode === 'signup' ? 'is-active' : ''}
                navigate={navigateRoute}
                route={{ name: 'signup' }}
              >
                {text.createAccount}
              </RouteLink>
            </div>
          )}

          <form className="auth-form" onSubmit={handleAuth}>
            <label>
              <span>{text.username}</span>
              <input
                autoComplete="username"
                name="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span>{text.password}</span>
              <input
                autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                name="password"
                type="password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>

            {authError && <p className="auth-error">{authError}</p>}
            {stateError && <p className="auth-error">{stateError}</p>}

            <button className="primary-button primary-button--wide" disabled={authBusy} type="submit">
              {authMode === 'signup' ? text.createAccount : text.signIn}
            </button>
          </form>

          <div className="auth-panel__footer">
            <div aria-label={text.language} className="language-toggle" role="group">
              <button
                className={language === 'en' ? 'is-active' : ''}
                onClick={() => setLanguage('en')}
                type="button"
              >
                EN
              </button>
              <button
                className={language === 'de' ? 'is-active' : ''}
                onClick={() => setLanguage('de')}
                type="button"
              >
                DE
              </button>
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className={`app-shell ${isNativeApp ? 'app-shell--native' : ''} ${currentView === 'reader' ? 'app-shell--reader' : ''}`}>
      <a className="skip-link" href="#main-content">{text.skipToContent}</a>
      {currentView !== 'reader' && (
      <header className={`topbar ${topbarHidden ? 'topbar--hidden' : ''}`}>
        <RouteLink
          className="brand-lockup"
          navigate={navigateRoute}
          route={{ name: 'bookmarks', scope: 'all' }}
        >
          <span className="brand-lockup__mark">O</span>
          <span className="brand-lockup__text">{text.brandName}</span>
        </RouteLink>

        <div className="topbar__left">
          <div
            className={`search-shell ${searchOpen ? 'is-open' : ''}`}
            onBlurCapture={handleSearchBlur}
            onFocusCapture={() => setSearchOpen(true)}
          >
            <div className="search-bar">
              <button
                aria-label="Open search"
                className="search-bar__toggle"
                onMouseDown={(event) => {
                  event.preventDefault()
                  openSearch()
                }}
                type="button"
              >
                <AppIcon className="search-bar__icon" name="search" />
              </button>
              <input
                ref={searchInputRef}
                onChange={(event) => updateSearchQuery(event.target.value)}
                onFocus={() => setSearchOpen(true)}
                placeholder={text.searchPlaceholder}
                value={searchQuery}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            {searchOpen && (
              <div className="search-popover">
                <div className="search-popover__header">
                  <p className="section-kicker">{text.quickResults}</p>
                  <div className="search-popover__header-actions">
                    {searchQuery && (
                      <button
                        className="ghost-button ghost-button--small"
                        onClick={() => {
                          updateSearchQuery('')
                          searchInputRef.current?.focus()
                        }}
                        type="button"
                      >
                        <AppIcon name="close" />
                        {text.clearSearch}
                      </button>
                    )}
                    <button className="ghost-button ghost-button--small" onClick={() => setSearchOpen(false)} type="button">
                      <AppIcon name="close" />
                      {text.closeSearch}
                    </button>
                  </div>
                </div>

                <div className="search-popover__scope">
                  {readerScopeOrder.map((scope) => (
                    <button
                      className={`scope-button ${searchScope === scope ? 'is-active' : ''}`}
                      key={scope}
                      onClick={() => updateSearchScope(scope)}
                      type="button"
                    >
                      {text.scopes[scope]}
                    </button>
                  ))}
                </div>

                <div className="search-popover__results">
                  {deferredSearch === '' ? (
                    <div className="search-state">{text.searchHint}</div>
                  ) : searchLoading ? (
                    <div className="search-state">Searching...</div>
                  ) : searchPreview.length === 0 ? (
                    <div className="search-state">No matches yet.</div>
                  ) : (
                    searchPreview.map((series) => (
                      <RouteLink
                        className="search-result"
                        key={series.id}
                        navigate={navigateRoute}
                        onNavigate={() => setSearchOpen(false)}
                        route={seriesRoute(series)}
                      >
                        {renderPoster(series, true)}
                        <div>
                          <strong>{getSeriesDisplayTitle(series)}</strong>
                          <p>{categoryLabel(series.category)} • {series.progressLabel}</p>
                        </div>
                      </RouteLink>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <nav className="window-tabs">
            {[
              { id: 'bookmarks' as const, label: text.nav.bookmarks },
              { id: 'downloads' as const, label: text.nav.downloads },
              ...readerCategoryOrder.map((category) => ({
              id: category,
              label: text.nav[category],
            }))].map((item) => (
              <RouteLink
                ariaCurrent={
                  item.id === 'bookmarks'
                    ? currentView === 'bookmarks' ? 'page' : undefined
                    : item.id === 'downloads'
                      ? currentView === 'downloads' ? 'page' : undefined
                      : ['library', 'series'].includes(currentView) && currentCategory === item.id
                        ? 'page'
                        : undefined
                }
                className={`window-tab ${
                  item.id === 'bookmarks'
                    ? currentView === 'bookmarks'
                      ? 'is-active'
                      : ''
                    : item.id === 'downloads'
                      ? currentView === 'downloads'
                        ? 'is-active'
                        : ''
                    : ['library', 'series'].includes(currentView) && currentCategory === item.id
                      ? 'is-active'
                      : ''
                }`}
                key={item.id}
                navigate={navigateRoute}
                route={
                  item.id === 'bookmarks'
                    ? { name: 'bookmarks', scope: 'all' }
                    : item.id === 'downloads'
                      ? { name: 'downloads' }
                      : {
                          name: 'library',
                          category: categoryRouteId(item.id),
                          topics: [],
                          sort: discoverSort,
                        }
                }
              >
                {item.label}
              </RouteLink>
            ))}
          </nav>
        </div>

        <div className="topbar__right">
          <div className="language-toggle language-toggle--header">
            <button
              className={language === 'en' ? 'is-active' : ''}
              onClick={() => setLanguage('en')}
              type="button"
            >
              EN
            </button>
            <button
              className={language === 'de' ? 'is-active' : ''}
              onClick={() => setLanguage('de')}
              type="button"
            >
              DE
            </button>
          </div>

          <RouteLink
            ariaCurrent={currentView === 'profile' ? 'page' : undefined}
            className="profile-pill"
            navigate={navigateRoute}
            route={{ name: 'profile' }}
          >
            <span className="profile-pill__avatar">
              {appState?.user?.username.slice(0, 1).toUpperCase()}
            </span>
            <span className="profile-pill__meta">
              {appState?.user?.username}
              <small>{text.profile}</small>
            </span>
          </RouteLink>

          {appState?.user?.role === 'admin' && (
            <RouteLink
              ariaCurrent={currentView === 'admin' ? 'page' : undefined}
              className="ghost-button"
              navigate={navigateRoute}
              route={{ name: 'admin' }}
            >
              <AppIcon name="admin" />
              {text.admin}
            </RouteLink>
          )}
          <button className="ghost-button" onClick={() => void handleLogout()}>
            <AppIcon name="logout" />
            {text.logout}
          </button>
          <button className="mobile-top-action" onClick={openSearch} type="button" aria-label={text.searchAction}>
            <AppIcon name="search" />
          </button>
        </div>
      </header>
      )}

      <main className="main-shell" id="main-content" ref={mainShellRef} tabIndex={-1}>
        {!routeProblem && currentView === 'admin' && (
          <section className="page-heading">
            <div>
              <p className="section-kicker">{text.demoTag}</p>
              <h1>{pageTitle}</h1>
              <p>{pageBody}</p>
            </div>
            <div className="chip-row">
              <span className="chip chip--accent">{text.scanMode}</span>
              <span className="chip">
                {text.sourceFolders}: {appState?.scanSummary.sourceFolderCount || 0}
              </span>
              <span className="chip">
                {text.lastScan}: {formatRelativeTime(appState?.scanSummary.lastScanAt || null, language)}
              </span>
            </div>
          </section>
        )}

        {stateError && authenticated && (
          <article className="panel panel--padded global-error" role="alert">
            <span>{stateError}</span>
            <button
              aria-label={text.dismissError}
              className="global-error__dismiss"
              onClick={() => setStateError(null)}
              type="button"
            >
              <AppIcon name="close" />
            </button>
          </article>
        )}

        {routeProblem
          ? renderRouteProblem()
          : (
            <>
              {currentView === 'bookmarks' && renderBookmarks()}
              {currentView === 'downloads' && renderDownloads()}
              {currentView === 'library' && renderLibrary()}
              {currentView === 'search' && renderSearchPage()}
              {currentView === 'series' && renderSeries()}
              {currentView === 'reader' && renderReader()}
              {currentView === 'creator' && renderCreator()}
              {currentView === 'profile' && renderProfile()}
              {currentView === 'admin' && renderAdmin()}
            </>
          )}
      </main>

      {currentView !== 'reader' && (
        <nav className="bottom-nav" aria-label="Primary">
          <RouteLink
            ariaCurrent={currentView === 'bookmarks' ? 'page' : undefined}
            className={currentView === 'bookmarks' ? 'is-active' : ''}
            navigate={navigateRoute}
            onNavigate={() => setSearchOpen(false)}
            route={{ name: 'bookmarks', scope: 'all' }}
          >
            <AppIcon name="library" />
            <span>{text.mobileNav.library}</span>
          </RouteLink>
          <RouteLink
            ariaCurrent={['library', 'series', 'creator'].includes(currentView) ? 'page' : undefined}
            className={['library', 'series', 'creator'].includes(currentView) ? 'is-active' : ''}
            navigate={navigateRoute}
            onNavigate={() => setSearchOpen(false)}
            route={{
              name: 'library',
              category: categoryRouteId(currentCategory),
              topics: [],
              sort: discoverSort,
            }}
          >
            <AppIcon name="discover" />
            <span>{text.mobileNav.discover}</span>
          </RouteLink>
          <RouteLink
            ariaCurrent={currentView === 'search' ? 'page' : undefined}
            className={currentView === 'search' ? 'is-active' : ''}
            navigate={navigateRoute}
            onNavigate={() => setSearchOpen(false)}
            route={{ name: 'search', query: searchQuery, scope: searchScope }}
          >
            <AppIcon name="search" />
            <span>{text.mobileNav.search}</span>
          </RouteLink>
          <RouteLink
            ariaCurrent={currentView === 'downloads' ? 'page' : undefined}
            className={currentView === 'downloads' ? 'is-active' : ''}
            navigate={navigateRoute}
            onNavigate={() => setSearchOpen(false)}
            route={{ name: 'downloads' }}
          >
            <AppIcon name="download" />
            <span>{text.mobileNav.downloads}</span>
          </RouteLink>
          <RouteLink
            ariaCurrent={currentView === 'profile' || currentView === 'admin' ? 'page' : undefined}
            className={currentView === 'profile' || currentView === 'admin' ? 'is-active' : ''}
            navigate={navigateRoute}
            onNavigate={() => setSearchOpen(false)}
            route={{ name: 'profile' }}
          >
            <AppIcon name="profile" />
            <span>{text.mobileNav.profile}</span>
          </RouteLink>
        </nav>
      )}
    </div>
  )
}

export default App
