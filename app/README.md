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

- `GET /healthz` returns a DB-backed health payload.
- `GET /api/health` is kept for compatibility.
- the Docker image includes a healthcheck against `/healthz`.
- the container runs as a non-root user, drops Linux capabilities, and defaults to localhost-only port binding.

## Persistence

All app data is stored under `APP_DATA_DIR`:

- SQLite database
- generated covers
- user accounts
- bookmarks
- comments
- scan state

Media files remain in the mounted media folder and are streamed on demand.
