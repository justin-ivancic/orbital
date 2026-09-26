import type { CategoryId, EntryFormat, ScopeId, SeriesTabId, ViewId } from './appTypes'

export const libraryRouteCategories = ['books', 'manga', 'novels', 'magazines'] as const
export const librarySorts = ['title', 'added', 'year', 'author'] as const
export const adminTabs = ['library', 'users', 'metadata', 'system'] as const

export type LibraryRouteCategory = (typeof libraryRouteCategories)[number]
export type LibrarySort = (typeof librarySorts)[number]
export type AdminTab = (typeof adminTabs)[number]

type ReaderLocation = {
  page: number | null
  percent: number | null
  variantId: string | null
}

export type AppRoute =
  | { name: 'home' }
  | { name: 'login'; next: string | null }
  | { name: 'signup' }
  | { name: 'downloads' }
  | { name: 'search'; query: string; scope: ScopeId }
  | {
      name: 'library'
      category: LibraryRouteCategory
      topics: string[]
      sort: LibrarySort
      page: number
    }
  | {
      name: 'series'
      category: LibraryRouteCategory
      seriesId: string
      tab: SeriesTabId
      season: number | null
      page: number
    }
  | ({
      name: 'reader'
      category: LibraryRouteCategory
      seriesId: string
      entryId: string
    } & ReaderLocation)
  | ({
      name: 'offlineReader'
      downloadId: string
      entryId: string
    } & ReaderLocation)
  | { name: 'creator'; creatorKey: string }
  | { name: 'settings' }
  | { name: 'admin'; tab: AdminTab }
  | { name: 'notFound'; path: string }

export type LocationLike = {
  pathname: string
  search?: string
}

const categorySet = new Set<string>(libraryRouteCategories)
const scopeSet = new Set<string>(['all', ...libraryRouteCategories])
const tabSet = new Set<string>(['overview', 'entries', 'comments'])
const sortSet = new Set<string>(librarySorts)
const adminTabSet = new Set<string>(adminTabs)
const percentReaderFormats = new Set<EntryFormat>(['epub', 'html', 'md', 'txt'])

export const readerBeginningLocation = (
  format: EntryFormat | null | undefined,
): Pick<ReaderLocation, 'page' | 'percent'> =>
  format && percentReaderFormats.has(format)
    ? { page: null, percent: 0 }
    : { page: 1, percent: null }

export const isPercentFormat = (format: EntryFormat | null | undefined) =>
  Boolean(format && percentReaderFormats.has(format))

const decodeSegment = (segment: string) => {
  try {
    const decoded = decodeURIComponent(segment)
    return decoded.length <= 512 ? decoded : null
  } catch {
    return null
  }
}

const encodeSegment = (segment: string) => encodeURIComponent(segment)

const normalizedPath = (pathname: string) => {
  if (!pathname || pathname === '/') {
    return '/'
  }

  const withLeadingSlash = pathname.startsWith('/') ? pathname : `/${pathname}`
  return withLeadingSlash.replace(/\/+$/, '') || '/'
}

const positiveInteger = (value: string | null) => {
  if (!value || !/^\d+$/.test(value)) {
    return null
  }

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 10_000_000
    ? parsed
    : null
}

const boundedPercent = (value: string | null) => {
  if (!value || !/^\d+$/.test(value)) {
    return null
  }

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null
}

const boundedText = (value: string | null, maxLength: number) => {
  const normalized = value?.trim() || ''
  return normalized.slice(0, maxLength)
}

const searchParams = (search = '') => new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)

const parseScope = (value: string | null): ScopeId =>
  value && scopeSet.has(value) ? (value as ScopeId) : 'all'

const parseCategory = (value: string | null): LibraryRouteCategory | null =>
  value && categorySet.has(value) ? (value as LibraryRouteCategory) : null

const parseTab = (value: string | null): SeriesTabId =>
  value && tabSet.has(value) ? (value as SeriesTabId) : 'entries'

const parseSort = (value: string | null): LibrarySort =>
  value && sortSet.has(value) ? (value as LibrarySort) : 'title'

const parseAdminTab = (value: string | null): AdminTab =>
  value && adminTabSet.has(value) ? (value as AdminTab) : 'library'

