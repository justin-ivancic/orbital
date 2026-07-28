import ePub, {
  type Book as EpubBook,
  type Location as EpubLocation,
  type Rendition as EpubRendition,
} from 'epubjs'
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Minus,
  Plus,
  RotateCcw,
  Settings2,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react'
import type {
  EntryFormat,
  ReaderDirection,
  ReaderProgress,
  ReaderSettings,
  ReaderViewMode,
  ReadingStyle,
} from './appTypes'
import {
  compatibleReadingStyles,
  readerSettingsForStyle,
  readingStyleLabels,
} from './readerSettings'

const imagePattern = /\.(avif|gif|jpe?g|png|webp)$/i
const minReaderWidth = 280
const maxPdfCanvasWidth = 1120
const maxPdfCanvasPixelWidth = 2400
const maxPdfPixelRatio = 2.25
const maxTouchPdfPixelRatio = 2
const pdfNativeFallbackDelayMs = 6500
const pdfDesktopImmediateRenderRadius = 3
const pdfTouchImmediateRenderRadius = 4
const pdfDesktopPrefetchRenderRadius = 6
const pdfTouchPrefetchRenderRadius = 7
const pdfDesktopCachedPageLimit = 26
const pdfTouchCachedPageLimit = 30
const minCbzZoom = 70
const maxCbzZoom = 170
const cbzZoomStep = 10
const cbzSinglePageBaseWidth = 980
const cbzSpreadBaseWidth = 1220
const cbzSpreadSoloBaseWidth = 620
const pdfAssetBaseUrl = `${import.meta.env.BASE_URL}pdfjs/`
const pdfWasmUrl = `${pdfAssetBaseUrl}wasm/`
const pdfStandardFontDataUrl = `${pdfAssetBaseUrl}standard_fonts/`
const pdfIccUrl = `${pdfAssetBaseUrl}iccs/`

GlobalWorkerOptions.workerSrc = pdfWorker

const shouldUseTouchPdfCompatibility = () => {
  if (typeof navigator === 'undefined') {
    return false
  }

  const userAgent = navigator.userAgent || ''
  const looksLikeTouchMac = /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1

  return (
    /iPad|iPhone|iPod/i.test(userAgent) ||
    looksLikeTouchMac ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

const getPdfRenderPixelRatio = () => {
  if (typeof window === 'undefined') {
    return 1
  }

  const devicePixelRatio = window.devicePixelRatio || 1
  const viewportScale = window.visualViewport?.scale || 1

  return devicePixelRatio * Math.max(1, Math.min(viewportScale, 2))
}

type PdfEmbedProps = {
  fileUrl: string
  title: string
  initialPage?: number
  onProgressChange?: (progress: ReaderProgress) => void
  onSettingsChange: (settings: ReaderSettings) => void
  settings: ReaderSettings
  toolbarAccessory?: ReactNode
}

type CbzReaderProps = {
  entryId: string
  fileUrl: string
  title: string
  offlinePages?: CbzPage[]
  initialPage?: number
  onProgressChange?: (progress: ReaderProgress) => void
  onSettingsChange: (settings: ReaderSettings) => void
  settings: ReaderSettings
  toolbarAccessory?: ReactNode
}

type HtmlChapterReaderProps = {
  fileUrl: string
  title: string
  initialProgress?: number
  onProgressChange?: (progress: ReaderProgress) => void
  onSettingsChange: (settings: ReaderSettings) => void
  settings: ReaderSettings
  toolbarAccessory?: ReactNode
}

type TextFileReaderProps = {
  fileUrl: string
  title: string
  format: 'md' | 'txt'
  initialProgress?: number
  onProgressChange?: (progress: ReaderProgress) => void
  onSettingsChange: (settings: ReaderSettings) => void
  settings: ReaderSettings
  toolbarAccessory?: ReactNode
}

type EpubReaderProps = {
  fileUrl: string
  title: string
  initialProgress?: number
  onProgressChange?: (progress: ReaderProgress) => void
  onSettingsChange: (settings: ReaderSettings) => void
  settings: ReaderSettings
  toolbarAccessory?: ReactNode
}

type CbzGroup = {
  id: string
  startPage: number
  endPage: number
  pages: CbzDisplayPage[]
}

type CbzPage = {
  archiveIndex: number
  name: string
  url: string
}

type CbzManifestResponse = {
  pageCount: number
  pages: Array<{
    archiveIndex: number
    name: string
    pageNumber: number
    url: string
  }>
}

type CbzDisplayPage = {
  logicalPage: number
  slot: 'left' | 'right' | 'single'
  url: string
}

type CbzReadingDirection = ReaderDirection
type CbzPageOrderMode = 'archive' | 'filename'
type CbzSpreadAlignment = 'cover-first' | 'straight-pairs'

const naturalSort = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })

const clampPage = (page: number, totalPages: number) =>
  Math.min(Math.max(page, 1), Math.max(totalPages, 1))

const clampPercent = (value: number) => Math.min(Math.max(Math.round(value), 0), 100)
const clampZoom = (value: number) =>
  Math.min(Math.max(Math.round(value), minCbzZoom), maxCbzZoom)

type ViewportCenter = {
  x: number
  y: number
}

const centeredViewport: ViewportCenter = { x: 0.5, y: 0.5 }

const readViewportCenter = (viewport: HTMLDivElement): ViewportCenter => ({
  x:
    viewport.scrollWidth > 0
      ? (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth
      : centeredViewport.x,
  y:
    viewport.scrollHeight > 0
      ? (viewport.scrollTop + viewport.clientHeight / 2) / viewport.scrollHeight
      : centeredViewport.y,
})

const writeViewportCenter = (viewport: HTMLDivElement, center: ViewportCenter) => {
  const maximumLeft = Math.max(viewport.scrollWidth - viewport.clientWidth, 0)
  const maximumTop = Math.max(viewport.scrollHeight - viewport.clientHeight, 0)

  viewport.scrollLeft = Math.min(
    Math.max(center.x * viewport.scrollWidth - viewport.clientWidth / 2, 0),
    maximumLeft,
  )
  viewport.scrollTop = Math.min(
    Math.max(center.y * viewport.scrollHeight - viewport.clientHeight / 2, 0),
    maximumTop,
  )
}

type CenteredPagedViewportOptions = {
  fitMode: ReaderSettings['fitMode']
  pageKey: string
  recenterKey?: string
  viewportRef: { current: HTMLDivElement | null }
  zoom: number
}

const useCenteredPagedViewport = ({
  fitMode,
  pageKey,
  recenterKey = '',
  viewportRef,
  zoom,
}: CenteredPagedViewportOptions) => {
  const pendingCenterRef = useRef<ViewportCenter | null>(null)
  const previousPageKeyRef = useRef(pageKey)
  const previousRecenterKeyRef = useRef(recenterKey)

  const captureViewportCenter = useCallback(() => {
    const viewport = viewportRef.current
    pendingCenterRef.current = viewport ? readViewportCenter(viewport) : centeredViewport
  }, [viewportRef])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const pageChanged = previousPageKeyRef.current !== pageKey
    const viewportChanged = previousRecenterKeyRef.current !== recenterKey
    previousPageKeyRef.current = pageKey
    previousRecenterKeyRef.current = recenterKey

    if (fitMode !== 'manual') {
      pendingCenterRef.current = null
      viewport.scrollLeft = 0
      viewport.scrollTop = 0
      return
    }

    const nextCenter =
      pageChanged || viewportChanged
        ? centeredViewport
        : pendingCenterRef.current ?? centeredViewport
    pendingCenterRef.current = null

    const applyCenter = () => writeViewportCenter(viewport, nextCenter)
    applyCenter()
    const frame = requestAnimationFrame(applyCenter)

    return () => cancelAnimationFrame(frame)
  }, [fitMode, pageKey, recenterKey, viewportRef, zoom])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || fitMode !== 'manual' || typeof ResizeObserver === 'undefined') {
      return
    }

    let previousWidth = viewport.clientWidth
    let previousHeight = viewport.clientHeight
    let frame = 0
    const observer = new ResizeObserver(() => {
      const nextWidth = viewport.clientWidth
      const nextHeight = viewport.clientHeight
      if (nextWidth === previousWidth && nextHeight === previousHeight) {
        return
      }

      previousWidth = nextWidth
      previousHeight = nextHeight
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => writeViewportCenter(viewport, centeredViewport))
    })

    observer.observe(viewport)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [fitMode, pageKey, viewportRef])

  return captureViewportCenter
}

type ReaderSettingsControlProps = {
  fileUrl: string
  format: EntryFormat
  onSettingsChange: (settings: ReaderSettings) => void
  settings: ReaderSettings
}

