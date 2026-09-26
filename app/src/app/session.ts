import { ApiError, api, isNetworkError } from '../api'
import type { AppState, AuthPayload, BootstrapState, SessionUser } from '../appTypes'
import { clearImageCache } from '../imageCache'
import { getLastOfflineProfile } from '../offlineStorage'
import { needsServerUrl } from '../platform'
import { isProtectedRoute, appRoutePath } from '../routing'
import { cacheClear } from './cache'
import { connectionStore, isOffline, setOffline } from './connection'
import {
  applyServerState,
  clearLibraryCache,
  libraryStore,
  resetLibrary,
  restoreLibraryCache,
} from './library'
import { notify } from './notices'
import { discardPendingProgress, flushProgress, loadPendingProgress, pendingOverlay } from './progress'
import { currentRoute, navigate } from './router'
import { clearSeriesCache } from './series'
import { createStore, useStore } from './store'
import { currentStrings } from '../i18n'

export type SessionPhase = 'booting' | 'connect' | 'signedOut' | 'ready'

export type SessionState = {
  phase: SessionPhase
  appName: string
  openSignup: boolean
  user: SessionUser | null
  /** Shown on the sign-in screen (for example when the server is unreachable). */
  authError: string | null
}

export const sessionStore = createStore<SessionState>({
  phase: 'booting',
  appName: 'Orbital',
  openSignup: false,
  user: null,
  authError: null,
})

const lastUserKey = 'orbital:last-user'

const rememberUser = (user: SessionUser | null) => {
  try {
    if (user) {
      window.localStorage.setItem(lastUserKey, JSON.stringify(user))
    } else {
      window.localStorage.removeItem(lastUserKey)
    }
  } catch {
    // Offline start-up simply needs a connection when storage is unavailable.
  }
}

const readRememberedUser = (): SessionUser | null => {
  try {
    const raw = window.localStorage.getItem(lastUserKey)
    const user = raw ? (JSON.parse(raw) as SessionUser) : null
    return user && typeof user.id === 'string' && typeof user.username === 'string' ? user : null
  } catch {
    return null
  }
}

const applyBootstrap = (bootstrap: BootstrapState) => {
  api.setCsrfToken(bootstrap.csrfToken)
  sessionStore.update({
    appName: bootstrap.appName || 'Orbital',
    openSignup: bootstrap.openSignup,
  })
}

const enterSignedIn = (user: SessionUser) => {
  const previousOwner = libraryStore.get().ownerId

  if (previousOwner && previousOwner !== user.id) {
    resetLibrary(user.id)
    clearSeriesCache()
    api.setKnownLibraryRevision(null)
  }

  loadPendingProgress(user.id)
  rememberUser(user)
  sessionStore.update({ phase: 'ready', user, authError: null })
}

/** Applies a full state response (sign-in, refresh, admin actions). */
export const applyState = (state: AppState) => {
  api.setCsrfToken(state.csrfToken)

  if (!state.user) {
    return
  }

  enterSignedIn(state.user)
  applyServerState(state, pendingOverlay())
  api.setKnownLibraryRevision(libraryStore.get().revision)
}

let refreshInFlight: Promise<boolean> | null = null

