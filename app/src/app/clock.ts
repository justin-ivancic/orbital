import { createStore, useStore } from './store'

/** A minute clock so relative times ("5 minutes ago") stay pure during render. */
const clockStore = createStore({ now: Date.now() })

if (typeof window !== 'undefined') {
  window.setInterval(() => clockStore.set({ now: Date.now() }), 60_000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      clockStore.set({ now: Date.now() })
    }
  })
}

const selectNow = (state: { now: number }) => state.now

export const useNow = () => useStore(clockStore, selectNow)
