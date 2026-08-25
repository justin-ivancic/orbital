import { Capacitor } from '@capacitor/core'

export const isNativeApp = Capacitor.isNativePlatform()
export const androidAppVersionCode = 22
export const androidAppVersionName = '1.21'

const configuredApiBaseUrl = String(import.meta.env?.VITE_ORBITAL_API_BASE_URL || '').trim()
const defaultApiBaseUrl = 'https://library.justinivancic.com'

export const apiBaseUrl = isNativeApp
  ? (configuredApiBaseUrl || defaultApiBaseUrl).replace(/\/$/, '')
  : ''

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

  return `${apiBaseUrl}${input}`
}

export const toNativeFileUrl = (filePath: string) => Capacitor.convertFileSrc(filePath)
