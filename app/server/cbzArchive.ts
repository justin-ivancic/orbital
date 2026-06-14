import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import type { Response } from 'express'
import mime from 'mime-types'

const endOfCentralDirectorySignature = 0x06054b50
const centralDirectoryFileHeaderSignature = 0x02014b50
const localFileHeaderSignature = 0x04034b50
const maxEndOfCentralDirectorySearchBytes = 65557
const maxCentralDirectoryBytes = Number(process.env.APP_CBZ_MAX_CENTRAL_DIRECTORY_BYTES || 64 * 1024 * 1024)
const maxCbzPages = Number(process.env.APP_CBZ_MAX_PAGES || 5000)
const maxCbzEntries = Number(process.env.APP_CBZ_MAX_ENTRIES || 20000)
const maxCbzPageBytes = Number(process.env.APP_CBZ_MAX_PAGE_BYTES || 80 * 1024 * 1024)
const maxManifestCacheEntries = Number(process.env.APP_CBZ_MANIFEST_CACHE_ENTRIES || 32)

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

type ZipCentralDirectory = {
  centralDirectoryOffset: number
  centralDirectorySize: number
  totalEntries: number
}

const manifestCache = new Map<string, CbzArchiveManifest>()

export const getCbzMediaVersion = (stats: Pick<fs.Stats, 'mtimeMs' | 'size'>) =>
  `${Math.round(stats.mtimeMs)}-${stats.size}`

const readFileRange = async (filePath: string, start: number, length: number) => {
  if (length < 0) {
    throw new Error('Invalid CBZ archive structure.')
  }

  const file = await fsPromises.open(filePath, 'r')

  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, start)

    if (bytesRead !== length) {
      throw new Error('Invalid CBZ archive structure.')
    }

    return buffer
  } finally {
    await file.close()
  }
}

const findEndOfCentralDirectory = (tail: Buffer) => {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== endOfCentralDirectorySignature) {
      continue
    }

    const commentLength = tail.readUInt16LE(offset + 20)

    if (offset + 22 + commentLength === tail.length) {
      return offset
    }
  }

  return -1
}

const readCentralDirectoryLocator = async (filePath: string, fileSize: number): Promise<ZipCentralDirectory> => {
  const tailLength = Math.min(fileSize, maxEndOfCentralDirectorySearchBytes)
  const tailStart = fileSize - tailLength
  const tail = await readFileRange(filePath, tailStart, tailLength)
  const eocdOffset = findEndOfCentralDirectory(tail)

  if (eocdOffset < 0) {
    throw new Error('This CBZ file is not a readable ZIP archive.')
  }

  const diskNumber = tail.readUInt16LE(eocdOffset + 4)
  const centralDirectoryDisk = tail.readUInt16LE(eocdOffset + 6)
  const diskEntryCount = tail.readUInt16LE(eocdOffset + 8)
  const totalEntries = tail.readUInt16LE(eocdOffset + 10)
  const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12)
  const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16)

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== totalEntries) {
    throw new Error('Multi-part CBZ archives are not supported.')
  }

  if (
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 CBZ archives are not supported yet.')
  }

  if (totalEntries > maxCbzEntries || centralDirectorySize > maxCentralDirectoryBytes) {
    throw new Error('This CBZ archive is too large to index safely.')
  }

  if (
    centralDirectoryOffset < 0 ||
    centralDirectorySize < 0 ||
    centralDirectoryOffset + centralDirectorySize > fileSize
  ) {
    throw new Error('Invalid CBZ central directory.')
  }

  return {
    centralDirectoryOffset,
    centralDirectorySize,
    totalEntries,
  }
}

const isUnsafeArchiveName = (name: string) => {
  const normalizedName = name.replace(/\\/g, '/')

  return (
    normalizedName.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalizedName) ||
    normalizedName.split('/').some((part) => part === '..')
  )
}

const getImageContentType = (name: string) => {
  const extension = path.extname(name).toLowerCase()

  if (!supportedImageExtensions.has(extension)) {
    return null
  }

  const contentType = mime.lookup(name) || 'application/octet-stream'

  return supportedImageMimeTypes.has(contentType) ? contentType : null
}

