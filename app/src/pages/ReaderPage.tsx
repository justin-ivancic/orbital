import {
  ArrowDownToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  ListOrdered,
  Type,
  X,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryEntry, SavedReadingPosition, SeriesDetail, SeriesSummary } from '../appTypes'
import { useOffline } from '../app/connection'
import { startDownload, useDownloadRecords } from '../app/downloads'
import { getSeriesIndex, libraryStore } from '../app/library'
import { useDocumentTitle } from '../app/navigation'
import {
  buildOfflinePagesForEntry,
  buildOfflineSeriesDetail,
  getDownloadIndex,
  offlineResourceUrl,
} from '../app/offlineLibrary'
import { preferencesStore, type DevicePreferences } from '../app/preferences'
import { recordProgress } from '../app/progress'
import { useSeriesReaderSettings } from '../app/readerSettings'
import { exitReader, navigate, replaceRoute } from '../app/router'
import { loadSeries, useSeriesState } from '../app/series'
import { entryDisplayTitle, entryLabel, seriesTitle } from '../app/seriesText'
import { useStore } from '../app/store'
import { isNativeApp } from '../platform'
import { readerBeginningLocation, readerRoute, seriesRoute, type AppRoute } from '../routing'
import { useT } from '../i18n'
import { CbzReader } from '../readers/CbzReader'
import { DisplaySheet } from '../readers/DisplaySheet'
import { FlowReader } from '../readers/FlowReader'
import type { ReaderController, ReaderPosition, ReaderSource, TocItem } from '../readers/types'
import { Sheet } from '../ui/Sheet'
import { ProblemPage } from './ProblemPage'

type ReaderRoute = Extract<AppRoute, { name: 'reader' | 'offlineReader' }>

// pdf.js and epub.js are large; each loads only when a file of its kind opens.
const PdfReader = lazy(() => import('../readers/PdfReader').then((module) => ({ default: module.PdfReader })))
const EpubReader = lazy(() => import('../readers/EpubReader').then((module) => ({ default: module.EpubReader })))

const hintKey = 'orbital:reader-hint-seen'
const selectPreferences = (state: DevicePreferences) => state

const readHintSeen = () => {
  try {
    return window.localStorage.getItem(hintKey) === '1'
  } catch {
    return true
  }
}

const findEntry = (detail: SeriesDetail | null, id: string) => {
  if (!detail) {
    return { entry: null, index: -1 }
  }

  const index = detail.entries.findIndex(
    (entry) => entry.id === id || entry.variants.some((variant) => variant.id === id),
  )

  return { entry: index >= 0 ? detail.entries[index] : null, index }
}

type SessionProps = {
  route: ReaderRoute
  series: SeriesSummary
  detail: SeriesDetail
  entry: LibraryEntry
  entryIndex: number
  variantId: string
  source: ReaderSource
}

