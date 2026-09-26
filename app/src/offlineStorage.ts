import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import type {
  Bookmark,
  OfflineDownloadManifest,
  OfflineDownloadRecord,
  OfflineDownloadResource,
  OfflineStorageSummary,
  SavedReadingPosition,
  SessionUser,
} from './appTypes'
import { getOfflineResourceStorageKey } from './offlineStorageKeys'
import { isNativeApp, toNativeFileUrl } from './platform'
import { OfflineResourceIntegrityError } from './offlineDownloads'

const offlineDbName = 'orbital-offline-v1'
const offlineDbVersion = 3
const downloadsStoreName = 'downloads'
const resourcesStoreName = 'resources'
const readingStateStoreName = 'readingState'
const nativeDownloadsPath = 'orbital/downloads'
const nativeStorageEnabled = isNativeApp && Capacitor.isNativePlatform()

type OfflineResourceRecord = {
  storageKey: string
  key: string
  downloadId: string
  ownerUserId: string
  resource: OfflineDownloadResource
  blob: Blob
  size: number
  storedAt: string
}

export type OfflineStoredResource = {
  resource: OfflineDownloadResource
  size: number
}

export type OfflineReadingState = {
  ownerUserId: string
  bookmarks: Bookmark[]
  readingPositions: Record<string, SavedReadingPosition>
  updatedAt: string
}

const nativeDownloadPath = (downloadId: string) =>
  `${nativeDownloadsPath}/${encodeURIComponent(downloadId)}`

const nativeRecordPath = (downloadId: string) =>
  `${nativeDownloadPath(downloadId)}/record.json`

const nativeManifestPath = (downloadId: string) =>
  `${nativeDownloadPath(downloadId)}/manifest.json`

const nativeResourceFileName = (resourceKey: string) => `${encodeURIComponent(resourceKey)}.bin`

let nativeDownloadsBaseUri: string | null = null

/**
 * Resolves the on-device downloads folder once, so resource URLs can be built
 * without one bridge call per file.
 */
export const initNativeOfflineStorage = async () => {
  if (!nativeStorageEnabled || nativeDownloadsBaseUri) {
    return
  }

  await Filesystem.mkdir({ path: nativeDownloadsPath, directory: Directory.Data, recursive: true })
    .catch(() => undefined)
  const result = await Filesystem.getUri({ path: nativeDownloadsPath, directory: Directory.Data })
  nativeDownloadsBaseUri = result.uri.replace(/\/+$/, '')
}

/** The WebView URL of a downloaded resource (native app only). */
export const nativeResourceUrl = (downloadId: string, resourceKey: string) => {
  if (!nativeDownloadsBaseUri) {
    return null
  }

  // File names on disk are already URI-encoded, so each segment is encoded again for the URL.
  const segments = [encodeURIComponent(downloadId), 'resources', nativeResourceFileName(resourceKey)]
  return toNativeFileUrl(`${nativeDownloadsBaseUri}/${segments.map(encodeURIComponent).join('/')}`)
}

const nativeResourcePath = (downloadId: string, resourceKey: string) =>
  `${nativeDownloadPath(downloadId)}/resources/${encodeURIComponent(resourceKey)}.bin`

const nativeReadingStatePath = (ownerUserId: string) =>
  `orbital/reading/${encodeURIComponent(ownerUserId)}.json`

const commitNativeResourceFile = async (path: string, temporaryPath: string) => {
  const previousPath = `${path}.previous`

  await Filesystem.deleteFile({
    path: previousPath,
    directory: Directory.Data,
  }).catch(() => undefined)

  let previousFileMoved = false

  try {
    await Filesystem.rename({
      from: path,
      to: previousPath,
      directory: Directory.Data,
    })
    previousFileMoved = true
  } catch {
    // There may not be an existing resource on the first attempt.
  }

  try {
    await Filesystem.rename({
      from: temporaryPath,
      to: path,
      directory: Directory.Data,
    })
  } catch (error) {
    if (previousFileMoved) {
      await Filesystem.rename({
        from: previousPath,
        to: path,
        directory: Directory.Data,
      }).catch(() => undefined)
    }
    throw error
  }

  await Filesystem.deleteFile({
    path: previousPath,
    directory: Directory.Data,
  }).catch(() => undefined)
}

