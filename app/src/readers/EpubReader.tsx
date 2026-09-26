import ePub, { type Book, type Contents, type Location, type Rendition } from 'epubjs'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { fetchAuthenticatedResource } from '../authenticatedResource'
import { cacheGet, cacheSet } from '../app/cache'
import type { TextStyle } from '../app/preferences'
import { resolvePagedSwipeAction, resolveTapZone } from '../readerGestures'
import { useT } from '../i18n'
import { lineHeights, pageMargins, sansStack, serifStack } from './textStyle'
import type { ReaderContentProps, TocItem } from './types'

type NavItem = { label: string; href: string; subitems?: NavItem[] }

const flattenToc = (items: NavItem[], depth = 0): TocItem[] =>
  items.flatMap((item) => [
    { label: item.label.trim(), href: item.href, depth },
    ...flattenToc(item.subitems ?? [], depth + 1),
  ])

/** CSS injected into every chapter so the device typography applies. */
const bookCss = (style: TextStyle, dark: boolean) => {
  const family = style.font === 'sans' ? sansStack : style.font === 'serif' ? serifStack : null
  const textRules = [
    family ? `font-family: ${family} !important;` : '',
    `line-height: ${lineHeights[style.spacing]} !important;`,
    style.justify ? 'text-align: justify !important; hyphens: auto;' : '',
  ].join(' ')

  return `
    html, body {
      background: ${dark ? '#0b0b0b' : '#ffffff'} !important;
      color: ${dark ? '#f2f2f2' : '#0d0d0d'} !important;
    }
    body {
      font-size: ${Math.round((style.fontScale / 100) * 112)}% !important;
      ${family ? `font-family: ${family} !important;` : ''}
      line-height: ${lineHeights[style.spacing]} !important;
      margin: 0 !important;
      -webkit-font-smoothing: antialiased;
    }
    p, li, dd, blockquote, div { ${textRules} }
    a { color: inherit !important; }
    img, svg, image { max-width: 100% !important; height: auto; }
    ${dark ? 'img { filter: none; }' : ''}
  `
}

/**
 * EPUB reader on epub.js. It opens at the exact saved spot (a CFI), shows the
 * first page before anything else, and measures percentages in the background
 * (cached, so large books only pay for that once).
 */
