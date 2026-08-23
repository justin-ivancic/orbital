import { Capacitor } from '@capacitor/core'

const imageCacheNamePrefix = 'orbital-images-v1'
const imageDatabaseName = 'orbital-image-cache-v1'
const imageDatabaseVersion = 1
const imageStoreName = 'images'
const imageCacheTtlMs = 30 * 24 * 60 * 60 * 1000
const imageCacheMaxEntries = 128
const imageCacheMaxBytes = 100 * 1024 * 1024
const imageRequestConcurrency = 3
const cachedAtHeader = 'X-Orbital-Cached-At'
const accessedAtHeader = 'X-Orbital-Accessed-At'
const sizeHeader = 'X-Orbital-Size'

type MemoryImage = {
  blob: Blob
  accessedAt: number
}

type ImageQueueItem = {
  task: () => Promise<Blob>
  resolve: (blob: Blob) => void
  reject: (error: unknown) => void
}

type IndexedDbImageRecord = {
  key: string
  ownerUserId: string
  url: string
  blob: Blob
  cachedAt: number
  accessedAt: number
  size: number
}

const memoryImages = new Map<string, MemoryImage>()
const inFlightImages = new Map<string, Promise<Blob>>()
const imageQueue: ImageQueueItem[] = []
const ownerGenerations = new Map<string, number>()
let memoryImageBytes = 0
let activeImageRequests = 0

const cacheNameForOwner = (ownerUserId: string) =>
  `${imageCacheNamePrefix}:${encodeURIComponent(ownerUserId)}`

const cacheStorage = () => {
  if (typeof window === 'undefined' || !('caches' in window)) {
    return null
  }

  return window.caches
}

const canUseIndexedDb = () => typeof indexedDB !== 'undefined'

const imageStorageKey = (ownerUserId: string, url: string) =>
  `${encodeURIComponent(ownerUserId)}:${url}`

const openImageDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error('IndexedDB is not available.'))
      return
    }

    const request = indexedDB.open(imageDatabaseName, imageDatabaseVersion)

    request.onupgradeneeded = () => {
      const db = request.result
      if (db.objectStoreNames.contains(imageStoreName)) {
        return
      }

      const images = db.createObjectStore(imageStoreName, { keyPath: 'key' })
      images.createIndex('ownerUserId', 'ownerUserId', { unique: false })
      images.createIndex('accessedAt', 'accessedAt', { unique: false })
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open image cache.'))
  })

const imageTransactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error || new Error('Image cache transaction aborted.'))
    transaction.onerror = () => reject(transaction.error || new Error('Image cache transaction failed.'))
  })

const readIndexedDbImage = async (ownerUserId: string, url: string) => {
  if (!canUseIndexedDb()) {
    return null
  }

  const db = await openImageDb()

  try {
    const transaction = db.transaction(imageStoreName, 'readwrite')
    const done = imageTransactionDone(transaction)
    const store = transaction.objectStore(imageStoreName)
    const request = store.get(imageStorageKey(ownerUserId, url))

    const record = await new Promise<IndexedDbImageRecord | null>((resolve, reject) => {
      request.onsuccess = () => {
        const result = request.result as IndexedDbImageRecord | undefined
        if (!result || Date.now() - result.cachedAt >= imageCacheTtlMs) {
          if (result) {
            store.delete(result.key)
          }
          resolve(null)
          return
        }

        store.put({ ...result, accessedAt: Date.now() })
        resolve(result)
      }
      request.onerror = () => reject(request.error || new Error('Could not read image cache.'))
    })

    await done
    return record?.blob || null
  } finally {
    db.close()
  }
}

const pruneIndexedDbImages = async (db: IDBDatabase, ownerUserId: string) => {
  const readTransaction = db.transaction(imageStoreName, 'readonly')
  const readDone = imageTransactionDone(readTransaction)
  const readRequest = readTransaction
    .objectStore(imageStoreName)
    .index('ownerUserId')
    .getAll(IDBKeyRange.only(ownerUserId))
  const records = await new Promise<IndexedDbImageRecord[]>((resolve, reject) => {
    readRequest.onsuccess = () => resolve(readRequest.result as IndexedDbImageRecord[])
    readRequest.onerror = () => reject(readRequest.error || new Error('Could not inspect image cache.'))
  })
  await readDone

  records.sort((left, right) => left.accessedAt - right.accessedAt)
  let totalBytes = records.reduce((total, record) => total + record.size, 0)
  const toDelete: string[] = []

  while (records.length - toDelete.length > imageCacheMaxEntries || totalBytes > imageCacheMaxBytes) {
    const oldest = records[toDelete.length]
    if (!oldest) {
      break
    }

    toDelete.push(oldest.key)
    totalBytes -= oldest.size
  }

  if (!toDelete.length) {
    return
  }

  const deleteTransaction = db.transaction(imageStoreName, 'readwrite')
  const deleteDone = imageTransactionDone(deleteTransaction)
  const store = deleteTransaction.objectStore(imageStoreName)
  toDelete.forEach((key) => store.delete(key))
  await deleteDone
}