const readNativeJson = async <T,>(path: string): Promise<T | null> => {
  try {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    })

    return JSON.parse(String(result.data)) as T
  } catch {
    return null
  }
}

const writeNativeJson = async (path: string, value: unknown) => {
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: JSON.stringify(value),
    encoding: Encoding.UTF8,
    recursive: true,
  })
}

const blobToBase64 = async (blob: Blob) => {
  // Give pending touch and scroll work a chance to paint before the synchronous
  // base64 conversion needed by Capacitor's native Filesystem bridge.
  if (typeof window !== 'undefined') {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }

  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }

  return btoa(binary)
}

const listNativeDownloadIds = async () => {
  try {
    const result = await Filesystem.readdir({
      path: nativeDownloadsPath,
      directory: Directory.Data,
    })

    return result.files
      .filter((entry) => entry.type === 'directory' || entry.type == null)
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * On the device a download is stored as a small, frequently rewritten
 * `record.json` (status and counters) plus a `manifest.json` that is written
 * once. Older builds kept the manifest inside the record; both are read.
 */
type NativeRecordHeader = Omit<OfflineDownloadRecord, 'manifest'> & {
  manifest?: OfflineDownloadManifest
}

const nativeManifestCache = new Map<string, OfflineDownloadManifest>()

const readNativeManifest = async (downloadId: string) => {
  const cached = nativeManifestCache.get(downloadId)

  if (cached) {
    return cached
  }

  const manifest = await readNativeJson<OfflineDownloadManifest>(nativeManifestPath(downloadId))

  if (manifest) {
    nativeManifestCache.set(downloadId, manifest)
  }

  return manifest
}

const readNativeRecordHeader = (downloadId: string) =>
  readNativeJson<NativeRecordHeader>(nativeRecordPath(downloadId))

const readNativeRecord = async (downloadId: string): Promise<OfflineDownloadRecord | null> => {
  const header = await readNativeRecordHeader(downloadId)

  if (!header) {
    return null
  }

  if (header.manifest) {
    nativeManifestCache.set(downloadId, header.manifest)
    return header as OfflineDownloadRecord
  }

  const manifest = await readNativeManifest(downloadId)
  return manifest ? { ...header, manifest } : null
}

const readAllNativeRecordHeaders = async () => {
  const ids = await listNativeDownloadIds()
  const headers = await Promise.all(ids.map((encodedId) =>
    readNativeRecordHeader(decodeURIComponent(encodedId)).catch(() => null),
  ))

  return headers.filter((header): header is NativeRecordHeader => Boolean(header))
}

const readAllNativeRecords = async () => {
  const ids = await listNativeDownloadIds()
  const records = await Promise.all(ids.map((encodedId) =>
    readNativeRecord(decodeURIComponent(encodedId)).catch(() => null),
  ))

  return records.filter((record): record is OfflineDownloadRecord => Boolean(record))
}

const writeNativeRecord = async (record: OfflineDownloadRecord) => {
  if (nativeManifestCache.get(record.id) !== record.manifest) {
    await writeNativeJson(nativeManifestPath(record.id), record.manifest)
    nativeManifestCache.set(record.id, record.manifest)
  }

  const { manifest: _manifest, ...header } = record
  void _manifest
  await writeNativeJson(nativeRecordPath(record.id), header)
}

const canUseIndexedDb = () => typeof indexedDB !== 'undefined'

const toPromise = <T,>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'))
  })

const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'))
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'))
  })

