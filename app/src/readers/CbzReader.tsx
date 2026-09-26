import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ReaderDirection, ReaderSettings, ReaderViewMode } from '../appTypes'
import { fetchAuthenticatedResource } from '../authenticatedResource'
import { resolveApiUrl } from '../platform'
import { useT } from '../i18n'
import { PageImage } from './PageImage'
import { preloadPageImages } from './pageImages'
import { TapSurface } from './TapSurface'
import type { ReaderContentProps } from './types'

type CbzPage = {
  archiveIndex: number
  name: string
  url: string
}

type CbzGroup = {
  startPage: number
  endPage: number
  /** Pages in display order (left to right). */
  pages: Array<{ page: number; url: string }>
}

type ManifestResponse = {
  pageCount: number
  pages: Array<{ archiveIndex: number; name: string; pageNumber: number; url: string }>
}

const imagePattern = /\.(avif|gif|jpe?g|png|webp)$/i
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const orderPages = (pages: CbzPage[], order: ReaderSettings['pageOrder']) =>
  order === 'archive'
    ? [...pages].sort((left, right) => left.archiveIndex - right.archiveIndex)
    : [...pages].sort((left, right) => collator.compare(left.name, right.name))

const buildGroups = (
  pages: CbzPage[],
  viewMode: ReaderViewMode,
  direction: ReaderDirection,
  alignment: ReaderSettings['spreadAlignment'],
): CbzGroup[] => {
  if (viewMode === 'single') {
    return pages.map((page, index) => ({
      startPage: index + 1,
      endPage: index + 1,
      pages: [{ page: index + 1, url: page.url }],
    }))
  }

  const groups: CbzGroup[] = []
  let index = 0

  if (alignment === 'cover-first' && pages.length > 0) {
    groups.push({ startPage: 1, endPage: 1, pages: [{ page: 1, url: pages[0].url }] })
    index = 1
  }

  for (; index < pages.length; index += 2) {
    const first = { page: index + 1, url: pages[index].url }
    const second = pages[index + 1] ? { page: index + 2, url: pages[index + 1].url } : null
    groups.push({
      startPage: first.page,
      endPage: second?.page ?? first.page,
      pages: second ? (direction === 'rtl' ? [second, first] : [first, second]) : [first],
    })
  }

  return groups
}

const groupIndexForPage = (groups: CbzGroup[], page: number) =>
  Math.max(0, groups.findIndex((group) => page >= group.startPage && page <= group.endPage))

/**
 * Comic and manga reader. Paged mode shows one page or a spread and prefetches
 * the next few pages; scroll mode stacks pages for webtoons.
 */
