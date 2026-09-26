import type fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { Response } from 'express'
import mime from 'mime-types'
import {
  assertReadableZipEntry,
  isUnsafeZipEntryName,
  readZipDirectory,
  readZipEntries,
  readZipEntry,
  withFileHandle,
  ZipFormatError,
  type ZipEntry,
} from './zipArchive'

const maxCentralDirectoryBytes = Number(process.env.APP_CBZ_MAX_CENTRAL_DIRECTORY_BYTES || 64 * 1024 * 1024)
const maxCbzPages = Number(process.env.APP_CBZ_MAX_PAGES || 5000)
const maxCbzEntries = Number(process.env.APP_CBZ_MAX_ENTRIES || 20000)
const maxCbzPageBytes = Number(process.env.APP_CBZ_MAX_PAGE_BYTES || 80 * 1024 * 1024)
const maxManifestCacheEntries = Number(process.env.APP_CBZ_MANIFEST_CACHE_ENTRIES || 128)
const maxPageCacheBytes = Number(process.env.APP_CBZ_PAGE_CACHE_MB || 96) * 1024 * 1024
const defaultReadAheadPages = Number(process.env.APP_CBZ_READ_AHEAD_PAGES || 4)
const maxReadAheadBytes = 16 * 1024 * 1024

const supportedImageExtensions = new Set(['.avif', '.gif', '.jpg', '.jpeg', '.png', '.webp'])
const supportedImageMimeTypes = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export type CbzArchivePage = {
  pageNumber: number
  archiveIndex: number
  name: string
  fileName: string
  contentType: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export type CbzArchiveManifest = {
  version: string
  pageCount: number
  pages: CbzArchivePage[]
}

type FileVersion = Pick<fs.Stats, 'mtimeMs' | 'size'>

const manifestCache = new Map<string, CbzArchiveManifest>()
const manifestLoads = new Map<string, Promise<CbzArchiveManifest>>()
const pageCache = new Map<string, Buffer>()
const pageLoads = new Map<string, Promise<Buffer>>()
let pageCacheBytes = 0

export const getCbzMediaVersion = (stats: FileVersion) =>
  `${Math.floor(stats.mtimeMs)}-${stats.size}`

const getImageContentType = (name: string) => {
  const extension = path.extname(name).toLowerCase()

  if (!supportedImageExtensions.has(extension)) {
    return null
  }

  const contentType = mime.lookup(name) || 'application/octet-stream'
  return supportedImageMimeTypes.has(contentType) ? contentType : null
}

const toCbzError = (error: unknown) =>
  error instanceof ZipFormatError ? new Error(`CBZ: ${error.message}`) : error

const buildManifest = async (filePath: string, stats: FileVersion): Promise<CbzArchiveManifest> => {
  const entries = await withFileHandle(filePath, (handle) =>
    readZipDirectory(handle, stats.size, {
      maxCentralDirectoryBytes,
      maxEntries: maxCbzEntries,
    }),
  ).catch((error: unknown) => {
    if (error instanceof ZipFormatError && /not a readable ZIP/.test(error.message)) {
      throw new Error('This CBZ file is not a readable ZIP archive.')
    }
    throw toCbzError(error)
  })
  const pages: CbzArchivePage[] = []

  for (const entry of entries) {
    if (!entry.name || entry.name.endsWith('/')) {
      continue
    }

    if (isUnsafeZipEntryName(entry.name)) {
      throw new Error('CBZ archives cannot contain path traversal entries.')
    }

    const contentType = getImageContentType(entry.name)
    if (!contentType) {
      continue
    }

    if (entry.compressedSize === 0 || entry.uncompressedSize === 0) {
      throw new Error('This CBZ page is too large or empty to serve safely.')
    }

    try {
      assertReadableZipEntry(entry, stats.size, maxCbzPageBytes)
    } catch (error) {
      throw toCbzError(error)
    }

    pages.push({
      pageNumber: pages.length + 1,
      archiveIndex: pages.length,
      name: entry.name,
      fileName: path.posix.basename(entry.name.replace(/\\/g, '/')),
      contentType,
      compressionMethod: entry.compressionMethod,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      localHeaderOffset: entry.localHeaderOffset,
    })

    if (pages.length > maxCbzPages) {
      throw new Error('This CBZ archive has too many pages to index safely.')
    }
  }

  if (pages.length === 0) {
    throw new Error('No readable image pages found in this CBZ file.')
  }

  return {
    version: getCbzMediaVersion(stats),
    pageCount: pages.length,
    pages,
  }
}

export const loadCbzArchiveManifest = async (
  filePath: string,
  stats: FileVersion,
): Promise<CbzArchiveManifest> => {
  const normalizedPath = path.resolve(filePath)
  const cacheKey = `${normalizedPath}:${getCbzMediaVersion(stats)}`
  const cachedManifest = manifestCache.get(cacheKey)

  if (cachedManifest) {
    manifestCache.delete(cacheKey)
    manifestCache.set(cacheKey, cachedManifest)
    return cachedManifest
  }

  const pending = manifestLoads.get(cacheKey)
  if (pending) {
    return pending
  }

  const load = buildManifest(normalizedPath, stats)
    .then((manifest) => {
      manifestCache.set(cacheKey, manifest)
      while (manifestCache.size > maxManifestCacheEntries) {
        const oldestKey = manifestCache.keys().next().value as string | undefined
        if (!oldestKey) {
          break
        }
        manifestCache.delete(oldestKey)
      }
      return manifest
    })
    .finally(() => manifestLoads.delete(cacheKey))

  manifestLoads.set(cacheKey, load)
  return load
}

const pageCacheKey = (filePath: string, version: string, page: CbzArchivePage) =>
  `${path.resolve(filePath)}:${version}:${page.pageNumber}`

const pageAsZipEntry = (page: CbzArchivePage): ZipEntry => ({
  index: page.archiveIndex,
  name: page.name,
  flags: 0,
  compressionMethod: page.compressionMethod,
  compressedSize: page.compressedSize,
  uncompressedSize: page.uncompressedSize,
  localHeaderOffset: page.localHeaderOffset,
})

const rememberPage = (key: string, bytes: Buffer) => {
  if (bytes.length > maxPageCacheBytes / 4) {
    return
  }

  const previous = pageCache.get(key)
  if (previous) {
    pageCacheBytes -= previous.length
    pageCache.delete(key)
  }

  pageCache.set(key, bytes)
  pageCacheBytes += bytes.length

  while (pageCacheBytes > maxPageCacheBytes) {
    const oldestKey = pageCache.keys().next().value as string | undefined
    if (!oldestKey) {
      break
    }
    pageCacheBytes -= pageCache.get(oldestKey)?.length ?? 0
    pageCache.delete(oldestKey)
  }
}

const readCachedPage = (key: string) => {
  const cached = pageCache.get(key)
  if (cached) {
    pageCache.delete(key)
    pageCache.set(key, cached)
  }
  return cached
}

const scheduleReadAhead = (
  filePath: string,
  stats: FileVersion,
  manifest: CbzArchiveManifest,
  page: CbzArchivePage,
  count: number,
) => {
  if (count <= 0) {
    return
  }

  const candidates = manifest.pages
    .slice(page.pageNumber, page.pageNumber + count)
    .filter((candidate) => {
      const key = pageCacheKey(filePath, manifest.version, candidate)
      return !pageCache.has(key) && !pageLoads.has(key)
    })

  if (!candidates.length) {
    return
  }

  const load = withFileHandle(filePath, (handle) =>
    readZipEntries(handle, stats.size, candidates.map(pageAsZipEntry), maxReadAheadBytes),
  )

  for (const candidate of candidates) {
    const key = pageCacheKey(filePath, manifest.version, candidate)
    const pagePromise = load.then((results) => {
      const bytes = results.get(candidate.archiveIndex)
      if (!bytes) {
        throw new Error('Read-ahead did not return the requested page.')
      }
      rememberPage(key, bytes)
      return bytes
    })
    pageLoads.set(key, pagePromise)
    void pagePromise.catch(() => undefined).finally(() => pageLoads.delete(key))
  }
}

/**
 * Returns the decoded bytes of one page. Pages are cached by archive version,
 * concurrent requests share one read, and the next pages are warmed in the
 * background so sequential reading on a slow mount stays responsive.
 */
export const readCbzPage = async (
  filePath: string,
  stats: FileVersion,
  manifest: CbzArchiveManifest,
  page: CbzArchivePage,
  options: { readAhead?: number } = {},
) => {
  const key = pageCacheKey(filePath, manifest.version, page)
  const readAhead = options.readAhead ?? defaultReadAheadPages
  const cached = readCachedPage(key)

  if (cached) {
    scheduleReadAhead(filePath, stats, manifest, page, readAhead)
    return cached
  }

  let pending = pageLoads.get(key)
  if (!pending) {
    pending = withFileHandle(filePath, (handle) => readZipEntry(handle, stats.size, pageAsZipEntry(page)))
      .then((bytes) => {
        rememberPage(key, bytes)
        return bytes
      })
      .catch((error: unknown) => {
        throw toCbzError(error)
      })
    pageLoads.set(key, pending)
    void pending.catch(() => undefined).finally(() => pageLoads.delete(key))
  }

  const bytes = await pending
  scheduleReadAhead(filePath, stats, manifest, page, readAhead)
  return bytes
}

const imageMagicMatches = (buffer: Buffer, contentType: string) => {
  if (contentType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  }

  if (contentType === 'image/png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  }

  if (contentType === 'image/gif') {
    return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
  }

  if (contentType === 'image/webp') {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  }

  if (contentType === 'image/avif') {
    return (
      buffer.length >= 12 &&
      buffer.subarray(4, 8).toString('ascii') === 'ftyp' &&
      buffer.subarray(8, Math.min(buffer.length, 32)).includes(Buffer.from('avif'))
    )
  }

  return false
}

export const assertCbzPageImage = (bytes: Buffer, page: CbzArchivePage) => {
  if (!imageMagicMatches(bytes, page.contentType)) {
    throw new Error('The requested CBZ page is not a supported image.')
  }
}

/** Writes a fully read page with exact length headers. */
export const sendCbzPageBytes = (response: Response, page: CbzArchivePage, bytes: Buffer, headOnly = false) => {
  assertCbzPageImage(bytes, page)
  response.status(200)
  response.setHeader('Content-Type', page.contentType)
  response.setHeader('Content-Length', bytes.length)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(page.fileName)}`)

  if (headOnly) {
    response.end()
    return
  }

  response.end(bytes)
}

/** Reads a page and streams it; kept for callers that expect a stream. */
export const openCbzPageImageStream = async (filePath: string, page: CbzArchivePage) => {
  const bytes = await withFileHandle(filePath, async (handle) => {
    const stats = await handle.stat()
    return readZipEntry(handle, stats.size, pageAsZipEntry(page))
  })
  return Readable.from([bytes])
}

const naturalCompare = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })

/** The cover is the first page by natural file name, which matches how most archives are authored. */
export const selectCbzCoverPage = (manifest: CbzArchiveManifest) =>
  [...manifest.pages].sort((left, right) => naturalCompare(left.name, right.name))[0] ?? null

export const getCbzPageCacheStats = () => ({
  bytes: pageCacheBytes,
  pages: pageCache.size,
  manifests: manifestCache.size,
})
