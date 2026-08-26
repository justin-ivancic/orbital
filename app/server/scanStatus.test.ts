import assert from 'node:assert/strict'
import test from 'node:test'
import type { Database } from 'better-sqlite3'
import { getLatestScanStatus, markInterruptedScans } from './library.ts'

type MemoryScanRun = {
  id: string
  started_at: string
  finished_at: string | null
  status: string
  requested_source_id: string | null
  resume_attempt: number
  heartbeat_at: string | null
  lineage_id: string | null
  current_source_id: string | null
  current_series_key: string | null
  current_series_title: string | null
  summary: string
}

type MemoryScanEvent = {
  id: string
  scan_run_id: string
  level: 'info' | 'success' | 'error'
  message: string
  created_at: string
}

type MemorySourceFolder = {
  id: string
  last_scan_status: string
  updated_at: string | null
}

type MemorySeriesCheckpoint = {
  lineage_id: string
  source_folder_id: string
  series_key: string
  status: 'running' | 'completed' | 'failed' | 'quarantined'
  failure_count: number
  last_error: string | null
  updated_at: string
}

class MemoryScanDatabase {
  scanRuns: MemoryScanRun[] = []
  scanEvents: MemoryScanEvent[] = []
  sourceFolders: MemorySourceFolder[] = []
  checkpoints: MemorySeriesCheckpoint[] = []

  prepare(sql: string) {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim()

    if (normalizedSql.startsWith('SELECT id, requested_source_id, resume_attempt, lineage_id,')) {
      return {
        all: () =>
          this.scanRuns
            .filter((run) => run.status === 'running')
            .map((run) => ({
              id: run.id,
              requested_source_id: run.requested_source_id,
              resume_attempt: run.resume_attempt,
              lineage_id: run.lineage_id,
              current_source_id: run.current_source_id,
              current_series_key: run.current_series_key,
              current_series_title: run.current_series_title,
            })),
      }
    }

    if (normalizedSql.startsWith('SELECT failure_count FROM scan_series_checkpoints')) {
      return {
        get: (lineageId: string, sourceFolderId: string, seriesKey: string) =>
          this.checkpoints.find(
            (checkpoint) =>
              checkpoint.lineage_id === lineageId &&
              checkpoint.source_folder_id === sourceFolderId &&
              checkpoint.series_key === seriesKey,
          ),
      }
    }

    if (normalizedSql.startsWith('UPDATE scan_series_checkpoints SET status =')) {
      return {
        run: (
          status: MemorySeriesCheckpoint['status'],
          failureCount: number,
          lastError: string,
          updatedAt: string,
          lineageId: string,
          sourceFolderId: string,
          seriesKey: string,
        ) => {
          const checkpoint = this.checkpoints.find(
            (item) =>
              item.lineage_id === lineageId &&
              item.source_folder_id === sourceFolderId &&
              item.series_key === seriesKey,
          )
          if (!checkpoint) {
            return { changes: 0 }
          }
          checkpoint.status = status
          checkpoint.failure_count = failureCount
          checkpoint.last_error = lastError
          checkpoint.updated_at = updatedAt
          return { changes: 1 }
        },
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

    if (normalizedSql.startsWith('UPDATE source_folders SET last_scan_status =')) {
      return {
        run: (updatedAt: string) => {
          for (const sourceFolder of this.sourceFolders) {
            if (sourceFolder.last_scan_status === 'Scanning') {
              sourceFolder.last_scan_status = 'Error'
              sourceFolder.updated_at = updatedAt
            }
          }

          return { changes: 1 }
        },
      }
    }

    if (normalizedSql.startsWith('UPDATE scan_runs SET finished_at = ?, status =')) {
      return {
        run: (finishedAt: string, summary: string, heartbeatAt: string, scanRunId: string) => {
          const run = this.scanRuns.find((item) => item.id === scanRunId)

          if (!run) {
            return { changes: 0 }
          }

          run.finished_at = finishedAt
          run.status = 'error'
          run.heartbeat_at = heartbeatAt
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
    requested_source_id: null,
    resume_attempt: 0,
    heartbeat_at: '2026-06-14T10:01:00.000Z',
    lineage_id: 'scan_1',
    current_source_id: null,
    current_series_key: null,
    current_series_title: null,
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
    requested_source_id: 'source_1',
    resume_attempt: 0,
    heartbeat_at: '2026-06-14T10:00:30.000Z',
    lineage_id: 'lineage_1',
    current_source_id: 'source_1',
    current_series_key: 'series_1',
    current_series_title: 'Problematic series',
    summary: '',
  })
  memoryDb.checkpoints.push({
    lineage_id: 'lineage_1',
    source_folder_id: 'source_1',
    series_key: 'series_1',
    status: 'running',
    failure_count: 0,
    last_error: null,
    updated_at: '2026-06-14T10:00:30.000Z',
  })
  memoryDb.sourceFolders.push({
    id: 'source_1',
    last_scan_status: 'Scanning',
    updated_at: null,
  })

  const resumptions = markInterruptedScans(db)
  const status = getLatestScanStatus(db)

  assert.equal(status.active, false)
  assert.equal(status.runId, 'scan_running')
  assert.match(status.summary || '', /^Scan was interrupted before completion;/)
  assert.equal(status.events.at(-1)?.level, 'error')
  assert.match(status.events.at(-1)?.message || '', /^Scan was interrupted before completion;/)
  assert.deepEqual(resumptions, [{
    runId: 'scan_running',
    lineageId: 'lineage_1',
    sourceId: 'source_1',
    resumeAttempt: 0,
    shouldResume: true,
  }])
  assert.equal(memoryDb.checkpoints[0]?.status, 'failed')
  assert.equal(memoryDb.checkpoints[0]?.failure_count, 1)
  assert.equal(memoryDb.sourceFolders[0]?.last_scan_status, 'Error')
})

test('a series that stops the server twice is quarantined while the scan still resumes', () => {
  const memoryDb = createTestDatabase()
  const db = memoryDb as unknown as Database

  memoryDb.scanRuns.push({
    id: 'scan_second_attempt',
    started_at: '2026-06-14T10:05:00.000Z',
    finished_at: null,
    status: 'running',
    requested_source_id: 'source_1',
    resume_attempt: 1,
    heartbeat_at: '2026-06-14T10:05:30.000Z',
    lineage_id: 'lineage_1',
    current_source_id: 'source_1',
    current_series_key: 'series_1',
    current_series_title: 'Repeatedly problematic series',
    summary: '',
  })
  memoryDb.checkpoints.push({
    lineage_id: 'lineage_1',
    source_folder_id: 'source_1',
    series_key: 'series_1',
    status: 'running',
    failure_count: 1,
    last_error: 'The server process stopped while this series was being processed.',
    updated_at: '2026-06-14T10:05:30.000Z',
  })

  const resumptions = markInterruptedScans(db)

  assert.equal(memoryDb.checkpoints[0]?.status, 'quarantined')
  assert.equal(memoryDb.checkpoints[0]?.failure_count, 2)
  assert.match(memoryDb.scanRuns[0]?.summary || '', /will be quarantined and the scan will resume/i)
  assert.deepEqual(resumptions, [{
    runId: 'scan_second_attempt',
    lineageId: 'lineage_1',
    sourceId: 'source_1',
    resumeAttempt: 1,
    shouldResume: true,
  }])
})
