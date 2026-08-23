import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'

const imageCacheNamePrefix = 'orbital-images-v1'
const imageDatabaseName = 'orbital-image-cache-v1'
const imageDatabaseVersion = 1
const imageStoreName = 'images'
const imageCacheTtlMs = 90 * 24 * 60 * 60 * 1000
const imageCacheMaxEntries = 1024
const imageCacheMaxBytes = 256 * 1024 * 1024
const imageRequestConcurrency = 3
const cachedAtHeader = 'X-Orbital-Cached-At'
const accessedAtHeader = 'X-Orbital-Accessed-At'
const sizeHeader = 'X-Orbital-Size'
const nativeImageRootPath = 'orbital/covers'
const nativeImageStorageEnabled = Capacitor.isNativePlatform()

type MemoryImage = {
  blob: Blob
  url: string
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

type NativeImageMetadata = {
  url: string
  cachedAt: number
  contentType: string
  size: number
}

export type ImageCacheSummary = {
  storedBytes: number
  imageCount: number
  persistent: boolean
  lastWriteError?: string | null
}

export const imageCacheChangedEvent = 'orbital:image-cache-changed'

const memoryImages = new Map<string, MemoryImage>()
const inFlightImages = new Map<string, Promise<Blob>>()
const imageQueue: ImageQueueItem[] = []
const ownerGenerations = new Map<string, number>()
const imageCacheWriteErrors = new Map<string, string>()
let memoryImageBytes = 0
let activeImageRequests = 0

const notifyImageCacheChanged = (ownerUserId: string) => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return
  }

  window.dispatchEvent(new CustomEvent(imageCacheChangedEvent, {
    detail: { ownerUserId },
  }))
}

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

const nativeImageOwnerPath = (ownerUserId: string) =>
  `${nativeImageRootPath}/${encodeURIComponent(ownerUserId)}`

const nativeImageHash = (url: string) => {
  let first = 2166136261
  let second = 2166136261 ^ 0x9e3779b9

  for (let index = 0; index < url.length; index += 1) {
    const code = url.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ (code + index), 16777619)
  }

  return `${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`
}

const nativeImagePath = (ownerUserId: string, url: string) =>
  `${nativeImageOwnerPath(ownerUserId)}/${nativeImageHash(url)}.bin`

const nativeImageMetadataPath = (ownerUserId: string, url: string) =>
  `${nativeImageOwnerPath(ownerUserId)}/${nativeImageHash(url)}.json`

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

const readNativeImageRecord = async (
  ownerUserId: string,
  url: string,
  cacheKey: string,
  suffix: string,
  allowStaleUrl: boolean,
) => {
  const metadataResult = await Filesystem.readFile({
    path: `${nativeImageMetadataPath(ownerUserId, cacheKey)}${suffix}`,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  })
  const metadata = JSON.parse(String(metadataResult.data)) as NativeImageMetadata

  if (
    (!allowStaleUrl && metadata.url !== url) ||
    !Number.isFinite(metadata.cachedAt) ||
    Date.now() - metadata.cachedAt >= imageCacheTtlMs
  ) {
    return null
  }

  const imageResult = await Filesystem.readFile({
    path: `${nativeImagePath(ownerUserId, cacheKey)}${suffix}`,
    directory: Directory.Data,
  })
  if (typeof imageResult.data !== 'string') {
    return null
  }

  const blob = base64ToBlob(imageResult.data, metadata.contentType || 'application/octet-stream')
  return blob.size === metadata.size ? blob : null
}

