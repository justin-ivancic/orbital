import { useEffect } from 'react'
import { preferencesStore, type DevicePreferences } from './app/preferences'
import { navigate, useRoute } from './app/router'
import { useSession } from './app/session'
import { useStore } from './app/store'
import { useT } from './i18n'
import { AuthPage } from './pages/AuthPage'
import { ConnectPage } from './pages/ConnectPage'
import { appRoutePath, isProtectedRoute, parseAppRoute } from './routing'
import { Shell } from './shell/Shell'

const selectAppearance = (state: DevicePreferences) => `${state.theme}:${state.language}`

/** Applies the theme (following the device when asked) and document language. */
const useAppearance = () => {
  const appearance = useStore(preferencesStore, selectAppearance)

  useEffect(() => {
    const [theme, language] = appearance.split(':')
    const root = document.documentElement
    root.lang = language

    if (theme !== 'system') {
      root.dataset.theme = theme
      return
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      root.dataset.theme = media.matches ? 'dark' : 'light'
    }

    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [appearance])
}

function Splash() {
  const t = useT()

  return (
    <div className="splash" role="status">
      <div className="splash__inner">
        <span aria-hidden="true" className="brand__mark" />
        <span className="brand__name">{t.common.appName}</span>
        <span className="spinner-text">{t.common.loading}</span>
      </div>
    </div>
  )
}

export default function App() {
  const session = useSession()
  const route = useRoute()
  useAppearance()

  // Keep the address in line with the session: sign-in pages only while signed out.
  useEffect(() => {
    if (session.phase === 'signedOut' && isProtectedRoute(route)) {
      navigate(
        { name: 'login', next: route.name === 'home' || route.name === 'notFound' ? null : appRoutePath(route) },
        { replace: true },
      )
    } else if (session.phase === 'signedOut' && route.name === 'signup' && !session.openSignup) {
      navigate({ name: 'login', next: null }, { replace: true })
    } else if (session.phase === 'ready' && (route.name === 'login' || route.name === 'signup')) {
      const next = route.name === 'login' && route.next ? parseAppRoute(new URL(route.next, 'https://orbital.invalid')) : null
      navigate(next && isProtectedRoute(next) && next.name !== 'notFound' ? next : { name: 'home' }, { replace: true })
    }
  }, [route, session.openSignup, session.phase])

  switch (session.phase) {
    case 'booting':
      return <Splash />
    case 'connect':
      return <ConnectPage />
    case 'signedOut':
      return <AuthPage />
    default:
      return <Shell />
  }
}
