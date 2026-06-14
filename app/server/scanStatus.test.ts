import assert from 'node:assert/strict'
import test from 'node:test'
import type { Database } from 'better-sqlite3'
import { getLatestScanStatus, markInterruptedScans } from './library.ts'

type MemoryScanRun = {
  id: string
  started_at: string
  finished_at: string | null
  status: string
  summary: string
}

type MemoryScanEvent = {
  id: string
  scan_run_id: string
  level: 'info' | 'success' | 'error'
  message: string
  created_at: string
}

class MemoryScanDatabase {
  scanRuns: MemoryScanRun[] = []
  scanEvents: MemoryScanEvent[] = []

  prepare(sql: string) {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim()

    if (normalizedSql.startsWith('SELECT id FROM scan_runs WHERE status =')) {
      return {
        all: () =>
          this.scanRuns
            .filter((run) => run.status === 'running')
            .map((run) => ({ id: run.id })),
      }
    }

    if (normalizedSql.startsWith('INSERT INTO scan_events')) {
      return {
        run: (
          id: string,
          scanRunId: string,
          level: MemoryScanEvent['level'],
          message: string,
          createdAt: string,
        ) => {
          this.scanEvents.push({
            id,
            scan_run_id: scanRunId,
            level,
            message,
            created_at: createdAt,
          })

          return { changes: 1 }
        },
      }
    }

    if (normalizedSql.startsWith('UPDATE scan_runs SET finished_at = ?, status =')) {
      return {
        run: (finishedAt: string, summary: string, scanRunId: string) => {
          const run = this.scanRuns.find((item) => item.id === scanRunId)

          if (!run) {
            return { changes: 0 }
          }

          run.finished_at = finishedAt
          run.status = 'error'
          run.summary = summary
          return { changes: 1 }
        },
      }
    }

    if (normalizedSql.startsWith('SELECT id, started_at, finished_at, status, summary FROM scan_runs')) {
      return {
        get: () =>
          this.scanRuns
            .slice()
            .sort((left, right) => right.started_at.localeCompare(left.started_at))[0],
      }
    }

    if (normalizedSql.startsWith('SELECT id, level, message, created_at FROM scan_events')) {
      return {
        all: (scanRunId: string) =>
          this.scanEvents
            .filter((event) => event.scan_run_id === scanRunId)
            .sort((left, right) => right.created_at.localeCompare(left.created_at))
            .slice(0, 120)
            .map((event) => ({
              id: event.id,
              level: event.level,
              message: event.message,
              created_at: event.created_at,
            })),
      }
    }

    throw new Error(`Unhandled scan-status SQL in test: ${normalizedSql}`)
  }
}

const createTestDatabase = () => new MemoryScanDatabase()

test('latest scan status includes durable events in display order', () => {
  const memoryDb = createTestDatabase()
  const db = memoryDb as unknown as Database

  memoryDb.scanRuns.push({
    id: 'scan_1',
    started_at: '2026-06-14T10:00:00.000Z',
    finished_at: '2026-06-14T10:01:00.000Z',
    status: 'success',
    summary: '1 source folder scanned',
  })
  memoryDb.scanEvents.push(
    {
      id: 'event_2',
      scan_run_id: 'scan_1',
      level: 'success',
      message: 'Finished source',
      created_at: '2026-06-14T10:00:20.000Z',
    },
    {
      id: 'event_1',
      scan_run_id: 'scan_1',
      level: 'info',
      message: 'Scanning source',
      created_at: '2026-06-14T10:00:10.000Z',
    },
  )

  const status = getLatestScanStatus(db)

  assert.equal(status.active, false)
  assert.equal(status.runId, 'scan_1')
  assert.deepEqual(status.events.map((event) => event.id), ['event_1', 'event_2'])
})

test('interrupted running scans are marked as errored on startup', () => {
  const memoryDb = createTestDatabase()
  const db = memoryDb as unknown as Database

  memoryDb.scanRuns.push({
    id: 'scan_running',
    started_at: '2026-06-14T10:00:00.000Z',
    finished_at: null,
    status: 'running',
    summary: '',
  })

  markInterruptedScans(db)
  const status = getLatestScanStatus(db)

  assert.equal(status.active, false)
  assert.equal(status.runId, 'scan_running')
  assert.equal(status.summary, 'Scan was interrupted before completion.')
  assert.equal(status.events.at(-1)?.level, 'error')
  assert.equal(status.events.at(-1)?.message, 'Scan was interrupted before completion.')
})
