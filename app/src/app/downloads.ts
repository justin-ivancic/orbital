import { Filesystem } from '@capacitor/filesystem'
import { api, getAuthHeaders } from '../api'
import type {
  OfflineDownloadRecord,
  OfflineDownloadResource,
  OfflineDownloadTarget,
  OfflineStorageSummary,
} from '../appTypes'
import {
  isOfflineDownloadCandidateForTarget,
  isOfflineResourceComplete,
  isRetryableOfflineDownloadError,
  mergeOfflineDownloadRecord,
  mergeOfflineManifestWithStoredResources,
  offlineRetryDelay,
  OfflineDownloadCancelledError,
  OfflineResourceIntegrityError,
  planReusableOfflineResources,
  runOfflineDownloadQueue,
  waitForOfflineRetry,
} from '../offlineDownloads'
import {
  copyOfflineResources,
  createOfflineDownloadRecord,
  deleteAllOfflineDownloadsForUser,
  deleteOfflineDownload,
  downloadOfflineResourceNative,
  getOfflineDownload,
  getOfflineResourceInventory,
  getOfflineStorageSummary,
  initNativeOfflineStorage,
  listOfflineDownloads,
  putOfflineDownload,
  putOfflineResource,
  requestOfflineStoragePersistence,
  type OfflineStoredResource,
} from '../offlineStorage'
import { isNativeApp } from '../platform'
import { currentStrings } from '../i18n'
import { isOffline } from './connection'
import { notify } from './notices'
import { createStore, useStore } from './store'

export type DownloadPhase = 'preparing' | 'reusing' | 'downloading' | 'removing'

export type DownloadActivity = {
  phase: DownloadPhase
  done: number
  total: number
  bytes: number
  totalBytes: number
}

export type DownloadsState = {
  userId: string | null
  loaded: boolean
  records: OfflineDownloadRecord[]
  /** Live work keyed by target (`entry:…`, `series:…`) or download id while removing. */
  activity: Record<string, DownloadActivity>
  summary: OfflineStorageSummary | null
}

export const downloadsStore = createStore<DownloadsState>({
  userId: null,
  loaded: false,
  records: [],
  activity: {},
  summary: null,
})

export const targetKey = (target: OfflineDownloadTarget) =>
  target.type === 'entry' ? `entry:${target.entryId}` : `series:${target.seriesId}`

export const isActiveDownload = (record: OfflineDownloadRecord) =>
  record.status === 'queued' || record.status === 'downloading'

const checkpointIntervalMs = 3_000
const uiUpdateIntervalMs = 800
const autoRetryDelayMs = 15_000

const running = new Set<string>()
const controllers = new Map<string, AbortController>()
const completions = new Map<string, Promise<void>>()
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Targets that should not restart by themselves (paused, failed, finished). */
const autoResumeGuard = new Set<string>()
const deletedIds = new Set<string>()
let deleteAllInProgress = false
let refreshRequest = 0

const sortRecords = (records: OfflineDownloadRecord[]) =>
  [...records].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))

/* ------------------------------------------------------ store helpers -- */

const pendingRecordUpdates = new Map<string, OfflineDownloadRecord>()
let recordFlushTimer: ReturnType<typeof setTimeout> | null = null

const flushRecordUpdates = () => {
  recordFlushTimer = null

  if (pendingRecordUpdates.size === 0) {
    return
  }

  const updates = new Map(pendingRecordUpdates)
  pendingRecordUpdates.clear()

  downloadsStore.set((previous) => {
    const withoutUpdated = previous.records.filter((record) => !updates.has(record.id))
    return { ...previous, records: sortRecords([...withoutUpdated, ...updates.values()]) }
  })
}

/** Shows a record change. Progress updates are batched to spare e-ink screens. */
const showRecord = (record: OfflineDownloadRecord, immediate = false) => {
  if (deletedIds.has(record.id)) {
    return
  }

  pendingRecordUpdates.set(record.id, record)

  if (immediate) {
    if (recordFlushTimer) {
      clearTimeout(recordFlushTimer)
    }
    flushRecordUpdates()
    return
  }

  recordFlushTimer ??= setTimeout(flushRecordUpdates, uiUpdateIntervalMs)
}

const saveRecord = async (record: OfflineDownloadRecord, immediate = false) => {
  await putOfflineDownload(record)
  showRecord(record, immediate)
}

const activityUpdates = new Map<string, DownloadActivity | null>()
let activityFlushTimer: ReturnType<typeof setTimeout> | null = null

