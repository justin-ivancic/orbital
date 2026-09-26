import { useState, type FormEvent } from 'react'
import { isNetworkError } from '../api'
import { navigate, useRoute } from '../app/router'
import { login, useSession } from '../app/session'
import { preferencesStore, setPreference } from '../app/preferences'
import { useStore } from '../app/store'
import { clearServerUrl, getServerUrl, isNativeApp } from '../platform'
import { parseAppRoute } from '../routing'
import { useT } from '../i18n'
import { Segmented } from '../ui/bits'
import { Link } from '../ui/Link'

const selectLanguage = (state: { language: 'en' | 'de' }) => state.language

export function LanguageSwitch() {
  const language = useStore(preferencesStore, selectLanguage)
  const t = useT()

  return (
    <Segmented
      label={t.settings.language}
      onChange={(value) => setPreference('language', value)}
      options={[
        { value: 'en', label: 'EN' },
        { value: 'de', label: 'DE' },
      ]}
      value={language}
    />
  )
}

export function AuthPage() {
  const t = useT()
  const route = useRoute()
  const session = useSession()
  const mode = route.name === 'signup' && session.openSignup ? 'signup' : 'login'
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const shownError = error ?? session.authError

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError(null)

    try {
      await login(
        { username: String(form.get('username') ?? '').trim(), password: String(form.get('password') ?? '') },
        mode,
      )
      const next = route.name === 'login' && route.next ? parseAppRoute(new URL(route.next, 'https://orbital.invalid')) : null
      navigate(next && next.name !== 'login' && next.name !== 'signup' && next.name !== 'notFound' ? next : { name: 'home' }, { replace: true })
    } catch (submitError) {
      setError(
        isNetworkError(submitError)
          ? t.auth.cantReachServer
          : submitError instanceof Error
            ? submitError.message
            : t.common.somethingWentWrong,
      )
    } finally {
      setBusy(false)
    }
  }

  const server = getServerUrl().replace(/^https?:\/\//, '')

  return (
    <main className="auth">
      <div className="auth__card panel panel--raised">
        <div className="auth__brand">
          <span aria-hidden="true" className="brand__mark" />
          <span className="brand__name">{session.appName || t.common.appName}</span>
        </div>
        <div className="stack" style={{ gap: 'var(--space-1)' }}>
          <h1>{mode === 'signup' ? t.auth.signUpTitle : t.auth.signInTitle}</h1>
          <p className="text-muted">{mode === 'signup' ? t.auth.signUpIntro : t.auth.signInIntro}</p>
        </div>
        <form className="stack" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span className="field__label">{t.auth.username}</span>
            <input
              autoCapitalize="none"
              autoComplete="username"
              autoCorrect="off"
              className="input"
              name="username"
              required
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field__label">{t.auth.password}</span>
            <input
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              className="input"
              minLength={mode === 'signup' ? 8 : undefined}
              name="password"
              required
              type="password"
            />
            {mode === 'signup' && <span className="field__hint">{t.auth.passwordHint}</span>}
          </label>
          {shownError && <p className="form-error" role="alert">{shownError}</p>}
          <button className="btn btn--primary btn--block" disabled={busy} type="submit">
            {busy
              ? mode === 'signup' ? t.auth.creatingAccount : t.auth.signingIn
              : mode === 'signup' ? t.auth.createAccount : t.auth.signIn}
          </button>
        </form>
        {session.openSignup && (
          <p className="auth__switch">
            {mode === 'signup' ? t.auth.haveAccount : t.auth.noAccount}{' '}
            <Link className="link-btn" options={{ replace: true }} to={mode === 'signup' ? { name: 'login', next: null } : { name: 'signup' }}>
              {mode === 'signup' ? t.auth.signIn : t.auth.createAccount}
            </Link>
          </p>
        )}
        <div className="auth__footer">
          {isNativeApp && server && (
            <span className="auth__server">
              {t.auth.server}: {server}{' '}
              <button
                className="link-btn"
                onClick={() => {
                  clearServerUrl()
                  window.location.replace('/')
                }}
                type="button"
              >
                {t.auth.changeServer}
              </button>
            </span>
          )}
          <LanguageSwitch />
        </div>
      </div>
    </main>
  )
}
