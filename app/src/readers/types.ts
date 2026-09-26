import type { EntryFormat, ReaderSettings, ReaderViewMode, SavedReadingPosition } from '../appTypes'
import type { TapLayout, TextStyle } from '../app/preferences'
import type { OfflinePage } from '../app/offlineLibrary'

/** Where the reader is, reported after every page turn or scroll. */
export type ReaderPosition = {
  /** Page number (1-based) for page formats, percentage (0–100) for text. */
  page: number
  totalPages: number
  endPage?: number
  locationType: 'page' | 'percent'
  viewMode?: ReaderViewMode
  /** Exact, format-specific location such as an EPUB CFI. */
  locator?: string
}

export type ReaderSource = {
  /** The file variant being read. */
  variantId: string
  format: EntryFormat
  fileUrl: string
  /** Page images of a downloaded comic archive. */
  offlinePages?: OfflinePage[] | null
  /** The file is stored on this device. */
  local: boolean
}

export type ReaderController = {
  /** Jumps to a page (page formats) or a percentage (text formats). */
  goTo: (target: number) => void
  next: () => void
  previous: () => void
  /** Opens a table-of-contents target (EPUB). */
  goToHref?: (href: string) => void
}

export type TocItem = {
  label: string
  href: string
  depth: number
}

export type ReaderContentProps = {
  source: ReaderSource
  title: string
  settings: ReaderSettings
  textStyle: TextStyle
  tapLayout: TapLayout
  initial: SavedReadingPosition | null
  onPosition: (position: ReaderPosition) => void
  onCenterTap: () => void
  /** Called when a page turn happens (to tuck the menus away). */
  onTurn?: () => void
  onNextEntry?: () => void
  onPreviousEntry?: () => void
  onReady?: (controller: ReaderController) => void
  onError?: (message: string) => void
  /** The book's own table of contents, when it has one. */
  onToc?: (items: TocItem[]) => void
}
