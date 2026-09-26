import { ApiError, api, isNetworkError } from '../api'
import type { SeriesComment, SeriesDetail } from '../appTypes'
import { cacheDelete, cacheGet, cacheSet } from './cache'
import { isOffline } from './connection'
import { getSeriesIndex, libraryStore } from './library'
import { createStore, useStore } from './store'

export type SeriesLoadState = {
  detail: SeriesDetail | null
  loading: boolean
  error: string | null
  errorStatus: number | null
  fetchedAt: number
}

type SeriesStoreState = Record<string, SeriesLoadState>

export const seriesStore = createStore<SeriesStoreState>({})

const memoryLimit = 40
const persistedLimit = 120
const freshForMs = 10 * 60 * 1000
const inFlight = new Map<string, Promise<SeriesDetail | null>>()
const accessOrder: string[] = []

const cacheKey = (userId: string, seriesId: string) => `series:${userId}:${seriesId}`
const indexKey = (userId: string) => `series-index:${userId}`

const touch = (seriesId: string) => {
  const index = accessOrder.indexOf(seriesId)

  if (index >= 0) {
    accessOrder.splice(index, 1)
  }

  accessOrder.push(seriesId)

  if (accessOrder.length > memoryLimit) {
    const evicted = accessOrder.splice(0, accessOrder.length - memoryLimit)
    seriesStore.set((previous) => {
      const next = { ...previous }
      evicted.forEach((id) => delete next[id])
      return next
    })
  }
}

const blankState: SeriesLoadState = {
  detail: null,
  loading: false,
  error: null,
  errorStatus: null,
  fetchedAt: 0,
}

const setSeriesState = (seriesId: string, patch: Partial<SeriesLoadState>) => {
  seriesStore.set((previous) => ({
    ...previous,
    [seriesId]: { ...(previous[seriesId] ?? blankState), ...patch },
  }))
}

const persistDetail = async (userId: string, detail: SeriesDetail) => {
  await cacheSet(cacheKey(userId, detail.id), detail)
  const index = (await cacheGet<string[]>(indexKey(userId))) ?? []
  const nextIndex = [...index.filter((id) => id !== detail.id), detail.id]
  const evicted = nextIndex.splice(0, Math.max(0, nextIndex.length - persistedLimit))
  await cacheSet(indexKey(userId), nextIndex)
  await Promise.all(evicted.map((id) => cacheDelete(cacheKey(userId, id))))
}

const isStale = (detail: SeriesDetail, fetchedAt: number) => {
  const summary = getSeriesIndex(libraryStore.get().library).get(detail.id)

  if (summary && summary.stats.lastScanAt !== detail.stats.lastScanAt) {
    return true
  }

  return Date.now() - fetchedAt > freshForMs
}

/**
 * Loads a series with its entries: memory first, then the on-device cache
 * (shown immediately), then the server when the copy may be out of date.
 */
export const loadSeries = async (seriesId: string, options: { force?: boolean } = {}) => {
  const userId = libraryStore.get().ownerId
  const existing = seriesStore.get()[seriesId]
  touch(seriesId)

  if (existing?.detail && !options.force && !isStale(existing.detail, existing.fetchedAt)) {
    return existing.detail
  }

  const running = inFlight.get(seriesId)
  if (running) {
    return running
  }

  const task = (async () => {
    let detail = existing?.detail ?? null

    if (!detail && userId) {
      const cached = await cacheGet<SeriesDetail>(cacheKey(userId, seriesId))

      if (cached) {
        detail = cached
        setSeriesState(seriesId, { detail: cached, fetchedAt: 0, error: null, errorStatus: null })
      }
    }

    if (isOffline()) {
      if (!detail) {
        setSeriesState(seriesId, { loading: false, error: null, errorStatus: null })
      }
      return detail
    }

    setSeriesState(seriesId, { loading: true })

    try {
      const fresh = await api.getSeries(seriesId)
      setSeriesState(seriesId, {
        detail: fresh,
        loading: false,
        error: null,
        errorStatus: null,
        fetchedAt: Date.now(),
      })

      if (userId) {
        void persistDetail(userId, fresh)
      }

      return fresh
    } catch (error) {
      const status = error instanceof ApiError ? error.status : null
      setSeriesState(seriesId, {
        loading: false,
        error: error instanceof Error ? error.message : 'The title could not be loaded.',
        errorStatus: status,
        // A cached copy stays visible when only the network failed.
        detail: status === 404 ? null : detail,
      })

      if (status === 404 && userId) {
        void cacheDelete(cacheKey(userId, seriesId))
      }

      if (!isNetworkError(error) && status !== 404) {
        throw error
      }

      return status === 404 ? null : detail
    } finally {
      inFlight.delete(seriesId)
    }
  })()

  inFlight.set(seriesId, task)
  return task
}

export const updateSeriesComments = (seriesId: string, comments: SeriesComment[]) => {
  const current = seriesStore.get()[seriesId]?.detail

  if (!current) {
    return
  }

  const detail = { ...current, comments }
  setSeriesState(seriesId, { detail })
  const userId = libraryStore.get().ownerId

  if (userId) {
    void persistDetail(userId, detail)
  }
}

/** Registers a detail built elsewhere (for example an offline download). */
export const putSeriesDetail = (detail: SeriesDetail) => {
  setSeriesState(detail.id, { detail, loading: false, error: null, errorStatus: null, fetchedAt: Date.now() })
  touch(detail.id)
}

export const clearSeriesCache = () => {
  accessOrder.splice(0, accessOrder.length)
  inFlight.clear()
  seriesStore.set({})
}

export const useSeriesState = (seriesId: string | null) =>
  useStore(seriesStore, (state) => (seriesId ? state[seriesId] ?? blankState : blankState))
