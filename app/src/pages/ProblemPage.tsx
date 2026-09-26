import { ArrowDownToLine, CircleAlert, House, ShieldAlert } from 'lucide-react'
import { useDocumentTitle } from '../app/navigation'
import { useT } from '../i18n'
import { TopBar } from '../shell/TopBar'
import { EmptyState } from '../ui/bits'
import { Link } from '../ui/Link'

type ProblemKind = 'notFound' | 'gone' | 'downloadGone' | 'adminOnly'

export function ProblemPage({ kind }: { kind: ProblemKind }) {
  const t = useT()
  const content = {
    notFound: { title: t.problems.notFoundTitle, body: t.problems.notFoundBody, icon: CircleAlert },
    gone: { title: t.problems.goneTitle, body: t.problems.goneBody, icon: CircleAlert },
    downloadGone: { title: t.problems.downloadGoneTitle, body: t.problems.downloadGoneBody, icon: ArrowDownToLine },
    adminOnly: { title: t.problems.adminOnlyTitle, body: t.problems.adminOnlyBody, icon: ShieldAlert },
  }[kind]
  useDocumentTitle(content.title)

  return (
    <>
      <TopBar back={{ name: 'home' }} title={content.title} />
      <div className="page">
        <EmptyState
          action={
            <div className="cluster" style={{ justifyContent: 'center' }}>
              {kind === 'downloadGone' && (
                <Link className="btn" to={{ name: 'downloads' }}>
                  {t.problems.openDownloads}
                </Link>
              )}
              <Link className="btn btn--primary" to={{ name: 'home' }}>
                <House aria-hidden="true" />
                {t.problems.goHome}
              </Link>
            </div>
          }
          body={content.body}
          icon={content.icon}
          title={content.title}
        />
      </div>
    </>
  )
}
