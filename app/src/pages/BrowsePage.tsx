import { Check, LayoutGrid, List, SlidersHorizontal } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { SeriesSummary } from '../appTypes'
import { useDownloadRecords } from '../app/downloads'
import { libraryStore, type LibraryState } from '../app/library'
import { availableCategories, useCategoryCounts, useDocumentTitle } from '../app/navigation'
import { seriesAvailability } from '../app/offlineLibrary'
import { preferencesStore, setPreference } from '../app/preferences'
import { navigate, replaceRoute } from '../app/router'
import { seriesCreator, seriesTopics } from '../app/seriesText'
import { useStore } from '../app/store'
import { useT } from '../i18n'
import { libraryRoute, type AppRoute, type LibrarySort } from '../routing'
import { TopBar } from '../shell/TopBar'
import { EmptyState, Pager, Segmented } from '../ui/bits'
import { Link } from '../ui/Link'
import { Sheet } from '../ui/Sheet'
import { TitleCard, TitleRow } from '../ui/TitleCard'

type LibraryRoute = Extract<AppRoute, { name: 'library' }>

const pageSize = 60

const selectLibrary = (state: LibraryState) => state.library
const selectBrowseView = (state: { browseView: 'grid' | 'list' }) => state.browseView

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const sorters: Record<LibrarySort, (left: SeriesSummary, right: SeriesSummary) => number> = {
  title: (left, right) => collator.compare(left.title, right.title),
  added: (left, right) =>
    (right.addedAt ?? '').localeCompare(left.addedAt ?? '') || collator.compare(left.title, right.title),
  year: (left, right) =>
    (right.year ?? -Infinity) - (left.year ?? -Infinity) || collator.compare(left.title, right.title),
  author: (left, right) => {
    const leftCreator = seriesCreator(left)
    const rightCreator = seriesCreator(right)

    if (leftCreator && rightCreator) {
      return collator.compare(leftCreator, rightCreator) || collator.compare(left.title, right.title)
    }

    return leftCreator ? -1 : rightCreator ? 1 : collator.compare(left.title, right.title)
  },
}

function TopicSheet({
  topics,
  selected,
  onApply,
  onClose,
}: {
  topics: Array<{ topic: string; count: number }>
  selected: string[]
  onApply: (topics: string[]) => void
  onClose: () => void
}) {
  const t = useT()
  const [draft, setDraft] = useState(() => new Set(selected))

  const toggle = (topic: string) => {
    setDraft((previous) => {
      const next = new Set(previous)

      if (next.has(topic)) {
        next.delete(topic)
      } else {
        next.add(topic)
      }

      return next
    })
  }

  return (
    <Sheet
      footer={(
        <>
          <button className="btn" disabled={draft.size === 0} onClick={() => setDraft(new Set())} type="button">
            {t.browse.clear}
          </button>
          <button className="btn btn--primary" onClick={() => onApply([...draft])} type="button">
            {t.browse.apply}
          </button>
        </>
      )}
      onClose={onClose}
      title={t.browse.filterTitle}
    >
      <div className="topic-list">
        {topics.map(({ topic, count }) => (
          <button
            aria-pressed={draft.has(topic)}
            className="chip topic-chip"
            key={topic}
            onClick={() => toggle(topic)}
            type="button"
          >
            {draft.has(topic) && <Check aria-hidden="true" />}
            {topic}
            <span className="topic-chip__count">{count}</span>
          </button>
        ))}
      </div>
    </Sheet>
  )
}

