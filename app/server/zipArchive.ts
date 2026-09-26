import fsPromises, { type FileHandle } from 'node:fs/promises'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

const inflateRaw = promisify(zlib.inflateRaw)

const endOfCentralDirectorySignature = 0x06054b50
const centralDirectoryFileHeaderSignature = 0x02014b50
const localFileHeaderSignature = 0x04034b50
const localFileHeaderLength = 30
const maxEndOfCentralDirectorySearchBytes = 65557
// Local extra fields may be longer than the central copy; over-read this much
// so a single read normally covers the header, name, extra field, and data.
const localHeaderSlackBytes = 1024
// Neighbouring entries closer than this are fetched with one read.
const coalesceGapBytes = 64 * 1024

export type ZipLimits = {
  maxCentralDirectoryBytes: number
  maxEntries: number
}

export type ZipEntry = {
  index: number
  name: string
  flags: number
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipFormatError'
  }
}

const readExactly = async (handle: FileHandle, position: number, length: number) => {
  if (length < 0) {
    throw new ZipFormatError('Invalid ZIP archive structure.')
  }

  const buffer = Buffer.alloc(length)
  let offset = 0

  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset)
    if (bytesRead === 0) {
      break
    }
    offset += bytesRead
  }

  return offset === length ? buffer : buffer.subarray(0, offset)
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

/**
 * Reads a ZIP central directory with two reads (tail + directory) and never
 * inflates entry data. ZIP64, multi-disk, and encrypted archives are rejected
 * by the callers that need their data.
 */
export const readZipDirectory = async (
  handle: FileHandle,
  fileSize: number,
  limits: ZipLimits,
): Promise<ZipEntry[]> => {
  const tailLength = Math.min(fileSize, maxEndOfCentralDirectorySearchBytes)
  const tail = await readExactly(handle, fileSize - tailLength, tailLength)
  const eocdOffset = findEndOfCentralDirectory(tail)

  if (eocdOffset < 0) {
    throw new ZipFormatError('This file is not a readable ZIP archive.')
  }

  const diskNumber = tail.readUInt16LE(eocdOffset + 4)
  const centralDirectoryDisk = tail.readUInt16LE(eocdOffset + 6)
  const diskEntryCount = tail.readUInt16LE(eocdOffset + 8)
  const totalEntries = tail.readUInt16LE(eocdOffset + 10)
  const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12)
  const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16)

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== totalEntries) {
    throw new ZipFormatError('Multi-part ZIP archives are not supported.')
  }

  if (
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new ZipFormatError('ZIP64 archives are not supported yet.')
  }

  if (totalEntries > limits.maxEntries || centralDirectorySize > limits.maxCentralDirectoryBytes) {
    throw new ZipFormatError('This archive is too large to index safely.')
  }

  if (centralDirectoryOffset + centralDirectorySize > fileSize) {
    throw new ZipFormatError('Invalid ZIP central directory.')
  }

  const directory = await readExactly(handle, centralDirectoryOffset, centralDirectorySize)
  if (directory.length !== centralDirectorySize) {
    throw new ZipFormatError('Invalid ZIP central directory.')
  }

  const entries: ZipEntry[] = []
  let offset = 0

  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== centralDirectoryFileHeaderSignature) {
      throw new ZipFormatError('Invalid ZIP central directory entry.')
    }

    const flags = directory.readUInt16LE(offset + 8)
    const compressionMethod = directory.readUInt16LE(offset + 10)
    const compressedSize = directory.readUInt32LE(offset + 20)
    const uncompressedSize = directory.readUInt32LE(offset + 24)
    const fileNameLength = directory.readUInt16LE(offset + 28)
    const extraLength = directory.readUInt16LE(offset + 30)
    const commentLength = directory.readUInt16LE(offset + 32)
    const diskNumberStart = directory.readUInt16LE(offset + 34)
    const localHeaderOffset = directory.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const nameEnd = nameStart + fileNameLength
    const entryEnd = nameEnd + extraLength + commentLength

    if (entryEnd > directory.length) {
      throw new ZipFormatError('Invalid ZIP central directory entry.')
    }

    if (diskNumberStart !== 0) {
      throw new ZipFormatError('Multi-part ZIP archives are not supported.')
    }

    entries.push({
      index,
      name: directory.subarray(nameStart, nameEnd).toString('utf8'),
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })
    offset = entryEnd
  }

  return entries
}

export const isUnsafeZipEntryName = (name: string) => {
  const normalizedName = name.replace(/\\/g, '/')

  return (
    normalizedName.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalizedName) ||
    normalizedName.split('/').some((part) => part === '..')
  )
}

