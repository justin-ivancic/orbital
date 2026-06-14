import assert from 'node:assert/strict'
import test from 'node:test'
import type { Database } from 'better-sqlite3'
import type { CategoryId, SessionUser } from '../src/appTypes.ts'
import {
  bootstrapAdminUser,
  clearSession,
  createSession,
  findSessionContext,
  findSessionUser,
  getAppState,
  loginUser,
  removeBookmark,
  saveBookmark,
  signupUser,
  type AppConfig,
} from './library.ts'

type MemoryUser = {
  id: string
  username: string
  password_hash: string
  role: SessionUser['role']
  created_at: string
  updated_at: string
}

type MemorySession = {
  id: string
  user_id: string
  expires_at: number
  csrf_token: string | null
  created_at: string
}

type MemorySourceRoot = {
  id: string
  label: string
  path: string
}

type MemorySourceFolder = {
  id: string
  root_id: string | null
  category: CategoryId
  relative_path: string
  path: string
  item_count: number
  last_scan_at: string | null
  last_scan_status: string | null
  enabled: number
}

type MemorySeries = {
  id: string
  source_folder_id: string
  category: CategoryId
  title: string
  title_short: string
  year: number | null
  format: string
  status: string
  description: string
  folder_path: string
  cover_source: string
  metadata_source: string
  cover_path: string | null
  cover_mime: string | null
  banner_path: string | null
  banner_mime: string | null
  remote_provider: string | null
  remote_id: string | null
  external_url: string | null
  source_name: string | null
  source_role: string | null
  genres_json: string
  file_count: number
  last_scan_at: string | null
  tags_json: string
  metadata_refreshed_at: string | null
  updated_at: string
}

type MemoryEntry = {
  series_id: string
  id: string
  relative_path: string
  label: string
  title: string
  storage_file: string
  format: string
  details: string
  sort_order: number
  chapter_number: number | null
  season_number: number | null
  episode_number: number | null
}

type MemoryBookmark = {
  user_id: string
  series_id: string
  entry_id: string
  entry_index: number
  category: CategoryId
  progress: string
  cue: string
  last_seen: string
}

type MemoryReadingPosition = {
  user_id: string
  entry_id: string
  page: number
  total_pages: number | null
  view_mode: string | null
  location_type: string | null
  progress_label: string | null
  cue_label: string | null
}

class MemoryStatement {
  db: MemoryDatabase
  sql: string

  constructor(db: MemoryDatabase, sql: string) {
    this.db = db
    this.sql = sql.replace(/\s+/g, ' ').trim()
  }

  run(...args: unknown[]) {
    return this.db.run(this.sql, args)
  }

  get(...args: unknown[]) {
    return this.db.get(this.sql, args)
  }

  all(...args: unknown[]) {
    return this.db.all(this.sql, args)
  }
}

class MemoryDatabase {
  users: MemoryUser[] = []
  sessions: MemorySession[] = []
  sourceRoots: MemorySourceRoot[] = []
  sourceFolders: MemorySourceFolder[] = []
  series: MemorySeries[] = []
  entries: MemoryEntry[] = []
  bookmarks: MemoryBookmark[] = []
  readingPositions: MemoryReadingPosition[] = []

  prepare(sql: string) {
    return new MemoryStatement(this, sql)
  }

