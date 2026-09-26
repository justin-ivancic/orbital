import { CloudOff, X } from 'lucide-react'
import { useConnection } from '../app/connection'
import { dismissNotice, notify, useNotices } from '../app/notices'
import { reconnect } from '../app/session'
import { useT } from '../i18n'

export function NoticeRegion() {
  const t = useT()
  const notices = useNotices()

  return (
    <div aria-live="polite" className="notices" role="status">
      {notices.map((notice) => (
        <div className={`notice${notice.tone === 'error' ? ' notice--error' : ''}`} key={notice.id}>
          <span>{notice.text}</span>
          <button
            aria-label={t.common.dismiss}
            className="icon-btn icon-btn--small"
            onClick={() => dismissNotice(notice.id)}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}

export function OfflineBanner() {
  const t = useT()
  const { offline, reconnecting } = useConnection()

  if (!offline) {
    return null
  }

  const handleReconnect = async () => {
    try {
      const online = await reconnect()
      notify(online ? t.connection.backOnline : t.connection.stillOffline, online ? 'info' : 'error')
    } catch (error) {
      notify(error instanceof Error ? error.message : t.common.somethingWentWrong, 'error')
    }
  }

  return (
    <div className="offline-strip">
      <div className="banner banner--inverse" role="status">
        <CloudOff aria-hidden="true" />
        <span className="banner__text">{t.connection.offline}</span>
        <button className="btn btn--small" disabled={reconnecting} onClick={() => void handleReconnect()} type="button">
          {reconnecting ? t.connection.reconnecting : t.connection.reconnect}
        </button>
      </div>
    </div>
  )
}
