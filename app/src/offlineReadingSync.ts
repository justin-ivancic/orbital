import type { AppState, Bookmark, SavedReadingPosition } from './appTypes'
import type { OfflineReadingState } from './offlineStorage'
import { mergePendingBookmarks, selectNewerBookmarksForSync } from './bookmarkOrdering'

type BookmarkSyncPayload = Pick<
  Bookmark,
  'seriesId' | 'entryId' | 'entryIndex' | 'category' | 'progress' | 'cue' | 'lastSeen'
> & {
  position: SavedReadingPosition
}

type OfflineReadingSyncOperations = {
  saveBookmark: (payload: BookmarkSyncPayload) => Promise<unknown>
  loadRemoteState: () => Promise<AppState>
  persistLocalState: (state: OfflineReadingState) => Promise<OfflineReadingState>
}

export const synchronizeOfflineReadingState = async (
  initialRemoteState: AppState,
  localState: OfflineReadingState,
  operations: OfflineReadingSyncOperations,
  failOnSyncError = false,
) => {
  if (!initialRemoteState.user) {
    return initialRemoteState
  }

  const bookmarksToSync = selectNewerBookmarksForSync(
    localState.bookmarks,
    initialRemoteState.bookmarks,
  )
  const failedBookmarks: Bookmark[] = []
  let firstSyncError: unknown = null
  let successfulSyncCount = 0

  for (const bookmark of bookmarksToSync) {
    try {
      await operations.saveBookmark({
        seriesId: bookmark.seriesId,
        entryId: bookmark.entryId,
        entryIndex: bookmark.entryIndex,
        category: bookmark.category,
        progress: bookmark.progress,
        cue: bookmark.cue,
        position: localState.readingPositions[bookmark.entryId] || { page: 1 },
        lastSeen: bookmark.lastSeen,
      })
      successfulSyncCount += 1
    } catch (error) {
      failedBookmarks.push(bookmark)
      firstSyncError ??= error
    }
  }

  let remoteState = initialRemoteState
  if (successfulSyncCount > 0) {
    try {
      remoteState = await operations.loadRemoteState()
    } catch (error) {
      firstSyncError ??= error
      failedBookmarks.splice(0, failedBookmarks.length, ...bookmarksToSync)
    }
  }

  const pendingBookmarks = mergePendingBookmarks([], failedBookmarks)
  const pendingPositions = pendingBookmarks.reduce<Record<string, SavedReadingPosition>>(
    (positions, bookmark) => {
      const position = localState.readingPositions[bookmark.entryId]
      if (position) {
        positions[bookmark.entryId] = position
      }
      return positions
    },
    {},
  )
  const synchronizedState = {
    ...remoteState,
    bookmarks: mergePendingBookmarks(remoteState.bookmarks, pendingBookmarks),
    readingPositions: {
      ...remoteState.readingPositions,
      ...pendingPositions,
    },
  }

  await operations.persistLocalState({
    ownerUserId: initialRemoteState.user.id,
    bookmarks: synchronizedState.bookmarks,
    readingPositions: synchronizedState.readingPositions,
    updatedAt: localState.updatedAt,
  })

  if (firstSyncError && failOnSyncError) {
    throw firstSyncError
  }

  return synchronizedState
}
