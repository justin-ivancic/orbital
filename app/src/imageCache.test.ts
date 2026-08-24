import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acquireCachedImage,
  clearImageCache,
  getImageCacheSummary,
  loadCachedImage,
  runImageCacheSelfTest,
} from './imageCache.ts'

class TestCache {
  private readonly responses = new Map<string, Response>()

  private key(request: RequestInfo | URL) {
    return typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
  }

  async match(request: RequestInfo | URL) {
    return this.responses.get(this.key(request))?.clone()
  }

  async put(request: RequestInfo | URL, response: Response) {
    this.responses.set(this.key(request), response.clone())
  }

  async delete(request: RequestInfo | URL) {
    return this.responses.delete(this.key(request))
  }

  async keys() {
    return [...this.responses.keys()].map((url) => new Request(url))
  }
}

class TestCacheStorage {
  readonly cache = new TestCache()

  async open() {
    return this.cache
  }

  async delete() {
    return true
  }

  async keys() {
    return []
  }
}

const responseFor = (value: string) =>
  new Response(new Blob([value], { type: 'image/png' }), {
    headers: { 'Content-Type': 'image/png' },
    status: 200,
  })

test('persists the first cover loaded for a fresh user', async () => {
  const ownerUserId = 'image-cache-fresh-user'
  const url = 'https://example.test/api/media/cover/first?v=1'
  const storage = new TestCacheStorage()
  const previousWindow = (globalThis as { window?: unknown }).window

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { caches: storage },
  })

  try {
    // Deliberately do not initialize this owner with clearImageCache. A fresh
    // installation has no generation entry, which used to skip the write.
    await loadCachedImage(ownerUserId, url, async () => responseFor('first-cover'))

    const summary = await getImageCacheSummary(ownerUserId)
    assert.equal(summary.imageCount, 1)
    assert.equal(summary.storedBytes, 11)
  } finally {
    await clearImageCache(ownerUserId)
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
      })
    }
  }
})

test('deduplicates concurrent requests for the same image', async () => {
  const ownerUserId = 'image-cache-dedupe-user'
  const url = 'https://example.test/api/media/cover/one?v=1'
  let requestCount = 0
  let releaseRequest: (value?: void | PromiseLike<void>) => void = () => undefined
  const requestReleased = new Promise<void>((resolve) => {
    releaseRequest = resolve
  })

  const fetcher = async () => {
    requestCount += 1
    await requestReleased
    return responseFor('cover')
  }

  const first = loadCachedImage(ownerUserId, url, fetcher)
  const second = loadCachedImage(ownerUserId, url, fetcher)

  assert.strictEqual(first, second)
  releaseRequest()

  const [firstBlob, secondBlob] = await Promise.all([first, second])
  assert.equal(requestCount, 1)
  assert.equal(firstBlob.size, secondBlob.size)
  await clearImageCache(ownerUserId)
})

test('limits simultaneous image requests', async () => {
  const ownerUserId = 'image-cache-concurrency-user'
  let activeRequests = 0
  let peakRequests = 0

  const requests = Array.from({ length: 8 }, (_, index) =>
    loadCachedImage(
      ownerUserId,
      `https://example.test/api/media/cover/${index}?v=1`,
      async () => {
        activeRequests += 1
        peakRequests = Math.max(peakRequests, activeRequests)
        await new Promise((resolve) => setTimeout(resolve, 5))
        activeRequests -= 1
        return responseFor(`cover-${index}`)
      },
    ),
  )

  await Promise.all(requests)
  assert.ok(peakRequests <= 3)
  await clearImageCache(ownerUserId)
})

test('loads visible covers before older nearby covers waiting in the queue', async () => {
  const ownerUserId = 'image-cache-priority-user'
  let releaseBlockers: (value?: void | PromiseLike<void>) => void = () => undefined
  const blockersReleased = new Promise<void>((resolve) => {
    releaseBlockers = resolve
  })
  const startOrder: string[] = []

  const blockers = Array.from({ length: 3 }, (_, index) => loadCachedImage(
    ownerUserId,
    `https://example.test/api/media/cover/blocker-${index}`,
    async () => {
      await blockersReleased
      return responseFor(`blocker-${index}`)
    },
  ))
  const nearby = acquireCachedImage(
    ownerUserId,
    'https://example.test/api/media/cover/nearby',
    async () => {
      startOrder.push('nearby')
      return responseFor('nearby')
    },
    'cover:nearby',
    'nearby',
  )
  const visible = acquireCachedImage(
    ownerUserId,
    'https://example.test/api/media/cover/visible',
    async () => {
      startOrder.push('visible')
      return responseFor('visible')
    },
    'cover:visible',
    'visible',
  )

  releaseBlockers()
  await Promise.all([...blockers, nearby.promise, visible.promise])

  assert.deepEqual(startOrder, ['visible', 'nearby'])
  nearby.release()
  visible.release()
  await clearImageCache(ownerUserId)
})

test('drops an unobserved cover request before it starts', async () => {
  const ownerUserId = 'image-cache-cancel-user'
  let releaseBlockers: (value?: void | PromiseLike<void>) => void = () => undefined
  const blockersReleased = new Promise<void>((resolve) => {
    releaseBlockers = resolve
  })
  let cancelledFetcherRan = false

  const blockers = Array.from({ length: 3 }, (_, index) => loadCachedImage(
    ownerUserId,
    `https://example.test/api/media/cover/cancel-blocker-${index}`,
    async () => {
      await blockersReleased
      return responseFor(`blocker-${index}`)
    },
  ))
  const cancelled = acquireCachedImage(
    ownerUserId,
    'https://example.test/api/media/cover/cancelled',
    async () => {
      cancelledFetcherRan = true
      return responseFor('cancelled')
    },
    'cover:cancelled',
  )

  cancelled.release()
  await assert.rejects(cancelled.promise, { name: 'AbortError' })
  releaseBlockers()
  await Promise.all(blockers)

  assert.equal(cancelledFetcherRan, false)
  await clearImageCache(ownerUserId)
})

