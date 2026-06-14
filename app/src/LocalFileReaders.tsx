import JSZip from 'jszip'
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
import { ExternalLink, Minus, Plus, Settings2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ReaderProgress, ReaderViewMode } from './appTypes'

const imagePattern = /\.(avif|gif|jpe?g|png|webp)$/i
const minReaderWidth = 280
const maxPdfCanvasWidth = 760
const maxPdfPixelRatio = 1.5
const maxTouchPdfPixelRatio = 1
const pdfNativeFallbackDelayMs = 6500
const pdfDesktopImmediateRenderRadius = 5
const pdfTouchImmediateRenderRadius = 6
const pdfDesktopPrefetchRenderRadius = 10
const pdfTouchPrefetchRenderRadius = 12
const pdfDesktopCachedPageLimit = 56
const pdfTouchCachedPageLimit = 72
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

type PdfEmbedProps = {
  fileUrl: string
  title: string
  initialPage?: number
  onProgressChange?: (progress: ReaderProgress) => void
  toolbarAccessory?: ReactNode
}

type CbzReaderProps = {
  fileUrl: string
  title: string
  initialPage?: number
  initialViewMode?: ReaderViewMode
  initialReadingDirection?: 'ltr' | 'rtl'
  initialPageOrderMode?: 'archive' | 'filename'
  initialSpreadAlignment?: 'cover-first' | 'straight-pairs'
  onProgressChange?: (progress: ReaderProgress) => void
  preferenceKey?: string
  toolbarAccessory?: ReactNode
}

type HtmlChapterReaderProps = {
  fileUrl: string
  title: string
  initialProgress?: number
  onProgressChange?: (progress: ReaderProgress) => void
  toolbarAccessory?: ReactNode
}

type TextFileReaderProps = {
  fileUrl: string
  title: string
  format: 'md' | 'txt'
  initialProgress?: number
  onProgressChange?: (progress: ReaderProgress) => void
  toolbarAccessory?: ReactNode
}

type EpubReaderProps = {
  fileUrl: string
  title: string
  initialProgress?: number
  onProgressChange?: (progress: ReaderProgress) => void
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

type CbzDisplayPage = {
  logicalPage: number
  slot: 'left' | 'right' | 'single'
  url: string
}

type CbzReadingDirection = 'ltr' | 'rtl'
type CbzPageOrderMode = 'archive' | 'filename'
type CbzSpreadAlignment = 'cover-first' | 'straight-pairs'

const naturalSort = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })

const clampPage = (page: number, totalPages: number) =>
  Math.min(Math.max(page, 1), Math.max(totalPages, 1))

const clampPercent = (value: number) => Math.min(Math.max(Math.round(value), 0), 100)
const clampZoom = (value: number) =>
  Math.min(Math.max(Math.round(value), minCbzZoom), maxCbzZoom)

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

const orderCbzPages = (pages: CbzPage[], pageOrderMode: CbzPageOrderMode) => {
  if (pageOrderMode === 'archive') {
    return [...pages].sort((left, right) => left.archiveIndex - right.archiveIndex)
  }

  return [...pages].sort((left, right) => naturalSort(left.name, right.name))
}

type PdfPageCanvasProps = {
  estimatedHeight: number
  pdfDocument: PDFDocumentProxy
  pageNumber: number
  targetWidth: number
  title: string
  onError: (message: string) => void
  onRendered?: () => void
  pixelRatioLimit: number
}