  run(sql: string, args: unknown[]) {
    if (sql.startsWith('INSERT INTO users')) {
      const [id, username, passwordHash, createdAt, updatedAt] = args as string[]
      this.users.push({
        id,
        username,
        password_hash: passwordHash,
        role: sql.includes("'admin'") ? 'admin' : 'member',
        created_at: createdAt,
        updated_at: updatedAt,
      })
      return { changes: 1 }
    }

    if (sql.startsWith("UPDATE users SET role = 'admin'")) {
      const [updatedAt, id] = args as string[]
      const user = this.users.find((item) => item.id === id)
      if (user) {
        user.role = 'admin'
        user.updated_at = updatedAt
      }
      return { changes: user ? 1 : 0 }
    }

    if (sql.startsWith('INSERT INTO sessions')) {
      const [id, userId, expiresAt, csrfToken, createdAt] = args as [string, string, number, string, string]
      this.sessions.push({
        id,
        user_id: userId,
        expires_at: expiresAt,
        csrf_token: csrfToken,
        created_at: createdAt,
      })
      return { changes: 1 }
    }

    if (sql.startsWith('UPDATE sessions SET csrf_token = ? WHERE id = ?')) {
      const [csrfToken, id] = args as string[]
      const session = this.sessions.find((item) => item.id === id)
      if (session) {
        session.csrf_token = csrfToken
      }
      return { changes: session ? 1 : 0 }
    }

    if (sql.startsWith('DELETE FROM sessions WHERE id = ?')) {
      const [id] = args as string[]
      const before = this.sessions.length
      this.sessions = this.sessions.filter((session) => session.id !== id)
      return { changes: before - this.sessions.length }
    }

    if (sql.startsWith('INSERT INTO reading_positions')) {
      const [
        userId,
        entryId,
        page,
        totalPages,
        viewMode,
        locationType,
        progressLabel,
        cueLabel,
      ] = args as [string, string, number, number | null, string | null, string | null, string | null, string | null]
      const existing = this.readingPositions.find(
        (position) => position.user_id === userId && position.entry_id === entryId,
      )
      const nextPosition = {
        user_id: userId,
        entry_id: entryId,
        page,
        total_pages: totalPages,
        view_mode: viewMode,
        location_type: locationType,
        progress_label: progressLabel,
        cue_label: cueLabel,
      }

      if (existing) {
        Object.assign(existing, nextPosition)
      } else {
        this.readingPositions.push(nextPosition)
      }

      return { changes: 1 }
    }

    if (sql.startsWith('INSERT INTO bookmarks')) {
      const [userId, seriesId, entryId, entryIndex, category, progress, cue, lastSeen] = args as [
        string,
        string,
        string,
        number,
        CategoryId,
        string,
        string,
        string,
      ]
      const existing = this.bookmarks.find(
        (bookmark) => bookmark.user_id === userId && bookmark.series_id === seriesId,
      )
      const nextBookmark = {
        user_id: userId,
        series_id: seriesId,
        entry_id: entryId,
        entry_index: entryIndex,
        category,
        progress,
        cue,
        last_seen: lastSeen,
      }

      if (existing) {
        Object.assign(existing, nextBookmark)
      } else {
        this.bookmarks.push(nextBookmark)
      }

      return { changes: 1 }
    }

    if (sql.startsWith('DELETE FROM bookmarks WHERE user_id = ? AND series_id = ?')) {
      const [userId, seriesId] = args as string[]
      const before = this.bookmarks.length
      this.bookmarks = this.bookmarks.filter(
        (bookmark) => bookmark.user_id !== userId || bookmark.series_id !== seriesId,
      )
      return { changes: before - this.bookmarks.length }
    }

    throw new Error(`Unhandled run statement in auth test: ${sql}`)
  }

  get(sql: string, args: unknown[] = []) {
    if (sql.includes('SELECT id FROM users WHERE lower(username) = lower(?)')) {
      const [username] = args as string[]
      const user = this.findUser(username)
      return user ? { id: user.id } : undefined
    }

    if (sql.includes('SELECT id, username, role, password_hash FROM users')) {
      const [username] = args as string[]
      const user = this.findUser(username)
      return user
        ? {
            id: user.id,
            username: user.username,
            role: user.role,
            password_hash: user.password_hash,
          }
        : undefined
    }

    if (sql.includes('FROM sessions s INNER JOIN users u ON u.id = s.user_id')) {
      const [sessionId] = args as string[]
      const session = this.sessions.find((item) => item.id === sessionId)
      const user = session ? this.users.find((item) => item.id === session.user_id) : undefined

      return session && user
        ? {
            id: session.id,
            expires_at: session.expires_at,
            csrf_token: session.csrf_token,
            user_id: user.id,
            username: user.username,
            role: user.role,
          }
        : undefined
    }

    if (sql.includes('SELECT id, series_id FROM entries WHERE id = ?')) {
      const [entryId] = args as string[]
      const entry = this.entries.find((item) => item.id === entryId)
      return entry
        ? {
            id: entry.id,
            series_id: entry.series_id,
          }
        : undefined
    }

    if (sql.includes("FROM scan_runs WHERE status = 'success'")) {
      return undefined
    }

    if (sql.includes('SELECT COUNT(*) AS count FROM source_roots')) {
      return { count: this.sourceRoots.length }
    }

    if (sql.includes('SELECT COUNT(*) AS count FROM source_folders WHERE enabled = 1')) {
      return { count: this.sourceFolders.filter((folder) => folder.enabled === 1).length }
    }

    if (sql.includes('SELECT id, started_at, finished_at, status, summary FROM scan_runs')) {
      return undefined
    }

    throw new Error(`Unhandled get statement in auth test: ${sql}`)
  }

