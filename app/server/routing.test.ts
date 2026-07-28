import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appRoutePath,
  parseAppRoute,
  safeInternalDestination,
  type AppRoute,
} from '../src/routing'

const roundTrip = (route: AppRoute) => {
  const path = appRoutePath(route)
  const parsedUrl = new URL(path, 'https://library.example')
  return parseAppRoute(parsedUrl)
}

test('parses the stable top-level routes and normalizes default query state', () => {
  assert.deepEqual(parseAppRoute({ pathname: '/' }), { name: 'root' })
  assert.deepEqual(parseAppRoute({ pathname: '/bookmarks/', search: '?scope=manga' }), {
    name: 'bookmarks',
    scope: 'manga',
  })
  assert.deepEqual(parseAppRoute({ pathname: '/search', search: '?q=%20Dune%20&scope=books' }), {
    name: 'search',
    query: 'Dune',
    scope: 'books',
  })
  assert.deepEqual(parseAppRoute({ pathname: '/search', search: '?scope=invalid' }), {
    name: 'search',
    query: '',
    scope: 'all',
  })
})

test('round-trips library, series, and exact reader state', () => {
  const routes: AppRoute[] = [
    { name: 'library', category: 'books', topics: ['History', 'Art & Design'], sort: 'year' },
    {
      name: 'series',
      category: 'manga',
      seriesId: 'witch hat atelier-a82f38cc',
      tab: 'comments',
      season: 2,
    },
    {
      name: 'reader',
      category: 'novels',
      seriesId: 'the-dispossessed-a82f38cc',
      entryId: 'chapter 4-a9b123',
      page: null,
      percent: 37,
      variantId: 'epub-edition',
    },
    {
      name: 'offlineReader',
      downloadId: 'download/id',
      entryId: 'volume 1',
      page: 42,
      percent: null,
      variantId: null,
    },
  ]

  routes.forEach((route) => assert.deepEqual(roundTrip(route), route))
})

test('uses the page position in preference to a conflicting percentage', () => {
  assert.deepEqual(
    parseAppRoute({
      pathname: '/books/book-a82f38cc/read/book-a9b123',
      search: '?page=12&percent=99',
    }),
    {
      name: 'reader',
      category: 'books',
      seriesId: 'book-a82f38cc',
      entryId: 'book-a9b123',
      page: 12,
      percent: null,
      variantId: null,
    },
  )
})

test('bounds malformed reader and filter state to safe defaults', () => {
  assert.deepEqual(
    parseAppRoute({
      pathname: '/books/book-a82f38cc/read/book-a9b123',
      search: '?page=999999999999999&percent=101',
    }),
    {
      name: 'reader',
      category: 'books',
      seriesId: 'book-a82f38cc',
      entryId: 'book-a9b123',
      page: null,
      percent: null,
      variantId: null,
    },
  )
  assert.deepEqual(parseAppRoute({ pathname: '/books', search: '?sort=random&topic=&topic=History' }), {
    name: 'library',
    category: 'books',
    topics: ['History'],
    sort: 'title',
  })
})

test('rejects unknown, incomplete, and malformed routes', () => {
  assert.deepEqual(parseAppRoute({ pathname: '/books/book-a82f38cc/read' }), {
    name: 'notFound',
    path: '/books/book-a82f38cc/read',
  })
  assert.deepEqual(parseAppRoute({ pathname: '/anime' }), {
    name: 'notFound',
    path: '/anime',
  })
  assert.deepEqual(parseAppRoute({ pathname: '/books/%E0%A4%A' }), {
    name: 'notFound',
    path: '/books/%E0%A4%A',
  })
})

test('accepts only same-origin path destinations after authentication', () => {
  assert.equal(safeInternalDestination('/novels/a/read/b?page=12'), '/novels/a/read/b?page=12')
  assert.equal(safeInternalDestination('//evil.example/steal'), null)
  assert.equal(safeInternalDestination('https://evil.example/steal'), null)
  assert.equal(safeInternalDestination('bookmarks'), null)
})
