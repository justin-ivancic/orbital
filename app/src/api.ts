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
  MetadataOverridePayload,
  MediaTracksResponse,
  ResetPasswordPayload,
  SavedReadingPosition,
  ScopeId,
  SearchResponse,
  SeriesResponse,
  UpdateSourcePayload,
} from './appTypes'

let csrfToken: string | null = null

const unsafeHttpMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const isUnsafeRequest = (method: string | undefined) =>
  unsafeHttpMethods.has((method || 'GET').toUpperCase())

const request = async <T,>(input: string, init?: RequestInit) => {
  const response = await fetch(input, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(isUnsafeRequest(init?.method) && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(init?.headers || {}),
    },
    ...init,
  })

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(errorPayload?.error || `Request failed with ${response.status}`)
  }

  return (await response.json()) as T
}

export const api = {
  setCsrfToken: (token: string | null | undefined) => {
    csrfToken = token || null
  },
  getBootstrap: () => request<BootstrapState>('/api/bootstrap'),
  getState: () => request<AppState>('/api/state'),
  login: (payload: AuthPayload) =>
    request<AppState>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  signup: (payload: AuthPayload) =>
    request<AppState>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  logout: () =>
    request<{ ok: true }>('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  changePassword: (payload: ChangePasswordPayload) =>
    request<AppState>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getSeries: (seriesId: string) => request<SeriesResponse>(`/api/series/${seriesId}`),
  getEntryTracks: (entryId: string) =>
    request<MediaTracksResponse>(`/api/media-tracks/${entryId}`),
  search: (query: string, scope: ScopeId) =>
    request<SearchResponse>(
      `/api/search?q=${encodeURIComponent(query)}&scope=${encodeURIComponent(scope)}`,
    ),
  setBookmark: (payload: {
    seriesId: string
    entryId: string
    entryIndex: number
    category: CategoryId
    progress: string
    cue: string
    position: SavedReadingPosition
  }) =>
    request<Pick<AppState, 'bookmarks' | 'readingPositions'>>('/api/bookmarks', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  removeBookmark: (seriesId: string) =>
    request<Pick<AppState, 'bookmarks' | 'readingPositions'>>(
      `/api/bookmarks/${encodeURIComponent(seriesId)}`,
      {
        method: 'DELETE',
      },
    ),
  addComment: (payload: CreateCommentPayload) =>
    request<SeriesResponse>('/api/comments', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  createRoot: (payload: CreateRootPayload) =>
    request<AppState>('/api/admin/roots', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteRoot: (rootId: string) =>
    request<AppState>(`/api/admin/roots/${rootId}`, {
      method: 'DELETE',
    }),
  listDirectories: (rootId: string, relativePath: string) =>
    request<DirectoryListing>(
      `/api/admin/directories?rootId=${encodeURIComponent(rootId)}&relativePath=${encodeURIComponent(relativePath)}`,
    ),
  createSource: (payload: CreateSourcePayload) =>
    request<AppState>('/api/admin/sources', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateSource: (sourceId: string, payload: UpdateSourcePayload) =>
    request<AppState>(`/api/admin/sources/${sourceId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteSource: (sourceId: string) =>
    request<AppState>(`/api/admin/sources/${sourceId}`, {
      method: 'DELETE',
    }),
  runScan: (sourceId?: string) =>
    request<AppState>('/api/admin/scan', {
      method: 'POST',
      body: JSON.stringify(sourceId ? { sourceId } : {}),
    }),
  resetPassword: (userId: string, payload: ResetPasswordPayload) =>
    request<AppState>(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  saveMetadataOverride: (seriesId: string, payload: MetadataOverridePayload) =>
    request<AppState>(`/api/admin/series/${seriesId}/metadata-override`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  clearMetadataOverride: (seriesId: string) =>
    request<AppState>(`/api/admin/series/${seriesId}/metadata-override`, {
      method: 'DELETE',
    }),
  refreshSeriesMetadata: (seriesId: string) =>
    request<AppState>(`/api/admin/series/${seriesId}/metadata-refresh`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
}
