import { Capacitor } from '@capacitor/core'

export const isNativeApp = Capacitor.isNativePlatform()
export const androidAppVersionCode = 11
export const androidAppVersionName = '1.10'

const configuredApiBaseUrl = String(import.meta.env.VITE_ORBITAL_API_BASE_URL || '').trim()
const defaultApiBaseUrl = 'https://library.justinivancic.com'

export const apiBaseUrl = isNativeApp
  ? (configuredApiBaseUrl || defaultApiBaseUrl).replace(/\/$/, '')
  : ''

export const resolveApiUrl = (input: string) => {
  if (/^[a-z][a-z\d+\-.]*:/i.test(input)) {
    return input
  }

  return `${apiBaseUrl}${input}`
}

export const toNativeFileUrl = (filePath: string) => Capacitor.convertFileSrc(filePath)
