import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getAuthHeaders } from '../api'
import type { ReaderSettings, ReaderViewMode } from '../appTypes'
import { isLocalAppResourceUrl, isNativeApp, resolveApiUrl } from '../platform'
import { useT } from '../i18n'
import { TapSurface } from './TapSurface'
import type { ReaderContentProps } from './types'

GlobalWorkerOptions.workerSrc = pdfWorker

const assetBase = `${import.meta.env.BASE_URL}pdfjs/`
const maxCanvasPixels = 2400 * 3400
const maxPixelRatio = 2.5

const touchSafariCompatibility = () => {
  if (typeof navigator === 'undefined') {
    return false
  }

  const agent = navigator.userAgent || ''
  return /iPad|iPhone|iPod/i.test(agent) || (/Macintosh/i.test(agent) && navigator.maxTouchPoints > 1)
}

type PageGroup = {
  startPage: number
  endPage: number
  pages: number[]
}

const buildPdfGroups = (
  count: number,
  viewMode: ReaderViewMode,
  direction: ReaderSettings['direction'],
  alignment: ReaderSettings['spreadAlignment'],
): PageGroup[] => {
  if (viewMode === 'single') {
    return Array.from({ length: count }, (_, index) => ({ startPage: index + 1, endPage: index + 1, pages: [index + 1] }))
  }

  const groups: PageGroup[] = []
  let page = 1

  if (alignment === 'cover-first' && count > 0) {
    groups.push({ startPage: 1, endPage: 1, pages: [1] })
    page = 2
  }

  for (; page <= count; page += 2) {
    const second = page + 1 <= count ? page + 1 : null
    groups.push({
      startPage: page,
      endPage: second ?? page,
      pages: second ? (direction === 'rtl' ? [second, page] : [page, second]) : [page],
    })
  }

  return groups
}

type PdfCanvasProps = {
  document: PDFDocumentProxy
  pageNumber: number
  /** The box the page must fit (CSS pixels). */
  boxWidth: number
  boxHeight: number
  fit: ReaderSettings['fitMode'] | 'scroll'
  zoom: number
  label: string
  onFailed: (message: string) => void
}

/** Renders one PDF page into a canvas sized for the screen's pixel density. */
const PdfCanvas = memo(function PdfCanvas({
  document: pdfDocument,
  pageNumber,
  boxWidth,
  boxHeight,
  fit,
  zoom,
  label,
  onFailed,
}: PdfCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [cssSize, setCssSize] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    let task: RenderTask | null = null

    const render = async () => {
      try {
        const page = await pdfDocument.getPage(pageNumber)
        const base = page.getViewport({ scale: 1 })
        const widthScale = boxWidth / base.width
        const heightScale = boxHeight / base.height
        const scale =
          fit === 'fit-page'
            ? Math.min(widthScale, heightScale)
            : fit === 'manual'
              ? Math.min(widthScale, heightScale) * (zoom / 100)
              : widthScale
        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current

        if (cancelled || !canvas) {
          return
        }

        const ratio = Math.min(
          maxPixelRatio,
          Math.max(1, window.devicePixelRatio || 1),
          Math.sqrt(maxCanvasPixels / Math.max(1, viewport.width * viewport.height)),
        )
        const context = canvas.getContext('2d', { alpha: false })

        if (!context) {
          throw new Error('Canvas is not available.')
        }

        canvas.width = Math.floor(viewport.width * ratio)
        canvas.height = Math.floor(viewport.height * ratio)
        task = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        })
        await task.promise

        if (!cancelled) {
          setCssSize({ width: Math.round(viewport.width), height: Math.round(viewport.height) })
        }
      } catch (renderError) {
        const cancelledRender =
          renderError instanceof Error &&
          (renderError.name === 'RenderingCancelledException' || /cancel/i.test(renderError.message))

        if (!cancelled && !cancelledRender) {
          onFailed(renderError instanceof Error ? renderError.message : String(renderError))
        }
      }
    }

    void render()

    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [boxHeight, boxWidth, fit, onFailed, pageNumber, pdfDocument, zoom])

  return (
    <canvas
      aria-label={label}
      className="pdf__canvas"
      ref={canvasRef}
      role="img"
      style={cssSize ? { width: cssSize.width, height: cssSize.height } : { visibility: 'hidden' }}
    />
  )
})

