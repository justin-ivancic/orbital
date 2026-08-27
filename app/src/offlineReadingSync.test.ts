import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppState, Bookmark, SavedReadingPosition } from './appTypes'
import type { OfflineReadingState } from './offlineStorage'
import { synchronizeOfflineReadingState } from './offlineReadingSync'

const bookmark = (entryId: string, entryIndex: number, lastSeen: string): Bookmark => ({
  seriesId: 'series-1',
  category: 'novels',
  entryId,
  entryIndex,
  entryLabel: `Chapter ${entryIndex + 1}`,
  entryTitle: `Chapter ${entryIndex + 1}`,
  progress: 'Chapter start',
  cue: `Chapter ${entryIndex + 1}`,
  lastSeen,
})

const appState = (savedBookmark: Bookmark): AppState => ({
  appName: 'Orbital',
  bootstrapAdmin: 'admin',
  openSignup: false,
  user: { id: 'user-1', username: 'reader', role: 'member' },
  csrfToken: 'csrf',
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
  scanStatus: {
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
  },
  library: [],
  bookmarks: [savedBookmark],
  readingPositions: { [savedBookmark.entryId]: { page: 1 } },
  sourceRoots: [],
  sourceFolders: [],
  users: [],
  metadataQueue: [],
})

const localReadingState = (savedBookmark: Bookmark): OfflineReadingState => ({
  ownerUserId: 'user-1',
  bookmarks: [savedBookmark],
  readingPositions: { [savedBookmark.entryId]: { page: 42, totalPages: 100 } },
  updatedAt: savedBookmark.lastSeen,
})

test('newer offline progress is sent with its position and persisted after server confirmation', async () => {
  const remoteBookmark = bookmark('chapter-1', 0, '2026-08-23T10:00:00.000Z')
  const offlineBookmark = bookmark('chapter-2', 1, '2026-08-23T12:00:00.000Z')
  const confirmedState = {
    ...appState(offlineBookmark),
    readingPositions: { 'chapter-2': { page: 42, totalPages: 100 } },
  }
  const observed: {
    savedPayload?: { entryId: string; lastSeen: string; position: SavedReadingPosition }
    persistedState?: OfflineReadingState
  } = {}

  const result = await synchronizeOfflineReadingState(
    appState(remoteBookmark),
    localReadingState(offlineBookmark),
    {
      saveBookmark: async (payload) => {
        observed.savedPayload = payload
      },
      loadRemoteState: async () => confirmedState,
      persistLocalState: async (state) => {
        observed.persistedState = state
        return state
      },
    },
  )

  assert.equal(observed.savedPayload?.entryId, 'chapter-2')
  assert.equal(observed.savedPayload?.lastSeen, offlineBookmark.lastSeen)
  assert.deepEqual(observed.savedPayload?.position, { page: 42, totalPages: 100 })
  assert.equal(result.bookmarks[0]?.entryId, 'chapter-2')
  assert.equal(observed.persistedState?.bookmarks[0]?.entryId, 'chapter-2')
  assert.deepEqual(observed.persistedState?.readingPositions['chapter-2'], { page: 42, totalPages: 100 })
})

test('a failed reconnect keeps newer offline progress locally for the next retry', async () => {
  const remoteBookmark = bookmark('chapter-1', 0, '2026-08-23T10:00:00.000Z')
  const offlineBookmark = bookmark('chapter-2', 1, '2026-08-23T12:00:00.000Z')
  const observed: { persistedState?: OfflineReadingState } = {}

  const result = await synchronizeOfflineReadingState(
    appState(remoteBookmark),
    localReadingState(offlineBookmark),
    {
      saveBookmark: async () => {
        throw new Error('Server unavailable')
      },
      loadRemoteState: async () => {
        throw new Error('must not load after zero successful writes')
      },
      persistLocalState: async (state) => {
        observed.persistedState = state
        return state
      },
    },
  )

  assert.equal(result.bookmarks[0]?.entryId, 'chapter-2')
  assert.equal(observed.persistedState?.bookmarks[0]?.entryId, 'chapter-2')
  assert.deepEqual(observed.persistedState?.readingPositions['chapter-2'], { page: 42, totalPages: 100 })
})

test('manual refresh preserves offline progress before reporting a sync failure', async () => {
  const remoteBookmark = bookmark('chapter-1', 0, '2026-08-23T10:00:00.000Z')
  const offlineBookmark = bookmark('chapter-2', 1, '2026-08-23T12:00:00.000Z')
  const observed: { persistedState?: OfflineReadingState } = {}

  await assert.rejects(
    synchronizeOfflineReadingState(
      appState(remoteBookmark),
      localReadingState(offlineBookmark),
      {
        saveBookmark: async () => {
          throw new Error('Server unavailable')
        },
        loadRemoteState: async () => {
          throw new Error('must not load after zero successful writes')
        },
        persistLocalState: async (state) => {
          observed.persistedState = state
          return state
        },
      },
      true,
    ),
    /Server unavailable/,
  )

  assert.equal(observed.persistedState?.bookmarks[0]?.entryId, 'chapter-2')
  assert.deepEqual(observed.persistedState?.readingPositions['chapter-2'], { page: 42, totalPages: 100 })
})
