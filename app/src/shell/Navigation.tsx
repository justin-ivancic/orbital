import { ArrowDownToLine, Compass, House, Search, Settings, ShieldCheck, type LucideIcon } from 'lucide-react'
import type { MouseEvent } from 'react'
import { availableCategories, browseTarget, useCategoryCounts } from '../app/navigation'
import { navigate, useRoute } from '../app/router'
import { useUser } from '../app/session'
import { useT } from '../i18n'
import { appRoutePath, libraryRoute, type AppRoute } from '../routing'
import { Link } from '../ui/Link'

type NavSection = 'home' | 'browse' | 'search' | 'downloads' | 'settings' | 'admin'

const sectionFor = (route: AppRoute): NavSection | null => {
  switch (route.name) {
    case 'home':
      return 'home'
    case 'library':
    case 'series':
    case 'creator':
      return 'browse'
    case 'search':
      return 'search'
    case 'downloads':
      return 'downloads'
    case 'settings':
      return 'settings'
    case 'admin':
      return 'admin'
    default:
      return null
  }
}

type NavItem = {
  section: NavSection
  label: string
  shortLabel?: string
  icon: LucideIcon
  to: () => AppRoute
}

const useNavItems = (): NavItem[] => {
  const t = useT()

  return [
    { section: 'home', label: t.nav.home, icon: House, to: () => ({ name: 'home' }) },
    { section: 'browse', label: t.nav.browse, icon: Compass, to: browseTarget },
    { section: 'search', label: t.nav.search, icon: Search, to: () => ({ name: 'search', query: '', scope: 'all' }) },
    { section: 'downloads', label: t.nav.downloads, icon: ArrowDownToLine, to: () => ({ name: 'downloads' }) },
    { section: 'settings', label: t.nav.settings, shortLabel: t.nav.settingsShort, icon: Settings, to: () => ({ name: 'settings' }) },
  ]
}

/** Navigates to a destination computed at click time (Browse remembers the last shelf). */
const handleDynamicLink = (event: MouseEvent<HTMLAnchorElement>, to: () => AppRoute) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return
  }

  event.preventDefault()
  navigate(to())
}

export function BottomNav() {
  const t = useT()
  const route = useRoute()
  const items = useNavItems()
  const current = sectionFor(route)

  return (
    <nav aria-label={t.nav.primary} className="bottomnav">
      {items.map((item) => {
        const active = current === item.section || (item.section === 'settings' && current === 'admin')
        const Icon = item.icon

        return (
          <a
            aria-current={active ? 'page' : undefined}
            className="bottomnav__item"
            href={appRoutePath(item.to())}
            key={item.section}
            onClick={(event) => handleDynamicLink(event, item.to)}
          >
            <Icon aria-hidden="true" strokeWidth={active ? 2.4 : 2} />
            <span className="bottomnav__label">{item.shortLabel ?? item.label}</span>
          </a>
        )
      })}
    </nav>
  )
}

export function Sidebar() {
  const t = useT()
  const route = useRoute()
  const user = useUser()
  const items = useNavItems()
  const counts = useCategoryCounts()
  const current = sectionFor(route)
  const categories = availableCategories(counts)
  const primary = items.filter((item) => item.section !== 'settings')
  const settings = items.find((item) => item.section === 'settings')

  const renderItem = (item: NavItem) => {
    const Icon = item.icon
    const active = current === item.section

    return (
      <a
        aria-current={active ? 'page' : undefined}
        className="sidebar__link"
        href={appRoutePath(item.to())}
        key={item.section}
        onClick={(event) => handleDynamicLink(event, item.to)}
      >
        <Icon aria-hidden="true" />
        {item.label}
      </a>
    )
  }

  return (
    <aside className="sidebar">
      <Link className="brand" to={{ name: 'home' }}>
        <span aria-hidden="true" className="brand__mark" />
        <span className="brand__name">{t.common.appName}</span>
      </Link>
      <nav aria-label={t.nav.primary} className="sidebar__nav">
        {primary.map((item) => (
          <div key={item.section}>
            {renderItem(item)}
            {item.section === 'browse' && categories.length > 1 && (
              <div className="sidebar__sub">
                {categories.map((category) => {
                  const active = route.name === 'library' && route.category === category

                  return (
                    <Link
                      aria-current={active ? 'page' : undefined}
                      className="sidebar__sublink"
                      key={category}
                      to={libraryRoute(category)}
                    >
                      {t.categories[category]}
                      <span className="sidebar__count">{counts[category].toLocaleString(t.locale)}</span>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="sidebar__footer">
        {user?.role === 'admin' && (
          <Link
            aria-current={current === 'admin' ? 'page' : undefined}
            className="sidebar__link"
            to={{ name: 'admin', tab: 'library' }}
          >
            <ShieldCheck aria-hidden="true" />
            {t.nav.admin}
          </Link>
        )}
        {settings && renderItem(settings)}
      </div>
    </aside>
  )
}
