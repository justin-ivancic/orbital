import type {
  OfflineDownloadManifest,
  OfflineDownloadRecord,
  OfflineDownloadResource,
  OfflineDownloadTarget,
  SeriesDetail,
  SeriesSummary,
} from './appTypes'
import type { OfflineStoredResource } from './offlineStorage'

export type OfflineStoredResourcePackage = {
  downloadId: string
  resources: OfflineStoredResource[]
}

export type OfflineResourceTransfer = {
  sourceDownloadId: string
  resource: OfflineDownloadResource
  stored: OfflineStoredResource
}

export type OfflineSeriesAvailability = 'complete' | 'partial'

export const getOfflineSeriesAvailability = (
  downloadedEntryIds: Set<string> | undefined,
  currentEntryCount: number,
): OfflineSeriesAvailability | undefined => {
  const downloadedEntryCount = downloadedEntryIds?.size ?? 0

  if (!downloadedEntryCount) {
    return undefined
  }

  return downloadedEntryCount >= currentEntryCount ? 'complete' : 'partial'
}

export const getOfflineSeriesCoverage = (
  records: OfflineDownloadRecord[],
) => {
  const entryIdsBySeriesId = new Map<string, Set<string>>()

  records.forEach((record) => {
    if (record.status !== 'ready') {
      return
    }

    const seriesIds = new Set(
      record.manifest.resources
        .map((resource) => resource.seriesId)
        .filter((seriesId): seriesId is string => Boolean(seriesId)),
    )

    if (record.manifest.target.type === 'series') {
      seriesIds.add(record.manifest.target.seriesId)
    }

    seriesIds.forEach((seriesId) => {
      const downloadedEntryIds = entryIdsBySeriesId.get(seriesId) ?? new Set<string>()
      record.manifest.entries.forEach((entry) => downloadedEntryIds.add(entry.entryId))
      entryIdsBySeriesId.set(seriesId, downloadedEntryIds)
    })
  })

  return entryIdsBySeriesId
}

export const isOfflineDownloadCandidateForTarget = (
  record: OfflineDownloadRecord,
  target: OfflineDownloadTarget,
) => {
  if (target.type === 'entry') {
    return (
      record.manifest.target.type === 'entry' &&
      record.manifest.target.entryId === target.entryId
    )
  }

  return (
    (record.manifest.target.type === 'series' && record.manifest.target.seriesId === target.seriesId) ||
    record.manifest.resources.some((resource) => resource.seriesId === target.seriesId)
  )
}

/**
 * Keeps the last-known catalogue visible while replacing only media URLs that
 * have a verified local copy. A single-entry download must not replace the
 * richer cached series metadata with the small offline manifest.
 */
export const mergeOfflineLibrary = (
  cachedLibrary: SeriesSummary[],
  offlineLibrary: SeriesDetail[],
): SeriesSummary[] => {
  const mergedById = new Map(cachedLibrary.map((series) => [series.id, series]))

  offlineLibrary.forEach((offlineSeries) => {
    const cachedSeries = mergedById.get(offlineSeries.id)

    mergedById.set(
      offlineSeries.id,
      cachedSeries
        ? {
            ...cachedSeries,
            coverUrl: offlineSeries.coverUrl ?? cachedSeries.coverUrl,
            bannerUrl: offlineSeries.bannerUrl ?? cachedSeries.bannerUrl,
          }
        : offlineSeries,
    )
  })

  return [...mergedById.values()]
}

export class OfflineDownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled.')
    this.name = 'OfflineDownloadCancelledError'
  }
}

export class OfflineResourceIntegrityError extends Error {
  constructor(label: string) {
    super(`Downloaded size mismatch for ${label}.`)
    this.name = 'OfflineResourceIntegrityError'
  }
}

export const isOfflineResourceComplete = (
  resource: OfflineDownloadResource,
  stored: OfflineStoredResource | undefined,
) => Boolean(
  stored &&
  stored.resource.key === resource.key &&
  stored.resource.kind === resource.kind &&
  stored.resource.version === resource.version &&
  (resource.size <= 0 || stored.size === resource.size),
)

export const mergeOfflineManifestWithStoredResources = (
  manifest: OfflineDownloadManifest,
  storedResources: OfflineStoredResource[],
) => {
  const storedByKey = new Map(storedResources.map((stored) => [stored.resource.key, stored]))

  return {
    manifest: {
      ...manifest,
      resources: manifest.resources.map((resource) => {
        const stored = storedByKey.get(resource.key)

        if (!stored || !isOfflineResourceComplete(resource, stored)) {
          return resource
        }

        return { ...resource, url: stored.resource.url }
      }),
    },
    completedResources: manifest.resources.filter((resource) => (
      isOfflineResourceComplete(resource, storedByKey.get(resource.key))
    )),
  }
}

