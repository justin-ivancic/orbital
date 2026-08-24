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
  key: string
  priority: number
  sequence: number
  queuedAt: number
  started: boolean
  task: () => Promise<Blob>
  resolve: (blob: Blob) => void
  reject: (error: unknown) => void
}

type ImageRequestRecord = {
  item: ImageQueueItem
  managedConsumers: number
  promise: Promise<Blob>
  unmanagedConsumer: boolean
}

export type ImageLoadPriority = 'background' | 'nearby' | 'visible'

export type ImageLoadPerformance = {
  activeRequests: number
  averageLoadMs: number
  averageQueueWaitMs: number
  cacheHits: number
  completedLoads: number
  lastLoadMs: number
  networkLoads: number
  queuedRequests: number
}

export type CachedImageRequest = {
  promise: Promise<Blob>
  release: () => void
  setPriority: (priority: ImageLoadPriority) => void
}

type NativeImageSource = {
  displayUrl: string
  size: number
  url: string
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
  backend: 'cache-storage' | 'indexeddb' | 'native-filesystem' | 'none'
  lastWriteError?: string | null
  lastError?: string | null
}

export type ImageCacheSelfTestResult = {
  passed: boolean
  backend: ImageCacheSummary['backend']
  bytesWritten: number
  bytesRead: number
  storedBytes: number
  imageCount: number
  error: string | null
}

export const imageCacheChangedEvent = 'orbital:image-cache-changed'

const memoryImages = new Map<string, MemoryImage>()
const nativeImageSources = new Map<string, NativeImageSource>()
const inFlightImages = new Map<string, ImageRequestRecord>()
const imageQueue: ImageQueueItem[] = []
const ownerGenerations = new Map<string, number>()
const imageCacheWriteErrors = new Map<string, string>()
const imageCacheBackends = new Map<string, ImageCacheSummary['backend']>()
let memoryImageBytes = 0
let activeImageRequests = 0
let imageRequestSequence = 0
let completedImageLoads = 0
let totalImageLoadMs = 0
let totalImageQueueWaitMs = 0
let lastImageLoadMs = 0
let persistentImageHits = 0
let networkImageLoads = 0

const imagePriorityValue: Record<ImageLoadPriority, number> = {
  background: 0,
  nearby: 1,
  visible: 2,
}

const ownerGeneration = (ownerUserId: string) => ownerGenerations.get(ownerUserId) ?? 0

const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) {
      return message
    }
  }

  return fallback
}

const isMissingNativePathError = (error: unknown) =>
  /not found|does not exist|no such file|missing/i.test(errorMessage(error, ''))

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

const forgetNativeImageSource = (ownerUserId: string, cacheKey: string) => {
  nativeImageSources.delete(memoryKey(ownerUserId, cacheKey))
}

const readNativeImageSourceRecord = async (
  ownerUserId: string,
  url: string,
  cacheKey: string,
  allowStaleUrl: boolean,
): Promise<NativeImageSource | null> => {
  const metadataResult = await Filesystem.readFile({
    path: nativeImageMetadataPath(ownerUserId, cacheKey),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  })
  const metadata = JSON.parse(String(metadataResult.data)) as NativeImageMetadata

  if (
    (!allowStaleUrl && metadata.url !== url) ||
    !Number.isFinite(metadata.cachedAt) ||
    Date.now() - metadata.cachedAt >= imageCacheTtlMs ||
    !Number.isFinite(metadata.size) ||
    metadata.size <= 0
  ) {
    return null
  }

  const imagePath = nativeImagePath(ownerUserId, cacheKey)
  const fileStats = await Filesystem.stat({ path: imagePath, directory: Directory.Data })
  if (Number(fileStats.size) !== metadata.size) {
    return null
  }

  const file = await Filesystem.getUri({ path: imagePath, directory: Directory.Data })
  return {
    displayUrl: Capacitor.convertFileSrc(file.uri),
    size: metadata.size,
    url: metadata.url,
  }
}

