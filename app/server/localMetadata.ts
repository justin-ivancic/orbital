import fsPromises from 'node:fs/promises'
import path from 'node:path'
import mime from 'mime-types'
import type { EntryFormat } from '../src/appTypes.ts'
import { loadCbzArchiveManifest, readCbzPage, selectCbzCoverPage } from './cbzArchive'
import { runPdfJob } from './mediaWorkerPool'
import {
  assertReadableZipEntry,
  isUnsafeZipEntryName,
  readZipDirectory,
  readZipEntry,
  withFileHandle,
  type ZipEntry,
} from './zipArchive'

export type LocalMediaMetadata = {
  title: string | null
  authors: string[]
  subjects: string[]
  description: string | null
  year: number | null
  language: string | null
  publisher: string | null
}

export type LocalMediaResult = {
  metadata: LocalMediaMetadata | null
  cover: { outputPath: string; mimeType: string } | null
  pageCount: number | null
}

const maxDocumentEntryBytes = 4 * 1024 * 1024
const maxCoverImageBytes = 40 * 1024 * 1024
const zipLimits = { maxCentralDirectoryBytes: 32 * 1024 * 1024, maxEntries: 20000 }
const coverImageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

const emptyMetadata = (): LocalMediaMetadata => ({
  title: null,
  authors: [],
  subjects: [],
  description: null,
  year: null,
  language: null,
  publisher: null,
})

const decodeXmlText = (value: string) =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')