const readIndexedDbImagesForOwner = async (ownerUserId: string) => {
  const db = await openImageDb()

  try {
    const transaction = db.transaction(imageStoreName, 'readwrite')
    const done = imageTransactionDone(transaction)
    const store = transaction.objectStore(imageStoreName)
    const request = store.index('ownerUserId').getAll(IDBKeyRange.only(ownerUserId))

    request.onsuccess = () => {
      const records = request.result as IndexedDbImageRecord[]
      records.forEach((record) => store.delete(record.key))
    }

    await done
  } finally {
    db.close()
  }
}

const writeIndexedDbImage = async (ownerUserId: string, url: string, blob: Blob) => {
  if (!canUseIndexedDb()) {
    return
  }

  const db = await openImageDb()

  try {
    const now = Date.now()
    const transaction = db.transaction(imageStoreName, 'readwrite')
    const done = imageTransactionDone(transaction)
    transaction.objectStore(imageStoreName).put({
      key: imageStorageKey(ownerUserId, url),
      ownerUserId,
      url,
      blob,
      cachedAt: now,
      accessedAt: now,
      size: blob.size,
    } satisfies IndexedDbImageRecord)
    await done
    await pruneIndexedDbImages(db, ownerUserId)
  } finally {
    db.close()
  }
}

const memoryKey = (ownerUserId: string, url: string) => `${encodeURIComponent(ownerUserId)}:${url}`

const rememberImage = (key: string, blob: Blob) => {
  const previous = memoryImages.get(key)
  if (previous) {
    memoryImageBytes -= previous.blob.size
  }

  memoryImages.set(key, { blob, accessedAt: Date.now() })
  memoryImageBytes += blob.size

  while (memoryImageBytes > imageCacheMaxBytes / 4 && memoryImages.size > 1) {
    const oldest = [...memoryImages.entries()].sort(
      (left, right) => left[1].accessedAt - right[1].accessedAt,
    )[0]

    if (!oldest) {
      break
    }

    memoryImages.delete(oldest[0])
    memoryImageBytes -= oldest[1].blob.size
  }
}

const readMemoryImage = (key: string) => {
  const image = memoryImages.get(key)
  if (!image) {
    return null
  }

  image.accessedAt = Date.now()
  return image.blob
}

const isFresh = (response: Response) => {
  const cachedAt = Number(response.headers.get(cachedAtHeader))
  return Number.isFinite(cachedAt) && Date.now() - cachedAt < imageCacheTtlMs
}

const readCacheStorageImage = async (ownerUserId: string, url: string) => {
  const storage = cacheStorage()
  if (!storage) {
    return null
  }

  try {
    const cache = await storage.open(cacheNameForOwner(ownerUserId))
    const response = await cache.match(url)
    if (!response) {
      return null
    }

    if (!isFresh(response)) {
      await cache.delete(url)
      return null
    }

    const blob = await response.blob()
    const headers = new Headers(response.headers)
    headers.set(accessedAtHeader, String(Date.now()))
    await cache.put(url, new Response(blob, { headers })).catch(() => undefined)
    return blob
  } catch {
    return null
  }
}

const readPersistentImage = async (ownerUserId: string, url: string) => {
  const cacheImage = await readCacheStorageImage(ownerUserId, url)
  return cacheImage || await readIndexedDbImage(ownerUserId, url).catch(() => null)
}

const prunePersistentImages = async (cache: Cache) => {
  const requests = await cache.keys()
  const entries = (
    await Promise.all(
      requests.map(async (request) => {
        const response = await cache.match(request)
        if (!response) {
          return null
        }

        return {
          accessedAt: Number(response.headers.get(accessedAtHeader)) || 0,
          request,
          size: Number(response.headers.get(sizeHeader)) || 0,
        }
      }),
    )
  ).filter((entry): entry is {
    accessedAt: number
    request: Request
    size: number
  } => Boolean(entry))

  entries.sort((left, right) => left.accessedAt - right.accessedAt)

  let totalBytes = entries.reduce((total, entry) => total + entry.size, 0)
  while (
    entries.length > imageCacheMaxEntries ||
    totalBytes > imageCacheMaxBytes
  ) {
    const oldest = entries.shift()
    if (!oldest) {
      break
    }

    await cache.delete(oldest.request)
    totalBytes -= oldest.size
  }
}