export const getCachedImageSource = async (
  ownerUserId: string,
  url: string,
  cacheKey = url,
  allowStaleUrl = false,
) => {
  if (!nativeImageStorageEnabled) {
    return null
  }

  const key = memoryKey(ownerUserId, cacheKey)
  const remembered = nativeImageSources.get(key)
  if (remembered && (allowStaleUrl || remembered.url === url)) {
    return remembered.displayUrl
  }

  for (const candidateKey of [...new Set([cacheKey, url])]) {
    try {
      const source = await readNativeImageSourceRecord(
        ownerUserId,
        url,
        candidateKey,
        allowStaleUrl,
      )
      if (source) {
        nativeImageSources.set(key, source)
        return source.displayUrl
      }
    } catch {
      // Older or interrupted records fall through to the verified Blob path.
    }
  }

  return null
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

  forgetNativeImageSource(ownerUserId, cacheKey)

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
    return {
      storedBytes: 0,
      imageCount: 0,
      persistent: false,
      backend: 'none',
      lastError: null,
    }
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
      backend: 'indexeddb',
      lastError: null,
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
  if (!nativeImageStorageEnabled) {
    const cacheImage = await readCacheStorageImage(ownerUserId, url)
    if (cacheImage) {
      return cacheImage
    }
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
    // Use the same app-private filesystem as offline books on Android. This is
    // independent of WebView storage eviction and remains readable after a
    // process restart. IndexedDB remains a compatibility fallback for covers
    // created by older APKs or unusual WebViews where Filesystem is unavailable.
    try {
      stored = await writeNativeImage(ownerUserId, url, cacheKey, blob)
      if (stored) {
        const verified = await getCachedImageSource(ownerUserId, url, cacheKey)
        stored = Boolean(verified)
        if (stored) {
          imageCacheBackends.set(ownerUserId, 'native-filesystem')
        }
      }
    } catch (error) {
      lastError = error
    }

    if (!stored) {
      try {
        stored = await writeIndexedDbImage(ownerUserId, url, cacheKey, blob)
        if (stored) {
          const verified = await readIndexedDbImage(ownerUserId, url, cacheKey)
          stored = Boolean(verified && verified.size === blob.size)
          if (stored) {
            imageCacheBackends.set(ownerUserId, 'indexeddb')
          }
        }
      } catch (error) {
        lastError = error
      }
    }
  } else {
    try {
      stored = await writeCacheStorageImage(ownerUserId, url, blob)
      if (stored) {
        imageCacheBackends.set(ownerUserId, 'cache-storage')
      }
    } catch (error) {
      lastError = error
    }

    if (!stored) {
      try {
        stored = await writeIndexedDbImage(ownerUserId, url, cacheKey, blob)
        if (stored) {
          imageCacheBackends.set(ownerUserId, 'indexeddb')
        }
      } catch (error) {
        lastError = error
      }
    }
  }

  if (stored) {
    imageCacheWriteErrors.delete(ownerUserId)
  } else {
    imageCacheBackends.set(ownerUserId, 'none')
    imageCacheWriteErrors.set(
      ownerUserId,
      errorMessage(lastError, 'Cover storage could not be verified.'),
    )
  }
  notifyImageCacheChanged(ownerUserId)
  return stored
}

const getNativeImageSummary = async (ownerUserId: string): Promise<ImageCacheSummary> => {
  if (!nativeImageStorageEnabled) {
    return {
      storedBytes: 0,
      imageCount: 0,
      persistent: false,
      backend: 'none',
      lastError: null,
    }
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
      backend: 'native-filesystem',
      lastError: null,
    }
  } catch (error) {
    return {
      storedBytes: 0,
      imageCount: 0,
      persistent: true,
      backend: 'native-filesystem',
      lastError: isMissingNativePathError(error)
        ? null
        : errorMessage(error, 'The Android cover folder could not be inspected.'),
    }
  }
}

const getCacheStorageSummary = async (ownerUserId: string): Promise<ImageCacheSummary> => {
  const storage = cacheStorage()
  if (!storage) {
    return {
      storedBytes: 0,
      imageCount: 0,
      persistent: false,
      backend: 'none',
      lastError: null,
    }
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
      backend: 'cache-storage',
      lastError: null,
    }
  } catch (error) {
    return {
      storedBytes: 0,
      imageCount: 0,
      persistent: false,
      backend: 'cache-storage',
      lastError: errorMessage(error, 'Cover storage could not be inspected.'),
    }
  }
}

