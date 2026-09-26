# Orbital

Orbital is a self-hosted reading library. Point it at folders of books, manga, web
novels and magazines on your server or NAS, and read them in any browser or in
the Android app, with your place kept across devices.

The interface is designed for e-ink first: paper-and-ink colours, no animation,
large touch targets, and page turns by tapping or swiping. It works just as well
on a phone, tablet or desktop browser.

Your files stay where they are. Orbital indexes them, streams pages on demand
and keeps its own data (users, progress, comments, covers) in a local SQLite
database. Nothing is sent to outside services unless an administrator turns on
online metadata lookups.

## Features

- **Readers for every format.** Paged EPUB with typography controls, PDF with
  streaming and pre-rendered neighbouring pages, CBZ with read-ahead, and
  paginated HTML, Markdown and plain-text chapters.
- **Made for e-ink.** Light, dark and system themes, adjustable text size, font,
  spacing and margins, two tap layouts (edges, or mostly forward), and page
  turns with no motion.
- **Continue where you left off.** Progress saves on the device first and syncs
  in the background, so reading works on flaky connections, and the most recent
  position wins across devices.
- **Offline downloads.** Download a book, a chapter or a whole series and read it
  without a connection, in the Android app (app-private storage) or a browser
  (installed web app).
- **A library that sorts itself.** Series grouping, volume and chapter detection,
  covers from the files themselves, embedded EPUB, PDF and ComicInfo metadata,
  topics, author pages, sorting and instant search.
- **Simple administration.** Add a media folder in three steps, watch scans live,
  fix titles and covers, manage readers, and share the Android app from your own
  server.
- **English and German interface.**

## Supported files

Every media folder you add gets a type. The type decides how files are grouped
and which formats are picked up.