export function EpubReader({
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
  onToc,
}: ReaderContentProps) {
  const t = useT()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const atEndRef = useRef(false)
  const atStartRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const paged = settings.layout === 'paged'
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
  const callbacksRef = useRef({ onPosition, onCenterTap, onTurn, onNextEntry, onPreviousEntry, tapLayout })
  const cssRef = useRef(bookCss(textStyle, dark))

  useEffect(() => {
    callbacksRef.current = { onPosition, onCenterTap, onTurn, onNextEntry, onPreviousEntry, tapLayout }
  }, [onCenterTap, onNextEntry, onPosition, onPreviousEntry, onTurn, tapLayout])

  const forward = useCallback(() => {
    if (atEndRef.current) {
      callbacksRef.current.onNextEntry?.()
      return
    }

    void renditionRef.current?.next()
    callbacksRef.current.onTurn?.()
  }, [])

  const back = useCallback(() => {
    if (atStartRef.current) {
      callbacksRef.current.onPreviousEntry?.()
      return
    }

    void renditionRef.current?.prev()
    callbacksRef.current.onTurn?.()
  }, [])

  useEffect(() => {
    const stage = stageRef.current

    if (!stage) {
      return
    }

    let cancelled = false
    const locationsKey = `epub-locations:${source.variantId}:${source.fileUrl}`
    setReady(false)
    setError(null)

    const open = async () => {
      try {
        const response = await fetchAuthenticatedResource(source.fileUrl)
        const data = await response.arrayBuffer()

        if (cancelled) {
          return
        }

        const book = ePub(data)
        bookRef.current = book
        await book.ready

        if (cancelled) {
          book.destroy()
          return
        }

        const rendition = book.renderTo(stage, {
          width: '100%',
          height: '100%',
          flow: paged ? 'paginated' : 'scrolled-doc',
          manager: paged ? 'default' : 'continuous',
          spread: 'none',
          allowScriptedContent: false,
        })
        renditionRef.current = rendition
        // epub.js only re-injects rule themes into new chapters, so the device
        // typography is added by a content hook instead.
        rendition.hooks.content.register((contents: Contents) => {
          contents.addStylesheetCss(cssRef.current, 'orbital')
        })

        const cachedLocations = await cacheGet<string>(locationsKey)

        if (cachedLocations) {
          book.locations.load(cachedLocations)
        }

        const percentOf = (cfi: string, location: Location) => {
          if (book.locations.length() > 0) {
            return Math.round(book.locations.percentageFromCfi(cfi) * 100)
          }

          const spineLength = (book.spine as unknown as { length: number }).length || 1
          return Math.round((location.start.index / spineLength) * 100)
        }

        rendition.on('relocated', (location: Location) => {
          const cfi = location?.start?.cfi

          if (!cfi) {
            return
          }

          atStartRef.current = Boolean(location.atStart)
          atEndRef.current = Boolean(location.atEnd)
          callbacksRef.current.onPosition({
            page: Math.min(100, Math.max(0, percentOf(cfi, location))),
            totalPages: 100,
            locationType: 'percent',
            locator: cfi,
          })
        })

        // Taps and swipes happen inside the book's frame; map them to page turns.
        let touchStart: { x: number; y: number } | null = null
        let lastSwipe = 0

        const framePoint = (event: MouseEvent | Touch, view: Window | null) => {
          const frame = view?.frameElement as HTMLElement | null
          const frameRect = frame?.getBoundingClientRect()
          const stageRect = stage.getBoundingClientRect()
          return {
            x: (frameRect?.left ?? 0) + event.clientX - stageRect.left,
            y: (frameRect?.top ?? 0) + event.clientY - stageRect.top,
            width: stageRect.width,
            height: stageRect.height,
          }
        }

        rendition.on('touchstart', (event: TouchEvent) => {
          const touch = event.touches[0]
          touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null
        })

        rendition.on('touchend', (event: TouchEvent) => {
          const touch = event.changedTouches[0]

          if (!touchStart || !touch || !paged) {
            return
          }

          const action = resolvePagedSwipeAction(touch.clientX - touchStart.x, touch.clientY - touchStart.y, 'ltr')
          touchStart = null

          if (action) {
            lastSwipe = Date.now()

            if (action === 'next') {
              forward()
            } else {
              back()
            }
          }
        })

        rendition.on('click', (event: MouseEvent) => {
          if (Date.now() - lastSwipe < 500) {
            return
          }

          const target = event.target as Element | null

          if (target?.closest?.('a[href]')) {
            return
          }

          const point = framePoint(event, event.view)
          const zone = resolveTapZone(point.x, point.y, point.width, point.height, callbacksRef.current.tapLayout, 'ltr')

          if (!paged && zone !== 'menu') {
            const scroller = stage.querySelector<HTMLElement>('.epub-container') ?? stage
            scroller.scrollBy({ top: (zone === 'forward' ? 1 : -1) * scroller.clientHeight * 0.88 })
            return
          }

          if (zone === 'forward') {
            forward()
          } else if (zone === 'back') {
            back()
          } else {
            callbacksRef.current.onCenterTap()
          }
        })

        rendition.on('keyup', (event: KeyboardEvent) => {
          if (event.key === 'ArrowRight' || event.key === 'PageDown') {
            forward()
          } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
            back()
          }
        })

        const savedCfi = initial?.locator?.startsWith('epubcfi(') ? initial.locator : null
        const savedPercent = initial?.locationType === 'percent' ? initial.page : 0
        let target: string | undefined = savedCfi ?? undefined

        if (!target && savedPercent > 0) {
          if (book.locations.length() > 0) {
            target = book.locations.cfiFromPercentage(savedPercent / 100)
          } else {
            const spineLength = (book.spine as unknown as { length: number }).length || 1
            const section = book.spine.get(Math.min(spineLength - 1, Math.floor((savedPercent / 100) * spineLength)))
            target = section?.href
          }
        }

        await rendition.display(target)

        if (cancelled) {
          return
        }

        setReady(true)

        const navigation = await book.loaded.navigation.catch(() => null)

        if (!cancelled && navigation?.toc?.length) {
          onToc?.(flattenToc(navigation.toc as unknown as NavItem[]))
        }

        if (!cachedLocations) {
          // Measure the book for percentages without blocking the first page.
          window.setTimeout(() => {
            if (cancelled) {
              return
            }

            void book.locations.generate(1600).then(() => {
              if (!cancelled) {
                void cacheSet(locationsKey, book.locations.save())
                void rendition.reportLocation()
              }
            }).catch(() => undefined)
          }, 1500)
        }
      } catch (openError) {
        if (!cancelled) {
          const message = openError instanceof Error ? openError.message : t.reader.errorBody
          setError(message)
          onError?.(message)
        }
      }
    }

    void open()

    return () => {
      cancelled = true
      renditionRef.current?.destroy()
      renditionRef.current = null
      bookRef.current?.destroy()
      bookRef.current = null
    }
    // The book is reopened only for a new file or layout; typography updates in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paged, source.fileUrl, source.variantId])

  useEffect(() => {
    cssRef.current = bookCss(textStyle, dark)
    const rendition = renditionRef.current

    if (!rendition) {
      return
    }

    const contents = rendition.getContents() as unknown as Contents[]
    contents.forEach((item) => item.addStylesheetCss(cssRef.current, 'orbital'))
  }, [dark, textStyle])

  const controller = useMemo(
    () => ({
      goTo: (percent: number) => {
        const book = bookRef.current

        if (!book || book.locations.length() === 0) {
          return
        }

        void renditionRef.current?.display(book.locations.cfiFromPercentage(Math.min(1, Math.max(0, percent / 100))))
      },
      goToHref: (href: string) => {
        void renditionRef.current?.display(href)
      },
      next: forward,
      previous: back,
    }),
    [back, forward],
  )

  useEffect(() => {
    if (ready) {
      onReady?.(controller)
    }
  }, [controller, onReady, ready])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return
      }

      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault()
        forward()
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        back()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [back, forward])

  return (
    <div className="epub" style={{ '--epub-margin': `${pageMargins[textStyle.margins]}px` } as CSSProperties}>
      {error ? (
        <div className="reader-state">
          <h2>{t.reader.errorTitle}</h2>
          <p>{error}</p>
        </div>
      ) : (
        !ready && <p className="reader-state">{t.reader.loading}</p>
      )}
      <div className={`epub__stage${paged ? ' epub__stage--paged' : ''}`} ref={stageRef} />
    </div>
  )
}
