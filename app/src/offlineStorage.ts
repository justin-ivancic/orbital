import type {
  OfflineDownloadManifest,
  OfflineDownloadRecord,
  OfflineDownloadResource,
  OfflineStorageSummary,
  SessionUser,
} from './appTypes'

const offlineDbName = 'orbital-offline-v1'
const offlineDbVersion = 1
const downloadsStoreName = 'downloads'
const resourcesStoreName = 'resources'

type OfflineResourceRecord = {
  key: string
  downloadId: string
  ownerUserId: string
  resource: OfflineDownloadResource
  blob: Blob
  size: number
  storedAt: string
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

const openOfflineDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error('Offline storage is not available in this browser.'))
      return
    }

    const request = indexedDB.open(offlineDbName, offlineDbVersion)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(downloadsStoreName)) {
        const downloads = db.createObjectStore(downloadsStoreName, { keyPath: 'id' })
        downloads.createIndex('ownerUserId', 'ownerUserId', { unique: false })
        downloads.createIndex('updatedAt', 'updatedAt', { unique: false })
      }

      if (!db.objectStoreNames.contains(resourcesStoreName)) {
        const resources = db.createObjectStore(resourcesStoreName, { keyPath: 'key' })
        resources.createIndex('downloadId', 'downloadId', { unique: false })
        resources.createIndex('ownerUserId', 'ownerUserId', { unique: false })
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
})

export const putOfflineDownload = async (record: OfflineDownloadRecord) => {
  const db = await openOfflineDb()

  try {
    const transaction = db.transaction(downloadsStoreName, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(downloadsStoreName).put({
      ...record,
      updatedAt: new Date().toISOString(),
    })
    await done
  } finally {
    db.close()
  }
}

export const getOfflineDownload = async (downloadId: string) => {
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

export const listOfflineDownloads = async (ownerUserId: string) => {
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

export const putOfflineResource = async (
  downloadId: string,
  ownerUserId: string,
  resource: OfflineDownloadResource,
  blob: Blob,
) => {
  const db = await openOfflineDb()
  const record: OfflineResourceRecord = {
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
}

export const getOfflineResource = async (resourceKey: string) => {
  const db = await openOfflineDb()

  try {
    const transaction = db.transaction(resourcesStoreName, 'readonly')
    const done = transactionDone(transaction)
    const record = await toPromise<OfflineResourceRecord | undefined>(
      transaction.objectStore(resourcesStoreName).get(resourceKey),
    )
    await done
    return record ?? null
  } finally {
    db.close()
  }
}

export const deleteOfflineDownload = async (downloadId: string) => {
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

    resourceRecords.forEach((record) => resources.delete(record.key))
    downloads.delete(downloadId)
    await done
  } finally {
    db.close()
  }
}

export const deleteAllOfflineDownloadsForUser = async (ownerUserId: string) => {
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
    const transaction = db.transaction([downloadsStoreName, resourcesStoreName], 'readwrite')
    const done = transactionDone(transaction)
    const downloadsStore = transaction.objectStore(downloadsStoreName)
    const resourcesStore = transaction.objectStore(resourcesStoreName)

    downloads.forEach((record) => downloadsStore.delete(record.id))
    resources.forEach((record) => resourcesStore.delete(record.key))
    await done
  } finally {
    db.close()
  }
}

export const getOfflineStorageSummary = async (
  ownerUserId: string,
): Promise<OfflineStorageSummary> => {
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
      partialCount: records.filter((record) => ['partial', 'failed', 'stale'].includes(record.status)).length,
      browserUsageBytes: estimate?.usage ?? null,
      browserQuotaBytes: estimate?.quota ?? null,
      persistent,
    }
  } finally {
    db.close()
  }
}

export const requestOfflineStoragePersistence = async () => {
  if (!navigator.storage?.persist) {
    return null
  }

  return navigator.storage.persist()
}

export const getOfflineResourceUrl = (resourceKey: string) =>
  `/__orbital_offline/resources/${encodeURIComponent(resourceKey)}`
