import { BookOpen, Check, Clapperboard, Download, Images, Newspaper, ScrollText } from 'lucide-react'
import { memo, useState, type CSSProperties } from 'react'
import type { CategoryId, SeriesSummary } from '../appTypes'
import { AuthenticatedResourceImage } from '../AuthenticatedResourceImage'
import { useOffline } from '../app/connection'
import { useUser } from '../app/session'
import { hashIndex, seriesCreator, seriesTitle } from '../app/seriesText'
import type { OfflineSeriesAvailability } from '../offlineDownloads'
import { useT } from '../i18n'

type CoverSeries = Pick<
  SeriesSummary,
  'id' | 'title' | 'titleShort' | 'folder' | 'format' | 'category' | 'coverUrl' | 'coverImageUrl' | 'sourceName'
>

const categoryMarks: Record<CategoryId, typeof BookOpen> = {
  books: BookOpen,
  manga: Images,
  novels: ScrollText,
  magazines: Newspaper,
  anime: Clapperboard,
}

type FallbackCoverProps = {
  series: CoverSeries
  compact?: boolean
}

export function FallbackCover({ series, compact = false }: FallbackCoverProps) {
  const t = useT()
  const Mark = categoryMarks[series.category] ?? BookOpen
  const creator = seriesCreator(series)
  const band = `var(--cover-${hashIndex(series.id || series.title, 8) + 1})`

  return (
    <div
      aria-hidden="true"
      className={`fallback-cover${compact ? ' fallback-cover--compact' : ''}`}
      style={{ '--band': band } as CSSProperties}
    >
      <div className="fallback-cover__top">
        <span className="fallback-cover__category">{t.categories[series.category]}</span>
      </div>
      <div className="fallback-cover__panel">
        <span className="fallback-cover__title">{seriesTitle(series)}</span>
        {creator && <span className="fallback-cover__author">{creator}</span>}
      </div>
      <div className="fallback-cover__mark">
        <Mark strokeWidth={1.8} />
      </div>
    </div>
  )
}

type CoverProps = {
  series: CoverSeries
  /** Uses the full-size image (series pages). */
  large?: boolean
  eager?: boolean
  availability?: OfflineSeriesAvailability
  compact?: boolean
}

/** A cover image with a typographic fallback and an offline badge. */
export const Cover = memo(function Cover({ series, large = false, eager = false, availability, compact = false }: CoverProps) {
  const t = useT()
  const user = useUser()
  const offline = useOffline()
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const source = (large ? series.coverImageUrl ?? series.coverUrl : series.coverUrl) ?? null
  const showImage = Boolean(source && failedUrl !== source)

  return (
    <div className="cover">
      {showImage && source ? (
        <AuthenticatedResourceImage
          alt=""
          cacheKey={`${large ? 'cover-full' : 'cover'}:${series.id}`}
          decoding="async"
          loading={eager ? 'eager' : 'lazy'}
          offlineOnly={offline}
          onError={() => setFailedUrl(source)}
          ownerUserId={user?.id}
          sourceUrl={source}
        />
      ) : (
        <FallbackCover compact={compact} series={series} />
      )}
      {availability && (
        <span
          className={`cover__badge${availability === 'partial' ? ' cover__badge--partial' : ''}`}
          title={availability === 'complete' ? t.series.downloaded : t.series.download}
        >
          {availability === 'complete' ? <Check aria-hidden="true" /> : <Download aria-hidden="true" />}
          <span className="visually-hidden">
            {availability === 'complete' ? t.series.downloaded : t.series.download}
          </span>
        </span>
      )}
    </div>
  )
})
