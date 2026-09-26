import { ArrowDownToLine, BookOpen, HardDrive, Pause, Play, RotateCw, ShieldCheck, Trash2 } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import type { OfflineDownloadRecord } from '../appTypes'
import { useOffline } from '../app/connection'
import { confirmAction } from '../app/dialogs'
import {
  isActiveDownload,
  pauseDownload,
  removeAllDownloads,
  removeDownload,
  requestPersistence,
  startDownload,
  targetKey,
  useDownloadActivity,
  useDownloadRecords,
  useDownloadsLoaded,
  useStorageSummary,
  type DownloadActivity,
} from '../app/downloads'
import { getSeriesIndex, libraryStore, type LibraryState } from '../app/library'
import { useDocumentTitle } from '../app/navigation'
import { buildOfflineSeriesDetail, offlineSeriesId, seriesAvailability } from '../app/offlineLibrary'
import { navigate } from '../app/router'
import { useStore } from '../app/store'
import { isNativeApp } from '../platform'
import { formatBytes, useT } from '../i18n'
import { TopBar } from '../shell/TopBar'
import { EmptyState, Meter, Segmented } from '../ui/bits'
import { Cover } from '../ui/Cover'

type Filter = 'all' | 'active' | 'ready' | 'attention'

const selectLibrary = (state: LibraryState) => state.library

const needsAttention = (record: OfflineDownloadRecord) =>
  ['failed', 'partial', 'stale', 'paused'].includes(record.status)

const progressOf = (record: OfflineDownloadRecord, activity: DownloadActivity | null) => {
  if (activity?.phase === 'downloading' && activity.totalBytes > 0) {
    return Math.min(1, activity.bytes / activity.totalBytes)
  }

  if (record.manifest.estimatedBytes > 0) {
    return Math.min(1, record.downloadedBytes / record.manifest.estimatedBytes)
  }

  return record.resourceCount ? record.downloadedResourceCount / record.resourceCount : 0
}

type RowProps = {
  record: OfflineDownloadRecord
  activity: DownloadActivity | null
  removing: boolean
  offline: boolean
}

const DownloadRow = memo(function DownloadRow({ record, activity, removing, offline }: RowProps) {
  const t = useT()
  const library = useStore(libraryStore, selectLibrary)
  const records = useDownloadRecords()
  const seriesId = offlineSeriesId(record)
  const catalogueSeries = getSeriesIndex(library).get(seriesId)
  const offlineSeries = useMemo(() => buildOfflineSeriesDetail(record), [record])
  const coverSeries = catalogueSeries ? { ...catalogueSeries, coverUrl: offlineSeries.coverUrl ?? catalogueSeries.coverUrl } : offlineSeries
  const active = Boolean(activity) || isActiveDownload(record)
  const progress = progressOf(record, activity)
  const partialSeries = record.status === 'ready' && catalogueSeries && seriesAvailability(records, catalogueSeries) === 'partial'
  const status = partialSeries ? t.downloads.status.partial : t.downloads.status[record.status]
  const title = record.manifest.title
  const subtitle = record.manifest.seriesTitle !== title ? record.manifest.seriesTitle : t.categories[record.manifest.category]

  const read = () => {
    const firstEntry = record.manifest.entries[0]

    if (firstEntry) {
      navigate({
        name: 'offlineReader',
        downloadId: record.id,
        entryId: firstEntry.entryId,
        page: null,
        percent: null,
        variantId: null,
      })
    }
  }

  const remove = async () => {
    const confirmed = await confirmAction({
      title: t.downloads.remove,
      body: t.downloads.removeConfirm(title),
      confirmLabel: t.downloads.remove,
      danger: true,
    })

    if (confirmed) {
      await removeDownload(record.id)
    }
  }

  const retryTarget = partialSeries ? { type: 'series' as const, seriesId } : record.manifest.target
  const retryLabel = partialSeries || record.status === 'partial'
    ? t.downloads.downloadRest
    : record.status === 'stale'
      ? t.downloads.update
      : record.status === 'paused'
        ? t.downloads.resume
        : record.status === 'ready'
          ? t.downloads.update
          : t.downloads.retry

  return (
    <li className="download-row">
      <div className="download-row__cover">
        <Cover compact series={coverSeries} />
      </div>
      <div className="download-row__body">
        <span className="download-row__title">{title}</span>
        <span className="download-row__meta">{subtitle}</span>
        <span className="download-row__status">
          <strong>{activity ? t.downloads.status.downloading : status}</strong>
          {' · '}
          {active || record.status !== 'ready'
            ? t.downloads.bytes(
                formatBytes(activity?.bytes ?? record.downloadedBytes, t),
                formatBytes(record.manifest.estimatedBytes, t),
              )
            : formatBytes(record.downloadedBytes, t)}
          {record.resourceCount > 1 && ` · ${t.downloads.progress(activity?.done ?? record.downloadedResourceCount, record.resourceCount)}`}
        </span>
        {(active || (record.status !== 'ready' && progress > 0)) && <Meter thin value={progress} />}
        {record.status === 'stale' && <span className="download-row__note">{t.downloads.staleNote}</span>}
        {record.failureReason && record.status !== 'ready' && (
          <span className="download-row__note download-row__note--error">{record.failureReason}</span>
        )}
      </div>
      <div className="download-row__actions">
        {record.status === 'ready' && (
          <button className="btn btn--small btn--primary" disabled={removing} onClick={read} type="button">
            <BookOpen aria-hidden="true" />
            {t.downloads.read}
          </button>
        )}
        {active ? (
          <button className="btn btn--small" onClick={() => void pauseDownload(record)} type="button">
            <Pause aria-hidden="true" />
            {t.downloads.pause}
          </button>
        ) : (record.status !== 'ready' || partialSeries) && (
          <button className="btn btn--small" disabled={offline || removing} onClick={() => void startDownload(retryTarget)} type="button">
            {record.status === 'paused' ? <Play aria-hidden="true" /> : <RotateCw aria-hidden="true" />}
            {retryLabel}
          </button>
        )}
        <button
          aria-label={`${t.downloads.remove}: ${title}`}
          className="icon-btn icon-btn--outlined icon-btn--small"
          disabled={removing}
          onClick={() => void remove()}
          type="button"
        >
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    </li>
  )
})

