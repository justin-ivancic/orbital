import { useDocumentTitle } from '../app/navigation'
import { replaceRoute } from '../app/router'
import { useScanStatusStream } from '../app/scan'
import { useUser } from '../app/session'
import { useT } from '../i18n'
import { adminTabs, type AppRoute } from '../routing'
import { TopBar } from '../shell/TopBar'
import { LibraryTab } from './admin/LibraryTab'
import { MetadataTab } from './admin/MetadataTab'
import { SystemTab } from './admin/SystemTab'
import { UsersTab } from './admin/UsersTab'
import { ProblemPage } from './ProblemPage'

type AdminRoute = Extract<AppRoute, { name: 'admin' }>

function AdminContent({ route }: { route: AdminRoute }) {
  const t = useT()
  useScanStatusStream()
  useDocumentTitle(`${t.admin.title} · ${t.admin.tabs[route.tab]}`)

  return (
    <>
      <TopBar back={{ name: 'settings' }} title={t.admin.title} />
      <div className="page admin">
        <header className="page-head">
          <div className="page-head__text">
            <h1>{t.admin.title}</h1>
          </div>
        </header>
        <nav aria-label={t.admin.title} className="tabs">
          {adminTabs.map((tab) => (
            <button
              aria-current={route.tab === tab ? 'page' : undefined}
              className="tab"
              key={tab}
              onClick={() => replaceRoute({ name: 'admin', tab })}
              type="button"
            >
              {t.admin.tabs[tab]}
            </button>
          ))}
        </nav>
        {route.tab === 'library' && <LibraryTab />}
        {route.tab === 'users' && <UsersTab />}
        {route.tab === 'metadata' && <MetadataTab />}
        {route.tab === 'system' && <SystemTab />}
      </div>
    </>
  )
}

export function AdminPage({ route }: { route: AdminRoute }) {
  const user = useUser()

  if (user?.role !== 'admin') {
    return <ProblemPage kind="adminOnly" />
  }

  return <AdminContent route={route} />
}
