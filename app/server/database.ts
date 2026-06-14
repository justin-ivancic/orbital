import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ensureDir } from './utils'

export type OrbitalDatabase = Database.Database

const categoryCheck = "category IN ('anime', 'manga', 'novels', 'books', 'magazines')"
const databaseFileName = 'orbital.sqlite'

export const openDatabase = (dataDirectory: string) => {
  ensureDir(dataDirectory)
  const databasePath = path.join(dataDirectory, databaseFileName)
  const db = new Database(databasePath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      csrf_token TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_roots (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_folders (
      id TEXT PRIMARY KEY,
      root_id TEXT REFERENCES source_roots(id) ON DELETE SET NULL,
      category TEXT NOT NULL CHECK(${categoryCheck}),
      relative_path TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      item_count INTEGER NOT NULL DEFAULT 0,
      last_scan_at TEXT,
      last_scan_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS series (
      id TEXT PRIMARY KEY,
      source_folder_id TEXT NOT NULL REFERENCES source_folders(id) ON DELETE CASCADE,
      series_key TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL CHECK(${categoryCheck}),
      title TEXT NOT NULL,
      title_short TEXT NOT NULL,
      year INTEGER,
      format TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      cover_path TEXT,
      cover_mime TEXT,
      banner_path TEXT,
      banner_mime TEXT,
      cover_source TEXT NOT NULL,
      metadata_source TEXT NOT NULL,
      remote_provider TEXT,
      remote_id TEXT,
      external_url TEXT,
      source_name TEXT,
      source_role TEXT,
      genres_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      metadata_refreshed_at TEXT,
      file_count INTEGER NOT NULL DEFAULT 0,
      last_scan_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      source_folder_id TEXT NOT NULL REFERENCES source_folders(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL UNIQUE,
      storage_file TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      label TEXT NOT NULL,
      title TEXT NOT NULL,
      format TEXT NOT NULL,
      details TEXT NOT NULL,
      chapter_number REAL,
      season_number INTEGER,
      episode_number INTEGER,
      sort_order REAL NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      entry_index INTEGER NOT NULL,
      category TEXT NOT NULL CHECK(${categoryCheck}),
      progress TEXT NOT NULL,
      cue TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (user_id, series_id)
    );

    CREATE TABLE IF NOT EXISTS reading_positions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      total_pages INTEGER,
      view_mode TEXT,
      location_type TEXT,
      progress_label TEXT,
      cue_label TEXT,
      PRIMARY KEY (user_id, entry_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata_overrides (
      series_id TEXT PRIMARY KEY REFERENCES series(id) ON DELETE CASCADE,
      title TEXT,
      year INTEGER,
      description TEXT,
      cover_path TEXT,
      cover_mime TEXT,
      external_url TEXT,
      source_name TEXT,
      source_role TEXT,
      base_title TEXT,
      base_year INTEGER,
      base_description TEXT,
      base_cover_path TEXT,
      base_cover_mime TEXT,
      base_cover_source TEXT,
      base_external_url TEXT,
      base_source_name TEXT,
      base_source_role TEXT,
      base_metadata_source TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scan_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      changed_files INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS scan_events (
      id TEXT PRIMARY KEY,
      scan_run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
      level TEXT NOT NULL CHECK(level IN ('info', 'success', 'error')),
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      key TEXT PRIMARY KEY,
      points INTEGER NOT NULL,
      window_reset_at INTEGER NOT NULL,
      blocked_until INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expiry
      ON rate_limit_buckets (window_reset_at, blocked_until);
  `)

  const ensureColumn = (tableName: string, columnName: string, definition: string) => {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string
    }>

    if (!columns.some((column) => column.name === columnName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
    }
  }

  ensureColumn('entries', 'chapter_number', 'REAL')
  ensureColumn('sessions', 'csrf_token', 'TEXT')
  ensureColumn('entries', 'season_number', 'INTEGER')
  ensureColumn('entries', 'episode_number', 'INTEGER')
  ensureColumn('entries', 'sort_order', 'REAL NOT NULL DEFAULT 0')
  ensureColumn('bookmarks', 'entry_index', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('bookmarks', 'category', "TEXT NOT NULL DEFAULT 'anime'")
  ensureColumn('source_folders', 'relative_path', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('source_folders', 'item_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('source_folders', 'enabled', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('series', 'cover_mime', 'TEXT')
  ensureColumn('series', 'banner_path', 'TEXT')
  ensureColumn('series', 'banner_mime', 'TEXT')
  ensureColumn('series', 'remote_provider', 'TEXT')
  ensureColumn('series', 'remote_id', 'TEXT')
  ensureColumn('series', 'external_url', 'TEXT')
  ensureColumn('series', 'source_name', 'TEXT')
  ensureColumn('series', 'source_role', 'TEXT')
  ensureColumn('series', 'genres_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn('series', 'metadata_refreshed_at', 'TEXT')
  ensureColumn('metadata_overrides', 'external_url', 'TEXT')
  ensureColumn('metadata_overrides', 'source_name', 'TEXT')
  ensureColumn('metadata_overrides', 'source_role', 'TEXT')
  ensureColumn('metadata_overrides', 'base_title', 'TEXT')
  ensureColumn('metadata_overrides', 'base_year', 'INTEGER')
  ensureColumn('metadata_overrides', 'base_description', 'TEXT')
  ensureColumn('metadata_overrides', 'base_cover_path', 'TEXT')
  ensureColumn('metadata_overrides', 'base_cover_mime', 'TEXT')
  ensureColumn('metadata_overrides', 'base_cover_source', 'TEXT')
  ensureColumn('metadata_overrides', 'base_external_url', 'TEXT')
  ensureColumn('metadata_overrides', 'base_source_name', 'TEXT')
  ensureColumn('metadata_overrides', 'base_source_role', 'TEXT')
  ensureColumn('metadata_overrides', 'base_metadata_source', 'TEXT')

  const needsCategoryConstraintMigration = ['source_folders', 'series', 'bookmarks'].some((tableName) => {
    const table = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
      .get(tableName) as { sql: string } | undefined

    return Boolean(table?.sql && !table.sql.includes('magazines'))
  })

  if (needsCategoryConstraintMigration) {
    const migrateCategoryConstraints = db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS temp.source_folders_category_backup;
        DROP TABLE IF EXISTS temp.series_category_backup;
        DROP TABLE IF EXISTS temp.bookmarks_category_backup;

        CREATE TEMP TABLE source_folders_category_backup AS
          SELECT id, root_id, category, relative_path, path, enabled, item_count,
                 last_scan_at, last_scan_status, created_at, updated_at
          FROM source_folders;

        CREATE TEMP TABLE series_category_backup AS
          SELECT id, source_folder_id, series_key, category, title, title_short, year,
                 format, status, description, folder_path, cover_path, cover_mime,
                 banner_path, banner_mime, cover_source, metadata_source, remote_provider,
                 remote_id, external_url, source_name, source_role, genres_json, tags_json,
                 metadata_refreshed_at, file_count, last_scan_at, created_at, updated_at
          FROM series;

        CREATE TEMP TABLE bookmarks_category_backup AS
          SELECT user_id, series_id, entry_id, entry_index, category, progress, cue, last_seen
          FROM bookmarks;

        DROP TABLE bookmarks;
        DROP TABLE series;
        DROP TABLE source_folders;

        CREATE TABLE source_folders (
          id TEXT PRIMARY KEY,
          root_id TEXT REFERENCES source_roots(id) ON DELETE SET NULL,
          category TEXT NOT NULL CHECK(${categoryCheck}),
          relative_path TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1,
          item_count INTEGER NOT NULL DEFAULT 0,
          last_scan_at TEXT,
          last_scan_status TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE series (
          id TEXT PRIMARY KEY,
          source_folder_id TEXT NOT NULL REFERENCES source_folders(id) ON DELETE CASCADE,
          series_key TEXT NOT NULL UNIQUE,
          category TEXT NOT NULL CHECK(${categoryCheck}),
          title TEXT NOT NULL,
          title_short TEXT NOT NULL,
          year INTEGER,
          format TEXT NOT NULL,
          status TEXT NOT NULL,
          description TEXT NOT NULL,
          folder_path TEXT NOT NULL,
          cover_path TEXT,
          cover_mime TEXT,
          banner_path TEXT,
          banner_mime TEXT,
          cover_source TEXT NOT NULL,
          metadata_source TEXT NOT NULL,
          remote_provider TEXT,
          remote_id TEXT,
          external_url TEXT,
          source_name TEXT,
          source_role TEXT,
          genres_json TEXT NOT NULL DEFAULT '[]',
          tags_json TEXT NOT NULL DEFAULT '[]',
          metadata_refreshed_at TEXT,
          file_count INTEGER NOT NULL DEFAULT 0,
          last_scan_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE bookmarks (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
          entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          entry_index INTEGER NOT NULL,
          category TEXT NOT NULL CHECK(${categoryCheck}),
          progress TEXT NOT NULL,
          cue TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY (user_id, series_id)
        );

        INSERT INTO source_folders (
          id, root_id, category, relative_path, path, enabled, item_count,
          last_scan_at, last_scan_status, created_at, updated_at
        )
        SELECT id, root_id, category, relative_path, path, enabled, item_count,
               last_scan_at, last_scan_status, created_at, updated_at
        FROM source_folders_category_backup;

        INSERT INTO series (
          id, source_folder_id, series_key, category, title, title_short, year,
          format, status, description, folder_path, cover_path, cover_mime,
          banner_path, banner_mime, cover_source, metadata_source, remote_provider,
          remote_id, external_url, source_name, source_role, genres_json, tags_json,
          metadata_refreshed_at, file_count, last_scan_at, created_at, updated_at
        )
        SELECT id, source_folder_id, series_key, category, title, title_short, year,
               format, status, description, folder_path, cover_path, cover_mime,
               banner_path, banner_mime, cover_source, metadata_source, remote_provider,
               remote_id, external_url, source_name, source_role, genres_json, tags_json,
               metadata_refreshed_at, file_count, last_scan_at, created_at, updated_at
        FROM series_category_backup;

        INSERT INTO bookmarks (
          user_id, series_id, entry_id, entry_index, category, progress, cue, last_seen
        )
        SELECT user_id, series_id, entry_id, entry_index, category, progress, cue, last_seen
        FROM bookmarks_category_backup;

        DROP TABLE temp.source_folders_category_backup;
        DROP TABLE temp.series_category_backup;
        DROP TABLE temp.bookmarks_category_backup;
      `)

      const foreignKeyIssues = db.prepare(`PRAGMA foreign_key_check`).all()
      if (foreignKeyIssues.length > 0) {
        throw new Error('Database category migration failed foreign key validation.')
      }
    })

    db.pragma('foreign_keys = OFF')
    try {
      migrateCategoryConstraints()
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_series_source_folder ON series(source_folder_id);
    CREATE INDEX IF NOT EXISTS idx_series_category_sort ON series(category, year, title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_entries_series_order ON entries(series_id, sort_order, label, title);
    CREATE INDEX IF NOT EXISTS idx_entries_source_folder ON entries(source_folder_id);
    CREATE INDEX IF NOT EXISTS idx_comments_series_created ON comments(series_id, created_at DESC);
  `)

  const coversDirectory = path.join(dataDirectory, 'covers')
  ensureDir(coversDirectory)

  return {
    db,
    databasePath,
    coversDirectory,
    dataDirectory,
  }
}

export const fileExists = (filePath: string | null | undefined) => {
  if (!filePath) {
    return false
  }

  try {
    return fs.existsSync(filePath)
  } catch {
    return false
  }
}
