import type { CategoryId, EntryFormat, ScopeId, SeriesTabId, ViewId } from './appTypes'

export const libraryRouteCategories = ['manga', 'novels', 'books', 'magazines'] as const

export type LibraryRouteCategory = (typeof libraryRouteCategories)[number]
export type LibrarySort = 'title' | 'year'

type ReaderLocation = {
  page: number | null
  percent: number | null
  variantId: string | null
}

export type AppRoute =
  | { name: 'root' }
  | { name: 'login'; next: string | null }
  | { name: 'signup' }
  | { name: 'bookmarks'; scope: ScopeId }
  | { name: 'downloads' }
  | { name: 'search'; query: string; scope: ScopeId }
  | {
      name: 'library'
      category: LibraryRouteCategory
      topics: string[]
      sort: LibrarySort
    }
  | {
      name: 'series'
      category: LibraryRouteCategory
      seriesId: string
      tab: SeriesTabId
      season: number | null
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
  | { name: 'profile' }
  | { name: 'admin' }
  | { name: 'notFound'; path: string }

export type LocationLike = {
  pathname: string
  search?: string
}

const categorySet = new Set<string>(libraryRouteCategories)
const scopeSet = new Set<string>(['all', ...libraryRouteCategories])
const tabSet = new Set<string>(['overview', 'entries', 'comments'])
const percentReaderFormats = new Set<EntryFormat>(['epub', 'html', 'md', 'txt'])

export const readerBeginningLocation = (
  format: EntryFormat | null | undefined,
): Pick<ReaderLocation, 'page' | 'percent'> =>
  format && percentReaderFormats.has(format)
    ? { page: null, percent: 0 }
    : { page: 1, percent: null }

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

  if (path === '/') {
    return { name: 'root' }
  }

  if (path === '/login') {
    return { name: 'login', next: safeInternalDestination(params.get('next')) }
  }

  if (path === '/signup') {
    return { name: 'signup' }
  }

  if (path === '/bookmarks') {
    return { name: 'bookmarks', scope: parseScope(params.get('scope')) }
  }

  if (path === '/downloads') {
    return { name: 'downloads' }
  }

  if (path === '/search') {
    return {
      name: 'search',
      query: boundedText(params.get('q'), 200),
      scope: parseScope(params.get('scope')),
    }
  }

  if (path === '/profile') {
    return { name: 'profile' }
  }

  if (path === '/admin') {
    return { name: 'admin' }
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
      sort: params.get('sort') === 'year' ? 'year' : 'title',
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
    case 'root':
      return '/'
    case 'login':
      if (route.next) {
        params.set('next', route.next)
      }
      return withQuery('/login', params)
    case 'signup':
      return '/signup'
    case 'bookmarks':
      appendScope(params, route.scope)
      return withQuery('/bookmarks', params)
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
      return withQuery(`/${route.category}`, params)
    case 'series':
      if (route.tab !== 'entries') {
        params.set('tab', route.tab)
      }
      if (route.season != null) {
        params.set('season', String(route.season))
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
    case 'profile':
      return '/profile'
    case 'admin':
      return '/admin'
    case 'notFound':
      return normalizedPath(route.path)
  }
}

export const routeView = (route: AppRoute): ViewId => {
  switch (route.name) {
    case 'root':
    case 'login':
    case 'signup':
      return 'bookmarks'
    case 'library':
      return 'library'
    case 'series':
      return 'series'
    case 'reader':
    case 'offlineReader':
      return 'reader'
    case 'creator':
      return 'creator'
    case 'notFound':
      return 'notFound'
    default:
      return route.name
  }
}

export const isProtectedRoute = (route: AppRoute) =>
  !['root', 'login', 'signup'].includes(route.name)

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