| Type | Formats | Grouping |
| --- | --- | --- |
| Books | `epub`, `pdf`, `txt`, `md`, `html`, `htm` (`mobi`, `azw3` and `azw` are listed, and a browser can download the original, but the app can't open them) | Each file is a title unless a folder groups several files |
| Manga | `cbz`, `pdf`, `epub` | Each folder is a series; each file is a chapter or volume |
| Novels | `html`, `htm`, `md`, `txt`, `epub`, `pdf` | One folder per novel, one file per chapter |
| Magazines | `pdf`, `cbz`, `epub`, `html`, `htm`, `md`, `txt` | One folder per magazine, one file per issue |

## Quick start (Docker)

You need Docker with the Compose plugin.

```bash
git clone <this repository> orbital
cd orbital/app
cp .env.example .env
mkdir -p data library
```

Open `.env` and set a strong admin password:

```bash
APP_ADMIN_PASSWORD=choose-a-long-password
```

Put your files in `app/library`, one subfolder per type (for example
`library/books` and `library/manga`), or point `MEDIA_HOST_DIR` at an existing
folder. Then start Orbital:

```bash
docker compose up -d --build
```

Open `http://localhost:4310` and sign in as `admin` with the password you set.

### First run

1. Open **Admin → Library** and choose **Add folder**.
2. Pick what the folder contains (books, manga, novels or magazines).
3. Browse to the folder inside your storage and choose **Use this folder**, then
   **Add and scan**.

The first scan reads covers and embedded metadata, so a large library takes a
while. You can start reading as soon as titles appear. Later scans only look at
what changed. Use **Scan for changes** after adding files, or **Rescan** on a
single folder.

The admin account is created on the first start. Changing
`APP_ADMIN_PASSWORD` afterwards does not change the password of an existing
account. Change it in **Settings** instead.

### Media on a NAS

Mount the share on the Docker host and set `MEDIA_HOST_DIR` to the mount point.
Or let Docker mount it over SMB with the NAS override file:

```bash
docker compose -f compose.yaml -f compose.nas.yaml up -d --build
```

Set `NAS_SHARE`, `NAS_USERNAME`, `NAS_PASSWORD` and the other `NAS_*` values
in `.env` (see [`app/.env.example`](app/.env.example)). Orbital only needs read
access; the media is mounted read-only.

## Running on a public address

Orbital is meant to sit behind a reverse proxy that terminates HTTPS, such as
Caddy, nginx, Traefik or a platform like Coolify. Set these variables when it
does:

```bash
APP_COOKIE_SECURE=1   # session cookies only over HTTPS
APP_TRUST_PROXY=1     # read the client address from the proxy (hop count)
APP_ENABLE_HSTS=1     # optional, once HTTPS works everywhere
```

- Keep `HOST_BIND_ADDR=127.0.0.1` when the proxy runs on the same machine, so
  the plain HTTP port is not reachable from outside.
- Use `/healthz` for health checks. It is cheap and does not touch the media
  mount. `/readyz` checks the database, data folder and media root, and is meant
  for diagnostics.
- Back up the data directory (`app/data` by default). It holds the database,
  generated covers and the uploaded Android app.

### Coolify

1. Create a resource from this repository and pick the **Dockerfile** build pack
   with `app` as the base directory. The Dockerfile listens on port `4300`.
2. Add a persistent volume at `/app/data`.
3. Mount your media into the container, for example a host folder or a CIFS
   volume at `/media/library`, and set `APP_MEDIA_ROOT_PATH=/media/library`.
4. Set `APP_ADMIN_PASSWORD`, `APP_COOKIE_SECURE=1` and `APP_TRUST_PROXY=1`.
5. Set the health check path to `/healthz`.

With automatic deployment on, every push to the tracked branch goes live.

### Cloudflare and other CDNs

- Do not cache `/api/*`. Covers, pages and downloads are private to each account.
  Cache only the built assets under `/assets/*`.
- Media responses are sent as `private, no-transform`. Don't add rules that
  override this, or byte ranges and download size checks can break.
- Keep verification challenges away from `/api/*`. The Android app cannot solve
  a browser challenge and would treat the server as offline.
- Orbital treats gateway errors (502, 503, 504 and Cloudflare 52x) as "offline",
  keeps showing the cached library and retries on its own.

## Android app

The Android app bundles the interface, stores downloads in app-private storage
and opens straight into your library when you are offline.

**Installing.** On the device, open Orbital in the browser, go to **Settings**
and tap **Android app** to download the APK from your server. An administrator
makes it available first, in one of these ways (checked in this order):

1. Upload an APK in **Admin → System**.
2. Place an APK at `app/mobile-distribution/orbital-android.apk` before building
   the image yourself. The repository never contains APKs.
3. Set `APP_ANDROID_APK_URL` to an HTTPS download address.

On first launch the app asks for your server address. It must be an `https://`
address. The app remembers it. **Change**, next to the address on the sign-in
screen, resets it.

**Updates.** **Settings → App** shows the installed version and offers an
update when the server has a newer version code. Android only updates
an app in place when the new APK is signed with the same key. A different key
means uninstalling first, which deletes downloads. See
[`app/README.md`](app/README.md#android-app) for building and signing.

## Configuration

Set these in `app/.env` for Docker Compose, or as environment variables anywhere
else.

### Server

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_ADMIN_PASSWORD` | (required) | Password for the first admin account. The server does not start without it. |
| `APP_ADMIN_USERNAME` | `admin` | Username of the first admin account. |
| `APP_NAME` | `Orbital Library` | Name shown on the sign-in screen and in the browser tab. |
| `APP_OPEN_SIGNUP` | `0` in production | `1` lets anyone who can reach the server create a reader account. |
| `PORT` | `4300` | Port the server listens on inside the container. |
| `APP_DATA_DIR` | `/app/data` in Docker, `./data` otherwise | Database, covers, thumbnails and the uploaded APK. |
| `APP_COOKIE_SECURE` | `1` in production, `0` in the Compose file | Send session cookies over HTTPS only. Set `1` behind HTTPS. |
| `APP_TRUST_PROXY` | off | `1` (or another hop count) behind a reverse proxy. Also accepts an Express "trust proxy" value such as `loopback`. |
| `APP_ENABLE_HSTS` | `0` | `1` sends `Strict-Transport-Security`. Only enable once HTTPS is permanent. |
| `APP_MOBILE_ORIGINS` | `https://localhost,capacitor://localhost` | Origins the Android app may call the API from. |
| `APP_REMOTE_METADATA` | unset | Unset lets an admin decide in **Admin → Metadata** (off by default). `1` or `0` forces lookups on or off. |
| `APP_ANDROID_APK_URL` | unset | HTTPS address of an APK, used when none is uploaded or bundled. |

### Media

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEDIA_HOST_DIR` | `./library` | Folder on the Docker host that holds your media (Compose). |
| `APP_MEDIA_ROOT_PATH` | `/media/library` in Compose | Where the media is mounted inside the container. It appears in **Admin → Library** as storage from the server configuration. |
| `APP_MEDIA_ROOT_LABEL` | the folder name | Name of that storage in the admin screens. |
| `APP_MEDIA_ROOT_DISPLAY_PATH` | `MEDIA_HOST_DIR` | Path shown to admins, for example the NAS share. |

### Docker Compose only

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST_BIND_ADDR` | `127.0.0.1` | Host address the port is published on. Use `0.0.0.0` only behind a firewall or proxy. |
| `HOST_PORT` | `4310` | Host port. |
| `APP_DATA_HOST_DIR` | `./data` | Host folder for the data directory. |
| `NAS_*` | | SMB settings for `compose.nas.yaml`, see `.env.example`. |

### Tuning (optional)

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_CBZ_PAGE_CACHE_MB` | `96` | Memory for recently read CBZ pages. |
| `APP_CBZ_READ_AHEAD_PAGES` | `4` | CBZ pages prepared ahead of the reader. |
| `APP_CBZ_MANIFEST_CACHE_ENTRIES` | `128` | CBZ archive indexes kept in memory. |
| `APP_CBZ_MAX_PAGES` | `5000` | Largest page count accepted per archive. |
| `APP_CBZ_MAX_ENTRIES` | `20000` | Largest number of files accepted per archive. |
| `APP_CBZ_MAX_PAGE_BYTES` | `83886080` (80 MB) | Largest single page accepted. |
| `APP_CBZ_MAX_CENTRAL_DIRECTORY_BYTES` | `67108864` (64 MB) | Largest archive index accepted. |

### Build time

| Variable | Purpose |
| --- | --- |
| `VITE_ORBITAL_API_BASE_URL` | Pre-fills a server address in a self-built Android APK. Without it the app asks on first launch. |

## Privacy and security

- Media files are never modified, and are mounted read-only in the provided
  Compose setup.
- Everything Orbital stores lives in the data directory on your server.
- Online metadata is off by default. When an admin enables it, titles and
  authors of items without embedded details are sent to AniList and Google
  Books during scans.
- Passwords are hashed with bcrypt. Sign-in, sign-up and password changes are
  rate limited. Browser sessions use `HttpOnly`, `SameSite=Strict` cookies with
  CSRF tokens. The Android app keeps its sign-in token encrypted with a key from
  the Android Keystore.
- Offline downloads are tied to the account that made them and hidden from
  other accounts on the same device. They are not encrypted, so treat an
  unlocked device like an open book.
- Account signup is closed unless you set `APP_OPEN_SIGNUP=1`. Admins add readers
  in **Admin → Users**.

## Development

```bash
cd app
cp .env.example .env    # set APP_ADMIN_PASSWORD
npm install
npm run dev             # frontend on :5173, server on :4300
```

See [`app/README.md`](app/README.md) for scripts, tests, the Android build and
how the code is organised.

## Repository layout

```text
app/
  server/        Express API, SQLite, library scanner, metadata, media streaming
  src/           React interface, readers and offline storage
  android/       Capacitor Android project
  public/        Static files, service worker, PDF.js assets
  scripts/       Build helpers
  docs/          Design notes
```

## Status and license

Orbital is young and changes often. Back up your data directory before
upgrading.

No open-source license has been chosen yet. Until one is, all rights are
reserved by the authors.
