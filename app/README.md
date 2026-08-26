# Orbital Library App

Orbital Library is a self-hosted media library for browsing and reading locally mounted files.

## What is included

- React frontend
- Express backend with SQLite persistence
- Bootstrap admin account through environment variables
- Optional open signup for regular users
- Manual bookmarks with per-user saved reader position
- Series-level comments
- Admin UI for linking mounted folders
- Incremental scanning for anime, manga, novels, books, and magazines; bounded parallel inventory checks reuse unchanged entries, detected moves preserve IDs, durable per-series checkpoints resume interrupted work without restarting completed items, large series commit in safe batches, risky PDF/CBZ cover extraction runs in isolated workers, and incomplete source scans preserve existing records
- Authenticated local media serving
- Local cover fallbacks for folders, PDFs, CBZ files, and generated placeholders
- PWA app shell with explicit offline downloads for chapters, books, and series
- Installable Capacitor Android app with app-private offline storage
- Downloads management with estimated size, verified local bytes, browser quota, repair, and delete controls
- Naturally loaded cover images are stored in the same verified app-private filesystem used by Android downloads, with cover storage accounting, an on-device self-test, and cleanup controls in Downloads
- Direct Android APK download from the authenticated Profile page

The repository does not include personal media, databases, logs, or local environment files. It includes the current debug APK in `mobile-distribution/` so the deployed Profile page can provide a direct device download.

## Local Development

```bash
cp .env.example .env
npm install
npm run dev
```

Set `APP_ADMIN_PASSWORD` in `.env` before starting the server.

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:4300`

The default bootstrap admin username is `admin` unless `APP_ADMIN_USERNAME` is set.

Demo seeding is disabled by default. To seed demo files in a local-only environment, set `APP_ENABLE_DEMO_SEED=1` and provide `APP_DEMO_FILES_ROOT`.

## Android app

The Android target packages the Orbital interface inside an installable APK.
The server, SQLite database, and NAS-backed media remain unchanged. After
installing, sign in while online and download the books or series you want from
`Downloads`; those copies are stored in Android app-private storage and remain
readable without Wi-Fi. Cover images that become visible while browsing are
stored separately in the same app-private area, so cached bookmarks and library
sections can retain their covers offline. Offline startup uses the local profile
and does not require another login.

> **Future APK release note:** The Capacitor Filesystem plugin requires JDK 21;
> JDK 17 is not sufficient. The Android build also needs Android SDK platform
> 36 and build-tools 36.0.0. If the build machine has no Java or Android SDK,
> install those tools in a temporary or developer-local location first, then
> run the commands below from this directory. The pinned Gradle wrapper is
> downloaded automatically when needed.

Before each release, increment `versionCode` and `versionName` in
`android/app/build.gradle`, and `androidAppVersionCode` and
`androidAppVersionName` in `src/platform.ts`.
Keeping the version code higher than the installed APK lets Android update the
app in place without requiring an uninstall, which preserves downloaded books
and series.

Build the debug APK from this directory:

```bash
npm run mobile:assemble
```

The APK is written to
`android/app/build/outputs/apk/debug/app-debug.apk`. The native client defaults
to `https://library.justinivancic.com`; set `VITE_ORBITAL_API_BASE_URL` before
building to target another server. Android cover storage uses the app-private
`Directory.Data` filesystem as its canonical store, so covers remain available
after the app process is closed. IndexedDB is retained only as a compatibility
fallback for older covers. The Android UI renders verified cached covers through
direct app-private file URLs instead of rebuilding base64 images in JavaScript.
The server also creates bounded card thumbnails on first use, and the Downloads
page reports recent cover-loading and page-switching timings for device-level
performance checks.

The header and Profile page include a manual refresh action for reconnecting
after offline use. Series downloads are incremental: verified unchanged files
are copied locally with the native filesystem, interrupted replacements remain
resumable, and the previous complete package is kept until its replacement is
fully ready.

Small offline resources download with bounded concurrency. Progress records are
checkpointed periodically instead of rebuilding storage totals after every
chapter, which keeps library scrolling responsive while a series downloads.

To rebuild and publish the APK that the hosted Profile page serves, run:

```bash
npm run mobile:publish
```

This rebuilds the Android app and copies the result to
`mobile-distribution/orbital-android.apk`. The production server serves that
file at `/api/mobile/app.apk`; keep the route reachable for the browser and
native client. Push the updated APK in the same deployment as the server so the
authenticated Profile page offers the new build directly to the e-reader.