export const planReusableOfflineResources = (
  manifest: OfflineDownloadManifest,
  packages: OfflineStoredResourcePackage[],
  existingResources: OfflineStoredResource[] = [],
): OfflineResourceTransfer[] => {
  const manifestResourcesByKey = new Map(
    manifest.resources.map((resource) => [resource.key, resource]),
  )
  const reservedKeys = new Set(
    existingResources
      .filter((stored) => {
        const resource = manifestResourcesByKey.get(stored.resource.key)
        return resource && isOfflineResourceComplete(resource, stored)
      })
      .map((stored) => stored.resource.key),
  )
  const transfers: OfflineResourceTransfer[] = []

  for (const offlinePackage of packages) {
    for (const stored of offlinePackage.resources) {
      const resource = manifestResourcesByKey.get(stored.resource.key)

      if (
        !resource ||
        reservedKeys.has(resource.key) ||
        !isOfflineResourceComplete(resource, stored)
      ) {
        continue
      }

      reservedKeys.add(resource.key)
      transfers.push({
        sourceDownloadId: offlinePackage.downloadId,
        resource,
        stored,
      })
    }
  }

  return transfers
}

export const progressForOfflineResources = (
  resources: OfflineDownloadResource[],
  completedResources: OfflineDownloadResource[],
) => {
  const completedKeys = new Set(completedResources.map((resource) => resource.key))

  return resources.reduce(
    (progress, resource) => {
      if (!completedKeys.has(resource.key)) {
        return progress
      }

      return {
        downloadedBytes: progress.downloadedBytes + Math.max(0, resource.size),
        verifiedBytes: progress.verifiedBytes + Math.max(0, resource.size),
        downloadedResourceCount: progress.downloadedResourceCount + 1,
      }
    },
    {
      downloadedBytes: 0,
      verifiedBytes: 0,
      downloadedResourceCount: 0,
    },
  )
}

export const mergeOfflineDownloadRecord = (
  manifest: OfflineDownloadManifest,
  existingRecord: OfflineDownloadRecord | null,
  completedResources: OfflineDownloadResource[],
  mergedManifest: OfflineDownloadManifest,
  createRecord: (nextManifest: OfflineDownloadManifest) => OfflineDownloadRecord,
) => {
  const progress = progressForOfflineResources(manifest.resources, completedResources)
  const record = existingRecord && existingRecord.manifest.contentKey === manifest.contentKey
    ? existingRecord
    : createRecord(mergedManifest)

  return {
    ...record,
    manifest: mergedManifest,
    ownerUserId: manifest.ownerUserId,
    ownerUsername: manifest.ownerUsername,
    status: 'downloading' as const,
    completedAt: null,
    downloadedBytes: progress.downloadedBytes,
    verifiedBytes: progress.verifiedBytes,
    resourceCount: manifest.resourceCount,
    downloadedResourceCount: progress.downloadedResourceCount,
    failureReason: null,
    retryAt: null,
    updatedAt: new Date().toISOString(),
  }
}

export const isRetryableOfflineDownloadError = (error: unknown) => {
  if (error instanceof OfflineDownloadCancelledError) {
    return false
  }

  if (error instanceof OfflineResourceIntegrityError) {
    return true
  }

  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : null

  if (status == null || Number.isNaN(status)) {
    return error instanceof TypeError
  }

  return status === 408 || status === 425 || status === 429 || status >= 500
}

export const waitForOfflineRetry = async (
  delayMs: number,
  signal: AbortSignal,
) => {
  if (signal.aborted) {
    throw new OfflineDownloadCancelledError()
  }

  await new Promise<void>((resolve, reject) => {
    let timeout = 0
    function cleanup() {
      signal.removeEventListener('abort', handleAbort)
    }

    function handleAbort() {
      window.clearTimeout(timeout)
      cleanup()
      reject(new OfflineDownloadCancelledError())
    }

    const finish = () => {
      cleanup()
      resolve()
    }

    timeout = window.setTimeout(finish, delayMs)
    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

export const offlineRetryDelay = (attempt: number) =>
  Math.min(8000, 1000 * (2 ** Math.max(0, attempt - 1)))

export const runOfflineDownloadQueue = async <T,>(
  items: readonly T[],
  concurrency: number,
  processItem: (item: T) => Promise<void>,
) => {
  if (!items.length) {
    return
  }

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length))
  let nextIndex = 0
  let failed = false
  let firstError: unknown

  const runWorker = async () => {
    while (!failed) {
      const itemIndex = nextIndex
      nextIndex += 1

      if (itemIndex >= items.length) {
        return
      }

      try {
        await processItem(items[itemIndex])
      } catch (error) {
        failed = true
        firstError = error
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

  if (failed) {
    throw firstError
  }
}