const flushActivity = () => {
  activityFlushTimer = null

  if (activityUpdates.size === 0) {
    return
  }

  const updates = new Map(activityUpdates)
  activityUpdates.clear()

  downloadsStore.set((previous) => {
    const activity = { ...previous.activity }

    updates.forEach((value, key) => {
      if (value) {
        activity[key] = value
      } else {
        delete activity[key]
      }
    })

    return { ...previous, activity }
  })
}

const setActivity = (key: string, activity: DownloadActivity | null, immediate = false) => {
  activityUpdates.set(key, activity)

  if (immediate) {
    if (activityFlushTimer) {
      clearTimeout(activityFlushTimer)
    }
    flushActivity()
    return
  }

  activityFlushTimer ??= setTimeout(flushActivity, uiUpdateIntervalMs)
}

/* ------------------------------------------------ native live progress -- */

type LiveTransfer = {
  onBytes: (bytes: number) => void
}

const liveTransfers = new Map<string, LiveTransfer>()
let progressListenerReady = false

const ensureProgressListener = () => {
  if (!isNativeApp || progressListenerReady) {
    return
  }

  progressListenerReady = true
  void Filesystem.addListener('progress', (status) => {
    liveTransfers.get(status.url)?.onBytes(status.bytes)
  }).catch(() => {
    progressListenerReady = false
  })
}

/* ----------------------------------------------------------- loading -- */

export const refreshDownloads = async () => {
  const request = ++refreshRequest
  const userId = downloadsStore.get().userId

  if (!userId) {
    downloadsStore.update({ records: [], loaded: true, summary: null })
    return
  }

  try {
    const records = await listOfflineDownloads(userId)

    if (request !== refreshRequest || downloadsStore.get().userId !== userId) {
      return
    }

    pendingRecordUpdates.clear()
    downloadsStore.update({
      records: sortRecords(records.filter((record) => !deletedIds.has(record.id))),
      loaded: true,
    })

    void getOfflineStorageSummary(userId, records)
      .then((summary) => {
        if (request === refreshRequest) {
          downloadsStore.update({ summary })
        }
      })
      .catch(() => undefined)
  } catch {
    if (request === refreshRequest) {
      downloadsStore.update({ loaded: true })
    }
  }
}

const stopAll = () => {
  controllers.forEach((controller) => controller.abort())
  retryTimers.forEach((timer) => clearTimeout(timer))
  retryTimers.clear()
}

/** Switches the manager to a signed-in user (or none). */
export const setDownloadsUser = async (userId: string | null) => {
  if (downloadsStore.get().userId === userId) {
    return
  }

  stopAll()
  autoResumeGuard.clear()
  deletedIds.clear()
  pendingRecordUpdates.clear()
  downloadsStore.set({ userId, loaded: false, records: [], activity: {}, summary: null })

  if (isNativeApp) {
    await initNativeOfflineStorage().catch(() => undefined)
    ensureProgressListener()
  }

  await refreshDownloads()
  resumeDownloads()
}

/* ---------------------------------------------------------- starting -- */

const clearRetryTimer = (key: string) => {
  const timer = retryTimers.get(key)

  if (timer) {
    clearTimeout(timer)
    retryTimers.delete(key)
  }
}

const concurrencyFor = (resources: OfflineDownloadResource[]) => {
  if (!isNativeApp) {
    return 4
  }

  // Page images are small, so more parallel requests hide the latency of the
  // server → NAS round trip. Whole files are few and large.
  return resources.some((resource) => resource.kind === 'cbz-page') ? 6 : 3
}

const fetchResourceOnce = async (
  downloadId: string,
  ownerUserId: string,
  resource: OfflineDownloadResource,
  signal: AbortSignal,
): Promise<OfflineStoredResource> => {
  if (isNativeApp) {
    const headers = await getAuthHeaders()
    return downloadOfflineResourceNative(downloadId, resource, headers)
  }

  const response = await api.fetchResource(resource.url, signal)
  const blob = await response.blob()

  if (resource.size > 0 && blob.size !== resource.size) {
    throw new OfflineResourceIntegrityError(resource.label)
  }

  const stored = await putOfflineResource(downloadId, ownerUserId, resource, blob)
  return { resource: stored, size: blob.size }
}

