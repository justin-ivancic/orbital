import { BookOpen, Dices, EllipsisVertical, FolderPlus, Library } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import type { Bookmark, OfflineDownloadRecord, SavedReadingPosition, SeriesSummary } from '../appTypes'
import { useNow } from '../app/clock'
import { useOffline } from '../app/connection'
import { startDownload, useDownloadRecords } from '../app/downloads'
import { getSeriesIndex, libraryStore, readerCategories, type LibraryState } from '../app/library'
import { browseTarget, useDocumentTitle } from '../app/navigation'
import { buildOfflineSeriesDetail, getDownloadIndex, seriesAvailability } from '../app/offlineLibrary'
import { notify } from '../app/notices'
import { forgetPendingProgress } from '../app/progress'
import { resumeRouteFor } from '../app/resume'
import { navigate } from '../app/router'
import { useUser } from '../app/session'
import { seriesCreator, seriesTitle, summarizeProgress } from '../app/seriesText'
import { shallowEqual, useStore } from '../app/store'
import { api } from '../api'
import { useT, type Strings } from '../i18n'
import { seriesRoute } from '../routing'
import { TopBar } from '../shell/TopBar'
import { EmptyState, Meter, SectionHead } from '../ui/bits'
import { Cover } from '../ui/Cover'
import { Link } from '../ui/Link'
import { Sheet } from '../ui/Sheet'
import { TitleCard } from '../ui/TitleCard'

type ContinueItem = {
  bookmark: Bookmark
  series: SeriesSummary
  position: SavedReadingPosition | undefined
}

const selectHomeData = (state: LibraryState) => ({
  library: state.library,
  bookmarks: state.bookmarks,
  readingPositions: state.readingPositions,
  loaded: state.loaded,
})

const dayPeriod = (now: number) => {
  const hour = new Date(now).getHours()

  if (hour < 5) {
    return 'night'
  }

  if (hour < 12) {
    return 'morning'
  }

  if (hour < 18) {
    return 'afternoon'
  }

  return hour < 23 ? 'evening' : 'night'
}

const openResume = (item: ContinueItem, records: OfflineDownloadRecord[], offline: boolean, t: Strings) => {
  const route = resumeRouteFor(item.bookmark, item.series, records, offline)

  if (route) {
    navigate(route)
  } else {
    notify(t.series.notAvailableOffline, 'error')
  }
}

type ContinueCardProps = {
  item: ContinueItem
  records: OfflineDownloadRecord[]
  offline: boolean
  onMenu: (item: ContinueItem) => void
}

const ContinueHero = memo(function ContinueHero({ item, records, offline, onMenu }: ContinueCardProps) {
  const t = useT()
  const summary = summarizeProgress(item.bookmark, item.series, item.position, t)
  const title = seriesTitle(item.series)
  const creator = seriesCreator(item.series)

  return (
    <article className="hero panel panel--raised">
      <button
        aria-label={`${t.home.resume}: ${title}`}
        className="hero__cover"
        onClick={() => openResume(item, records, offline, t)}
        type="button"
      >
        <Cover availability={seriesAvailability(records, item.series)} eager large series={item.series} />
      </button>
      <div className="hero__body">
        <span className="kicker">{t.home.continueReading}</span>
        <h2 className="hero__title clamp-3">{title}</h2>
        {creator && <p className="hero__creator">{creator}</p>}
        <p className="hero__where">{summary.where}</p>
        <Meter label={summary.where} value={summary.ratio} />
        {summary.remaining && <p className="hero__remaining">{t.home.left(summary.remaining)}</p>}
        <div className="hero__actions">
          <button className="btn btn--primary" onClick={() => openResume(item, records, offline, t)} type="button">
            <BookOpen aria-hidden="true" />
            {t.home.resume}
          </button>
          <Link className="btn" to={seriesRoute(item.series.category, item.series.id)}>
            {t.home.openDetails}
          </Link>
          <button
            aria-label={t.home.itemActions(title)}
            className="icon-btn icon-btn--outlined"
            onClick={() => onMenu(item)}
            type="button"
          >
            <EllipsisVertical aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  )
})

