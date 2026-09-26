import { memo } from 'react'
import type { SeriesSummary } from '../appTypes'
import { seriesCreator, seriesTitle, titleMeta } from '../app/seriesText'
import type { OfflineSeriesAvailability } from '../offlineDownloads'
import { seriesRoute } from '../routing'
import { useT } from '../i18n'
import { Meter } from './bits'
import { Cover } from './Cover'
import { Link } from './Link'

type TitleCardProps = {
  series: SeriesSummary
  availability?: OfflineSeriesAvailability
  progress?: number
  eager?: boolean
}

export const TitleCard = memo(function TitleCard({ series, availability, progress, eager }: TitleCardProps) {
  const t = useT()
  const title = seriesTitle(series)

  return (
    <Link className="title-card" to={seriesRoute(series.category, series.id)}>
      <Cover availability={availability} eager={eager} series={series} />
      <span className="title-card__title">{title}</span>
      <span className="title-card__meta">{titleMeta(series, t)}</span>
      {progress != null && progress > 0 && <Meter thin value={progress} />}
    </Link>
  )
})

export const TitleRow = memo(function TitleRow({ series, availability }: TitleCardProps) {
  const t = useT()
  const creator = seriesCreator(series)

  return (
    <Link className="title-row" to={seriesRoute(series.category, series.id)}>
      <Cover availability={availability} compact series={series} />
      <span className="title-row__body">
        <span className="title-row__title">{seriesTitle(series)}</span>
        <span className="title-row__meta">
          {[creator, series.year].filter(Boolean).join(' · ') || t.categories[series.category]}
        </span>
      </span>
      <span className="title-row__end">{titleMeta(series, t)}</span>
    </Link>
  )
})
