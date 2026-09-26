import { fetchAuthenticatedResource } from '../authenticatedResource'
import { isLocalAppResourceUrl, isNativeApp, resolveApiUrl } from '../platform'

/**
 * Page images for the comic reader. In the web app the browser cache does the
 * work; the native app authenticates with a header, so pages are fetched into
 * object URLs and kept in a small LRU so prefetched pages appear instantly.
 */

type CachedPage = {
  promise: Promise<string>
  objectUrl: string | null
  pins: number
}

const cache = new Map<string, CachedPage>()
const cacheLimit = 16

const needsBlob = (url: string) => isNativeApp && !isLocalAppResourceUrl(resolveApiUrl(url))

const decodeImage = (src: string) =>
  new Promise<void>((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.src = src

    if (typeof image.decode === 'function') {
      image.decode().then(() => resolve(), () => resolve())
    } else {
      image.onload = () => resolve()
      image.onerror = () => resolve()
    }
  })

const evict = () => {
  if (cache.size <= cacheLimit) {
    return
  }

  for (const [url, entry] of cache) {
    if (cache.size <= cacheLimit) {
      break
    }

    if (entry.pins > 0) {
      continue
    }

    cache.delete(url)

    if (entry.objectUrl) {
      URL.revokeObjectURL(entry.objectUrl)
    }
  }
}

/** Resolves to a displayable, decoded image source. */
export const loadPageImage = (url: string): Promise<string> => {
  const resolved = resolveApiUrl(url)
  const existing = cache.get(resolved)

  if (existing) {
    cache.delete(resolved)
    cache.set(resolved, existing)
    return existing.promise
  }

  const entry: CachedPage = {
    objectUrl: null,
    pins: 0,
    promise: Promise.resolve(''),
  }

  entry.promise = (async () => {
    if (!needsBlob(resolved)) {
      await decodeImage(resolved)
      return resolved
    }

    const response = await fetchAuthenticatedResource(resolved)
    const objectUrl = URL.createObjectURL(await response.blob())
    entry.objectUrl = objectUrl
    await decodeImage(objectUrl)
    return objectUrl
  })()

  entry.promise.catch(() => {
    if (cache.get(resolved) === entry) {
      cache.delete(resolved)
    }
  })

  cache.set(resolved, entry)
  evict()
  return entry.promise
}

export const preloadPageImages = (urls: string[]) => {
  urls.forEach((url) => {
    void loadPageImage(url).catch(() => undefined)
  })
}

/** Keeps an image alive while it is on screen. Returns the release function. */
export const pinPageImage = (url: string) => {
  const entry = cache.get(resolveApiUrl(url))

  if (!entry) {
    return () => undefined
  }

  entry.pins += 1
  return () => {
    entry.pins = Math.max(0, entry.pins - 1)
    evict()
  }
}