The server accepts the native bearer-token client from the origins in
`APP_MOBILE_ORIGINS` (default: `https://localhost,capacitor://localhost`). If a
Cloudflare verification challenge is enabled for the whole site, exempt the
authenticated API, offline manifest, and media download paths so the installed
client can make non-interactive requests.

## Production Build

```bash
npm install
npm run build
npm run start
```

The app serves the built frontend from the same Node server in production mode.

## Stable URLs

Orbital uses refresh-safe, shareable paths for every primary screen:

- `/login`, `/signup`, `/bookmarks`, `/downloads`, `/search`, `/profile`, and `/admin`
- `/manga`, `/novels`, `/books`, and `/magazines`
- `/:category/:seriesId` for a series
- `/:category/:seriesId/read/:entryId` for a reader
- `/creators/:creatorKey` for a creator
- `/login?next=...` to return to a protected page after signing in

Search scope, shelf filters and sort order live in the query string. Reader URLs
also keep the selected edition and exact page or percentage so a refresh returns
to the same place. Links are ordinary browser links, so copy link, open in a new
tab, Back, and Forward work normally.

The bundled Express production server already returns the app shell for
non-API routes. If another reverse proxy serves the frontend directly, configure
that proxy to fall back to `index.html` for unknown document requests while
leaving `/api/*`, `/assets/*`, `/sw.js`, and media responses untouched.

## Docker

Copy the example environment file and set a real admin password before starting the container:

```bash
cp .env.example .env
mkdir -p data library
docker compose up -d --build
```

By default, Docker stores app state in `./data` and mounts local media from `./library`.

Common environment variables:

- `HOST_BIND_ADDR`: host interface for Docker port binding; defaults to `127.0.0.1`
- `APP_ADMIN_USERNAME`: bootstrap admin username
- `APP_ADMIN_PASSWORD`: required in production
- `APP_OPEN_SIGNUP`: set to `1` only when you intentionally want public self-signup
- `APP_DATA_HOST_DIR`: host directory for SQLite data
- `MEDIA_HOST_DIR`: host directory or mounted share containing media
- `APP_MEDIA_ROOT_LABEL`: display label for the mounted media root
- `APP_COOKIE_SECURE`: set to `1` when serving behind HTTPS
- `APP_ENABLE_HSTS`: set to `1` only after HTTPS is confirmed
- `APP_TRUST_PROXY`: set to `1` only when Orbital is behind a trusted reverse proxy
- `APP_MOBILE_ORIGINS`: comma-separated Capacitor origins allowed for the native client

After the container starts:

1. Sign in as the bootstrap admin.
2. Open `Admin`.
3. Browse the mounted library root.
4. Link subfolders to `Novels`, `Books`, `Manga`, `Anime`, or `Magazines`.
5. Run scans from the admin page when you want to refresh the library.

Container health:

- `GET /healthz` returns a cheap DB-backed liveness payload for container and router health checks.
- `GET /readyz` checks DB access, app data write access, cover cache write access, and the configured media root for admin diagnostics.
- `GET /api/health` is kept for compatibility.
- `GET /api/ready` is kept for environments that prefer API-prefixed probes.
- the Docker image includes a healthcheck against `/healthz`; keep stricter readiness checks out of Docker routing so a slow or temporarily unavailable media mount does not make the app disappear for new clients.
- the container entrypoint repairs `/app/data` ownership for existing persistent volumes, then runs the app as the non-root `node` user when possible.
- the provided Compose file drops Linux capabilities and defaults to localhost-only port binding.

PWA and offline download routing:

- `/sw.js` is served from the site root with `Service-Worker-Allowed: /` and `Cache-Control: no-cache`.
- `/api/offline/capabilities`, `/api/offline/estimate`, and `/api/offline/manifests` describe authenticated download packages without creating server-side archives.
- `/api/offline/manifests/:manifestId/resources/:resourceKey` streams versioned package resources with private immutable headers.
- The browser stores downloaded package metadata and blobs in IndexedDB. Server files, bookmarks, users, and scans are not changed by deleting a device download.
- Reverse proxies and Cloudflare rules should bypass cache for `/api/*`, `/api/media/*`, and `/api/offline/*`. Cache only built static assets such as `/assets/*`.

## Persistence

All app data is stored under `APP_DATA_DIR`:

- SQLite database
- generated covers
- user accounts
- bookmarks
- comments
- scan state

Media files remain in the mounted media folder and are streamed on demand.