  all(sql: string, args: unknown[] = []) {
    if (sql.includes('FROM series') && sql.includes('ORDER BY category')) {
      return [...this.series]
    }

    if (sql.includes('FROM entries') && sql.includes('WHERE series_id IN')) {
      const seriesIds = new Set(args as string[])
      return this.entries.filter((entry) => seriesIds.has(entry.series_id))
    }

    if (sql.includes('FROM bookmarks b INNER JOIN entries e ON e.id = b.entry_id')) {
      const [userId] = args as string[]
      return this.bookmarks
        .filter((bookmark) => bookmark.user_id === userId)
        .map((bookmark) => {
          const entry = this.entries.find((item) => item.id === bookmark.entry_id)
          return {
            series_id: bookmark.series_id,
            category: bookmark.category,
            entry_id: bookmark.entry_id,
            entry_index: bookmark.entry_index,
            progress: bookmark.progress,
            cue: bookmark.cue,
            last_seen: bookmark.last_seen,
            entry_label: entry?.label ?? '',
            entry_title: entry?.title ?? '',
          }
        })
    }

    if (sql.includes('FROM reading_positions WHERE user_id = ?')) {
      const [userId] = args as string[]
      return this.readingPositions.filter((position) => position.user_id === userId)
    }

    if (sql.includes('FROM source_roots r LEFT JOIN source_folders s ON s.root_id = r.id')) {
      return this.sourceRoots.map((root) => ({
        ...root,
        source_count: this.sourceFolders.filter((folder) => folder.root_id === root.id).length,
      }))
    }

    if (sql.includes('FROM source_folders WHERE enabled = 1')) {
      return this.sourceFolders.filter((folder) => folder.enabled === 1)
    }

    if (sql.includes('FROM users ORDER BY CASE role')) {
      return [...this.users].sort((first, second) => {
        if (first.role !== second.role) {
          return first.role === 'admin' ? -1 : 1
        }

        return first.username.localeCompare(second.username)
      })
    }

    if (sql.includes('FROM series') && sql.includes('LIMIT 16')) {
      return [...this.series]
    }

    throw new Error(`Unhandled all statement in auth test: ${sql}`)
  }

  findUser(username: string) {
    return this.users.find((user) => user.username.toLowerCase() === username.toLowerCase())
  }

  seedLibraryFixture() {
    const rootId = 'root_auth_fixture'
    const folderId = 'folder_auth_fixture'
    const seriesId = 'series_auth_fixture'
    const entryId = 'entry_auth_fixture'

    this.sourceRoots.push({
      id: rootId,
      label: 'Library',
      path: '/tmp/orbital-auth-library',
    })

    this.sourceFolders.push({
      id: folderId,
      root_id: rootId,
      category: 'manga',
      relative_path: '',
      path: '/tmp/orbital-auth-library/manga',
      item_count: 1,
      last_scan_at: null,
      last_scan_status: null,
      enabled: 1,
    })

    this.series.push({
      id: seriesId,
      source_folder_id: folderId,
      category: 'manga',
      title: 'Security Fixture',
      title_short: 'Security Fixture',
      year: 2026,
      format: 'cbz',
      status: 'Ready',
      description: 'Fixture used for auth isolation tests.',
      folder_path: '/tmp/orbital-auth-library/manga/Security Fixture',
      cover_source: 'Test fixture',
      metadata_source: 'Test fixture',
      cover_path: null,
      cover_mime: null,
      banner_path: null,
      banner_mime: null,
      remote_provider: null,
      remote_id: null,
      external_url: null,
      source_name: null,
      source_role: null,
      genres_json: '[]',
      file_count: 1,
      last_scan_at: null,
      tags_json: '[]',
      metadata_refreshed_at: null,
      updated_at: '2026-06-14T00:00:00.000Z',
    })

    this.entries.push({
      id: entryId,
      series_id: seriesId,
      relative_path: 'Security Fixture/chapter-001.cbz',
      label: 'Chapter 001',
      title: 'Chapter 001',
      storage_file: 'chapter-001.cbz',
      format: 'cbz',
      details: '10 pages',
      sort_order: 1,
      chapter_number: 1,
      season_number: null,
      episode_number: null,
    })

    return {
      entryId,
      seriesId,
    }
  }
}

const createTestDatabase = () => {
  const memoryDb = new MemoryDatabase()
  const config: AppConfig = {
    appName: 'Orbital Test',
    bootstrapAdmin: 'admin',
    bootstrapPassword: 'admin-secret',
    openSignup: true,
    enableDemoSeed: false,
    demoFilesRoot: '',
    coversDirectory: '',
    managedSourceRoot: null,
  }

  return {
    db: memoryDb as unknown as Database,
    memoryDb,
    config,
  }
}