function ReaderSession({ route, series, detail, entry, entryIndex, variantId, source }: SessionProps) {
  const t = useT()
  const offline = useOffline()
  const preferences = useStore(preferencesStore, selectPreferences)
  const records = useDownloadRecords()
  const [settings, setSettings] = useSeriesReaderSettings(series.id, series.category, source.format)
  const [chrome, setChrome] = useState(true)
  const [sheet, setSheet] = useState<'display' | 'contents' | 'more' | null>(null)
  const [hintOpen, setHintOpen] = useState(() => !readHintSeen())
  const [position, setPosition] = useState<ReaderPosition | null>(null)
  const [scrub, setScrub] = useState<number | null>(null)
  const [toc, setToc] = useState<TocItem[]>([])
  const [failed, setFailed] = useState<string | null>(null)
  const controllerRef = useRef<ReaderController | null>(null)
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const urlTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<ReaderPosition | null>(null)

  // The start position is read once per opened file.
  const [initial] = useState<SavedReadingPosition | null>(() => {
    const saved = libraryStore.get().readingPositions[variantId] ?? null

    if (route.page != null) {
      return { ...saved, page: route.page, locationType: 'page', locator: undefined }
    }

    if (route.percent != null) {
      return {
        ...saved,
        page: route.percent,
        locationType: 'percent',
        locator: saved?.page === route.percent ? saved.locator : undefined,
      }
    }

    return saved
  })

  const label = entryLabel(entry.label, t)
  const subtitle = entryDisplayTitle(entry, series)
  const unitTitle = detail.entries.length > 1 ? label : seriesTitle(series)
  useDocumentTitle(detail.entries.length > 1 ? `${label} · ${seriesTitle(series)}` : seriesTitle(series))

  const saveProgress = useCallback(
    (value: ReaderPosition) => {
      recordProgress({
        seriesId: series.id,
        category: series.category,
        entryLabel: entry.label,
        entryTitle: entry.title,
        variantId,
        entryIndex,
        position: {
          page: value.page,
          totalPages: value.totalPages,
          viewMode: value.viewMode,
          locationType: value.locationType,
          locator: value.locator,
        },
      })
    },
    [entry.label, entry.title, entryIndex, series.category, series.id, variantId],
  )

  const routeRef = useRef(route)

  useEffect(() => {
    routeRef.current = route
  }, [route])

  const handlePosition = useCallback(
    (value: ReaderPosition) => {
      latest.current = value
      setPosition(value)

      if (progressTimer.current) {
        clearTimeout(progressTimer.current)
      }

      progressTimer.current = setTimeout(() => saveProgress(value), 900)

      if (urlTimer.current) {
        clearTimeout(urlTimer.current)
      }

      urlTimer.current = setTimeout(() => {
        const percent = value.locationType === 'percent'
        replaceRoute({
          ...routeRef.current,
          page: percent ? null : Math.max(1, Math.round(value.page)),
          percent: percent ? Math.round(value.page) : null,
        })
      }, 1500)
    },
    [saveProgress],
  )

  // Save the last position when the reader closes.
  useEffect(
    () => () => {
      if (progressTimer.current) {
        clearTimeout(progressTimer.current)
      }

      if (urlTimer.current) {
        clearTimeout(urlTimer.current)
      }

      if (latest.current) {
        saveProgress(latest.current)
      }
    },
    [saveProgress],
  )

  const goToEntry = useCallback(
    (index: number, fromEnd = false) => {
      const target = detail.entries[index]

      if (!target) {
        return
      }

      if (latest.current) {
        saveProgress(latest.current)
      }

      const variant = target.variants.find((item) => item.id === target.preferredVariantId) ?? target.variants[0]
      // Going back opens the previous chapter at its saved spot; going forward starts at the top.
      const start = fromEnd ? { page: null, percent: null } : readerBeginningLocation(variant?.format)

      if (route.name === 'offlineReader') {
        navigate({
          name: 'offlineReader',
          downloadId: route.downloadId,
          entryId: target.preferredVariantId,
          page: start.page,
          percent: start.percent,
          variantId: null,
        })
        return
      }

      navigate(readerRoute(series.category, series.id, target.id, start))
    },
    [detail.entries, route, saveProgress, series.category, series.id],
  )

  const hasNext = entryIndex < detail.entries.length - 1
  const hasPrevious = entryIndex > 0
  const onNextEntry = useMemo(() => (hasNext ? () => goToEntry(entryIndex + 1) : undefined), [entryIndex, goToEntry, hasNext])
  const onPreviousEntry = useMemo(
    () => (hasPrevious ? () => goToEntry(entryIndex - 1, true) : undefined),
    [entryIndex, goToEntry, hasPrevious],
  )
  const toggleChrome = useCallback(() => setChrome((value) => !value), [])
  const hideChrome = useCallback(() => setChrome(false), [])
  const handleReady = useCallback((controller: ReaderController) => {
    controllerRef.current = controller
  }, [])
  const handleToc = useCallback((items: TocItem[]) => setToc(items), [])
  const handleError = useCallback((message: string) => setFailed(message), [])

  const close = () => {
    if (latest.current) {
      saveProgress(latest.current)
    }

    exitReader(route.name === 'offlineReader' ? { name: 'downloads' } : seriesRoute(series.category, series.id))
  }

  const dismissHint = () => {
    setHintOpen(false)

    try {
      window.localStorage.setItem(hintKey, '1')
    } catch {
      // The hint shows again next time; harmless.
    }
  }

  const readerProps = {
    source,
    title: `${seriesTitle(series)} ${label}`,
    settings,
    textStyle: preferences.text,
    tapLayout: preferences.tapLayout,
    initial,
    onPosition: handlePosition,
    onCenterTap: toggleChrome,
    onTurn: hideChrome,
    onNextEntry,
    onPreviousEntry,
    onReady: handleReady,
    onError: handleError,
    onToc: handleToc,
  }

  const percentFormat = position?.locationType === 'percent'
  const total = position ? (percentFormat ? 100 : position.totalPages) : 0
  const current = scrub ?? (position ? Math.round(position.page) : 0)
  const progressText = !position
    ? t.reader.loading
    : percentFormat
      ? t.reader.percent(current)
      : position.endPage && position.endPage > position.page && scrub == null
        ? t.reader.pagesOf(position.page, position.endPage, position.totalPages)
        : t.reader.pageOf(current, position.totalPages)
  const variant = entry.variants.find((item) => item.id === variantId) ?? entry.variants[0]
  const entryDownloaded = getDownloadIndex(records).readyByEntry.has(variantId)

  let content = null

  if (failed) {
    content = (
      <div className="reader-state">
        <h2>{t.reader.errorTitle}</h2>
        <p>{failed}</p>
        {!isNativeApp && !source.local && (
          <a className="btn" href={variant?.downloadUrl ?? source.fileUrl} rel="noreferrer" target="_blank">
            <ArrowDownToLine aria-hidden="true" />
            {t.reader.downloadOriginal}
          </a>
        )}
      </div>
    )
  } else if (source.format === 'cbz') {
    content = <CbzReader {...readerProps} />
  } else if (source.format === 'pdf') {
    content = <PdfReader {...readerProps} />
  } else if (source.format === 'epub') {
    content = <EpubReader {...readerProps} />
  } else if (source.format === 'html' || source.format === 'md' || source.format === 'txt') {
    content = <FlowReader {...readerProps} />
  } else {
    content = (
      <div className="reader-state">
        <h2>{t.reader.unsupportedTitle}</h2>
        <p>{t.reader.unsupportedBody(source.format.toUpperCase())}</p>
        {!isNativeApp && (
          <a className="btn" href={variant?.downloadUrl ?? source.fileUrl} rel="noreferrer" target="_blank">
            <ArrowDownToLine aria-hidden="true" />
            {t.reader.downloadOriginal}
          </a>
        )}
      </div>
    )
  }

  return (
    <div className={`reader${chrome ? ' reader--chrome' : ''}`}>
      <div className="reader__content">
        <Suspense fallback={<p className="reader-state">{t.reader.loading}</p>}>{content}</Suspense>
      </div>

      {chrome && (
        <>
          <header className="reader__top">
            <button aria-label={t.reader.close} className="icon-btn" onClick={close} type="button">
              <X aria-hidden="true" />
            </button>
            <div className="reader__titles">
              <span className="reader__series">{seriesTitle(series)}</span>
              <strong className="reader__entry">{detail.entries.length > 1 ? `${unitTitle}${subtitle ? ` · ${subtitle}` : ''}` : unitTitle}</strong>
            </div>
            {(detail.entries.length > 1 || toc.length > 0) && (
              <button aria-label={t.reader.contents} className="icon-btn" onClick={() => setSheet('contents')} type="button">
                <ListOrdered aria-hidden="true" />
              </button>
            )}
            <button aria-label={t.reader.display} className="icon-btn" onClick={() => setSheet('display')} type="button">
              <Type aria-hidden="true" />
            </button>
            <button aria-label={t.common.more} className="icon-btn" onClick={() => setSheet('more')} type="button">
              <EllipsisVertical aria-hidden="true" />
            </button>
          </header>

          <footer className="reader__bottom">
            <button
              aria-label={t.reader.previousEntry}
              className="icon-btn"
              disabled={!hasPrevious}
              onClick={() => goToEntry(entryIndex - 1)}
              type="button"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <div className="reader__scrub">
              <input
                aria-label={t.reader.goToPage}
                className="reader__range"
                disabled={!position || total <= 1}
                max={percentFormat ? 100 : Math.max(1, total)}
                min={percentFormat ? 0 : 1}
                onBlur={() => setScrub(null)}
                onChange={(event) => setScrub(Number(event.target.value))}
                onKeyUp={(event) => {
                  if (event.key === 'Enter' && scrub != null) {
                    controllerRef.current?.goTo(scrub)
                    setScrub(null)
                  }
                }}
                onPointerUp={() => {
                  if (scrub != null) {
                    controllerRef.current?.goTo(scrub)
                    setScrub(null)
                  }
                }}
                step={1}
                type="range"
                value={current}
              />
              <span className="reader__progress">{progressText}</span>
            </div>
            <button
              aria-label={t.reader.nextEntry}
              className="icon-btn"
              disabled={!hasNext}
              onClick={() => goToEntry(entryIndex + 1)}
              type="button"
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </footer>
        </>
      )}

      {hintOpen && (
        <button className="reader-hint" onClick={dismissHint} type="button">
          <span className="reader-hint__zone">
            <ChevronLeft aria-hidden="true" />
            {t.reader.previousPage}
          </span>
          <span className="reader-hint__zone reader-hint__zone--menu">
            <span>{t.reader.tapHint}</span>
            <span className="btn btn--primary">{t.reader.gotIt}</span>
          </span>
          <span className="reader-hint__zone">
            <ChevronRight aria-hidden="true" />
            {t.reader.nextPage}
          </span>
        </button>
      )}

      {sheet === 'display' && (
        <DisplaySheet
          format={source.format}
          onClose={() => setSheet(null)}
          onSettings={setSettings}
          settings={settings}
          textStyle={preferences.text}
        />
      )}

      {sheet === 'contents' && (
        <Sheet onClose={() => setSheet(null)} title={t.reader.contents}>
          {toc.length > 0 && (
            <div className="list">
              {toc.map((item) => (
                <button
                  className="list-row"
                  key={`${item.href}-${item.label}`}
                  onClick={() => {
                    setSheet(null)
                    controllerRef.current?.goToHref?.(item.href)
                  }}
                  style={{ paddingLeft: `calc(var(--space-4) + ${item.depth * 16}px)` }}
                  type="button"
                >
                  <span className="list-row__body">
                    <span className="list-row__title">{item.label}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {detail.entries.length > 1 && (
            <div className="list">
              {detail.entries.map((item, index) => (
                <button
                  aria-current={index === entryIndex ? 'true' : undefined}
                  className={`list-row${index === entryIndex ? ' list-row--current' : ''}`}
                  key={item.id}
                  onClick={() => {
                    setSheet(null)

                    if (index !== entryIndex) {
                      goToEntry(index)
                    }
                  }}
                  type="button"
                >
                  <span className="list-row__body">
                    <span className="list-row__title">{entryLabel(item.label, t)}</span>
                    {entryDisplayTitle(item, series) && (
                      <span className="list-row__meta">{entryDisplayTitle(item, series)}</span>
                    )}
                  </span>
                  {index === entryIndex && <Check aria-hidden="true" className="list-row__chevron" />}
                </button>
              ))}
            </div>
          )}
        </Sheet>
      )}

      {sheet === 'more' && (
        <Sheet onClose={() => setSheet(null)} title={seriesTitle(series)}>
          {entry.variants.length > 1 && (
            <section className="stack" style={{ gap: 'var(--space-2)' }}>
              <h3 className="kicker">{t.series.edition}</h3>
              <div className="list">
                {entry.variants.map((item) => (
                  <button
                    className="list-row"
                    key={item.id}
                    onClick={() => {
                      setSheet(null)

                      if (route.name === 'reader') {
                        navigate(
                          { ...route, variantId: item.id === entry.preferredVariantId ? null : item.id, page: null, percent: null },
                          { replace: true },
                        )
                      }
                    }}
                    type="button"
                  >
                    <span className="list-row__body">
                      <span className="list-row__title">{item.variantLabel}</span>
                      <span className="list-row__meta">{item.format.toUpperCase()} · {item.storageFile}</span>
                    </span>
                    {item.id === variantId && <Check aria-hidden="true" className="list-row__chevron" />}
                  </button>
                ))}
              </div>
            </section>
          )}
          <div className="list">
            {route.name === 'reader' && (
              <button
                className="list-row"
                disabled={offline || entryDownloaded}
                onClick={() => {
                  setSheet(null)
                  void startDownload({ type: 'entry', entryId: variantId })
                }}
                type="button"
              >
                <span className="list-row__body">
                  <span className="list-row__title">
                    {entryDownloaded ? t.series.downloaded : t.series.downloadEntry(detail.entries.length > 1 ? label : seriesTitle(series))}
                  </span>
                </span>
                {entryDownloaded ? <Check aria-hidden="true" className="list-row__chevron" /> : <ArrowDownToLine aria-hidden="true" className="list-row__chevron" />}
              </button>
            )}
            {route.name === 'reader' && (
              <button
                className="list-row"
                onClick={() => {
                  setSheet(null)
                  navigate(seriesRoute(series.category, series.id))
                }}
                type="button"
              >
                <span className="list-row__body">
                  <span className="list-row__title">{t.reader.backToSeries}</span>
                </span>
              </button>
            )}
            {!isNativeApp && variant && (
              <a className="list-row" href={variant.downloadUrl} rel="noreferrer" target="_blank">
                <span className="list-row__body">
                  <span className="list-row__title">{t.reader.downloadOriginal}</span>
                  <span className="list-row__meta">{variant.storageFile}</span>
                </span>
              </a>
            )}
          </div>
        </Sheet>
      )}
    </div>
  )
}

export function ReaderPage({ route }: { route: ReaderRoute }) {
  const t = useT()
  const offline = useOffline()
  const records = useDownloadRecords()
  const onlineSeriesId = route.name === 'reader' ? route.seriesId : null
  const { detail: loadedDetail, error, errorStatus } = useSeriesState(onlineSeriesId)
  const librarySeries = useStore(libraryStore, (state) =>
    onlineSeriesId ? getSeriesIndex(state.library).get(onlineSeriesId) ?? null : null,
  )

  useEffect(() => {
    if (onlineSeriesId) {
      void loadSeries(onlineSeriesId).catch(() => undefined)
    }
  }, [onlineSeriesId])

  const downloadRecord = route.name === 'offlineReader'
    ? records.find((record) => record.id === route.downloadId) ?? null
    : null
  const offlineDetail = useMemo(
    () => (downloadRecord?.status === 'ready' ? buildOfflineSeriesDetail(downloadRecord) : null),
    [downloadRecord],
  )
  const detail = route.name === 'reader' ? loadedDetail : offlineDetail
  const { entry, index } = findEntry(detail, route.entryId)
  const variantId = entry
    ? route.variantId && entry.variants.some((variant) => variant.id === route.variantId)
      ? route.variantId
      : entry.variants.some((variant) => variant.id === route.entryId)
        ? route.entryId
        : entry.preferredVariantId
    : null
  const variant = entry?.variants.find((item) => item.id === variantId) ?? null
  const download = variantId ? getDownloadIndex(records).readyByEntry.get(variantId) ?? null : null

  // Online, a title read offline before is redirected to its downloaded copy.
  useEffect(() => {
    if (route.name === 'reader' && offline && download && variantId && !loadedDetail) {
      navigate(
        { name: 'offlineReader', downloadId: download.id, entryId: variantId, page: route.page, percent: route.percent, variantId: null },
        { replace: true },
      )
    }
  }, [download, loadedDetail, offline, route, variantId])

  const source = useMemo<ReaderSource | null>(() => {
    if (!variant || !variantId) {
      return null
    }

    // A downloaded copy opens faster than streaming, even while online.
    if (download) {
      const manifestEntry = download.manifest.entries.find((item) => item.entryId === variantId)
      const resource = manifestEntry
        ? download.manifest.resources.find((item) => item.key === manifestEntry.resourceKeys[0])
        : null

      return {
        variantId,
        format: variant.format,
        fileUrl: resource ? offlineResourceUrl(download.id, resource) : variant.fileUrl,
        offlinePages: buildOfflinePagesForEntry(download, variantId),
        local: Boolean(resource),
      }
    }

    return { variantId, format: variant.format, fileUrl: variant.fileUrl, offlinePages: null, local: route.name === 'offlineReader' }
  }, [download, route.name, variant, variantId])

  const series: SeriesSummary | null = librarySeries ?? detail

  if (route.name === 'offlineReader' && records.length > 0 && !offlineDetail) {
    return <ProblemPage kind="downloadGone" />
  }

  if (errorStatus === 404 || (detail && !entry)) {
    return <ProblemPage kind="gone" />
  }

  if (!series || !detail || !entry || !variantId || !source) {
    return (
      <div className="reader">
        <div className="reader-state">
          <p>{offline && route.name === 'reader' && !loadedDetail ? t.reader.notOffline : error ?? t.reader.loading}</p>
          <button className="btn" onClick={() => exitReader({ name: 'home' })} type="button">
            {t.reader.close}
          </button>
        </div>
      </div>
    )
  }

  if (offline && route.name === 'reader' && !download) {
    return (
      <div className="reader">
        <div className="reader-state">
          <h2>{t.reader.notOffline}</h2>
          <button className="btn" onClick={() => exitReader(seriesRoute(series.category, series.id))} type="button">
            {t.reader.close}
          </button>
        </div>
      </div>
    )
  }

  return (
    <ReaderSession
      detail={detail}
      entry={entry}
      entryIndex={index}
      key={`${series.id}:${variantId}`}
      route={route}
      series={series}
      source={source}
      variantId={variantId}
    />
  )
}