export function PdfReader({
  source,
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
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [aspect, setAspect] = useState(1.414)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(() => Math.max(1, initial?.locationType === 'percent' ? 1 : initial?.page ?? 1))
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const restoredScrollRef = useRef(false)
  const paged = settings.layout === 'paged'
  const viewMode = paged ? settings.viewMode : 'single'

  const fail = useCallback(
    (message: string) => {
      setError(message)
      onError?.(message)
    },
    [onError],
  )

  useEffect(() => {
    let cancelled = false
    let loadingTask: ReturnType<typeof getDocument> | null = null
    setPdf(null)
    setError(null)

    const load = async () => {
      try {
        const url = resolveApiUrl(source.fileUrl)
        const local = source.local || isLocalAppResourceUrl(url)
        const compatibility = touchSafariCompatibility()
        const headers = isNativeApp && !local ? await getAuthHeaders() : {}

        loadingTask = getDocument({
          url,
          httpHeaders: headers,
          withCredentials: !isNativeApp,
          // The app's local file server ignores Range headers, so local files are read whole.
          disableRange: isNativeApp && local,
          disableStream: true,
          disableAutoFetch: true,
          rangeChunkSize: 262_144,
          isEvalSupported: false,
          enableHWA: false,
          iccUrl: `${assetBase}iccs/`,
          standardFontDataUrl: `${assetBase}standard_fonts/`,
          wasmUrl: `${assetBase}wasm/`,
          useWasm: !compatibility,
          isOffscreenCanvasSupported: !compatibility,
          isImageDecoderSupported: !compatibility,
        })

        const document = await loadingTask.promise

        if (cancelled) {
          void document.destroy()
          return
        }

        const first = await document.getPage(1)
        const viewport = first.getViewport({ scale: 1 })
        setAspect(viewport.height / viewport.width)
        setPdf(document)
      } catch (loadError) {
        if (!cancelled) {
          fail(loadError instanceof Error ? loadError.message : t.reader.errorBody)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
      void loadingTask?.destroy()
    }
  }, [fail, source.fileUrl, source.local, t.reader.errorBody])

  useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport || typeof ResizeObserver === 'undefined') {
      return
    }

    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const width = Math.round(viewport.clientWidth)
        const height = Math.round(viewport.clientHeight)
        setBox((previous) => (previous?.width === width && previous.height === height ? previous : { width, height }))
      })
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [pdf])

  const count = pdf?.numPages ?? 0
  const groups = useMemo(
    () => buildPdfGroups(count, viewMode, settings.direction, settings.spreadAlignment),
    [count, settings.direction, settings.spreadAlignment, viewMode],
  )
  const safePage = count ? Math.min(Math.max(page, 1), count) : 1
  const groupIndex = Math.max(0, groups.findIndex((group) => safePage >= group.startPage && safePage <= group.endPage))
  const group = groups[groupIndex] ?? null

  useEffect(() => {
    if (!group || !count) {
      return
    }

    onPosition({ page: group.startPage, endPage: group.endPage, totalPages: count, locationType: 'page', viewMode })
  }, [count, group, onPosition, viewMode])

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

  const pageHeight = box ? Math.round(Math.min(box.width, 1100) * aspect) + 12 : 0

  const controller = useMemo(
    () => ({
      goTo: (target: number) => {
        const next = Math.min(Math.max(1, Math.round(target)), Math.max(1, count))
        setPage(next)

        if (!paged && viewportRef.current && pageHeight) {
          viewportRef.current.scrollTop = (next - 1) * pageHeight
        }
      },
      next: forward,
      previous: back,
    }),
    [back, count, forward, pageHeight, paged],
  )

  useEffect(() => {
    if (pdf) {
      onReady?.(controller)
    }
  }, [controller, onReady, pdf])

  // Scroll mode: restore once, then follow the scroll offset.
  useEffect(() => {
    const viewport = viewportRef.current

    if (paged || !viewport || !pdf || !pageHeight) {
      return
    }

    if (!restoredScrollRef.current) {
      restoredScrollRef.current = true
      viewport.scrollTop = (safePage - 1) * pageHeight
    }

    let frame = 0
    const handleScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const visible = Math.min(count, Math.max(1, Math.floor((viewport.scrollTop + viewport.clientHeight * 0.3) / pageHeight) + 1))
        setPage(visible)
      })
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', handleScroll)
    }
  }, [count, pageHeight, paged, pdf, safePage])

  if (error) {
    return (
      <div className="reader-state">
        <h2>{t.reader.errorTitle}</h2>
        <p>{error}</p>
      </div>
    )
  }

  const zoomed = settings.fitMode === 'manual'
  const pageBox = box
    ? {
        width: group && group.pages.length > 1 ? Math.floor(box.width / 2) : box.width,
        height: box.height,
      }
    : null
  const renderGroups = paged
    ? [groupIndex, groupIndex + 1, groupIndex - 1].filter((index) => index >= 0 && index < groups.length)
    : []

  return (
    <TapSurface
      className="pdf"
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
        className={`pdf__viewport pdf__viewport--${paged ? settings.fitMode : 'scroll'}`}
        ref={viewportRef}
        style={{ '--pdf-page-height': `${pageHeight}px` } as CSSProperties}
      >
        {!pdf || !box ? (
          <p className="reader-state">{t.reader.loading}</p>
        ) : paged ? (
          renderGroups.map((index) => {
            const item = groups[index]
            const active = index === groupIndex

            return (
              <div
                aria-hidden={!active}
                className={`pdf__spread${item.pages.length > 1 ? ' pdf__spread--pair' : ''}`}
                hidden={!active}
                key={`${item.startPage}-${viewMode}`}
              >
                {item.pages.map((pageNumber) => (
                  <PdfCanvas
                    boxHeight={pageBox?.height ?? box.height}
                    boxWidth={pageBox?.width ?? box.width}
                    document={pdf}
                    fit={settings.fitMode}
                    key={pageNumber}
                    label={t.reader.pageImage(pageNumber)}
                    onFailed={fail}
                    pageNumber={pageNumber}
                    zoom={settings.zoom}
                  />
                ))}
              </div>
            )
          })
        ) : (
          <div className="pdf__strip">
            {Array.from({ length: count }, (_, index) => index + 1).map((pageNumber) => (
              <div className="pdf__strip-page" key={pageNumber}>
                {Math.abs(pageNumber - safePage) <= 3 ? (
                  <PdfCanvas
                    boxHeight={Infinity}
                    boxWidth={Math.min(box.width, 1100)}
                    document={pdf}
                    fit="scroll"
                    label={t.reader.pageImage(pageNumber)}
                    onFailed={fail}
                    pageNumber={pageNumber}
                    zoom={100}
                  />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </TapSurface>
  )
}
