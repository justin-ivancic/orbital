import assert from 'node:assert/strict'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { SessionUser } from '../src/appTypes.ts'
import { openDatabase } from './database'
import {
  bootstrapAdminUser,
  clearSession,
  createSession,
  createUserAccount,
  deleteUserAccount,
  findSessionContext,
  findSessionUser,
  getAppState,
  getLibraryRevision,
  loginUser,
  removeBookmark,
  saveBookmark,
  saveReadingProgress,
  signupUser,
  type AppConfig,
} from './library.ts'
import { SESSION_TTL_MS } from './utils'

type TestDatabase = ReturnType<typeof openDatabase>['db']

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

const withDatabase = async (run: (db: TestDatabase) => Promise<void>) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'orbital-auth-'))
  const database = openDatabase(directory)

  try {
    await run(database.db)
  } finally {
    database.db.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
}

const seedLibraryFixture = (db: TestDatabase) => {
  const now = '2026-06-14T00:00:00.000Z'
  db.prepare(`INSERT INTO source_roots (id, label, path, created_at) VALUES (?, ?, ?, ?)`).run(
    'root_auth_fixture',
    'Library',
    '/tmp/orbital-auth-library',
    now,
  )
  db.prepare(
    `
      INSERT INTO source_folders (id, root_id, category, relative_path, path, enabled, item_count, created_at, updated_at)
      VALUES (?, ?, 'manga', '', ?, 1, 1, ?, ?)
    `,
  ).run('folder_auth_fixture', 'root_auth_fixture', '/tmp/orbital-auth-library/manga', now, now)
  db.prepare(
    `
      INSERT INTO series (
        id, source_folder_id, series_key, category, title, title_short, year, format, status,
        description, folder_path, cover_source, metadata_source, file_count, created_at, updated_at
      ) VALUES (?, ?, ?, 'manga', ?, ?, 2026, 'Manga', 'Ready', ?, ?, 'No cover image', 'Folder-derived metadata', 1, ?, ?)
    `,
  ).run(
    'series_auth_fixture',
    'folder_auth_fixture',
    'manga:auth-fixture',
    'Security Fixture',
    'Security Fixture',
    'Fixture used for auth isolation tests.',
    '/tmp/orbital-auth-library/manga/Security Fixture',
    now,
    now,
  )
  db.prepare(
    `
      INSERT INTO entries (
        id, series_id, source_folder_id, file_path, storage_file, relative_path, label, title,
        format, details, chapter_number, sort_order, size, mtime_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'chapter-001.cbz', 'Security Fixture/chapter-001.cbz', 'Chapter 001', 'Chapter 001',
        'cbz', '10 pages', 1, 1, 100, 1, ?, ?)
    `,
  ).run(
    'entry_auth_fixture',
    'series_auth_fixture',
    'folder_auth_fixture',
    '/tmp/orbital-auth-library/manga/Security Fixture/chapter-001.cbz',
    now,
    now,
  )

  return { entryId: 'entry_auth_fixture', seriesId: 'series_auth_fixture' }
}

const saveFixtureBookmark = (
  db: TestDatabase,
  user: SessionUser,
  fixture: ReturnType<typeof seedLibraryFixture>,
  page: number,
  lastSeen?: string,
) =>
  saveBookmark(db, user, {
    seriesId: fixture.seriesId,
    entryId: fixture.entryId,
    entryIndex: 0,
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
    lastSeen,
  })

const sessionRow = (db: TestDatabase, id: string) =>
  db.prepare(`SELECT id, expires_at FROM sessions WHERE id = ?`).get(id) as
    | { id: string; expires_at: number }
    | undefined

