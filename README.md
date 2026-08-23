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
- Device-local offline downloads for chapters, books, and series through the PWA
- Installable Android app with app-private offline storage for downloaded content
- Downloads screen with estimated size, verified local bytes, browser quota, repair, and delete controls
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
npm run mobile:assemble
```

### Android app

Orbital includes a Capacitor Android target. The APK bundles the web interface
locally, while the existing Express server and NAS-backed media library remain
the source of truth. Sign in while online, download books or series from the
Downloads screen, and the installed app can open those copies without a network
connection. The downloaded files live in the app's private Android storage and
are separate from browser/PWA storage.

Build a debug APK from `app/`:

```bash
npm run mobile:assemble
```

The result is `app/android/app/build/outputs/apk/debug/app-debug.apk`. Transfer
that file to the Boox and install it, then sign in and download the content you
want before leaving connectivity. To make the current APK available from
Orbital’s Profile page, run `npm run mobile:publish` from `app/`; it copies the
APK to `app/mobile-distribution/orbital-android.apk` and serves it at
`/api/mobile/app.apk`.

The native client defaults to `https://library.justinivancic.com`. Set
`VITE_ORBITAL_API_BASE_URL` at build time only when using another server.

## Configuration

The most important environment variables are:

| Variable | Purpose |
| --- | --- |
| `HOST_BIND_ADDR` | Host interface for Docker port binding. Defaults to `127.0.0.1`; set to `0.0.0.0` only when a proxy/firewall protects it. |
| `APP_ADMIN_USERNAME` | Bootstrap admin username. Defaults to `admin`. |
| `APP_ADMIN_PASSWORD` | Required bootstrap admin password. |
| `APP_OPEN_SIGNUP` | Set to `1` only when you intentionally want public self-signup. Production Docker defaults to `0`. |
| `APP_DATA_HOST_DIR` | Host directory for persistent Docker app data. |
| `MEDIA_HOST_DIR` | Host folder or mounted share containing media files. |
| `APP_MEDIA_ROOT_LABEL` | Display name for the mounted media root. |
| `APP_COOKIE_SECURE` | Set to `1` when serving behind HTTPS. |
| `APP_ENABLE_HSTS` | Set to `1` only after HTTPS is confirmed. |
| `APP_TRUST_PROXY` | Set to `1` only when Orbital is behind a trusted reverse proxy. |
| `APP_MOBILE_ORIGINS` | Comma-separated Capacitor origins allowed to call the bearer-token mobile API. The default is `https://localhost,capacitor://localhost`. |

See [`app/.env.example`](app/.env.example) for the full example.

## Privacy Model

Orbital is built around local ownership:

- media files remain in your mounted folder
- SQLite data stays in the configured app data directory
- offline downloads are explicit per-device browser storage, scoped to the signed-in Orbital user
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
- Leave `APP_OPEN_SIGNUP=0` unless you intentionally want new people to self-register.
- Mount media read-only when possible.
- Keep the default localhost Docker bind unless a reverse proxy or firewall protects the app.
- Use `/healthz` for container and reverse-proxy health checks.
- Serve `/sw.js` with `Service-Worker-Allowed: /` and `Cache-Control: no-cache`; the bundled server does this automatically.
- Do not edge-cache `/api/*`, `/api/media/*`, `/api/offline/*`, or other authenticated media routes. Cache only immutable built assets such as `/assets/*`.
- If Cloudflare applies a verification challenge globally, exclude the authenticated API and media paths used by the Android client; the native app cannot complete an interactive browser challenge for background API and download requests.
- Keep proxy compression/transforms off for media responses so range requests and offline byte verification remain stable.
- Keep `data/` backed up if bookmarks, users, comments, and scan state matter.
- Do not commit `.env`, local databases, media folders, or generated builds.

## Project Status

Orbital is an early self-hosted app. The core local-library workflow is present, but the project should still be treated as actively evolving.

## License

No open-source license has been selected yet.
