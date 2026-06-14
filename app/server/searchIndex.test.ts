import assert from 'node:assert/strict'
import test from 'node:test'
import type { Database } from 'better-sqlite3'
import type { CategoryId } from '../src/appTypes.ts'
import { searchSeries } from './library.ts'

type PreparedStatementMock = {
  all: (...args: unknown[]) => unknown[]
}

const seriesRow = {
  id: 'series_why_not_capitalism',
  source_folder_id: 'source_books',
  category: 'books' as CategoryId,
  title: 'Why Not Capitalism 2nd Edition',
  title_short: 'Why Not Capitalism',
  year: 2024,
  format: 'Book',
  status: 'Ready to read',
  description: 'A short political economy book.',
  folder_path: '/library/books/Why Not Capitalism',
  cover_source: 'Generated fallback cover',
  metadata_source: 'Folder-derived metadata',
  cover_path: null,
  cover_mime: null,
  banner_path: null,
  banner_mime: null,
  remote_provider: null,
  remote_id: null,
  external_url: null,
  source_name: 'Michael Munger',
  source_role: 'Author',
  genres_json: '["politics","economics"]',
  file_count: 1,
  last_scan_at: '2026-06-14T12:00:00.000Z',
  tags_json: '["capitalism","reading list"]',
  metadata_refreshed_at: null,
}

const entryCountRow = {
  series_id: seriesRow.id,
  relative_path: 'why-not-capitalism.pdf',
  label: 'Book PDF',
  title: 'Class Reading List Appendix',
  sort_order: 1,
  chapter_number: null,
  season_number: null,
  episode_number: null,
}

class SearchDatabaseMock {
  ftsQueries: string[] = []

  constructor(private readonly failFts = false) {}

  prepare(sql: string): PreparedStatementMock {
    if (sql.includes('FROM series_search_fts')) {
      if (this.failFts) {
        throw new Error('FTS is unavailable')
      }

      return {
        all: (ftsQuery: unknown, scope: unknown) => {
          this.ftsQueries.push(String(ftsQuery))
          return scope === 'manga' ? [] : [seriesRow]
        },
      }
    }

    if (sql.includes('FROM series s') && sql.includes('LEFT JOIN entries e')) {
      return {
        all: (scope: unknown) => scope === 'manga' ? [] : [seriesRow],
      }
    }

    if (sql.includes('FROM entries') && sql.includes('WHERE series_id IN')) {
      return {
        all: () => [entryCountRow],
      }
    }

    throw new Error(`Unhandled search SQL in test: ${sql.replace(/\s+/g, ' ').trim()}`)
  }

  asDatabase() {
    return this as unknown as Database
  }
}

test('series search uses the materialized metadata and entry search document', () => {
  const db = new SearchDatabaseMock()
  const result = searchSeries(db.asDatabase(), 'why-not capitalism', 'all')

  assert.deepEqual(db.ftsQueries, ['why* AND not* AND capitalism*'])
  assert.deepEqual(result.results.map((series) => series.id), [seriesRow.id])
  assert.equal(result.results[0]?.sourceName, 'Michael Munger')
  assert.equal(result.results[0]?.progressLabel, '1 book file')
  assert.deepEqual(searchSeries(db.asDatabase(), 'munger', 'manga').results, [])
})

test('series search falls back to joined LIKE search when FTS is unavailable', () => {
  const db = new SearchDatabaseMock(true)
  const result = searchSeries(db.asDatabase(), 'reading appendix', 'all')

  assert.deepEqual(result.results.map((series) => series.id), [seriesRow.id])
})
