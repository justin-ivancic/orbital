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
- Incremental scanning for anime, manga, novels, books, and magazines
- Authenticated local media serving
- Local cover fallbacks for folders, PDFs, CBZ files, and generated placeholders
- PWA app shell with explicit offline downloads for chapters, books, and series
- Downloads management with estimated size, verified local bytes, browser quota, repair, and delete controls

The repository does not include personal media, databases, logs, generated builds, or local environment files.

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

## Production Build

```bash
npm install
npm run build
npm run start
```

The app serves the built frontend from the same Node server in production mode.

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