test('uses a fresh image from persistent cache before fetching the network', async () => {
  const ownerUserId = 'image-cache-persistent-user'
  const url = 'https://example.test/api/media/cover/persisted?v=1'
  const storage = new TestCacheStorage()
  const previousWindow = (globalThis as { window?: unknown }).window

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { caches: storage },
  })

  try {
    await clearImageCache(ownerUserId)
    await storage.cache.put(
      url,
      new Response(new Blob(['persisted'], { type: 'image/png' }), {
        headers: {
          'Content-Type': 'image/png',
          'X-Orbital-Accessed-At': String(Date.now()),
          'X-Orbital-Cached-At': String(Date.now()),
          'X-Orbital-Size': '8',
        },
      }),
    )

    let requestCount = 0
    const blob = await loadCachedImage(ownerUserId, url, async () => {
      requestCount += 1
      return responseFor('network')
    })

    assert.equal(requestCount, 0)
    assert.equal(await blob.text(), 'persisted')
  } finally {
    await clearImageCache(ownerUserId)
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
      })
    }
  }
})

test('reports persisted cover bytes and count for storage management', async () => {
  const ownerUserId = 'image-cache-summary-user'
  const url = 'https://example.test/api/media/cover/summary?v=1'
  const storage = new TestCacheStorage()
  const previousWindow = (globalThis as { window?: unknown }).window

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { caches: storage },
  })

  try {
    await clearImageCache(ownerUserId)
    await storage.cache.put(
      url,
      new Response(new Blob(['persisted-cover'], { type: 'image/png' }), {
        headers: {
          'Content-Type': 'image/png',
          'X-Orbital-Accessed-At': String(Date.now()),
          'X-Orbital-Cached-At': String(Date.now()),
          'X-Orbital-Size': '15',
        },
      }),
    )

    assert.deepEqual(await getImageCacheSummary(ownerUserId), {
      storedBytes: 15,
      imageCount: 1,
      persistent: true,
      backend: 'cache-storage',
      lastWriteError: null,
      lastError: null,
    })
  } finally {
    await clearImageCache(ownerUserId)
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
      })
    }
  }
})

test('updates persistent cover storage after a cover is loaded', async () => {
  const ownerUserId = 'image-cache-write-summary-user'
  const url = 'https://example.test/api/media/cover/write-summary?v=1'
  const storage = new TestCacheStorage()
  const previousWindow = (globalThis as { window?: unknown }).window

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { caches: storage },
  })

  try {
    await clearImageCache(ownerUserId)
    await loadCachedImage(ownerUserId, url, async () => responseFor('stored-cover'))

    const summary = await getImageCacheSummary(ownerUserId)
    assert.equal(summary.imageCount, 1)
    assert.ok(summary.storedBytes > 0)
    assert.equal(summary.lastWriteError, null)
  } finally {
    await clearImageCache(ownerUserId)
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
      })
    }
  }
})

test('runs a verified cover storage self-test without leaving a diagnostic image', async () => {
  const ownerUserId = 'image-cache-self-test-user'
  const storage = new TestCacheStorage()
  const previousWindow = (globalThis as { window?: unknown }).window

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { caches: storage },
  })

  try {
    await clearImageCache(ownerUserId)
    const result = await runImageCacheSelfTest(ownerUserId)

    assert.equal(result.passed, true)
    assert.equal(result.backend, 'cache-storage')
    assert.equal(result.bytesRead, result.bytesWritten)
    assert.equal((await getImageCacheSummary(ownerUserId)).imageCount, 0)
  } finally {
    await clearImageCache(ownerUserId)
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
      })
    }
  }
})

test('stable cover identities survive a media URL change in offline mode', async () => {
  const ownerUserId = 'image-cache-stable-cover-user'
  const firstUrl = 'https://example.test/api/media/cover/stable?v=1'
  const refreshedUrl = 'https://example.test/api/media/cover/stable?v=2'
  const cacheKey = 'cover:stable-series'

  await clearImageCache(ownerUserId)
  await loadCachedImage(ownerUserId, firstUrl, async () => responseFor('cached-cover'), cacheKey)

  const offlineBlob = await loadCachedImage(ownerUserId, refreshedUrl, undefined, cacheKey)
  assert.equal(await offlineBlob.text(), 'cached-cover')

  let requestCount = 0
  const refreshedBlob = await loadCachedImage(
    ownerUserId,
    refreshedUrl,
    async () => {
      requestCount += 1
      return responseFor('refreshed-cover')
    },
    cacheKey,
  )

  assert.equal(requestCount, 1)
  assert.equal(await refreshedBlob.text(), 'refreshed-cover')
  await clearImageCache(ownerUserId)
})

test('offline image reads fail locally without attempting a network request', async () => {
  const ownerUserId = 'image-cache-offline-user'
  const url = 'https://example.test/api/media/cover/not-cached?v=1'

  await assert.rejects(
    loadCachedImage(ownerUserId, url),
    /Image is not cached on this device\./,
  )
})
