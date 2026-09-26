import {
  ArrowDownToLine,
  ArrowUpDown,
  BookOpen,
  Check,
  CircleDot,
  ExternalLink,
  MessageSquare,
  Pause,
  RotateCcw,
} from 'lucide-react'
import { memo, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import type {
  Bookmark,
  EntryUnit,
  LibraryEntry,
  OfflineDownloadRecord,
  OfflineDownloadTarget,
  SavedReadingPosition,
  SeriesDetail,
  SeriesSummary,
} from '../appTypes'
import { useNow } from '../app/clock'
import { useOffline } from '../app/connection'
import { confirmAction } from '../app/dialogs'
import {
  downloadsStore,
  pauseDownload,
  removeDownload,
  startDownload,
  targetKey,
  useDownloadRecords,
  type DownloadActivity,
} from '../app/downloads'
import { getSeriesIndex, libraryStore, type LibraryState } from '../app/library'
import { browseTarget, useDocumentTitle } from '../app/navigation'
import { notify } from '../app/notices'
import { buildOfflineSeriesDetail, getDownloadIndex, seriesAvailability } from '../app/offlineLibrary'
import { navigate, replaceRoute } from '../app/router'
import { loadSeries, updateSeriesComments, useSeriesState } from '../app/series'
import {
  creatorKey,
  entryDisplayTitle,
  entryLabel,
  entryUnitOf,
  formatUnitCount,
  seriesCreator,
  seriesDescription,
  seriesTitle,
  seriesTopics,
  summarizeProgress,
  unitHeading,
} from '../app/seriesText'
import { useStore } from '../app/store'
import { formatBytes, formatDate, formatDateTime, formatRelative, useT, type Strings } from '../i18n'
import { libraryRoute, readerRoute, type AppRoute } from '../routing'
import { TopBar } from '../shell/TopBar'
import { EmptyState, Meter, Pager, SectionHead } from '../ui/bits'
import { Cover } from '../ui/Cover'
import { Link } from '../ui/Link'
import { TitleCard } from '../ui/TitleCard'
import { ProblemPage } from './ProblemPage'

type SeriesRoute = Extract<AppRoute, { name: 'series' }>

const entriesPerPage = 100

const selectSeriesData = (seriesId: string) => (state: LibraryState) => ({
  summary: getSeriesIndex(state.library).get(seriesId) ?? null,
  bookmark: state.bookmarks.find((bookmark) => bookmark.seriesId === seriesId) ?? null,
  positions: state.readingPositions,
  library: state.library,
  loaded: state.loaded,
})

const sameSeriesData = (
  left: ReturnType<ReturnType<typeof selectSeriesData>>,
  right: ReturnType<ReturnType<typeof selectSeriesData>>,
) =>
  left.summary === right.summary &&
  left.bookmark === right.bookmark &&
  left.positions === right.positions &&
  left.library === right.library &&
  left.loaded === right.loaded

const findEntryIndex = (entries: LibraryEntry[], variantId: string | null | undefined) =>
  variantId
    ? entries.findIndex((entry) => entry.id === variantId || entry.variants.some((variant) => variant.id === variantId))
    : -1

const entryTarget = (entry: LibraryEntry): OfflineDownloadTarget => ({ type: 'entry', entryId: entry.preferredVariantId })

const percentOf = (activity: DownloadActivity | null) => {
  if (!activity) {
    return 0
  }

  if (activity.totalBytes > 0) {
    return Math.min(1, activity.bytes / activity.totalBytes)
  }

  return activity.total > 0 ? activity.done / activity.total : 0
}

/* -------------------------------------------------------- download control -- */

type DownloadControlProps = {
  series: SeriesSummary
  detail: SeriesDetail | null
  records: OfflineDownloadRecord[]
  offline: boolean
}

function SeriesDownloadControl({ series, detail, records, offline }: DownloadControlProps) {
  const t = useT()
  const single = (detail?.entries.length ?? series.stats.fileCount) <= 1
  const target: OfflineDownloadTarget | null = single
    ? detail?.entries[0]
      ? entryTarget(detail.entries[0])
      : null
    : { type: 'series', seriesId: series.id }
  const key = target ? targetKey(target) : null
  const activity = useStore(downloadsStore, (state) => (key ? state.activity[key] ?? null : null))
  const index = getDownloadIndex(records)
  const availability = seriesAvailability(records, series)
  const downloadedCount = index.coverage.get(series.id)?.size ?? 0
  const record = single
    ? detail?.entries[0]
      ? index.readyByEntry.get(detail.entries[0].preferredVariantId) ?? null
      : null
    : index.bySeriesTarget.get(series.id) ?? null

  if (activity && target) {
    const running = records.find((item) => targetKey(item.manifest.target) === key)

    return (
      <div className="download-progress">
        <div className="download-progress__text">
          <ArrowDownToLine aria-hidden="true" />
          <span>
            {activity.phase === 'downloading'
              ? `${t.series.downloading} ${Math.round(percentOf(activity) * 100)}%`
              : activity.phase === 'reusing'
                ? t.downloads.reusing(activity.done, activity.total)
                : t.downloads.preparing}
          </span>
        </div>
        <Meter value={percentOf(activity)} />
        {running && (
          <button className="btn btn--small" onClick={() => void pauseDownload(running)} type="button">
            <Pause aria-hidden="true" />
            {t.downloads.pause}
          </button>
        )}
      </div>
    )
  }

  if (availability === 'complete' && record) {
    const remove = async () => {
      const confirmed = await confirmAction({
        title: t.series.removeDownload,
        body: t.downloads.removeConfirm(seriesTitle(series)),
        confirmLabel: t.downloads.remove,
        danger: true,
      })

      if (confirmed) {
        await removeDownload(record.id)
      }
    }

    return (
      <button className="btn" onClick={() => void remove()} type="button">
        <Check aria-hidden="true" />
        {t.series.downloaded}
      </button>
    )
  }

  if (!target) {
    return null
  }

  return (
    <button
      className="btn"
      disabled={offline}
      onClick={() => void startDownload(target)}
      type="button"
    >
      <ArrowDownToLine aria-hidden="true" />
      {availability === 'partial' && !single
        ? `${t.series.downloadRest} (${t.series.downloadedPartly(downloadedCount, series.stats.fileCount)})`
        : single
          ? t.series.download
          : t.series.downloadAll}
    </button>
  )
}

/* ------------------------------------------------------------ entry rows -- */

type EntryRowProps = {
  entry: LibraryEntry
  series: SeriesSummary
  state: 'read' | 'current' | 'unread'
  position: SavedReadingPosition | undefined
  downloaded: boolean
  activity: DownloadActivity | null
  offline: boolean
  showFormat: boolean
  onOpen: (entry: LibraryEntry) => void
}

const EntryRow = memo(function EntryRow({
  entry,
  series,
  state,
  position,
  downloaded,
  activity,
  offline,
  showFormat,
  onOpen,
}: EntryRowProps) {
  const t = useT()
  const label = entryLabel(entry.label, t)
  const title = entryDisplayTitle(entry, series)
  const variant = entry.variants.find((item) => item.id === entry.preferredVariantId) ?? entry.variants[0]
  const where =
    state === 'current' && position
      ? position.locationType === 'percent'
        ? t.reader.percent(Math.round(position.page))
        : position.totalPages
          ? t.progress.pageOf(position.page, position.totalPages)
          : null
      : null

  return (
    <li className={`entry-row entry-row--${state}`}>
      <button className="entry-row__open" onClick={() => onOpen(entry)} type="button">
        <span aria-hidden="true" className="entry-row__state">
          {state === 'read' ? <Check /> : state === 'current' ? <CircleDot /> : null}
        </span>
        <span className="entry-row__text">
          <span className="entry-row__label">
            {label}
            {state === 'current' && <span className="chip chip--solid entry-row__badge">{t.series.stateReading}</span>}
          </span>
          {title && <span className="entry-row__title">{title}</span>}
          {(where || showFormat || entry.variants.length > 1) && (
            <span className="entry-row__meta">
              {[
                where,
                showFormat && variant ? variant.format.toUpperCase() : null,
                entry.variants.length > 1 ? t.series.editions(entry.variants.length) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </span>
        <span className="visually-hidden">{state === 'read' ? t.series.stateRead : ''}</span>
      </button>
      <span className="entry-row__download">
        {downloaded ? (
          <span aria-label={t.series.entryDownloaded(label)} className="entry-row__saved" role="img">
            <Check aria-hidden="true" />
          </span>
        ) : activity ? (
          <span className="entry-row__percent">{Math.round(percentOf(activity) * 100)}%</span>
        ) : (
          <button
            aria-label={t.series.downloadEntry(label)}
            className="icon-btn"
            disabled={offline}
            onClick={() => void startDownload(entryTarget(entry))}
            type="button"
          >
            <ArrowDownToLine aria-hidden="true" />
          </button>
        )}
      </span>
    </li>
  )
})

/* -------------------------------------------------------------- comments -- */

function Comments({ detail, offline }: { detail: SeriesDetail; offline: boolean }) {
  const t = useT()
  const now = useNow()
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!draft.trim()) {
      return
    }

    setPosting(true)

    try {
      const comments = await api.addComment({ seriesId: detail.id, text: draft.trim() })
      updateSeriesComments(detail.id, comments)
      setDraft('')
    } catch (error) {
      notify(error instanceof Error ? error.message : t.common.somethingWentWrong, 'error')
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="stack comments">
      {!offline && (
        <form className="comment-form" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span className="visually-hidden">{t.series.comments}</span>
            <textarea
              className="textarea"
              maxLength={4000}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t.series.commentPlaceholder}
              rows={3}
              value={draft}
            />
          </label>
          <button className="btn btn--primary" disabled={posting || !draft.trim()} type="submit">
            {posting ? t.series.posting : t.series.post}
          </button>
        </form>
      )}
      {detail.comments.length === 0 ? (
        <p className="text-muted">{t.series.noComments}</p>
      ) : (
        <ul className="comment-list">
          {[...detail.comments].reverse().map((comment) => (
            <li className="comment" key={comment.id}>
              <div className="comment__head">
                <strong>{comment.user}</strong>
                <span className="text-muted" title={formatDateTime(comment.when, t)}>
                  {formatRelative(comment.when, t, now)}
                </span>
              </div>
              <p className="comment__text">{comment.text}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- details -- */

function AboutSection({ series, detail, library }: { series: SeriesSummary; detail: SeriesDetail | null; library: SeriesSummary[] }) {
  const t = useT()
  const now = useNow()
  const creator = seriesCreator(series)
  const variants = detail?.entries.flatMap((entry) => entry.variants) ?? []
  const formats = [...new Set(variants.map((variant) => variant.format.toUpperCase()))].join(', ') || series.format
  const single = detail?.entries.length === 1 ? detail.entries[0] : null
  const singleVariant = single?.variants.find((variant) => variant.id === single.preferredVariantId) ?? single?.variants[0]
  const totalSize = variants.reduce((sum, variant) => sum + (variant.size ?? 0), 0)
  const moreByCreator = useMemo(() => {
    if (!creator) {
      return []
    }

    const key = creatorKey(creator)
    return library
      .filter((item) => {
        const itemCreator = seriesCreator(item)
        return item.id !== series.id && itemCreator != null && creatorKey(itemCreator) === key
      })
      .slice(0, 12)
  }, [creator, library, series.id])

  return (
    <div className="stack about">
      <dl className="details-list">
        {creator && (
          <>
            <dt>{series.sourceRole || t.series.author}</dt>
            <dd>
              <Link className="link-btn" to={{ name: 'creator', creatorKey: creatorKey(creator) }}>
                {creator}
              </Link>
            </dd>
          </>
        )}
        {series.year && (
          <>
            <dt>{t.series.year}</dt>
            <dd>{series.year}</dd>
          </>
        )}
        <dt>{t.series.format}</dt>
        <dd>{formats}</dd>
        {singleVariant?.pageCount ? (
          <>
            <dt>{t.series.pages}</dt>
            <dd>{singleVariant.pageCount.toLocaleString(t.locale)}</dd>
          </>
        ) : null}
        {totalSize > 0 && (
          <>
            <dt>{t.series.size}</dt>
            <dd>{formatBytes(totalSize, t)}</dd>
          </>
        )}
        {series.addedAt && (
          <>
            <dt>{t.series.added}</dt>
            <dd>{formatDate(series.addedAt, t)}</dd>
          </>
        )}
        <dt>{t.series.metadata}</dt>
        <dd>{series.metadataSource}</dd>
        <dt>{t.series.lastScan}</dt>
        <dd>{formatRelative(series.stats.lastScanAt, t, now)}</dd>
        {series.folder && (
          <>
            <dt>{t.series.folder}</dt>
            <dd className="about__path">{series.folder}</dd>
          </>
        )}
      </dl>
      {series.externalUrl && (
        <a className="btn btn--small about__external" href={series.externalUrl} rel="noreferrer" target="_blank">
          <ExternalLink aria-hidden="true" />
          {t.series.openSource}
        </a>
      )}
      {moreByCreator.length > 0 && creator && (
        <section className="section">
          <SectionHead title={t.series.moreBy(creator)} />
          <div className="title-grid title-grid--row">
            {moreByCreator.map((item) => (
              <TitleCard key={item.id} series={item} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function Description({ text }: { text: string }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 420

  if (!text.trim()) {
    return null
  }

  return (
    <div className="description">
      <p className={expanded || !long ? '' : 'clamp-6'}>{text}</p>
      {long && (
        <button className="link-btn" onClick={() => setExpanded((value) => !value)} type="button">
          {expanded ? t.common.showLess : t.common.showMore}
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ page -- */

const primaryAction = (
  entries: LibraryEntry[],
  bookmark: Bookmark | null,
  positions: Record<string, SavedReadingPosition>,
  series: SeriesSummary,
  t: Strings,
) => {
  const currentIndex = findEntryIndex(entries, bookmark?.entryId)

  if (bookmark && currentIndex >= 0) {
    const summary = summarizeProgress(bookmark, { ...series, stats: { ...series.stats, fileCount: entries.length } }, positions[bookmark.entryId], t)

    const position = positions[bookmark.entryId]
    const atStart = !position || (position.locationType === 'percent' ? position.page <= 0 : position.page <= 1)

    if (currentIndex === 0 && atStart) {
      return { label: t.series.read, entry: entries[0], variantId: bookmark.entryId, icon: BookOpen, summary: null }
    }

    if (summary.finished) {
      return { label: t.series.readAgain, entry: entries[0], variantId: null, icon: RotateCcw, summary }
    }

    return {
      label: t.series.continueAt(summary.where),
      entry: entries[currentIndex],
      variantId: bookmark.entryId,
      icon: BookOpen,
      summary,
    }
  }

  return { label: t.series.read, entry: entries[0] ?? null, variantId: null, icon: BookOpen, summary: null }
}

export function SeriesPage({ route }: { route: SeriesRoute }) {
  const t = useT()
  const offline = useOffline()
  const records = useDownloadRecords()
  const selector = useMemo(() => selectSeriesData(route.seriesId), [route.seriesId])
  const { summary, bookmark, positions, library, loaded } = useStore(libraryStore, selector, sameSeriesData)
  const { detail: loadedDetail, error, errorStatus } = useSeriesState(route.seriesId)
  const [newestFirst, setNewestFirst] = useState(false)
  const activity = useStore(downloadsStore, (state) => state.activity)

  useEffect(() => {
    void loadSeries(route.seriesId).catch(() => undefined)
  }, [route.seriesId, summary?.stats.lastScanAt])

  const offlineDetail = useMemo(() => {
    const record = getDownloadIndex(records).readyBySeries.get(route.seriesId)
    return record ? buildOfflineSeriesDetail(record) : null
  }, [records, route.seriesId])

  const detail = loadedDetail ?? (offline ? offlineDetail : null)
  const series: SeriesSummary | null = summary ?? detail
  useDocumentTitle(series ? seriesTitle(series) : null)

  if (!series) {
    if (errorStatus === 404) {
      return <ProblemPage kind="gone" />
    }

    if (offline && loaded) {
      return (
        <>
          <TopBar back={browseTarget()} title={t.nav.browse} />
          <div className="page">
            <EmptyState icon={BookOpen} title={t.series.notAvailableOffline} />
          </div>
        </>
      )
    }

    return (
      <>
        <TopBar back={browseTarget()} title={t.common.loading} />
        <div className="page">
          <p className="spinner-text">{error ?? t.common.loading}</p>
        </div>
      </>
    )
  }

  const entries = detail?.entries ?? []
  const unit: EntryUnit = entryUnitOf(series, entries)
  const single = entries.length === 1 || (!detail && series.stats.fileCount <= 1)
  const title = seriesTitle(series)
  const creator = seriesCreator(series)
  const action = primaryAction(entries, bookmark, positions, series, t)
  const currentIndex = findEntryIndex(entries, bookmark?.entryId)
  const index = getDownloadIndex(records)
  const topics = seriesTopics(series)
  const formats = new Set(entries.flatMap((entry) => entry.variants.map((variant) => variant.format)))
  const tab = single ? 'overview' : route.tab

  const openEntry = (entry: LibraryEntry, variantId?: string | null) => {
    const downloaded = index.readyByEntry.get(variantId ?? entry.preferredVariantId)

    if (offline) {
      if (!downloaded) {
        notify(t.series.notAvailableOffline, 'error')
        return
      }

      navigate({
        name: 'offlineReader',
        downloadId: downloaded.id,
        entryId: variantId ?? entry.preferredVariantId,
        page: null,
        percent: null,
        variantId: null,
      })
      return
    }

    navigate(readerRoute(series.category, series.id, entry.id, { variantId: variantId && variantId !== entry.preferredVariantId ? variantId : null }))
  }

  const orderedEntries = newestFirst ? [...entries].reverse() : entries
  const pageCount = Math.max(1, Math.ceil(orderedEntries.length / entriesPerPage))
  const page = Math.min(route.page, pageCount)
  const pageEntries = orderedEntries.slice((page - 1) * entriesPerPage, page * entriesPerPage)
  const currentPage = currentIndex >= 0
    ? Math.floor((newestFirst ? entries.length - 1 - currentIndex : currentIndex) / entriesPerPage) + 1
    : null

  const setTab = (nextTab: SeriesRoute['tab']) => replaceRoute({ ...route, tab: nextTab, page: 1 })

  return (
    <>
      <TopBar back={libraryRoute(series.category === 'anime' ? 'books' : series.category)} title={title} />
      <div className="page series">
        <section className="series-head">
          <div className="series-head__cover">
            <Cover availability={seriesAvailability(records, series)} eager large series={series} />
          </div>
          <div className="series-head__info">
            <Link className="kicker" to={libraryRoute(series.category === 'anime' ? 'books' : series.category)}>
              {t.categories[series.category]}
            </Link>
            <h1 className="series-head__title">{title}</h1>
            {(creator || series.year) && (
              <p className="series-head__byline">
                {creator && (
                  <Link className="series-head__creator" to={{ name: 'creator', creatorKey: creatorKey(creator) }}>
                    {creator}
                  </Link>
                )}
                {creator && series.year ? ' · ' : ''}
                {series.year}
              </p>
            )}
            {!single && (
              <p className="series-head__facts">
                {formatUnitCount(unit, detail ? entries.length : series.stats.fileCount, t)}
              </p>
            )}
            <div className="series-head__actions">
              <button
                className="btn btn--primary series-head__read"
                disabled={!action.entry}
                onClick={() => action.entry && openEntry(action.entry, action.variantId)}
                type="button"
              >
                <action.icon aria-hidden="true" />
                <span className="clamp-2">{action.entry ? action.label : t.series.loadingContents}</span>
              </button>
              <SeriesDownloadControl detail={detail} offline={offline} records={records} series={series} />
            </div>
            {action.summary && !action.summary.finished && (
              <div className="series-head__progress">
                <Meter label={action.summary.where} value={action.summary.ratio} />
                {action.summary.remaining && <span className="text-muted text-small">{t.home.left(action.summary.remaining)}</span>}
              </div>
            )}
            <Description text={seriesDescription(detail?.description ?? series.description)} />
            {topics.length > 0 && (
              <div className="cluster">
                {topics.slice(0, 10).map((topic) =>
                  series.category === 'books' ? (
                    <Link className="chip" key={topic} to={libraryRoute('books', { topics: [topic] })}>
                      {topic}
                    </Link>
                  ) : (
                    <span className="chip chip--quiet" key={topic}>
                      {topic}
                    </span>
                  ),
                )}
              </div>
            )}
          </div>
        </section>

        {single ? (
          <>
            <section className="section">
              <SectionHead title={t.series.details} />
              <AboutSection detail={detail} library={library} series={series} />
            </section>
            {detail && (
              <section className="section">
                <SectionHead meta={detail.comments.length || undefined} title={t.series.comments} />
                <Comments detail={detail} offline={offline} />
              </section>
            )}
          </>
        ) : (
          <section className="section">
            <div className="tabs" role="tablist">
              <button aria-selected={tab === 'entries'} className="tab" onClick={() => setTab('entries')} role="tab" type="button">
                {unitHeading(unit, t)}
                <span className="tab__count">{(detail ? entries.length : series.stats.fileCount).toLocaleString(t.locale)}</span>
              </button>
              <button aria-selected={tab === 'overview'} className="tab" onClick={() => setTab('overview')} role="tab" type="button">
                {t.series.about}
              </button>
              <button aria-selected={tab === 'comments'} className="tab" onClick={() => setTab('comments')} role="tab" type="button">
                <MessageSquare aria-hidden="true" size={18} />
                {t.series.comments}
                {detail && detail.comments.length > 0 && <span className="tab__count">{detail.comments.length}</span>}
              </button>
            </div>

            {tab === 'entries' && (
              <>
                {!detail ? (
                  <p className="spinner-text">{offline ? t.series.notAvailableOffline : error ?? t.series.loadingContents}</p>
                ) : (
                  <>
                    <div className="entries-toolbar">
                      <button className="btn btn--small" onClick={() => setNewestFirst((value) => !value)} type="button">
                        <ArrowUpDown aria-hidden="true" />
                        {newestFirst ? t.series.newestFirst : t.series.oldestFirst}
                      </button>
                      {currentPage && currentPage !== page && (
                        <button className="btn btn--small" onClick={() => replaceRoute({ ...route, page: currentPage })} type="button">
                          <CircleDot aria-hidden="true" />
                          {t.series.stateReading}
                        </button>
                      )}
                      <span className="spacer" />
                      {pageCount > 1 && (
                        <span className="text-muted text-small">
                          {t.common.rangeOf((page - 1) * entriesPerPage + 1, Math.min(page * entriesPerPage, entries.length), entries.length)}
                        </span>
                      )}
                    </div>
                    <ul className="entry-list">
                      {pageEntries.map((entry) => {
                        const entryIndex = entries.indexOf(entry)
                        const state = entryIndex === currentIndex
                          ? 'current'
                          : currentIndex >= 0 && entryIndex < currentIndex
                            ? 'read'
                            : 'unread'

                        return (
                          <EntryRow
                            activity={activity[targetKey(entryTarget(entry))] ?? null}
                            downloaded={entry.variants.some((variant) => index.readyByEntry.has(variant.id))}
                            entry={entry}
                            key={entry.id}
                            offline={offline}
                            onOpen={openEntry}
                            position={state === 'current' && bookmark ? positions[bookmark.entryId] : undefined}
                            series={series}
                            showFormat={formats.size > 1}
                            state={state}
                          />
                        )
                      })}
                    </ul>
                    <Pager onChange={(nextPage) => navigate({ ...route, page: nextPage }, { replace: true })} page={page} pageCount={pageCount} />
                  </>
                )}
              </>
            )}

            {tab === 'overview' && <AboutSection detail={detail} library={library} series={series} />}

            {tab === 'comments' && (detail ? (
              <Comments detail={detail} offline={offline} />
            ) : (
              <p className="spinner-text">{t.common.loading}</p>
            ))}
          </section>
        )}

        {detail && !single && offline && entries.length > 0 && (
          <p className="text-muted text-small">{t.connection.offline}</p>
        )}
      </div>
    </>
  )
}