const readNativeImage = async (
  ownerUserId: string,
  url: string,
  cacheKey = url,
  allowStaleUrl = false,
) => {
  if (!nativeImageStorageEnabled) {
    return null
  }

  const candidateKeys = [...new Set([cacheKey, url])]
  for (const candidateKey of candidateKeys) {
    try {
      const blob = await readNativeImageRecord(ownerUserId, url, candidateKey, '', allowStaleUrl)
      if (blob) {
        return blob
      }
    } catch {
      // Try an interrupted-write recovery below, then the next key.
    }

    try {
      const previousBlob = await readNativeImageRecord(
        ownerUserId,
        url,
        candidateKey,
        '.previous',
        allowStaleUrl,
      )
      if (previousBlob) {
        await Filesystem.deleteFile({
          path: nativeImagePath(ownerUserId, candidateKey),
          directory: Directory.Data,
        }).catch(() => undefined)
        await Filesystem.deleteFile({
          path: nativeImageMetadataPath(ownerUserId, candidateKey),
          directory: Directory.Data,
        }).catch(() => undefined)
        let imageRestored = false
        try {
          await Filesystem.rename({
            from: `${nativeImagePath(ownerUserId, candidateKey)}.previous`,
            to: nativeImagePath(ownerUserId, candidateKey),
            directory: Directory.Data,
          })
          imageRestored = true
          await Filesystem.rename({
            from: `${nativeImageMetadataPath(ownerUserId, candidateKey)}.previous`,
            to: nativeImageMetadataPath(ownerUserId, candidateKey),
            directory: Directory.Data,
          })
          return previousBlob
        } catch {
          if (imageRestored) {
            await Filesystem.rename({
              from: nativeImagePath(ownerUserId, candidateKey),
              to: `${nativeImagePath(ownerUserId, candidateKey)}.previous`,
              directory: Directory.Data,
            }).catch(() => undefined)
          }
        }
      }
    } catch {
      // Try the next key. Older builds stored covers under their full URL.
    }
  }

  return null
}

const writeNativeImage = async (
  ownerUserId: string,
  url: string,
  cacheKey: string,
  blob: Blob,
) => {
  if (!nativeImageStorageEnabled) {
    return false
  }

  const path = nativeImagePath(ownerUserId, cacheKey)
  const temporaryPath = `${path}.part`
  const previousPath = `${path}.previous`
  const metadataPath = nativeImageMetadataPath(ownerUserId, cacheKey)
  const temporaryMetadataPath = `${metadataPath}.part`
  const previousMetadataPath = `${metadataPath}.previous`
  const metadata: NativeImageMetadata = {
    url,
    cachedAt: Date.now(),
    contentType: blob.type || 'application/octet-stream',
    size: blob.size,
  }

  await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(() => undefined)
  await Filesystem.deleteFile({ path: temporaryMetadataPath, directory: Directory.Data }).catch(() => undefined)
  await Filesystem.writeFile({
    path: temporaryPath,
    directory: Directory.Data,
    data: await blobToBase64(blob),
    recursive: true,
  })
  await Filesystem.writeFile({
    path: temporaryMetadataPath,
    directory: Directory.Data,
    data: JSON.stringify(metadata),
    encoding: Encoding.UTF8,
    recursive: true,
  })

  await Filesystem.deleteFile({ path: previousPath, directory: Directory.Data }).catch(() => undefined)
  await Filesystem.deleteFile({ path: previousMetadataPath, directory: Directory.Data }).catch(() => undefined)

  let previousImageMoved = false
  let previousMetadataMoved = false

  try {
    await Filesystem.rename({ from: path, to: previousPath, directory: Directory.Data })
    previousImageMoved = true
  } catch {
    // There may not be an existing image on the first attempt.
  }

  try {
    await Filesystem.rename({
      from: metadataPath,
      to: previousMetadataPath,
      directory: Directory.Data,
    })
    previousMetadataMoved = true
  } catch {
    // There may not be existing metadata on the first attempt.
  }

  try {
    await Filesystem.rename({ from: temporaryPath, to: path, directory: Directory.Data })
    await Filesystem.rename({
      from: temporaryMetadataPath,
      to: metadataPath,
      directory: Directory.Data,
    })
  } catch (error) {
    await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined)
    await Filesystem.deleteFile({ path: metadataPath, directory: Directory.Data }).catch(() => undefined)
    await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(() => undefined)
    await Filesystem.deleteFile({ path: temporaryMetadataPath, directory: Directory.Data }).catch(() => undefined)
    if (previousImageMoved) {
      await Filesystem.rename({ from: previousPath, to: path, directory: Directory.Data }).catch(() => undefined)
    }
    if (previousMetadataMoved) {
      await Filesystem.rename({
        from: previousMetadataPath,
        to: metadataPath,
        directory: Directory.Data,
      }).catch(() => undefined)
    }
    throw error
  }

  await Filesystem.deleteFile({ path: previousPath, directory: Directory.Data }).catch(() => undefined)
  await Filesystem.deleteFile({ path: previousMetadataPath, directory: Directory.Data }).catch(() => undefined)
  return true
}

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

