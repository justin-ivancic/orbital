# Offline Downloads

Orbital offline downloads are explicit device-local packages. Normal browsing caches are not treated as downloads.

## Architecture

- The server creates authenticated manifests through `POST /api/offline/manifests`.
- A manifest is a versioned snapshot of one entry or one series.
- CBZ downloads store extracted page image responses, not the raw archive.
- PDF, EPUB, text, HTML, and other file downloads store the file response as one resource.
- The browser stores package records and resource blobs in IndexedDB.
- The Android app stores package records and resource files in app-private native storage.
- The service worker serves local bytes through `/__orbital_offline/resources/:resourceKey`.
- The Downloads screen is the source of truth for local package state, size, repair and delete actions. Series pages show per-chapter download state and a download button for the whole series.
- Resources download a few at a time: four in the browser; on Android, six for CBZ pages and three for whole files.
- On Android, files are written straight to disk by the native HTTP client, with the sign-in token sent as a header. Nothing large passes through JavaScript.
- A download continues while Orbital stays open, even if you move to another screen or open a reader.
- Progress is saved every few seconds and after each finished package. Reopening Orbital, coming back online, or returning to the app resumes queued, interrupted or partial downloads.

## Privacy And Account Scope

- Every package record includes the Orbital user id, username, server instance id, manifest id, and media versions.
- The Downloads screen only lists packages for the active user id.
- Logging out does not delete downloads, but they are hidden until that user is active again.
- Deleting downloads removes the local copies and package records only. Server media, bookmarks, users, comments, and scans stay unchanged.
- This is not DRM. Anyone with access to the unlocked device or browser profile may be able to read the stored files.

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
- `downloading`: resources are being fetched.
- `queued`: a transient failure is waiting for an automatic retry.
- `partial`: at least one resource exists locally, but the package did not finish.
- `paused`: the reader paused the download; completed resources stay and it continues from there.
- `failed`: no usable resource completed.
- `stale`: the server media version changed before the package could be repaired or redownloaded.

Each resource is accepted only after its complete response has been received and its expected size has been verified. Native writes use a temporary `.part` file and a recoverable replacement step, so a half-written chapter or page is never treated as complete and an already-complete resource is not needlessly downloaded again. Transient failures retry automatically, and returning to the app triggers recovery for unfinished records.

If the server copy changes, Orbital creates a replacement package beside the old one. Resource keys are stable for unchanged chapters and pages, so completed matching resources are copied locally into the replacement package and only new or changed resources are downloaded from the server. The old package remains available until the replacement is ready, then is removed. A replacement can temporarily use additional local space while both packages exist.

On Android, cover images that have been viewed online are also retained in a durable per-user device cache for up to 90 days, subject to a 1,024-image and 256 MB limit. Covers are cached on demand rather than prefetched in bulk.

Use the Downloads screen to pause, resume, retry, update a download to the server's current version, remove one download or all of them, and, in a browser, ask for persistent storage so the browser does not evict downloads when space runs low.