const createResourcesStore = (db: IDBDatabase) => {
  const resources = db.createObjectStore(resourcesStoreName, { keyPath: 'storageKey' })
  resources.createIndex('downloadId', 'downloadId', { unique: false })
  resources.createIndex('ownerUserId', 'ownerUserId', { unique: false })
  resources.createIndex('resourceKey', 'key', { unique: false })
  return resources
}

const openOfflineDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error('Offline storage is not available in this browser.'))
      return
    }

    const request = indexedDB.open(offlineDbName, offlineDbVersion)

    request.onupgradeneeded = (event) => {
      const db = request.result
      const upgradeTransaction = request.transaction

      if (!db.objectStoreNames.contains(downloadsStoreName)) {
        const downloads = db.createObjectStore(downloadsStoreName, { keyPath: 'id' })
        downloads.createIndex('ownerUserId', 'ownerUserId', { unique: false })
        downloads.createIndex('updatedAt', 'updatedAt', { unique: false })
      }

      if (!db.objectStoreNames.contains(resourcesStoreName)) {
        createResourcesStore(db)
      } else if (event.oldVersion < 3 && upgradeTransaction) {
        const previousResources = upgradeTransaction.objectStore(resourcesStoreName)
        const migration = previousResources.getAll()

        migration.onsuccess = () => {
          const previousRecords = migration.result as Array<OfflineResourceRecord & { storageKey?: string }>
          db.deleteObjectStore(resourcesStoreName)
          const resources = createResourcesStore(db)

          previousRecords.forEach((record) => {
            resources.put({
              ...record,
              storageKey: getOfflineResourceStorageKey(record.downloadId, record.key),
            })
          })
        }
      }

      if (!db.objectStoreNames.contains(readingStateStoreName)) {
        db.createObjectStore(readingStateStoreName, { keyPath: 'ownerUserId' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open offline storage.'))
  })

const readAllFromIndex = async <T,>(
  db: IDBDatabase,
  storeName: string,
  indexName: string,
  key: IDBValidKey,
) => {
  const transaction = db.transaction(storeName, 'readonly')
  const done = transactionDone(transaction)
  const store = transaction.objectStore(storeName)
  const index = store.index(indexName)
  const results: T[] = []

  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(key))

    request.onsuccess = () => {
      const cursor = request.result

      if (!cursor) {
        resolve()
        return
      }

      results.push(cursor.value as T)
      cursor.continue()
    }

    request.onerror = () => reject(request.error || new Error('Could not read offline storage.'))
  })

  await done
  return results
}

const readAllFromStore = async <T,>(db: IDBDatabase, storeName: string) => {
  const transaction = db.transaction(storeName, 'readonly')
  const done = transactionDone(transaction)
  const store = transaction.objectStore(storeName)
  const results: T[] = []

  await new Promise<void>((resolve, reject) => {
    const request = store.openCursor()

    request.onsuccess = () => {
      const cursor = request.result

      if (!cursor) {
        resolve()
        return
      }

      results.push(cursor.value as T)
      cursor.continue()
    }

    request.onerror = () => reject(request.error || new Error('Could not read offline storage.'))
  })

  await done
  return results
}

export const createOfflineDownloadRecord = (
  manifest: OfflineDownloadManifest,
): OfflineDownloadRecord => ({
  id: manifest.manifestId,
  manifest,
  ownerUserId: manifest.ownerUserId,
  ownerUsername: manifest.ownerUsername,
  status: 'queued',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: null,
  downloadedBytes: 0,
  verifiedBytes: 0,
  resourceCount: manifest.resourceCount,
  downloadedResourceCount: 0,
  failureReason: null,
  retryAt: null,
})

export const putOfflineDownload = async (record: OfflineDownloadRecord) => {
  const nextRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
  }

  if (nativeStorageEnabled) {
    await writeNativeRecord(nextRecord)
    return
  }

  const db = await openOfflineDb()

  try {
    const transaction = db.transaction(downloadsStoreName, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(downloadsStoreName).put(nextRecord)
    await done
  } finally {
    db.close()
  }
}

