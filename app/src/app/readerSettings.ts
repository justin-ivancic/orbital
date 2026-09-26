import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CategoryId, EntryFormat, ReaderSettings } from '../appTypes'
import { defaultReaderSettings, normalizeReaderSettings, settingsForFormat } from '../readerSettings'
import { isOffline } from './connection'

/**
 * Page settings (layout, fit, direction, spreads) are remembered per title and
 * synced to the account. A local copy makes the reader open with them instantly.
 */

const storageKey = (seriesId: string) => `orbital:reader-settings:${seriesId}`

const readLocal = (seriesId: string, fallback: ReaderSettings) => {
  try {
    const raw = window.localStorage.getItem(storageKey(seriesId))
    return raw ? normalizeReaderSettings(JSON.parse(raw), fallback) : null
  } catch {
    return null
  }
}

const writeLocal = (seriesId: string, settings: ReaderSettings) => {
  try {
    window.localStorage.setItem(storageKey(seriesId), JSON.stringify(settings))
  } catch {
    // Settings still apply for this session.
  }
}

export const useSeriesReaderSettings = (seriesId: string, category: CategoryId, format: EntryFormat) => {
  const [stored, setStored] = useState<{ seriesId: string; settings: ReaderSettings }>(() => ({
    seriesId,
    settings: readLocal(seriesId, defaultReaderSettings(category, format)) ?? defaultReaderSettings(category, format),
  }))
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<ReaderSettings | null>(null)
  const current =
    stored.seriesId === seriesId
      ? stored.settings
      : readLocal(seriesId, defaultReaderSettings(category, format)) ?? defaultReaderSettings(category, format)

  useEffect(() => {
    if (isOffline()) {
      return
    }

    let cancelled = false

    void api
      .getReaderPreference(seriesId)
      .then((response) => {
        if (cancelled || !response.preference) {
          return
        }

        const settings = normalizeReaderSettings(response.preference, defaultReaderSettings(category, format))
        writeLocal(seriesId, settings)
        setStored({ seriesId, settings })
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [category, format, seriesId])

  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
      }

      if (pending.current) {
        void api.setReaderPreference(seriesId, pending.current, { keepalive: true }).catch(() => undefined)
        pending.current = null
      }
    },
    [seriesId],
  )

  const update = useCallback(
    (next: ReaderSettings) => {
      const settings = normalizeReaderSettings(next, defaultReaderSettings(category, format))
      writeLocal(seriesId, settings)
      setStored({ seriesId, settings })
      pending.current = settings

      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
      }

      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        const toSave = pending.current
        pending.current = null

        if (toSave && !isOffline()) {
          void api.setReaderPreference(seriesId, toSave).catch(() => undefined)
        }
      }, 800)
    },
    [category, format, seriesId],
  )

  return [settingsForFormat(current, category, format), update] as const
}