export const startDownload = async (
  target: OfflineDownloadTarget,
  options: { autoResume?: boolean } = {},
) => {
  const userId = downloadsStore.get().userId
  const strings = currentStrings()

  if (!userId || deleteAllInProgress) {
    return
  }

  if (isOffline()) {
    if (!options.autoResume) {
      notify(strings.connection.offline, 'error')
    }
    return
  }

  const key = targetKey(target)

  if (running.has(key)) {
    return
  }

  if (options.autoResume) {
    autoResumeGuard.add(key)
  } else {
    autoResumeGuard.delete(key)
  }

  clearRetryTimer(key)
  running.add(key)
  const controller = new AbortController()
  controllers.set(key, controller)
  let finishRun: () => void = () => undefined
  completions.set(key, new Promise<void>((resolve) => {
    finishRun = resolve
  }))

  let record: OfflineDownloadRecord | null =
    downloadsStore.get().records.find((item) => targetKey(item.manifest.target) === key) ?? null
  let started = record?.status !== 'ready'
  setActivity(key, { phase: 'preparing', done: 0, total: 0, bytes: 0, totalBytes: 0 }, true)

  try {
    if (isNativeApp) {
      await initNativeOfflineStorage()
    }

    await requestOfflineStoragePersistence().catch(() => null)
    const manifest = await api.createOfflineManifest(target, controller.signal)
    deletedIds.delete(manifest.manifestId)

    const storedRecord = await getOfflineDownload(manifest.manifestId)
    const candidates = [
      ...new Map(
        [...downloadsStore.get().records, ...(storedRecord ? [storedRecord] : [])]
          .filter((item) => item.ownerUserId === userId && isOfflineDownloadCandidateForTarget(item, target))
          .map((item) => [item.id, item] as const),
      ).values(),
    ]
    const existingRecord = candidates.find((item) => item.id === manifest.manifestId) ?? null
    const replacements = candidates.filter((item) => item.id !== manifest.manifestId)

    if (existingRecord) {
      record = existingRecord
    } else {
      record = createOfflineDownloadRecord(manifest)
      started = true
      await saveRecord(record, true)

      if (!options.autoResume) {
        notify(strings.downloads.started(manifest.title))
      }
    }

    // Reuse files that older downloads of the same title already stored.
    const storedResources = await getOfflineResourceInventory(manifest.manifestId)
    const previousPackages = await Promise.all(
      replacements.map(async (item) => ({
        downloadId: item.id,
        resources: await getOfflineResourceInventory(item.id),
      })),
    )
    const reusable = planReusableOfflineResources(manifest, previousPackages, storedResources)

    if (reusable.length) {
      const bySource = new Map<string, typeof reusable>()
      reusable.forEach((transfer) => {
        bySource.set(transfer.sourceDownloadId, [...(bySource.get(transfer.sourceDownloadId) ?? []), transfer])
      })

      let reused = 0

      for (const [sourceId, transfers] of bySource) {
        if (controller.signal.aborted) {
          throw new OfflineDownloadCancelledError()
        }

        const copied = await copyOfflineResources(
          sourceId,
          manifest.manifestId,
          userId,
          transfers.map((transfer) => transfer.resource),
        ).catch(() => [] as OfflineStoredResource[])

        storedResources.push(...copied)
        reused += copied.length
        setActivity(key, { phase: 'reusing', done: reused, total: reusable.length, bytes: 0, totalBytes: 0 })
      }
    }

    const merged = mergeOfflineManifestWithStoredResources(manifest, storedResources)
    // The stored manifest keeps server addresses; local copies are found by key.
    record = mergeOfflineDownloadRecord(
      manifest,
      existingRecord ?? (record?.id === manifest.manifestId ? record : null),
      merged.completedResources,
      manifest,
      createOfflineDownloadRecord,
    )
    started = true
    await saveRecord(record, true)

    const storedByKey = new Map(storedResources.map((stored) => [stored.resource.key, stored]))
    const pendingResources = manifest.resources.filter(
      (resource) => !isOfflineResourceComplete(resource, storedByKey.get(resource.key)),
    )
    let progress: OfflineDownloadRecord = record
    let lastCheckpoint = Date.now()
    let checkpoint: Promise<void> | null = null
    const inFlightBytes = new Map<string, number>()

    const publishActivity = () => {
      let partialBytes = 0
      inFlightBytes.forEach((bytes) => {
        partialBytes += bytes
      })
      setActivity(key, {
        phase: 'downloading',
        done: progress.downloadedResourceCount,
        total: progress.resourceCount,
        bytes: progress.downloadedBytes + partialBytes,
        totalBytes: manifest.estimatedBytes,
      })
    }

    const persistProgress = async (force = false): Promise<void> => {
      if (checkpoint) {
        if (force) {
          await checkpoint
          return persistProgress(true)
        }
        return
      }

      if (!force && Date.now() - lastCheckpoint < checkpointIntervalMs) {
        return
      }

      lastCheckpoint = Date.now()
      const snapshot = { ...progress, status: 'downloading' as const, retryAt: null, updatedAt: new Date().toISOString() }
      checkpoint = putOfflineDownload(snapshot).finally(() => {
        checkpoint = null
      })
      await checkpoint
    }

    const downloadOne = async (resource: OfflineDownloadResource) => {
      if (controller.signal.aborted) {
        throw new OfflineDownloadCancelledError()
      }

      let attempt = 0
      let stored: OfflineStoredResource | null = null

      if (isNativeApp && resource.kind === 'file') {
        inFlightBytes.set(resource.url, 0)
        liveTransfers.set(resource.url, {
          onBytes: (bytes) => {
            inFlightBytes.set(resource.url, bytes)
            publishActivity()
          },
        })
      }

      try {
        while (!stored) {
          try {
            stored = await fetchResourceOnce(progress.id, progress.ownerUserId, resource, controller.signal)
          } catch (error) {
            if (controller.signal.aborted) {
              throw new OfflineDownloadCancelledError()
            }

            if (!isRetryableOfflineDownloadError(error) || attempt >= 3) {
              throw error
            }

            attempt += 1
            await waitForOfflineRetry(offlineRetryDelay(attempt), controller.signal)
          }
        }
      } finally {
        liveTransfers.delete(resource.url)
        inFlightBytes.delete(resource.url)
      }

      if (controller.signal.aborted) {
        throw new OfflineDownloadCancelledError()
      }

      storedByKey.set(resource.key, stored)
      progress = {
        ...progress,
        status: 'downloading',
        retryAt: null,
        downloadedBytes: progress.downloadedBytes + stored.size,
        verifiedBytes: progress.verifiedBytes + (resource.size || stored.size),
        downloadedResourceCount: progress.downloadedResourceCount + 1,
        updatedAt: new Date().toISOString(),
      }
      record = progress
      showRecord(progress)
      publishActivity()
      await persistProgress()
    }

    publishActivity()

    try {
      await runOfflineDownloadQueue(pendingResources, concurrencyFor(pendingResources), downloadOne)
    } catch (error) {
      await persistProgress(true).catch(() => undefined)
      throw error
    }

    record = {
      ...progress,
      status: 'ready',
      completedAt: new Date().toISOString(),
      failureReason: null,
      retryAt: null,
      updatedAt: new Date().toISOString(),
    }
    await saveRecord(record, true)
    await Promise.all(
      replacements
        .filter((item) => item.id !== record?.id)
        .map((item) => deleteOfflineDownload(item.id).catch(() => undefined)),
    )
    autoResumeGuard.delete(key)

    if (!options.autoResume || pendingResources.length > 0) {
      notify(strings.downloads.finished(manifest.title))
    }
  } catch (error) {
    const cancelled = error instanceof OfflineDownloadCancelledError || controller.signal.aborted
    const retryable = isRetryableOfflineDownloadError(error)
    const message = error instanceof Error ? error.message : strings.common.somethingWentWrong
    autoResumeGuard.add(key)

    if (started && record && !deletedIds.has(record.id)) {
      record = {
        ...record,
        status: cancelled
          ? 'paused'
          : /stale/i.test(message)
            ? 'stale'
            : retryable
              ? 'queued'
              : record.downloadedResourceCount > 0
                ? 'partial'
                : 'failed',
        failureReason: cancelled ? null : message,
        retryAt: retryable && !cancelled ? new Date(Date.now() + autoRetryDelayMs).toISOString() : null,
        completedAt: null,
        updatedAt: new Date().toISOString(),
      }
      await saveRecord(record, true).catch(() => undefined)
    }

    if (!options.autoResume && !cancelled && !retryable) {
      notify(message, 'error')
    }
  } finally {
    running.delete(key)
    controllers.delete(key)
    completions.delete(key)
    finishRun()
    setActivity(key, null, true)
    void refreshDownloads().then(resumeDownloads)
  }
}