export const getOfflineDownload = async (downloadId: string) => {
  if (nativeStorageEnabled) {
    return readNativeRecord(downloadId)
  }

  const db = await openOfflineDb()

  try {
    const transaction = db.transaction(downloadsStoreName, 'readonly')
    const done = transactionDone(transaction)
    const record = await toPromise<OfflineDownloadRecord | undefined>(
      transaction.objectStore(downloadsStoreName).get(downloadId),
    )
    await done
    return record ?? null
  } finally {
    db.close()
  }
}

export const getOfflineResourceInventory = async (
  downloadId: string,
): Promise<OfflineStoredResource[]> => {
  if (nativeStorageEnabled) {
    const record = await readNativeRecord(downloadId)

    if (!record) {
      return []
    }

    await initNativeOfflineStorage()
    const resourcesByFileName = new Map(
      record.manifest.resources.map((resource) => [nativeResourceFileName(resource.key), resource]),
    )

    try {
      const result = await Filesystem.readdir({
        path: `${nativeDownloadPath(downloadId)}/resources`,
        directory: Directory.Data,
      })
      const filesByName = new Map(result.files.map((file) => [file.name, file]))
      const storedResources: OfflineStoredResource[] = []

      for (const [fileName, resource] of resourcesByFileName) {
        let file = filesByName.get(fileName)

        if (!file || file.type !== 'file') {
          const previousFileName = `${fileName}.previous`
          const previousFile = filesByName.get(previousFileName)

          if (previousFile?.type === 'file') {
            try {
              await Filesystem.rename({
                from: `${nativeDownloadPath(downloadId)}/resources/${previousFileName}`,
                to: `${nativeDownloadPath(downloadId)}/resources/${fileName}`,
                directory: Directory.Data,
              })
              file = previousFile
            } catch {
              // A failed restore must be repaired as a fresh resource.
            }
          }
        }

        const url = nativeResourceUrl(downloadId, resource.key)

        if (!file || file.type !== 'file' || !url) {
          continue
        }

        storedResources.push({
          resource: { ...resource, url },
          size: Number.isFinite(file.size) ? file.size : 0,
        })
      }

      return storedResources
    } catch {
      return []
    }
  }

  const db = await openOfflineDb()

  try {
    const records = await readAllFromIndex<OfflineResourceRecord>(
      db,
      resourcesStoreName,
      'downloadId',
      downloadId,
    )

    return records.map((record) => ({
      resource: record.resource,
      size: record.size,
    }))
  } finally {
    db.close()
  }
}

export const listOfflineDownloads = async (ownerUserId: string) => {
  if (nativeStorageEnabled) {
    const records = await readAllNativeRecords()

    return records
      .filter((record) => record.ownerUserId === ownerUserId)
      .sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      )
  }

  const db = await openOfflineDb()

  try {
    const records = await readAllFromIndex<OfflineDownloadRecord>(
      db,
      downloadsStoreName,
      'ownerUserId',
      ownerUserId,
    )

    return records.sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )
  } finally {
    db.close()
  }
}

export const getLastOfflineProfile = async (): Promise<SessionUser | null> => {
  if (nativeStorageEnabled) {
    const records = await readAllNativeRecordHeaders()
    const latest = records
      .filter((record) => record.ownerUserId && record.ownerUsername)
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0]

    return latest
      ? {
          id: latest.ownerUserId,
          username: latest.ownerUsername,
          role: 'member',
        }
      : null
  }

  const db = await openOfflineDb()

  try {
    const records = await readAllFromStore<OfflineDownloadRecord>(db, downloadsStoreName)
    const latest = records
      .filter((record) => record.ownerUserId && record.ownerUsername)
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0]

    return latest
      ? {
          id: latest.ownerUserId,
          username: latest.ownerUsername,
          role: 'member',
        }
      : null
  } finally {
    db.close()
  }
}

