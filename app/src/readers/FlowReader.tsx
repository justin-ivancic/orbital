import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fetchAuthenticatedResource } from '../authenticatedResource'
import { useT } from '../i18n'
import { markdownToHtml, plainTextToHtml, sanitizeChapterHtml } from './content'
import { TapSurface } from './TapSurface'
import { textStyleVariables } from './textStyle'
import type { ReaderContentProps } from './types'

const blockSelector = ':scope > *'

const blocksOf = (content: HTMLElement | null) =>
  content ? [...content.querySelectorAll<HTMLElement>(blockSelector)] : []

/**
 * Reads HTML chapters, Markdown and plain text. In page mode the text is laid
 * out in screen-sized columns, so turning a page is a single jump with no
 * scrolling — exactly what an e-ink panel likes.
 */
export function FlowReader({
  source,
  settings,
  textStyle,
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
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLElement | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const restoredRef = useRef(false)
  const anchorRef = useRef<number | null>(null)
  const paged = settings.layout === 'paged'

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    setError(null)
    restoredRef.current = false

    const load = async () => {
      try {
        const response = await fetchAuthenticatedResource(source.fileUrl)
        const text = await response.text()
        const nextHtml =
          source.format === 'md'
            ? markdownToHtml(text)
            : source.format === 'txt'
              ? plainTextToHtml(text)
              : sanitizeChapterHtml(text).html

        if (!cancelled) {
          setHtml(nextHtml || '<p></p>')
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
  }, [onError, source.fileUrl, source.format, t.reader.errorBody])

  const measure = useCallback(() => {
    const viewport = viewportRef.current

    if (!viewport) {
      return 1
    }

    if (!paged) {
      return 1
    }

    const width = viewport.clientWidth || 1
    return Math.max(1, Math.round(viewport.scrollWidth / width))
  }, [paged])

  /** Index of the first paragraph visible on the current page or scroll offset. */
  const firstVisibleBlock = useCallback(() => {
    const viewport = viewportRef.current

    if (!viewport) {
      return null
    }

    const bounds = viewport.getBoundingClientRect()
    const items = blocksOf(contentRef.current)

    for (let index = 0; index < items.length; index += 1) {
      const rects = [...items[index].getClientRects()]
      const visible = rects.some((rect) =>
        paged
          ? rect.right > bounds.left + 1 && rect.left < bounds.right - 1
          : rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1,
      )

      if (visible) {
        return index
      }
    }

    return null
  }, [paged])

  const pageOfBlock = useCallback((index: number) => {
    const viewport = viewportRef.current
    const item = blocksOf(contentRef.current)[index]

    if (!viewport || !item) {
      return null
    }

    const bounds = viewport.getBoundingClientRect()
    const rect = item.getClientRects()[0] ?? item.getBoundingClientRect()

    if (paged) {
      const width = viewport.clientWidth || 1
      return Math.max(0, Math.floor((rect.left - bounds.left + viewport.scrollLeft + 1) / width))
    }

    return rect.top - bounds.top + viewport.scrollTop
  }, [paged])

  const goToPage = useCallback((target: number) => {
    const viewport = viewportRef.current

    if (!viewport) {
      return
    }

    const count = measure()
    const nextPage = Math.min(count - 1, Math.max(0, target))
    viewport.scrollLeft = nextPage * viewport.clientWidth
    setPageCount(count)
    setPage(nextPage)
  }, [measure])

  const report = useCallback(() => {
    const viewport = viewportRef.current

    if (!viewport) {
      return
    }

    let percent: number

    if (paged) {
      const count = measure()
      const current = Math.round(viewport.scrollLeft / (viewport.clientWidth || 1))
      percent = count > 1 ? Math.round((current / (count - 1)) * 100) : 0
    } else {
      const maximum = viewport.scrollHeight - viewport.clientHeight
      percent = maximum > 0 ? Math.round((viewport.scrollTop / maximum) * 100) : 0
    }

    const block = firstVisibleBlock()
    anchorRef.current = block
    onPosition({
      page: Math.min(100, Math.max(0, percent)),
      totalPages: 100,
      locationType: 'percent',
      locator: block != null ? `b:${block}` : undefined,
    })
  }, [firstVisibleBlock, measure, onPosition, paged])

  // Restore the reading position once the text is laid out.
  useLayoutEffect(() => {
    const viewport = viewportRef.current

    if (!html || !viewport || restoredRef.current) {
      return
    }

    restoredRef.current = true
    const locatorBlock = initial?.locator?.startsWith('b:') ? Number(initial.locator.slice(2)) : null
    const percent = initial?.locationType === 'percent' ? initial.page : 0

    if (paged) {
      const count = measure()
      const blockPage = locatorBlock != null && Number.isFinite(locatorBlock) ? pageOfBlock(locatorBlock) : null
      goToPage(blockPage ?? Math.round((percent / 100) * (count - 1)))
    } else {
      const blockOffset = locatorBlock != null && Number.isFinite(locatorBlock) ? pageOfBlock(locatorBlock) : null
      viewport.scrollTop =
        blockOffset ?? Math.round((percent / 100) * Math.max(0, viewport.scrollHeight - viewport.clientHeight))
    }

    report()
  }, [goToPage, html, initial, measure, pageOfBlock, paged, report])

  // Keep the same paragraph in view when the text size or window changes.
  useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport || !html || typeof ResizeObserver === 'undefined') {
      return
    }

    let frame = 0
    const relayout = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const anchor = anchorRef.current

        if (paged) {
          const count = measure()
          setPageCount(count)
          const anchorPage = anchor != null ? pageOfBlock(anchor) : null

          if (anchorPage != null) {
            viewport.scrollLeft = anchorPage * viewport.clientWidth
            setPage(anchorPage)
          }
        }
      })
    }

    const observer = new ResizeObserver(relayout)
    observer.observe(viewport)

    if (contentRef.current) {
      observer.observe(contentRef.current)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [html, measure, pageOfBlock, paged])

  useEffect(() => {
    if (!html) {
      return
    }

    const anchor = anchorRef.current
    const frame = requestAnimationFrame(() => {
      if (anchor != null && paged) {
        const anchorPage = pageOfBlock(anchor)

        if (anchorPage != null) {
          goToPage(anchorPage)
        }
      }
    })

    return () => cancelAnimationFrame(frame)
    // Re-anchor when typography changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textStyle.fontScale, textStyle.font, textStyle.spacing, textStyle.margins, textStyle.justify])

  const forward = useCallback(() => {
    if (!paged) {
      onNextEntry?.()
      return
    }

    const count = measure()

    if (page >= count - 1) {
      onNextEntry?.()
      return
    }

    goToPage(page + 1)
    onTurn?.()
    report()
  }, [goToPage, measure, onNextEntry, onTurn, page, paged, report])

  const back = useCallback(() => {
    if (!paged) {
      onPreviousEntry?.()
      return
    }

    if (page <= 0) {
      onPreviousEntry?.()
      return
    }

    goToPage(page - 1)
    onTurn?.()
    report()
  }, [goToPage, onPreviousEntry, onTurn, page, paged, report])

  const controller = useMemo(
    () => ({
      goTo: (percent: number) => {
        const viewport = viewportRef.current

        if (!viewport) {
          return
        }

        if (paged) {
          goToPage(Math.round((percent / 100) * (measure() - 1)))
        } else {
          viewport.scrollTop = Math.round((percent / 100) * (viewport.scrollHeight - viewport.clientHeight))
        }

        report()
      },
      next: forward,
      previous: back,
    }),
    [back, forward, goToPage, measure, paged, report],
  )

  useEffect(() => {
    if (html) {
      onReady?.(controller)
    }
  }, [controller, html, onReady])

  useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport || paged || !html) {
      return
    }

    let timer = 0
    const handleScroll = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(report, 250)
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.clearTimeout(timer)
      viewport.removeEventListener('scroll', handleScroll)
    }
  }, [html, paged, report])

  if (error) {
    return (
      <div className="reader-state">
        <h2>{t.reader.errorTitle}</h2>
        <p>{error}</p>
      </div>
    )
  }

  return (
    <TapSurface
      className="flow"
      direction="ltr"
      layout={tapLayout}
      mode={paged ? 'paged' : 'scroll'}
      onBack={back}
      onForward={forward}
      onMenu={onCenterTap}
      scrollRef={viewportRef}
    >
      <div
        className={`flow__viewport${paged ? ' flow__viewport--paged' : ''}${textStyle.font === 'publisher' ? ' flow__viewport--publisher' : ''}`}
        ref={viewportRef}
        style={textStyleVariables(textStyle)}
      >
        {html == null ? (
          <p className="reader-state">{t.reader.loading}</p>
        ) : (
          <article
            className="flow__content"
            dangerouslySetInnerHTML={{ __html: html }}
            ref={(element) => {
              contentRef.current = element
            }}
          />
        )}
      </div>
      {paged && html != null && pageCount > 1 && (
        <span aria-hidden="true" className="flow__folio">
          {page + 1} / {pageCount}
        </span>
      )}
    </TapSurface>
  )
}
