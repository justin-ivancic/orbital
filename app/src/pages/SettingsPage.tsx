import {
  ArrowDownToLine,
  ChevronRight,
  KeyRound,
  LogOut,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { api, type AndroidAppInfo } from '../api'
import { useNow } from '../app/clock'
import { useOffline } from '../app/connection'
import { confirmAction } from '../app/dialogs'
import { libraryStore, type LibraryState } from '../app/library'
import { useDocumentTitle } from '../app/navigation'
import { notify } from '../app/notices'
import { preferencesStore, setPreference, type DevicePreferences } from '../app/preferences'
import { applyState, logout, reconnect, refreshState, resetDeviceCache, useUser } from '../app/session'
import { useStore } from '../app/store'
import {
  clearImageCache,
  getImageCacheSummary,
  getImageLoadPerformance,
  runImageCacheSelfTest,
  type ImageCacheSummary,
} from '../imageCache'
import { getRoutePerformanceSummary } from '../performanceMetrics'
import { androidAppVersionCode, androidAppVersionName, clearServerUrl, getServerUrl, isNativeApp, resolveApiUrl } from '../platform'
import { formatBytes, formatRelative, useT } from '../i18n'
import { SettingRow, TextSettingsControls } from '../readers/TextSettingsControls'
import { TopBar } from '../shell/TopBar'
import { Segmented } from '../ui/bits'
import { Link } from '../ui/Link'
import { Sheet } from '../ui/Sheet'

const selectPreferences = (state: DevicePreferences) => state
const selectSyncedAt = (state: LibraryState) => state.syncedAt

function PasswordSheet({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const currentPassword = String(form.get('currentPassword') ?? '')
    const newPassword = String(form.get('newPassword') ?? '')
    const confirmPassword = String(form.get('confirmPassword') ?? '')

    if (newPassword.length < 8) {
      setError(t.settings.passwordTooShort)
      return
    }

    if (newPassword !== confirmPassword) {
      setError(t.settings.passwordMismatch)
      return
    }

    setBusy(true)
    setError(null)

    try {
      applyState(await api.changePassword({ currentPassword, newPassword }))
      notify(t.settings.passwordChanged)
      onClose()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t.common.somethingWentWrong)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet dismissible={false} onClose={onClose} title={t.settings.changePassword}>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span className="field__label">{t.settings.currentPassword}</span>
          <input autoComplete="current-password" className="input" name="currentPassword" required type="password" />
        </label>
        <label className="field">
          <span className="field__label">{t.settings.newPassword}</span>
          <input autoComplete="new-password" className="input" minLength={8} name="newPassword" required type="password" />
          <span className="field__hint">{t.auth.passwordHint}</span>
        </label>
        <label className="field">
          <span className="field__label">{t.settings.confirmPassword}</span>
          <input autoComplete="new-password" className="input" minLength={8} name="confirmPassword" required type="password" />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="cluster" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} type="button">
            {t.common.cancel}
          </button>
          <button className="btn btn--primary" disabled={busy} type="submit">
            {busy ? t.common.saving : t.settings.changePassword}
          </button>
        </div>
      </form>
    </Sheet>
  )
}