const writeCacheStorageImage = async (
  ownerUserId: string,
  url: string,
  blob: Blob,
) => {
  const storage = cacheStorage()
  if (!storage) {
    return false
  }

  try {
    const cache = await storage.open(cacheNameForOwner(ownerUserId))
    const now = String(Date.now())
    const headers = new Headers({
      'Content-Type': blob.type || 'application/octet-stream',
      [accessedAtHeader]: now,
      [cachedAtHeader]: now,
      [sizeHeader]: String(blob.size),
    })

    await cache.put(url, new Response(blob, { headers }))
    await prunePersistentImages(cache)
    return true
  } catch {
    // Image persistence is an optimization; a storage failure must not block rendering.
    return false
  }
}

const writePersistentImage = async (
  ownerUserId: string,
  url: string,
  blob: Blob,
) => {
  const nativeImageCache = Capacitor.isNativePlatform()
  const cacheStored = nativeImageCache
    ? false
    : await writeCacheStorageImage(ownerUserId, url, blob)

  if (!cacheStored || nativeImageCache) {
    await writeIndexedDbImage(ownerUserId, url, blob).catch(() => undefined)
  }
}

const pumpImageQueue = () => {
  while (activeImageRequests < imageRequestConcurrency && imageQueue.length > 0) {
    const item = imageQueue.shift()
    if (!item) {
      return
    }

    activeImageRequests += 1
    void item.task().then(
      (blob) => {
        item.resolve(blob)
        activeImageRequests -= 1
        pumpImageQueue()
      },
      (error: unknown) => {
        item.reject(error)
        activeImageRequests -= 1
        pumpImageQueue()
      },
    )
  }
}

const enqueueImageRequest = (key: string, task: () => Promise<Blob>) => {
  const existing = inFlightImages.get(key)
  if (existing) {
    return existing
  }

  const promise = new Promise<Blob>((resolve, reject) => {
    imageQueue.push({ reject, resolve, task })
    pumpImageQueue()
  })

  inFlightImages.set(key, promise)
  void promise.then(
    () => inFlightImages.delete(key),
    () => inFlightImages.delete(key),
  )

  return promise
}

export const loadCachedImage = (
  ownerUserId: string,
  url: string,
  fetcher: () => Promise<Response>,
) => {
  const key = memoryKey(ownerUserId, url)
  const memoryImage = readMemoryImage(key)
  if (memoryImage) {
    return Promise.resolve(memoryImage)
  }

  return enqueueImageRequest(key, async () => {
    const generation = ownerGenerations.get(ownerUserId) || 0
    const persistentImage = await readPersistentImage(ownerUserId, url)
    if (persistentImage) {
      if (ownerGenerations.get(ownerUserId) === generation) {
        rememberImage(key, persistentImage)
      }
      return persistentImage
    }

    const response = await fetcher()
    if (!response.ok) {
      throw new Error(`Failed to load image (${response.status})`)
    }

    const blob = await response.blob()
    if (ownerGenerations.get(ownerUserId) === generation) {
      rememberImage(key, blob)
      await writePersistentImage(ownerUserId, url, blob)
    }
    return blob
  })
}

export const clearImageCache = async (ownerUserId?: string) => {
  const storage = cacheStorage()

  for (const key of [...memoryImages.keys()]) {
    if (!ownerUserId || key.startsWith(`${encodeURIComponent(ownerUserId)}:`)) {
      const image = memoryImages.get(key)
      if (image) {
        memoryImageBytes -= image.blob.size
      }
      memoryImages.delete(key)
    }
  }

  if (ownerUserId) {
    ownerGenerations.set(ownerUserId, (ownerGenerations.get(ownerUserId) || 0) + 1)
  }

  await (async () => {
    if (!storage) {
      return
    }

    try {
      if (ownerUserId) {
        await storage.delete(cacheNameForOwner(ownerUserId))
        return
      }

      const cacheNames = await storage.keys()
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(`${imageCacheNamePrefix}:`))
          .map((name) => storage.delete(name)),
      )
    } catch {
      // Cache cleanup is best-effort and never blocks authentication or reading.
    }
  })()

  if (!canUseIndexedDb()) {
    return
  }

  try {
    if (ownerUserId) {
      await readIndexedDbImagesForOwner(ownerUserId)
      return
    }

    const db = await openImageDb()
    try {
      const transaction = db.transaction(imageStoreName, 'readwrite')
      const done = imageTransactionDone(transaction)
      transaction.objectStore(imageStoreName).clear()
      await done
    } finally {
      db.close()
    }
  } catch {
    // IndexedDB cleanup is best-effort and never blocks authentication or reading.
  }
}
