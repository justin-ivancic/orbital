import type {
  AppState,
  AuthPayload,
  Bookmark,
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
  Role,
  SavedReadingPosition,
  ScopeId,
  ScanStatusResponse,
  SearchResponse,
  SeriesComment,
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
let knownLibraryRevision: string | null = null
const unauthorizedListeners = new Set<() => void>()

const defaultTimeoutMs = 25_000

export class ApiError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// Gateway errors mean the Orbital server itself is unreachable (a reverse proxy
// or Cloudflare answered instead), which the app treats like being offline.
const gatewayStatuses = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])

/** True when the Orbital server could not be reached (offline, DNS, TLS, timeout, proxy error). */
export const isNetworkError = (error: unknown) =>
  error instanceof ApiError
    ? error.status == null || gatewayStatuses.has(error.status)
    : error instanceof TypeError

export type ProgressSaveResponse = {
  saved: boolean
  bookmark: Bookmark | null
  position: SavedReadingPosition | null
}

export type ProgressPayload = {
  seriesId: string
  entryId: string
  entryIndex: number
  category: CategoryId
  progress: string
  cue: string
  position: SavedReadingPosition
  lastSeen?: string
}

export type AndroidAppInfo = {
  available: boolean
  source: 'uploaded' | 'bundled' | 'external' | null
  size: number | null
  updatedAt: string | null
  versionName: string | null
  versionCode: number | null
  downloadUrl: string
}

export type AdminSettings = {
  remoteMetadata: { enabled: boolean; lockedByEnvironment: boolean }
  openSignup: boolean
  androidApp: AndroidAppInfo
}

const unsafeHttpMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const authEndpoints = ['/api/bootstrap', '/api/auth/', '/api/mobile/auth/']

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
  coverImageUrl: normalizeUrl(series.coverImageUrl ?? null),
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

/** Headers that authenticate a request made outside `fetch` (native downloads). */
export const getAuthHeaders = async (): Promise<Record<string, string>> => {
  await ensureMobileSessionLoaded()
  const mobileSession = getMobileSession()
  return mobileSession ? { Authorization: `Bearer ${mobileSession.accessToken}` } : {}
}

