const SHELL_CACHE = 'orbital-shell-v1'
const ASSET_CACHE = 'orbital-assets-v1'
const OFFLINE_DB = 'orbital-offline-v1'
const OFFLINE_DB_VERSION = 1
const RESOURCES_STORE = 'resources'

const shellUrls = ['/', '/site.webmanifest']

const openOfflineDb = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB, OFFLINE_DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains('downloads')) {
        const downloads = db.createObjectStore('downloads', { keyPath: 'id' })
        downloads.createIndex('ownerUserId', 'ownerUserId', { unique: false })
        downloads.createIndex('updatedAt', 'updatedAt', { unique: false })
      }

      if (!db.objectStoreNames.contains(RESOURCES_STORE)) {
        const resources = db.createObjectStore(RESOURCES_STORE, { keyPath: 'key' })
        resources.createIndex('downloadId', 'downloadId', { unique: false })
        resources.createIndex('ownerUserId', 'ownerUserId', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open offline database.'))
  })

const readOfflineResource = async (resourceKey) => {
  const db = await openOfflineDb()

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(RESOURCES_STORE, 'readonly')
      const request = transaction.objectStore(RESOURCES_STORE).get(resourceKey)

      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error || new Error('Could not read offline resource.'))
    })
  } finally {
    db.close()
  }
}

const parseRangeHeader = (rangeHeader, size) => {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=') || !Number.isFinite(size) || size < 1) {
    return null
  }

  const [startText = '', endText = ''] = rangeHeader.slice('bytes='.length).split('-', 2)
  const explicitStart = startText.trim()
  const explicitEnd = endText.trim()

  if (!explicitStart && !explicitEnd) {
    return null
  }

  if (!explicitStart) {
    const suffixLength = Number.parseInt(explicitEnd, 10)

    if (!Number.isFinite(suffixLength) || suffixLength < 1) {
      return null
    }

    const start = Math.max(size - suffixLength, 0)
    return { start, end: size - 1 }
  }

  const start = Number.parseInt(explicitStart, 10)
  const requestedEnd = explicitEnd ? Number.parseInt(explicitEnd, 10) : size - 1
  const end = Math.min(requestedEnd, size - 1)

  if (!Number.isFinite(start) || !Number.isFinite(requestedEnd) || start < 0 || start > end || start >= size) {
    return null
  }

  return { start, end }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(shellUrls))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName.startsWith('orbital-') && ![SHELL_CACHE, ASSET_CACHE].includes(cacheName))
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

const cacheFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)

  if (cached) {
    return cached
  }

  const response = await fetch(request)

  if (response.ok) {
    cache.put(request, response.clone()).catch(() => undefined)
  }

  return response
}

const networkFirstDocument = async (request) => {
  const cache = await caches.open(SHELL_CACHE)

  try {
    const response = await fetch(request)
    const contentType = response.headers.get('content-type') || ''

    if (response.ok && contentType.includes('text/html')) {
      cache.put('/', response.clone()).catch(() => undefined)
    }

    return response
  } catch (error) {
    const cached = await cache.match('/') || await cache.match('/index.html')

    if (cached) {
      return cached
    }

    throw error
  }
}

const offlineResourceResponse = async (request, resourceKey) => {
  const record = await readOfflineResource(resourceKey)

  if (!record) {
    return new Response('Offline resource not found on this device.', {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    })
  }

  const size = record.size || record.blob.size || 0
  const contentType = record.resource.contentType || record.blob.type || 'application/octet-stream'
  const baseHeaders = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Length': String(size),
    'Content-Type': contentType,
    'X-Orbital-Offline': 'hit',
  }

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: baseHeaders,
    })
  }

  const range = parseRangeHeader(request.headers.get('Range'), size)

  if (range) {
    const body = record.blob.slice(range.start, range.end + 1, contentType)

    return new Response(body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      },
    })
  }

  return new Response(record.blob, {
    status: 200,
    headers: baseHeaders,
  })
}

self.addEventListener('fetch', (event) => {
  const request = event.request

  if (!['GET', 'HEAD'].includes(request.method)) {
    return
  }

  const url = new URL(request.url)

  if (url.origin !== self.location.origin) {
    return
  }

  if (url.pathname.startsWith('/__orbital_offline/resources/')) {
    const resourceKey = decodeURIComponent(url.pathname.replace('/__orbital_offline/resources/', ''))
    event.respondWith(offlineResourceResponse(request, resourceKey))
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstDocument(request))
    return
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/app-icons/') || url.pathname.startsWith('/pdfjs/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE))
    return
  }

  if (url.pathname === '/site.webmanifest') {
    event.respondWith(cacheFirst(request, SHELL_CACHE))
  }
})