test('password checks and sessions bind to the intended account', async () => {
  await withDatabase(async (db) => {
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
    assert.equal(sessionRow(db, aliceSession.sessionId), undefined, 'raw tokens are never stored')

    const aliceContext = findSessionContext(db, aliceSession.sessionId)
    assert.equal(aliceContext?.sessionId, aliceSession.sessionId)
    assert.equal(aliceContext?.csrfToken, aliceSession.csrfToken)
    assert.deepEqual(aliceContext?.user, alice)
    assert.equal(aliceContext?.renewed, false)
    assert.deepEqual(findSessionUser(db, aliceSession.sessionId), alice)
    assert.deepEqual(findSessionUser(db, bobSession.sessionId), bob)

    db.prepare(`INSERT INTO sessions (id, user_id, expires_at, csrf_token, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      'session_legacy',
      bob.id,
      Date.now() + SESSION_TTL_MS,
      'legacy-csrf-token',
      new Date().toISOString(),
    )
    const legacyContext = findSessionContext(db, 'session_legacy')
    assert.equal(legacyContext?.csrfToken, 'legacy-csrf-token')
    assert.deepEqual(legacyContext?.user, bob)
    assert.equal(sessionRow(db, 'session_legacy'), undefined, 'legacy raw ids are migrated to hashes')
    assert.deepEqual(findSessionUser(db, 'session_legacy'), bob)

    db.prepare(`INSERT INTO sessions (id, user_id, expires_at, csrf_token, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      'session_expired',
      alice.id,
      Date.now() - 1,
      'expired-csrf-token',
      '2026-06-14T00:00:00.000Z',
    )
    assert.equal(findSessionUser(db, 'session_expired'), null)

    clearSession(db, aliceSession.sessionId)
    assert.equal(findSessionUser(db, aliceSession.sessionId), null)
    assert.deepEqual(findSessionUser(db, bobSession.sessionId), bob)
  })
})

test('sessions in use are extended before they expire', async () => {
  await withDatabase(async (db) => {
    const reader = await signupUser(db, 'Reader', 'reader-secret')
    const session = createSession(db, reader.id)
    const nearlyExpired = Date.now() + 60_000
    db.prepare(`UPDATE sessions SET expires_at = ?`).run(nearlyExpired)

    const context = findSessionContext(db, session.sessionId)
    assert.equal(context?.renewed, true)
    assert.equal((context?.expiresAt ?? 0) > Date.now() + SESSION_TTL_MS - 5_000, true)

    const followUp = findSessionContext(db, session.sessionId)
    assert.equal(followUp?.renewed, false, 'a fresh session is not rewritten on every request')
  })
})

test('library state, bookmarks, and reading positions stay isolated per user', async () => {
  await withDatabase(async (db) => {
    const fixture = seedLibraryFixture(db)
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
})

test('bookmark writes can preserve offline recency timestamps during reconnect', async () => {
  await withDatabase(async (db) => {
    const fixture = seedLibraryFixture(db)
    const user = await signupUser(db, 'Reader', 'reader-secret')
    const offlineTimestamp = '2026-08-22T12:00:00.000Z'
    const resumedTimestamp = '2026-08-23T12:00:00.000Z'

    saveFixtureBookmark(db, user, fixture, 2, offlineTimestamp)
    assert.equal(getAppState(db, config, user).bookmarks[0]?.lastSeen, offlineTimestamp)

    saveFixtureBookmark(db, user, fixture, 3, resumedTimestamp)
    const state = getAppState(db, config, user)
    assert.equal(state.bookmarks[0]?.lastSeen, resumedTimestamp)
    assert.equal(state.bookmarks[0]?.progress, 'Page 3 of 10')
  })
})

test('an older offline bookmark cannot overwrite newer server reading progress', async () => {
  await withDatabase(async (db) => {
    const fixture = seedLibraryFixture(db)
    const user = await signupUser(db, 'Reader', 'reader-secret')

    saveFixtureBookmark(db, user, fixture, 8, '2026-08-23T12:00:00.000Z')
    saveFixtureBookmark(db, user, fixture, 2, '2026-08-23T11:00:00.000Z')

    const state = getAppState(db, config, user)
    assert.equal(state.bookmarks[0]?.lastSeen, '2026-08-23T12:00:00.000Z')
    assert.equal(state.bookmarks[0]?.progress, 'Page 8 of 10')
    assert.equal(state.readingPositions[fixture.entryId]?.page, 8)
  })
})

test('compact progress saves return only what changed and keep exact locators', async () => {
  await withDatabase(async (db) => {
    const fixture = seedLibraryFixture(db)
    const user = await signupUser(db, 'Reader', 'reader-secret')

    const result = saveReadingProgress(db, user, {
      seriesId: fixture.seriesId,
      entryId: fixture.entryId,
      entryIndex: 0,
      category: 'books',
      progress: '41% through book',
      cue: 'Chapter 001',
      position: { page: 41.4, totalPages: 100, locationType: 'percent', locator: 'epubcfi(/6/4!/4/2/1:0)' },
    })

    assert.equal(result.saved, true)
    assert.equal(result.bookmark?.category, 'manga', 'the category always comes from the library')
    assert.equal(result.position?.page, 41)
    assert.equal(result.position?.locator, 'epubcfi(/6/4!/4/2/1:0)')

    const stale = saveReadingProgress(db, user, {
      seriesId: fixture.seriesId,
      entryId: fixture.entryId,
      entryIndex: 0,
      progress: 'older',
      cue: '',
      position: { page: 1 },
      lastSeen: '2020-01-01T00:00:00.000Z',
    })
    assert.equal(stale.saved, false)
    assert.equal(stale.position?.page, 41)

    assert.throws(
      () => saveReadingProgress(db, user, {
        seriesId: fixture.seriesId,
        entryId: fixture.entryId,
        entryIndex: 0,
        progress: '',
        cue: '',
        position: undefined,
      }),
      /Reading position is missing/,
    )
  })
})

test('the library revision changes only when summaries change', async () => {
  await withDatabase(async (db) => {
    seedLibraryFixture(db)
    const reader = await signupUser(db, 'Reader', 'reader-secret')
    const revision = getLibraryRevision(db)
    const state = getAppState(db, config, reader, null, { knownLibraryRevision: revision })

    assert.equal(state.libraryUnchanged, true)
    assert.deepEqual(state.library, [])
    assert.equal(state.libraryRevision, revision)

    db.prepare(`UPDATE series SET title = 'Renamed', updated_at = ?`).run('2026-09-01T00:00:00.000Z')
    const changed = getAppState(db, config, reader, null, { knownLibraryRevision: revision, compact: true })
    assert.equal(changed.libraryUnchanged, false)
    assert.equal(changed.library[0]?.title, 'Renamed')
    assert.notEqual(changed.libraryRevision, revision)
  })
})

test('admin-only state is hidden from member accounts', async () => {
  await withDatabase(async (db) => {
    seedLibraryFixture(db)
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
})

test('administrators can add and remove accounts without open signup', async () => {
  await withDatabase(async (db) => {
    await bootstrapAdminUser(db, config)
    const admin = await loginUser(db, 'admin', 'admin-secret')

    await createUserAccount(db, { username: 'Guest Reader', password: 'guest-secret-1' })
    await assert.rejects(createUserAccount(db, { username: 'guest reader', password: 'another-secret' }), /already exists/)
    await assert.rejects(createUserAccount(db, { username: 'x', password: 'long-enough-1' }), /Usernames need/)
    await assert.rejects(createUserAccount(db, { username: 'Short', password: 'short' }), /at least 8/)

    const guest = await loginUser(db, 'Guest Reader', 'guest-secret-1')
    assert.equal(guest.role, 'member')
    createSession(db, guest.id)

    assert.throws(() => deleteUserAccount(db, config, admin, admin.id), /your own account/)
    deleteUserAccount(db, config, admin, guest.id)
    await assert.rejects(loginUser(db, 'Guest Reader', 'guest-secret-1'), /Unknown username/)
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?`).get(guest.id) as { count: number }).count,
      0,
    )
  })
})