/* ------------------------------------------------------------ resume -- */

/** Restarts interrupted downloads and schedules retries that are due later. */
export const resumeDownloads = () => {
  const { userId, loaded, records } = downloadsStore.get()

  if (!userId || !loaded || isOffline() || deleteAllInProgress) {
    return
  }

  const now = Date.now()

  records.forEach((record) => {
    const key = targetKey(record.manifest.target)

    if (!['queued', 'downloading', 'partial'].includes(record.status) || running.has(key)) {
      return
    }

    const retryAt = record.retryAt ? Date.parse(record.retryAt) : now

    if (retryAt > now) {
      if (!retryTimers.has(key)) {
        retryTimers.set(key, setTimeout(() => {
          retryTimers.delete(key)
          resumeDownloads()
        }, retryAt - now))
      }
      return
    }

    const scheduledRetry = record.status === 'queued' && Boolean(record.retryAt)

    if (autoResumeGuard.has(key) && !scheduledRetry) {
      return
    }

    void startDownload(record.manifest.target, { autoResume: true })
  })
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => resumeDownloads())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resumeDownloads()
    }
  })
}

/* ---------------------------------------------------- pause & remove -- */

export const pauseDownload = async (record: OfflineDownloadRecord) => {
  if (deleteAllInProgress) {
    return
  }

  const key = targetKey(record.manifest.target)
  autoResumeGuard.add(key)
  clearRetryTimer(key)
  controllers.get(key)?.abort()

  if (!running.has(key)) {
    await saveRecord({
      ...record,
      status: 'paused',
      failureReason: null,
      retryAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
    }, true).catch(() => undefined)
  }
}

