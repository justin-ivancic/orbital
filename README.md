# Orbital

Orbital is a self-hosted media library for browsing, reading, and watching files that stay on your own machine or server. It is designed for personal archives where the app should index local folders, preserve reader progress, and serve media through a private web interface without uploading the library anywhere else.

The repository ships as an empty library app. It does not include personal media, databases, logs, generated builds, local environment files, or sample archives.

## Features

- React web app with an Express API
- SQLite persistence for users, sessions, bookmarks, comments, scans, and metadata
- Admin-managed source roots and media folders
- Authenticated file streaming from mounted local folders
- Reader and player support for books, novels, manga, magazines, and video
- Bookmark and reading-position tracking per user
- Series comments and basic account management
- Optional metadata refresh through remote providers
- Docker-friendly deployment with bind-mounted media and app data

## Supported Media

Orbital scans linked folders into these library sections:

| Section | Formats |
| --- | --- |
| Anime | `mkv`, `mp4`, `avi`, `m4v`, `mov` |
| Manga | `cbz`, `pdf`, `epub` |
| Novels | `html`, `htm`, `md`, `pdf`, `epub`, `txt` |
| Books | `pdf`, `epub`, `mobi`, `azw3`, `txt`, `md`, `html`, `htm` |
| Magazines | `pdf`, `cbz`, `epub` |

## Quick Start

The app lives in [`app/`](app/).

```bash
cd app
cp .env.example .env
mkdir -p data library
```

Edit `.env` and set at least:

```bash
APP_ADMIN_PASSWORD=change-this-password
```

Then start with Docker:

```bash
docker compose up -d --build
```

By default:

- app data is stored in `app/data`
- media is mounted from `app/library`
- the web app is available at `http://localhost:4310`
- the bootstrap admin username is `admin`

After signing in, open `Admin`, browse the mounted library root, link media subfolders to sections, and run a scan.

## Local Development

```bash
cd app
cp .env.example .env
npm install
npm run dev
```

Set `APP_ADMIN_PASSWORD` in `.env` before starting the server.

Development services:

- frontend: `http://127.0.0.1:5173`
- backend: `http://127.0.0.1:4300`

Useful scripts:

```bash
npm run dev
npm run build
npm run lint
npm run start
```

## Configuration

The most important environment variables are:

| Variable | Purpose |
| --- | --- |
| `APP_ADMIN_USERNAME` | Bootstrap admin username. Defaults to `admin`. |
| `APP_ADMIN_PASSWORD` | Required bootstrap admin password. |
| `APP_OPEN_SIGNUP` | Set to `0` to disable public self-signup. |
| `APP_DATA_HOST_DIR` | Host directory for persistent Docker app data. |
| `MEDIA_HOST_DIR` | Host folder or mounted share containing media files. |
| `APP_MEDIA_ROOT_LABEL` | Display name for the mounted media root. |
| `APP_COOKIE_SECURE` | Set to `1` when serving behind HTTPS. |

See [`app/.env.example`](app/.env.example) for the full example.

## Privacy Model

Orbital is built around local ownership:

- media files remain in your mounted folder
- SQLite data stays in the configured app data directory
- `.env`, databases, generated builds, logs, test artifacts, and media folders are ignored by Git
- demo seeding is disabled unless explicitly configured with `APP_ENABLE_DEMO_SEED=1`

Metadata refresh can call external providers for lookup data. Keep that feature disabled or avoid using it if your library titles should never leave the server.

## Repository Layout

```text
app/
  server/       Express API, SQLite persistence, scanning, metadata, streaming
  src/          React frontend
  public/       Static assets and PDF.js runtime assets
  scripts/      Build support scripts
```

## Production Notes

- Always set a strong `APP_ADMIN_PASSWORD`.
- Use `APP_COOKIE_SECURE=1` behind HTTPS.
- Mount media read-only when possible.
- Keep `data/` backed up if bookmarks, users, comments, and scan state matter.
- Do not commit `.env`, local databases, media folders, or generated builds.

## Project Status

Orbital is an early self-hosted app. The core local-library workflow is present, but the project should still be treated as actively evolving.

## License

No open-source license has been selected yet.
