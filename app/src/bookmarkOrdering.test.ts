import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bookmark } from './appTypes'
import {
  getBookmarkEntryOrdinal,
  mergePendingBookmarks,
  selectNewerBookmarksForSync,
  sortBookmarksByRecency,
} from './bookmarkOrdering'

const bookmark = (seriesId: string, lastSeen: string): Bookmark => ({
  seriesId,
  category: 'novels',
  entryId: `${seriesId}-entry`,
  entryIndex: 0,
  entryLabel: 'Chapter 1',
  entryTitle: 'Chapter 1',
  progress: 'Page 1',
  cue: 'Chapter 1',
  lastSeen,
})

test('bookmark recency sorting is newest first with deterministic ties', () => {
  const sorted = sortBookmarksByRecency([
    bookmark('older', '2026-08-20T10:00:00.000Z'),
    bookmark('newer', '2026-08-23T10:00:00.000Z'),
    bookmark('tied-b', '2026-08-22T10:00:00.000Z'),
    bookmark('tied-a', '2026-08-22T10:00:00.000Z'),
  ])

  assert.deepEqual(sorted.map((item) => item.seriesId), [
    'newer',
    'tied-a',
    'tied-b',
    'older',
  ])
})

test('offline sync selects only local bookmarks newer than the server copy', () => {
  const local = [
    bookmark('unchanged', '2026-08-23T09:00:00.000Z'),
    bookmark('newest', '2026-08-23T12:00:00.000Z'),
    bookmark('offline-new', '2026-08-23T11:00:00.000Z'),
  ]
  const remote = [
    bookmark('unchanged', '2026-08-23T10:00:00.000Z'),
    bookmark('newest', '2026-08-23T10:30:00.000Z'),
  ]

  assert.deepEqual(
    selectNewerBookmarksForSync(local, remote).map((item) => item.seriesId),
    ['offline-new', 'newest'],
  )
})

test('bookmark progress uses the saved chapter label instead of a misleading package index', () => {
  const savedChapter = {
    ...bookmark('series', '2026-08-23T12:00:00.000Z'),
    entryIndex: 366,
    entryLabel: 'Chapter 2',
  }

  assert.equal(getBookmarkEntryOrdinal(savedChapter, 367), 2)
  assert.equal(
    getBookmarkEntryOrdinal({ ...savedChapter, entryLabel: 'Afterword' }, 367),
    367,
  )
})

test('failed offline bookmark writes remain overlaid until a later sync succeeds', () => {
  const remote = bookmark('series', '2026-08-23T10:00:00.000Z')
  const pending = {
    ...bookmark('series', '2026-08-23T12:00:00.000Z'),
    entryId: 'series-chapter-2',
    entryIndex: 1,
    entryLabel: 'Chapter 2',
  }

  assert.deepEqual(mergePendingBookmarks([remote], [pending]), [pending])
})