export const getImageCacheSummary = async (ownerUserId: string): Promise<ImageCacheSummary> => {
  if (nativeImageStorageEnabled) {
    const nativeSummary = await getNativeImageSummary(ownerUserId)
    const fallbackSummary = await getIndexedDbImageSummary(ownerUserId).catch((error) => ({
      storedBytes: 0,
      imageCount: 0,
      persistent: true,
      backend: 'indexeddb' as const,
      lastError: errorMessage(error, 'IndexedDB cover storage could not be inspected.'),
    }))
    return {
      storedBytes: nativeSummary.storedBytes + fallbackSummary.storedBytes,
      imageCount: nativeSummary.imageCount + fallbackSummary.imageCount,
      persistent: true,
      backend: nativeSummary.imageCount > 0
        ? 'native-filesystem'
        : fallbackSummary.imageCount > 0
          ? 'indexeddb'
          : 'native-filesystem',
      lastWriteError: imageCacheWriteErrors.get(ownerUserId) || null,
      lastError: nativeSummary.lastError || (
        nativeSummary.imageCount === 0 ? fallbackSummary.lastError : null
      ),
    }
  }

  const cacheSummary = await getCacheStorageSummary(ownerUserId)
  const fallbackSummary = await getIndexedDbImageSummary(ownerUserId).catch(() => ({
    storedBytes: 0,
    imageCount: 0,
    persistent: false,
    backend: 'none' as const,
    lastError: null,
  }))
  return {
    storedBytes: cacheSummary.storedBytes + fallbackSummary.storedBytes,
    imageCount: cacheSummary.imageCount + fallbackSummary.imageCount,
    persistent: cacheSummary.persistent || fallbackSummary.persistent,
    backend: cacheSummary.imageCount > 0
      ? 'cache-storage'
      : fallbackSummary.imageCount > 0
        ? 'indexeddb'
        : cacheSummary.backend,
    lastWriteError: imageCacheWriteErrors.get(ownerUserId) || null,
    lastError: cacheSummary.lastError || fallbackSummary.lastError || null,
  }
}

const deleteNativeImage = async (ownerUserId: string, cacheKey: string) => {
  if (!nativeImageStorageEnabled) {
    return
  }

  const path = nativeImagePath(ownerUserId, cacheKey)
  const metadataPath = nativeImageMetadataPath(ownerUserId, cacheKey)
  await Promise.all([
    '',
    '.part',
    '.previous',
  ].flatMap((suffix) => [
    Filesystem.deleteFile({ path: `${path}${suffix}`, directory: Directory.Data }).catch(() => undefined),
    Filesystem.deleteFile({ path: `${metadataPath}${suffix}`, directory: Directory.Data }).catch(() => undefined),
  ]))
}

const deleteIndexedDbImage = async (ownerUserId: string, cacheKey: string) => {
  if (!canUseIndexedDb()) {
    return
  }

  const db = await openImageDb()
  try {
    const transaction = db.transaction(imageStoreName, 'readwrite')
    const done = imageTransactionDone(transaction)
    transaction.objectStore(imageStoreName).delete(imageStorageKey(ownerUserId, cacheKey))
    await done
  } finally {
    db.close()
  }
}

const deleteCacheStorageImage = async (ownerUserId: string, url: string) => {
  const storage = cacheStorage()
  if (!storage) {
    return
  }

  try {
    const cache = await storage.open(cacheNameForOwner(ownerUserId))
    await cache.delete(url)
  } catch {
    // The diagnostic cleanup is best-effort.
  }
}

const deletePersistentImage = async (
  ownerUserId: string,
  url: string,
  cacheKey: string,
) => {
  if (nativeImageStorageEnabled) {
    await deleteNativeImage(ownerUserId, cacheKey)
  }

  await deleteIndexedDbImage(ownerUserId, cacheKey).catch(() => undefined)
  await deleteCacheStorageImage(ownerUserId, url)
}

