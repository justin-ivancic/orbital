import { createStore, useStore } from './store'

export type ConnectionState = {
  /** The server could not be reached; the app runs from cached data and downloads. */
  offline: boolean
  reconnecting: boolean
}

export const connectionStore = createStore<ConnectionState>({
  offline: false,
  reconnecting: false,
})

export const setOffline = (offline: boolean) => {
  connectionStore.update({ offline })
}

export const isOffline = () => connectionStore.get().offline

const selectOffline = (state: ConnectionState) => state.offline
const selectConnection = (state: ConnectionState) => state

export const useOffline = () => useStore(connectionStore, selectOffline)
export const useConnection = () => useStore(connectionStore, selectConnection)
