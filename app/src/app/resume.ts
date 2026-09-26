import type { Bookmark, OfflineDownloadRecord, SeriesSummary } from '../appTypes'
import { readerRoute, type AppRoute } from '../routing'
import { getDownloadIndex } from './offlineLibrary'

/**
 * Where "Resume" goes. Offline, a downloaded copy is opened; online the reader
 * streams from the server (and still prefers nothing else).
 */
export const resumeRouteFor = (
  bookmark: Pick<Bookmark, 'entryId' | 'seriesId' | 'category'>,
  series: Pick<SeriesSummary, 'id' | 'category'> | null,
  records: OfflineDownloadRecord[],
  offline: boolean,
): AppRoute | null => {
  const download = getDownloadIndex(records).readyByEntry.get(bookmark.entryId)

  if (offline && download) {
    return {
      name: 'offlineReader',
      downloadId: download.id,
      entryId: bookmark.entryId,
      page: null,
      percent: null,
      variantId: null,
    }
  }

  if (!series && offline) {
    return null
  }

  return readerRoute(series?.category ?? bookmark.category, bookmark.seriesId, bookmark.entryId)
}