export const removeDownload = async (downloadId: string) => {
  if (deleteAllInProgress) {
    return
  }

  const record = downloadsStore.get().records.find((item) => item.id === downloadId)
  let completion: Promise<void> | undefined

  if (record) {
    const key = targetKey(record.manifest.target)
    autoResumeGuard.add(key)
    clearRetryTimer(key)
    controllers.get(key)?.abort()
    completion = completions.get(key)
  }

  deletedIds.add(downloadId)
  pendingRecordUpdates.delete(downloadId)
  setActivity(downloadId, { phase: 'removing', done: 0, total: 0, bytes: 0, totalBytes: 0 }, true)
  downloadsStore.set((previous) => ({
    ...previous,
    records: previous.records.filter((item) => item.id !== downloadId),
  }))

  try {
    await completion
    await deleteOfflineDownload(downloadId)
  } catch (error) {
    notify(error instanceof Error ? error.message : currentStrings().common.somethingWentWrong, 'error')
  } finally {
    setActivity(downloadId, null, true)
    await refreshDownloads()
  }
}

export const removeAllDownloads = async () => {
  const userId = downloadsStore.get().userId

  if (!userId || deleteAllInProgress) {
    return
  }

  deleteAllInProgress = true
  const waits = [...completions.values()]
  downloadsStore.get().records.forEach((record) => {
    const key = targetKey(record.manifest.target)
    autoResumeGuard.add(key)
    deletedIds.add(record.id)
    clearRetryTimer(key)
  })
  stopAll()
  setActivity('all', { phase: 'removing', done: 0, total: 0, bytes: 0, totalBytes: 0 }, true)

  try {
    await Promise.all(waits)
    await deleteAllOfflineDownloadsForUser(userId)
  } catch (error) {
    notify(error instanceof Error ? error.message : currentStrings().common.somethingWentWrong, 'error')
  } finally {
    deleteAllInProgress = false
    setActivity('all', null, true)
    await refreshDownloads()
  }
}

export const requestPersistence = async () => {
  await requestOfflineStoragePersistence().catch(() => null)
  await refreshDownloads()
}

/** Stops all work before the user signs out. */
export const stopDownloadsForSignOut = async () => {
  const waits = [...completions.values()]
  stopAll()
  await Promise.all(waits).catch(() => undefined)
  await setDownloadsUser(null)
}

/* --------------------------------------------------------------- hooks -- */

const selectRecords = (state: DownloadsState) => state.records
const selectActivity = (state: DownloadsState) => state.activity
const selectLoaded = (state: DownloadsState) => state.loaded
const selectSummary = (state: DownloadsState) => state.summary

export const useDownloadRecords = () => useStore(downloadsStore, selectRecords)
export const useDownloadActivity = () => useStore(downloadsStore, selectActivity)
export const useDownloadsLoaded = () => useStore(downloadsStore, selectLoaded)
export const useStorageSummary = () => useStore(downloadsStore, selectSummary)

export const useTargetActivity = (target: OfflineDownloadTarget | null) =>
  useStore(downloadsStore, (state) => (target ? state.activity[targetKey(target)] ?? null : null))
