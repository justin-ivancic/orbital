import assert from 'node:assert/strict'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openDatabase } from './database'
import {
  resolveEntryMediaFile,
  runScan,
  updateSourceFolderCategory,
  type AppConfig,
} from './library'

const createTempDirectory = async () =>
  fsPromises.mkdtemp(path.join(os.tmpdir(), 'orbital-library-scan-'))

const makeConfig = (directory: string): AppConfig => ({
  appName: 'Orbital',
  bootstrapAdmin: 'admin',
  bootstrapPassword: 'password',
  openSignup: false,
  enableDemoSeed: false,
  demoFilesRoot: directory,
  coversDirectory: path.join(directory, 'data', 'covers'),
  managedSourceRoot: null,
})

const createSource = (
  db: ReturnType<typeof openDatabase>['db'],
  sourcePath: string,
  relativePath = '',
) => {
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO source_roots (id, label, path, created_at) VALUES (?, ?, ?, ?)`).run(
    'root-1',
    'Test library',
    sourcePath,
    now,
  )
  db.prepare(
    `
      INSERT INTO source_folders (
        id, root_id, category, relative_path, path, enabled, item_count,
        last_scan_at, last_scan_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, ?)
    `,
  ).run('source-1', 'root-1', 'novels', relativePath, sourcePath, now, now)
}

const writeNovel = async (sourcePath: string, fileName: string, content: string) => {
  const seriesPath = path.join(sourcePath, 'The Test Series')
  await fsPromises.mkdir(seriesPath, { recursive: true })
  const filePath = path.join(seriesPath, fileName)
  await fsPromises.writeFile(filePath, content)
  return filePath
}

test('library scans skip unchanged series and expose reconciliation metrics', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    await writeNovel(sourcePath, 'Chapter 1 - Opening.txt', 'opening')
    await writeNovel(sourcePath, 'Chapter 2 - Return.txt', 'return')

    const firstScan = await runScan(database.db, config, 'source-1')
    assert.equal(firstScan.changedFiles, 2)
    assert.equal(firstScan.metrics.newFiles, 2)
    assert.equal(firstScan.metrics.parsedFiles, 2)
    assert.equal(firstScan.metrics.processedSeries, 1)
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM scan_series_checkpoints`).get() as { count: number }).count,
      0,
    )

    const before = database.db
      .prepare(`SELECT last_scan_at, updated_at FROM series WHERE source_folder_id = ?`)
      .get('source-1') as { last_scan_at: string; updated_at: string }
    const beforeEntries = database.db
      .prepare(`SELECT id, updated_at FROM entries WHERE source_folder_id = ? ORDER BY file_path`)
      .all('source-1') as Array<{ id: string; updated_at: string }>

    const secondScan = await runScan(database.db, config, 'source-1')
    assert.equal(secondScan.changedFiles, 0)
    assert.equal(secondScan.metrics.unchangedFiles, 2)
    assert.equal(secondScan.metrics.reusedFiles, 2)
    assert.equal(secondScan.metrics.parsedFiles, 0)
    assert.equal(secondScan.metrics.processedSeries, 0)

    const after = database.db
      .prepare(`SELECT last_scan_at, updated_at FROM series WHERE source_folder_id = ?`)
      .get('source-1') as { last_scan_at: string; updated_at: string }
    const afterEntries = database.db
      .prepare(`SELECT id, updated_at FROM entries WHERE source_folder_id = ? ORDER BY file_path`)
      .all('source-1') as Array<{ id: string; updated_at: string }>

    assert.deepEqual(after, before)
    assert.deepEqual(afterEntries, beforeEntries)

    const lastRun = database.db
      .prepare(
        `
          SELECT discovered_files, parsed_files, reused_files, unchanged_files,
                 new_files, deleted_files, moved_files, processed_series
          FROM scan_runs
          WHERE id = ?
        `,
      )
      .get(secondScan.scanRunId) as Record<string, number>
    assert.deepEqual(lastRun, {
      discovered_files: 2,
      parsed_files: 0,
      reused_files: 2,
      unchanged_files: 2,
      new_files: 0,
      deleted_files: 0,
      moved_files: 0,
      processed_series: 0,
    })

    await writeNovel(sourcePath, 'Chapter 3 - Addition.txt', 'addition')
    const incrementalScan = await runScan(database.db, config, 'source-1')
    assert.equal(incrementalScan.metrics.newFiles, 1)
    assert.equal(incrementalScan.metrics.parsedFiles, 1)
    assert.equal(incrementalScan.metrics.reusedFiles, 2)
    assert.equal(incrementalScan.metrics.unchangedFiles, 2)
    assert.equal(incrementalScan.metrics.processedSeries, 1)
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('large unchanged libraries reuse inventory without flooding durable progress updates', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    await Promise.all(
      Array.from({ length: 120 }, async (_, index) => {
        const seriesPath = path.join(sourcePath, `Series ${String(index + 1).padStart(3, '0')}`)
        await fsPromises.mkdir(seriesPath, { recursive: true })
        await fsPromises.writeFile(path.join(seriesPath, 'Chapter 1.txt'), `chapter ${index + 1}`)
      }),
    )

    await runScan(database.db, config, 'source-1')
    let progressUpdates = 0
    const incrementalScan = await runScan(database.db, config, 'source-1', {
      onProgress: () => {
        progressUpdates += 1
      },
    })

    assert.equal(incrementalScan.metrics.discoveredFiles, 120)
    assert.equal(incrementalScan.metrics.reusedFiles, 120)
    assert.equal(incrementalScan.metrics.parsedFiles, 0)
    assert.equal(incrementalScan.metrics.unchangedFiles, 120)
    assert.equal(incrementalScan.metrics.processedSeries, 0)
    assert.ok(progressUpdates < 25, `expected throttled progress updates, received ${progressUpdates}`)

    const durableEventCount = database.db
      .prepare(`SELECT COUNT(*) AS count FROM scan_events WHERE scan_run_id = ?`)
      .get(incrementalScan.scanRunId) as { count: number }
    assert.ok(durableEventCount.count < 15)
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('library scans discover local covers during inventory without reparsing unchanged entries', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    await writeNovel(sourcePath, 'Chapter 1 - Opening.txt', 'opening')
    await runScan(database.db, config, 'source-1')

    const localCoverPath = path.join(sourcePath, 'cover.jpg')
    await fsPromises.writeFile(localCoverPath, 'local-cover')
    const incrementalScan = await runScan(database.db, config, 'source-1')
    const series = database.db
      .prepare(`SELECT cover_path FROM series WHERE source_folder_id = ?`)
      .get('source-1') as { cover_path: string }

    assert.equal(incrementalScan.metrics.parsedFiles, 0)
    assert.equal(incrementalScan.metrics.reusedFiles, 1)
    assert.equal(incrementalScan.metrics.processedSeries, 1)
    assert.equal(series.cover_path, localCoverPath)
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('library scans ignore file symlinks that escape the linked source', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    const outsideFilePath = path.join(directory, 'outside.txt')
    await fsPromises.writeFile(outsideFilePath, 'outside the linked source')
    await fsPromises.symlink(outsideFilePath, path.join(sourcePath, 'Linked book.txt'))

    const scan = await runScan(database.db, config, 'source-1')
    const entryCount = database.db
      .prepare(`SELECT COUNT(*) AS count FROM entries WHERE source_folder_id = ?`)
      .get('source-1') as { count: number }

    assert.equal(scan.metrics.discoveredFiles, 0)
    assert.equal(entryCount.count, 0)
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('media access rejects a scanned file replaced by an escaping symlink', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    const scannedFilePath = await writeNovel(sourcePath, 'Chapter 1 - Opening.txt', 'opening')
    await runScan(database.db, config, 'source-1')
    const entry = database.db
      .prepare(`SELECT id FROM entries WHERE file_path = ?`)
      .get(scannedFilePath) as { id: string }

    const outsideFilePath = path.join(directory, 'outside.txt')
    await fsPromises.writeFile(outsideFilePath, 'outside the linked source')
    await fsPromises.unlink(scannedFilePath)
    await fsPromises.symlink(outsideFilePath, scannedFilePath)

    assert.throws(() => resolveEntryMediaFile(database.db, entry.id), /not found/i)
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('interrupted scans retain committed series and retry incrementally', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    await writeNovel(sourcePath, 'Chapter 1 - Opening.txt', 'opening')
    await writeNovel(sourcePath, 'Chapter 2 - Return.txt', 'return')
    await runScan(database.db, config, 'source-1')
    await writeNovel(sourcePath, 'Chapter 3 - Addition.txt', 'addition')

    await assert.rejects(
      () =>
        runScan(database.db, config, 'source-1', {
          onProgress: ({ currentSourceSeriesCompleted }) => {
            if (currentSourceSeriesCompleted === 1) {
              throw new Error('simulated process interruption')
            }
          },
        }),
      /simulated process interruption/,
    )

    const interruptedRun = database.db
      .prepare(
        `
          SELECT status, changed_files, processed_series, heartbeat_at
          FROM scan_runs
          ORDER BY started_at DESC
          LIMIT 1
        `,
      )
      .get() as { status: string; changed_files: number; processed_series: number; heartbeat_at: string | null }
    assert.equal(interruptedRun.status, 'error')
    assert.equal(interruptedRun.changed_files, 1)
    assert.equal(interruptedRun.processed_series, 1)
    assert.ok(interruptedRun.heartbeat_at)
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM entries WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      3,
    )

    const retry = await runScan(database.db, config, 'source-1')
    assert.equal(retry.metrics.newFiles, 0)
    assert.equal(retry.metrics.unchangedFiles, 3)
    assert.equal(retry.metrics.reusedFiles, 3)
    assert.equal(
      (database.db.prepare(`SELECT last_scan_status FROM source_folders WHERE id = ?`).get('source-1') as { last_scan_status: string }).last_scan_status,
      'Ready',
    )
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('a resumed scan continues from durable series checkpoints instead of returning to zero', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)
  const seriesCount = 3_700
  const lineageId = 'scan-lineage-large-library'

  try {
    createSource(database.db, sourcePath, 'novels')
    for (let batchStart = 0; batchStart < seriesCount; batchStart += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, seriesCount - batchStart) }, async (_, offset) => {
          const seriesIndex = batchStart + offset + 1
          const seriesPath = path.join(sourcePath, `Series ${String(seriesIndex).padStart(5, '0')}`)
          await fsPromises.mkdir(seriesPath, { recursive: true })
          await fsPromises.writeFile(path.join(seriesPath, 'Chapter 1.txt'), `chapter ${seriesIndex}`)
        }),
      )
    }

    await assert.rejects(
      () => runScan(
        database.db,
        config,
        'source-1',
        {
          onProgress: ({ currentSourceSeriesCompleted, summary }) => {
            if (currentSourceSeriesCompleted === 3_600 && !summary?.includes('entries')) {
              throw new Error('simulated process stop near the reported production boundary')
            }
          },
        },
        { lineageId },
      ),
      /simulated process stop/,
    )

    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM series WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      3_600,
    )

    let firstInventoryProgress: number | null = null
    const resumed = await runScan(
      database.db,
      config,
      'source-1',
      {
        onProgress: ({ currentSourceSeriesTotal, currentSourceSeriesCompleted }) => {
          if (currentSourceSeriesTotal === seriesCount && firstInventoryProgress == null) {
            firstInventoryProgress = currentSourceSeriesCompleted
          }
        },
      },
      { lineageId, resumeAttempt: 1 },
    )

    assert.equal(firstInventoryProgress, 3_600)
    assert.equal(resumed.metrics.newFiles, 100)
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM series WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      seriesCount,
    )
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('large series retain committed entry batches when processing is interrupted', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    const seriesPath = path.join(sourcePath, 'Large Series')
    await fsPromises.mkdir(seriesPath, { recursive: true })
    await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        fsPromises.writeFile(
          path.join(seriesPath, `Chapter ${String(index + 1).padStart(4, '0')}.txt`),
          `chapter ${index + 1}`,
        ),
      ),
    )

    const interrupted = await runScan(database.db, config, 'source-1', {
      onProgress: ({ summary }) => {
        if (summary?.includes('250/600 entries')) {
          throw new Error('simulated interruption after a committed entry batch')
        }
      },
    })
    assert.equal(interrupted.scannedSourceIds.includes('source-1'), true)
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM entries WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      250,
    )

    const resumed = await runScan(database.db, config, 'source-1')
    assert.equal(resumed.metrics.newFiles, 350)
    assert.equal(resumed.metrics.unchangedFiles, 250)
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM entries WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      600,
    )
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('library scans preserve entry bookmarks when a file is renamed', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    await writeNovel(sourcePath, 'Chapter 1 - Opening.txt', 'opening')
    const originalPath = await writeNovel(sourcePath, 'Chapter 2 - Return.txt', 'return')

    await runScan(database.db, config, 'source-1')
    const originalEntry = database.db
      .prepare(`SELECT id, series_id FROM entries WHERE file_path = ?`)
      .get(originalPath) as { id: string; series_id: string }

    database.db.prepare(
      `INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('user-1', 'reader', 'not-used-in-test', 'member', new Date().toISOString(), new Date().toISOString())
    database.db.prepare(
      `
        INSERT INTO bookmarks (user_id, series_id, entry_id, entry_index, category, progress, cue, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run('user-1', originalEntry.series_id, originalEntry.id, 1, 'novels', '50%', 'Chapter 2', new Date().toISOString())

    const renamedPath = path.join(path.dirname(originalPath), 'Chapter 2 - Renamed.txt')
    await fsPromises.rename(originalPath, renamedPath)

    const scan = await runScan(database.db, config, 'source-1')
    assert.equal(scan.metrics.movedFiles, 1)
    assert.equal(scan.metrics.deletedFiles, 0)

    const renamedEntry = database.db
      .prepare(`SELECT id, series_id, file_path FROM entries WHERE id = ?`)
      .get(originalEntry.id) as { id: string; series_id: string; file_path: string }
    const bookmark = database.db
      .prepare(`SELECT entry_id, series_id FROM bookmarks WHERE user_id = ?`)
      .get('user-1') as { entry_id: string; series_id: string }

    assert.deepEqual(renamedEntry, {
      id: originalEntry.id,
      series_id: originalEntry.series_id,
      file_path: renamedPath,
    })
    assert.deepEqual(bookmark, {
      entry_id: originalEntry.id,
      series_id: originalEntry.series_id,
    })
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('library scans preserve a series identity when its folder is moved', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    const firstPath = await writeNovel(sourcePath, 'Chapter 1 - Opening.txt', 'opening')
    const secondPath = await writeNovel(sourcePath, 'Chapter 2 - Return.txt', 'return')
    await runScan(database.db, config, 'source-1')

    const originalSeries = database.db
      .prepare(`SELECT id FROM series WHERE source_folder_id = ?`)
      .get('source-1') as { id: string }
    const originalEntries = database.db
      .prepare(`SELECT id, file_path FROM entries WHERE series_id = ? ORDER BY file_path`)
      .all(originalSeries.id) as Array<{ id: string; file_path: string }>

    const originalFolder = path.dirname(firstPath)
    const movedFolder = path.join(sourcePath, 'Moved Test Series')
    await fsPromises.rename(originalFolder, movedFolder)

    const scan = await runScan(database.db, config, 'source-1')
    assert.equal(scan.metrics.movedFiles, 2)
    assert.equal(scan.metrics.deletedFiles, 0)

    const movedSeries = database.db
      .prepare(`SELECT id, folder_path FROM series WHERE source_folder_id = ?`)
      .get('source-1') as { id: string; folder_path: string }
    const movedEntries = database.db
      .prepare(`SELECT id, file_path FROM entries WHERE series_id = ? ORDER BY file_path`)
      .all(originalSeries.id) as Array<{ id: string; file_path: string }>

    assert.equal(movedSeries.id, originalSeries.id)
    assert.deepEqual(
      movedEntries.map((entry) => entry.id),
      originalEntries.map((entry) => entry.id),
    )
    assert.deepEqual(
      movedEntries.map((entry) => entry.file_path),
      [path.join(movedFolder, path.basename(firstPath)), path.join(movedFolder, path.basename(secondPath))],
    )
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('library scans preserve records when the source folder is unavailable', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    await writeNovel(sourcePath, 'Chapter 1 - Opening.txt', 'opening')
    await runScan(database.db, config, 'source-1')

    await fsPromises.rm(sourcePath, { recursive: true, force: true })
    const scan = await runScan(database.db, config, 'source-1')

    assert.equal(scan.metrics.skippedSources, 1)
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM series`).get() as { count: number }).count, 1)
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM entries`).get() as { count: number }).count, 1)
    assert.equal(
      (database.db.prepare(`SELECT last_scan_status FROM source_folders WHERE id = ?`).get('source-1') as { last_scan_status: string }).last_scan_status,
      'Unavailable',
    )
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('library scans do not merge a partially moved series into the old series identity', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath, 'novels')
    await writeNovel(sourcePath, 'Chapter 1 - Opening.txt', 'opening')
    await writeNovel(sourcePath, 'Chapter 2 - Return.txt', 'return')
    await runScan(database.db, config, 'source-1')

    const movedPath = path.join(sourcePath, 'Moved Test Series', 'Chapter 1 - Opening.txt')
    await fsPromises.mkdir(path.dirname(movedPath), { recursive: true })
    await fsPromises.rename(
      path.join(sourcePath, 'The Test Series', 'Chapter 1 - Opening.txt'),
      movedPath,
    )

    const scan = await runScan(database.db, config, 'source-1')
    assert.equal(scan.metrics.deletedFiles, 1)
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM series WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      2,
    )
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM entries WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      2,
    )
    assert.equal(
      (database.db.prepare(`SELECT last_scan_status FROM source_folders WHERE id = ?`).get('source-1') as { last_scan_status: string }).last_scan_status,
      'Ready',
    )
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('library scans preserve records when a populated source is replaced by an empty mount', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    await writeNovel(sourcePath, 'Chapter 1 - Opening.txt', 'opening')
    await runScan(database.db, config, 'source-1')

    await fsPromises.rm(sourcePath, { recursive: true, force: true })
    await fsPromises.mkdir(sourcePath, { recursive: true })
    const scan = await runScan(database.db, config, 'source-1')

    assert.equal(scan.metrics.skippedSources, 1)
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM series WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      1,
    )
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM entries WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      1,
    )
    assert.equal(
      (database.db.prepare(`SELECT last_scan_status FROM source_folders WHERE id = ?`).get('source-1') as { last_scan_status: string }).last_scan_status,
      'Unavailable',
    )
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('library scans reparse entries after a source category changes', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    await writeNovel(sourcePath, 'Chapter 1 - Opening.txt', 'opening')
    await writeNovel(sourcePath, 'Chapter 2 - Return.txt', 'return')
    await runScan(database.db, config, 'source-1')

    updateSourceFolderCategory(database.db, config, 'source-1', { category: 'books' })
    const scan = await runScan(database.db, config, 'source-1')

    assert.equal(scan.metrics.parsedFiles, 2)
    assert.equal(scan.metrics.reusedFiles, 0)
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM series WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      2,
    )
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM entries WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      2,
    )
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM series WHERE series_key LIKE 'novel:%'`).get() as { count: number }).count,
      0,
    )
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('library scans regenerate a missing derived cover for an unchanged series', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    await writeNovel(sourcePath, 'Chapter 1 - Opening.txt', 'opening')
    await runScan(database.db, config, 'source-1')

    const originalSeries = database.db
      .prepare(`SELECT id, cover_path FROM series WHERE source_folder_id = ?`)
      .get('source-1') as { id: string; cover_path: string }
    await fsPromises.rm(originalSeries.cover_path, { force: true })

    const scan = await runScan(database.db, config, 'source-1')
    const repairedSeries = database.db
      .prepare(`SELECT id, cover_path FROM series WHERE id = ?`)
      .get(originalSeries.id) as { id: string; cover_path: string }

    assert.equal(scan.metrics.processedSeries, 1)
    assert.equal(repairedSeries.id, originalSeries.id)
    assert.equal(await fsPromises.stat(repairedSeries.cover_path).then(() => true), true)
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('invalid PDF cover extraction is isolated and falls back without failing the scan', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath)
    const seriesPath = path.join(sourcePath, 'Broken PDF Series')
    await fsPromises.mkdir(seriesPath, { recursive: true })
    await fsPromises.writeFile(path.join(seriesPath, 'Chapter 1.pdf'), 'not a valid pdf')

    const scan = await runScan(database.db, config, 'source-1')
    const series = database.db
      .prepare(`SELECT cover_path, cover_source FROM series WHERE source_folder_id = ? LIMIT 1`)
      .get('source-1') as { cover_path: string; cover_source: string }

    assert.equal(scan.scannedSourceIds.includes('source-1'), true)
    assert.equal(series.cover_source, 'Generated fallback cover')
    assert.match(series.cover_path, /\.svg$/)
    assert.equal(await fsPromises.stat(series.cover_path).then(() => true), true)
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('a series failure is isolated without failing the whole source or deleting existing records', async () => {
  const directory = await createTempDirectory()
  const sourcePath = path.join(directory, 'library')
  await fsPromises.mkdir(sourcePath, { recursive: true })
  const database = openDatabase(path.join(directory, 'data'))
  const config = makeConfig(directory)

  try {
    createSource(database.db, sourcePath, 'novels')
    const retainedSeriesPath = path.join(sourcePath, 'Retained Series')
    const removedSeriesPath = path.join(sourcePath, 'Removed Series')
    await fsPromises.mkdir(retainedSeriesPath, { recursive: true })
    await fsPromises.mkdir(removedSeriesPath, { recursive: true })
    await fsPromises.writeFile(path.join(retainedSeriesPath, 'Chapter 1.txt'), 'retained')
    await fsPromises.writeFile(path.join(removedSeriesPath, 'Chapter 1.txt'), 'removed')
    await runScan(database.db, config, 'source-1')

    const retainedCover = database.db
      .prepare(`SELECT cover_path FROM series WHERE source_folder_id = ? AND title = ?`)
      .get('source-1', 'Retained Series') as { cover_path: string }
    await fsPromises.rm(retainedCover.cover_path, { force: true })
    await fsPromises.rm(removedSeriesPath, { recursive: true, force: true })

    const brokenConfig = {
      ...config,
      coversDirectory: path.join(directory, 'missing-covers'),
    }
    const isolatedFailure = await runScan(database.db, brokenConfig, 'source-1')
    assert.equal(isolatedFailure.scannedSourceIds.includes('source-1'), true)
    assert.equal(
      (database.db.prepare(`SELECT last_scan_status FROM source_folders WHERE id = ?`).get('source-1') as { last_scan_status: string }).last_scan_status,
      'Ready with warnings',
    )
    assert.equal(
      (database.db.prepare(`SELECT status FROM scan_runs ORDER BY started_at DESC LIMIT 1`).get() as { status: string }).status,
      'success',
    )
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM series WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      2,
    )
    const failureEvents = database.db
      .prepare(`SELECT message FROM scan_events WHERE scan_run_id = ? AND level = 'error'`)
      .all(isolatedFailure.scanRunId) as Array<{ message: string }>
    assert.equal(
      failureEvents.some((event) => /deletion reconciliation was skipped/i.test(event.message)),
      true,
    )

    const retry = await runScan(database.db, config, 'source-1')
    assert.equal(retry.metrics.newFiles, 0)
    assert.equal(retry.metrics.deletedFiles, 1)
    assert.equal(
      (database.db.prepare(`SELECT COUNT(*) AS count FROM series WHERE source_folder_id = ?`).get('source-1') as { count: number }).count,
      1,
    )
    assert.equal(
      (database.db.prepare(`SELECT last_scan_status FROM source_folders WHERE id = ?`).get('source-1') as { last_scan_status: string }).last_scan_status,
      'Ready',
    )
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})
