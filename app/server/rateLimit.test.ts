import assert from 'node:assert/strict'
import test from 'node:test'
import type { Database } from 'better-sqlite3'
import {
  assertRateLimitAllowed,
  clearRateLimitBuckets,
  consumeRateLimit,
  createRateLimitKey,
  pruneRateLimitBuckets,
  RateLimitError,
  recordRateLimitFailure,
} from './rateLimit.ts'

type MemoryRateLimitBucket = {
  key: string
  points: number
  window_reset_at: number
  blocked_until: number
  updated_at: string
}

class MemoryRateLimitDatabase {
  buckets = new Map<string, MemoryRateLimitBucket>()

  prepare(sql: string) {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim()

    if (normalizedSql.startsWith('SELECT points, window_reset_at, blocked_until FROM rate_limit_buckets')) {
      return {
        get: (key: string) => {
          const bucket = this.buckets.get(key)

          if (!bucket) {
            return undefined
          }

          return {
            points: bucket.points,
            window_reset_at: bucket.window_reset_at,
            blocked_until: bucket.blocked_until,
          }
        },
      }
    }

    if (normalizedSql.startsWith('DELETE FROM rate_limit_buckets WHERE key = ?')) {
      return {
        run: (key: string) => {
          const deleted = this.buckets.delete(key)
          return { changes: deleted ? 1 : 0 }
        },
      }
    }

    if (normalizedSql.startsWith('DELETE FROM rate_limit_buckets WHERE window_reset_at <= ?')) {
      return {
        run: (windowResetAt: number, blockedUntil: number) => {
          let changes = 0

          for (const bucket of this.buckets.values()) {
            if (bucket.window_reset_at <= windowResetAt && bucket.blocked_until <= blockedUntil) {
              this.buckets.delete(bucket.key)
              changes += 1
            }
          }

          return { changes }
        },
      }
    }

    if (normalizedSql.startsWith('INSERT INTO rate_limit_buckets')) {
      return {
        run: (
          key: string,
          points: number,
          windowResetAt: number,
          blockedUntil: number,
          updatedAt: string,
        ) => {
          this.buckets.set(key, {
            key,
            points,
            window_reset_at: windowResetAt,
            blocked_until: blockedUntil,
            updated_at: updatedAt,
          })

          return { changes: 1 }
        },
      }
    }

    throw new Error(`Unhandled rate-limit SQL in test: ${normalizedSql}`)
  }

  transaction<T extends unknown[], R>(callback: (...args: T) => R) {
    return (...args: T) => callback(...args)
  }
}

const createTestDatabase = () => new MemoryRateLimitDatabase() as unknown as Database

test('rate limit buckets block after configured failed attempts and expire cleanly', () => {
  const db = createTestDatabase()
  const policy = {
    limit: 2,
    windowMs: 1_000,
    blockMs: 5_000,
  }
  const key = createRateLimitKey('login-username', 'Alice', '127.0.0.1')

  recordRateLimitFailure(db, key, policy, 1_000)
  recordRateLimitFailure(db, key, policy, 1_100)

  assert.doesNotThrow(() => assertRateLimitAllowed(db, key, 1_200))
  assert.throws(() => recordRateLimitFailure(db, key, policy, 1_300), RateLimitError)
  assert.throws(() => assertRateLimitAllowed(db, key, 2_000), RateLimitError)

  assert.doesNotThrow(() => assertRateLimitAllowed(db, key, 6_400))
})

test('rate limit keys are normalized and can be cleared after successful auth', () => {
  const db = createTestDatabase()
  const policy = {
    limit: 1,
    windowMs: 60_000,
    blockMs: 60_000,
  }
  const firstKey = createRateLimitKey('login-username', ' Alice ', '::1')
  const secondKey = createRateLimitKey('login-username', 'alice', '::1')

  assert.equal(firstKey, secondKey)
  consumeRateLimit(db, firstKey, policy, 1_000)
  assert.throws(() => consumeRateLimit(db, secondKey, policy, 1_100), RateLimitError)

  clearRateLimitBuckets(db, [secondKey])
  assert.doesNotThrow(() => assertRateLimitAllowed(db, firstKey, 1_200))
})

test('expired buckets can be pruned without touching active blocks', () => {
  const db = createTestDatabase()
  const expiredKey = createRateLimitKey('signup-ip', 'expired')
  const activeKey = createRateLimitKey('signup-ip', 'active')
  const blockedKey = createRateLimitKey('signup-ip', 'blocked')

  recordRateLimitFailure(db, expiredKey, { limit: 5, windowMs: 100, blockMs: 100 }, 1_000)
  recordRateLimitFailure(db, activeKey, { limit: 5, windowMs: 10_000, blockMs: 100 }, 1_000)
  assert.throws(
    () => recordRateLimitFailure(db, blockedKey, { limit: 0, windowMs: 100, blockMs: 10_000 }, 1_000),
    RateLimitError,
  )

  pruneRateLimitBuckets(db, 1_500)

  assert.doesNotThrow(() => assertRateLimitAllowed(db, expiredKey, 1_500))
  assert.doesNotThrow(() => assertRateLimitAllowed(db, activeKey, 1_500))
  assert.throws(() => assertRateLimitAllowed(db, blockedKey, 1_500), RateLimitError)
})
