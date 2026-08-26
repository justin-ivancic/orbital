import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import JSZip from 'jszip'
import mime from 'mime-types'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

type CoverWorkerRequest =
  | { kind: 'pdf'; inputPath: string; outputPath: string }
  | { kind: 'cbz'; inputPath: string; outputBasePath: string }

type CoverWorkerResult =
  | { ok: true; outputPath: string; mimeType: string }
  | { ok: false; error: string }

const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp'])

const naturalCompare = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })

const renderPdfCover = async (inputPath: string, outputPath: string) => {
  const documentData = new Uint8Array(await fsPromises.readFile(inputPath))
  const loadingTask = pdfjs.getDocument({ data: documentData, useSystemFonts: true })
  const pdfDocument = await loadingTask.promise

  try {
    const firstPage = await pdfDocument.getPage(1)
    const baseViewport = firstPage.getViewport({ scale: 1 })
    const scale = 500 / Math.max(baseViewport.width, 1)
    const viewport = firstPage.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const context = canvas.getContext('2d')

    await firstPage.render({ canvasContext: context, viewport }).promise
    await fsPromises.writeFile(outputPath, canvas.toBuffer('image/png'))
  } finally {
    await pdfDocument.destroy()
  }

  return { outputPath, mimeType: 'image/png' }
}

const extractCbzCover = async (inputPath: string, outputBasePath: string) => {
  const archive = await JSZip.loadAsync(await fsPromises.readFile(inputPath))
  const imageEntry = Object.values(archive.files)
    .filter((entry) => !entry.dir && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .sort((left, right) => naturalCompare(left.name, right.name))[0]

  if (!imageEntry) {
    throw new Error('No readable image page found in archive.')
  }

  const extension = path.extname(imageEntry.name).toLowerCase() || '.jpg'
  const outputPath = `${outputBasePath}${extension}`
  const imageBuffer = await imageEntry.async('nodebuffer')
  await fsPromises.writeFile(outputPath, imageBuffer)

  return {
    outputPath,
    mimeType: String(mime.lookup(outputPath) || 'image/jpeg'),
  }
}

const run = async (request: CoverWorkerRequest): Promise<CoverWorkerResult> => {
  try {
    const result = request.kind === 'pdf'
      ? await renderPdfCover(request.inputPath, request.outputPath)
      : await extractCbzCover(request.inputPath, request.outputBasePath)
    return { ok: true, ...result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Cover extraction failed.',
    }
  }
}

process.once('message', (request: CoverWorkerRequest) => {
  void run(request).then((result) => {
    process.send?.(result, () => process.exit(result.ok ? 0 : 1))
  })
})
