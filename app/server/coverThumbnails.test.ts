import assert from 'node:assert/strict'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { cardCoverDimensions, resolveCardCoverPath } from './coverThumbnails.ts'

test('creates and reuses a bounded card cover thumbnail', async () => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'orbital-cover-thumbnail-'))

  try {
    const sourcePath = path.join(directory, 'source.png')
    const canvas = createCanvas(1200, 1800)
    canvas.getContext('2d').fillRect(0, 0, 1200, 1800)
    await fsPromises.writeFile(sourcePath, await canvas.encode('png'))

    const firstPath = await resolveCardCoverPath(directory, 'series-one', sourcePath)
    const firstStats = await fsPromises.stat(firstPath)
    const thumbnail = await loadImage(firstPath)

    assert.equal(thumbnail.width, cardCoverDimensions.maxWidth)
    assert.equal(thumbnail.height, cardCoverDimensions.maxHeight)
    assert.ok(firstStats.size > 0)

    const secondPath = await resolveCardCoverPath(directory, 'series-one', sourcePath)
    const secondStats = await fsPromises.stat(secondPath)
    assert.equal(secondPath, firstPath)
    assert.equal(secondStats.mtimeMs, firstStats.mtimeMs)

    const obsoleteThumbnail = createCanvas(100, 100)
    obsoleteThumbnail.getContext('2d').fillRect(0, 0, 100, 100)
    await fsPromises.writeFile(firstPath, await obsoleteThumbnail.encode('webp'))
    await fsPromises.writeFile(`${firstPath}.json`, JSON.stringify({
      sourceModifiedAt: (await fsPromises.stat(sourcePath)).mtimeMs,
      sourcePath,
      sourceSize: (await fsPromises.stat(sourcePath)).size,
    }))
    const upgradedPath = await resolveCardCoverPath(directory, 'series-one', sourcePath)
    const upgraded = await loadImage(upgradedPath)
    assert.equal(upgraded.width, cardCoverDimensions.maxWidth)
    assert.equal(upgraded.height, cardCoverDimensions.maxHeight)

    const replacement = createCanvas(800, 800)
    replacement.getContext('2d').fillRect(0, 0, 800, 800)
    await fsPromises.writeFile(sourcePath, await replacement.encode('png'))
    const refreshedPath = await resolveCardCoverPath(directory, 'series-one', sourcePath)
    const refreshed = await loadImage(refreshedPath)
    assert.equal(refreshed.width, cardCoverDimensions.maxWidth)
    assert.equal(refreshed.height, cardCoverDimensions.maxWidth)
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('falls back to the original cover when thumbnail decoding fails', async () => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'orbital-cover-fallback-'))

  try {
    const sourcePath = path.join(directory, 'source.bin')
    await fsPromises.writeFile(sourcePath, 'not-an-image')

    assert.equal(
      await resolveCardCoverPath(directory, 'series-two', sourcePath),
      sourcePath,
    )
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})
