import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Request, Response } from 'express'
import mime from 'mime-types'

// Larger reads mean fewer round-trips when media lives on a network mount.
const mediaReadChunkBytes = 512 * 1024

export type ByteRange = {
  start: number
  end: number
}

export const parseRangeHeader = (rangeHeader: string, fileSize: number): ByteRange | null => {
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)

  if (!match) {
    return null
  }

  const startText = match[1] || ''
  const endText = match[2] || ''

  if (!startText && !endText) {
    return null
  }

  if (!startText) {
    const suffixLength = Number(endText)

    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null
    }

    return { start: Math.max(fileSize - suffixLength, 0), end: fileSize - 1 }
  }

  const start = Number(startText)
  const requestedEnd = endText ? Number(endText) : fileSize - 1
  const end = Math.min(requestedEnd, fileSize - 1)

  if (!Number.isFinite(start) || !Number.isFinite(requestedEnd) || start > end || start < 0) {
    return null
  }

  return { start, end }
}

export const buildMediaEntityTag = (stats: Pick<fs.Stats, 'mtimeMs' | 'size'>) =>
  `"${Math.round(stats.mtimeMs).toString(36)}-${stats.size.toString(36)}"`

const requestMatchesValidators = (request: Request, stats: fs.Stats, entityTag: string) => {
  const ifNoneMatch = request.get('if-none-match')

  if (ifNoneMatch) {
    return ifNoneMatch.split(',').map((value) => value.trim()).includes(entityTag)
  }

  const ifModifiedSince = request.get('if-modified-since')
  if (!ifModifiedSince) {
    return false
  }

  const modifiedSince = Date.parse(ifModifiedSince)
  return Number.isFinite(modifiedSince) && Math.floor(stats.mtimeMs / 1000) <= Math.floor(modifiedSince / 1000)
}

export const isClientAbortError = (error: unknown) =>
  Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      ['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'EPIPE', 'ERR_STREAM_DESTROYED'].includes(
        String((error as { code?: unknown }).code),
      ),
  )

/**
 * Streams a file (or a byte range of it) with conditional-request support.
 * `pipeline` closes the file descriptor on client aborts and turns read errors
 * from a flaky mount into a destroyed response instead of a process crash.
 */
export const sendMediaFile = async (
  request: Request,
  response: Response,
  filePath: string,
  options: {
    stats?: fs.Stats
    contentType?: string
    rangeHeader?: string
    fileName?: string
    disposition?: 'inline' | 'attachment'
  } = {},
) => {
  const stats = options.stats ?? await fs.promises.stat(filePath)
  const contentType = options.contentType || mime.lookup(filePath) || 'application/octet-stream'
  const entityTag = buildMediaEntityTag(stats)

  if (!response.hasHeader('Cache-Control')) {
    response.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate, no-transform')
  }

  response.setHeader('Accept-Ranges', 'bytes')
  response.setHeader('ETag', entityTag)
  response.setHeader('Last-Modified', stats.mtime.toUTCString())
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Vary', 'Cookie, Authorization')
  response.setHeader(
    'Content-Disposition',
    `${options.disposition ?? 'inline'}; filename*=UTF-8''${encodeURIComponent(options.fileName ?? path.basename(filePath))}`,
  )

  const rangeHeader = options.rangeHeader

  if (!rangeHeader && requestMatchesValidators(request, stats, entityTag)) {
    response.status(304).end()
    return
  }

  let start = 0
  let end = stats.size - 1

  if (rangeHeader) {
    const range = parseRangeHeader(rangeHeader, stats.size)

    if (!range) {
      response.status(416).setHeader('Content-Range', `bytes */${stats.size}`).end()
      return
    }

    start = range.start
    end = range.end
    response.status(206)
    response.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`)
  } else {
    response.status(200)
  }

  response.setHeader('Content-Type', contentType)
  response.setHeader('Content-Length', stats.size === 0 ? 0 : end - start + 1)

  if (request.method === 'HEAD' || stats.size === 0) {
    response.end()
    return
  }

  try {
    await pipeline(
      fs.createReadStream(filePath, { start, end, highWaterMark: mediaReadChunkBytes }),
      response,
    )
  } catch (error) {
    if (!isClientAbortError(error)) {
      console.warn(`Media stream failed for ${path.basename(filePath)}: ${error instanceof Error ? error.message : error}`)
    }

    if (!response.destroyed) {
      response.destroy()
    }
  }
}