const emptyOfflineReadingState = (ownerUserId: string): OfflineReadingState => ({
  ownerUserId,
  bookmarks: [],
  readingPositions: {},
  updatedAt: new Date(0).toISOString(),
})

export const getOfflineReadingState = async (ownerUserId: string): Promise<OfflineReadingState> => {
  if (nativeStorageEnabled) {
    return (
      (await readNativeJson<OfflineReadingState>(nativeReadingStatePath(ownerUserId))) ||
      emptyOfflineReadingState(ownerUserId)
    )
  }

  const db = await openOfflineDb()

  try {
    const transaction = db.transaction(readingStateStoreName, 'readonly')
    const done = transactionDone(transaction)
    const state = await toPromise<OfflineReadingState | undefined>(
      transaction.objectStore(readingStateStoreName).get(ownerUserId),
    )
    await done
    return state || emptyOfflineReadingState(ownerUserId)
  } finally {
    db.close()
  }
}

export const putOfflineReadingState = async (state: OfflineReadingState) => {
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
  }

  if (nativeStorageEnabled) {
    await writeNativeJson(nativeReadingStatePath(state.ownerUserId), nextState)
    return nextState
  }

  const db = await openOfflineDb()

  try {
    const transaction = db.transaction(readingStateStoreName, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(readingStateStoreName).put(nextState)
    await done
    return nextState
  } finally {
    db.close()
  }
}

export const putOfflineResource = async (
  downloadId: string,
  ownerUserId: string,
  resource: OfflineDownloadResource,
  blob: Blob,
) => {
  if (nativeStorageEnabled) {
    const path = nativeResourcePath(downloadId, resource.key)
    const temporaryPath = `${path}.part`

    await Filesystem.deleteFile({
      path: temporaryPath,
      directory: Directory.Data,
    }).catch(() => undefined)

    await Filesystem.writeFile({
      path: temporaryPath,
      directory: Directory.Data,
      data: await blobToBase64(blob),
      recursive: true,
    })
    await commitNativeResourceFile(path, temporaryPath)
    await initNativeOfflineStorage()

    return {
      ...resource,
      url: nativeResourceUrl(downloadId, resource.key) ?? resource.url,
    }
  }

  const db = await openOfflineDb()
  const record: OfflineResourceRecord = {
    storageKey: getOfflineResourceStorageKey(downloadId, resource.key),
    key: resource.key,
    downloadId,
    ownerUserId,
    resource,
    blob,
    size: blob.size,
    storedAt: new Date().toISOString(),
  }

  try {
    const transaction = db.transaction(resourcesStoreName, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(resourcesStoreName).put(record)
    await done
  } finally {
    db.close()
  }

  return resource
}

export class NativeDownloadError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'NativeDownloadError'
    this.status = status
  }
}

/**
 * Android's HttpURLConnection reports HTTP 404/410 as a FileNotFoundException
 * whose message is just the URL, and other errors as "Server returned HTTP
 * response code: NNN". Connection problems (timeouts, DNS) carry no URL.
 */
const nativeErrorStatus = (message: string) => {
  const code = message.match(/response code:\s*(\d{3})/i)?.[1]

  if (code) {
    return Number(code)
  }

  return /https?:\/\/\S+/i.test(message) && !/time(?:d)? ?out|reset|refused|unreachable|resolve host|failed to connect/i.test(message)
    ? 404
    : null
}

const createdNativeDirectories = new Set<string>()

/** The native download writes straight to a file and does not create folders. */
const ensureNativeDirectory = async (path: string) => {
  if (createdNativeDirectories.has(path)) {
    return
  }

  await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true }).catch(() => undefined)
  createdNativeDirectories.add(path)
}

/**
 * Streams one resource straight to disk with the platform HTTP client. This
 * avoids copying every byte through JavaScript and the base64 bridge, which
 * made large downloads crawl on e-readers.
 */
