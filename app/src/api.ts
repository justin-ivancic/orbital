import type {
  AppState,
  AuthPayload,
  BootstrapState,
  CategoryId,
  ChangePasswordPayload,
  CreateCommentPayload,
  CreateRootPayload,
  CreateSourcePayload,
  DirectoryListing,
  MediaTrackCollection,
  MetadataOverridePayload,
  MediaTracksResponse,
  MobileAuthResponse,
  OfflineCapabilities,
  OfflineDownloadEstimate,
  OfflineDownloadManifest,
  OfflineDownloadTarget,
  ReaderPreferenceResponse,
  ReaderSettings,
  ResetPasswordPayload,
  SavedReadingPosition,
  ScopeId,
  ScanStatusResponse,
  SearchResponse,
  SeriesDetail,
  SeriesResponse,
  SeriesSummary,
  UpdateSourcePayload,
} from './appTypes'
import { resolveApiUrl, isNativeApp } from './platform'
import {
  clearMobileSession,
  ensureMobileSessionLoaded,
  getMobileSession,
  saveMobileSession,
} from './mobileSession'

let csrfToken: string | null = null

export class ApiError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const unsafeHttpMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const normalizeUrl = (url: string | null) => (url ? resolveApiUrl(url) : url)

const normalizeMediaTracks = (tracks: MediaTrackCollection): MediaTrackCollection => ({
  audio: tracks.audio.map((track) => ({
    ...track,
    url: resolveApiUrl(track.url),
  })),
  subtitles: tracks.subtitles.map((track) => ({
    ...track,
    url: resolveApiUrl(track.url),
  })),
})

export const normalizeSeriesSummary = (series: SeriesSummary): SeriesSummary => ({
  ...series,
  coverUrl: normalizeUrl(series.coverUrl),
  bannerUrl: normalizeUrl(series.bannerUrl),
})

export const normalizeSeriesDetail = (series: SeriesDetail): SeriesDetail => ({
  ...normalizeSeriesSummary(series),
  comments: series.comments,
  entries: series.entries.map((entry) => ({
    ...entry,
    variants: entry.variants.map((variant) => ({
      ...variant,
      fileUrl: resolveApiUrl(variant.fileUrl),
      downloadUrl: resolveApiUrl(variant.downloadUrl),
      mediaTracks: normalizeMediaTracks(variant.mediaTracks),
    })),
  })),
})

export const normalizeAppState = <T extends AppState>(state: T): T => ({
  ...state,
  library: state.library.map(normalizeSeriesSummary),
  metadataQueue: state.metadataQueue.map((item) => ({
    ...item,
    coverUrl: normalizeUrl(item.coverUrl),
  })),
})

const normalizeOfflineManifest = (manifest: OfflineDownloadManifest): OfflineDownloadManifest => ({
  ...manifest,
  resources: manifest.resources.map((resource) => ({
    ...resource,
    url: resolveApiUrl(resource.url),
    onlineUrl: resolveApiUrl(resource.onlineUrl),
  })),
})

const isUnsafeRequest = (method: string | undefined) =>
  unsafeHttpMethods.has((method || 'GET').toUpperCase())

const getRequestHeaders = (init?: RequestInit) => {
  const mobileSession = getMobileSession()

  return {
    ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
    ...(isUnsafeRequest(init?.method) && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    ...(mobileSession ? { Authorization: `Bearer ${mobileSession.accessToken}` } : {}),
  }
}

const request = async <T,>(input: string, init?: RequestInit) => {
  await ensureMobileSessionLoaded()
  const response = await fetch(resolveApiUrl(input), {
    credentials: isNativeApp ? 'omit' : 'same-origin',
    headers: {
      ...getRequestHeaders(init),
      ...(isUnsafeRequest(init?.method) && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(init?.headers || {}),
    },
    ...init,
  })

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      errorPayload?.error || `Request failed with ${response.status}`,
      response.status,
    )
  }

  return (await response.json()) as T
}

const fetchResource = async (input: string, signal?: AbortSignal) => {
  await ensureMobileSessionLoaded()
  const response = await fetch(resolveApiUrl(input), {
    credentials: isNativeApp ? 'omit' : 'same-origin',
    headers: getRequestHeaders(),
    signal,
  })

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      errorPayload?.error || `Request failed with ${response.status}`,
      response.status,
    )
  }

  return response
}

