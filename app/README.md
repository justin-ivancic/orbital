# Orbital app

This folder holds the whole application: the Express server, the React
interface and the Capacitor Android project. Deployment and configuration are
described in the [main README](../README.md). This file is for working on the
code.

## Getting started

Requires Node.js 20.19+ or 22.12+.

```bash
cp .env.example .env     # set APP_ADMIN_PASSWORD
npm install
npm run dev
```

- Interface: `http://127.0.0.1:5173` (Vite, proxies `/api` to the server)
- Server: `http://127.0.0.1:4300`

`npm run dev` reads `.env`. Variables already set in your shell take precedence.
To browse a local media folder, start the server with
`APP_MEDIA_ROOT_PATH=./library`, or add the folder as storage in
**Admin → Library**. Leave `APP_MEDIA_ROOT_PATH` out of `.env` if you also use
Docker Compose, which sets it for the container.

`APP_ENABLE_DEMO_SEED=1` with `APP_DEMO_FILES_ROOT=<folder>` fills an empty
database with demo folders from that directory, for local testing only.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with reload, plus the Vite dev server |
| `npm run build` | Type-checks everything and builds the interface into `dist/` |
| `npm run start` | Runs the server, which also serves the built interface from `dist/` |
| `npm test` | All `node:test` suites (server and interface logic) |
| `npm run lint` | ESLint, including the React Compiler rules |
| `npm run mobile:build` | Builds the interface and copies it into the Android project |
| `npm run mobile:assemble` | `mobile:build`, then a debug APK |
| `npm run mobile:publish` | `mobile:assemble`, then copies the APK to `mobile-distribution/` |
| `npm run mobile:open` | Opens the Android project in Android Studio |

Before sending changes, run `npm test`, `npm run lint` and `npx tsc -b`. The last
one also type-checks the server, which `tsx` does not do at runtime.

## How the code is organised

### Server (`server/`)

| File | Role |
| --- | --- |
| `index.ts` | Configuration, security headers, sessions and every HTTP route |
| `library.ts` | Folder scanning, title and chapter parsing, grouping, library payloads |
| `database.ts` | SQLite schema and migrations |
| `localMetadata.ts`, `mediaWorker*.ts` | Embedded EPUB, PDF and ComicInfo metadata, and cover extraction, in worker threads |
| `metadata.ts` | Optional online lookups (AniList, Google Books) |
| `cbzArchive.ts`, `zipArchive.ts` | Reading CBZ pages with ranged reads, page cache and read-ahead |
| `mediaResponses.ts`, `mediaVersion.ts` | Streaming with byte ranges and version-stamped URLs |
| `offline.ts` | Download manifests for the offline feature |
| `coverThumbnails.ts` | Card-sized cover thumbnails |
| `androidApp.ts` | APK upload and download |
| `appSettings.ts`, `rateLimit.ts`, `readerPreferences.ts` | Settings stored in the database, rate limits, per-series reader settings |

The scanner reuses unchanged entries, keeps IDs when files move, commits large
series in batches and resumes interrupted scans. Raising
`LIBRARY_SCANNER_VERSION` in `library.ts` makes the next scan reparse every
folder. Raise it when parsing rules change.

### Interface (`src/`)

- `app/`: application state. Small external stores (`store.ts`) for the router,
  session, library, downloads, series details, preferences and notices, read
  with `useStore(store, selector)`.
- `pages/`: one component per screen, `pages/admin/` for the admin tabs.
- `readers/`: `EpubReader`, `PdfReader`, `CbzReader` and `FlowReader` (HTML,
  Markdown, text), sharing `TapSurface` for taps, swipes and keys.
- `shell/`, `ui/`: navigation, top bar, notices, and shared pieces such as
  covers, sheets and title cards.
- `styles/`: design tokens and CSS. `i18n/`: English and German strings.
- `api.ts`, `platform.ts`: the HTTP client, and web versus Android differences.
- `offlineStorage.ts`, `offlineDownloads.ts`: download storage in IndexedDB on
  the web and in app-private files on Android.