function ReaderSettingsControl({
  fileUrl,
  format,
  onSettingsChange,
  settings,
}: ReaderSettingsControlProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const imageReader = format === 'cbz' || format === 'pdf'
  const availableStyles = compatibleReadingStyles(format)
  const settingsId = `${format}-reader-settings`
  const updateSettings = (updates: Partial<ReaderSettings>) => {
    onSettingsChange({ ...settings, ...updates })
  }
  const applyStyle = (style: ReadingStyle) => {
    onSettingsChange(readerSettingsForStyle(style, settings))
  }

  useEffect(() => {
    if (!settingsOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [settingsOpen])

  return (
    <div className="reader-settings">
      <button
        aria-controls={settingsId}
        aria-expanded={settingsOpen}
        aria-haspopup="dialog"
        className={`ghost-button reader-settings__trigger ${settingsOpen ? 'is-active' : ''}`}
        onClick={() => setSettingsOpen((isOpen) => !isOpen)}
        type="button"
      >
        <Settings2 aria-hidden="true" className="app-icon" strokeWidth={1.9} />
        <span className="reader-settings__trigger-label">Reading style</span>
      </button>

      {settingsOpen && (
        <div
          aria-label="Reader settings"
          className="reader-settings__sheet"
          id={settingsId}
          role="dialog"
        >
          <div className="reader-settings__header">
            <div>
              <span>Reading style</span>
              <strong>{readingStyleLabels[settings.style]}</strong>
            </div>
            <button
              aria-label="Close reader settings"
              className="reader-settings__close"
              onClick={() => setSettingsOpen(false)}
              type="button"
            >
              <X aria-hidden="true" className="app-icon" strokeWidth={1.9} />
            </button>
          </div>

          <div className="reader-settings__group reader-settings__group--wide">
            <span className="reader-settings__label">Treat this as</span>
            <div
              aria-label="Reading style"
              className="reader-settings__choices reader-settings__choices--styles"
            >
              {availableStyles.map((style) => (
                <button
                  aria-pressed={settings.style === style}
                  className={settings.style === style ? 'is-active' : ''}
                  key={style}
                  onClick={() => applyStyle(style)}
                  type="button"
                >
                  {readingStyleLabels[style]}
                </button>
              ))}
            </div>
          </div>

          <div className="reader-settings__group">
            <span className="reader-settings__label">Layout</span>
            <div aria-label="Reader layout" className="reader-settings__choices">
              <button
                aria-pressed={settings.layout === 'paged'}
                className={settings.layout === 'paged' ? 'is-active' : ''}
                onClick={() => updateSettings({ layout: 'paged' })}
                type="button"
              >
                Paged
              </button>
              <button
                aria-pressed={settings.layout === 'continuous'}
                className={settings.layout === 'continuous' ? 'is-active' : ''}
                onClick={() => updateSettings({ layout: 'continuous' })}
                type="button"
              >
                Continuous
              </button>
            </div>
          </div>

          {imageReader && settings.layout === 'paged' && (
            <div className="reader-settings__group">
              <span className="reader-settings__label">Page view</span>
              <div aria-label="Page view" className="reader-settings__choices">
                <button
                  aria-pressed={settings.viewMode === 'single'}
                  className={settings.viewMode === 'single' ? 'is-active' : ''}
                  onClick={() => updateSettings({ viewMode: 'single' })}
                  type="button"
                >
                  Single
                </button>
                <button
                  aria-pressed={settings.viewMode === 'spread'}
                  className={settings.viewMode === 'spread' ? 'is-active' : ''}
                  onClick={() => updateSettings({ viewMode: 'spread' })}
                  type="button"
                >
                  Spread
                </button>
              </div>
            </div>
          )}

          {imageReader && (
            <div className="reader-settings__group reader-settings__group--wide">
              <span className="reader-settings__label">Page fit</span>
              <div
                aria-label="Page fit"
                className="reader-settings__choices reader-settings__choices--three"
              >
                <button
                  aria-pressed={settings.fitMode === 'fit-page'}
                  className={settings.fitMode === 'fit-page' ? 'is-active' : ''}
                  onClick={() => updateSettings({ fitMode: 'fit-page', zoom: 100 })}
                  type="button"
                >
                  Whole page
                </button>
                <button
                  aria-pressed={settings.fitMode === 'fit-width'}
                  className={settings.fitMode === 'fit-width' ? 'is-active' : ''}
                  onClick={() => updateSettings({ fitMode: 'fit-width', zoom: 100 })}
                  type="button"
                >
                  Width
                </button>
                <button
                  aria-pressed={settings.fitMode === 'manual'}
                  className={settings.fitMode === 'manual' ? 'is-active' : ''}
                  onClick={() => updateSettings({ fitMode: 'manual' })}
                  type="button"
                >
                  Zoom
                </button>
              </div>
              {settings.fitMode === 'manual' && (
                <div className="reader-settings__stepper" aria-label="Page zoom">
                  <button
                    aria-label="Zoom out"
                    disabled={settings.zoom <= minCbzZoom}
                    onClick={() => updateSettings({ zoom: clampZoom(settings.zoom - cbzZoomStep) })}
                    type="button"
                  >
                    <Minus aria-hidden="true" className="app-icon" strokeWidth={1.9} />
                  </button>
                  <span>{settings.zoom}%</span>
                  <button
                    aria-label="Zoom in"
                    disabled={settings.zoom >= maxCbzZoom}
                    onClick={() => updateSettings({ zoom: clampZoom(settings.zoom + cbzZoomStep) })}
                    type="button"
                  >
                    <Plus aria-hidden="true" className="app-icon" strokeWidth={1.9} />
                  </button>
                </div>
              )}
            </div>
          )}

          {imageReader && settings.style !== 'webtoon' && (
            <div className="reader-settings__group">
              <span className="reader-settings__label">Direction</span>
              <div aria-label="Reading direction" className="reader-settings__choices">
                <button
                  aria-pressed={settings.direction === 'ltr'}
                  className={settings.direction === 'ltr' ? 'is-active' : ''}
                  onClick={() => updateSettings({ direction: 'ltr' })}
                  type="button"
                >
                  LTR
                </button>
                <button
                  aria-pressed={settings.direction === 'rtl'}
                  className={settings.direction === 'rtl' ? 'is-active' : ''}
                  onClick={() => updateSettings({ direction: 'rtl' })}
                  type="button"
                >
                  RTL
                </button>
              </div>
            </div>
          )}

          {format === 'cbz' && (
            <div className="reader-settings__group">
              <span className="reader-settings__label">Page order</span>
              <div aria-label="Page order" className="reader-settings__choices">
                <button
                  aria-pressed={settings.pageOrder === 'archive'}
                  className={settings.pageOrder === 'archive' ? 'is-active' : ''}
                  onClick={() => updateSettings({ pageOrder: 'archive' })}
                  type="button"
                >
                  Archive
                </button>
                <button
                  aria-pressed={settings.pageOrder === 'filename'}
                  className={settings.pageOrder === 'filename' ? 'is-active' : ''}
                  onClick={() => updateSettings({ pageOrder: 'filename' })}
                  type="button"
                >
                  Filename
                </button>
              </div>
            </div>
          )}

          {imageReader && settings.layout === 'paged' && settings.viewMode === 'spread' && (
            <div className="reader-settings__group">
              <span className="reader-settings__label">Spread pairing</span>
              <div aria-label="Spread pairing" className="reader-settings__choices">
                <button
                  aria-pressed={settings.spreadAlignment === 'cover-first'}
                  className={settings.spreadAlignment === 'cover-first' ? 'is-active' : ''}
                  onClick={() => updateSettings({ spreadAlignment: 'cover-first' })}
                  type="button"
                >
                  Cover first
                </button>
                <button
                  aria-pressed={settings.spreadAlignment === 'straight-pairs'}
                  className={settings.spreadAlignment === 'straight-pairs' ? 'is-active' : ''}
                  onClick={() => updateSettings({ spreadAlignment: 'straight-pairs' })}
                  type="button"
                >
                  Pairs
                </button>
              </div>
            </div>
          )}

          {!imageReader && (
            <div className="reader-settings__group reader-settings__group--wide">
              <span className="reader-settings__label">Text size</span>
              <div className="reader-settings__stepper" aria-label="Text size">
                <button
                  aria-label="Decrease text size"
                  disabled={settings.fontSize <= 80}
                  onClick={() => updateSettings({ fontSize: Math.max(settings.fontSize - 10, 80) })}
                  type="button"
                >
                  <Minus aria-hidden="true" className="app-icon" strokeWidth={1.9} />
                </button>
                <span>{settings.fontSize}%</span>
                <button
                  aria-label="Increase text size"
                  disabled={settings.fontSize >= 160}
                  onClick={() => updateSettings({ fontSize: Math.min(settings.fontSize + 10, 160) })}
                  type="button"
                >
                  <Plus aria-hidden="true" className="app-icon" strokeWidth={1.9} />
                </button>
              </div>
            </div>
          )}

          <div className="reader-settings__footer">
            <button
              className="ghost-button"
              onClick={() => onSettingsChange(readerSettingsForStyle(settings.style))}
              type="button"
            >
              <RotateCcw aria-hidden="true" className="app-icon" strokeWidth={1.9} />
              Reset style
            </button>
            <button
              className="ghost-button"
              onClick={() => window.open(fileUrl, '_blank', 'noopener,noreferrer')}
              type="button"
            >
              <ExternalLink aria-hidden="true" className="app-icon" strokeWidth={1.9} />
              Open original
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

type PagedReaderSurfaceProps = {
  canNext: boolean
  canPrevious: boolean
  children: ReactNode
  direction: ReaderDirection
  onNext: () => void
  onPrevious: () => void
  swipeEnabled?: boolean
}

function PagedReaderSurface({
  canNext,
  canPrevious,
  children,
  direction,
  onNext,
  onPrevious,
  swipeEnabled = true,
}: PagedReaderSurfaceProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const leftAction = direction === 'rtl' ? onNext : onPrevious
  const rightAction = direction === 'rtl' ? onPrevious : onNext
  const canGoLeft = direction === 'rtl' ? canNext : canPrevious
  const canGoRight = direction === 'rtl' ? canPrevious : canNext

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName))
      ) {
        return
      }

      if (event.key === 'ArrowLeft' && canGoLeft) {
        event.preventDefault()
        leftAction()
      } else if ((event.key === 'ArrowRight' || event.key === 'PageDown') && canGoRight) {
        event.preventDefault()
        rightAction()
      } else if (event.key === 'PageUp' && canGoLeft) {
        event.preventDefault()
        leftAction()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canGoLeft, canGoRight, leftAction, rightAction])

  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    event.stopPropagation()

    if (!swipeEnabled) {
      touchStartRef.current = null
      return
    }

    const touch = event.touches[0]
    if (!touch) {
      return
    }

    touchStartRef.current = { x: touch.clientX, y: touch.clientY }
  }

  const handleTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    event.stopPropagation()

    if (!swipeEnabled) {
      touchStartRef.current = null
      return
    }

    const start = touchStartRef.current
    const touch = event.changedTouches[0]
    touchStartRef.current = null

    if (!start || !touch) {
      return
    }

    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (Math.abs(deltaX) < 56 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) {
      return
    }

    if (deltaX > 0 && canGoLeft) {
      leftAction()
    } else if (deltaX < 0 && canGoRight) {
      rightAction()
    }
  }

  return (
    <div
      className="reader-paged-surface"
      onTouchEnd={handleTouchEnd}
      onTouchStart={handleTouchStart}
    >
      {children}
      <button
        aria-label={direction === 'rtl' ? 'Next page' : 'Previous page'}
        className="reader-page-turn reader-page-turn--left"
        disabled={!canGoLeft}
        onClick={leftAction}
        type="button"
      >
        <ChevronLeft aria-hidden="true" strokeWidth={1.8} />
      </button>
      <button
        aria-label={direction === 'rtl' ? 'Previous page' : 'Next page'}
        className="reader-page-turn reader-page-turn--right"
        disabled={!canGoRight}
        onClick={rightAction}
        type="button"
      >
        <ChevronRight aria-hidden="true" strokeWidth={1.8} />
      </button>
    </div>
  )
}

const getCenteredPageRange = (centerPage: number, totalPages: number, radius: number) => {
  if (totalPages <= 0) {
    return []
  }

  const safeCenterPage = clampPage(centerPage, totalPages)
  const startPage = Math.max(1, safeCenterPage - radius)
  const endPage = Math.min(totalPages, safeCenterPage + radius)
  const pages: number[] = []

  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
    pages.push(pageNumber)
  }

  return pages
}

const arePageSetsEqual = (left: Set<number>, right: Set<number>) => {
  if (left.size !== right.size) {
    return false
  }

  for (const pageNumber of left) {
    if (!right.has(pageNumber)) {
      return false
    }
  }

  return true
}

