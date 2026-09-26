import { Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { ScopeId, SeriesSummary } from '../appTypes'
import { useOffline } from '../app/connection'
import { useDownloadRecords } from '../app/downloads'
import { libraryStore, readerCategories, type LibraryState } from '../app/library'
import { availableCategories, useCategoryCounts, useDocumentTitle } from '../app/navigation'
import { seriesAvailability } from '../app/offlineLibrary'
import { replaceRoute } from '../app/router'
import { seriesCreator, seriesTitle } from '../app/seriesText'
import { useStore } from '../app/store'
import { useT } from '../i18n'
import type { AppRoute } from '../routing'
import { TopBar } from '../shell/TopBar'
import { EmptyState, Segmented } from '../ui/bits'
import { TitleCard } from '../ui/TitleCard'

type SearchRoute = Extract<AppRoute, { name: 'search' }>

const selectLibrary = (state: LibraryState) => state.library

const tokensOf = (query: string) =>
  query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

/** Instant matches from the saved catalogue (works offline as well). */
const searchLocally = (library: SeriesSummary[], query: string, scope: ScopeId) => {
  const tokens = tokensOf(query)

  if (!tokens.length) {
    return []
  }

  const scored: Array<{ series: SeriesSummary; score: number }> = []

  for (const series of library) {
    if (scope !== 'all' && series.category !== scope) {
      continue
    }

    if (!(readerCategories as readonly string[]).includes(series.category)) {
      continue
    }

    const title = seriesTitle(series).toLowerCase()
    const creator = seriesCreator(series)?.toLowerCase() ?? ''
    const haystack = `${title} ${creator} ${series.tags.join(' ')} ${series.genres.join(' ')} ${series.folder}`.toLowerCase()

    if (!tokens.every((token) => haystack.includes(token))) {
      continue
    }

    const phrase = tokens.join(' ')
    const score =
      (title === phrase ? 100 : 0) +
      (title.startsWith(phrase) ? 40 : 0) +
      (title.includes(phrase) ? 20 : 0) +
      (creator.includes(phrase) ? 10 : 0)
    scored.push({ series, score })
  }

  return scored
    .sort((left, right) => right.score - left.score || left.series.title.localeCompare(right.series.title))
    .slice(0, 120)
    .map((item) => item.series)
}

export function SearchPage({ route }: { route: SearchRoute }) {
  const t = useT()
  const offline = useOffline()
  const library = useStore(libraryStore, selectLibrary)
  const counts = useCategoryCounts()
  const records = useDownloadRecords()
  const [query, setQuery] = useState(route.query)
  const [serverResults, setServerResults] = useState<{ key: string; results: SeriesSummary[] } | null>(null)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const scope = route.scope
  const trimmed = query.trim()
  const searchKey = `${scope}:${trimmed}`
  useDocumentTitle(t.search.title)

  useEffect(() => {
    if (!route.query) {
      inputRef.current?.focus()
    }
    // Only on arrival: later URL updates come from this input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the address in sync without adding history entries on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (trimmed !== route.query) {
        replaceRoute({ ...route, query: trimmed })
      }
    }, 400)

    return () => window.clearTimeout(timer)
  }, [route, trimmed])

  useEffect(() => {
    if (!trimmed || offline) {
      setSearching(false)
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setSearching(true)
      api
        .search(trimmed, scope, controller.signal)
        .then((results) => {
          setServerResults({ key: `${scope}:${trimmed}`, results })
        })
        .catch(() => undefined)
        .finally(() => {
          if (!controller.signal.aborted) {
            setSearching(false)
          }
        })
    }, 250)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [offline, scope, trimmed])

  const localResults = useMemo(() => searchLocally(library, trimmed, scope), [library, scope, trimmed])
  const results = useMemo(() => {
    if (serverResults?.key !== searchKey) {
      return localResults
    }

    const readable = serverResults.results.filter((series) =>
      (readerCategories as readonly string[]).includes(series.category),
    )
    const seen = new Set(readable.map((series) => series.id))
    return [...readable, ...localResults.filter((series) => !seen.has(series.id))]
  }, [localResults, searchKey, serverResults])

  const scopes: Array<{ value: ScopeId; label: string }> = [
    { value: 'all', label: t.categories.all },
    ...availableCategories(counts).map((category) => ({ value: category as ScopeId, label: t.categories[category] })),
  ]

  return (
    <>
      <TopBar showSearch={false} title={t.search.title} />
      <div className="page search">
        <form
          className="search__form"
          onSubmit={(event) => {
            event.preventDefault()
            inputRef.current?.blur()
          }}
          role="search"
        >
          <label className="search-input">
            <Search aria-hidden="true" />
            <span className="visually-hidden">{t.search.title}</span>
            <input
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              className="input"
              enterKeyHint="search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t.search.placeholder}
              ref={inputRef}
              spellCheck={false}
              type="search"
              value={query}
            />
            {query && (
              <button
                aria-label={t.search.clear}
                className="icon-btn"
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            )}
          </label>
          {scopes.length > 2 && (
            <Segmented
              label={t.search.scope}
              onChange={(value) => replaceRoute({ ...route, query: trimmed, scope: value })}
              options={scopes}
              value={scope}
            />
          )}
        </form>

        {!trimmed ? (
          <EmptyState body={t.search.hint} icon={Search} title={t.search.title} />
        ) : (
          <>
            <p className="search__status" role="status">
              {offline
                ? t.search.offlineNote
                : searching
                  ? t.search.searching
                  : t.units.titles(results.length)}
            </p>
            {results.length === 0 && !searching ? (
              <EmptyState icon={Search} title={t.search.noResults(trimmed)} />
            ) : (
              <div className="title-grid">
                {results.map((series) => (
                  <TitleCard availability={seriesAvailability(records, series)} key={series.id} series={series} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