export function CbzReader({
  source,
  title,
  settings,
  tapLayout,
  initial,
  onPosition,
  onCenterTap,
  onTurn,
  onNextEntry,
  onPreviousEntry,
  onReady,
  onError,
}: ReaderContentProps) {
  const t = useT()
  const [pages, setPages] = useState<CbzPage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(() => Math.max(1, initial?.locationType === 'percent' ? 1 : initial?.page ?? 1))
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const scrollRestoredRef = useRef(false)
  const paged = settings.layout === 'paged'
  const viewMode = paged ? settings.viewMode : 'single'

  useEffect(() => {
    let cancelled = false
    setPages(null)
    setError(null)

    const load = async () => {
      try {
        if (source.offlinePages?.length) {
          const offlinePages = source.offlinePages.filter((item) => imagePattern.test(item.name))

          if (!cancelled) {
            setPages(offlinePages)
          }
          return
        }

        const response = await fetchAuthenticatedResource(
          `/api/media/cbz/${encodeURIComponent(source.variantId)}/manifest`,
        )
        const manifest = (await response.json()) as ManifestResponse
        const loaded = manifest.pages
          .filter((item) => imagePattern.test(item.name))
          .map((item, index) => ({
            archiveIndex: Number.isFinite(item.archiveIndex) ? item.archiveIndex : index,
            name: item.name,
            url: resolveApiUrl(item.url),
          }))

        if (!loaded.length) {
          throw new Error(t.reader.errorBody)
        }

        if (!cancelled) {
          setPages(loaded)
        }
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error ? loadError.message : t.reader.errorBody
          setError(message)
          onError?.(message)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [onError, source.offlinePages, source.variantId, t.reader.errorBody])

  const ordered = useMemo(() => (pages ? orderPages(pages, settings.pageOrder) : []), [pages, settings.pageOrder])
  const groups = useMemo(
    () => buildGroups(ordered, viewMode, settings.direction, settings.spreadAlignment),
    [ordered, settings.direction, settings.spreadAlignment, viewMode],
  )
  const total = ordered.length
  const safePage = total ? Math.min(Math.max(page, 1), total) : 1
  const groupIndex = groupIndexForPage(groups, safePage)
  const group = groups[groupIndex] ?? null

  // Report the position whenever the visible page changes.
  useEffect(() => {
    if (!group || !total) {
      return
    }

    onPosition({
      page: group.startPage,
      endPage: group.endPage,
      totalPages: total,
      locationType: 'page',
      viewMode,
    })
  }, [group, onPosition, total, viewMode])

  // Fetch the next pages ahead of time so turning is instant.
  useEffect(() => {
    if (!paged || !groups.length) {
      return
    }

    const upcoming = [1, 2, 3, -1]
      .map((offset) => groups[groupIndex + offset])
      .filter(Boolean)
      .flatMap((item) => item.pages.map((entry) => entry.url))
    const timer = window.setTimeout(() => preloadPageImages(upcoming), 60)
    return () => window.clearTimeout(timer)
  }, [groupIndex, groups, paged])

  const goToGroup = useCallback(
    (index: number) => {
      const next = groups[Math.min(groups.length - 1, Math.max(0, index))]

      if (next) {
        setPage(next.startPage)
        viewportRef.current?.scrollTo({ top: 0, left: 0 })
      }
    },
    [groups],
  )

  const forward = useCallback(() => {
    if (groupIndex >= groups.length - 1) {
      onNextEntry?.()
      return
    }

    goToGroup(groupIndex + 1)
    onTurn?.()
  }, [goToGroup, groupIndex, groups.length, onNextEntry, onTurn])

  const back = useCallback(() => {
    if (groupIndex <= 0) {
      onPreviousEntry?.()
      return
    }

    goToGroup(groupIndex - 1)
    onTurn?.()
  }, [goToGroup, groupIndex, onPreviousEntry, onTurn])

  const controller = useMemo(
    () => ({
      goTo: (target: number) => {
        setPage(Math.min(Math.max(1, Math.round(target)), Math.max(1, total)))

        if (!paged) {
          const element = viewportRef.current?.querySelector<HTMLElement>(`[data-page="${Math.round(target)}"]`)
          element?.scrollIntoView({ block: 'start' })
        }
      },
      next: forward,
      previous: back,
    }),
    [back, forward, paged, total],
  )

  useEffect(() => {
    if (total) {
      onReady?.(controller)
    }
  }, [controller, onReady, total])

  // Scroll mode: jump to the saved page once, then follow the scroll position.
  useEffect(() => {
    const viewport = viewportRef.current

    if (paged || !viewport || !total) {
      return
    }

    if (!scrollRestoredRef.current) {
      scrollRestoredRef.current = true
      viewport.querySelector<HTMLElement>(`[data-page="${safePage}"]`)?.scrollIntoView({ block: 'start' })
    }

    let frame = 0
    const handleScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const middle = viewport.getBoundingClientRect().top + viewport.clientHeight * 0.3
        const items = viewport.querySelectorAll<HTMLElement>('[data-page]')

        for (const item of items) {
          const rect = item.getBoundingClientRect()

          if (rect.bottom > middle) {
            const visible = Number(item.dataset.page)

            if (Number.isFinite(visible)) {
              setPage(visible)
            }
            break
          }
        }
      })
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', handleScroll)
    }
  }, [paged, safePage, total])

  if (error) {
    return (
      <div className="reader-state">
        <h2>{t.reader.errorTitle}</h2>
        <p>{error}</p>
      </div>
    )
  }

  if (!pages) {
    return <p className="reader-state">{t.reader.loadingPages}</p>
  }

  const zoomed = settings.fitMode === 'manual'

  return (
    <TapSurface
      className="comic"
      direction={settings.direction}
      layout={tapLayout}
      mode={paged ? 'paged' : 'scroll'}
      onBack={back}
      onForward={forward}
      onMenu={onCenterTap}
      scrollRef={viewportRef}
      swipe={!zoomed}
    >
      <div
        className={`comic__viewport comic__viewport--${paged ? settings.fitMode : 'scroll'}`}
        ref={viewportRef}
        style={zoomed ? ({ '--comic-zoom': `${settings.zoom}%` } as CSSProperties) : undefined}
      >
        {paged && group ? (
          <div className={`comic__spread${group.pages.length > 1 ? ' comic__spread--pair' : ''}`}>
            {group.pages.map((entry) => (
              <PageImage alt={t.reader.pageImage(entry.page)} className="comic__page" key={entry.page} url={entry.url} />
            ))}
          </div>
        ) : (
          <div className="comic__strip">
            {ordered.map((item, index) => (
              <div className="comic__strip-page" data-page={index + 1} key={item.url}>
                {Math.abs(index + 1 - safePage) <= 6 ? (
                  <PageImage alt={t.reader.pageImage(index + 1)} className="comic__page" url={item.url} />
                ) : (
                  <span aria-hidden="true" className="comic__placeholder" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <span className="visually-hidden">{title}</span>
    </TapSurface>
  )
}