function PdfPageCanvas({
  estimatedHeight,
  pdfDocument,
  pageNumber,
  targetWidth,
  title,
  onError,
  onRendered,
  pixelRatioLimit,
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
        const scale = targetWidth / baseViewport.width
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

        const pixelRatio = Math.min(window.devicePixelRatio || 1, pixelRatioLimit)

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
  }, [estimatedHeight, onError, onRendered, pageNumber, pdfDocument, pixelRatioLimit, targetWidth])

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
    const updateWidth = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const nextWidth = Math.round(
          element.clientWidth || element.getBoundingClientRect().width || window.innerWidth,
        )

        setViewportWidth((previousWidth) => (
          previousWidth === nextWidth ? previousWidth : nextWidth
        ))
      })
    }

    updateWidth()
    timeout = window.setTimeout(updateWidth, 140)
    window.addEventListener('resize', updateWidth, { passive: true })
    window.addEventListener('orientationchange', updateWidth)

    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateWidth())
      observer.observe(element)
    }

    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
      window.removeEventListener('resize', updateWidth)
      window.removeEventListener('orientationchange', updateWidth)
      observer?.disconnect()
    }
  }, [error, loading, nativeFallback, pageCount])

  const handlePageRendered = useCallback(() => {
    setFirstPageReady(true)
  }, [])

  const targetWidth = useMemo(
    () => {
      const measuredViewportWidth =
        viewportWidth ||
        (typeof window === 'undefined'
          ? minReaderWidth + 48
          : Math.min(window.innerWidth, maxPdfCanvasWidth + 48))

      return Math.max(
        minReaderWidth,
        Math.min(Math.max(measuredViewportWidth - 48, minReaderWidth), maxPdfCanvasWidth),
      )
    },
    [viewportWidth],
  )

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
    if (loading || error || nativeFallback || pageCount === 0 || !viewportRef.current) {
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
  }, [error, initialPage, loading, nativeFallback, pageCount, targetWidth, viewportWidth])

  useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport || loading || error || nativeFallback || pageCount === 0) {
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
  }, [error, loading, nativeFallback, pageCount, targetWidth])

  useEffect(() => {
    if (!loading && !error && pageCount > 0) {
      onProgressChange?.({ page: visiblePage, totalPages: pageCount })
    }
  }, [error, loading, onProgressChange, pageCount, visiblePage])

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

  return (
    <article className="document-frame">
      <div className="document-frame__toolbar">
        <div>
          <strong>Live PDF reader</strong>
          <p>Scroll the document directly here and bookmark the page you want to resume from.</p>
        </div>
        <div className="document-frame__toolbar-actions">
          {!loading && !error && <span className="document-frame__page-label">Page {visiblePage} of {pageCount}</span>}
          {toolbarAccessory}
          <button
            className="ghost-button"
            onClick={() => window.open(fileUrl, '_blank', 'noopener,noreferrer')}
            type="button"
          >
            <ExternalLink aria-hidden="true" className="app-icon" strokeWidth={1.9} />
            Open original file
          </button>
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

      {!loading && !showNativePdf && documentProxy && (
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
  toolbarAccessory,
}: EpubReaderProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const bookRef = useRef<EpubBook | null>(null)
  const renditionRef = useRef<EpubRendition | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visibleProgress, setVisibleProgress] = useState(clampPercent(initialProgress))
  const [fontSize, setFontSize] = useState(100)
  const [resolvedTitle, setResolvedTitle] = useState(title)

  useEffect(() => {
    let disposed = false

    setLoading(true)
    setError(null)
    setVisibleProgress(clampPercent(initialProgress))
    setFontSize(100)
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
          flow: 'scrolled-doc',
          manager: 'continuous',
          spread: 'none',
          minSpreadWidth: 0,
        })
        renditionRef.current = rendition

        rendition.themes.default({
          body: {
            background: 'transparent',
            color: '#eef3fb',
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
            color: '#f6f8ff',
            'font-size': '2rem',
            'line-height': '1.14',
            margin: '0 0 1rem',
          },
          h2: {
            color: '#f6f8ff',
            'font-size': '1.5rem',
            'line-height': '1.18',
            margin: '0 0 0.9rem',
          },
          h3: {
            color: '#f6f8ff',
            'font-size': '1.24rem',
            'line-height': '1.24',
            margin: '0 0 0.8rem',
          },
          img: {
            'max-width': '100%',
            height: 'auto',
          },
          a: {
            color: '#8ee4ff',
          },
          blockquote: {
            borderLeft: '2px solid rgba(98, 217, 255, 0.4)',
            color: 'rgba(224, 233, 246, 0.86)',
            margin: '0 0 1.4rem',
            paddingLeft: '1rem',
          },
        })
        rendition.themes.fontSize('100%')

        rendition.on('relocated', (location: EpubLocation) => {
          const locationCfi = location?.start?.cfi

          if (!locationCfi || !bookRef.current) {
            return
          }

          const percentage = clampPercent(
            bookRef.current.locations.percentageFromCfi(locationCfi) * 100,
          )

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
  }, [fileUrl, initialProgress, title])

  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${fontSize}%`)
  }, [fontSize])

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
          <div className="epub-reader__font-control" aria-label="EPUB font size">
            <button
              aria-label="Decrease font size"
              className="cbz-viewer__zoom-button"
              disabled={fontSize <= 85}
              onClick={() => setFontSize((previousSize) => Math.max(previousSize - 10, 85))}
              type="button"
            >
              <Minus aria-hidden="true" className="app-icon" strokeWidth={1.9} />
            </button>
            <span className="epub-reader__font-value">{fontSize}%</span>
            <button
              aria-label="Increase font size"
              className="cbz-viewer__zoom-button"
              disabled={fontSize >= 150}
              onClick={() => setFontSize((previousSize) => Math.min(previousSize + 10, 150))}
              type="button"
            >
              <Plus aria-hidden="true" className="app-icon" strokeWidth={1.9} />
            </button>
          </div>
          {toolbarAccessory}
          <button
            className="ghost-button"
            onClick={() => window.open(fileUrl, '_blank', 'noopener,noreferrer')}
            type="button"
          >
            <ExternalLink aria-hidden="true" className="app-icon" strokeWidth={1.9} />
            Open original file
          </button>
        </div>
      </div>

      {loading && <div className="cbz-viewer__state">Loading book from {resolvedTitle}...</div>}
      {error && <div className="cbz-viewer__state cbz-viewer__state--error">{error}</div>}

      {!loading && !error && <div className="epub-reader__viewport" ref={viewportRef} />}
    </article>
  )
}

export function CbzReader({
  fileUrl,
  title,
  initialPage = 1,
  initialViewMode = 'single',
  initialReadingDirection = 'rtl',
  initialPageOrderMode = 'archive',
  initialSpreadAlignment = 'cover-first',
  onProgressChange,
  preferenceKey,
  toolbarAccessory,
}: CbzReaderProps) {
  const [pages, setPages] = useState<CbzPage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ReaderViewMode>(initialViewMode)
  const [readingDirection, setReadingDirection] =
    useState<CbzReadingDirection>(initialReadingDirection)
  const [pageOrderMode, setPageOrderMode] =
    useState<CbzPageOrderMode>(initialPageOrderMode)
  const [spreadAlignment, setSpreadAlignment] =
    useState<CbzSpreadAlignment>(initialSpreadAlignment)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [singlePageZoom, setSinglePageZoom] = useState(100)
  const [spreadZoom, setSpreadZoom] = useState(100)
  const [visiblePage, setVisiblePage] = useState(initialPage)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const groupRefs = useRef<Array<HTMLDivElement | null>>([])
  const didInitialScrollRef = useRef(false)
  const settingsStorageKey = preferenceKey ? `cbz-reader-settings:${preferenceKey}` : null

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    if (!settingsStorageKey) {
      setReadingDirection(initialReadingDirection)
      setPageOrderMode(initialPageOrderMode)
      setSpreadAlignment(initialSpreadAlignment)
      return
    }

    const savedSettings = window.localStorage.getItem(settingsStorageKey)

    if (!savedSettings) {
      setReadingDirection(initialReadingDirection)
      setPageOrderMode(initialPageOrderMode)
      setSpreadAlignment(initialSpreadAlignment)
      return
    }

    try {
      const parsedSettings = JSON.parse(savedSettings) as Partial<{
        readingDirection: CbzReadingDirection
        pageOrderMode: CbzPageOrderMode
        spreadAlignment: CbzSpreadAlignment
      }>

      setReadingDirection(parsedSettings.readingDirection ?? initialReadingDirection)
      setPageOrderMode(parsedSettings.pageOrderMode ?? initialPageOrderMode)
      setSpreadAlignment(parsedSettings.spreadAlignment ?? initialSpreadAlignment)
    } catch {
      setReadingDirection(initialReadingDirection)
      setPageOrderMode(initialPageOrderMode)
      setSpreadAlignment(initialSpreadAlignment)
    }
  }, [
    initialPageOrderMode,
    initialReadingDirection,
    initialSpreadAlignment,
    settingsStorageKey,
  ])

  useEffect(() => {
    if (typeof window === 'undefined' || !settingsStorageKey) {
      return
    }

    window.localStorage.setItem(
      settingsStorageKey,
      JSON.stringify({
        pageOrderMode,
        readingDirection,
        spreadAlignment,
      }),
    )
  }, [pageOrderMode, readingDirection, settingsStorageKey, spreadAlignment])

  useEffect(() => {
    setViewMode(initialViewMode)
  }, [fileUrl, initialViewMode])

  useEffect(() => {
    setSinglePageZoom(100)
    setSpreadZoom(100)
    setSettingsOpen(false)
  }, [fileUrl])

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

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [settingsOpen])

  useEffect(() => {
    let disposed = false
    let activeUrls: string[] = []

    const load = async () => {
      setLoading(true)
      setError(null)
      setPages([])
      setVisiblePage(initialPage)
      didInitialScrollRef.current = false

      try {
        const response = await fetch(fileUrl)

        if (!response.ok) {
          throw new Error(`Failed to load archive (${response.status})`)
        }

        const archive = await JSZip.loadAsync(await response.arrayBuffer())
        const imageFiles = Object.values(archive.files).filter(
          (entry) => !entry.dir && imagePattern.test(entry.name),
        )

        if (imageFiles.length === 0) {
          throw new Error('No readable image pages found in this CBZ file.')
        }

        const pageSources = await Promise.all(
          imageFiles.map(async (entry, archiveIndex) => {
            const blob = await entry.async('blob')
            return {
              archiveIndex,
              name: entry.name,
              url: URL.createObjectURL(blob),
            }
          }),
        )

        if (disposed) {
          pageSources.forEach((page) => URL.revokeObjectURL(page.url))
          return
        }

        activeUrls = pageSources.map((page) => page.url)
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
      activeUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [fileUrl, initialPage])

  const orderedPages = useMemo(
    () => orderCbzPages(pages, pageOrderMode),
    [pageOrderMode, pages],
  )

  const groups = useMemo(
    () => buildCbzGroups(orderedPages, viewMode, readingDirection, spreadAlignment),
    [orderedPages, readingDirection, spreadAlignment, viewMode],
  )

  useEffect(() => {
    didInitialScrollRef.current = false
  }, [initialPage, viewMode])

  useEffect(() => {
    if (loading || error || groups.length === 0 || !viewportRef.current) {
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
  }, [error, groups, initialPage, loading, pages.length])

  useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport || loading || error || groups.length === 0) {
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
  }, [error, groups, loading])

  useEffect(() => {
    if (!loading && !error && pages.length > 0) {
      onProgressChange?.({
        page: visiblePage,
        totalPages: pages.length,
        endPage: groups.find((group) => group.startPage === visiblePage)?.endPage ?? visiblePage,
        viewMode,
      })
    }
  }, [error, groups, loading, onProgressChange, pages.length, viewMode, visiblePage])

  const activeZoom = viewMode === 'spread' ? spreadZoom : singlePageZoom
  const activeGroup = groups.find(
    (group) => visiblePage >= group.startPage && visiblePage <= group.endPage,
  )
  const pageIndicatorLabel =
    viewMode === 'spread' && activeGroup && activeGroup.endPage > activeGroup.startPage
      ? `Pages ${activeGroup.startPage}-${activeGroup.endPage} of ${orderedPages.length}`
      : `Page ${visiblePage} of ${orderedPages.length}`
  const decreaseZoom = () => {
    if (viewMode === 'spread') {
      setSpreadZoom((previousZoom) => clampZoom(previousZoom - cbzZoomStep))
      return
    }

    setSinglePageZoom((previousZoom) => clampZoom(previousZoom - cbzZoomStep))
  }
  const increaseZoom = () => {
    if (viewMode === 'spread') {
      setSpreadZoom((previousZoom) => clampZoom(previousZoom + cbzZoomStep))
      return
    }

    setSinglePageZoom((previousZoom) => clampZoom(previousZoom + cbzZoomStep))
  }

  return (
    <article className="cbz-viewer">
      <div className="cbz-viewer__toolbar">
        <div>
          <strong>Live CBZ reader</strong>
          <p>Switch between single pages and spreads, then bookmark the page you want to return to.</p>
        </div>
        <div className="cbz-viewer__toolbar-actions">
          {!loading && !error && (
            <span className="cbz-viewer__page-indicator">{pageIndicatorLabel}</span>
          )}
          <div className="cbz-viewer__toolbar-right">
            <div className="cbz-viewer__settings">
              <button
                aria-controls="cbz-reader-settings-popover"
                aria-expanded={settingsOpen}
                aria-haspopup="dialog"
                className={`ghost-button ${settingsOpen ? 'is-active' : ''}`}
                onClick={() => setSettingsOpen((isOpen) => !isOpen)}
                type="button"
              >
                <Settings2 aria-hidden="true" className="app-icon" strokeWidth={1.9} />
                Reader settings
              </button>
            </div>
            <div className="cbz-viewer__mode-toggle" role="tablist" aria-label="Reading mode">
              <button
                aria-pressed={viewMode === 'single'}
                className={`cbz-viewer__mode-button ${viewMode === 'single' ? 'is-active' : ''}`}
                onClick={() => setViewMode('single')}
                type="button"
              >
                Single pages
              </button>
              <button
                aria-pressed={viewMode === 'spread'}
                className={`cbz-viewer__mode-button ${viewMode === 'spread' ? 'is-active' : ''}`}
                onClick={() => setViewMode('spread')}
                type="button"
              >
                Spreads
              </button>
            </div>
            <div className="cbz-viewer__zoom-control" aria-label="Reader zoom">
              <button
                aria-label="Zoom out"
                className="cbz-viewer__zoom-button"
                disabled={activeZoom <= minCbzZoom}
                onClick={decreaseZoom}
                type="button"
              >
                <Minus aria-hidden="true" className="app-icon" strokeWidth={1.9} />
              </button>
              <span className="cbz-viewer__zoom-value">{activeZoom}%</span>
              <button
                aria-label="Zoom in"
                className="cbz-viewer__zoom-button"
                disabled={activeZoom >= maxCbzZoom}
                onClick={increaseZoom}
                type="button"
              >
                <Plus aria-hidden="true" className="app-icon" strokeWidth={1.9} />
              </button>
            </div>
            {toolbarAccessory}
            <button
              className="ghost-button"
              onClick={() => window.open(fileUrl, '_blank', 'noopener,noreferrer')}
              type="button"
            >
              <ExternalLink aria-hidden="true" className="app-icon" strokeWidth={1.9} />
              Open original file
            </button>
          </div>
        </div>
      </div>

      {settingsOpen && (
        <div
          aria-label="Reader settings"
          className="cbz-viewer__settings-menu cbz-viewer__settings-menu--floating"
          id="cbz-reader-settings-popover"
          role="dialog"
        >
          <div className="cbz-viewer__settings-header">
            <span>Reader settings</span>
            <button
              aria-label="Close reader settings"
              className="cbz-viewer__settings-close"
              onClick={() => setSettingsOpen(false)}
              type="button"
            >
              <X aria-hidden="true" className="app-icon" strokeWidth={1.9} />
            </button>
          </div>
          <div className="cbz-viewer__settings-group">
            <span className="cbz-viewer__settings-label">Reading direction</span>
            <div className="cbz-viewer__mode-toggle" role="tablist" aria-label="Reading direction">
              <button
                aria-pressed={readingDirection === 'rtl'}
                className={`cbz-viewer__mode-button ${readingDirection === 'rtl' ? 'is-active' : ''}`}
                onClick={() => setReadingDirection('rtl')}
                type="button"
              >
                RTL
              </button>
              <button
                aria-pressed={readingDirection === 'ltr'}
                className={`cbz-viewer__mode-button ${readingDirection === 'ltr' ? 'is-active' : ''}`}
                onClick={() => setReadingDirection('ltr')}
                type="button"
              >
                LTR
              </button>
            </div>
          </div>
          <div className="cbz-viewer__settings-group">
            <span className="cbz-viewer__settings-label">Page order</span>
            <div className="cbz-viewer__mode-toggle" role="tablist" aria-label="Page order">
              <button
                aria-pressed={pageOrderMode === 'archive'}
                className={`cbz-viewer__mode-button ${pageOrderMode === 'archive' ? 'is-active' : ''}`}
                onClick={() => setPageOrderMode('archive')}
                type="button"
              >
                Archive
              </button>
              <button
                aria-pressed={pageOrderMode === 'filename'}
                className={`cbz-viewer__mode-button ${pageOrderMode === 'filename' ? 'is-active' : ''}`}
                onClick={() => setPageOrderMode('filename')}
                type="button"
              >
                Filename
              </button>
            </div>
          </div>
          <div className="cbz-viewer__settings-group">
            <span className="cbz-viewer__settings-label">Spread alignment</span>
            <div className="cbz-viewer__mode-toggle" role="tablist" aria-label="Spread alignment">
              <button
                aria-pressed={spreadAlignment === 'cover-first'}
                className={`cbz-viewer__mode-button ${spreadAlignment === 'cover-first' ? 'is-active' : ''}`}
                onClick={() => setSpreadAlignment('cover-first')}
                type="button"
              >
                Cover first
              </button>
              <button
                aria-pressed={spreadAlignment === 'straight-pairs'}
                className={`cbz-viewer__mode-button ${spreadAlignment === 'straight-pairs' ? 'is-active' : ''}`}
                onClick={() => setSpreadAlignment('straight-pairs')}
                type="button"
              >
                Straight pairs
              </button>
            </div>
          </div>
        </div>
      )}

      {loading && <div className="cbz-viewer__state">Loading pages from {title}...</div>}
      {error && <div className="cbz-viewer__state cbz-viewer__state--error">{error}</div>}

      {!loading && !error && (
        <div className="cbz-viewer__viewport" ref={viewportRef}>
          <div className="cbz-viewer__pages">
            {groups.map((group, index) => {
              const isSinglePageGroup = group.pages.length === 1 && viewMode === 'single'
              const isSpreadPair = group.pages.length > 1
              const isSpreadSoloGroup = group.pages.length === 1 && viewMode === 'spread'
              const sheetClassName =
                isSpreadPair
                  ? 'cbz-page__sheet cbz-page__sheet--spread'
                  : isSpreadSoloGroup
                    ? 'cbz-page__sheet cbz-page__sheet--spread-solo'
                    : 'cbz-page__sheet'
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
                  ? {
                      '--cbz-single-page-width': `${Math.round((cbzSinglePageBaseWidth * singlePageZoom) / 100)}px`,
                    }
                  : isSpreadPair
                    ? {
                        '--cbz-spread-width': `${Math.round((cbzSpreadBaseWidth * spreadZoom) / 100)}px`,
                      }
                    : isSpreadSoloGroup
                      ? {
                          '--cbz-spread-solo-width': `${Math.round((cbzSpreadSoloBaseWidth * spreadZoom) / 100)}px`,
                        }
                      : undefined
              const groupDistanceFromVisiblePage =
                visiblePage < group.startPage
                  ? group.startPage - visiblePage
                  : visiblePage > group.endPage
                    ? visiblePage - group.endPage
                    : 0
              const shouldEagerLoadGroup =
                groupDistanceFromVisiblePage <= (viewMode === 'spread' ? 8 : 12)

              return (
                <div
                  className="cbz-page"
                  key={`${fileUrl}-${group.id}-${viewMode}`}
                  ref={(element) => {
                    groupRefs.current[index] = element
                  }}
                  data-page={group.startPage}
                >
                  <figure
                    className={
                      group.pages.length > 1 ? 'cbz-page__figure cbz-page__figure--spread' : 'cbz-page__figure'
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
            })}
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
  toolbarAccessory,
}: HtmlChapterReaderProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const didInitialScrollRef = useRef(false)
  const [chapterHtml, setChapterHtml] = useState('')
  const [resolvedTitle, setResolvedTitle] = useState(title)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visibleProgress, setVisibleProgress] = useState(clampPercent(initialProgress))

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
      const maxScroll = Math.max(viewport.scrollHeight - viewport.clientHeight, 0)
      viewport.scrollTop = Math.round((maxScroll * safeProgress) / 100)
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
  }, [chapterHtml, error, initialProgress, loading])

  useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport || loading || error || !chapterHtml) {
      return
    }

    let frame = 0

    const updateVisibleProgress = () => {
      const maxScroll = Math.max(viewport.scrollHeight - viewport.clientHeight, 0)
      const nextProgress =
        maxScroll === 0 ? 0 : clampPercent((viewport.scrollTop / maxScroll) * 100)

      setVisibleProgress((previousProgress) =>
        previousProgress === nextProgress ? previousProgress : nextProgress,
      )
    }

    const handleScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateVisibleProgress)
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    updateVisibleProgress()

    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', handleScroll)
    }
  }, [chapterHtml, error, loading])

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

  return (
    <article className="html-reader">
      <div className="html-reader__toolbar">
        <div>
          <strong>Responsive HTML reader</strong>
          <p>Scroll the chapter directly here and bookmark your reading position for a clean mobile resume.</p>
        </div>
        <div className="html-reader__toolbar-actions">
          {!loading && !error && (
            <span className="html-reader__progress-label">{bookmarkCopy.progressLabel}</span>
          )}
          {toolbarAccessory}
          <button
            className="ghost-button"
            onClick={() => window.open(fileUrl, '_blank', 'noopener,noreferrer')}
            type="button"
          >
            <ExternalLink aria-hidden="true" className="app-icon" strokeWidth={1.9} />
            Open original file
          </button>
        </div>
      </div>

      {loading && <div className="cbz-viewer__state">Loading chapter from {resolvedTitle}...</div>}
      {error && <div className="cbz-viewer__state cbz-viewer__state--error">{error}</div>}

      {!loading && !error && (
        <div className="html-reader__viewport" ref={viewportRef}>
          <article className="html-reader__content">
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
  toolbarAccessory,
}: TextFileReaderProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const didInitialScrollRef = useRef(false)
  const [documentHtml, setDocumentHtml] = useState('')
  const [resolvedTitle, setResolvedTitle] = useState(title)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visibleProgress, setVisibleProgress] = useState(clampPercent(initialProgress))

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
      const maxScroll = Math.max(viewport.scrollHeight - viewport.clientHeight, 0)
      viewport.scrollTop = Math.round((maxScroll * safeProgress) / 100)
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
  }, [documentHtml, error, initialProgress, loading])

  useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport || loading || error || !documentHtml) {
      return
    }

    let frame = 0

    const updateVisibleProgress = () => {
      const maxScroll = Math.max(viewport.scrollHeight - viewport.clientHeight, 0)
      const nextProgress =
        maxScroll === 0 ? 0 : clampPercent((viewport.scrollTop / maxScroll) * 100)

      setVisibleProgress((previousProgress) =>
        previousProgress === nextProgress ? previousProgress : nextProgress,
      )
    }

    const handleScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateVisibleProgress)
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    updateVisibleProgress()

    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', handleScroll)
    }
  }, [documentHtml, error, loading])

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

  return (
    <article className="html-reader">
      <div className="html-reader__toolbar">
        <div>
          <strong>{readerLabel}</strong>
          <p>Scroll the document directly here and bookmark your reading position for a clean mobile resume.</p>
        </div>
        <div className="html-reader__toolbar-actions">
          {!loading && !error && (
            <span className="html-reader__progress-label">{bookmarkCopy.progressLabel}</span>
          )}
          {toolbarAccessory}
          <button
            className="ghost-button"
            onClick={() => window.open(fileUrl, '_blank', 'noopener,noreferrer')}
            type="button"
          >
            <ExternalLink aria-hidden="true" className="app-icon" strokeWidth={1.9} />
            Open original file
          </button>
        </div>
      </div>

      {loading && <div className="cbz-viewer__state">Loading document from {resolvedTitle}...</div>}
      {error && <div className="cbz-viewer__state cbz-viewer__state--error">{error}</div>}

      {!loading && !error && (
        <div className="html-reader__viewport" ref={viewportRef}>
          <article className="html-reader__content">
            <div dangerouslySetInnerHTML={{ __html: documentHtml }} />
          </article>
        </div>
      )}
    </article>
  )
}