const parseLocationQuery = (params: URLSearchParams): ReaderLocation => {
  const page = positiveInteger(params.get('page'))
  const percent = page == null ? boundedPercent(params.get('percent')) : null

  return {
    page,
    percent,
    variantId: boundedText(params.get('variant'), 512) || null,
  }
}

export const safeInternalDestination = (value: string | null | undefined) => {
  if (!value || value.length > 2_048 || !value.startsWith('/') || value.startsWith('//')) {
    return null
  }

  try {
    const url = new URL(value, 'https://orbital.invalid')
    if (url.origin !== 'https://orbital.invalid') {
      return null
    }

    return `${normalizedPath(url.pathname)}${url.search}${url.hash}`
  } catch {
    return null
  }
}

export const parseAppRoute = ({ pathname, search = '' }: LocationLike): AppRoute => {
  const path = normalizedPath(pathname)
  const params = searchParams(search)

  switch (path) {
    case '/':
    case '/home':
    case '/bookmarks':
      return { name: 'home' }
    case '/login':
      return { name: 'login', next: safeInternalDestination(params.get('next')) }
    case '/signup':
      return { name: 'signup' }
    case '/downloads':
      return { name: 'downloads' }
    case '/search':
      return {
        name: 'search',
        query: boundedText(params.get('q'), 200),
        scope: parseScope(params.get('scope')),
      }
    case '/settings':
    case '/profile':
      return { name: 'settings' }
    case '/admin':
      return { name: 'admin', tab: parseAdminTab(params.get('tab')) }
  }

  const rawSegments = path.slice(1).split('/')
  const segments = rawSegments.map(decodeSegment)

  if (segments.some((segment) => segment == null)) {
    return { name: 'notFound', path }
  }

  if (segments[0] === 'creators' && segments.length === 2 && segments[1]) {
    return { name: 'creator', creatorKey: segments[1] }
  }

  if (
    segments[0] === 'downloads' &&
    segments.length === 5 &&
    segments[1] &&
    segments[2] === 'read' &&
    segments[3] === 'entry' &&
    segments[4]
  ) {
    return {
      name: 'offlineReader',
      downloadId: segments[1],
      entryId: segments[4],
      ...parseLocationQuery(params),
    }
  }

  const category = parseCategory(segments[0])
  if (!category) {
    return { name: 'notFound', path }
  }

  if (segments.length === 1) {
    const topics = [...new Set(
      params
        .getAll('topic')
        .slice(0, 16)
        .map((topic) => boundedText(topic, 80))
        .filter(Boolean),
    )]

    return {
      name: 'library',
      category,
      topics,
      sort: parseSort(params.get('sort')),
      page: positiveInteger(params.get('page')) ?? 1,
    }
  }

  const seriesId = segments[1]
  if (!seriesId) {
    return { name: 'notFound', path }
  }

  if (segments.length === 2) {
    return {
      name: 'series',
      category,
      seriesId,
      tab: parseTab(params.get('tab')),
      season: positiveInteger(params.get('season')),
      page: positiveInteger(params.get('page')) ?? 1,
    }
  }

  if (segments.length === 4 && segments[2] === 'read' && segments[3]) {
    return {
      name: 'reader',
      category,
      seriesId,
      entryId: segments[3],
      ...parseLocationQuery(params),
    }
  }

  return { name: 'notFound', path }
}

const appendScope = (params: URLSearchParams, scope: ScopeId) => {
  if (scope !== 'all') {
    params.set('scope', scope)
  }
}

const appendReaderLocation = (params: URLSearchParams, route: ReaderLocation) => {
  if (route.page != null && route.page > 0) {
    params.set('page', String(route.page))
  } else if (route.percent != null && route.percent >= 0) {
    params.set('percent', String(route.percent))
  }

  if (route.variantId) {
    params.set('variant', route.variantId)
  }
}

