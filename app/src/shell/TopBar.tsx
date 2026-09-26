import { ArrowLeft, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { goBack } from '../app/router'
import { useT } from '../i18n'
import type { AppRoute } from '../routing'
import { Link } from '../ui/Link'

type TopBarProps = {
  /** Page title; the brand is shown when omitted. */
  title?: string
  /** Shows a back button that returns to the previous page (or this fallback). */
  back?: AppRoute
  actions?: ReactNode
  /** Keep the bar on wide screens too (the reader-like pages). */
  always?: boolean
  showSearch?: boolean
}

/** The compact-screen header. Wide screens use the sidebar and page headings instead. */
export function TopBar({ title, back, actions, always = false, showSearch = true }: TopBarProps) {
  const t = useT()

  return (
    <header className={`topbar${always ? '' : ' topbar--compact-only'}`}>
      {back && (
        <button aria-label={t.common.back} className="icon-btn" onClick={() => goBack(back)} type="button">
          <ArrowLeft aria-hidden="true" />
        </button>
      )}
      {title ? (
        <span className="topbar__title">{title}</span>
      ) : (
        <Link className="brand" to={{ name: 'home' }}>
          <span aria-hidden="true" className="brand__mark" />
          <span className="brand__name">{t.common.appName}</span>
        </Link>
      )}
      {!title && <span className="spacer" />}
      <div className="topbar__actions">
        {actions}
        {showSearch && (
          <Link aria-label={t.nav.search} className="icon-btn" to={{ name: 'search', query: '', scope: 'all' }}>
            <Search aria-hidden="true" />
          </Link>
        )}
      </div>
    </header>
  )
}
