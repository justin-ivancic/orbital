import assert from 'node:assert/strict'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import {
  getCbzMediaVersion,
  loadCbzArchiveManifest,
  openCbzPageImageStream,
} from './cbzArchive.ts'

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

const createTempDirectory = async () =>
  fsPromises.mkdtemp(path.join(os.tmpdir(), 'orbital-cbz-'))

const writeZip = async (directory: string, entries: Record<string, Buffer | string>) => {
  const zip = new JSZip()

  Object.entries(entries).forEach(([name, content]) => {
    zip.file(name, content)
  })

  const archive = await zip.generateAsync({
    compression: 'DEFLATE',
    type: 'nodebuffer',
  })
  const archivePath = path.join(directory, 'fixture.cbz')
  await fsPromises.writeFile(archivePath, archive)
  return archivePath
}

const readStream = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = []

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

test('CBZ media versions use the same timestamp precision as scanned entries', () => {
  assert.equal(getCbzMediaVersion({ mtimeMs: 1234.9, size: 456 }), '1234-456')
})

test('CBZ manifest indexes image entries without inflating the archive', async () => {
  const directory = await createTempDirectory()

  try {
    const archivePath = await writeZip(directory, {
      'page10.png': onePixelPng,
      'page2.png': onePixelPng,
      'folder/page1.png': onePixelPng,
      'notes.txt': 'not an image page',
    })
    const stats = await fsPromises.stat(archivePath)
    const manifest = await loadCbzArchiveManifest(archivePath, stats)

    assert.equal(manifest.version, getCbzMediaVersion(stats))
    assert.equal(manifest.pageCount, 3)
    assert.deepEqual(
      manifest.pages.map((page) => page.name),
      ['page10.png', 'page2.png', 'folder/page1.png'],
    )
    assert.deepEqual(
      manifest.pages.map((page) => page.pageNumber),
      [1, 2, 3],
    )

    const firstPage = await readStream(await openCbzPageImageStream(archivePath, manifest.pages[0]))
    assert.deepEqual(firstPage, onePixelPng)
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('CBZ manifest rejects path traversal image entries', async () => {
  const directory = await createTempDirectory()

  try {
    const archivePath = await writeZip(directory, {
      '../evil.png': onePixelPng,
    })
    const stats = await fsPromises.stat(archivePath)

    await assert.rejects(
      loadCbzArchiveManifest(archivePath, stats),
      /path traversal entries/,
    )
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})
