const imageCacheNamePrefix = 'orbital-images-v1'
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

const readPersistentImage = async (ownerUserId: string, url: string) => {
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

const writePersistentImage = async (
  ownerUserId: string,
  url: string,
  blob: Blob,
) => {
  const storage = cacheStorage()
  if (!storage) {
    return
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
  } catch {
    // Image persistence is an optimization; a storage failure must not block rendering.
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
}