export function DownloadsPage() {
  const t = useT()
  const offline = useOffline()
  const records = useDownloadRecords()
  const loaded = useDownloadsLoaded()
  const activity = useDownloadActivity()
  const summary = useStorageSummary()
  const [filter, setFilter] = useState<Filter>('all')
  useDocumentTitle(t.downloads.title)

  const counts = useMemo(
    () => ({
      active: records.filter((record) => isActiveDownload(record) || activity[targetKey(record.manifest.target)]).length,
      ready: records.filter((record) => record.status === 'ready').length,
      attention: records.filter(needsAttention).length,
    }),
    [activity, records],
  )

  const visible = records.filter((record) => {
    switch (filter) {
      case 'active':
        return isActiveDownload(record) || Boolean(activity[targetKey(record.manifest.target)])
      case 'ready':
        return record.status === 'ready'
      case 'attention':
        return needsAttention(record)
      default:
        return true
    }
  })

  const usedBytes = summary?.downloadedBytes ?? records.reduce((sum, record) => sum + record.downloadedBytes, 0)
  const quotaRatio = summary?.browserQuotaBytes ? Math.min(1, (summary.browserUsageBytes ?? 0) / summary.browserQuotaBytes) : null
  const removingAll = Boolean(activity.all)

  const removeAll = async () => {
    const confirmed = await confirmAction({
      title: t.downloads.removeAll,
      body: t.downloads.removeAllConfirm,
      confirmLabel: t.downloads.removeAll,
      danger: true,
    })

    if (confirmed) {
      await removeAllDownloads()
    }
  }

  return (
    <>
      <TopBar title={t.downloads.title} />
      <div className="page page--narrow downloads">
        <header className="page-head">
          <div className="page-head__text">
            <h1>{t.downloads.title}</h1>
            <p className="page-head__subtitle">{t.downloads.intro}</p>
          </div>
        </header>

        <section className="panel storage-card">
          <HardDrive aria-hidden="true" className="storage-card__icon" />
          <div className="storage-card__body">
            <strong className="storage-card__used">{t.downloads.used(formatBytes(usedBytes, t))}</strong>
            {quotaRatio != null && summary?.browserQuotaBytes != null && (
              <>
                <Meter thin value={quotaRatio} />
                <span className="text-muted text-small">
                  {t.downloads.usedOf(formatBytes(summary.browserUsageBytes, t), formatBytes(summary.browserQuotaBytes, t))}
                </span>
              </>
            )}
          </div>
          {!isNativeApp && summary && summary.persistent !== true && (
            <button className="btn btn--small" onClick={() => void requestPersistence()} title={t.downloads.protectHelp} type="button">
              <ShieldCheck aria-hidden="true" />
              {t.downloads.protect}
            </button>
          )}
          {!isNativeApp && summary?.persistent === true && (
            <span className="chip chip--quiet">
              <ShieldCheck aria-hidden="true" />
              {t.downloads.protected}
            </span>
          )}
        </section>

        {records.length > 0 && (
          <Segmented
            block
            label={t.downloads.title}
            onChange={setFilter}
            options={[
              { value: 'all', label: `${t.downloads.filterAll} ${records.length}` },
              { value: 'active', label: `${t.downloads.filterActive} ${counts.active}` },
              { value: 'ready', label: `${t.downloads.filterReady} ${counts.ready}` },
              { value: 'attention', label: `${t.downloads.filterAttention} ${counts.attention}` },
            ]}
            value={filter}
          />
        )}

        {!loaded ? (
          <p className="spinner-text">{t.common.loading}</p>
        ) : visible.length === 0 ? (
          <EmptyState body={records.length === 0 ? t.downloads.emptyBody : undefined} icon={ArrowDownToLine} title={t.downloads.empty} />
        ) : (
          <ul className="download-list">
            {visible.map((record) => (
              <DownloadRow
                activity={activity[targetKey(record.manifest.target)] ?? null}
                key={record.id}
                offline={offline}
                record={record}
                removing={removingAll || Boolean(activity[record.id])}
              />
            ))}
          </ul>
        )}

        {records.length > 0 && (
          <div>
            <button className="btn btn--danger" disabled={removingAll} onClick={() => void removeAll()} type="button">
              <Trash2 aria-hidden="true" />
              {t.downloads.removeAll}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
