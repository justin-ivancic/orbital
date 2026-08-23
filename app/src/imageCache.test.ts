import assert from 'node:assert/strict'
import test from 'node:test'
import { clearImageCache, loadCachedImage } from './imageCache.ts'

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

test('offline image reads fail locally without attempting a network request', async () => {
  const ownerUserId = 'image-cache-offline-user'
  const url = 'https://example.test/api/media/cover/not-cached?v=1'

  await assert.rejects(
    loadCachedImage(ownerUserId, url),
    /Image is not cached on this device\./,
  )
})