const parseCbzCentralDirectory = async (
  filePath: string,
  stats: fs.Stats,
): Promise<CbzArchivePage[]> => {
  const locator = await readCentralDirectoryLocator(filePath, stats.size)
  const centralDirectory = await readFileRange(
    filePath,
    locator.centralDirectoryOffset,
    locator.centralDirectorySize,
  )
  const pages: CbzArchivePage[] = []
  let offset = 0

  for (let entryIndex = 0; entryIndex < locator.totalEntries; entryIndex += 1) {
    if (offset + 46 > centralDirectory.length) {
      throw new Error('Invalid CBZ central directory entry.')
    }

    if (centralDirectory.readUInt32LE(offset) !== centralDirectoryFileHeaderSignature) {
      throw new Error('Invalid CBZ central directory entry.')
    }

    const flags = centralDirectory.readUInt16LE(offset + 8)
    const compressionMethod = centralDirectory.readUInt16LE(offset + 10)
    const compressedSize = centralDirectory.readUInt32LE(offset + 20)
    const uncompressedSize = centralDirectory.readUInt32LE(offset + 24)
    const fileNameLength = centralDirectory.readUInt16LE(offset + 28)
    const extraLength = centralDirectory.readUInt16LE(offset + 30)
    const commentLength = centralDirectory.readUInt16LE(offset + 32)
    const diskNumberStart = centralDirectory.readUInt16LE(offset + 34)
    const localHeaderOffset = centralDirectory.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const nameEnd = nameStart + fileNameLength
    const entryEnd = nameEnd + extraLength + commentLength

    if (entryEnd > centralDirectory.length) {
      throw new Error('Invalid CBZ central directory entry.')
    }

    const name = centralDirectory.subarray(nameStart, nameEnd).toString('utf8')
    offset = entryEnd

    if (!name || name.endsWith('/')) {
      continue
    }

    if (isUnsafeArchiveName(name)) {
      throw new Error('CBZ archives cannot contain path traversal entries.')
    }

    const contentType = getImageContentType(name)

    if (!contentType) {
      continue
    }

    if (flags & 0x1) {
      throw new Error('Encrypted CBZ image entries are not supported.')
    }

    if (diskNumberStart !== 0) {
      throw new Error('Multi-part CBZ archives are not supported.')
    }

    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error('Unsupported CBZ image compression method.')
    }

    if (compressedSize === 0 || uncompressedSize === 0 || uncompressedSize > maxCbzPageBytes) {
      throw new Error('This CBZ page is too large or empty to serve safely.')
    }

    if (
      localHeaderOffset >= stats.size ||
      compressedSize > stats.size ||
      localHeaderOffset + compressedSize > stats.size
    ) {
      throw new Error('Invalid CBZ page offset.')
    }

    pages.push({
      pageNumber: pages.length + 1,
      archiveIndex: pages.length,
      name,
      fileName: path.posix.basename(name.replace(/\\/g, '/')),
      contentType,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })

    if (pages.length > maxCbzPages) {
      throw new Error('This CBZ archive has too many pages to index safely.')
    }
  }

  if (pages.length === 0) {
    throw new Error('No readable image pages found in this CBZ file.')
  }

  return pages
}

export const loadCbzArchiveManifest = async (
  filePath: string,
  stats: fs.Stats,
): Promise<CbzArchiveManifest> => {
  const normalizedPath = path.resolve(filePath)
  const version = getCbzMediaVersion(stats)
  const cacheKey = `${normalizedPath}:${version}`
  const cachedManifest = manifestCache.get(cacheKey)

  if (cachedManifest) {
    manifestCache.delete(cacheKey)
    manifestCache.set(cacheKey, cachedManifest)
    return cachedManifest
  }

  const pages = await parseCbzCentralDirectory(normalizedPath, stats)
  const manifest = {
    version,
    pageCount: pages.length,
    pages,
  }

  manifestCache.set(cacheKey, manifest)

  while (manifestCache.size > maxManifestCacheEntries) {
    const oldestKey = manifestCache.keys().next().value as string | undefined

    if (!oldestKey) {
      break
    }

    manifestCache.delete(oldestKey)
  }

  return manifest
}

const readLocalFileDataOffset = async (filePath: string, page: CbzArchivePage) => {
  const header = await readFileRange(filePath, page.localHeaderOffset, 30)

  if (header.readUInt32LE(0) !== localFileHeaderSignature) {
    throw new Error('Invalid CBZ local file header.')
  }

  const fileNameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)

  return page.localHeaderOffset + 30 + fileNameLength + extraLength
}

export const openCbzPageImageStream = async (filePath: string, page: CbzArchivePage) => {
  const dataOffset = await readLocalFileDataOffset(filePath, page)
  const compressedStream = fs.createReadStream(filePath, {
    start: dataOffset,
    end: dataOffset + page.compressedSize - 1,
  })

  if (page.compressionMethod === 0) {
    return compressedStream
  }

  return compressedStream.pipe(zlib.createInflateRaw())
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

const waitForResponseDrain = (response: Response) =>
  new Promise<void>((resolve) => {
    response.once('drain', resolve)
  })

const writeResponseChunk = async (response: Response, chunk: Buffer) => {
  if (!response.write(chunk)) {
    await waitForResponseDrain(response)
  }
}

const setCbzImageResponseHeaders = (response: Response, page: CbzArchivePage) => {
  response.status(200)
  response.setHeader('Content-Type', page.contentType)
  response.setHeader('Content-Length', page.uncompressedSize)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(page.fileName)}`)
}

export const sendCbzPageImage = async (
  response: Response,
  filePath: string,
  page: CbzArchivePage,
) => {
  const stream = await openCbzPageImageStream(filePath, page)
  let sniffBuffer = Buffer.alloc(0)
  let headersWritten = false

  try {
    for await (const chunk of stream as Readable) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

      if (!headersWritten) {
        sniffBuffer = Buffer.concat([sniffBuffer, buffer])

        if (sniffBuffer.length < 16) {
          continue
        }

        if (!imageMagicMatches(sniffBuffer, page.contentType)) {
          throw new Error('The requested CBZ page is not a supported image.')
        }

        setCbzImageResponseHeaders(response, page)
        headersWritten = true
        await writeResponseChunk(response, sniffBuffer)
        continue
      }

      await writeResponseChunk(response, buffer)
    }

    if (!headersWritten) {
      if (!imageMagicMatches(sniffBuffer, page.contentType)) {
        throw new Error('The requested CBZ page is not a supported image.')
      }

      setCbzImageResponseHeaders(response, page)
      headersWritten = true
      await writeResponseChunk(response, sniffBuffer)
    }

    response.end()
  } catch (error) {
    if (!response.headersSent) {
      throw error
    }

    response.destroy(error instanceof Error ? error : new Error('Failed to stream CBZ page.'))
  }
}