export const downloadOfflineResourceNative = async (
  downloadId: string,
  resource: OfflineDownloadResource,
  headers: Record<string, string>,
): Promise<OfflineStoredResource> => {
  const path = nativeResourcePath(downloadId, resource.key)
  const temporaryPath = `${path}.part`

  await ensureNativeDirectory(`${nativeDownloadPath(downloadId)}/resources`)
  await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(() => undefined)

  try {
    await Filesystem.downloadFile({
      url: resource.url,
      path: temporaryPath,
      directory: Directory.Data,
      headers,
      recursive: true,
      progress: resource.kind === 'file',
      connectTimeout: 20_000,
      readTimeout: 60_000,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(() => undefined)
    throw new NativeDownloadError(message, nativeErrorStatus(message))
  }

  const stats = await Filesystem.stat({ path: temporaryPath, directory: Directory.Data })

  if (stats.type !== 'file' || stats.size <= 0 || (resource.size > 0 && stats.size !== resource.size)) {
    await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(() => undefined)
    throw new OfflineResourceIntegrityError(resource.label)
  }

  await commitNativeResourceFile(path, temporaryPath)
  await initNativeOfflineStorage()

  return {
    resource: { ...resource, url: nativeResourceUrl(downloadId, resource.key) ?? resource.url },
    size: stats.size,
  }
}

const isReusableOfflineResource = (
  source: OfflineResourceRecord | null,
  ownerUserId: string,
  resource: OfflineDownloadResource,
) => Boolean(
  source &&
  source.blob instanceof Blob &&
  source.ownerUserId === ownerUserId &&
  source.resource.kind === resource.kind &&
  source.resource.version === resource.version &&
  source.size === source.blob.size &&
  (resource.size <= 0 || source.size === resource.size),
)

const copyNativeOfflineResource = async (
  sourceDownloadId: string,
  sourceResource: OfflineDownloadResource,
  targetDownloadId: string,
  resource: OfflineDownloadResource,
): Promise<OfflineStoredResource | null> => {
  if (
    sourceResource.kind !== resource.kind ||
    sourceResource.version !== resource.version
  ) {
    return null
  }

  const sourcePath = nativeResourcePath(sourceDownloadId, resource.key)
  const targetPath = nativeResourcePath(targetDownloadId, resource.key)
  const temporaryPath = `${targetPath}.part`
  const sourceStats = await Filesystem.stat({ path: sourcePath, directory: Directory.Data })

  if (
    sourceStats.type !== 'file' ||
    sourceStats.size <= 0 ||
    (resource.size > 0 && sourceStats.size !== resource.size)
  ) {
    return null
  }

  await Filesystem.mkdir({
    path: `${nativeDownloadPath(targetDownloadId)}/resources`,
    directory: Directory.Data,
    recursive: true,
  })
  await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data })
    .catch(() => undefined)
  await Filesystem.copy({
    from: sourcePath,
    to: temporaryPath,
    directory: Directory.Data,
  })

  const copiedStats = await Filesystem.stat({ path: temporaryPath, directory: Directory.Data })
  if (copiedStats.type !== 'file' || copiedStats.size !== sourceStats.size) {
    await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data })
      .catch(() => undefined)
    return null
  }

  await commitNativeResourceFile(targetPath, temporaryPath)
  await initNativeOfflineStorage()

  return {
    resource: { ...resource, url: nativeResourceUrl(targetDownloadId, resource.key) ?? resource.url },
    size: copiedStats.size,
  }
}