const saveFixtureBookmark = (
  db: Database,
  user: SessionUser,
  fixture: ReturnType<MemoryDatabase['seedLibraryFixture']>,
  page: number,
) =>
  saveBookmark(db, user, {
    seriesId: fixture.seriesId,
    entryId: fixture.entryId,
    entryIndex: 0,
    category: 'manga',
    progress: `Page ${page} of 10`,
    cue: 'Chapter 001',
    position: {
      page,
      totalPages: 10,
      viewMode: 'single',
      locationType: 'page',
      progressLabel: `Page ${page} of 10`,
      cueLabel: 'Chapter 001',
    },
  })

test('password checks and sessions bind to the intended account', async () => {
  const { db, memoryDb } = createTestDatabase()
  const alice = await signupUser(db, 'Alice', 'alice-secret')
  const bob = await signupUser(db, 'Bob', 'bob-secret')

  await assert.rejects(signupUser(db, 'alice', 'another-secret'), /already exists/)
  await assert.rejects(loginUser(db, 'Alice', 'bob-secret'), /Unknown username or password/)
  await assert.rejects(loginUser(db, 'Bob', 'alice-secret'), /Unknown username or password/)

  assert.equal((await loginUser(db, ' Alice ', 'alice-secret')).id, alice.id)
  assert.equal((await loginUser(db, 'BOB', 'bob-secret')).id, bob.id)

  const aliceSession = createSession(db, alice.id)
  const bobSession = createSession(db, bob.id)

  assert.equal(typeof aliceSession.csrfToken, 'string')
  assert.equal(aliceSession.csrfToken.length > 20, true)
  assert.deepEqual(findSessionContext(db, aliceSession.sessionId), {
    sessionId: aliceSession.sessionId,
    csrfToken: aliceSession.csrfToken,
    user: alice,
  })
  assert.deepEqual(findSessionUser(db, aliceSession.sessionId), alice)
  assert.deepEqual(findSessionUser(db, bobSession.sessionId), bob)

  memoryDb.sessions.push({
    id: 'session_expired',
    user_id: alice.id,
    expires_at: Date.now() - 1,
    csrf_token: 'expired-csrf-token',
    created_at: '2026-06-14T00:00:00.000Z',
  })

  assert.equal(findSessionUser(db, 'session_expired'), null)

  clearSession(db, aliceSession.sessionId)
  assert.equal(findSessionUser(db, aliceSession.sessionId), null)
  assert.deepEqual(findSessionUser(db, bobSession.sessionId), bob)
})

test('library state, bookmarks, and reading positions stay isolated per user', async () => {
  const { db, memoryDb, config } = createTestDatabase()
  const fixture = memoryDb.seedLibraryFixture()
  const alice = await signupUser(db, 'Alice', 'alice-secret')
  const bob = await signupUser(db, 'Bob', 'bob-secret')

  saveFixtureBookmark(db, alice, fixture, 2)
  saveFixtureBookmark(db, bob, fixture, 7)

  const anonymousState = getAppState(db, config, null)
  assert.equal(anonymousState.library.length, 0)
  assert.equal(anonymousState.bookmarks.length, 0)
  assert.deepEqual(anonymousState.readingPositions, {})

  const aliceState = getAppState(db, config, alice)
  assert.equal(aliceState.library.length, 1)
  assert.equal(aliceState.bookmarks.length, 1)
  assert.equal(aliceState.bookmarks[0]?.progress, 'Page 2 of 10')
  assert.equal(aliceState.readingPositions[fixture.entryId]?.page, 2)

  const bobState = getAppState(db, config, bob)
  assert.equal(bobState.library.length, 1)
  assert.equal(bobState.bookmarks.length, 1)
  assert.equal(bobState.bookmarks[0]?.progress, 'Page 7 of 10')
  assert.equal(bobState.readingPositions[fixture.entryId]?.page, 7)

  removeBookmark(db, alice, fixture.seriesId)

  assert.equal(getAppState(db, config, alice).bookmarks.length, 0)
  assert.equal(getAppState(db, config, bob).bookmarks[0]?.progress, 'Page 7 of 10')
})

test('admin-only state is hidden from member accounts', async () => {
  const { db, memoryDb, config } = createTestDatabase()
  memoryDb.seedLibraryFixture()
  await bootstrapAdminUser(db, config)
  const admin = await loginUser(db, 'admin', 'admin-secret')
  const member = await signupUser(db, 'Member', 'member-secret')

  const adminState = getAppState(db, config, admin)
  const memberState = getAppState(db, config, member)

  assert.ok(adminState.users.some((user) => user.name === 'admin'))
  assert.equal(adminState.sourceRoots.length, 1)
  assert.equal(adminState.sourceFolders.length, 1)

  assert.deepEqual(memberState.users, [])
  assert.deepEqual(memberState.sourceRoots, [])
  assert.deepEqual(memberState.sourceFolders, [])
})
