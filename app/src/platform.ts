import { Capacitor } from '@capacitor/core'

export const isNativeApp = Capacitor.isNativePlatform()
export const androidAppVersionCode = 25
export const androidAppVersionName = '2.0.0'

const serverUrlStorageKey = 'orbital:server-url'

/**
 * Normalizes what a person types as their server address into an origin plus
 * optional path prefix (`https://library.example.com`). Returns null for
 * anything that is not a plain http(s) URL.
 */
export const normalizeServerUrl = (input: string) => {
  const trimmed = input.trim()

  if (!trimmed) {
    return null
  }

  const withScheme = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(withScheme)

    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname) {
      return null
    }

    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

const readStoredServerUrl = () => {
  try {
    return typeof window === 'undefined'
      ? null
      : normalizeServerUrl(window.localStorage.getItem(serverUrlStorageKey) || '')
  } catch {
    return null
  }
}

// Self-hosters who build their own APK can bake in a default server; everyone
// else enters it on first launch.
const buildTimeServerUrl = normalizeServerUrl(String(import.meta.env?.VITE_ORBITAL_API_BASE_URL || ''))

let serverUrl = isNativeApp ? readStoredServerUrl() ?? buildTimeServerUrl ?? '' : ''

/** The server the native app talks to; empty in the web app (same origin). */
export const getServerUrl = () => serverUrl

export const needsServerUrl = () => isNativeApp && !serverUrl

export const setServerUrl = (value: string) => {
  const normalized = normalizeServerUrl(value)

  if (!normalized) {
    throw new Error('Enter the address of your Orbital server, for example https://library.example.com.')
  }

  serverUrl = normalized

  try {
    window.localStorage.setItem(serverUrlStorageKey, normalized)
  } catch {
    // The address still applies for this session.
  }

  return normalized
}

const localAppResourcePattern = /^(?:blob|capacitor|data|file):/i

export const isLocalAppResourceUrl = (input: string) => {
  if (localAppResourcePattern.test(input) || input.startsWith('/__orbital_offline/')) {
    return true
  }

  try {
    return new URL(input, 'https://orbital.invalid').hostname === 'localhost'
  } catch {
    return false
  }
}

export const resolveApiUrl = (input: string) => {
  if (/^[a-z][a-z\d+\-.]*:/i.test(input)) {
    return input
  }

  return `${serverUrl}${input}`
}

export const toNativeFileUrl = (filePath: string) => Capacitor.convertFileSrc(filePath)
