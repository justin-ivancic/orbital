import { ApiError, api, isNetworkError, type ProgressPayload } from '../api'
import type { Bookmark, CategoryId, SavedReadingPosition } from '../appTypes'
import { sortBookmarksByRecency } from '../bookmarkOrdering'
import { isOffline } from './connection'
import { libraryStore, persistReadingCache, type ReadingOverlay } from './library'

/**
 * Reading progress is saved locally first and synchronised in the background.
 * Only the newest position per series is kept in the queue, so a burst of
 * page turns costs one small request, and nothing is lost while offline.
 */

type PendingProgress = ProgressPayload & {
  lastSeen: string
  entryLabel: string
  entryTitle: string
}

export type ProgressInput = {
  seriesId: string
  category: CategoryId
  entryLabel: string
  entryTitle: string
  /** The file (variant) that was read. */
  variantId: string
  entryIndex: number
  position: SavedReadingPosition
}

const pending = new Map<string, PendingProgress>()
let pendingOwner: string | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushing: Promise<void> | null = null
let retryAttempt = 0

const storageKey = (userId: string) => `orbital:pending-progress:${userId}`

const persistPending = () => {
  if (!pendingOwner) {
    return
  }

  try {
    if (pending.size === 0) {
      window.localStorage.removeItem(storageKey(pendingOwner))
    } else {
      window.localStorage.setItem(storageKey(pendingOwner), JSON.stringify([...pending.values()]))
    }
  } catch {
    // The queue still lives in memory for this session.
  }
}

/** Loads the unsent progress for a user (after sign-in or on start). */
export const loadPendingProgress = (userId: string | null) => {
  if (pendingOwner === userId) {
    return
  }

  pending.clear()
  pendingOwner = userId
  retryAttempt = 0

  if (!userId) {
    return
  }

  try {
    const raw = window.localStorage.getItem(storageKey(userId))
    const items = raw ? (JSON.parse(raw) as PendingProgress[]) : []

    items.forEach((item) => {
      if (item && typeof item.seriesId === 'string' && typeof item.entryId === 'string') {
        pending.set(item.seriesId, item)
      }
    })
  } catch {
    // A damaged queue is dropped; the server copy stays authoritative.
  }
}

/** Progress that the server has not confirmed yet, applied over server state. */
export const pendingOverlay = (): ReadingOverlay => {
  const bookmarks: Bookmark[] = []
  const positions: Record<string, SavedReadingPosition> = {}

  pending.forEach((item) => {
    bookmarks.push(toBookmark(item))
    positions[item.entryId] = item.position
  })

  return { bookmarks, positions }
}

const toBookmark = (item: PendingProgress): Bookmark => ({
  seriesId: item.seriesId,
  category: item.category,
  entryId: item.entryId,
  entryIndex: item.entryIndex,
  entryLabel: item.entryLabel,
  entryTitle: item.entryTitle,
  progress: item.progress,
  cue: item.cue,
  lastSeen: item.lastSeen,
})

const describePosition = (position: SavedReadingPosition) => {
  if (position.locationType === 'percent') {
    const percent = Math.round(position.page)
    return {
      progress: position.progressLabel || `${percent}%`,
      cue: position.cueLabel || `Bookmark set at ${percent}%`,
    }
  }

  const total = position.totalPages ?? 0
  return {
    progress: position.progressLabel || (total > 0 ? `Page ${position.page} of ${total}` : `Page ${position.page}`),
    cue: position.cueLabel || `Bookmark set at page ${position.page}`,
  }
}

const samePosition = (left: SavedReadingPosition | undefined, right: SavedReadingPosition) =>
  Boolean(
    left &&
      left.page === right.page &&
      left.totalPages === right.totalPages &&
      left.locationType === right.locationType &&
      left.viewMode === right.viewMode &&
      (left.locator ?? null) === (right.locator ?? null),
  )