const getRequestHeaders = (init?: RequestInit) => {
  const mobileSession = getMobileSession()

  return {
    ...(init?.body != null && !(init.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
    ...(isUnsafeRequest(init?.method) && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    ...(mobileSession ? { Authorization: `Bearer ${mobileSession.accessToken}` } : {}),
  }
}

const notifyUnauthorized = (input: string) => {
  if (authEndpoints.some((endpoint) => input.startsWith(endpoint))) {
    return
  }

  unauthorizedListeners.forEach((listener) => listener())
}

const withTimeout = (signal: AbortSignal | null | undefined, timeoutMs: number) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs)
  const forwardAbort = () => controller.abort(signal?.reason)

  if (signal?.aborted) {
    forwardAbort()
  } else {
    signal?.addEventListener('abort', forwardAbort, { once: true })
  }

  return {
    signal: controller.signal,
    // Only the wait for response headers is timed; the caller's signal keeps
    // cancelling the body (large downloads) after that.
    done: () => clearTimeout(timer),
  }
}

type RequestOptions = RequestInit & { timeoutMs?: number }

const send = async (input: string, init: RequestOptions = {}) => {
  await ensureMobileSessionLoaded()
  const { timeoutMs = defaultTimeoutMs, ...requestInit } = init
  const timeout = withTimeout(requestInit.signal, timeoutMs)

  try {
    const response = await fetch(resolveApiUrl(input), {
      credentials: isNativeApp ? 'omit' : 'same-origin',
      ...requestInit,
      headers: {
        ...getRequestHeaders(requestInit),
        ...(requestInit.headers || {}),
      },
      signal: timeout.signal,
    })

    if (!response.ok) {
      const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null

      if (response.status === 401) {
        notifyUnauthorized(input)
      }

      throw new ApiError(errorPayload?.error || `Request failed with ${response.status}`, response.status)
    }

    return response
  } catch (error) {
    if (error instanceof ApiError) {
      throw error
    }

    if (requestInit.signal?.aborted) {
      throw error
    }

    // Network failures and timeouts carry no HTTP status.
    throw new ApiError(error instanceof Error ? error.message : 'Network request failed.', null)
  } finally {
    timeout.done()
  }
}

const request = async <T,>(input: string, init?: RequestOptions) => (await (await send(input, init)).json()) as T

const fetchResource = (input: string, signal?: AbortSignal) =>
  send(input, { signal, timeoutMs: 120_000 })

const withStateQuery = (path: string) => {
  const params = new URLSearchParams({ compact: '1' })

  if (knownLibraryRevision) {
    params.set('libraryRevision', knownLibraryRevision)
  }

  return `${path}${path.includes('?') ? '&' : '?'}${params.toString()}`
}

const stateRequest = async (path: string, init?: RequestOptions) =>
  normalizeAppState(await request<AppState>(withStateQuery(path), init))

export const api = {
  fetchResource,
  onUnauthorized: (listener: () => void) => {
    unauthorizedListeners.add(listener)
    return () => {
      unauthorizedListeners.delete(listener)
    }
  },
  setCsrfToken: (token: string | null | undefined) => {
    csrfToken = token || null
  },
  /**
   * The library revision this client already holds. State responses omit the
   * library (and set `libraryUnchanged`) when the server has the same one.
   */
  setKnownLibraryRevision: (revision: string | null | undefined) => {
    knownLibraryRevision = revision || null
  },
  getBootstrap: (options?: { signal?: AbortSignal; timeoutMs?: number }) =>
    request<BootstrapState>('/api/bootstrap', { signal: options?.signal, timeoutMs: options?.timeoutMs ?? 12_000 }),
  getState: () => stateRequest('/api/state'),
  login: async (payload: AuthPayload) => {
    if (!isNativeApp) {
      return stateRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    }

    const response = await request<MobileAuthResponse>(withStateQuery('/api/mobile/auth/login'), {
      method: 'POST',
      body: JSON.stringify(payload),
    })

    await saveMobileSession({
      accessToken: response.accessToken,
      expiresAt: response.accessTokenExpiresAt,
    })

    return normalizeAppState(response)
  },
  signup: (payload: AuthPayload) =>
    stateRequest('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  logout: async () => {
    try {
      await request<{ ok: true }>('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({}),
        timeoutMs: 8_000,
      })
    } finally {
      if (isNativeApp) {
        await clearMobileSession()
      }
    }
  },
  /** Forgets the native session token without contacting the server. */
  forgetSession: async () => {
    if (isNativeApp) {
      await clearMobileSession()
    }
  },
  changePassword: (payload: ChangePasswordPayload) =>
    stateRequest('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getSeries: async (seriesId: string, signal?: AbortSignal) => {
    const response = await request<SeriesResponse>(`/api/series/${encodeURIComponent(seriesId)}`, { signal })
    return normalizeSeriesDetail(response.series)
  },
  getEntryTracks: async (entryId: string) => {
    const response = await request<MediaTracksResponse>(`/api/media-tracks/${encodeURIComponent(entryId)}`)
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
      timeoutMs: 120_000,
    })),
  search: async (query: string, scope: ScopeId, signal?: AbortSignal) => {
    const response = await request<SearchResponse>(
      `/api/search?q=${encodeURIComponent(query)}&scope=${encodeURIComponent(scope)}`,
      { signal },
    )
    return response.results.map(normalizeSeriesSummary)
  },
  saveProgress: (payload: ProgressPayload, options?: { keepalive?: boolean }) =>
    request<ProgressSaveResponse>('/api/bookmarks?compact=1', {
      method: 'POST',
      body: JSON.stringify(payload),
      keepalive: options?.keepalive,
      timeoutMs: 15_000,
    }),
  removeBookmark: (seriesId: string) =>
    request<{ ok: true }>(`/api/bookmarks/${encodeURIComponent(seriesId)}?compact=1`, {
      method: 'DELETE',
    }),
  getReaderPreference: (seriesId: string) =>
    request<ReaderPreferenceResponse>(`/api/reader-preferences/${encodeURIComponent(seriesId)}`),
  setReaderPreference: (seriesId: string, settings: ReaderSettings, options?: { keepalive?: boolean }) =>
    request<ReaderPreferenceResponse>(`/api/reader-preferences/${encodeURIComponent(seriesId)}`, {
      method: 'PUT',
      body: JSON.stringify({ settings }),
      keepalive: options?.keepalive,
    }),
  addComment: async (payload: CreateCommentPayload) =>
    (await request<{ comments: SeriesComment[] }>('/api/comments?compact=1', {
      method: 'POST',
      body: JSON.stringify(payload),
    })).comments,
  getAppInfo: () => request<AndroidAppInfo>('/api/mobile/app-info', { timeoutMs: 10_000 }),

  /* ---------------------------------------------------------------- admin -- */

  createRoot: (payload: CreateRootPayload) =>
    stateRequest('/api/admin/roots', { method: 'POST', body: JSON.stringify(payload) }),
  deleteRoot: (rootId: string) =>
    stateRequest(`/api/admin/roots/${encodeURIComponent(rootId)}`, { method: 'DELETE' }),
  listDirectories: (rootId: string, relativePath: string) =>
    request<DirectoryListing>(
      `/api/admin/directories?rootId=${encodeURIComponent(rootId)}&relativePath=${encodeURIComponent(relativePath)}`,
    ),
  createSource: (payload: CreateSourcePayload) =>
    stateRequest('/api/admin/sources', { method: 'POST', body: JSON.stringify(payload) }),
  updateSource: (sourceId: string, payload: UpdateSourcePayload) =>
    stateRequest(`/api/admin/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteSource: (sourceId: string) =>
    stateRequest(`/api/admin/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' }),
  runScan: (sourceId?: string) =>
    stateRequest('/api/admin/scan', {
      method: 'POST',
      body: JSON.stringify(sourceId ? { sourceId } : {}),
    }),
  getScanStatus: () => request<ScanStatusResponse>('/api/admin/scan/status'),
  createUser: (payload: { username: string; password: string; role: Role }) =>
    stateRequest('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) }),
  deleteUser: (userId: string) =>
    stateRequest(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  resetPassword: (userId: string, payload: ResetPasswordPayload) =>
    stateRequest(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getAdminSettings: () => request<AdminSettings>('/api/admin/settings'),
  updateAdminSettings: (payload: { remoteMetadataEnabled?: boolean }) =>
    request<AdminSettings>('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  deleteAndroidApk: () =>
    request<{ androidApp: AndroidAppInfo }>('/api/admin/android-app', { method: 'DELETE' }),
  saveMetadataOverride: (seriesId: string, payload: MetadataOverridePayload) =>
    stateRequest(`/api/admin/series/${encodeURIComponent(seriesId)}/metadata-override`, {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: 60_000,
    }),
  clearMetadataOverride: (seriesId: string) =>
    stateRequest(`/api/admin/series/${encodeURIComponent(seriesId)}/metadata-override`, {
      method: 'DELETE',
    }),
  refreshSeriesMetadata: (seriesId: string) =>
    stateRequest(`/api/admin/series/${encodeURIComponent(seriesId)}/metadata-refresh`, {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 60_000,
    }),
  /** Streams an APK to the server, reporting upload progress (0–1). */
  uploadAndroidApk: async (
    file: File,
    version: { versionName: string; versionCode: string },
    onProgress: (fraction: number) => void,
  ) => {
    await ensureMobileSessionLoaded()
    const params = new URLSearchParams()

    if (version.versionName.trim()) {
      params.set('versionName', version.versionName.trim())
    }

    if (version.versionCode.trim()) {
      params.set('versionCode', version.versionCode.trim())
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/vnd.android.package-archive',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(await getAuthHeaders()),
    }

    return new Promise<AndroidAppInfo>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', resolveApiUrl(`/api/admin/android-app?${params.toString()}`))
      xhr.withCredentials = !isNativeApp
      Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value))
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(event.loaded / event.total)
        }
      }
      xhr.onload = () => {
        let payload: { androidApp?: AndroidAppInfo; error?: string } | null = null

        try {
          payload = JSON.parse(xhr.responseText)
        } catch {
          payload = null
        }

        if (xhr.status >= 200 && xhr.status < 300 && payload?.androidApp) {
          resolve(payload.androidApp)
          return
        }

        if (xhr.status === 401) {
          notifyUnauthorized('/api/admin/android-app')
        }

        reject(new ApiError(payload?.error || `Upload failed with ${xhr.status}`, xhr.status || null))
      }
      xhr.onerror = () => reject(new ApiError('The upload was interrupted.', null))
      xhr.send(file)
    })
  },
}
