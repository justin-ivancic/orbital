import type { Database } from 'better-sqlite3'
import type { ReaderSettings, SessionUser } from '../src/appTypes.ts'
import { normalizeReaderSettings, readerSettingsForStyle } from '../src/readerSettings.ts'
import { nowIso } from './utils'

const normalizedSeriesId = (seriesId: string) => {
  const value = seriesId.trim()

  if (!value || value.length > 512) {
    throw new Error('Reader preference target was not found.')
  }

  return value
}

const assertSeriesExists = (db: Database, seriesId: string) => {
  const series = db
    .prepare('SELECT id FROM series WHERE id = ? LIMIT 1')
    .get(seriesId) as { id: string } | undefined

  if (!series) {
    throw new Error('Reader preference target was not found.')
  }
}

export const getReaderPreference = (
  db: Database,
  user: SessionUser,
  seriesId: string,
): ReaderSettings | null => {
  const targetSeriesId = normalizedSeriesId(seriesId)
  assertSeriesExists(db, targetSeriesId)

  const row = db
    .prepare(
      `
        SELECT settings_json
        FROM reader_preferences
        WHERE user_id = ? AND series_id = ?
        LIMIT 1
      `,
    )
    .get(user.id, targetSeriesId) as { settings_json: string } | undefined

  if (!row) {
    return null
  }

  try {
    return normalizeReaderSettings(JSON.parse(row.settings_json), readerSettingsForStyle('book'))
  } catch {
    return null
  }
}

export const saveReaderPreference = (
  db: Database,
  user: SessionUser,
  seriesId: string,
  settings: unknown,
): ReaderSettings => {
  const targetSeriesId = normalizedSeriesId(seriesId)
  assertSeriesExists(db, targetSeriesId)
  const normalizedSettings = normalizeReaderSettings(settings, readerSettingsForStyle('book'))

  db.prepare(
    `
      INSERT INTO reader_preferences (user_id, series_id, settings_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, series_id) DO UPDATE SET
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at
    `,
  ).run(user.id, targetSeriesId, JSON.stringify(normalizedSettings), nowIso())

  return normalizedSettings
}
