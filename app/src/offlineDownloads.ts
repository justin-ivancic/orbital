import type {
  OfflineDownloadManifest,
  OfflineDownloadRecord,
  OfflineDownloadResource,
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
