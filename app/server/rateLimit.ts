import crypto from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { nowIso } from './utils'

export type RateLimitPolicy = {
  limit: number
  windowMs: number
  blockMs: number
}

type RateLimitBucket = {
  points: number
  window_reset_at: number
  blocked_until: number
}

export class RateLimitError extends Error {
  retryAfterMs: number

  constructor(retryAfterMs: number) {
    super(`Too many attempts. Try again in ${formatRetryDelay(retryAfterMs)}.`)
    this.name = 'RateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

const formatRetryDelay = (retryAfterMs: number) => {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))

  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`
  }

  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

const normalizeKeyPart = (value: string | number | null | undefined) => {
  const normalized = String(value ?? 'blank').trim().toLowerCase().replace(/\s+/g, ' ')

  return normalized.slice(0, 160) || 'blank'
}

export const createRateLimitKey = (
  scope: string,
  ...parts: Array<string | number | null | undefined>
) => {
  const hash = crypto
    .createHash('sha256')
    .update(parts.map(normalizeKeyPart).join('\0'))
    .digest('hex')

  return `${scope}:${hash}`
}

const getBucket = (db: Database, key: string) =>
  db
    .prepare(
      `
        SELECT points, window_reset_at, blocked_until
        FROM rate_limit_buckets
        WHERE key = ?
      `,
    )
    .get(key) as RateLimitBucket | undefined

const resetExpiredBucket = (
  db: Database,
  key: string,
  bucket: RateLimitBucket | undefined,
  now: number,
) => {
  if (!bucket) {
    return null
  }

  if (bucket.window_reset_at <= now && bucket.blocked_until <= now) {
    db.prepare(`DELETE FROM rate_limit_buckets WHERE key = ?`).run(key)
    return null
  }

  return bucket
}

const throwIfBlocked = (bucket: RateLimitBucket | null, now: number) => {
  if (bucket && bucket.blocked_until > now) {
    throw new RateLimitError(bucket.blocked_until - now)
  }
}

export const assertRateLimitAllowed = (db: Database, key: string, now = Date.now()) => {
  const bucket = resetExpiredBucket(db, key, getBucket(db, key), now)
  throwIfBlocked(bucket, now)
}

export const recordRateLimitFailure = (
  db: Database,
  key: string,
  policy: RateLimitPolicy,
  now = Date.now(),
) => {
  const bucket = resetExpiredBucket(db, key, getBucket(db, key), now)
  throwIfBlocked(bucket, now)

  const nextPoints = bucket ? bucket.points + 1 : 1
  const windowResetAt = bucket?.window_reset_at && bucket.window_reset_at > now
    ? bucket.window_reset_at
    : now + policy.windowMs
  const blockedUntil = nextPoints > policy.limit ? now + policy.blockMs : 0

  db.prepare(
    `
      INSERT INTO rate_limit_buckets (key, points, window_reset_at, blocked_until, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        points = excluded.points,
        window_reset_at = excluded.window_reset_at,
        blocked_until = excluded.blocked_until,
        updated_at = excluded.updated_at
    `,
  ).run(key, nextPoints, windowResetAt, blockedUntil, nowIso())

  if (blockedUntil > now) {
    throw new RateLimitError(blockedUntil - now)
  }
}

export const consumeRateLimit = (
  db: Database,
  key: string,
  policy: RateLimitPolicy,
  now = Date.now(),
) => {
  assertRateLimitAllowed(db, key, now)
  recordRateLimitFailure(db, key, policy, now)
}

export const clearRateLimitBuckets = (db: Database, keys: string[]) => {
  if (!keys.length) {
    return
  }

  const statement = db.prepare(`DELETE FROM rate_limit_buckets WHERE key = ?`)
  const deleteBuckets = db.transaction((bucketKeys: string[]) => {
    for (const key of bucketKeys) {
      statement.run(key)
    }
  })

  deleteBuckets(keys)
}

export const pruneRateLimitBuckets = (db: Database, now = Date.now()) => {
  db.prepare(
    `
      DELETE FROM rate_limit_buckets
      WHERE window_reset_at <= ? AND blocked_until <= ?
    `,
  ).run(now, now)
}
