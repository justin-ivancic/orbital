import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { SessionUser } from '../src/appTypes'
import { readerSettingsForStyle } from '../src/readerSettings'
import { openDatabase } from './database'
import { getReaderPreference, saveReaderPreference } from './readerPreferences'

test('reader preferences are isolated by user and normalized before persistence', () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-reader-preferences-'))
  const { db } = openDatabase(dataDirectory)

  try {
    const now = new Date().toISOString()
    const alice: SessionUser = { id: 'alice', username: 'alice', role: 'member' }
    const bob: SessionUser = { id: 'bob', username: 'bob', role: 'member' }

    db.prepare(
      'INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(alice.id, alice.username, 'hash', alice.role, now, now)
    db.prepare(
      'INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(bob.id, bob.username, 'hash', bob.role, now, now)
    db.prepare(
      'INSERT INTO source_roots (id, label, path, created_at) VALUES (?, ?, ?, ?)',
    ).run('root', 'Library', '/library', now)
    db.prepare(
      `INSERT INTO source_folders (
        id, root_id, category, relative_path, path, enabled, item_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('folder', 'root', 'manga', 'manga', '/library/manga', 1, 1, now, now)
    db.prepare(
      `INSERT INTO series (
        id, source_folder_id, series_key, category, title, title_short, format, status,
        description, folder_path, cover_source, metadata_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'series',
      'folder',
      'manga:series',
      'manga',
      'Series',
      'Series',
      'cbz',
      'ready',
      '',
      '/library/manga/Series',
      'none',
      'filesystem',
      now,
      now,
    )

    const saved = saveReaderPreference(db, alice, 'series', {
      ...readerSettingsForStyle('manga'),
      zoom: 999,
    })

    assert.equal(saved.zoom, 200)
    assert.deepEqual(getReaderPreference(db, alice, 'series'), saved)
    assert.equal(getReaderPreference(db, bob, 'series'), null)
  } finally {
    db.close()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
  }
})