export const copyOfflineResources = async (
  sourceDownloadId: string,
  targetDownloadId: string,
  ownerUserId: string,
  resources: OfflineDownloadResource[],
): Promise<OfflineStoredResource[]> => {
  if (sourceDownloadId === targetDownloadId) {
    const inventory = await getOfflineResourceInventory(sourceDownloadId)
    const storedByKey = new Map(inventory.map((stored) => [stored.resource.key, stored]))

    return resources.flatMap((resource) => {
      const stored = storedByKey.get(resource.key)
      return stored &&
        stored.resource.kind === resource.kind &&
        stored.resource.version === resource.version &&
        (resource.size <= 0 || stored.size === resource.size)
        ? [{ resource: { ...resource, url: stored.resource.url }, size: stored.size }]
        : []
    })
  }

  if (!resources.length) {
    return []
  }

  if (nativeStorageEnabled) {
    const sourceDownload = await readNativeRecord(sourceDownloadId)
    if (!sourceDownload || sourceDownload.ownerUserId !== ownerUserId) {
      return []
    }

    const sourceResourcesByKey = new Map(
      sourceDownload.manifest.resources.map((resource) => [resource.key, resource]),
    )
    const copiedResources: OfflineStoredResource[] = []

    for (const resource of resources) {
      const sourceResource = sourceResourcesByKey.get(resource.key)
      if (!sourceResource) {
        continue
      }

      try {
        const copied = await copyNativeOfflineResource(
          sourceDownload.id,
          sourceResource,
          targetDownloadId,
          resource,
        )
        if (copied) {
          copiedResources.push(copied)
        }
      } catch {
        // A missing or interrupted source file is repaired by the download path.
      }
    }

    return copiedResources
  }

  const db = await openOfflineDb()

  try {
    const transaction = db.transaction(resourcesStoreName, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(resourcesStoreName)
    const copiedResources: OfflineStoredResource[] = []
    let remainingReads = resources.length
    let copyError: unknown = null

    const readsComplete = new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => {
        if (copyError) {
          return
        }

        copyError = error
        reject(error)
      }

      resources.forEach((resource) => {
        const request = store.get(
          getOfflineResourceStorageKey(sourceDownloadId, resource.key),
        )

        request.onsuccess = () => {
          if (copyError) {
            return
          }

          const source = (request.result as OfflineResourceRecord | undefined) ?? null

          if (source && isReusableOfflineResource(source, ownerUserId, resource)) {
            try {
              store.put({
                ...source,
                storageKey: getOfflineResourceStorageKey(targetDownloadId, resource.key),
                key: resource.key,
                downloadId: targetDownloadId,
                ownerUserId,
                resource,
                storedAt: new Date().toISOString(),
              } satisfies OfflineResourceRecord)
              copiedResources.push({
                resource,
                size: source.size,
              })
            } catch (error) {
              fail(error)
              return
            }
          }

          remainingReads -= 1

          if (remainingReads === 0) {
            resolve()
          }
        }

        request.onerror = () => {
          fail(request.error || new Error('Could not read offline resource.'))
        }
      })
    })

    try {
      await readsComplete
      await done
    } catch (error) {
      try {
        transaction.abort()
      } catch {
        // The transaction may already have aborted after a failed request.
      }
      await done.catch(() => undefined)
      throw error
    }

    return copiedResources
  } finally {
    db.close()
  }
}

export const deleteOfflineDownload = async (downloadId: string) => {
  if (nativeStorageEnabled) {
    nativeManifestCache.delete(downloadId)
    createdNativeDirectories.delete(`${nativeDownloadPath(downloadId)}/resources`)
    await Filesystem.rmdir({
      path: nativeDownloadPath(downloadId),
      directory: Directory.Data,
      recursive: true,
    }).catch(() => undefined)
    return
  }

  const db = await openOfflineDb()

  try {
    const resourceRecords = await readAllFromIndex<OfflineResourceRecord>(
      db,
      resourcesStoreName,
      'downloadId',
      downloadId,
    )
    const transaction = db.transaction([downloadsStoreName, resourcesStoreName], 'readwrite')
    const done = transactionDone(transaction)
    const downloads = transaction.objectStore(downloadsStoreName)
    const resources = transaction.objectStore(resourcesStoreName)

    resourceRecords.forEach((record) => resources.delete(record.storageKey))
    downloads.delete(downloadId)
    await done
  } finally {
    db.close()
  }
}