export const runImageCacheSelfTest = async (
  ownerUserId: string,
): Promise<ImageCacheSelfTestResult> => {
  const cacheKey = `diagnostic:cover-storage:${Date.now()}`
  const url = `https://orbital.local/cover-storage-test/${Date.now()}`
  const testBlob = new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
  ], { type: 'image/png' })

  await deletePersistentImage(ownerUserId, url, cacheKey)

  try {
    const beforeSummary = await getImageCacheSummary(ownerUserId)
    const stored = await writePersistentImage(ownerUserId, url, cacheKey, testBlob)
    const readBack = stored
      ? await readPersistentImage(ownerUserId, url, cacheKey)
      : null
    const summary = await getImageCacheSummary(ownerUserId)
    const bytesRead = readBack?.size || 0
    const summaryIncludesTest =
      summary.imageCount >= beforeSummary.imageCount + 1 &&
      summary.storedBytes >= beforeSummary.storedBytes + testBlob.size
    const passed = stored && bytesRead === testBlob.size && summaryIncludesTest

    return {
      passed,
      backend: imageCacheBackends.get(ownerUserId) || summary.backend,
      bytesWritten: testBlob.size,
      bytesRead,
      storedBytes: summary.storedBytes,
      imageCount: summary.imageCount,
      error: passed
        ? null
        : imageCacheWriteErrors.get(ownerUserId) || summary.lastError || (
            stored && bytesRead === testBlob.size && !summaryIncludesTest
              ? 'The cover was read back, but the storage summary could not find it.'
              : 'The cover could not be written and read back.'
          ),
    }
  } catch (error) {
    const summary = await getImageCacheSummary(ownerUserId).catch(() => ({
      storedBytes: 0,
      imageCount: 0,
      persistent: true,
      backend: 'none' as const,
      lastError: null,
    }))

    return {
      passed: false,
      backend: imageCacheBackends.get(ownerUserId) || summary.backend,
      bytesWritten: testBlob.size,
      bytesRead: 0,
      storedBytes: summary.storedBytes,
      imageCount: summary.imageCount,
      error: errorMessage(error, 'The cover storage self-test failed.'),
    }
  } finally {
    await deletePersistentImage(ownerUserId, url, cacheKey)
    notifyImageCacheChanged(ownerUserId)
  }
}

const pumpImageQueue = () => {
  while (activeImageRequests < imageRequestConcurrency && imageQueue.length > 0) {
    imageQueue.sort((left, right) => (
      right.priority - left.priority || left.sequence - right.sequence
    ))
    const item = imageQueue.shift()
    if (!item) {
      return
    }

    activeImageRequests += 1
    item.started = true
    const startedAt = performance.now()
    totalImageQueueWaitMs += Math.max(0, startedAt - item.queuedAt)
    void item.task().then(
      (blob) => {
        const loadMs = Math.max(0, performance.now() - startedAt)
        completedImageLoads += 1
        totalImageLoadMs += loadMs
        lastImageLoadMs = loadMs
        item.resolve(blob)
        activeImageRequests -= 1
        pumpImageQueue()
      },
      (error: unknown) => {
        const loadMs = Math.max(0, performance.now() - startedAt)
        completedImageLoads += 1
        totalImageLoadMs += loadMs
        lastImageLoadMs = loadMs
        item.reject(error)
        activeImageRequests -= 1
        pumpImageQueue()
      },
    )
  }
}

const updateQueuedImagePriority = (key: string, priority: ImageLoadPriority) => {
  const existing = inFlightImages.get(key)
  if (!existing || existing.item.started) {
    return
  }

  existing.item.priority = Math.max(existing.item.priority, imagePriorityValue[priority])
}

const cancelUnobservedImageRequest = (record: ImageRequestRecord) => {
  if (record.item.started || record.managedConsumers > 0 || record.unmanagedConsumer) {
    return
  }

  const queueIndex = imageQueue.indexOf(record.item)
  if (queueIndex >= 0) {
    imageQueue.splice(queueIndex, 1)
  }
  record.item.reject(new DOMException('Image request was cancelled.', 'AbortError'))
}