/** Fetches fresh state. Returns false when the server could not be reached. */
export const refreshState = () => {
  if (refreshInFlight) {
    return refreshInFlight
  }

  refreshInFlight = (async () => {
    try {
      api.setKnownLibraryRevision(libraryStore.get().revision)
      const state = await api.getState()
      applyState(state)
      setOffline(false)
      void flushProgress()
      return true
    } catch (error) {
      if (isNetworkError(error)) {
        setOffline(true)
        return false
      }

      throw error
    } finally {
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

const startOffline = async (user: SessionUser) => {
  loadPendingProgress(user.id)
  await restoreLibraryCache(user.id)
  libraryStore.update({ ownerId: user.id, loaded: true })
  setOffline(true)
  sessionStore.update({ phase: 'ready', user, authError: null })
}

export const bootSession = async () => {
  if (needsServerUrl()) {
    sessionStore.update({ phase: 'connect' })
    return
  }

  const remembered = readRememberedUser()

  if (remembered) {
    // Show the cached library right away; the server confirms it below.
    const restored = await restoreLibraryCache(remembered.id)

    if (restored) {
      loadPendingProgress(remembered.id)
      api.setKnownLibraryRevision(libraryStore.get().revision)
      sessionStore.update({ phase: 'ready', user: remembered })
    }
  }

  let bootstrap: BootstrapState

  try {
    bootstrap = await api.getBootstrap()
  } catch (error) {
    const offlineUser = remembered ?? (await getLastOfflineProfile().catch(() => null))

    if (offlineUser && isNetworkError(error)) {
      await startOffline(offlineUser)
      return
    }

    sessionStore.update({
      phase: 'signedOut',
      user: null,
      authError: isNetworkError(error)
        ? currentStrings().auth.cantReachServer
        : error instanceof Error
          ? error.message
          : currentStrings().common.somethingWentWrong,
    })
    return
  }

  applyBootstrap(bootstrap)

  if (!bootstrap.user) {
    sessionStore.update({ phase: 'signedOut', user: null })
    return
  }

  enterSignedIn(bootstrap.user)
  setOffline(false)

  try {
    await refreshState()
  } catch (error) {
    notify(error instanceof Error ? error.message : currentStrings().common.somethingWentWrong, 'error')
  }
}

export const login = async (payload: AuthPayload, mode: 'login' | 'signup') => {
  const state = mode === 'signup' ? await api.signup(payload) : await api.login(payload)
  setOffline(false)
  applyState(state)
}

const clearUserData = async (userId: string | null) => {
  if (userId) {
    discardPendingProgress(userId)
    await Promise.all([
      clearLibraryCache(userId).catch(() => undefined),
      clearImageCache(userId).catch(() => undefined),
    ])
  }

  rememberUser(null)
  resetLibrary()
  clearSeriesCache()
  api.setKnownLibraryRevision(null)
}

type SignOutListener = (userId: string | null) => Promise<void> | void
const signOutListeners = new Set<SignOutListener>()

/** Lets other modules (downloads) stop their work before a sign-out. */
export const onSignOut = (listener: SignOutListener) => {
  signOutListeners.add(listener)
  return () => {
    signOutListeners.delete(listener)
  }
}

export const logout = async () => {
  const userId = sessionStore.get().user?.id ?? null
  await flushProgress().catch(() => undefined)
  await Promise.all([...signOutListeners].map((listener) => Promise.resolve(listener(userId)).catch(() => undefined)))
  await api.logout().catch(() => undefined)
  await clearUserData(userId)
  api.setCsrfToken(null)
  sessionStore.update({ phase: 'signedOut', user: null, authError: null })
  navigate({ name: 'login', next: null }, { replace: true })
}

/** Called when the server rejects the session (expired or revoked). */
const handleUnauthorized = () => {
  const session = sessionStore.get()

  if (session.phase !== 'ready' || isOffline()) {
    return
  }

  void api.forgetSession()
  api.setCsrfToken(null)
  sessionStore.update({ phase: 'signedOut', user: null, authError: currentStrings().connection.sessionExpired })
  const route = currentRoute()
  navigate(
    { name: 'login', next: isProtectedRoute(route) && route.name !== 'home' ? appRoutePath(route) : null },
    { replace: true },
  )
}

export const reconnect = async () => {
  if (connectionStore.get().reconnecting) {
    return false
  }

  connectionStore.update({ reconnecting: true })

  try {
    const bootstrap = await api.getBootstrap({ timeoutMs: 10_000 })
    applyBootstrap(bootstrap)

    if (!bootstrap.user) {
      setOffline(false)
      handleUnauthorized()
      return true
    }

    enterSignedIn(bootstrap.user)
    const online = await refreshState()
    return online
  } catch (error) {
    if (isNetworkError(error)) {
      setOffline(true)
      return false
    }

    throw error
  } finally {
    connectionStore.update({ reconnecting: false })
  }
}

/** Removes every cached library copy on this device and reloads. */
export const resetDeviceCache = async () => {
  await flushProgress().catch(() => undefined)
  await cacheClear()

  if ('caches' in window) {
    const names = await window.caches.keys().catch(() => [] as string[])
    await Promise.all(names.map((name) => window.caches.delete(name).catch(() => false)))
  }

  const url = new URL(window.location.href)
  url.searchParams.set('refreshed', String(Date.now()))
  window.location.replace(url.toString())
}

let lastHiddenAt = 0
let offlineRetryTimer: ReturnType<typeof setInterval> | null = null

export const startSessionWatchers = () => {
  api.onUnauthorized(handleUnauthorized)

  window.addEventListener('online', () => {
    if (isOffline()) {
      void reconnect().then((online) => {
        if (online) {
          notify(currentStrings().connection.backOnline)
        }
      }).catch(() => undefined)
    }
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      lastHiddenAt = Date.now()
      return
    }

    // Picking the device up again after a while: make the home screen current.
    if (sessionStore.get().phase === 'ready' && lastHiddenAt && Date.now() - lastHiddenAt > 5 * 60 * 1000) {
      void (isOffline() ? reconnect() : refreshState()).catch(() => undefined)
    }
  })

  // While offline, quietly check for the server once a minute.
  connectionStore.subscribe(() => {
    const offline = isOffline()

    if (offline && !offlineRetryTimer) {
      offlineRetryTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && sessionStore.get().phase === 'ready') {
          void reconnect().then((online) => {
            if (online) {
              notify(currentStrings().connection.backOnline)
            }
          }).catch(() => undefined)
        }
      }, 60_000)
    } else if (!offline && offlineRetryTimer) {
      clearInterval(offlineRetryTimer)
      offlineRetryTimer = null
    }
  })
}

export const isAuthError = (error: unknown) => error instanceof ApiError && error.status === 401

const selectSession = (state: SessionState) => state
const selectUser = (state: SessionState) => state.user

export const useSession = () => useStore(sessionStore, selectSession)
export const useUser = () => useStore(sessionStore, selectUser)
export const currentUser = () => sessionStore.get().user