export const api = {
  fetchResource,
  setCsrfToken: (token: string | null | undefined) => {
    csrfToken = token || null
  },
  getBootstrap: () => request<BootstrapState>('/api/bootstrap'),
  getState: async () => normalizeAppState(await request<AppState>('/api/state')),
  login: async (payload: AuthPayload) => {
    if (!isNativeApp) {
      return normalizeAppState(await request<AppState>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(payload),
      }))
    }

    const response = await request<MobileAuthResponse>('/api/mobile/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    })

    await saveMobileSession({
      accessToken: response.accessToken,
      expiresAt: response.accessTokenExpiresAt,
    })

    return normalizeAppState(response)
  },
  signup: async (payload: AuthPayload) =>
    normalizeAppState(await request<AppState>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(payload),
    })),
  logout: async () => {
    const response = await request<{ ok: true }>('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    })

    if (isNativeApp) {
      await clearMobileSession()
    }

    return response
  },
  changePassword: async (payload: ChangePasswordPayload) =>
    normalizeAppState(await request<AppState>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    })),
  getSeries: async (seriesId: string) => {
    const response = await request<SeriesResponse>(`/api/series/${seriesId}`)
    return {
      ...response,
      series: normalizeSeriesDetail(response.series),
    }
  },
  getEntryTracks: async (entryId: string) => {
    const response = await request<MediaTracksResponse>(`/api/media-tracks/${entryId}`)
    return {
      ...response,
      mediaTracks: normalizeMediaTracks(response.mediaTracks),
    }
  },
  getOfflineCapabilities: () => request<OfflineCapabilities>('/api/offline/capabilities'),
  estimateOfflineDownload: (target: OfflineDownloadTarget) =>
    request<OfflineDownloadEstimate>('/api/offline/estimate', {
      method: 'POST',
      body: JSON.stringify({ target }),
    }),
  createOfflineManifest: async (target: OfflineDownloadTarget, signal?: AbortSignal) =>
    normalizeOfflineManifest(await request<OfflineDownloadManifest>('/api/offline/manifests', {
      method: 'POST',
      body: JSON.stringify({ target }),
      signal,
    })),
  search: async (query: string, scope: ScopeId) => {
    const response = await request<SearchResponse>(
      `/api/search?q=${encodeURIComponent(query)}&scope=${encodeURIComponent(scope)}`,
    )
    return {
      ...response,
      results: response.results.map(normalizeSeriesSummary),
    }
  },
  setBookmark: (
    payload: {
      seriesId: string
      entryId: string
      entryIndex: number
      category: CategoryId
      progress: string
      cue: string
      position: SavedReadingPosition
    },
    options?: { keepalive?: boolean },
  ) =>
    request<Pick<AppState, 'bookmarks' | 'readingPositions'>>('/api/bookmarks', {
      method: 'POST',
      body: JSON.stringify(payload),
      keepalive: options?.keepalive,
    }),
  removeBookmark: (seriesId: string) =>
    request<Pick<AppState, 'bookmarks' | 'readingPositions'>>(
      `/api/bookmarks/${encodeURIComponent(seriesId)}`,
      {
        method: 'DELETE',
      },
    ),
  getReaderPreference: (seriesId: string) =>
    request<ReaderPreferenceResponse>(
      `/api/reader-preferences/${encodeURIComponent(seriesId)}`,
    ),
  setReaderPreference: (
    seriesId: string,
    settings: ReaderSettings,
    options?: { keepalive?: boolean },
  ) =>
    request<ReaderPreferenceResponse>(
      `/api/reader-preferences/${encodeURIComponent(seriesId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ settings }),
        keepalive: options?.keepalive,
      },
    ),
  addComment: async (payload: CreateCommentPayload) => {
    const response = await request<SeriesResponse>('/api/comments', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return {
      ...response,
      series: normalizeSeriesDetail(response.series),
    }
  },
  createRoot: async (payload: CreateRootPayload) =>
    normalizeAppState(await request<AppState>('/api/admin/roots', {
      method: 'POST',
      body: JSON.stringify(payload),
    })),
  deleteRoot: async (rootId: string) =>
    normalizeAppState(await request<AppState>(`/api/admin/roots/${rootId}`, {
      method: 'DELETE',
    })),
  listDirectories: (rootId: string, relativePath: string) =>
    request<DirectoryListing>(
      `/api/admin/directories?rootId=${encodeURIComponent(rootId)}&relativePath=${encodeURIComponent(relativePath)}`,
    ),
  createSource: async (payload: CreateSourcePayload) =>
    normalizeAppState(await request<AppState>('/api/admin/sources', {
      method: 'POST',
      body: JSON.stringify(payload),
    })),
  updateSource: async (sourceId: string, payload: UpdateSourcePayload) =>
    normalizeAppState(await request<AppState>(`/api/admin/sources/${sourceId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })),
  deleteSource: async (sourceId: string) =>
    normalizeAppState(await request<AppState>(`/api/admin/sources/${sourceId}`, {
      method: 'DELETE',
    })),
  runScan: async (sourceId?: string) =>
    normalizeAppState(await request<AppState>('/api/admin/scan', {
      method: 'POST',
      body: JSON.stringify(sourceId ? { sourceId } : {}),
    })),
  getScanStatus: () => request<ScanStatusResponse>('/api/admin/scan/status'),
  resetPassword: async (userId: string, payload: ResetPasswordPayload) =>
    normalizeAppState(await request<AppState>(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })),
  saveMetadataOverride: async (seriesId: string, payload: MetadataOverridePayload) =>
    normalizeAppState(await request<AppState>(`/api/admin/series/${seriesId}/metadata-override`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })),
  clearMetadataOverride: async (seriesId: string) =>
    normalizeAppState(await request<AppState>(`/api/admin/series/${seriesId}/metadata-override`, {
      method: 'DELETE',
    })),
  refreshSeriesMetadata: async (seriesId: string) =>
    normalizeAppState(await request<AppState>(`/api/admin/series/${seriesId}/metadata-refresh`, {
      method: 'POST',
      body: JSON.stringify({}),
    })),
}