export const deleteAllOfflineDownloadsForUser = async (ownerUserId: string) => {
  if (nativeStorageEnabled) {
    const records = await readAllNativeRecordHeaders()

    await Promise.all(
      records
        .filter((record) => record.ownerUserId === ownerUserId)
        .map((record) => deleteOfflineDownload(record.id)),
    )
    await Filesystem.deleteFile({
      path: nativeReadingStatePath(ownerUserId),
      directory: Directory.Data,
    }).catch(() => undefined)
    return
  }

  const db = await openOfflineDb()

  try {
    const downloads = await readAllFromIndex<OfflineDownloadRecord>(
      db,
      downloadsStoreName,
      'ownerUserId',
      ownerUserId,
    )
    const resources = await readAllFromIndex<OfflineResourceRecord>(
      db,
      resourcesStoreName,
      'ownerUserId',
      ownerUserId,
    )
    const transaction = db.transaction(
      [downloadsStoreName, resourcesStoreName, readingStateStoreName],
      'readwrite',
    )
    const done = transactionDone(transaction)
    const downloadsStore = transaction.objectStore(downloadsStoreName)
    const resourcesStore = transaction.objectStore(resourcesStoreName)
    const readingStateStore = transaction.objectStore(readingStateStoreName)

    downloads.forEach((record) => downloadsStore.delete(record.id))
    resources.forEach((record) => resourcesStore.delete(record.storageKey))
    readingStateStore.delete(ownerUserId)
    await done
  } finally {
    db.close()
  }
}

export const getOfflineStorageSummary = async (
  ownerUserId: string,
  knownRecords?: OfflineDownloadRecord[],
): Promise<OfflineStorageSummary> => {
  if (nativeStorageEnabled) {
    const records = (knownRecords ?? await readAllNativeRecordHeaders()).filter(
      (record) => record.ownerUserId === ownerUserId,
    )

    return {
      downloadedBytes: records.reduce((total, record) => total + record.downloadedBytes, 0),
      verifiedBytes: records.reduce((total, record) => total + record.verifiedBytes, 0),
      downloadCount: records.length,
      readyCount: records.filter((record) => record.status === 'ready').length,
      partialCount: records.filter((record) => ['partial', 'failed', 'stale', 'paused'].includes(record.status)).length,
      browserUsageBytes: null,
      browserQuotaBytes: null,
      persistent: true,
    }
  }

  const db = await openOfflineDb()

  try {
    const records = knownRecords ?? await readAllFromIndex<OfflineDownloadRecord>(
        db,
        downloadsStoreName,
        'ownerUserId',
        ownerUserId,
      )
    const estimate = await navigator.storage?.estimate?.().catch(() => null)
    const persistent = await navigator.storage?.persisted?.().catch(() => null)

    return {
      downloadedBytes: records.reduce((total, record) => total + record.downloadedBytes, 0),
      verifiedBytes: records.reduce((total, record) => total + record.verifiedBytes, 0),
      downloadCount: records.length,
      readyCount: records.filter((record) => record.status === 'ready').length,
      partialCount: records.filter((record) => ['partial', 'failed', 'stale', 'paused'].includes(record.status)).length,
      browserUsageBytes: estimate?.usage ?? null,
      browserQuotaBytes: estimate?.quota ?? null,
      persistent,
    }
  } finally {
    db.close()
  }
}

export const requestOfflineStoragePersistence = async () => {
  if (nativeStorageEnabled) {
    return true
  }

  if (!navigator.storage?.persist) {
    return null
  }

  return navigator.storage.persist()
}

export const getOfflineResourceUrl = (resourceKey: string) =>
  `/__orbital_offline/resources/${encodeURIComponent(resourceKey)}`
