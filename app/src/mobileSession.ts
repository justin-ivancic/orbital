import { Capacitor, registerPlugin } from '@capacitor/core'

const SecureSession = registerPlugin<{
  get: () => Promise<{ token: string | null }>
  set: (options: { token: string }) => Promise<void>
  clear: () => Promise<void>
}>('SecureSession')

export type MobileSession = {
  accessToken: string
  expiresAt: number
}

let session: MobileSession | null = null
let loadPromise: Promise<void> | null = null

const isNative = () => Capacitor.isNativePlatform()

const load = async () => {
  if (!isNative() || session) {
    return
  }

  const stored = await SecureSession.get()
  if (!stored.token) {
    return
  }

  try {
    session = JSON.parse(atob(stored.token)) as MobileSession
  } catch {
    await SecureSession.clear()
  }
}

export const ensureMobileSessionLoaded = async () => {
  if (!loadPromise) {
    loadPromise = load()
  }

  await loadPromise
}

export const getMobileSession = () => session

export const saveMobileSession = async (nextSession: MobileSession) => {
  session = nextSession

  if (isNative()) {
    await SecureSession.set({
      token: btoa(JSON.stringify(nextSession)),
    })
  }
}

export const clearMobileSession = async () => {
  session = null

  if (isNative()) {
    await SecureSession.clear()
  }
}
