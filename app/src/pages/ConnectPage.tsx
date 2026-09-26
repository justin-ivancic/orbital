import { useState, type FormEvent } from 'react'
import { bootSession } from '../app/session'
import { normalizeServerUrl, setServerUrl } from '../platform'
import { useT } from '../i18n'
import { LanguageSwitch } from './AuthPage'

/** First start of the Android app: ask where the library lives. */
export function ConnectPage() {
  const t = useT()
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = normalizeServerUrl(address)

    if (!normalized) {
      setError(t.connect.invalid)
      return
    }

    if (!normalized.startsWith('https://')) {
      setError(t.connect.httpsRequired)
      return
    }

    setChecking(true)
    setError(null)
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 12_000)

    try {
      const response = await fetch(`${normalized}/api/bootstrap`, {
        credentials: 'omit',
        signal: controller.signal,
      })
      const payload = (await response.json().catch(() => null)) as { appName?: unknown; openSignup?: unknown } | null

      if (!response.ok || !payload || typeof payload.appName !== 'string' || typeof payload.openSignup !== 'boolean') {
        setError(t.connect.notOrbital)
        return
      }

      setServerUrl(normalized)
      await bootSession()
    } catch {
      setError(t.connect.unreachable)
    } finally {
      window.clearTimeout(timer)
      setChecking(false)
    }
  }

  return (
    <main className="auth">
      <div className="auth__card panel panel--raised">
        <div className="auth__brand">
          <span aria-hidden="true" className="brand__mark" />
          <span className="brand__name">{t.common.appName}</span>
        </div>
        <div className="stack" style={{ gap: 'var(--space-1)' }}>
          <h1>{t.connect.title}</h1>
          <p className="text-muted">{t.connect.intro}</p>
        </div>
        <form className="stack" onSubmit={(event) => void connect(event)}>
          <label className="field">
            <span className="field__label">{t.connect.address}</span>
            <input
              autoCapitalize="none"
              autoComplete="url"
              autoCorrect="off"
              className="input"
              inputMode="url"
              onChange={(event) => setAddress(event.target.value)}
              placeholder={t.connect.placeholder}
              required
              spellCheck={false}
              value={address}
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn--primary btn--block" disabled={checking || !address.trim()} type="submit">
            {checking ? t.connect.checking : t.connect.connect}
          </button>
        </form>
        <div className="auth__footer">
          <LanguageSwitch />
        </div>
      </div>
    </main>
  )
}