Reading progress is local-first. `app/progress.ts` records every page turn on the
device and syncs one pending position per title with retries. A newer position
from another device wins. The library, reading list and series details are
cached in IndexedDB, so the app starts instantly and keeps working offline.
Downloads are described in [`docs/offline-downloads.md`](docs/offline-downloads.md).

### Designing for e-ink

The interface targets a 10" colour e-ink tablet first:

- Paper and ink colour tokens with strong contrast. No transitions or
  animation, since every frame is a screen refresh.
- Touch targets of at least 44px. Hard outlines and offset shadows instead of
  soft shading.
- Pages turn by whole screens. Nothing scrolls continuously while reading.

Check changes at 930×1240 (e-reader), 390×844 (phone) and 1440×900 (desktop).

## Android app

The app id is `app.orbital.library`. The APK contains the built interface and
talks to the server set on first launch.

### Building

You need JDK 21 (JDK 17 is too old for the Capacitor Filesystem plugin) and the
Android SDK with platform 36 and build-tools 36.0.0. The Gradle wrapper
downloads Gradle itself.

```bash
npm run mobile:assemble
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

### Versions and signing

Before each release, raise the version in both places, keeping them equal:

- `versionCode` and `versionName` in `android/app/build.gradle`
- `androidAppVersionCode` and `androidAppVersionName` in `src/platform.ts`

The interface compares its version code with the one on the server and offers
the update in **Settings**.

Android installs an update over an existing app only when both are signed with
the same key. Debug builds use `~/.android/debug.keystore` of the machine that
builds them. Build from the same machine (or keep a copy of that keystore), or
set up a release keystore. Switching keys means uninstalling, which deletes all
downloads on the device.

### Distributing

Upload the APK in **Admin → System** (with its version name and code). Readers
then get it from **Settings** in the browser, at `/api/mobile/app.apk`. The
server looks for an APK in this order:

1. The upload, stored in the data directory (`android/orbital-android.apk`).
2. `mobile-distribution/orbital-android.apk` in the image, which
   `npm run mobile:publish` writes. APKs are never committed.
3. The address in `APP_ANDROID_APK_URL`.

## URLs

Every screen has a stable address that survives a refresh and can be shared:

| Path | Screen |
| --- | --- |
| `/` | Home: continue reading and shelves |
| `/books`, `/manga`, `/novels`, `/magazines` | Library sections (`?sort=`, `?topic=`, `?page=`) |
| `/:section/:seriesId` | A title (`?tab=overview`, `?tab=comments`) |
| `/:section/:seriesId/read/:entryId` | The reader, with the position in the query |
| `/downloads/:downloadId/read/entry/:entryId` | Reading a download |
| `/search?q=` | Search |
| `/creators/:creatorKey` | An author's titles |
| `/downloads`, `/settings`, `/admin?tab=` | Downloads, settings, admin |
| `/login?next=` | Sign in, then return to `next` |

Older paths (`/bookmarks`, `/profile`) redirect to their new screens.

## Serving behind a proxy

The server returns the app for every non-API path, so the bundled server needs
no extra rules. If another proxy serves `dist/` itself:

- Fall back to `index.html` for unknown paths. Leave `/api/*`, `/assets/*`
  and `/sw.js` alone.
- Serve `/sw.js` with `Service-Worker-Allowed: /` and
  `Cache-Control: no-cache`.
- Cache `/assets/*` for a long time; the file names change with every build.

Health endpoints:

- `GET /healthz` (also `/api/health`): cheap liveness check, used by the Docker
  health check.
- `GET /readyz` (also `/api/ready`): checks the database, the data and cover
  folders, and the media root. Use it for diagnostics, not for routing
  decisions, so a slow NAS never takes the app offline.

## Data

Everything lives in `APP_DATA_DIR`: the SQLite database (users, sessions,
progress, comments, folders, scan state, metadata), generated covers and
thumbnails, and the uploaded APK. Media folders are only read.
