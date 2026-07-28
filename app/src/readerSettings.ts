import type {
  CategoryId,
  EntryFormat,
  ReaderDirection,
  ReaderFitMode,
  ReaderLayoutMode,
  ReaderPageOrder,
  ReaderSettings,
  ReaderSpreadAlignment,
  ReaderViewMode,
  ReadingStyle,
} from './appTypes'

export const readingStyleLabels: Record<ReadingStyle, string> = {
  book: 'Book',
  manga: 'Manga',
  webtoon: 'Webtoon',
  text: 'Text',
}

const stylePresets: Record<ReadingStyle, ReaderSettings> = {
  book: {
    style: 'book',
    layout: 'paged',
    viewMode: 'single',
    direction: 'ltr',
    pageOrder: 'filename',
    spreadAlignment: 'cover-first',
    fitMode: 'fit-page',
    zoom: 100,
    fontSize: 100,
  },
  manga: {
    style: 'manga',
    layout: 'paged',
    viewMode: 'single',
    direction: 'rtl',
    pageOrder: 'archive',
    spreadAlignment: 'cover-first',
    fitMode: 'fit-page',
    zoom: 100,
    fontSize: 100,
  },
  webtoon: {
    style: 'webtoon',
    layout: 'continuous',
    viewMode: 'single',
    direction: 'ltr',
    pageOrder: 'filename',
    spreadAlignment: 'straight-pairs',
    fitMode: 'fit-width',
    zoom: 100,
    fontSize: 100,
  },
  text: {
    style: 'text',
    layout: 'continuous',
    viewMode: 'single',
    direction: 'ltr',
    pageOrder: 'filename',
    spreadAlignment: 'straight-pairs',
    fitMode: 'fit-width',
    zoom: 100,
    fontSize: 100,
  },
}

const imageFormats = new Set<EntryFormat>(['cbz', 'pdf'])
const textFormats = new Set<EntryFormat>(['epub', 'html', 'md', 'txt'])
const readingStyles = new Set<ReadingStyle>(['book', 'manga', 'webtoon', 'text'])
const layoutModes = new Set<ReaderLayoutMode>(['paged', 'continuous'])
const viewModes = new Set<ReaderViewMode>(['single', 'spread'])
const directions = new Set<ReaderDirection>(['ltr', 'rtl'])
const pageOrders = new Set<ReaderPageOrder>(['archive', 'filename'])
const spreadAlignments = new Set<ReaderSpreadAlignment>(['cover-first', 'straight-pairs'])
const fitModes = new Set<ReaderFitMode>(['fit-page', 'fit-width', 'manual'])

const enumValue = <T extends string>(value: unknown, values: Set<T>, fallback: T): T =>
  typeof value === 'string' && values.has(value as T) ? (value as T) : fallback

const boundedNumber = (value: unknown, minimum: number, maximum: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), minimum), maximum)
    : fallback

export const readerSettingsForStyle = (
  style: ReadingStyle,
  current?: Pick<ReaderSettings, 'fontSize'>,
): ReaderSettings => ({
  ...stylePresets[style],
  fontSize: current?.fontSize ?? stylePresets[style].fontSize,
})

export const compatibleReadingStyles = (format: EntryFormat): ReadingStyle[] => {
  if (imageFormats.has(format)) {
    return ['book', 'manga', 'webtoon']
  }

  if (textFormats.has(format)) {
    return ['text', 'book']
  }

  return ['book']
}

export const defaultReaderSettings = (
  category: CategoryId,
  format: EntryFormat,
): ReaderSettings => {
  if (textFormats.has(format)) {
    return readerSettingsForStyle(category === 'books' || category === 'magazines' ? 'book' : 'text')
  }

  if (category === 'manga') {
    return readerSettingsForStyle('manga')
  }

  return readerSettingsForStyle('book')
}

export const normalizeReaderSettings = (
  value: unknown,
  fallback: ReaderSettings,
): ReaderSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback
  }

  const candidate = value as Record<string, unknown>
  const style = enumValue(candidate.style, readingStyles, fallback.style)
  const styleFallback = readerSettingsForStyle(style, fallback)

  return {
    style,
    layout: enumValue(candidate.layout, layoutModes, styleFallback.layout),
    viewMode: enumValue(candidate.viewMode, viewModes, styleFallback.viewMode),
    direction: enumValue(candidate.direction, directions, styleFallback.direction),
    pageOrder: enumValue(candidate.pageOrder, pageOrders, styleFallback.pageOrder),
    spreadAlignment: enumValue(
      candidate.spreadAlignment,
      spreadAlignments,
      styleFallback.spreadAlignment,
    ),
    fitMode: enumValue(candidate.fitMode, fitModes, styleFallback.fitMode),
    zoom: boundedNumber(candidate.zoom, 70, 200, styleFallback.zoom),
    fontSize: boundedNumber(candidate.fontSize, 80, 160, styleFallback.fontSize),
  }
}

export const migrateLegacyCbzSettings = (
  value: unknown,
  fallback: ReaderSettings,
): ReaderSettings | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Record<string, unknown>
  const hasLegacyValue = [
    'readingDirection',
    'pageOrderMode',
    'spreadAlignment',
    'scaleMode',
  ].some((key) => key in candidate)

  if (!hasLegacyValue) {
    return null
  }

  return normalizeReaderSettings(
    {
      ...fallback,
      direction: candidate.readingDirection,
      pageOrder: candidate.pageOrderMode,
      spreadAlignment: candidate.spreadAlignment,
      fitMode:
        candidate.scaleMode === 'fit-width'
          ? 'fit-width'
          : candidate.scaleMode === 'manual'
            ? 'manual'
            : fallback.fitMode,
    },
    fallback,
  )
}

export const settingsForFormat = (
  settings: ReaderSettings,
  category: CategoryId,
  format: EntryFormat,
): ReaderSettings => {
  const compatibleStyles = compatibleReadingStyles(format)
  const compatibleSettings = compatibleStyles.includes(settings.style)
    ? settings
    : defaultReaderSettings(category, format)

  if (textFormats.has(format)) {
    return {
      ...compatibleSettings,
      viewMode: 'single',
      direction: 'ltr',
      pageOrder: 'filename',
      spreadAlignment: 'straight-pairs',
      fitMode: 'fit-width',
      zoom: 100,
    }
  }

  if (compatibleSettings.style === 'webtoon') {
    return {
      ...compatibleSettings,
      layout: 'continuous',
      viewMode: 'single',
      fitMode: 'fit-width',
    }
  }

  return compatibleSettings
}
