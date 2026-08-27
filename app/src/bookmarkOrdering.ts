import type { Bookmark } from './appTypes'

const bookmarkTime = (bookmark: Pick<Bookmark, 'lastSeen'>) => {
  const timestamp = Date.parse(bookmark.lastSeen)
  return Number.isFinite(timestamp) ? timestamp : null
}

export const compareBookmarksByRecency = (left: Bookmark, right: Bookmark) => {
  const leftTime = bookmarkTime(left)
  const rightTime = bookmarkTime(right)

  if (leftTime !== null || rightTime !== null) {
    if (leftTime === null) {
      return 1
    }

    if (rightTime === null) {
      return -1
    }

    if (rightTime !== leftTime) {
      return rightTime - leftTime
    }
  }

  return left.seriesId.localeCompare(right.seriesId) || left.entryId.localeCompare(right.entryId)
}

export const sortBookmarksByRecency = (bookmarks: Bookmark[]) =>
  [...bookmarks].sort(compareBookmarksByRecency)

export const getBookmarkEntryOrdinal = (bookmark: Bookmark, entryTotal: number) => {
  const safeTotal = Math.max(1, entryTotal)
  const fallbackOrdinal = Math.min(safeTotal, Math.max(1, bookmark.entryIndex + 1))
  const labelMatch = bookmark.entryLabel.match(
    /^(?:chapter|volume|issue|entry)\s+0*(\d+(?:\.\d+)?)(?:\b|\s|$)/i,
  )
  const labelOrdinal = labelMatch ? Number(labelMatch[1]) : Number.NaN

  return Number.isFinite(labelOrdinal) && labelOrdinal > 0 && labelOrdinal <= safeTotal
    ? labelOrdinal
    : fallbackOrdinal
}

export const mergePendingBookmarks = (
  remoteBookmarks: Bookmark[],
  pendingLocalBookmarks: Bookmark[],
) => {
  const mergedBySeriesId = new Map(
    remoteBookmarks.map((bookmark) => [bookmark.seriesId, bookmark]),
  )

  for (const bookmark of pendingLocalBookmarks) {
    mergedBySeriesId.set(bookmark.seriesId, bookmark)
  }

  return sortBookmarksByRecency([...mergedBySeriesId.values()])
}

export const selectNewerBookmarksForSync = (
  localBookmarks: Bookmark[],
  remoteBookmarks: Bookmark[],
) => {
  const remoteBySeriesId = new Map(remoteBookmarks.map((bookmark) => [bookmark.seriesId, bookmark]))

  return localBookmarks
    .filter((localBookmark) => {
      const remoteBookmark = remoteBySeriesId.get(localBookmark.seriesId)
      if (!remoteBookmark) {
        return true
      }

      const localTime = bookmarkTime(localBookmark)
      const remoteTime = bookmarkTime(remoteBookmark)

      if (localTime === null) {
        return remoteTime === null
      }

      return remoteTime === null || localTime > remoteTime
    })
    .sort((left, right) => compareBookmarksByRecency(right, left))
}
