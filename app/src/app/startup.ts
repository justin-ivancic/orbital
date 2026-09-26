import { setDownloadsUser, stopDownloadsForSignOut } from './downloads'
import { initRouter } from './router'
import { bootSession, onSignOut, sessionStore, startSessionWatchers } from './session'
import { warmOfflineAssets } from './warmup'

let started = false

/** Starts routing, the session and background work. Called once from main. */
export const startApp = () => {
  if (started) {
    return
  }

  started = true
  initRouter()
  startSessionWatchers()
  onSignOut(() => stopDownloadsForSignOut())

  let downloadsUser: string | null | undefined
  const syncDownloadsUser = () => {
    const userId = sessionStore.get().user?.id ?? null

    if (userId !== downloadsUser) {
      downloadsUser = userId
      void setDownloadsUser(userId)
    }
  }

  sessionStore.subscribe(syncDownloadsUser)
  syncDownloadsUser()
  void bootSession().then(() => {
    if (sessionStore.get().phase === 'ready') {
      warmOfflineAssets()
    }
  })
}