const withQuery = (path: string, params: URLSearchParams) => {
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

export const appRoutePath = (route: AppRoute): string => {
  const params = new URLSearchParams()

  switch (route.name) {
    case 'home':
      return '/'
    case 'login':
      if (route.next) {
        params.set('next', route.next)
      }
      return withQuery('/login', params)
    case 'signup':
      return '/signup'
    case 'downloads':
      return '/downloads'
    case 'search':
      if (route.query) {
        params.set('q', route.query)
      }
      appendScope(params, route.scope)
      return withQuery('/search', params)
    case 'library':
      route.topics.forEach((topic) => params.append('topic', topic))
      if (route.sort !== 'title') {
        params.set('sort', route.sort)
      }
      if (route.page > 1) {
        params.set('page', String(route.page))
      }
      return withQuery(`/${route.category}`, params)
    case 'series':
      if (route.tab !== 'entries') {
        params.set('tab', route.tab)
      }
      if (route.season != null) {
        params.set('season', String(route.season))
      }
      if (route.page > 1) {
        params.set('page', String(route.page))
      }
      return withQuery(`/${route.category}/${encodeSegment(route.seriesId)}`, params)
    case 'reader':
      appendReaderLocation(params, route)
      return withQuery(
        `/${route.category}/${encodeSegment(route.seriesId)}/read/${encodeSegment(route.entryId)}`,
        params,
      )
    case 'offlineReader':
      appendReaderLocation(params, route)
      return withQuery(
        `/downloads/${encodeSegment(route.downloadId)}/read/entry/${encodeSegment(route.entryId)}`,
        params,
      )
    case 'creator':
      return `/creators/${encodeSegment(route.creatorKey)}`
    case 'settings':
      return '/settings'
    case 'admin':
      if (route.tab !== 'library') {
        params.set('tab', route.tab)
      }
      return withQuery('/admin', params)
    case 'notFound':
      return normalizedPath(route.path)
  }
}

export const routeView = (route: AppRoute): ViewId => {
  switch (route.name) {
    case 'login':
    case 'signup':
      return 'home'
    case 'offlineReader':
      return 'reader'
    default:
      return route.name
  }
}

export const isProtectedRoute = (route: AppRoute) => route.name !== 'login' && route.name !== 'signup'

export const isReaderRoute = (
  route: AppRoute,
): route is Extract<AppRoute, { name: 'reader' | 'offlineReader' }> =>
  route.name === 'reader' || route.name === 'offlineReader'

export const shouldReplaceReaderNavigation = (currentRoute: AppRoute, nextRoute: AppRoute) =>
  // Chapters and reader-position updates belong to one session, so Back exits the reader.
  isReaderRoute(currentRoute) && isReaderRoute(nextRoute)

export const isSeriesRoute = (
  route: AppRoute,
): route is Extract<AppRoute, { name: 'series' | 'reader' }> =>
  route.name === 'series' || route.name === 'reader'

export const readerContentSessionKey = (route: AppRoute, variantId: string | null) => {
  if (!variantId) {
    return null
  }

  if (route.name === 'reader') {
    return `reader:${route.seriesId}:${variantId}`
  }

  if (route.name === 'offlineReader') {
    return `offline-reader:${route.downloadId}:${variantId}`
  }

  return null
}

export const routeForLocation = () =>
  parseAppRoute({ pathname: window.location.pathname, search: window.location.search })

export const categoryForRoute = (route: AppRoute): CategoryId | null => {
  if (route.name === 'library' || route.name === 'series' || route.name === 'reader') {
    return route.category
  }

  return null
}

export const isLibraryRouteCategory = (value: string): value is LibraryRouteCategory =>
  categorySet.has(value)

export const libraryRoute = (
  category: LibraryRouteCategory,
  overrides: Partial<Omit<Extract<AppRoute, { name: 'library' }>, 'name' | 'category'>> = {},
): AppRoute => ({
  name: 'library',
  category,
  topics: [],
  sort: 'title',
  page: 1,
  ...overrides,
})

export const seriesRoute = (
  category: CategoryId,
  seriesId: string,
  overrides: Partial<Pick<Extract<AppRoute, { name: 'series' }>, 'tab' | 'season' | 'page'>> = {},
): AppRoute => ({
  name: 'series',
  category: isLibraryRouteCategory(category) ? category : 'books',
  seriesId,
  tab: 'entries',
  season: null,
  page: 1,
  ...overrides,
})

export const readerRoute = (
  category: CategoryId,
  seriesId: string,
  entryId: string,
  location: Partial<ReaderLocation> = {},
): AppRoute => ({
  name: 'reader',
  category: isLibraryRouteCategory(category) ? category : 'books',
  seriesId,
  entryId,
  page: null,
  percent: null,
  variantId: null,
  ...location,
})