export function BrowsePage({ route }: { route: LibraryRoute }) {
  const t = useT()
  const library = useStore(libraryStore, selectLibrary)
  const counts = useCategoryCounts()
  const records = useDownloadRecords()
  const view = useStore(preferencesStore, selectBrowseView)
  const [topicsOpen, setTopicsOpen] = useState(false)
  useDocumentTitle(`${t.nav.browse} · ${t.categories[route.category]}`)

  const inCategory = useMemo(
    () => library.filter((series) => series.category === route.category),
    [library, route.category],
  )

  const topicCounts = useMemo(() => {
    const countsByTopic = new Map<string, number>()

    inCategory.forEach((series) => {
      seriesTopics(series).forEach((topic) => {
        countsByTopic.set(topic, (countsByTopic.get(topic) ?? 0) + 1)
      })
    })

    return [...countsByTopic.entries()]
      .filter(([, count]) => count > 1 || countsByTopic.size < 40)
      .map(([topic, count]) => ({ topic, count }))
      .sort((left, right) => right.count - left.count || collator.compare(left.topic, right.topic))
  }, [inCategory])

  const results = useMemo(() => {
    const filtered = route.topics.length
      ? inCategory.filter((series) => {
          const topics = seriesTopics(series)
          return route.topics.every((topic) => topics.includes(topic))
        })
      : inCategory

    return [...filtered].sort(sorters[route.sort])
  }, [inCategory, route.sort, route.topics])

  const pageCount = Math.max(1, Math.ceil(results.length / pageSize))
  const page = Math.min(route.page, pageCount)
  const visible = results.slice((page - 1) * pageSize, page * pageSize)
  const categories = availableCategories(counts)
  const tabs = categories.includes(route.category) ? categories : [...categories, route.category]

  const update = (patch: Partial<LibraryRoute>) => {
    replaceRoute({ ...route, page: 1, ...patch })
  }

  const changePage = (nextPage: number) => {
    navigate({ ...route, page: nextPage }, { replace: true })
  }

  return (
    <>
      <TopBar title={t.nav.browse} />
      <div className="page browse">
        <header className="page-head">
          <div className="page-head__text">
            <h1>{t.categories[route.category]}</h1>
            <p className="page-head__subtitle">{t.units.titles(results.length)}</p>
          </div>
        </header>

        {tabs.length > 1 && (
          <nav aria-label={t.nav.browse} className="tabs">
            {tabs.map((category) => (
              <Link
                aria-current={category === route.category ? 'page' : undefined}
                className="tab"
                key={category}
                to={libraryRoute(category, { sort: route.sort })}
              >
                {t.categories[category]}
                <span className="tab__count">{counts[category].toLocaleString(t.locale)}</span>
              </Link>
            ))}
          </nav>
        )}

        <div className="browse__toolbar">
          <Segmented
            label={t.browse.sort}
            onChange={(sort) => update({ sort })}
            options={[
              { value: 'title', label: t.browse.sortTitle },
              { value: 'added', label: t.browse.sortAdded },
              { value: 'year', label: t.browse.sortYear },
              { value: 'author', label: t.browse.sortAuthor },
            ]}
            value={route.sort}
          />
          <span className="spacer" />
          {topicCounts.length > 0 && (
            <button
              aria-pressed={route.topics.length > 0}
              className={`btn${route.topics.length ? ' btn--primary' : ''}`}
              onClick={() => setTopicsOpen(true)}
              type="button"
            >
              <SlidersHorizontal aria-hidden="true" />
              {route.topics.length ? t.browse.topicsSelected(route.topics.length) : t.browse.topics}
            </button>
          )}
          <Segmented
            label={t.browse.view}
            onChange={(next) => setPreference('browseView', next)}
            options={[
              { value: 'grid', label: null, icon: LayoutGrid, ariaLabel: t.browse.viewGrid },
              { value: 'list', label: null, icon: List, ariaLabel: t.browse.viewList },
            ]}
            value={view}
          />
        </div>

        {route.topics.length > 0 && (
          <div className="cluster">
            {route.topics.map((topic) => (
              <button
                aria-label={`${t.browse.clear}: ${topic}`}
                className="chip chip--solid"
                key={topic}
                onClick={() => update({ topics: route.topics.filter((item) => item !== topic) })}
                type="button"
              >
                {topic} ×
              </button>
            ))}
            <button className="link-btn" onClick={() => update({ topics: [] })} type="button">
              {t.browse.clear}
            </button>
          </div>
        )}

        {visible.length === 0 ? (
          <EmptyState
            body={route.topics.length ? t.browse.emptyFiltered : undefined}
            icon={SlidersHorizontal}
            title={t.browse.empty}
          />
        ) : view === 'grid' ? (
          <div className="title-grid">
            {visible.map((series, index) => (
              <TitleCard
                availability={seriesAvailability(records, series)}
                eager={index < 12}
                key={series.id}
                series={series}
              />
            ))}
          </div>
        ) : (
          <div className="title-list">
            {visible.map((series) => (
              <TitleRow availability={seriesAvailability(records, series)} key={series.id} series={series} />
            ))}
          </div>
        )}

        <Pager onChange={changePage} page={page} pageCount={pageCount} />
      </div>

      {topicsOpen && (
        <TopicSheet
          onApply={(topics) => {
            setTopicsOpen(false)
            update({ topics })
          }}
          onClose={() => setTopicsOpen(false)}
          selected={route.topics}
          topics={topicCounts}
        />
      )}
    </>
  )
}