const readIndexedDbImage = async (
  ownerUserId: string,
  url: string,
  cacheKey = url,
  allowStaleUrl = false,
) => {
  if (!canUseIndexedDb()) {
    return null
  }

  const db = await openImageDb()

  try {
    const transaction = db.transaction(imageStoreName, 'readwrite')
    const done = imageTransactionDone(transaction)
    const store = transaction.objectStore(imageStoreName)
    const candidateKeys = [...new Set([cacheKey, url])]
    const record = await (async () => {
      for (const candidateKey of candidateKeys) {
        const request = store.get(imageStorageKey(ownerUserId, candidateKey))
        const record = await new Promise<IndexedDbImageRecord | null>((resolve, reject) => {
          request.onsuccess = () => {
            const result = request.result as IndexedDbImageRecord | undefined
            if (!result) {
              resolve(null)
              return
            }

            if (Date.now() - result.cachedAt >= imageCacheTtlMs) {
              store.delete(result.key)
              resolve(null)
              return
            }

            if (!allowStaleUrl && result.url !== url) {
              resolve(null)
              return
            }

            store.put({ ...result, accessedAt: Date.now() })
            resolve(result)
          }
          request.onerror = () => reject(request.error || new Error('Could not read image cache.'))
        })

        if (record) {
          return record
        }
      }

      return null
    })()

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

const getIndexedDbImageSummary = async (ownerUserId: string): Promise<ImageCacheSummary> => {
  if (!canUseIndexedDb()) {
    return { storedBytes: 0, imageCount: 0, persistent: false }
  }

  const db = await openImageDb()

  try {
    const transaction = db.transaction(imageStoreName, 'readonly')
    const done = imageTransactionDone(transaction)
    const request = transaction
      .objectStore(imageStoreName)
      .index('ownerUserId')
      .getAll(IDBKeyRange.only(ownerUserId))
    const records = await new Promise<IndexedDbImageRecord[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as IndexedDbImageRecord[])
      request.onerror = () => reject(request.error || new Error('Could not inspect image cache.'))
    })
    await done

    const freshRecords = records.filter((record) => (
      Number.isFinite(record.cachedAt) &&
      Date.now() - record.cachedAt < imageCacheTtlMs &&
      Number.isFinite(record.size) &&
      record.size > 0
    ))

    return {
      storedBytes: freshRecords.reduce((total, record) => total + record.size, 0),
      imageCount: freshRecords.length,
      persistent: true,
    }
  } finally {
    db.close()
  }
}

const writeIndexedDbImage = async (
  ownerUserId: string,
  url: string,
  cacheKey: string,
  blob: Blob,
) => {
  if (!canUseIndexedDb()) {
    return false
  }

  const db = await openImageDb()

  try {
    const now = Date.now()
    const transaction = db.transaction(imageStoreName, 'readwrite')
    const done = imageTransactionDone(transaction)
    transaction.objectStore(imageStoreName).put({
      key: imageStorageKey(ownerUserId, cacheKey),
      ownerUserId,
      url,
      blob,
      cachedAt: now,
      accessedAt: now,
      size: blob.size,
    } satisfies IndexedDbImageRecord)
    await done
    await pruneIndexedDbImages(db, ownerUserId)
    return true
  } finally {
    db.close()
  }
}

const memoryKey = (ownerUserId: string, url: string) => `${encodeURIComponent(ownerUserId)}:${url}`