function AppSection() {
  const t = useT()
  const offline = useOffline()
  const [info, setInfo] = useState<AndroidAppInfo | null>(null)

  useEffect(() => {
    if (offline) {
      return
    }

    let cancelled = false
    void api.getAppInfo().then((value) => {
      if (!cancelled) {
        setInfo(value)
      }
    }).catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [offline])

  const apkUrl = info?.available ? resolveApiUrl(info.downloadUrl) : null
  const newer = Boolean(isNativeApp && info?.versionCode && info.versionCode > androidAppVersionCode)

  return (
    <section className="settings-section">
      <h2 className="settings-section__title">{t.settings.app}</h2>
      <div className="list">
        <div className="list-row">
          <span className="list-row__icon"><Smartphone aria-hidden="true" /></span>
          <span className="list-row__body">
            <span className="list-row__title">
              {isNativeApp ? t.settings.androidApp(`${androidAppVersionName} (${androidAppVersionCode})`) : t.settings.webApp}
            </span>
            {isNativeApp && info?.available && (
              <span className="list-row__meta">
                {newer ? t.settings.updateAvailable(info.versionName ?? String(info.versionCode)) : t.settings.upToDate}
              </span>
            )}
          </span>
          {isNativeApp && newer && apkUrl && (
            <a className="btn btn--small btn--primary" href={apkUrl} rel="noreferrer" target="_blank">
              <ArrowDownToLine aria-hidden="true" />
              {t.settings.installUpdate}
            </a>
          )}
        </div>
        {!isNativeApp && apkUrl && (
          <a className="list-row" download href={apkUrl}>
            <span className="list-row__icon"><ArrowDownToLine aria-hidden="true" /></span>
            <span className="list-row__body">
              <span className="list-row__title">{t.settings.getAndroidApp}</span>
              <span className="list-row__meta">
                {t.settings.getAndroidAppBody}
                {info?.versionName ? ` · ${info.versionName}` : ''}
                {info?.size ? ` · ${formatBytes(info.size, t)}` : ''}
              </span>
            </span>
            <ChevronRight aria-hidden="true" className="list-row__chevron" />
          </a>
        )}
      </div>
    </section>
  )
}

function StorageSection() {
  const t = useT()
  const user = useUser()
  const [covers, setCovers] = useState<ImageCacheSummary | null>(null)
  const [resetting, setResetting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const imagePerformance = getImageLoadPerformance()
  const routePerformance = getRoutePerformanceSummary()

  useEffect(() => {
    if (!user) {
      return
    }

    let cancelled = false
    void getImageCacheSummary(user.id).then((summary) => {
      if (!cancelled) {
        setCovers(summary)
      }
    }).catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [user])

  const clearCovers = async () => {
    if (!user) {
      return
    }

    const confirmed = await confirmAction({
      title: t.settings.clearCovers,
      body: t.settings.clearCoversConfirm,
      confirmLabel: t.settings.clearCovers,
      danger: true,
    })

    if (confirmed) {
      await clearImageCache(user.id)
      setCovers(await getImageCacheSummary(user.id))
    }
  }

  const reset = async () => {
    const confirmed = await confirmAction({
      title: t.settings.resetDevice,
      body: t.settings.resetDeviceHelp,
      confirmLabel: t.settings.resetDevice,
      danger: true,
    })

    if (confirmed) {
      setResetting(true)
      await resetDeviceCache()
    }
  }

  const testStorage = async () => {
    if (!user) {
      return
    }

    setTesting(true)

    try {
      const result = await runImageCacheSelfTest(user.id)
      setTestResult(result.passed ? t.settings.testPassed(result.backend, result.bytesRead) : t.settings.testFailed(result.error ?? ''))
      setCovers(await getImageCacheSummary(user.id))
    } catch (error) {
      setTestResult(t.settings.testFailed(error instanceof Error ? error.message : String(error)))
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section__title">{t.settings.storage}</h2>
      <div className="list">
        <Link className="list-row" to={{ name: 'downloads' }}>
          <span className="list-row__body">
            <span className="list-row__title">{t.settings.manageDownloads}</span>
          </span>
          <ChevronRight aria-hidden="true" className="list-row__chevron" />
        </Link>
        <div className="list-row">
          <span className="list-row__body">
            <span className="list-row__title">{t.settings.savedCovers}</span>
            <span className="list-row__meta">
              {covers ? t.settings.savedCoversBody(formatBytes(covers.storedBytes, t), covers.imageCount) : t.common.loading}
            </span>
          </span>
          <button className="btn btn--small" disabled={!covers?.storedBytes} onClick={() => void clearCovers()} type="button">
            {t.settings.clearCovers}
          </button>
        </div>
        <div className="list-row">
          <span className="list-row__body">
            <span className="list-row__title">{t.settings.resetDevice}</span>
            <span className="list-row__meta">{t.settings.resetDeviceHelp}</span>
          </span>
          <button className="btn btn--small btn--danger" disabled={resetting} onClick={() => void reset()} type="button">
            {resetting ? t.settings.resetting : t.settings.resetDevice}
          </button>
        </div>
      </div>
      <details className="diagnostics">
        <summary>{t.settings.diagnostics}</summary>
        <dl className="details-list">
          <dt>{t.settings.coverLoading}</dt>
          <dd>
            {imagePerformance.completedLoads
              ? t.settings.timing(imagePerformance.lastLoadMs, imagePerformance.averageLoadMs + imagePerformance.averageQueueWaitMs)
              : t.settings.notMeasured}
          </dd>
          <dt>{t.settings.pageSwitching}</dt>
          <dd>
            {routePerformance.completedTransitions
              ? t.settings.timing(routePerformance.lastTransitionMs, routePerformance.averageTransitionMs)
              : t.settings.notMeasured}
          </dd>
        </dl>
        <button className="btn btn--small" disabled={testing} onClick={() => void testStorage()} type="button">
          {testing ? t.settings.testing : t.settings.testCoverStorage}
        </button>
        {testResult && <p className="text-small">{testResult}</p>}
      </details>
    </section>
  )
}

export function SettingsPage() {
  const t = useT()
  const user = useUser()
  const now = useNow()
  const offline = useOffline()
  const preferences = useStore(preferencesStore, selectPreferences)
  const syncedAt = useStore(libraryStore, selectSyncedAt)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  useDocumentTitle(t.settings.title)

  const refresh = async () => {
    setRefreshing(true)

    try {
      const online = offline ? await reconnect() : await refreshState()
      notify(online ? t.settings.refreshed : offline ? t.connection.stillOffline : t.auth.cantReachServer, online ? 'info' : 'error')
    } catch (error) {
      notify(error instanceof Error ? error.message : t.common.somethingWentWrong, 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const signOut = async () => {
    const confirmed = await confirmAction({
      title: t.settings.signOut,
      body: t.settings.signOutConfirm,
      confirmLabel: t.settings.signOut,
    })

    if (confirmed) {
      await logout()
    }
  }

  const switchServer = async () => {
    const confirmed = await confirmAction({
      title: t.settings.switchServer,
      body: t.settings.switchServerConfirm,
      confirmLabel: t.settings.switchServer,
    })

    if (confirmed) {
      await logout()
      clearServerUrl()
      window.location.replace('/')
    }
  }

  return (
    <>
      <TopBar title={t.settings.title} />
      <div className="page page--narrow settings">
        <header className="page-head">
          <div className="page-head__text">
            <h1>{t.settings.title}</h1>
          </div>
        </header>

        <section className="settings-section">
          <h2 className="settings-section__title">{t.settings.account}</h2>
          <div className="list">
            <div className="list-row">
              <span aria-hidden="true" className="avatar">{user?.username.slice(0, 1).toUpperCase()}</span>
              <span className="list-row__body">
                <span className="list-row__title">{user?.username}</span>
                <span className="list-row__meta">{user?.role === 'admin' ? t.settings.roleAdmin : t.settings.roleMember}</span>
              </span>
            </div>
            <button className="list-row" disabled={offline} onClick={() => setPasswordOpen(true)} type="button">
              <span className="list-row__icon"><KeyRound aria-hidden="true" /></span>
              <span className="list-row__body">
                <span className="list-row__title">{t.settings.changePassword}</span>
              </span>
              <ChevronRight aria-hidden="true" className="list-row__chevron" />
            </button>
            {user?.role === 'admin' && (
              <Link className="list-row" to={{ name: 'admin', tab: 'library' }}>
                <span className="list-row__icon"><ShieldCheck aria-hidden="true" /></span>
                <span className="list-row__body">
                  <span className="list-row__title">{t.settings.admin}</span>
                  <span className="list-row__meta">{t.settings.adminBody}</span>
                </span>
                <ChevronRight aria-hidden="true" className="list-row__chevron" />
              </Link>
            )}
            <button className="list-row" onClick={() => void signOut()} type="button">
              <span className="list-row__icon"><LogOut aria-hidden="true" /></span>
              <span className="list-row__body">
                <span className="list-row__title">{t.settings.signOut}</span>
              </span>
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h2 className="settings-section__title">{t.settings.reading}</h2>
          <p className="text-muted text-small">{t.settings.readingHelp}</p>
          <div className="panel stack">
            <SettingRow
              hint={preferences.tapLayout === 'sides' ? t.settings.tapSidesHelp : t.settings.tapForwardHelp}
              label={t.settings.pageTurns}
            >
              <Segmented
                block
                label={t.settings.pageTurns}
                onChange={(tapLayout) => setPreference('tapLayout', tapLayout)}
                options={[
                  { value: 'sides', label: t.settings.tapSides },
                  { value: 'forward', label: t.settings.tapForward },
                ]}
                value={preferences.tapLayout}
              />
            </SettingRow>
            <TextSettingsControls allowPublisherFont textStyle={preferences.text} />
            <p className="reading-sample" style={{ fontFamily: preferences.text.font === 'sans' ? 'var(--font-reading-sans)' : 'var(--font-reading-serif)', fontSize: `${preferences.text.fontScale / 100 * 1.05}rem`, lineHeight: preferences.text.spacing === 'compact' ? 1.35 : preferences.text.spacing === 'relaxed' ? 1.85 : 1.6, textAlign: preferences.text.justify ? 'justify' : 'start' }}>
              {t.settings.readingSample}
            </p>
          </div>
        </section>

        <section className="settings-section">
          <h2 className="settings-section__title">{t.settings.appearance}</h2>
          <div className="panel stack">
            <SettingRow label={t.settings.theme}>
              <Segmented
                block
                label={t.settings.theme}
                onChange={(theme) => setPreference('theme', theme)}
                options={[
                  { value: 'light', label: t.settings.themeLight },
                  { value: 'dark', label: t.settings.themeDark },
                  { value: 'system', label: t.settings.themeSystem },
                ]}
                value={preferences.theme}
              />
            </SettingRow>
            <SettingRow label={t.settings.language}>
              <Segmented
                block
                label={t.settings.language}
                onChange={(language) => setPreference('language', language)}
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'de', label: 'Deutsch' },
                ]}
                value={preferences.language}
              />
            </SettingRow>
          </div>
        </section>

        <section className="settings-section">
          <h2 className="settings-section__title">{t.settings.library}</h2>
          <div className="list">
            <button className="list-row" disabled={refreshing} onClick={() => void refresh()} type="button">
              <span className="list-row__icon"><RefreshCw aria-hidden="true" /></span>
              <span className="list-row__body">
                <span className="list-row__title">{refreshing ? t.settings.refreshing : t.settings.refreshLibrary}</span>
                {syncedAt && <span className="list-row__meta">{t.settings.updated(formatRelative(syncedAt, t, now))}</span>}
              </span>
            </button>
            {isNativeApp && (
              <button className="list-row" onClick={() => void switchServer()} type="button">
                <span className="list-row__icon"><Server aria-hidden="true" /></span>
                <span className="list-row__body">
                  <span className="list-row__title">{t.settings.switchServer}</span>
                  <span className="list-row__meta">{getServerUrl().replace(/^https?:\/\//, '')}</span>
                </span>
                <ChevronRight aria-hidden="true" className="list-row__chevron" />
              </button>
            )}
          </div>
        </section>

        <AppSection />
        <StorageSection />
      </div>
      {passwordOpen && <PasswordSheet onClose={() => setPasswordOpen(false)} />}
    </>
  )
}
