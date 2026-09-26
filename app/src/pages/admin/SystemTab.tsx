import { Smartphone, Trash2, Upload } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { api, type AdminSettings, type AndroidAppInfo } from '../../api'
import { confirmAction } from '../../app/dialogs'
import { notify } from '../../app/notices'
import { formatBytes, formatDate, useT } from '../../i18n'
import { Meter, SectionHead } from '../../ui/bits'

export function SystemTab() {
  const t = useT()
  const s = t.admin.system
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [versionName, setVersionName] = useState('')
  const [versionCode, setVersionCode] = useState('')
  const [progress, setProgress] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.getAdminSettings().then((value) => {
      if (!cancelled) {
        setSettings(value)
      }
    }).catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [])

  const updateApp = (androidApp: AndroidAppInfo) =>
    setSettings((previous) => (previous ? { ...previous, androidApp } : previous))

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!file) {
      return
    }

    setProgress(0)

    try {
      updateApp(await api.uploadAndroidApk(file, { versionName, versionCode }, setProgress))
      notify(s.uploaded)
      setFile(null)
      setVersionName('')
      setVersionCode('')
      event.currentTarget?.reset()
    } catch (error) {
      notify(error instanceof Error ? error.message : t.common.somethingWentWrong, 'error')
    } finally {
      setProgress(null)
    }
  }

  const remove = async () => {
    const confirmed = await confirmAction({ title: s.removeApk, body: s.removeApkConfirm, confirmLabel: s.removeApk, danger: true })

    if (!confirmed) {
      return
    }

    try {
      updateApp((await api.deleteAndroidApk()).androidApp)
    } catch (error) {
      notify(error instanceof Error ? error.message : t.common.somethingWentWrong, 'error')
    }
  }

  const app = settings?.androidApp

  return (
    <div className="stack" style={{ gap: 'var(--space-8)' }}>
      <section className="section">
        <SectionHead title={s.android} />
        <p className="text-muted text-small">{s.androidIntro}</p>
        <div className="panel apk-card">
          <Smartphone aria-hidden="true" className="apk-card__icon" />
          <div className="apk-card__body">
            {!app ? (
              <span className="text-muted">{t.common.loading}</span>
            ) : app.available ? (
              <>
                <strong>
                  {app.versionName
                    ? s.current(`${app.versionName}${app.versionCode ? ` (${app.versionCode})` : ''}`, formatBytes(app.size, t))
                    : s.currentUnknown(formatBytes(app.size, t))}
                </strong>
                <span className="text-muted text-small">
                  {app.source === 'external' ? s.external : app.source === 'bundled' ? s.bundled : app.updatedAt ? formatDate(app.updatedAt, t) : ''}
                </span>
              </>
            ) : (
              <strong>{s.none}</strong>
            )}
          </div>
          {app?.source === 'uploaded' && (
            <button className="btn btn--small btn--danger" onClick={() => void remove()} type="button">
              <Trash2 aria-hidden="true" />
              {s.removeApk}
            </button>
          )}
        </div>

        <form className="panel stack" onSubmit={(event) => void upload(event)}>
          <label className="field">
            <span className="field__label">{s.chooseFile}</span>
            <input
              accept=".apk,application/vnd.android.package-archive"
              className="input input--file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              type="file"
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">{s.versionName}</span>
              <input className="input" onChange={(event) => setVersionName(event.target.value)} placeholder="2.0.0" value={versionName} />
            </label>
            <label className="field">
              <span className="field__label">{s.versionCode}</span>
              <input
                className="input"
                inputMode="numeric"
                onChange={(event) => setVersionCode(event.target.value)}
                placeholder="25"
                value={versionCode}
              />
            </label>
          </div>
          {progress != null && <Meter label={s.uploading} value={progress} />}
          <div>
            <button className="btn btn--primary" disabled={!file || progress != null} type="submit">
              <Upload aria-hidden="true" />
              {progress != null ? `${s.uploading} ${Math.round(progress * 100)}%` : s.upload}
            </button>
          </div>
        </form>
      </section>

      <section className="section">
        <SectionHead title={s.signup} />
        <p>{settings?.openSignup ? t.admin.users.signupOpen : t.admin.users.signupClosed}</p>
      </section>
    </div>
  )
}