const rememberImage = (key: string, url: string, blob: Blob) => {
  const previous = memoryImages.get(key)
  if (previous) {
    memoryImageBytes -= previous.blob.size
  }

  memoryImages.set(key, { blob, url, accessedAt: Date.now() })
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

const readMemoryImage = (key: string, url: string, allowStaleUrl: boolean) => {
  const image = memoryImages.get(key)
  if (!image || (!allowStaleUrl && image.url !== url)) {
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

const readPersistentImage = async (
  ownerUserId: string,
  url: string,
  cacheKey = url,
  allowStaleUrl = false,
) => {
  const cacheImage = await readCacheStorageImage(ownerUserId, url)
  if (cacheImage) {
    return cacheImage
  }

  const nativeImage = await readNativeImage(ownerUserId, url, cacheKey, allowStaleUrl)
  if (nativeImage) {
    return nativeImage
  }

  const indexedDbImage = await readIndexedDbImage(
    ownerUserId,
    url,
    cacheKey,
    allowStaleUrl,
  ).catch(() => null)
  return indexedDbImage
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
  cacheKey: string,
  blob: Blob,
) => {
  let stored = false
  let lastError: unknown = null

  if (Capacitor.isNativePlatform()) {
    // IndexedDB is the canonical cover store on Android. It is app-private,
    // survives WebView restarts, and is the same persistence layer used by the
    // web fallback. Keep the native filesystem reader below for older covers
    // and use it only if IndexedDB is unavailable on a particular WebView.
    try {
      stored = await writeIndexedDbImage(ownerUserId, url, cacheKey, blob)
      if (stored) {
        const verified = await readIndexedDbImage(ownerUserId, url, cacheKey)
        stored = Boolean(verified && verified.size === blob.size)
      }
    } catch (error) {
      lastError = error
    }

    if (!stored) {
      try {
        stored = await writeNativeImage(ownerUserId, url, cacheKey, blob)
        if (stored) {
          const verified = await readNativeImage(ownerUserId, url, cacheKey)
          stored = Boolean(verified && verified.size === blob.size)
        }
      } catch (error) {
        lastError = error
      }
    }
  } else {
    try {
      stored = await writeCacheStorageImage(ownerUserId, url, blob)
    } catch (error) {
      lastError = error
    }

    if (!stored) {
      try {
        stored = await writeIndexedDbImage(ownerUserId, url, cacheKey, blob)
      } catch (error) {
        lastError = error
      }
    }
  }

  if (stored) {
    imageCacheWriteErrors.delete(ownerUserId)
  } else {
    imageCacheWriteErrors.set(
      ownerUserId,
      lastError instanceof Error ? lastError.message : 'Cover storage could not be verified.',
    )
  }
  notifyImageCacheChanged(ownerUserId)
  return stored
}

const getNativeImageSummary = async (ownerUserId: string): Promise<ImageCacheSummary> => {
  if (!nativeImageStorageEnabled) {
    return { storedBytes: 0, imageCount: 0, persistent: false }
  }

  try {
    const result = await Filesystem.readdir({
      path: nativeImageOwnerPath(ownerUserId),
      directory: Directory.Data,
    })
    const imageFiles = result.files.filter((file) => file.type === 'file' && file.name.endsWith('.bin'))
    const imageSizes = await Promise.all(imageFiles.map(async (file) => {
      const fileSize = Number(file.size)
      if (Number.isFinite(fileSize) && fileSize > 0) {
        return fileSize
      }

      try {
        const metadataResult = await Filesystem.readFile({
          path: `${nativeImageOwnerPath(ownerUserId)}/${file.name.replace(/\.bin$/, '.json')}`,
          directory: Directory.Data,
          encoding: Encoding.UTF8,
        })
        const metadata = JSON.parse(String(metadataResult.data)) as NativeImageMetadata
        return Number.isFinite(metadata.size) && metadata.size > 0 ? metadata.size : null
      } catch {
        return null
      }
    }))
    const validSizes = imageSizes.filter((size): size is number => size != null)

    return {
      storedBytes: validSizes.reduce((total, size) => total + size, 0),
      imageCount: validSizes.length,
      persistent: true,
    }
  } catch {
    return { storedBytes: 0, imageCount: 0, persistent: true }
  }
}

const getCacheStorageSummary = async (ownerUserId: string): Promise<ImageCacheSummary> => {
  const storage = cacheStorage()
  if (!storage) {
    return { storedBytes: 0, imageCount: 0, persistent: false }
  }

  try {
    const cache = await storage.open(cacheNameForOwner(ownerUserId))
    const requests = await cache.keys()
    const entries = await Promise.all(
      requests.map(async (request) => {
        const response = await cache.match(request)
        if (!response || !isFresh(response)) {
          return null
        }

        const headerSize = Number(response.headers.get(sizeHeader))
        const size = Number.isFinite(headerSize) && headerSize > 0
          ? headerSize
          : (await response.blob()).size

        return size > 0 ? size : null
      }),
    )
    const sizes = entries.filter((size): size is number => size != null)

    return {
      storedBytes: sizes.reduce((total, size) => total + size, 0),
      imageCount: sizes.length,
      persistent: true,
    }
  } catch {
    return { storedBytes: 0, imageCount: 0, persistent: false }
  }
}

export const getImageCacheSummary = async (ownerUserId: string): Promise<ImageCacheSummary> => {
  if (nativeImageStorageEnabled) {
    const nativeSummary = await getNativeImageSummary(ownerUserId)
    const fallbackSummary = await getIndexedDbImageSummary(ownerUserId).catch(() => ({
      storedBytes: 0,
      imageCount: 0,
      persistent: true,
    }))
    return {
      storedBytes: nativeSummary.storedBytes + fallbackSummary.storedBytes,
      imageCount: nativeSummary.imageCount + fallbackSummary.imageCount,
      persistent: true,
      lastWriteError: imageCacheWriteErrors.get(ownerUserId) || null,
    }
  }

  const cacheSummary = await getCacheStorageSummary(ownerUserId)
  const fallbackSummary = await getIndexedDbImageSummary(ownerUserId).catch(() => ({
    storedBytes: 0,
    imageCount: 0,
    persistent: false,
  }))
  return {
    storedBytes: cacheSummary.storedBytes + fallbackSummary.storedBytes,
    imageCount: cacheSummary.imageCount + fallbackSummary.imageCount,
    persistent: cacheSummary.persistent || fallbackSummary.persistent,
    lastWriteError: imageCacheWriteErrors.get(ownerUserId) || null,
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
  fetcher?: () => Promise<Response>,
  cacheKey = url,
) => {
  const key = memoryKey(ownerUserId, cacheKey)
  const memoryImage = readMemoryImage(key, url, !fetcher)
  if (memoryImage) {
    return Promise.resolve(memoryImage)
  }

  return enqueueImageRequest(key, async () => {
    const generation = ownerGenerations.get(ownerUserId) || 0
    const persistentImage = await readPersistentImage(ownerUserId, url, cacheKey, !fetcher)
    if (persistentImage) {
      if (ownerGenerations.get(ownerUserId) === generation) {
        rememberImage(key, url, persistentImage)
      }
      return persistentImage
    }

    if (!fetcher) {
      throw new Error('Image is not cached on this device.')
    }

    const response = await fetcher()
    if (!response.ok) {
      throw new Error(`Failed to load image (${response.status})`)
    }

    const blob = await response.blob()
    if (ownerGenerations.get(ownerUserId) === generation) {
      rememberImage(key, url, blob)
      await writePersistentImage(ownerUserId, url, cacheKey, blob)
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
    imageCacheWriteErrors.delete(ownerUserId)
  }

  if (nativeImageStorageEnabled) {
    await Filesystem.rmdir({
      path: ownerUserId ? nativeImageOwnerPath(ownerUserId) : nativeImageRootPath,
      directory: Directory.Data,
      recursive: true,
    }).catch(() => undefined)
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

  if (ownerUserId) {
    notifyImageCacheChanged(ownerUserId)
  }
}