const ContinueCard = memo(function ContinueCard({ item, records, offline, onMenu }: ContinueCardProps) {
  const t = useT()
  const summary = summarizeProgress(item.bookmark, item.series, item.position, t)
  const title = seriesTitle(item.series)

  return (
    <div className="continue-card">
      <button
        aria-label={`${t.home.resume}: ${title}`}
        className="continue-card__open"
        onClick={() => openResume(item, records, offline, t)}
        type="button"
      >
        <Cover availability={seriesAvailability(records, item.series)} series={item.series} />
      </button>
      <div className="continue-card__foot">
        <div className="continue-card__text">
          <span className="title-card__title">{title}</span>
          <span className="title-card__meta">{summary.finished ? t.home.finished : summary.where}</span>
        </div>
        <button
          aria-label={t.home.itemActions(title)}
          className="icon-btn icon-btn--small continue-card__menu"
          onClick={() => onMenu(item)}
          type="button"
        >
          <EllipsisVertical aria-hidden="true" />
        </button>
      </div>
      <Meter thin value={summary.ratio} />
    </div>
  )
})

function ContinueMenu({ item, onClose }: { item: ContinueItem; onClose: () => void }) {
  const t = useT()
  const offline = useOffline()
  const records = useDownloadRecords()
  const [busy, setBusy] = useState(false)
  const title = seriesTitle(item.series)

  const remove = async () => {
    setBusy(true)

    try {
      forgetPendingProgress(item.series.id)
      await api.removeBookmark(item.series.id)
      libraryStore.set((previous) => ({
        ...previous,
        bookmarks: previous.bookmarks.filter((bookmark) => bookmark.seriesId !== item.series.id),
      }))
      notify(t.home.removed)
      onClose()
    } catch (error) {
      notify(error instanceof Error ? error.message : t.common.somethingWentWrong, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet onClose={onClose} title={title}>
      <div className="list">
        <button
          className="list-row"
          onClick={() => {
            onClose()
            openResume(item, records, offline, t)
          }}
          type="button"
        >
          <span className="list-row__body">
            <span className="list-row__title">{t.home.resume}</span>
          </span>
        </button>
        <Link className="list-row" onClick={onClose} to={seriesRoute(item.series.category, item.series.id)}>
          <span className="list-row__body">
            <span className="list-row__title">{t.home.openDetails}</span>
          </span>
        </Link>
        <button
          className="list-row"
          disabled={offline}
          onClick={() => {
            onClose()
            void startDownload(
              item.series.stats.fileCount > 1
                ? { type: 'series', seriesId: item.series.id }
                : { type: 'entry', entryId: item.bookmark.entryId },
            )
          }}
          type="button"
        >
          <span className="list-row__body">
            <span className="list-row__title">
              {item.series.stats.fileCount > 1 ? t.series.downloadAll : t.series.download}
            </span>
          </span>
        </button>
        <button className="list-row" disabled={busy || offline} onClick={() => void remove()} type="button">
          <span className="list-row__body">
            <span className="list-row__title">{t.home.removeFromList}</span>
          </span>
        </button>
      </div>
    </Sheet>
  )
}

export function HomePage() {
  const t = useT()
  const user = useUser()
  const now = useNow()
  const offline = useOffline()
  const records = useDownloadRecords()
  const { library, bookmarks, readingPositions, loaded } = useStore(libraryStore, selectHomeData, shallowEqual)
  const [menuItem, setMenuItem] = useState<ContinueItem | null>(null)
  useDocumentTitle(t.nav.home)

  const continueItems = useMemo(() => {
    const index = getSeriesIndex(library)
    const offlineSeries = new Map(
      records
        .filter((record) => record.status === 'ready')
        .map((record) => {
          const detail = buildOfflineSeriesDetail(record)
          return [detail.id, detail as SeriesSummary] as const
        }),
    )

    return bookmarks.flatMap((bookmark): ContinueItem[] => {
      const series = index.get(bookmark.seriesId) ?? offlineSeries.get(bookmark.seriesId)

      if (!series || !(readerCategories as readonly string[]).includes(series.category)) {
        return []
      }

      return [{ bookmark, series, position: readingPositions[bookmark.entryId] }]
    })
  }, [bookmarks, library, readingPositions, records])

  const recentlyAdded = useMemo(
    () =>
      library
        .filter((series) => (readerCategories as readonly string[]).includes(series.category))
        .filter((series) => series.addedAt)
        .sort((left, right) => (right.addedAt ?? '').localeCompare(left.addedAt ?? ''))
        .slice(0, 12),
    [library],
  )

  const onDevice = useMemo(() => {
    const index = getSeriesIndex(library)
    const seen = new Set<string>()
    const items: SeriesSummary[] = []

    getDownloadIndex(records).readyBySeries.forEach((record, seriesId) => {
      if (seen.has(seriesId)) {
        return
      }

      seen.add(seriesId)
      items.push(index.get(seriesId) ?? buildOfflineSeriesDetail(record))
    })

    return items.slice(0, 12)
  }, [library, records])

  const surprise = () => {
    const reading = new Set(bookmarks.map((bookmark) => bookmark.seriesId))
    const candidates = library.filter(
      (series) => !reading.has(series.id) && (readerCategories as readonly string[]).includes(series.category),
    )
    const pool = candidates.length ? candidates : library
    const pick = pool[Math.floor(Math.random() * pool.length)]

    if (pick) {
      navigate(seriesRoute(pick.category, pick.id))
    }
  }

  const [hero, ...others] = continueItems
  const libraryEmpty = loaded && library.length === 0 && !offline

  return (
    <>
      <TopBar />
      <div className="page home">
        <header className="page-head">
          <div className="page-head__text">
            <h1>{user ? t.home.greeting(dayPeriod(now), user.username) : t.nav.home}</h1>
            {library.length > 0 && (
              <p className="page-head__subtitle">{t.home.stats(continueItems.length, library.length)}</p>
            )}
          </div>
          {library.length > 0 && (
            <button className="btn" onClick={surprise} type="button">
              <Dices aria-hidden="true" />
              {t.home.surpriseMe}
            </button>
          )}
        </header>

        {libraryEmpty ? (
          <EmptyState
            action={
              user?.role === 'admin' ? (
                <Link className="btn btn--primary" to={{ name: 'admin', tab: 'library' }}>
                  <FolderPlus aria-hidden="true" />
                  {t.home.openAdmin}
                </Link>
              ) : null
            }
            body={user?.role === 'admin' ? t.home.libraryEmptyAdmin : t.home.libraryEmptyMember}
            icon={Library}
            title={t.home.libraryEmptyTitle}
          />
        ) : (
          <>
            {hero ? (
              <section className="section" aria-label={t.home.continueReading}>
                <ContinueHero item={hero} offline={offline} onMenu={setMenuItem} records={records} />
                {others.length > 0 && (
                  <div className="title-grid continue-grid">
                    {others.slice(0, 11).map((item) => (
                      <ContinueCard
                        item={item}
                        key={item.series.id}
                        offline={offline}
                        onMenu={setMenuItem}
                        records={records}
                      />
                    ))}
                  </div>
                )}
              </section>
            ) : (
              loaded && (
                <section className="panel home-empty">
                  <BookOpen aria-hidden="true" />
                  <div>
                    <h2>{t.home.emptyTitle}</h2>
                    <p>{t.home.emptyBody}</p>
                  </div>
                  <button className="btn btn--primary" onClick={() => navigate(browseTarget())} type="button">
                    {t.home.browseLibrary}
                  </button>
                </section>
              )
            )}

            {onDevice.length > 0 && (
              <section className="section">
                <SectionHead
                  action={
                    <Link className="link-btn" to={{ name: 'downloads' }}>
                      {t.home.seeAll}
                    </Link>
                  }
                  title={t.home.onThisDevice}
                />
                <div className="title-grid title-grid--row">
                  {onDevice.map((series) => (
                    <TitleCard availability={seriesAvailability(records, series)} key={series.id} series={series} />
                  ))}
                </div>
              </section>
            )}

            {recentlyAdded.length > 0 && !offline && (
              <section className="section">
                <SectionHead
                  action={
                    <Link
                      className="link-btn"
                      to={{
                        name: 'library',
                        category: recentlyAdded[0].category === 'anime' ? 'books' : recentlyAdded[0].category,
                        topics: [],
                        sort: 'added',
                        page: 1,
                      }}
                    >
                      {t.home.seeAll}
                    </Link>
                  }
                  title={t.home.recentlyAdded}
                />
                <div className="title-grid title-grid--row">
                  {recentlyAdded.map((series) => (
                    <TitleCard availability={seriesAvailability(records, series)} key={series.id} series={series} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
      {menuItem && <ContinueMenu item={menuItem} onClose={() => setMenuItem(null)} />}
    </>
  )
}
