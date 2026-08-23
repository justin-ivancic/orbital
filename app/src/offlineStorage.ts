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

const nativeResourcePath = (downloadId: string, resourceKey: string) =>
  `${nativeDownloadPath(downloadId)}/resources/${encodeURIComponent(resourceKey)}.bin`

const nativeReadingStatePath = (ownerUserId: string) =>
  `orbital/reading/${encodeURIComponent(ownerUserId)}.json`

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
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }

  return btoa(binary)
}

const base64ToBlob = (value: string, contentType: string) => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return new Blob([bytes], { type: contentType })
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

const readAllNativeRecords = async () => {
  const ids = await listNativeDownloadIds()
  const records: OfflineDownloadRecord[] = []

  for (const encodedId of ids) {
    const record = await readNativeJson<OfflineDownloadRecord>(
      `${nativeDownloadsPath}/${encodedId}/record.json`,
    )

    if (record) {
      records.push(record)
    }
  }

  return records
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
    await writeNativeJson(nativeRecordPath(record.id), nextRecord)
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
    return readNativeJson<OfflineDownloadRecord>(nativeRecordPath(downloadId))
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
    const record = await readNativeJson<OfflineDownloadRecord>(nativeRecordPath(downloadId))

    if (!record) {
      return []
    }

    const resourcesByFileName = new Map(
      record.manifest.resources.map((resource) => [
        `${encodeURIComponent(resource.key)}.bin`,
        resource,
      ]),
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

        if (!file || file.type !== 'file') {
          continue
        }

        try {
          const uri = await Filesystem.getUri({
            path: nativeResourcePath(downloadId, resource.key),
            directory: Directory.Data,
          })
          storedResources.push({
            resource: { ...resource, url: toNativeFileUrl(uri.uri) },
            size: Number.isFinite(file.size) ? file.size : 0,
          })
        } catch {
          // If the native URI cannot be resolved, let the downloader repair it.
        }
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
    const records = await readAllNativeRecords()
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
    const previousPath = `${path}.previous`

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

    const uri = await Filesystem.getUri({
      path,
      directory: Directory.Data,
    })

    return {
      ...resource,
      url: toNativeFileUrl(uri.uri),
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

export const getOfflineResource = async (resourceKey: string) => {
  if (nativeStorageEnabled) {
    const records = await readAllNativeRecords()

    for (const download of records) {
      const resource = download.manifest.resources.find((item) => item.key === resourceKey)
      if (!resource) {
        continue
      }

      const path = nativeResourcePath(download.id, resource.key)
      try {
        const result = await Filesystem.readFile({
          path,
          directory: Directory.Data,
        })
        const encoded = typeof result.data === 'string' ? result.data : ''
        const uri = await Filesystem.getUri({
          path,
          directory: Directory.Data,
        })
        const blob = base64ToBlob(encoded, resource.contentType)

        return {
          storageKey: getOfflineResourceStorageKey(download.id, resource.key),
          key: resource.key,
          downloadId: download.id,
          ownerUserId: download.ownerUserId,
          resource: { ...resource, url: toNativeFileUrl(uri.uri) },
          blob,
          size: blob.size,
          storedAt: download.updatedAt,
        } satisfies OfflineResourceRecord
      } catch {
        return null
      }
    }

    return null
  }

  const db = await openOfflineDb()

  try {
    const transaction = db.transaction(resourcesStoreName, 'readonly')
    const done = transactionDone(transaction)
    const record = await toPromise<OfflineResourceRecord | undefined>(
      transaction.objectStore(resourcesStoreName).index('resourceKey').get(resourceKey),
    )
    await done
    return record ?? null
  } finally {
    db.close()
  }
}

export const deleteOfflineDownload = async (downloadId: string) => {
  if (nativeStorageEnabled) {
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
    const records = await readAllNativeRecords()

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
): Promise<OfflineStorageSummary> => {
  if (nativeStorageEnabled) {
    const records = (await readAllNativeRecords()).filter(
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
    const records = await readAllFromIndex<OfflineDownloadRecord>(
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