const stripMarkup = (value: string) =>
  decodeXmlText(
    decodeXmlText(value)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()

const compact = (value: string) => value.replace(/\s+/g, ' ').trim()

const junkAuthorPattern =
  /^(?:administrator|admin|user|owner|unknown|anonymous|author|default|windows user|microsoft office user|office user|pc|hp|dell|lenovo|asus|acer|compaq|scanner|scan|scanned|test|null|none|n\/?a|various|-+|\?+|\.+)$/i
const softwareAuthorPattern =
  /\b(?:acrobat|adobe|microsoft|word|pscript|calibre|abbyy|pdf|distiller|ghostscript|scansoft|writer|office)\b/i

/** Returns a display-ready person name, or null for placeholders and tool names. */
export const cleanAuthorName = (value: string | null | undefined) => {
  if (!value) {
    return null
  }

  let name = compact(decodeXmlText(value)).replace(/^by\s+/i, '').replace(/[,;.]+$/, '').trim()

  if (
    !name ||
    name.length > 80 ||
    !/\p{L}/u.test(name) ||
    name.includes('@') ||
    /https?:/i.test(name) ||
    junkAuthorPattern.test(name) ||
    softwareAuthorPattern.test(name)
  ) {
    return null
  }

  // "Mises, Ludwig von" -> "Ludwig von Mises", so the same person groups together.
  const commaParts = name.split(',').map((part) => part.trim())
  if (commaParts.length === 2 && commaParts.every((part) => /^[\p{L}.'\- ]+$/u.test(part) && part.length > 1)) {
    name = `${commaParts[1]} ${commaParts[0]}`
  }

  return name
}

// ComicInfo lists people separated by commas ("Aki Mori, Ken Sato"), but a lone
// "Mori, Aki" is one person in "Last, First" order.
const splitNameList = (value: string) => {
  const parts = value.split(/\s*,\s*/).filter(Boolean)
  return parts.length > 1 && parts.every((part) => /\s/.test(part)) ? parts : [value]
}

const genericSubjectPattern = /^(?:general|fiction|nonfiction|non-fiction|book|books|ebook|e-book|pdf|untitled|misc|miscellaneous)$/i

export const cleanSubjects = (values: string[]) => {
  const seen = new Set<string>()
  const subjects: string[] = []

  for (const raw of values.flatMap((value) => value.split(/\s*[;,|/]\s*|\s+--\s+/))) {
    const subject = compact(decodeXmlText(raw)).replace(/[.]+$/, '')
    const key = subject.toLowerCase()

    if (
      subject.length < 2 ||
      subject.length > 48 ||
      !/\p{L}/u.test(subject) ||
      genericSubjectPattern.test(subject) ||
      seen.has(key)
    ) {
      continue
    }

    seen.add(key)
    subjects.push(subject.charAt(0).toUpperCase() + subject.slice(1))

    if (subjects.length >= 10) {
      break
    }
  }

  return subjects
}

const cleanDescription = (value: string | null | undefined) => {
  if (!value) {
    return null
  }

  const description = stripMarkup(value)
  return description.length >= 40 ? description.slice(0, 4000) : null
}

const parseYear = (value: string | null | undefined) => {
  const match = value?.match(/\b(1[5-9]\d{2}|20\d{2})\b/)
  return match ? Number(match[1]) : null
}

const readTagValues = (xml: string, tag: string) => {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'gi')
  return [...xml.matchAll(pattern)].map((match) => match[1])
}

const readAttributes = (tag: string) => {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attributes[match[1].toLowerCase()] = decodeXmlText(match[3] ?? match[4] ?? '')
  }
  return attributes
}

const findEntry = (entries: ZipEntry[], name: string) => {
  const normalizedName = name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
  return entries.find((entry) => entry.name.replace(/\\/g, '/').toLowerCase() === normalizedName) ?? null
}

const readTextEntry = async (
  handle: Parameters<typeof readZipEntry>[0],
  fileSize: number,
  entry: ZipEntry | null,
) => {
  if (!entry || isUnsafeZipEntryName(entry.name)) {
    return null
  }

  assertReadableZipEntry(entry, fileSize, maxDocumentEntryBytes)
  return (await readZipEntry(handle, fileSize, entry)).toString('utf8')
}

const coverExtension = (entryName: string, mediaType?: string | null) => {
  const fromName = path.extname(entryName).toLowerCase()
  if (coverImageExtensions.has(fromName)) {
    return fromName === '.jpeg' ? '.jpg' : fromName
  }

  const fromType = mediaType ? mime.extension(mediaType) : null
  return fromType && coverImageExtensions.has(`.${fromType}`) ? `.${fromType}` : null
}

const writeCover = async (outputBasePath: string, extension: string, bytes: Buffer) => {
  const outputPath = `${outputBasePath}${extension}`
  await fsPromises.writeFile(outputPath, bytes)
  return { outputPath, mimeType: String(mime.lookup(outputPath) || 'image/jpeg') }
}

const extractEpub = async (
  filePath: string,
  options: { coverOutputBasePath: string | null; wantMetadata: boolean },
): Promise<LocalMediaResult> =>
  withFileHandle(filePath, async (handle) => {
    const { size } = await handle.stat()
    const entries = await readZipDirectory(handle, size, zipLimits)
    const container = await readTextEntry(handle, size, findEntry(entries, 'META-INF/container.xml'))
    const opfPath = container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1]

    if (!opfPath) {
      return { metadata: null, cover: null, pageCount: null }
    }

    const opf = await readTextEntry(handle, size, findEntry(entries, decodeURIComponent(opfPath)))
    if (!opf) {
      return { metadata: null, cover: null, pageCount: null }
    }

    const metadata = emptyMetadata()

    if (options.wantMetadata) {
      metadata.title = readTagValues(opf, 'title').map((value) => compact(stripMarkup(value))).find(Boolean) ?? null
      metadata.authors = readTagValues(opf, 'creator')
        .map((value) => cleanAuthorName(stripMarkup(value)))
        .filter((value): value is string => Boolean(value))
      metadata.subjects = cleanSubjects(readTagValues(opf, 'subject').map(stripMarkup))
      metadata.description = cleanDescription(readTagValues(opf, 'description')[0])
      metadata.year = parseYear(readTagValues(opf, 'date')[0])
      metadata.language = compact(stripMarkup(readTagValues(opf, 'language')[0] ?? '')) || null
      metadata.publisher = compact(stripMarkup(readTagValues(opf, 'publisher')[0] ?? '')) || null
    }

    let cover: LocalMediaResult['cover'] = null

    if (options.coverOutputBasePath) {
      const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map((match) => readAttributes(match[0]))
      const coverId = [...opf.matchAll(/<meta\b[^>]*>/gi)]
        .map((match) => readAttributes(match[0]))
        .find((attributes) => attributes.name?.toLowerCase() === 'cover')?.content
      const coverItem =
        items.find((item) => item.properties?.split(/\s+/).includes('cover-image')) ??
        (coverId ? items.find((item) => item.id === coverId) : undefined) ??
        items.find((item) => /^image\//.test(item['media-type'] ?? '') && /cover/i.test(`${item.id} ${item.href}`))

      if (coverItem?.href) {
        const opfDirectory = path.posix.dirname(opfPath.replace(/\\/g, '/'))
        const coverName = path.posix.normalize(
          path.posix.join(opfDirectory === '.' ? '' : opfDirectory, decodeURIComponent(coverItem.href)),
        )
        const coverEntry = findEntry(entries, coverName)
        const extension = coverEntry ? coverExtension(coverEntry.name, coverItem['media-type']) : null

        if (coverEntry && extension && !isUnsafeZipEntryName(coverEntry.name)) {
          assertReadableZipEntry(coverEntry, size, maxCoverImageBytes)
          cover = await writeCover(options.coverOutputBasePath, extension, await readZipEntry(handle, size, coverEntry))
        }
      }
    }

    return {
      metadata: options.wantMetadata ? metadata : null,
      cover,
      pageCount: null,
    }
  })

const extractCbz = async (
  filePath: string,
  options: { coverOutputBasePath: string | null; wantMetadata: boolean },
): Promise<LocalMediaResult> => {
  const stats = await fsPromises.stat(filePath)
  const manifest = await loadCbzArchiveManifest(filePath, stats)
  let metadata: LocalMediaMetadata | null = null

  if (options.wantMetadata) {
    metadata = emptyMetadata()
    const comicInfo = await withFileHandle(filePath, async (handle) => {
      const entries = await readZipDirectory(handle, stats.size, zipLimits)
      const entry = entries.find((candidate) => /(?:^|\/)comicinfo\.xml$/i.test(candidate.name)) ?? null
      return readTextEntry(handle, stats.size, entry)
    }).catch(() => null)

    if (comicInfo) {
      const first = (tag: string) => {
        const value = readTagValues(comicInfo, tag)[0]
        return value ? compact(stripMarkup(value)) || null : null
      }
      metadata.title = first('Series') ?? first('Title')
      metadata.authors = [first('Writer'), first('Penciller')]
        .flatMap((value) => (value ? splitNameList(value) : []))
        .map(cleanAuthorName)
        .filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index)
      metadata.subjects = cleanSubjects([first('Genre') ?? '', first('Tags') ?? ''])
      metadata.description = cleanDescription(first('Summary'))
      metadata.year = parseYear(first('Year'))
      metadata.language = first('LanguageISO')
      metadata.publisher = first('Publisher')
    }
  }

  let cover: LocalMediaResult['cover'] = null
  const coverPage = options.coverOutputBasePath ? selectCbzCoverPage(manifest) : null

  if (coverPage && options.coverOutputBasePath) {
    const extension = coverExtension(coverPage.name, coverPage.contentType) ?? '.jpg'
    const bytes = await readCbzPage(filePath, stats, manifest, coverPage, { readAhead: 0 })
    cover = await writeCover(options.coverOutputBasePath, extension, bytes)
  }

  return { metadata, cover, pageCount: manifest.pageCount }
}

