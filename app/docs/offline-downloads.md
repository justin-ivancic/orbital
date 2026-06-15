# Offline Downloads

Orbital offline downloads are explicit device-local packages. Normal browsing caches are not treated as downloads.

## Architecture

- The server creates authenticated manifests through `POST /api/offline/manifests`.
- A manifest is a versioned snapshot of one entry or one series.
- CBZ downloads store extracted page image responses, not the raw archive.
- PDF, EPUB, text, HTML, and other file downloads store the file response as one resource.
- The browser stores package records and resource blobs in IndexedDB.
- The service worker serves local bytes through `/__orbital_offline/resources/:resourceKey`.
- The Downloads tab is the source of truth for local package state, size, repair, and delete actions.

## Privacy And Account Scope

- Every package record includes the Orbital user id, username, server instance id, manifest id, and media versions.
- The Downloads tab only lists packages for the active user id.
- Logging out does not delete downloads, but they are hidden until that user is active again.
- Deleting downloads removes browser-local blobs and package records only. Server media, bookmarks, users, comments, and scans stay unchanged.
- This is not DRM. Anyone with access to the unlocked browser profile/device may be able to inspect browser storage.

## Deployment Rules

- Keep `/healthz` cheap and independent from scans, media mounts, and downloads.
- Serve `/sw.js` from the root scope with `Service-Worker-Allowed: /`.
- Serve `/sw.js` with `Cache-Control: no-cache, max-age=0, must-revalidate`.
- Cache immutable built assets such as `/assets/*`.
- Do not edge-cache `/api/*`, `/api/media/*`, or `/api/offline/*`.
- Keep media responses private, versioned, and `no-transform`.
- Preserve range requests and `Content-Length` for file resources.

## Failure Recovery

- `ready`: all manifest resources are downloaded and size-verified.
- `downloading`: resources are being fetched one at a time.
- `partial`: at least one resource exists locally, but the package did not finish.
- `failed`: no usable resource completed.
- `stale`: the server media version changed before the package could be repaired or redownloaded.

Use the Downloads tab to repair, download again, delete one package, clear all packages for the active user, or request persistent browser storage.
