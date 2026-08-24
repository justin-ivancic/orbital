import crypto from 'node:crypto'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const cardCoverMaxWidth = 600
const cardCoverMaxHeight = 900
const thumbnailDirectoryName = '.thumbnails'
const inFlightThumbnails = new Map<string, Promise<string>>()

const thumbnailPathForSeries = (coversDirectory: string, seriesId: string) => {
  const fileName = `${crypto.createHash('sha256').update(seriesId).digest('hex')}.webp`
  return path.join(coversDirectory, thumbnailDirectoryName, fileName)
}

type ThumbnailMetadata = {
  sourceModifiedAt: number
  sourcePath: string
  sourceSize: number
}

const thumbnailMetadataPath = (thumbnailPath: string) => `${thumbnailPath}.json`

const isFreshThumbnail = async (
  thumbnailPath: string,
  sourcePath: string,
  sourceSize: number,
  sourceModifiedAt: number,
) => {
  try {
    const stats = await fsPromises.stat(thumbnailPath)
    const metadata = JSON.parse(
      await fsPromises.readFile(thumbnailMetadataPath(thumbnailPath), 'utf8'),
    ) as ThumbnailMetadata
    return (
      stats.size > 0 &&
      metadata.sourcePath === sourcePath &&
      metadata.sourceSize === sourceSize &&
      metadata.sourceModifiedAt === sourceModifiedAt
    )
  } catch {
    return false
  }
}

const generateCardCoverThumbnail = async (
  coversDirectory: string,
  seriesId: string,
  sourcePath: string,
) => {
  const sourceStats = await fsPromises.stat(sourcePath)
  const thumbnailPath = thumbnailPathForSeries(coversDirectory, seriesId)

  if (await isFreshThumbnail(
    thumbnailPath,
    sourcePath,
    sourceStats.size,
    sourceStats.mtimeMs,
  )) {
    return thumbnailPath
  }

  const source = await loadImage(sourcePath)
  const scale = Math.min(
    1,
    cardCoverMaxWidth / source.width,
    cardCoverMaxHeight / source.height,
  )
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))

  const canvas = createCanvas(width, height)
  canvas.getContext('2d').drawImage(source, 0, 0, width, height)
  const encoded = await canvas.encode('webp', 82)
  const thumbnailDirectory = path.dirname(thumbnailPath)
  const temporaryPath = `${thumbnailPath}.${crypto.randomUUID()}.part`
  const metadataPath = thumbnailMetadataPath(thumbnailPath)
  const temporaryMetadataPath = `${metadataPath}.${crypto.randomUUID()}.part`
  const metadata: ThumbnailMetadata = {
    sourceModifiedAt: sourceStats.mtimeMs,
    sourcePath,
    sourceSize: sourceStats.size,
  }

  await fsPromises.mkdir(thumbnailDirectory, { recursive: true })
  try {
    await fsPromises.writeFile(temporaryPath, encoded)
    await fsPromises.writeFile(temporaryMetadataPath, JSON.stringify(metadata))
    await fsPromises.rename(temporaryPath, thumbnailPath)
    await fsPromises.rename(temporaryMetadataPath, metadataPath)
  } finally {
    await fsPromises.unlink(temporaryPath).catch(() => undefined)
    await fsPromises.unlink(temporaryMetadataPath).catch(() => undefined)
  }

  return thumbnailPath
}

export const resolveCardCoverPath = async (
  coversDirectory: string,
  seriesId: string,
  sourcePath: string,
) => {
  const thumbnailPath = thumbnailPathForSeries(coversDirectory, seriesId)
  const existing = inFlightThumbnails.get(thumbnailPath)
  if (existing) {
    return existing
  }

  const pending = generateCardCoverThumbnail(coversDirectory, seriesId, sourcePath)
    .catch(() => sourcePath)
    .finally(() => inFlightThumbnails.delete(thumbnailPath))
  inFlightThumbnails.set(thumbnailPath, pending)
  return pending
}

export const cardCoverDimensions = {
  maxHeight: cardCoverMaxHeight,
  maxWidth: cardCoverMaxWidth,
}