const extractPdf = async (
  filePath: string,
  options: { coverOutputBasePath: string | null; wantMetadata: boolean },
): Promise<LocalMediaResult> => {
  const result = await runPdfJob({
    inputPath: filePath,
    coverOutputPath: options.coverOutputBasePath ? `${options.coverOutputBasePath}.jpg` : null,
    wantMetadata: options.wantMetadata,
  })
  const pdfMetadata = result.metadata

  return {
    metadata: pdfMetadata
      ? {
          title: pdfMetadata.title ? compact(pdfMetadata.title) : null,
          authors: pdfMetadata.authors
            .map(cleanAuthorName)
            .filter((value): value is string => Boolean(value)),
          subjects: cleanSubjects(pdfMetadata.keywords),
          description: null,
          year: null,
          language: pdfMetadata.language,
          publisher: null,
        }
      : null,
    cover: result.cover,
    pageCount: result.pageCount,
  }
}

export const supportsLocalMedia = (format: EntryFormat) =>
  format === 'pdf' || format === 'epub' || format === 'cbz'

/**
 * Reads embedded metadata and/or a cover from a local file using ranged reads
 * only, so large files on a network mount cost a few round-trips, not a copy.
 */
export const extractLocalMedia = async (
  filePath: string,
  format: EntryFormat,
  options: { coverOutputBasePath: string | null; wantMetadata: boolean },
): Promise<LocalMediaResult | null> => {
  if (format === 'pdf') {
    return extractPdf(filePath, options)
  }

  if (format === 'epub') {
    return extractEpub(filePath, options)
  }

  if (format === 'cbz') {
    return extractCbz(filePath, options)
  }

  return null
}
