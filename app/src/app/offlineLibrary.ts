import type {
  LibraryEntry,
  OfflineDownloadManifest,
  OfflineDownloadRecord,
  SeriesDetail,
  SeriesSummary,
} from '../appTypes'
import { getOfflineSeriesAvailability, getOfflineSeriesCoverage } from '../offlineDownloads'
import { getOfflineResourceUrl, nativeResourceUrl } from '../offlineStorage'
import { isNativeApp, resolveApiUrl } from '../platform'

/** Where a downloaded resource can be loaded from on this device. */
export const offlineResourceUrl = (
  downloadId: string,
  resource: OfflineDownloadManifest['resources'][number],
) => {
  if (isNativeApp) {
    return nativeResourceUrl(downloadId, resource.key) ?? resolveApiUrl(resource.url)
  }

  return getOfflineResourceUrl(resource.key)
}

const primaryResource = (manifest: OfflineDownloadManifest, entryId: string) => {
  const entry = manifest.entries.find((item) => item.entryId === entryId)

  if (!entry) {
    return null
  }

  return manifest.resources.find((resource) => resource.key === entry.resourceKeys[0]) ?? null
}

export type OfflinePage = {
  archiveIndex: number
  name: string
  url: string
}

export const buildOfflinePagesForEntry = (record: OfflineDownloadRecord, entryId: string): OfflinePage[] | null => {
  const entry = record.manifest.entries.find((item) => item.entryId === entryId)

  if (!entry || entry.format !== 'cbz') {
    return null
  }

  const resourcesByKey = new Map(record.manifest.resources.map((resource) => [resource.key, resource]))

  return entry.resourceKeys.flatMap((resourceKey, index) => {
    const resource = resourcesByKey.get(resourceKey)

    if (!resource || resource.kind !== 'cbz-page') {
      return []
    }

    return [{ archiveIndex: index, name: resource.label, url: offlineResourceUrl(record.id, resource) }]
  })
}

export const offlineSeriesId = (record: OfflineDownloadRecord) =>
  record.manifest.target.type === 'series'
    ? record.manifest.target.seriesId
    : record.manifest.resources.find((resource) => resource.seriesId)?.seriesId || record.manifest.manifestId

/** A series detail assembled from a download, for reading without the server. */
export const buildOfflineSeriesDetail = (record: OfflineDownloadRecord): SeriesDetail => {
  const { manifest } = record
  const coverResource = manifest.resources.find((resource) => resource.kind === 'cover')
  const bannerResource = manifest.resources.find((resource) => resource.kind === 'banner')
  const entries = manifest.entries.map((entry): LibraryEntry => {
    const resource = primaryResource(manifest, entry.entryId)
    const fileUrl = resource ? offlineResourceUrl(record.id, resource) : '#'

    return {
      id: entry.entryId,
      label: entry.label,
      title: entry.title,
      details: entry.format.toUpperCase(),
      chapterNumber: null,
      seasonNumber: null,
      episodeNumber: null,
      preferredVariantId: entry.entryId,
      variants: [
        {
          id: entry.entryId,
          variantLabel: entry.format.toUpperCase(),
          storageFile: entry.title,
          format: entry.format,
          details: entry.format.toUpperCase(),
          fileUrl,
          downloadUrl: fileUrl,
          mediaTracks: { audio: [], subtitles: [] },
        },
      ],
    }
  })

  return {
    id: offlineSeriesId(record),
    title: manifest.seriesTitle,
    titleShort: manifest.seriesTitle,
    category: manifest.category,
    year: null,
    format: [...new Set(manifest.entries.map((entry) => entry.format.toUpperCase()))].join(', '),
    status: 'Downloaded',
    progressLabel: '',
    description: manifest.subtitle,
    folder: '',
    coverUrl: coverResource ? offlineResourceUrl(record.id, coverResource) : null,
    coverImageUrl: coverResource ? offlineResourceUrl(record.id, coverResource) : null,
    bannerUrl: bannerResource ? offlineResourceUrl(record.id, bannerResource) : null,
    coverSource: 'Offline package',
    metadataSource: 'Offline package',
    externalUrl: null,
    sourceName: null,
    sourceRole: null,
    genres: [],
    tags: [],
    stats: {
      fileCount: manifest.entryCount,
      lastScanAt: record.completedAt,
    },
    entries,
    comments: [],
  }
}

/* ---------------------------------------------------------- lookups -- */

type DownloadIndex = {
  records: OfflineDownloadRecord[]
  readyByEntry: Map<string, OfflineDownloadRecord>
  bySeriesTarget: Map<string, OfflineDownloadRecord>
  readyBySeries: Map<string, OfflineDownloadRecord>
  coverage: Map<string, Set<string>>
}

let cachedIndex: DownloadIndex | null = null

/** Lookup tables over the download records, rebuilt only when they change. */
export const getDownloadIndex = (records: OfflineDownloadRecord[]): DownloadIndex => {
  if (cachedIndex?.records === records) {
    return cachedIndex
  }

  const readyByEntry = new Map<string, OfflineDownloadRecord>()
  const bySeriesTarget = new Map<string, OfflineDownloadRecord>()
  const readyBySeries = new Map<string, OfflineDownloadRecord>()

  records.forEach((record) => {
    if (record.manifest.target.type === 'series') {
      bySeriesTarget.set(record.manifest.target.seriesId, record)
    }

    if (record.status !== 'ready') {
      return
    }

    record.manifest.entries.forEach((entry) => {
      if (!readyByEntry.has(entry.entryId)) {
        readyByEntry.set(entry.entryId, record)
      }
    })

    const seriesId = offlineSeriesId(record)
    const existing = readyBySeries.get(seriesId)

    if (!existing || record.manifest.target.type === 'series') {
      readyBySeries.set(seriesId, record)
    }
  })

  cachedIndex = {
    records,
    readyByEntry,
    bySeriesTarget,
    readyBySeries,
    coverage: getOfflineSeriesCoverage(records),
  }

  return cachedIndex
}

export const seriesAvailability = (records: OfflineDownloadRecord[], series: Pick<SeriesSummary, 'id' | 'stats'>) =>
  getOfflineSeriesAvailability(getDownloadIndex(records).coverage.get(series.id), series.stats.fileCount)

export const downloadedEntryCount = (records: OfflineDownloadRecord[], seriesId: string) =>
  getDownloadIndex(records).coverage.get(seriesId)?.size ?? 0
