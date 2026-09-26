// Child process for PDF work that is risky to run in the server process:
// malformed files can make pdf.js spin or allocate heavily. The parent keeps
// one worker alive, sends jobs one at a time, and restarts it on timeouts.
import fsPromises, { type FileHandle } from 'node:fs/promises'
import { createCanvas } from '@napi-rs/canvas'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

export type MediaWorkerJob = {
  id: number
  kind: 'pdf'
  inputPath: string
  coverOutputPath: string | null
  wantMetadata: boolean
}

export type PdfMetadata = {
  title: string | null
  authors: string[]
  subject: string | null
  keywords: string[]
  language: string | null
}

export type MediaWorkerResult =
  | {
      id: number
      ok: true
      cover: { outputPath: string; mimeType: string } | null
      metadata: PdfMetadata | null
      pageCount: number | null
    }
  | { id: number; ok: false; error: string }

const rangeChunkBytes = 256 * 1024
const coverWidth = 600

class FileRangeTransport extends pdfjs.PDFDataRangeTransport {
  private readonly handle: FileHandle

  constructor(handle: FileHandle, length: number, initialData: Uint8Array) {
    super(length, initialData)
    this.handle = handle
  }

  requestDataRange(begin: number, end: number) {
    const length = Math.max(0, end - begin)
    const chunk = new Uint8Array(length)

    void this.handle
      .read(chunk, 0, length, begin)
      .then(({ bytesRead }) => this.onDataRange(begin, bytesRead === length ? chunk : chunk.subarray(0, bytesRead)))
      .catch(() => this.abort())
  }
}

const asText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : null

const asList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(asList)
  }

  const text = asText(value)
  return text ? [text] : []
}

const splitPeople = (value: string) =>
  value
    .split(/\s*(?:;|&|\band\b|\bund\b|\/)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean)

const splitKeywords = (value: string) =>
  value
    .split(/\s*[;,|]\s*/)
    .map((part) => part.trim())
    .filter(Boolean)

const readPdf = async (job: MediaWorkerJob) => {
  const handle = await fsPromises.open(job.inputPath, 'r')

  try {
    const { size } = await handle.stat()
    const initialLength = Math.min(size, rangeChunkBytes)
    const initialData = new Uint8Array(initialLength)
    await handle.read(initialData, 0, initialLength, 0)

    const loadingTask = pdfjs.getDocument({
      range: new FileRangeTransport(handle, size, initialData),
      length: size,
      rangeChunkSize: rangeChunkBytes,
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
      useSystemFonts: true,
    })
    const pdfDocument = await loadingTask.promise

    try {
      let metadata: PdfMetadata | null = null

      if (job.wantMetadata) {
        const { info, metadata: xmp } = await pdfDocument.getMetadata().catch(() => ({ info: {}, metadata: null }))
        const infoRecord = (info ?? {}) as Record<string, unknown>
        const xmpGet = (name: string) => {
          try {
            return xmp?.get(name) ?? null
          } catch {
            return null
          }
        }
        const authors = [
          ...asList(xmpGet('dc:creator')),
          ...splitPeople(asText(infoRecord.Author) ?? ''),
        ]
        const keywords = [
          ...asList(xmpGet('dc:subject')),
          ...splitKeywords(asText(infoRecord.Keywords) ?? ''),
        ]

        metadata = {
          title: asText(xmpGet('dc:title')) ?? asText(infoRecord.Title),
          authors: [...new Set(authors)],
          subject: asText(xmpGet('dc:description')) ?? asText(infoRecord.Subject),
          keywords: [...new Set(keywords)],
          language: asText(xmpGet('dc:language')) ?? asText(infoRecord.Language),
        }
      }

      let cover: { outputPath: string; mimeType: string } | null = null

      if (job.coverOutputPath) {
        const firstPage = await pdfDocument.getPage(1)
        const baseViewport = firstPage.getViewport({ scale: 1 })
        const viewport = firstPage.getViewport({ scale: coverWidth / Math.max(baseViewport.width, 1) })
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        const context = canvas.getContext('2d')
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)

        await firstPage.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise
        await fsPromises.writeFile(job.coverOutputPath, await canvas.encode('jpeg', 88))
        firstPage.cleanup()
        cover = { outputPath: job.coverOutputPath, mimeType: 'image/jpeg' }
      }

      return { cover, metadata, pageCount: pdfDocument.numPages }
    } finally {
      await pdfDocument.destroy()
    }
  } finally {
    await handle.close()
  }
}

const handleJob = async (job: MediaWorkerJob): Promise<MediaWorkerResult> => {
  try {
    return { id: job.id, ok: true, ...(await readPdf(job)) }
  } catch (error) {
    return {
      id: job.id,
      ok: false,
      error: error instanceof Error ? error.message : 'PDF processing failed.',
    }
  }
}

let queue = Promise.resolve()

process.on('message', (job: MediaWorkerJob) => {
  queue = queue.then(async () => {
    const result = await handleJob(job)
    process.send?.(result)
  })
})

process.on('disconnect', () => process.exit(0))
