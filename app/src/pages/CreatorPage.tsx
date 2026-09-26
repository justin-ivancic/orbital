import { UserRound } from 'lucide-react'
import { useDownloadRecords } from '../app/downloads'
import { libraryStore, type LibraryState } from '../app/library'
import { useDocumentTitle } from '../app/navigation'
import { seriesAvailability } from '../app/offlineLibrary'
import { creatorProfiles } from '../app/seriesText'
import { useStore } from '../app/store'
import { useT } from '../i18n'
import { libraryRoute } from '../routing'
import { TopBar } from '../shell/TopBar'
import { EmptyState } from '../ui/bits'
import { Link } from '../ui/Link'
import { TitleCard } from '../ui/TitleCard'
import { ProblemPage } from './ProblemPage'

const selectLibrary = (state: LibraryState) => state.library
const selectLoaded = (state: LibraryState) => state.loaded

export function CreatorPage({ creatorKey }: { creatorKey: string }) {
  const t = useT()
  const library = useStore(libraryStore, selectLibrary)
  const loaded = useStore(libraryStore, selectLoaded)
  const records = useDownloadRecords()
  const profile = creatorProfiles(library).get(creatorKey) ?? null
  useDocumentTitle(profile?.name ?? null)

  if (!profile) {
    return loaded ? <ProblemPage kind="gone" /> : (
      <div className="page">
        <EmptyState icon={UserRound} title={t.common.loading} />
      </div>
    )
  }

  return (
    <>
      <TopBar back={{ name: 'home' }} title={profile.name} />
      <div className="page creator">
        <header className="page-head">
          <div className="page-head__text">
            {profile.role && <span className="kicker">{profile.role}</span>}
            <h1>{profile.name}</h1>
            <p className="page-head__subtitle">{t.units.titles(profile.series.length)}</p>
          </div>
          <div className="cluster">
            {profile.categories.map((category) =>
              category === 'anime' ? null : (
                <Link className="chip" key={category} to={libraryRoute(category, { sort: 'author' })}>
                  {t.categories[category]}
                </Link>
              ),
            )}
          </div>
        </header>
        <div className="title-grid">
          {profile.series.map((series) => (
            <TitleCard availability={seriesAvailability(records, series)} key={series.id} series={series} />
          ))}
        </div>
      </div>
    </>
  )
}