/** Records where the reader is. Cheap enough to call on every page turn. */
export const recordProgress = (input: ProgressInput) => {
  const state = libraryStore.get()
  const userId = state.ownerId

  if (!userId) {
    return
  }

  if (pendingOwner !== userId) {
    loadPendingProgress(userId)
  }

  const currentBookmark = state.bookmarks.find((bookmark) => bookmark.seriesId === input.seriesId)

  if (
    currentBookmark?.entryId === input.variantId &&
    samePosition(state.readingPositions[input.variantId], input.position)
  ) {
    return
  }

  const labels = describePosition(input.position)
  const item: PendingProgress = {
    seriesId: input.seriesId,
    entryId: input.variantId,
    entryIndex: input.entryIndex,
    category: input.category,
    progress: labels.progress,
    cue: labels.cue,
    position: input.position,
    lastSeen: new Date().toISOString(),
    entryLabel: input.entryLabel,
    entryTitle: input.entryTitle,
  }

  pending.set(input.seriesId, item)
  persistPending()

  libraryStore.set((previous) => ({
    ...previous,
    bookmarks: sortBookmarksByRecency([
      ...previous.bookmarks.filter((bookmark) => bookmark.seriesId !== input.seriesId),
      toBookmark(item),
    ]),
    readingPositions: { ...previous.readingPositions, [input.variantId]: input.position },
  }))
  persistReadingCache()
  scheduleFlush(2_000)
}

export const scheduleFlush = (delayMs: number) => {
  if (flushTimer) {
    clearTimeout(flushTimer)
  }

  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushProgress()
  }, delayMs)
}

const retryDelay = () => Math.min(60_000, 5_000 * 2 ** Math.min(retryAttempt, 4))

/** Sends queued progress to the server. Safe to call at any time. */
export const flushProgress = async (options: { keepalive?: boolean } = {}): Promise<void> => {
  if (flushing) {
    return flushing
  }

  if (pending.size === 0 || (isOffline() && !options.keepalive)) {
    return
  }

  flushing = (async () => {
    const owner = pendingOwner

    for (const item of [...pending.values()]) {
      try {
        const response = await api.saveProgress(
          {
            seriesId: item.seriesId,
            entryId: item.entryId,
            entryIndex: item.entryIndex,
            category: item.category,
            progress: item.progress,
            cue: item.cue,
            position: item.position,
            lastSeen: item.lastSeen,
          },
          { keepalive: options.keepalive },
        )

        if (pendingOwner !== owner) {
          return
        }

        if (pending.get(item.seriesId) === item) {
          pending.delete(item.seriesId)
        }

        if (!response.saved && response.bookmark) {
          // Another device read further more recently; show its position.
          const serverBookmark = response.bookmark
          libraryStore.set((previous) => ({
            ...previous,
            bookmarks: sortBookmarksByRecency([
              ...previous.bookmarks.filter((bookmark) => bookmark.seriesId !== serverBookmark.seriesId),
              serverBookmark,
            ]),
            readingPositions: response.position
              ? { ...previous.readingPositions, [serverBookmark.entryId]: response.position }
              : previous.readingPositions,
          }))
          persistReadingCache()
        }
        retryAttempt = 0
      } catch (error) {
        if (error instanceof ApiError && error.status != null && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408 && error.status !== 429) {
          // The entry no longer exists (or the request is invalid): drop it.
          if (pending.get(item.seriesId) === item) {
            pending.delete(item.seriesId)
          }
          continue
        }

        if (isNetworkError(error) || error instanceof ApiError) {
          retryAttempt += 1
          scheduleFlush(retryDelay())
        }
        break
      }
    }

    persistPending()
  })().finally(() => {
    flushing = null
  })

  return flushing
}

export const hasPendingProgress = () => pending.size > 0

/** Drops unsent progress for one series (it is being removed from the list). */
export const forgetPendingProgress = (seriesId: string) => {
  if (pending.delete(seriesId)) {
    persistPending()
  }
}

export const discardPendingProgress = (userId: string) => {
  if (pendingOwner === userId) {
    pending.clear()
  }

  try {
    window.localStorage.removeItem(storageKey(userId))
  } catch {
    // Nothing to clean up.
  }
}

if (typeof window !== 'undefined') {
  const flushBeforeLeaving = () => {
    void flushProgress({ keepalive: true })
  }

  window.addEventListener('pagehide', flushBeforeLeaving)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushBeforeLeaving()
    }
  })
}