const enqueueImageRequest = (
  key: string,
  task: () => Promise<Blob>,
  priority: ImageLoadPriority,
  managed: boolean,
) => {
  const existing = inFlightImages.get(key)
  if (existing) {
    existing.managedConsumers += managed ? 1 : 0
    existing.unmanagedConsumer ||= !managed
    updateQueuedImagePriority(key, priority)
    return existing
  }

  let item: ImageQueueItem

  const promise = new Promise<Blob>((resolve, reject) => {
    item = {
      key,
      priority: imagePriorityValue[priority],
      sequence: imageRequestSequence,
      queuedAt: performance.now(),
      started: false,
      reject,
      resolve,
      task,
    }
    imageRequestSequence += 1
    imageQueue.push(item)
    pumpImageQueue()
  })

  const record: ImageRequestRecord = {
    item: item!,
    managedConsumers: managed ? 1 : 0,
    promise,
    unmanagedConsumer: !managed,
  }
  inFlightImages.set(key, record)
  void promise.then(
    () => inFlightImages.delete(key),
    () => inFlightImages.delete(key),
  )

  return record
}

const createCachedImageTask = (
  ownerUserId: string,
  url: string,
  fetcher?: () => Promise<Response>,
  cacheKey = url,
) => {
  return async () => {
    const key = memoryKey(ownerUserId, cacheKey)
    const generation = ownerGeneration(ownerUserId)
    const persistentImage = await readPersistentImage(ownerUserId, url, cacheKey, !fetcher)
    if (persistentImage) {
      persistentImageHits += 1
      if (ownerGeneration(ownerUserId) === generation) {
        rememberImage(key, url, persistentImage)
      }
      return persistentImage
    }

    if (!fetcher) {
      throw new Error('Image is not cached on this device.')
    }

    networkImageLoads += 1
    const response = await fetcher()
    if (!response.ok) {
      throw new Error(`Failed to load image (${response.status})`)
    }

    const blob = await response.blob()
    if (ownerGeneration(ownerUserId) === generation) {
      rememberImage(key, url, blob)
      await writePersistentImage(ownerUserId, url, cacheKey, blob)
    }
    return blob
  }
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
    persistentImageHits += 1
    return Promise.resolve(memoryImage)
  }

  return enqueueImageRequest(
    key,
    createCachedImageTask(ownerUserId, url, fetcher, cacheKey),
    'background',
    false,
  ).promise
}

export const acquireCachedImage = (
  ownerUserId: string,
  url: string,
  fetcher: (() => Promise<Response>) | undefined,
  cacheKey = url,
  priority: ImageLoadPriority = 'nearby',
): CachedImageRequest => {
  const key = memoryKey(ownerUserId, cacheKey)
  const memoryImage = readMemoryImage(key, url, !fetcher)
  if (memoryImage) {
    persistentImageHits += 1
    return {
      promise: Promise.resolve(memoryImage),
      release: () => undefined,
      setPriority: () => undefined,
    }
  }

  const record = enqueueImageRequest(
    key,
    createCachedImageTask(ownerUserId, url, fetcher, cacheKey),
    priority,
    true,
  )
  let released = false

  return {
    promise: record.promise,
    release: () => {
      if (released) {
        return
      }
      released = true
      record.managedConsumers = Math.max(0, record.managedConsumers - 1)
      cancelUnobservedImageRequest(record)
    },
    setPriority: (nextPriority) => updateQueuedImagePriority(key, nextPriority),
  }
}

export const getImageLoadPerformance = (): ImageLoadPerformance => ({
  activeRequests: activeImageRequests,
  averageLoadMs: completedImageLoads ? totalImageLoadMs / completedImageLoads : 0,
  averageQueueWaitMs: completedImageLoads ? totalImageQueueWaitMs / completedImageLoads : 0,
  cacheHits: persistentImageHits,
  completedLoads: completedImageLoads,
  lastLoadMs: lastImageLoadMs,
  networkLoads: networkImageLoads,
  queuedRequests: imageQueue.length,
})

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

  for (const key of [...nativeImageSources.keys()]) {
    if (!ownerUserId || key.startsWith(`${encodeURIComponent(ownerUserId)}:`)) {
      nativeImageSources.delete(key)
    }
  }

  if (ownerUserId) {
    ownerGenerations.set(ownerUserId, (ownerGenerations.get(ownerUserId) || 0) + 1)
    imageCacheWriteErrors.delete(ownerUserId)
    imageCacheBackends.delete(ownerUserId)
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