const buildStickyPdfPageSet = (
  previousPages: Set<number>,
  centerPage: number,
  totalPages: number,
  prefetchRadius: number,
  maxCachedPages: number,
) => {
  if (totalPages <= 0) {
    return new Set<number>()
  }

  const nextPages = new Set<number>()

  for (const pageNumber of previousPages) {
    if (pageNumber >= 1 && pageNumber <= totalPages) {
      nextPages.add(pageNumber)
    }
  }

  for (const pageNumber of getCenteredPageRange(centerPage, totalPages, prefetchRadius)) {
    nextPages.add(pageNumber)
  }

  if (nextPages.size <= maxCachedPages) {
    return nextPages
  }

  const safeCenterPage = clampPage(centerPage, totalPages)
  const closestPages = [...nextPages]
    .sort((left, right) => (
      Math.abs(left - safeCenterPage) - Math.abs(right - safeCenterPage) ||
      left - right
    ))
    .slice(0, maxCachedPages)

  return new Set(closestPages)
}

const buildPercentBookmarkCopy = (progress: number, unitLabel: string) => {
  const safeProgress = clampPercent(progress)

  if (safeProgress <= 0) {
    return {
      progressLabel: `${unitLabel} start`,
      cueLabel: `Bookmark set at ${unitLabel.toLowerCase()} start`,
    }
  }

  if (safeProgress >= 100) {
    return {
      progressLabel: `${unitLabel} end`,
      cueLabel: `Bookmark set at ${unitLabel.toLowerCase()} end`,
    }
  }

  return {
    progressLabel: `${safeProgress}% through ${unitLabel.toLowerCase()}`,
    cueLabel: `Bookmark set at ${safeProgress}% of ${unitLabel.toLowerCase()}`,
  }
}

const buildHtmlBookmarkCopy = (progress: number) => {
  return buildPercentBookmarkCopy(progress, 'Chapter')
}

const buildTextBookmarkCopy = (progress: number) => {
  return buildPercentBookmarkCopy(progress, 'Document')
}

const escapeHtmlText = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const renderMarkdownInline = (value: string) =>
  escapeHtmlText(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    )

const plainTextToHtml = (value: string) => {
  const blocks = value.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/)

  if (blocks.length === 0 || blocks.every((block) => block.trim() === '')) {
    return '<p>This text file is empty.</p>'
  }

  return blocks
    .map((block) => `<p>${escapeHtmlText(block.trim()).replace(/\n/g, '<br />')}</p>`)
    .join('')
}

