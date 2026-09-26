import type { Database } from 'better-sqlite3'
import { nowIso } from './utils'

const remoteMetadataKey = 'remote_metadata_enabled'

export const getAppSetting = (db: Database, key: string) => {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1')
    .get(key) as { value: string } | undefined

  return row?.value ?? null
}

export const setAppSetting = (db: Database, key: string, value: string | null) => {
  if (value == null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
    return
  }

  db.prepare(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(key, value, nowIso())
}

const parseBooleanFlag = (value: string | null | undefined) => {
  const normalized = value?.trim().toLowerCase()

  if (normalized && ['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }

  if (normalized && ['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return null
}

/**
 * Online metadata lookups send series titles (and book authors) to AniList and
 * Google Books. They are opt-in: an administrator enables them, or the
 * APP_REMOTE_METADATA environment variable forces the choice.
 */
export const getRemoteMetadataSetting = (db: Database) => {
  const environmentValue = parseBooleanFlag(process.env.APP_REMOTE_METADATA)

  if (environmentValue != null) {
    return { enabled: environmentValue, lockedByEnvironment: true }
  }

  return {
    enabled: parseBooleanFlag(getAppSetting(db, remoteMetadataKey)) ?? false,
    lockedByEnvironment: false,
  }
}

export const isRemoteMetadataEnabled = (db: Database) => getRemoteMetadataSetting(db).enabled

export const setRemoteMetadataEnabled = (db: Database, enabled: boolean) => {
  if (getRemoteMetadataSetting(db).lockedByEnvironment) {
    throw new Error('Online metadata is controlled by the APP_REMOTE_METADATA environment variable.')
  }

  setAppSetting(db, remoteMetadataKey, enabled ? '1' : '0')
}