export const assertReadableZipEntry = (entry: ZipEntry, fileSize: number, maxUncompressedBytes: number) => {
  if (entry.flags & 0x1) {
    throw new ZipFormatError('Encrypted archive entries are not supported.')
  }

  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new ZipFormatError('Unsupported archive compression method.')
  }

  if (entry.uncompressedSize > maxUncompressedBytes) {
    throw new ZipFormatError('This archive entry is too large to read safely.')
  }

  if (
    entry.localHeaderOffset >= fileSize ||
    entry.localHeaderOffset + entry.compressedSize > fileSize
  ) {
    throw new ZipFormatError('Invalid archive entry offset.')
  }
}

const entrySpan = (entry: ZipEntry) =>
  localFileHeaderLength + Buffer.byteLength(entry.name, 'utf8') + localHeaderSlackBytes + entry.compressedSize

const decodeEntryData = async (entry: ZipEntry, compressed: Buffer) => {
  if (entry.compressionMethod === 0) {
    if (compressed.length !== entry.uncompressedSize) {
      throw new ZipFormatError('Archive entry size does not match its directory record.')
    }
    return compressed
  }

  const inflated = await inflateRaw(compressed, {
    maxOutputLength: Math.max(1, entry.uncompressedSize),
  }).catch((error: unknown) => {
    throw new ZipFormatError(
      error instanceof Error ? `Could not decompress archive entry: ${error.message}` : 'Could not decompress archive entry.',
    )
  })

  if (inflated.length !== entry.uncompressedSize) {
    throw new ZipFormatError('Archive entry size does not match its directory record.')
  }

  return inflated
}

/**
 * Extracts one entry from a buffer that starts at `bufferPosition` in the file.
 * Falls back to an extra read when the local extra field was longer than the slack.
 */
const extractFromBuffer = async (
  handle: FileHandle,
  entry: ZipEntry,
  buffer: Buffer,
  bufferPosition: number,
) => {
  const headerStart = entry.localHeaderOffset - bufferPosition

  if (headerStart < 0 || headerStart + localFileHeaderLength > buffer.length) {
    throw new ZipFormatError('Invalid archive local header.')
  }

  if (buffer.readUInt32LE(headerStart) !== localFileHeaderSignature) {
    throw new ZipFormatError('Invalid archive local header.')
  }

  const nameLength = buffer.readUInt16LE(headerStart + 26)
  const extraLength = buffer.readUInt16LE(headerStart + 28)
  const dataStart = headerStart + localFileHeaderLength + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize

  const compressed = dataEnd <= buffer.length
    ? buffer.subarray(dataStart, dataEnd)
    : await readExactly(handle, bufferPosition + dataStart, entry.compressedSize)

  if (compressed.length !== entry.compressedSize) {
    throw new ZipFormatError('Archive entry data is truncated.')
  }

  return decodeEntryData(entry, compressed)
}

/** Reads and decodes one entry with a single read in the common case. */
export const readZipEntry = async (handle: FileHandle, fileSize: number, entry: ZipEntry) => {
  const length = Math.min(entrySpan(entry), fileSize - entry.localHeaderOffset)
  const buffer = await readExactly(handle, entry.localHeaderOffset, length)
  return extractFromBuffer(handle, entry, buffer, entry.localHeaderOffset)
}

/**
 * Reads several entries, coalescing neighbours into shared reads so that a
 * sequential run of pages costs one round-trip on a network mount.
 */
export const readZipEntries = async (
  handle: FileHandle,
  fileSize: number,
  entries: ZipEntry[],
  maxReadBytes: number,
) => {
  const results = new Map<number, Buffer>()
  const sorted = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset)
  let index = 0

  while (index < sorted.length) {
    const runStart = sorted[index].localHeaderOffset
    let runEnd = Math.min(runStart + entrySpan(sorted[index]), fileSize)
    const run = [sorted[index]]
    index += 1

    while (index < sorted.length) {
      const next = sorted[index]
      const nextEnd = Math.min(next.localHeaderOffset + entrySpan(next), fileSize)
      if (next.localHeaderOffset - runEnd > coalesceGapBytes || nextEnd - runStart > maxReadBytes) {
        break
      }
      run.push(next)
      runEnd = Math.max(runEnd, nextEnd)
      index += 1
    }

    const buffer = await readExactly(handle, runStart, runEnd - runStart)
    for (const entry of run) {
      results.set(entry.index, await extractFromBuffer(handle, entry, buffer, runStart))
    }
  }

  return results
}

export const withFileHandle = async <T,>(filePath: string, work: (handle: FileHandle) => Promise<T>) => {
  const handle = await fsPromises.open(filePath, 'r')
  try {
    return await work(handle)
  } finally {
    await handle.close()
  }
}