const markdownToHtml = (value: string) => {
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  const paragraph: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let inCodeBlock = false
  let codeLines: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return
    }

    output.push(`<p>${renderMarkdownInline(paragraph.join(' ').trim())}</p>`)
    paragraph.length = 0
  }

  const closeList = () => {
    if (!listType) {
      return
    }

    output.push(`</${listType}>`)
    listType = null
  }

  for (const line of lines) {
    const trimmedLine = line.trim()

    if (/^```/.test(trimmedLine)) {
      if (inCodeBlock) {
        output.push(`<pre><code>${escapeHtmlText(codeLines.join('\n'))}</code></pre>`)
        codeLines = []
        inCodeBlock = false
      } else {
        flushParagraph()
        closeList()
        inCodeBlock = true
      }
      continue
    }

    if (inCodeBlock) {
      codeLines.push(line)
      continue
    }

    if (trimmedLine === '') {
      flushParagraph()
      closeList()
      continue
    }

    const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      flushParagraph()
      closeList()
      const level = Math.min(headingMatch[1].length, 6)
      output.push(`<h${level}>${renderMarkdownInline(headingMatch[2])}</h${level}>`)
      continue
    }

    const unorderedMatch = trimmedLine.match(/^[-*+]\s+(.+)$/)
    if (unorderedMatch) {
      flushParagraph()
      if (listType !== 'ul') {
        closeList()
        output.push('<ul>')
        listType = 'ul'
      }
      output.push(`<li>${renderMarkdownInline(unorderedMatch[1])}</li>`)
      continue
    }

    const orderedMatch = trimmedLine.match(/^\d+[.)]\s+(.+)$/)
    if (orderedMatch) {
      flushParagraph()
      if (listType !== 'ol') {
        closeList()
        output.push('<ol>')
        listType = 'ol'
      }
      output.push(`<li>${renderMarkdownInline(orderedMatch[1])}</li>`)
      continue
    }

    const quoteMatch = trimmedLine.match(/^>\s?(.+)$/)
    if (quoteMatch) {
      flushParagraph()
      closeList()
      output.push(`<blockquote>${renderMarkdownInline(quoteMatch[1])}</blockquote>`)
      continue
    }

    paragraph.push(trimmedLine)
  }

  if (inCodeBlock) {
    output.push(`<pre><code>${escapeHtmlText(codeLines.join('\n'))}</code></pre>`)
  }

  flushParagraph()
  closeList()

  return output.join('') || '<p>This Markdown file is empty.</p>'
}

const resolveTextDocumentTitle = (rawText: string, fallbackTitle: string, format: 'md' | 'txt') => {
  const normalizedText = rawText.replace(/\r\n?/g, '\n')

  if (format === 'md') {
    const heading = normalizedText.match(/^#\s+(.+)$/m)?.[1]?.trim()

    if (heading) {
      return heading
    }
  }

  return normalizedText.split('\n').find((line) => line.trim().length > 0)?.trim() || fallbackTitle
}

const getClosestPageByViewportCenter = (
  viewport: HTMLDivElement,
  elements: Array<HTMLDivElement | null>,
  getPageForIndex: (index: number) => number,
) => {
  const viewportCenter = viewport.scrollTop + viewport.clientHeight * 0.5
  let closestPage = getPageForIndex(0)
  let smallestDistance = Number.POSITIVE_INFINITY

  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]

    if (!element) {
      continue
    }

    const elementCenter = element.offsetTop + element.offsetHeight * 0.5
    const distance = Math.abs(elementCenter - viewportCenter)

    if (distance < smallestDistance) {
      smallestDistance = distance
      closestPage = getPageForIndex(index)
    }
  }

  return closestPage
}

const buildCbzGroups = (
  pages: CbzPage[],
  viewMode: ReaderViewMode,
  readingDirection: CbzReadingDirection,
  spreadAlignment: CbzSpreadAlignment,
): CbzGroup[] => {
  if (viewMode === 'single') {
    return pages.map((page, index) => ({
      id: `page-${index + 1}`,
      startPage: index + 1,
      endPage: index + 1,
      pages: [
        {
          logicalPage: index + 1,
          slot: 'single',
          url: page.url,
        },
      ],
    }))
  }

  const groups: CbzGroup[] = []
  const startIndex = spreadAlignment === 'cover-first' ? 1 : 0

  if (spreadAlignment === 'cover-first' && pages[0]) {
    groups.push({
      id: 'page-1',
      startPage: 1,
      endPage: 1,
      pages: [
        {
          logicalPage: 1,
          slot: 'single',
          url: pages[0].url,
        },
      ],
    })
  }

  for (let index = startIndex; index < pages.length; index += 2) {
    const firstPage = pages[index]
    const secondPage = pages[index + 1]
    const startPage = index + 1
    const endPage = secondPage ? startPage + 1 : startPage

    const displayPages: CbzDisplayPage[] = secondPage
      ? readingDirection === 'rtl'
        ? [
            {
              logicalPage: startPage + 1,
              slot: 'left',
              url: secondPage.url,
            },
            {
              logicalPage: startPage,
              slot: 'right',
              url: firstPage.url,
            },
          ]
        : [
            {
              logicalPage: startPage,
              slot: 'left',
              url: firstPage.url,
            },
            {
              logicalPage: startPage + 1,
              slot: 'right',
              url: secondPage.url,
            },
          ]
      : [
          {
            logicalPage: startPage,
            slot: 'single',
            url: firstPage.url,
          },
        ]

    groups.push({
      id: `page-${startPage}`,
      startPage,
      endPage,
      pages: displayPages,
    })
  }

  return groups
}

type PdfDisplayPage = {
  logicalPage: number
  slot: 'left' | 'right' | 'single'
}

type PdfGroup = {
  id: string
  startPage: number
  endPage: number
  pages: PdfDisplayPage[]
}

const buildPdfGroups = (
  pageCount: number,
  viewMode: ReaderViewMode,
  readingDirection: ReaderDirection,
  spreadAlignment: CbzSpreadAlignment,
): PdfGroup[] => {
  const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1)

  if (viewMode === 'single') {
    return pageNumbers.map((pageNumber) => ({
      id: `page-${pageNumber}`,
      startPage: pageNumber,
      endPage: pageNumber,
      pages: [{ logicalPage: pageNumber, slot: 'single' }],
    }))
  }

  const groups: PdfGroup[] = []
  const startIndex = spreadAlignment === 'cover-first' ? 1 : 0

  if (spreadAlignment === 'cover-first' && pageNumbers[0]) {
    groups.push({
      id: 'page-1',
      startPage: 1,
      endPage: 1,
      pages: [{ logicalPage: 1, slot: 'single' }],
    })
  }

  for (let index = startIndex; index < pageNumbers.length; index += 2) {
    const firstPage = pageNumbers[index]
    const secondPage = pageNumbers[index + 1]
    const displayPages: PdfDisplayPage[] = secondPage
      ? readingDirection === 'rtl'
        ? [
            { logicalPage: secondPage, slot: 'left' },
            { logicalPage: firstPage, slot: 'right' },
          ]
        : [
            { logicalPage: firstPage, slot: 'left' },
            { logicalPage: secondPage, slot: 'right' },
          ]
      : [{ logicalPage: firstPage, slot: 'single' }]

    groups.push({
      id: `page-${firstPage}`,
      startPage: firstPage,
      endPage: secondPage ?? firstPage,
      pages: displayPages,
    })
  }

  return groups
}

const orderCbzPages = (pages: CbzPage[], pageOrderMode: CbzPageOrderMode) => {
  if (pageOrderMode === 'archive') {
    return [...pages].sort((left, right) => left.archiveIndex - right.archiveIndex)
  }

  return [...pages].sort((left, right) => naturalSort(left.name, right.name))
}

type PdfPageCanvasProps = {
  browserPixelRatio: number
  estimatedHeight: number
  fitHeight?: number
  fitMode?: ReaderSettings['fitMode']
  pdfDocument: PDFDocumentProxy
  pageNumber: number
  targetWidth: number
  title: string
  onError: (message: string) => void
  onRendered?: () => void
  pixelRatioLimit: number
  zoom?: number
}

function PdfPageCanvas({
  browserPixelRatio,
  estimatedHeight,
  fitHeight,
  fitMode,
  pdfDocument,
  pageNumber,
  targetWidth,
  title,
  onError,
  onRendered,
  pixelRatioLimit,
  zoom = 100,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [displaySize, setDisplaySize] = useState(() => ({
    height: estimatedHeight,
    width: targetWidth,
  }))

  useEffect(() => {
    let cancelled = false
    let renderTask: RenderTask | null = null
    let pdfPage: PDFPageProxy | null = null

    const renderPage = async () => {
      try {
        setDisplaySize({
          height: estimatedHeight,
          width: targetWidth,
        })

        pdfPage = await pdfDocument.getPage(pageNumber)

        if (cancelled || !canvasRef.current) {
          pdfPage.cleanup()
          return
        }

        const baseViewport = pdfPage.getViewport({ scale: 1 })
        const pageAspectRatio = baseViewport.height / baseViewport.width
        const wholePageWidth =
          fitHeight == null
            ? targetWidth
            : Math.min(targetWidth, fitHeight / pageAspectRatio)
        const resolvedTargetWidth =
          fitMode === 'fit-page'
            ? wholePageWidth
            : fitMode === 'manual'
              ? Math.min((wholePageWidth * zoom) / 100, maxPdfCanvasWidth * 1.5)
              : targetWidth
        const scale = resolvedTargetWidth / baseViewport.width
        const viewport = pdfPage.getViewport({ scale })
        const canvas = canvasRef.current
        const canvasContext =
          canvas.getContext('2d', {
            alpha: false,
            desynchronized: true,
          }) ?? canvas.getContext('2d', { alpha: false })

        if (!canvasContext) {
          throw new Error('Failed to prepare the PDF canvas.')
        }

        const pixelRatio = Math.max(
          1,
          Math.min(
            browserPixelRatio || 1,
            pixelRatioLimit,
            maxPdfCanvasPixelWidth / Math.max(1, viewport.width),
          ),
        )

        canvas.width = Math.floor(viewport.width * pixelRatio)
        canvas.height = Math.floor(viewport.height * pixelRatio)
        setDisplaySize({
          height: Math.round(viewport.height),
          width: Math.round(viewport.width),
        })

        renderTask = pdfPage.render({
          canvas,
          canvasContext,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
          viewport,
        })

        await renderTask.promise
        if (!cancelled) {
          onRendered?.()
        }
      } catch (renderError) {
        const cancelledRender =
          renderError instanceof Error &&
          (renderError.name === 'RenderingCancelledException' || /cancel/i.test(renderError.message))

        if (!cancelled && !cancelledRender) {
          const message =
            renderError instanceof Error ? renderError.message : 'Failed to render this PDF page.'
          onError(message)
        }
      }
    }

    void renderPage()

    return () => {
      cancelled = true
      renderTask?.cancel()
      pdfPage?.cleanup()
    }
  }, [
    browserPixelRatio,
    estimatedHeight,
    fitHeight,
    fitMode,
    onError,
    onRendered,
    pageNumber,
    pdfDocument,
    pixelRatioLimit,
    targetWidth,
    zoom,
  ])

  return (
    <canvas
      aria-label={`${title} page ${pageNumber}`}
      className="document-frame__canvas"
      ref={canvasRef}
      style={{
        height: `${displaySize.height}px`,
        width: `${displaySize.width}px`,
      }}
    />
  )
}

export function PdfEmbed({
  fileUrl,
  title,
  initialPage = 1,
  onProgressChange,
  onSettingsChange,
  settings,
  toolbarAccessory,
}: PdfEmbedProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef<Array<HTMLDivElement | null>>([])
  const didInitialScrollRef = useRef(false)
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [pageAspectRatio, setPageAspectRatio] = useState(1.38)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [browserPixelRatio, setBrowserPixelRatio] = useState(() => getPdfRenderPixelRatio())
  const [visiblePage, setVisiblePage] = useState(initialPage)
  const [renderedPdfPages, setRenderedPdfPages] = useState<Set<number>>(() => new Set())
  const [firstPageReady, setFirstPageReady] = useState(false)
  const [nativeFallback, setNativeFallback] = useState(false)
  const touchPdfCompatibility = useMemo(() => shouldUseTouchPdfCompatibility(), [])

  useEffect(() => {
    let disposed = false

    setLoading(true)
    setError(null)
    setDocumentProxy(null)
    setPageCount(0)
    setVisiblePage(initialPage)
    setRenderedPdfPages(new Set())
    setFirstPageReady(false)
    setNativeFallback(false)
    didInitialScrollRef.current = false

    const loadingTask = getDocument({
      url: fileUrl,
      iccUrl: pdfIccUrl,
      disableAutoFetch: true,
      disableStream: true,
      enableHWA: !touchPdfCompatibility,
      isImageDecoderSupported: !touchPdfCompatibility,
      isOffscreenCanvasSupported: !touchPdfCompatibility,
      rangeChunkSize: 262144,
      standardFontDataUrl: pdfStandardFontDataUrl,
      useWasm: !touchPdfCompatibility,
      useWorkerFetch: !touchPdfCompatibility,
      wasmUrl: pdfWasmUrl,
    })

    void loadingTask.promise
      .then(async (pdfDocument) => {
        if (disposed) {
          void pdfDocument.destroy()
          return
        }

        const safeInitialPage = clampPage(initialPage, pdfDocument.numPages)
        const samplePage = await pdfDocument.getPage(safeInitialPage)
        const sampleViewport = samplePage.getViewport({ scale: 1 })

        if (disposed) {
          void pdfDocument.destroy()
          return
        }

        setPageAspectRatio(sampleViewport.height / sampleViewport.width)
        setDocumentProxy(pdfDocument)
        setPageCount(pdfDocument.numPages)
        setVisiblePage(safeInitialPage)
      })
      .catch((loadError) => {
        if (!disposed) {
          const message =
            loadError instanceof Error ? loadError.message : 'Failed to load this PDF file.'
          setError(message)
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false)
        }
      })

    return () => {
      disposed = true
      void loadingTask.destroy()
    }
  }, [fileUrl, initialPage, touchPdfCompatibility])

  useEffect(() => {
    const element = viewportRef.current

    if (!element || loading || error || nativeFallback) {
      return
    }

    let frame = 0
    let timeout = 0
    let observer: ResizeObserver | null = null
    const updateViewportMetrics = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const nextWidth = Math.round(
          element.clientWidth || element.getBoundingClientRect().width || window.innerWidth,
        )
        const nextHeight = Math.round(
          element.clientHeight ||
          element.getBoundingClientRect().height ||
          window.visualViewport?.height ||
          window.innerHeight,
        )

        setViewportWidth((previousWidth) => (
          previousWidth === nextWidth ? previousWidth : nextWidth
        ))
        setViewportHeight((previousHeight) => (
          previousHeight === nextHeight ? previousHeight : nextHeight
        ))
        setBrowserPixelRatio((previousPixelRatio) => {
          const nextPixelRatio = getPdfRenderPixelRatio()

          return Math.abs(previousPixelRatio - nextPixelRatio) < 0.05
            ? previousPixelRatio
            : nextPixelRatio
        })
      })
    }
    const visualViewport = window.visualViewport ?? null

    updateViewportMetrics()
    timeout = window.setTimeout(updateViewportMetrics, 140)
    window.addEventListener('resize', updateViewportMetrics, { passive: true })
    window.addEventListener('orientationchange', updateViewportMetrics)
    visualViewport?.addEventListener('resize', updateViewportMetrics, { passive: true })

    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateViewportMetrics())
      observer.observe(element)
    }

    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
      window.removeEventListener('resize', updateViewportMetrics)
      window.removeEventListener('orientationchange', updateViewportMetrics)
      visualViewport?.removeEventListener('resize', updateViewportMetrics)
      observer?.disconnect()
    }
  }, [error, loading, nativeFallback, pageCount])

  const handlePageRendered = useCallback(() => {
    setFirstPageReady(true)
  }, [])

  const effectiveViewMode = settings.layout === 'paged' ? settings.viewMode : 'single'
  const pdfGroups = useMemo(
    () => buildPdfGroups(
      pageCount,
      effectiveViewMode,
      settings.direction,
      settings.spreadAlignment,
    ),
    [
      effectiveViewMode,
      pageCount,
      settings.direction,
      settings.spreadAlignment,
    ],
  )
  const activePdfGroupIndex = Math.max(
    pdfGroups.findIndex(
      (group) => visiblePage >= group.startPage && visiblePage <= group.endPage,
    ),
    0,
  )
  const activePdfGroup = pdfGroups[activePdfGroupIndex] ?? null
  const pdfPageKey = [
    activePdfGroup?.id ?? 'loading',
    effectiveViewMode,
    settings.direction,
    settings.spreadAlignment,
  ].join(':')
  const capturePdfViewportCenter = useCenteredPagedViewport({
    fitMode: settings.layout === 'paged' ? settings.fitMode : 'fit-width',
    pageKey: pdfPageKey,
    recenterKey: `${viewportWidth}x${viewportHeight}`,
    viewportRef,
    zoom: settings.zoom,
  })
  const handlePdfSettingsChange = useCallback(
    (nextSettings: ReaderSettings) => {
      if (nextSettings.layout === 'paged' && nextSettings.fitMode === 'manual') {
        capturePdfViewportCenter()
      }
      onSettingsChange(nextSettings)
    },
    [capturePdfViewportCenter, onSettingsChange],
  )

  useEffect(() => {
    didInitialScrollRef.current = false
  }, [effectiveViewMode, settings.layout])

  const measuredViewportWidth =
    viewportWidth ||
    (typeof window === 'undefined'
      ? minReaderWidth + 48
      : Math.min(window.innerWidth, maxPdfCanvasWidth + 48))
  const measuredViewportHeight =
    viewportHeight ||
    (typeof window === 'undefined'
      ? 900
      : window.visualViewport?.height || window.innerHeight)
  const pageColumns =
    settings.layout === 'paged' && effectiveViewMode === 'spread' ? 2 : 1
  const pagedInlinePadding =
    measuredViewportWidth <= 720
      ? 12
      : Math.min(Math.max(measuredViewportWidth * 0.06, 24), 72)
  const pagedBlockPadding = measuredViewportWidth <= 720 ? 8 : 14
  const availableWidth = Math.max(
    measuredViewportWidth - pagedInlinePadding * 2,
    1,
  )
  const availablePageWidth = Math.max(availableWidth / pageColumns, 1)
  const availablePageHeight = Math.max(
    measuredViewportHeight - pagedBlockPadding * 2,
    1,
  )
  const continuousWidth = Math.max(
    minReaderWidth,
    Math.min(Math.max(measuredViewportWidth - 48, minReaderWidth), maxPdfCanvasWidth),
  )
  const targetWidth =
    settings.layout === 'paged'
      ? Math.min(availablePageWidth, maxPdfCanvasWidth)
      : settings.fitMode === 'manual'
        ? Math.min((continuousWidth * settings.zoom) / 100, maxPdfCanvasWidth * 1.5)
        : continuousWidth

  const estimatedHeight = useMemo(
    () => Math.max(360, Math.round(targetWidth * pageAspectRatio)),
    [pageAspectRatio, targetWidth],
  )

  const pdfPixelRatioLimit = touchPdfCompatibility ? maxTouchPdfPixelRatio : maxPdfPixelRatio
  const pdfImmediateRenderRadius = touchPdfCompatibility
    ? pdfTouchImmediateRenderRadius
    : pdfDesktopImmediateRenderRadius
  const pdfPrefetchRenderRadius = touchPdfCompatibility
    ? pdfTouchPrefetchRenderRadius
    : pdfDesktopPrefetchRenderRadius
  const pdfCachedPageLimit = touchPdfCompatibility
    ? pdfTouchCachedPageLimit
    : pdfDesktopCachedPageLimit
  const immediatePdfPages = useMemo(
    () => new Set(getCenteredPageRange(visiblePage, pageCount, pdfImmediateRenderRadius)),
    [pageCount, pdfImmediateRenderRadius, visiblePage],
  )

  useEffect(() => {
    if (loading || error || nativeFallback || pageCount === 0) {
      return
    }

    setRenderedPdfPages((previousPages) => {
      const nextPages = buildStickyPdfPageSet(
        previousPages,
        visiblePage,
        pageCount,
        pdfPrefetchRenderRadius,
        pdfCachedPageLimit,
      )

      return arePageSetsEqual(previousPages, nextPages) ? previousPages : nextPages
    })
  }, [
    error,
    loading,
    nativeFallback,
    pageCount,
    pdfCachedPageLimit,
    pdfPrefetchRenderRadius,
    visiblePage,
  ])

  useEffect(() => {
    if (
      settings.layout !== 'continuous' ||
      loading ||
      error ||
      nativeFallback ||
      pageCount === 0 ||
      !viewportRef.current
    ) {
      return
    }

    const viewport = viewportRef.current
    const safeInitialPage = clampPage(initialPage, pageCount)
    let frame = 0
    let correctionFrame = 0
    let timeout = 0

    if (didInitialScrollRef.current) {
      return
    }

    const scrollToInitialPage = () => {
      const targetElement = pageRefs.current[safeInitialPage - 1]

      if (!targetElement) {
        return
      }

      viewport.scrollTop = Math.max(targetElement.offsetTop - 12, 0)
    }

    frame = requestAnimationFrame(() => {
      scrollToInitialPage()
      correctionFrame = requestAnimationFrame(scrollToInitialPage)
      timeout = window.setTimeout(scrollToInitialPage, 160)
      didInitialScrollRef.current = true
    })

    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(correctionFrame)
      window.clearTimeout(timeout)
    }
  }, [
    error,
    initialPage,
    loading,
    nativeFallback,
    pageCount,
    settings.layout,
    targetWidth,
    viewportWidth,
  ])

  useEffect(() => {
    const viewport = viewportRef.current

    if (
      settings.layout !== 'continuous' ||
      !viewport ||
      loading ||
      error ||
      nativeFallback ||
      pageCount === 0
    ) {
      return
    }

    let frame = 0

    const updateVisiblePage = () => {
      const nextVisiblePage = getClosestPageByViewportCenter(
        viewport,
        pageRefs.current,
        (index) => index + 1,
      )

      setVisiblePage((previousPage) =>
        previousPage === nextVisiblePage ? previousPage : nextVisiblePage,
      )
    }

    const handleScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateVisiblePage)
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    updateVisiblePage()

    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', handleScroll)
    }
  }, [error, loading, nativeFallback, pageCount, settings.layout, targetWidth])

  useEffect(() => {
    if (!loading && !error && pageCount > 0) {
      onProgressChange?.({
        page: visiblePage,
        totalPages: pageCount,
        viewMode: effectiveViewMode,
      })
    }
  }, [
    effectiveViewMode,
    error,
    loading,
    onProgressChange,
    pageCount,
    visiblePage,
  ])

  useEffect(() => {
    if (loading || error || nativeFallback || firstPageReady || pageCount === 0) {
      return
    }

    const timeout = window.setTimeout(() => {
      setNativeFallback(true)
    }, pdfNativeFallbackDelayMs)

    return () => window.clearTimeout(timeout)
  }, [error, firstPageReady, loading, nativeFallback, pageCount])

  const showNativePdf = nativeFallback || Boolean(error)
  const nativePdfUrl = useMemo(() => {
    if (fileUrl.includes('#')) {
      return fileUrl
    }

    const targetPage = pageCount > 0 ? clampPage(visiblePage, pageCount) : Math.max(1, initialPage)
    return `${fileUrl}#page=${targetPage}`
  }, [fileUrl, initialPage, pageCount, visiblePage])

  const movePdfGroup = (offset: number) => {
    const nextGroup = pdfGroups[Math.min(Math.max(activePdfGroupIndex + offset, 0), pdfGroups.length - 1)]
    if (nextGroup) {
      setVisiblePage(nextGroup.startPage)
    }
  }
  const pdfPageIndicatorLabel =
    activePdfGroup && activePdfGroup.endPage > activePdfGroup.startPage
      ? `Pages ${activePdfGroup.startPage}-${activePdfGroup.endPage} of ${pageCount}`
      : `Page ${visiblePage} of ${pageCount}`

  return (
    <article className="document-frame">
      <div className="document-frame__toolbar">
        <div>
          <strong>Live PDF reader</strong>
          <p>Choose a reading style, then move through fitted pages or a continuous document.</p>
        </div>
        <div className="document-frame__toolbar-actions">
          {!loading && !error && (
            <span className="document-frame__page-label">{pdfPageIndicatorLabel}</span>
          )}
          <ReaderSettingsControl
            fileUrl={fileUrl}
            format="pdf"
            onSettingsChange={handlePdfSettingsChange}
            settings={settings}
          />
          {toolbarAccessory}
        </div>
      </div>

      {loading && <div className="cbz-viewer__state">Loading pages from {title}...</div>}
      {error && (
        <div className="cbz-viewer__state cbz-viewer__state--error">
          {error} Showing the browser PDF view instead.
        </div>
      )}

      {!loading && showNativePdf && (
        <div className="document-frame__viewport document-frame__viewport--native">
          <iframe className="document-frame__native" src={nativePdfUrl} title={`${title} PDF`} />
        </div>
      )}

      {!loading && !showNativePdf && documentProxy && settings.layout === 'paged' && (
        <div
          className={`document-frame__viewport document-frame__viewport--paged document-frame__viewport--${settings.fitMode}`}
          ref={viewportRef}
        >
          <PagedReaderSurface
            canNext={activePdfGroupIndex < pdfGroups.length - 1}
            canPrevious={activePdfGroupIndex > 0}
            direction={settings.direction}
            onNext={() => movePdfGroup(1)}
            onPrevious={() => movePdfGroup(-1)}
            swipeEnabled={settings.fitMode !== 'manual'}
          >
            <div
              className={`document-frame__paged-group ${
                effectiveViewMode === 'spread' ? 'document-frame__paged-group--spread' : ''
              }`}
            >
              {pdfGroups
                .filter((_, index) => Math.abs(index - activePdfGroupIndex) <= 1)
                .map((group) => (
                  <div
                    aria-hidden={group !== activePdfGroup}
                    className={
                      group === activePdfGroup
                        ? 'document-frame__paged-sheet is-active'
                        : 'document-frame__paged-sheet is-preloaded'
                    }
                    key={`${fileUrl}-${group.id}-${effectiveViewMode}`}
                  >
                    {group.pages.map((page) => (
                      <div
                        className={`document-frame__paged-panel document-frame__paged-panel--${page.slot}`}
                        key={page.logicalPage}
                      >
                        <PdfPageCanvas
                          browserPixelRatio={browserPixelRatio}
                          estimatedHeight={estimatedHeight}
                          fitHeight={availablePageHeight}
                          fitMode={settings.fitMode}
                          onError={setError}
                          onRendered={
                            group === activePdfGroup ? handlePageRendered : undefined
                          }
                          pageNumber={page.logicalPage}
                          pixelRatioLimit={pdfPixelRatioLimit}
                          pdfDocument={documentProxy}
                          targetWidth={targetWidth}
                          title={title}
                          zoom={settings.zoom}
                        />
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          </PagedReaderSurface>
        </div>
      )}

      {!loading && !showNativePdf && documentProxy && settings.layout === 'continuous' && (
        <div className="document-frame__viewport" ref={viewportRef}>
          <div className="document-frame__stack">
            {Array.from({ length: pageCount }, (_, index) => {
              const pageNumber = index + 1
              const shouldRender = immediatePdfPages.has(pageNumber) || renderedPdfPages.has(pageNumber)

              return (
                <div
                  className="document-frame__page"
                  key={`${fileUrl}-${pageNumber}`}
                  ref={(element) => {
                    pageRefs.current[index] = element
                  }}
                  data-page={pageNumber}
                >
                  {shouldRender ? (
                    <PdfPageCanvas
                      browserPixelRatio={browserPixelRatio}
                      estimatedHeight={estimatedHeight}
                      onError={setError}
                      onRendered={handlePageRendered}
                      pageNumber={pageNumber}
                      pixelRatioLimit={pdfPixelRatioLimit}
                      pdfDocument={documentProxy}
                      targetWidth={targetWidth}
                      title={title}
                    />
                  ) : (
                    <div
                      className="document-frame__placeholder"
                      style={{ height: `${estimatedHeight}px` }}
                    >
                      <span>Page {pageNumber}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </article>
  )
}

export function EpubReader({
  fileUrl,
  title,
  initialProgress = 0,
  onProgressChange,
  onSettingsChange,
  settings,
  toolbarAccessory,
}: EpubReaderProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const bookRef = useRef<EpubBook | null>(null)
  const renditionRef = useRef<EpubRendition | null>(null)
  const fontSizeRef = useRef(settings.fontSize)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visibleProgress, setVisibleProgress] = useState(clampPercent(initialProgress))
  const [atStart, setAtStart] = useState(initialProgress <= 0)
  const [atEnd, setAtEnd] = useState(initialProgress >= 100)
  const [resolvedTitle, setResolvedTitle] = useState(title)

  useEffect(() => {
    let disposed = false

    setLoading(true)
    setError(null)
    setVisibleProgress(clampPercent(initialProgress))
    setAtStart(initialProgress <= 0)
    setAtEnd(initialProgress >= 100)
    setResolvedTitle(title)

    const load = async () => {
      try {
        const response = await fetch(fileUrl, {
          credentials: 'same-origin',
        })

        if (!response.ok) {
          throw new Error(`Failed to load EPUB (${response.status})`)
        }

        const fileData = await response.arrayBuffer()
        const book = ePub(fileData)
        bookRef.current = book

        await book.ready
        await book.locations.generate(1200)

        const metadata = await book.loaded.metadata.catch(() => null)

        if (disposed || !viewportRef.current) {
          book.destroy()
          return
        }

        setResolvedTitle(metadata?.title?.trim() || title)

        const rendition = book.renderTo(viewportRef.current, {
          width: '100%',
          height: '100%',
          flow: settings.layout === 'paged' ? 'paginated' : 'scrolled-doc',
          manager: settings.layout === 'paged' ? 'default' : 'continuous',
          spread: 'none',
          minSpreadWidth: 0,
        })
        renditionRef.current = rendition

        rendition.themes.default({
          body: {
            background: '#fff',
            color: '#000',
            'font-family':
              "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif",
            'line-height': '1.8',
            margin: '0 auto',
            'max-width': '72ch',
            padding: '1.6rem 1.4rem 3rem',
          },
          p: {
            'font-size': '1.04rem',
            margin: '0 0 1.1em',
          },
          h1: {
            color: '#000',
            'font-size': '2rem',
            'line-height': '1.14',
            margin: '0 0 1rem',
          },
          h2: {
            color: '#000',
            'font-size': '1.5rem',
            'line-height': '1.18',
            margin: '0 0 0.9rem',
          },
          h3: {
            color: '#000',
            'font-size': '1.24rem',
            'line-height': '1.24',
            margin: '0 0 0.8rem',
          },
          img: {
            'max-width': '100%',
            height: 'auto',
          },
          a: {
            color: '#000',
            'text-decoration': 'underline',
            'text-decoration-thickness': '0.08em',
            'text-underline-offset': '0.16em',
          },
          blockquote: {
            borderLeft: '2px solid #000',
            color: '#000',
            margin: '0 0 1.4rem',
            paddingLeft: '1rem',
          },
        })
        rendition.themes.fontSize(`${fontSizeRef.current}%`)

        rendition.on('relocated', (location: EpubLocation) => {
          const locationCfi = location?.start?.cfi

          if (!locationCfi || !bookRef.current) {
            return
          }

          const percentage = clampPercent(
            bookRef.current.locations.percentageFromCfi(locationCfi) * 100,
          )

          setAtStart(Boolean(location.atStart))
          setAtEnd(Boolean(location.atEnd))
          setVisibleProgress((previousProgress) =>
            previousProgress === percentage ? previousProgress : percentage,
          )
        })

        const startLocation =
          clampPercent(initialProgress) > 0
            ? book.locations.cfiFromPercentage(clampPercent(initialProgress) / 100)
            : undefined

        await rendition.display(startLocation)

        if (!disposed) {
          setLoading(false)
        }
      } catch (loadError) {
        if (!disposed) {
          const message =
            loadError instanceof Error ? loadError.message : 'Failed to read this EPUB file.'
          setError(message)
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      disposed = true
      renditionRef.current?.destroy()
      renditionRef.current = null
      bookRef.current?.destroy()
      bookRef.current = null
    }
  }, [fileUrl, initialProgress, settings.layout, title])

  useEffect(() => {
    fontSizeRef.current = settings.fontSize
    renditionRef.current?.themes.fontSize(`${settings.fontSize}%`)
  }, [settings.fontSize])

  useEffect(() => {
    if (loading || error) {
      return
    }

    const bookmarkCopy = buildPercentBookmarkCopy(visibleProgress, 'Book')

    onProgressChange?.({
      page: visibleProgress,
      totalPages: 100,
      locationType: 'percent',
      progressLabel: bookmarkCopy.progressLabel,
      cueLabel: bookmarkCopy.cueLabel,
    })
  }, [error, loading, onProgressChange, visibleProgress])

  const bookmarkCopy = buildPercentBookmarkCopy(visibleProgress, 'Book')

  return (
    <article className="epub-reader">
      <div className="epub-reader__toolbar">
        <div>
          <strong>Live EPUB reader</strong>
          <p>Responsive book reading with saved progress and adjustable text size.</p>
        </div>
        <div className="epub-reader__toolbar-actions">
          {!loading && !error && (
            <span className="epub-reader__progress-label">{bookmarkCopy.progressLabel}</span>
          )}
          <ReaderSettingsControl
            fileUrl={fileUrl}
            format="epub"
            onSettingsChange={onSettingsChange}
            settings={settings}
          />
          {toolbarAccessory}
        </div>
      </div>

      {loading && <div className="cbz-viewer__state">Loading book from {resolvedTitle}...</div>}
      {error && <div className="cbz-viewer__state cbz-viewer__state--error">{error}</div>}

      {!error && (
        <div
          className={`epub-reader__viewport ${
            settings.layout === 'paged' ? 'epub-reader__viewport--paged' : ''
          } ${loading ? 'is-loading' : ''}`}
        >
          {settings.layout === 'paged' ? (
            <PagedReaderSurface
              canNext={!atEnd}
              canPrevious={!atStart}
              direction="ltr"
              onNext={() => {
                void renditionRef.current?.next()
              }}
              onPrevious={() => {
                void renditionRef.current?.prev()
              }}
            >
              <div className="epub-reader__rendition" ref={viewportRef} />
            </PagedReaderSurface>
          ) : (
            <div className="epub-reader__rendition" ref={viewportRef} />
          )}
        </div>
      )}
    </article>
  )
}

export function CbzReader({
  entryId,
  fileUrl,
  title,
  offlinePages,
  initialPage = 1,
  onProgressChange,
  onSettingsChange,
  settings,
  toolbarAccessory,
}: CbzReaderProps) {
  const [pages, setPages] = useState<CbzPage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [visiblePage, setVisiblePage] = useState(initialPage)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const groupRefs = useRef<Array<HTMLDivElement | null>>([])
  const didInitialScrollRef = useRef(false)
  const offlinePageSignature = offlinePages
    ? offlinePages.map((page) => `${page.archiveIndex}:${page.url}`).join('|')
    : ''

  useEffect(() => {
    let disposed = false

    const load = async () => {
      setLoading(true)
      setError(null)
      setPages([])
      setVisiblePage(initialPage)
      didInitialScrollRef.current = false

      try {
        if (offlinePages?.length) {
          const pageSources = offlinePages
            .filter((page) => imagePattern.test(page.name))
            .map((page, index) => ({
              archiveIndex: Number.isFinite(page.archiveIndex) ? page.archiveIndex : index,
              name: page.name,
              url: page.url,
            }))

          if (!pageSources.length) {
            throw new Error('No downloaded image pages found for this chapter.')
          }

          if (disposed) {
            return
          }

          setPages(pageSources)
          setVisiblePage(clampPage(initialPage, pageSources.length))
          return
        }

        const response = await fetch(
          `/api/media/cbz/${encodeURIComponent(entryId)}/manifest?refresh=${Date.now()}`,
          {
            cache: 'no-store',
            credentials: 'same-origin',
          },
        )

        if (!response.ok) {
          const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(errorPayload?.error || `Failed to load CBZ manifest (${response.status})`)
        }

        const manifest = (await response.json()) as CbzManifestResponse

        if (!manifest.pages.length) {
          throw new Error('No readable image pages found in this CBZ file.')
        }

        const pageSources = manifest.pages
          .filter((page) => imagePattern.test(page.name))
          .map((page, index) => ({
            archiveIndex: Number.isFinite(page.archiveIndex) ? page.archiveIndex : index,
            name: page.name,
            url: page.url,
          }))

        if (disposed) {
          return
        }

        setPages(pageSources)
        setVisiblePage(clampPage(initialPage, pageSources.length))
      } catch (loadError) {
        if (!disposed) {
          const message =
            loadError instanceof Error ? loadError.message : 'Failed to read this CBZ file.'
          setError(message)
        }
      } finally {
        if (!disposed) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      disposed = true
    }
  }, [entryId, fileUrl, initialPage, offlinePageSignature, offlinePages])

  const orderedPages = useMemo(
    () => orderCbzPages(pages, settings.pageOrder),
    [pages, settings.pageOrder],
  )
  const effectiveViewMode = settings.layout === 'paged' ? settings.viewMode : 'single'

  const groups = useMemo(
    () => buildCbzGroups(
      orderedPages,
      effectiveViewMode,
      settings.direction,
      settings.spreadAlignment,
    ),
    [
      effectiveViewMode,
      orderedPages,
      settings.direction,
      settings.spreadAlignment,
    ],
  )

  useEffect(() => {
    didInitialScrollRef.current = false
  }, [effectiveViewMode, initialPage, settings.layout])

  useEffect(() => {
    if (
      settings.layout !== 'continuous' ||
      loading ||
      error ||
      groups.length === 0 ||
      !viewportRef.current
    ) {
      return
    }

    const viewport = viewportRef.current
    const initialGroupIndex = Math.max(
      groups.findIndex(
        (group) => clampPage(initialPage, pages.length) >= group.startPage &&
          clampPage(initialPage, pages.length) <= group.endPage,
      ),
      0,
    )
    let frame = 0
    let correctionFrame = 0
    let timeout = 0

    if (didInitialScrollRef.current) {
      return
    }

    const scrollToInitialGroup = () => {
      const targetElement = groupRefs.current[initialGroupIndex]

      if (!targetElement) {
        return
      }

      viewport.scrollTop = Math.max(targetElement.offsetTop - 12, 0)
    }
    
    frame = requestAnimationFrame(() => {
      scrollToInitialGroup()
      correctionFrame = requestAnimationFrame(scrollToInitialGroup)
      timeout = window.setTimeout(scrollToInitialGroup, 160)
      didInitialScrollRef.current = true
    })

    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(correctionFrame)
      window.clearTimeout(timeout)
    }
  }, [error, groups, initialPage, loading, pages.length, settings.layout])

  useEffect(() => {
    const viewport = viewportRef.current

    if (
      settings.layout !== 'continuous' ||
      !viewport ||
      loading ||
      error ||
      groups.length === 0
    ) {
      return
    }

    let frame = 0

    const updateVisiblePage = () => {
      const nextVisiblePage = getClosestPageByViewportCenter(
        viewport,
        groupRefs.current,
        (index) => groups[index].startPage,
      )

      setVisiblePage((previousPage) =>
        previousPage === nextVisiblePage ? previousPage : nextVisiblePage,
      )
    }

    const handleScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateVisiblePage)
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    updateVisiblePage()

    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', handleScroll)
    }
  }, [error, groups, loading, settings.layout])

  useEffect(() => {
    if (!loading && !error && pages.length > 0) {
      onProgressChange?.({
        page: visiblePage,
        totalPages: pages.length,
        endPage: groups.find((group) => group.startPage === visiblePage)?.endPage ?? visiblePage,
        viewMode: effectiveViewMode,
      })
    }
  }, [
    effectiveViewMode,
    error,
    groups,
    loading,
    onProgressChange,
    pages.length,
    visiblePage,
  ])

  const activeGroupIndex = Math.max(
    groups.findIndex(
      (group) => visiblePage >= group.startPage && visiblePage <= group.endPage,
    ),
    0,
  )
  const activeGroup = groups[activeGroupIndex] ?? null
  const pageIndicatorLabel =
    effectiveViewMode === 'spread' && activeGroup && activeGroup.endPage > activeGroup.startPage
      ? `Pages ${activeGroup.startPage}-${activeGroup.endPage} of ${orderedPages.length}`
      : `Page ${visiblePage} of ${orderedPages.length}`
  const cbzPageKey = [
    activeGroup?.id ?? 'loading',
    effectiveViewMode,
    settings.direction,
    settings.spreadAlignment,
  ].join(':')
  const captureCbzViewportCenter = useCenteredPagedViewport({
    fitMode: settings.layout === 'paged' ? settings.fitMode : 'fit-width',
    pageKey: cbzPageKey,
    viewportRef,
    zoom: settings.zoom,
  })
  const handleCbzSettingsChange = useCallback(
    (nextSettings: ReaderSettings) => {
      if (nextSettings.layout === 'paged' && nextSettings.fitMode === 'manual') {
        captureCbzViewportCenter()
      }
      onSettingsChange(nextSettings)
    },
    [captureCbzViewportCenter, onSettingsChange],
  )
  const getSheetWidth = (baseWidth: number) => {
    if (settings.fitMode === 'fit-page') {
      return '100%'
    }

    if (settings.fitMode === 'fit-width') {
      return '100%'
    }

    return `${Math.round((baseWidth * settings.zoom) / 100)}px`
  }

  const moveGroup = (offset: number) => {
    const nextGroup = groups[Math.min(Math.max(activeGroupIndex + offset, 0), groups.length - 1)]
    if (nextGroup) {
      setVisiblePage(nextGroup.startPage)
    }
  }

  useEffect(() => {
    if (settings.layout !== 'paged' || !activeGroup) {
      return
    }

    const nearbyGroups = groups.slice(
      Math.max(activeGroupIndex - 1, 0),
      Math.min(activeGroupIndex + 2, groups.length),
    )

    nearbyGroups.flatMap((group) => group.pages).forEach((page) => {
      const image = new Image()
      image.decoding = 'async'
      image.src = page.url
      void image.decode?.().catch(() => undefined)
    })
  }, [activeGroup, activeGroupIndex, groups, settings.layout])

  const renderCbzGroup = (group: CbzGroup, index: number, paged: boolean) => {
    const isSinglePageGroup = group.pages.length === 1 && effectiveViewMode === 'single'
    const isSpreadPair = group.pages.length > 1
    const isSpreadSoloGroup = group.pages.length === 1 && effectiveViewMode === 'spread'
    const sheetClassName = [
      'cbz-page__sheet',
      isSpreadPair ? 'cbz-page__sheet--spread' : '',
      isSpreadSoloGroup ? 'cbz-page__sheet--spread-solo' : '',
      paged ? 'cbz-page__sheet--paged' : '',
      paged ? `cbz-page__sheet--${settings.fitMode}` : '',
    ]
      .filter(Boolean)
      .join(' ')
    const sheetStyle:
      | (CSSProperties &
          Partial<
            Record<
              '--cbz-single-page-width' | '--cbz-spread-width' | '--cbz-spread-solo-width',
              string
            >
          >)
      | undefined =
      isSinglePageGroup
        ? { '--cbz-single-page-width': getSheetWidth(cbzSinglePageBaseWidth) }
        : isSpreadPair
          ? { '--cbz-spread-width': getSheetWidth(cbzSpreadBaseWidth) }
          : isSpreadSoloGroup
            ? { '--cbz-spread-solo-width': getSheetWidth(cbzSpreadSoloBaseWidth) }
            : undefined
    const groupDistanceFromVisiblePage =
      visiblePage < group.startPage
        ? group.startPage - visiblePage
        : visiblePage > group.endPage
          ? visiblePage - group.endPage
          : 0
    const shouldEagerLoadGroup =
      paged || groupDistanceFromVisiblePage <= (effectiveViewMode === 'spread' ? 8 : 12)

    return (
      <div
        className={paged ? 'cbz-page cbz-page--paged' : 'cbz-page'}
        key={`${fileUrl}-${group.id}-${effectiveViewMode}-${settings.layout}`}
        ref={(element) => {
          groupRefs.current[index] = element
        }}
        data-page={group.startPage}
      >
        <figure
          className={
            group.pages.length > 1
              ? 'cbz-page__figure cbz-page__figure--spread'
              : 'cbz-page__figure'
          }
        >
          <div className={sheetClassName} style={sheetStyle}>
            {group.pages.map((page) => {
              const panelClassName = [
                'cbz-page__panel',
                group.pages.length === 1 ? 'cbz-page__panel--single' : '',
                group.pages.length > 1 ? 'cbz-page__panel--spread' : '',
                page.slot === 'left' ? 'cbz-page__panel--left' : '',
                page.slot === 'right' ? 'cbz-page__panel--right' : '',
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <div className={panelClassName} key={page.url}>
                  <img
                    alt={`${title} page ${page.logicalPage}`}
                    decoding="async"
                    loading={shouldEagerLoadGroup ? 'eager' : 'lazy'}
                    src={page.url}
                  />
                </div>
              )
            })}
          </div>
        </figure>
      </div>
    )
  }

  return (
    <article className="cbz-viewer">
      <div className="cbz-viewer__toolbar">
        <div>
          <strong>Live CBZ reader</strong>
          <p>Choose a reading style, then move through fitted pages or a continuous strip.</p>
        </div>
        <div className="cbz-viewer__toolbar-actions">
          {!loading && !error && (
            <span className="cbz-viewer__page-indicator">{pageIndicatorLabel}</span>
          )}
          <div className="cbz-viewer__toolbar-right">
            <ReaderSettingsControl
              fileUrl={fileUrl}
              format="cbz"
              onSettingsChange={handleCbzSettingsChange}
              settings={settings}
            />
            {toolbarAccessory}
          </div>
        </div>
      </div>
      {loading && <div className="cbz-viewer__state">Loading pages from {title}...</div>}
      {error && <div className="cbz-viewer__state cbz-viewer__state--error">{error}</div>}

      {!loading && !error && settings.layout === 'paged' && activeGroup && (
        <div
          className={`cbz-viewer__viewport cbz-viewer__viewport--paged cbz-viewer__viewport--${settings.fitMode}`}
          ref={viewportRef}
        >
          <PagedReaderSurface
            canNext={activeGroupIndex < groups.length - 1}
            canPrevious={activeGroupIndex > 0}
            direction={settings.direction}
            onNext={() => moveGroup(1)}
            onPrevious={() => moveGroup(-1)}
            swipeEnabled={settings.fitMode !== 'manual'}
          >
            <div className="cbz-viewer__pages cbz-viewer__pages--paged">
              {renderCbzGroup(activeGroup, activeGroupIndex, true)}
            </div>
          </PagedReaderSurface>
        </div>
      )}

      {!loading && !error && settings.layout === 'continuous' && (
        <div className="cbz-viewer__viewport cbz-viewer__viewport--continuous" ref={viewportRef}>
          <div className="cbz-viewer__pages">
            {groups.map((group, index) => renderCbzGroup(group, index, false))}
          </div>
        </div>
      )}
    </article>
  )
}

export function HtmlChapterReader({
  fileUrl,
  title,
  initialProgress = 0,
  onProgressChange,
  onSettingsChange,
  settings,
  toolbarAccessory,
}: HtmlChapterReaderProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const didInitialScrollRef = useRef(false)
  const [chapterHtml, setChapterHtml] = useState('')
  const [resolvedTitle, setResolvedTitle] = useState(title)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visibleProgress, setVisibleProgress] = useState(clampPercent(initialProgress))
  const [visibleTextPage, setVisibleTextPage] = useState(1)
  const [textPageCount, setTextPageCount] = useState(1)

  useEffect(() => {
    let disposed = false

    setLoading(true)
    setError(null)
    setChapterHtml('')
    setResolvedTitle(title)
    setVisibleProgress(clampPercent(initialProgress))
    didInitialScrollRef.current = false

    const load = async () => {
      try {
        const response = await fetch(fileUrl)

        if (!response.ok) {
          throw new Error(`Failed to load chapter (${response.status})`)
        }

        const rawHtml = await response.text()
        const parsedDocument = new DOMParser().parseFromString(rawHtml, 'text/html')
        const chapterRoot =
          parsedDocument.querySelector('main.chapter, main, article, body')

        if (!chapterRoot) {
          throw new Error('No readable chapter content found in this HTML file.')
        }

        const nextTitle =
          parsedDocument.querySelector('title')?.textContent?.trim() ||
          chapterRoot.querySelector('h1')?.textContent?.trim() ||
          title

        if (disposed) {
          return
        }

        setResolvedTitle(nextTitle)
        setChapterHtml(chapterRoot.innerHTML.trim())
      } catch (loadError) {
        if (!disposed) {
          const message =
            loadError instanceof Error
              ? loadError.message
              : 'Failed to read this HTML chapter.'
          setError(message)
        }
      } finally {
        if (!disposed) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      disposed = true
    }
  }, [fileUrl, initialProgress, title])

  useEffect(() => {
    didInitialScrollRef.current = false
  }, [settings.fontSize, settings.layout])

  useEffect(() => {
    if (loading || error || !chapterHtml || !viewportRef.current) {
      return
    }

    if (didInitialScrollRef.current) {
      return
    }

    const viewport = viewportRef.current
    const safeProgress = clampPercent(initialProgress)
    let frame = 0
    let correctionFrame = 0
    let timeout = 0

    const scrollToInitialProgress = () => {
      const maxScroll =
        settings.layout === 'paged'
          ? Math.max(viewport.scrollWidth - viewport.clientWidth, 0)
          : Math.max(viewport.scrollHeight - viewport.clientHeight, 0)

      if (settings.layout === 'paged') {
        viewport.scrollLeft = Math.round((maxScroll * safeProgress) / 100)
      } else {
        viewport.scrollTop = Math.round((maxScroll * safeProgress) / 100)
      }
    }

    frame = requestAnimationFrame(() => {
      scrollToInitialProgress()
      correctionFrame = requestAnimationFrame(scrollToInitialProgress)
      timeout = window.setTimeout(scrollToInitialProgress, 160)
      didInitialScrollRef.current = true
    })

    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(correctionFrame)
      window.clearTimeout(timeout)
    }
  }, [
    chapterHtml,
    error,
    initialProgress,
    loading,
    settings.fontSize,
    settings.layout,
  ])

  useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport || loading || error || !chapterHtml) {
      return
    }

    let frame = 0

    const updateVisibleProgress = () => {
      const paged = settings.layout === 'paged'
      const maxScroll = paged
        ? Math.max(viewport.scrollWidth - viewport.clientWidth, 0)
        : Math.max(viewport.scrollHeight - viewport.clientHeight, 0)
      const nextProgress =
        maxScroll === 0
          ? 0
          : clampPercent(
              ((paged ? viewport.scrollLeft : viewport.scrollTop) / maxScroll) * 100,
            )

      if (paged) {
        const nextPageCount = Math.max(1, Math.round(viewport.scrollWidth / viewport.clientWidth))
        const nextPage = Math.min(
          Math.round(viewport.scrollLeft / Math.max(viewport.clientWidth, 1)) + 1,
          nextPageCount,
        )
        setTextPageCount(nextPageCount)
        setVisibleTextPage(nextPage)
      } else {
        setTextPageCount(1)
        setVisibleTextPage(1)
      }

      setVisibleProgress((previousProgress) =>
        previousProgress === nextProgress ? previousProgress : nextProgress,
      )
    }

    const handleScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateVisibleProgress)
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => handleScroll())
    resizeObserver?.observe(viewport)
    if (viewport.firstElementChild) {
      resizeObserver?.observe(viewport.firstElementChild)
    }
    updateVisibleProgress()

    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', handleScroll)
      resizeObserver?.disconnect()
    }
  }, [chapterHtml, error, loading, settings.fontSize, settings.layout])

  useEffect(() => {
    if (loading || error || !chapterHtml) {
      return
    }

    const bookmarkCopy = buildHtmlBookmarkCopy(visibleProgress)

    onProgressChange?.({
      page: visibleProgress,
      totalPages: 100,
      locationType: 'percent',
      progressLabel: bookmarkCopy.progressLabel,
      cueLabel: bookmarkCopy.cueLabel,
    })
  }, [chapterHtml, error, loading, onProgressChange, visibleProgress])

  const bookmarkCopy = buildHtmlBookmarkCopy(visibleProgress)
  const moveTextPage = (offset: number) => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const nextPage = Math.min(Math.max(visibleTextPage + offset, 1), textPageCount)
    viewport.scrollLeft = (nextPage - 1) * viewport.clientWidth
    setVisibleTextPage(nextPage)
  }
  const textProgressLabel =
    settings.layout === 'paged'
      ? `Page ${visibleTextPage} of ${textPageCount} · ${bookmarkCopy.progressLabel}`
      : bookmarkCopy.progressLabel

  return (
    <article className="html-reader">
      <div className="html-reader__toolbar">
        <div>
          <strong>Responsive HTML reader</strong>
          <p>Scroll the chapter directly here and bookmark your reading position for a clean mobile resume.</p>
        </div>
        <div className="html-reader__toolbar-actions">
          {!loading && !error && (
            <span className="html-reader__progress-label">{textProgressLabel}</span>
          )}
          <ReaderSettingsControl
            fileUrl={fileUrl}
            format="html"
            onSettingsChange={onSettingsChange}
            settings={settings}
          />
          {toolbarAccessory}
        </div>
      </div>

      {loading && <div className="cbz-viewer__state">Loading chapter from {resolvedTitle}...</div>}
      {error && <div className="cbz-viewer__state cbz-viewer__state--error">{error}</div>}

      {!loading && !error && settings.layout === 'paged' && (
        <PagedReaderSurface
          canNext={visibleTextPage < textPageCount}
          canPrevious={visibleTextPage > 1}
          direction="ltr"
          onNext={() => moveTextPage(1)}
          onPrevious={() => moveTextPage(-1)}
        >
          <div className="html-reader__viewport html-reader__viewport--paged" ref={viewportRef}>
            <article
              className="html-reader__content html-reader__content--paged"
              style={{ '--reader-font-scale': settings.fontSize / 100 } as CSSProperties}
            >
              <div dangerouslySetInnerHTML={{ __html: chapterHtml }} />
            </article>
          </div>
        </PagedReaderSurface>
      )}

      {!loading && !error && settings.layout === 'continuous' && (
        <div className="html-reader__viewport" ref={viewportRef}>
          <article
            className="html-reader__content"
            style={{ '--reader-font-scale': settings.fontSize / 100 } as CSSProperties}
          >
            <div dangerouslySetInnerHTML={{ __html: chapterHtml }} />
          </article>
        </div>
      )}
    </article>
  )
}

export function TextFileReader({
  fileUrl,
  title,
  format,
  initialProgress = 0,
  onProgressChange,
  onSettingsChange,
  settings,
  toolbarAccessory,
}: TextFileReaderProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const didInitialScrollRef = useRef(false)
  const [documentHtml, setDocumentHtml] = useState('')
  const [resolvedTitle, setResolvedTitle] = useState(title)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visibleProgress, setVisibleProgress] = useState(clampPercent(initialProgress))
  const [visibleTextPage, setVisibleTextPage] = useState(1)
  const [textPageCount, setTextPageCount] = useState(1)

  useEffect(() => {
    let disposed = false

    setLoading(true)
    setError(null)
    setDocumentHtml('')
    setResolvedTitle(title)
    setVisibleProgress(clampPercent(initialProgress))
    didInitialScrollRef.current = false

    const load = async () => {
      try {
        const response = await fetch(fileUrl)

        if (!response.ok) {
          throw new Error(`Failed to load document (${response.status})`)
        }

        const rawText = await response.text()
        const nextTitle = resolveTextDocumentTitle(rawText, title, format)
        const nextHtml = format === 'md' ? markdownToHtml(rawText) : plainTextToHtml(rawText)

        if (disposed) {
          return
        }

        setResolvedTitle(nextTitle)
        setDocumentHtml(nextHtml)
      } catch (loadError) {
        if (!disposed) {
          const message =
            loadError instanceof Error
              ? loadError.message
              : 'Failed to read this document.'
          setError(message)
        }
      } finally {
        if (!disposed) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      disposed = true
    }
  }, [fileUrl, format, initialProgress, title])

  useEffect(() => {
    didInitialScrollRef.current = false
  }, [settings.fontSize, settings.layout])

  useEffect(() => {
    if (loading || error || !documentHtml || !viewportRef.current) {
      return
    }

    if (didInitialScrollRef.current) {
      return
    }

    const viewport = viewportRef.current
    const safeProgress = clampPercent(initialProgress)
    let frame = 0
    let correctionFrame = 0
    let timeout = 0

    const scrollToInitialProgress = () => {
      const maxScroll =
        settings.layout === 'paged'
          ? Math.max(viewport.scrollWidth - viewport.clientWidth, 0)
          : Math.max(viewport.scrollHeight - viewport.clientHeight, 0)

      if (settings.layout === 'paged') {
        viewport.scrollLeft = Math.round((maxScroll * safeProgress) / 100)
      } else {
        viewport.scrollTop = Math.round((maxScroll * safeProgress) / 100)
      }
    }

    frame = requestAnimationFrame(() => {
      scrollToInitialProgress()
      correctionFrame = requestAnimationFrame(scrollToInitialProgress)
      timeout = window.setTimeout(scrollToInitialProgress, 160)
      didInitialScrollRef.current = true
    })

    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(correctionFrame)
      window.clearTimeout(timeout)
    }
  }, [
    documentHtml,
    error,
    initialProgress,
    loading,
    settings.fontSize,
    settings.layout,
  ])

  useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport || loading || error || !documentHtml) {
      return
    }

    let frame = 0

    const updateVisibleProgress = () => {
      const paged = settings.layout === 'paged'
      const maxScroll = paged
        ? Math.max(viewport.scrollWidth - viewport.clientWidth, 0)
        : Math.max(viewport.scrollHeight - viewport.clientHeight, 0)
      const nextProgress =
        maxScroll === 0
          ? 0
          : clampPercent(
              ((paged ? viewport.scrollLeft : viewport.scrollTop) / maxScroll) * 100,
            )

      if (paged) {
        const nextPageCount = Math.max(1, Math.round(viewport.scrollWidth / viewport.clientWidth))
        const nextPage = Math.min(
          Math.round(viewport.scrollLeft / Math.max(viewport.clientWidth, 1)) + 1,
          nextPageCount,
        )
        setTextPageCount(nextPageCount)
        setVisibleTextPage(nextPage)
      } else {
        setTextPageCount(1)
        setVisibleTextPage(1)
      }

      setVisibleProgress((previousProgress) =>
        previousProgress === nextProgress ? previousProgress : nextProgress,
      )
    }

    const handleScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateVisibleProgress)
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => handleScroll())
    resizeObserver?.observe(viewport)
    if (viewport.firstElementChild) {
      resizeObserver?.observe(viewport.firstElementChild)
    }
    updateVisibleProgress()

    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', handleScroll)
      resizeObserver?.disconnect()
    }
  }, [documentHtml, error, loading, settings.fontSize, settings.layout])

  useEffect(() => {
    if (loading || error || !documentHtml) {
      return
    }

    const bookmarkCopy = buildTextBookmarkCopy(visibleProgress)

    onProgressChange?.({
      page: visibleProgress,
      totalPages: 100,
      locationType: 'percent',
      progressLabel: bookmarkCopy.progressLabel,
      cueLabel: bookmarkCopy.cueLabel,
    })
  }, [documentHtml, error, loading, onProgressChange, visibleProgress])

  const bookmarkCopy = buildTextBookmarkCopy(visibleProgress)
  const readerLabel = format === 'md' ? 'Markdown reader' : 'Text reader'
  const moveTextPage = (offset: number) => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const nextPage = Math.min(Math.max(visibleTextPage + offset, 1), textPageCount)
    viewport.scrollLeft = (nextPage - 1) * viewport.clientWidth
    setVisibleTextPage(nextPage)
  }
  const textProgressLabel =
    settings.layout === 'paged'
      ? `Page ${visibleTextPage} of ${textPageCount} · ${bookmarkCopy.progressLabel}`
      : bookmarkCopy.progressLabel

  return (
    <article className="html-reader">
      <div className="html-reader__toolbar">
        <div>
          <strong>{readerLabel}</strong>
          <p>Scroll the document directly here and bookmark your reading position for a clean mobile resume.</p>
        </div>
        <div className="html-reader__toolbar-actions">
          {!loading && !error && (
            <span className="html-reader__progress-label">{textProgressLabel}</span>
          )}
          <ReaderSettingsControl
            fileUrl={fileUrl}
            format={format}
            onSettingsChange={onSettingsChange}
            settings={settings}
          />
          {toolbarAccessory}
        </div>
      </div>

      {loading && <div className="cbz-viewer__state">Loading document from {resolvedTitle}...</div>}
      {error && <div className="cbz-viewer__state cbz-viewer__state--error">{error}</div>}

      {!loading && !error && settings.layout === 'paged' && (
        <PagedReaderSurface
          canNext={visibleTextPage < textPageCount}
          canPrevious={visibleTextPage > 1}
          direction="ltr"
          onNext={() => moveTextPage(1)}
          onPrevious={() => moveTextPage(-1)}
        >
          <div className="html-reader__viewport html-reader__viewport--paged" ref={viewportRef}>
            <article
              className="html-reader__content html-reader__content--paged"
              style={{ '--reader-font-scale': settings.fontSize / 100 } as CSSProperties}
            >
              <div dangerouslySetInnerHTML={{ __html: documentHtml }} />
            </article>
          </div>
        </PagedReaderSurface>
      )}

      {!loading && !error && settings.layout === 'continuous' && (
        <div className="html-reader__viewport" ref={viewportRef}>
          <article
            className="html-reader__content"
            style={{ '--reader-font-scale': settings.fontSize / 100 } as CSSProperties}
          >
            <div dangerouslySetInnerHTML={{ __html: documentHtml }} />
          </article>
        </div>
      )}
    </article>
  )
}
