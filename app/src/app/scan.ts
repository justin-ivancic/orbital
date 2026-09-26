import { useEffect } from 'react'
import { api } from '../api'
import type { ScanStatus } from '../appTypes'
import { isNativeApp, resolveApiUrl } from '../platform'
import { libraryStore, setScanStatus } from './library'
import { refreshState } from './session'

let pollUntil = 0
let pollTimer: ReturnType<typeof setTimeout> | null = null
let watchers = 0

const handleStatus = (status: ScanStatus) => {
  const wasActive = libraryStore.get().scanStatus.active
  setScanStatus(status)

  if (wasActive && !status.active) {
    // A finished scan changes the library; fetch the new state.
    void refreshState().catch(() => undefined)
  }
}

const poll = async () => {
  pollTimer = null

  try {
    const { scanStatus } = await api.getScanStatus()
    handleStatus(scanStatus)
  } catch {
    // The next poll tries again.
  }

  if (watchers > 0 && (libraryStore.get().scanStatus.active || Date.now() < pollUntil)) {
    pollTimer = setTimeout(() => void poll(), libraryStore.get().scanStatus.active ? 1500 : 2500)
  }
}

/** Polls quickly for a while, for example right after starting a scan. */
export const watchScanClosely = (durationMs = 60_000) => {
  pollUntil = Math.max(pollUntil, Date.now() + durationMs)

  if (!pollTimer) {
    pollTimer = setTimeout(() => void poll(), 800)
  }
}

/**
 * Follows the scan while an admin page is open: a server-sent event stream in
 * the web app, polling in the native app (which cannot add auth headers to
 * EventSource).
 */
export const useScanStatusStream = () => {
  useEffect(() => {
    watchers += 1
    let source: EventSource | null = null

    if (!isNativeApp && typeof EventSource !== 'undefined') {
      source = new EventSource(resolveApiUrl('/api/admin/scan/events'), { withCredentials: true })
      source.addEventListener('status', (event) => {
        try {
          handleStatus(JSON.parse((event as MessageEvent<string>).data) as ScanStatus)
        } catch {
          // Ignore a malformed event; the next one replaces it.
        }
      })
      source.addEventListener('error', () => watchScanClosely(30_000))
    } else {
      watchScanClosely(5_000)
    }

    if (libraryStore.get().scanStatus.active) {
      watchScanClosely()
    }

    return () => {
      watchers -= 1
      source?.close()

      if (watchers === 0 && pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
    }
  }, [])
}
