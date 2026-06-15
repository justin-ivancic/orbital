import crypto from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { parse as parseCookie, serialize as serializeCookie } from 'cookie'
import express, { type NextFunction, type Request, type Response } from 'express'
import mime from 'mime-types'
import type { ScanLogEntry, ScanStatus } from '../src/appTypes.ts'
import {
  getCbzMediaVersion,
  loadCbzArchiveManifest,
  sendCbzPageImage,
} from './cbzArchive'
import { getEntryEmbeddedMediaTracks, renderEmbeddedSubtitleTrack, streamEmbeddedAudioTrack } from './embeddedMedia'
import { openDatabase } from './database'
import {
  buildVersionedMediaPath,
  isCurrentMediaVersion,
  isStaleMediaVersion,
} from './mediaVersion'
import {
  buildOfflineEstimate,
  buildOfflineManifest,
  getOfflineCapabilities,
  resolveOfflineResource,
} from './offline'
import {
  assertRateLimitAllowed,
  clearRateLimitBuckets,
  consumeRateLimit,
  createRateLimitKey,
  pruneRateLimitBuckets,
  RateLimitError,
  recordRateLimitFailure,
  type RateLimitPolicy,
} from './rateLimit'
import {
  addComment,
  bootstrapAdminUser,
  changeUserPassword,
  clearSession,
  createSession,
  createSourceFolder,
  createSourceRoot,
  ensureConfiguredSourceRoot,
  findSessionUser,
  findSessionContext,
  getAppState,
  getEntrySidecarMediaTracks,
  getLatestScanStatus,
  getSeriesDetail,
  listDirectoriesForRoot,
  loginUser,
  markInterruptedScans,
  maybeSeedDemoContent,
  clearMetadataOverride,
  removeBookmark,
  removeSourceRoot,
  removeSourceFolder,
  refreshSeriesMetadata,
  renderSubtitleTrackForBrowser,
  resetUserPassword,
  resolveEntryFilePath,
  resolveEntryMediaFile,
  resolveSeriesBannerPath,
  resolveEntryTrack,
  resolveSeriesCoverPath,
  runScan,
  saveMetadataOverride,
  saveBookmark,
  searchSeries,
  signupUser,
  updateSourceFolderCategory,
} from './library'
import { SESSION_COOKIE_NAME } from './utils'

type RequestWithUser = Request & {
  sessionUser: ReturnType<typeof findSessionUser>
  sessionId: string | null
  sessionCsrfToken: string | null
}

const port = Number(process.env.PORT || 4300)
const appRoot = process.cwd()
const dataDirectory = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(appRoot, 'data')
const demoFilesRoot = process.env.APP_DEMO_FILES_ROOT
  ? path.resolve(process.env.APP_DEMO_FILES_ROOT)
  : ''
const {
  db,
  coversDirectory,
} = openDatabase(dataDirectory)
pruneRateLimitBuckets(db)
markInterruptedScans(db)

const minutes = (value: number) => value * 60 * 1000
const hours = (value: number) => value * 60 * 60 * 1000

const loginIpPolicy = {
  limit: 30,
  windowMs: minutes(15),
  blockMs: minutes(15),
} satisfies RateLimitPolicy

const loginUsernamePolicy = {
  limit: 8,
  windowMs: minutes(15),
  blockMs: minutes(15),
} satisfies RateLimitPolicy

const signupPolicy = {
  limit: 10,
  windowMs: hours(1),
  blockMs: hours(1),
} satisfies RateLimitPolicy

const passwordChangePolicy = {
  limit: 6,
  windowMs: minutes(15),
  blockMs: minutes(15),
} satisfies RateLimitPolicy

const adminResetPolicy = {
  limit: 12,
  windowMs: hours(1),
  blockMs: hours(1),
} satisfies RateLimitPolicy
const configuredBootstrapPassword = process.env.APP_ADMIN_PASSWORD?.trim() || ''
const configuredManagedSourceRootPath = process.env.APP_MEDIA_ROOT_PATH?.trim() || ''
const configuredManagedSourceRootDisplayPath =
  process.env.APP_MEDIA_ROOT_DISPLAY_PATH?.trim() || process.env.MEDIA_HOST_DIR?.trim() || ''

const deriveManagedRootLabel = (displayPath: string, storagePath: string) => {
  const candidatePath = (displayPath || storagePath).replace(/[\\/]+$/, '')
  const baseName =
    path.win32.basename(candidatePath.replace(/\//g, '\\')) ||
    path.posix.basename(candidatePath) ||
    'Archive'

  if (!baseName || /^[A-Za-z]:$/.test(baseName)) {
    return 'Archive'
  }

  return `${baseName.slice(0, 1).toUpperCase()}${baseName.slice(1)}`
}

if (!configuredBootstrapPassword) {
  throw new Error('APP_ADMIN_PASSWORD must be set.')
}

const config = {
  appName: process.env.APP_NAME || 'Orbital Library',
  bootstrapAdmin: process.env.APP_ADMIN_USERNAME || 'admin',
  bootstrapPassword: configuredBootstrapPassword,
  openSignup:
    process.env.APP_OPEN_SIGNUP != null
      ? process.env.APP_OPEN_SIGNUP === '1'
      : process.env.NODE_ENV !== 'production',
  enableDemoSeed:
    process.env.APP_ENABLE_DEMO_SEED != null
      ? process.env.APP_ENABLE_DEMO_SEED === '1'
      : false,
  demoFilesRoot,
  coversDirectory,
  managedSourceRoot: configuredManagedSourceRootPath
    ? {
        label:
          process.env.APP_MEDIA_ROOT_LABEL?.trim() ||
          deriveManagedRootLabel(configuredManagedSourceRootDisplayPath, configuredManagedSourceRootPath),
        storagePath: path.resolve(configuredManagedSourceRootPath),
        displayPath: configuredManagedSourceRootDisplayPath || configuredManagedSourceRootPath,
      }
    : null,
}

const explicitCookieSecure = process.env.APP_COOKIE_SECURE?.trim()
const useSecureSessionCookie = explicitCookieSecure
  ? explicitCookieSecure === '1'
  : process.env.NODE_ENV === 'production'
const enableStrictTransportSecurity = process.env.APP_ENABLE_HSTS === '1'

const app = express()

if (process.env.APP_TRUST_PROXY) {
  const trustProxy = process.env.APP_TRUST_PROXY.trim()
  app.set('trust proxy', trustProxy === '1' ? 1 : trustProxy)
}

app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), xr-spatial-tracking=()',
  )
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src 'self' blob:",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "object-src 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
    ].join('; '),
  )

  if (enableStrictTransportSecurity && request.secure) {
    response.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
  }

  next()
})

app.use('/api', (request, response, next) => {
  if (!request.path.startsWith('/media/')) {
    response.setHeader('Cache-Control', 'no-store')
  }

  next()
})

app.use(express.json({ limit: '2mb' }))

let activeScanStatus: ScanStatus | null = null
let activeScanPromise: Promise<void> | null = null

const trimScanEvents = (events: ScanLogEntry[]) => events.slice(-120)
const scanEventClients = new Set<Response>()

const getCurrentScanStatus = () => activeScanStatus ?? getLatestScanStatus(db)

const writeScanStreamEvent = (response: Response, eventName: string, payload: unknown) => {
  response.write(`event: ${eventName}\n`)
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const broadcastScanStreamEvent = (eventName: string, payload: unknown) => {
  for (const response of scanEventClients) {
    if (response.destroyed) {
      scanEventClients.delete(response)
      continue
    }

    try {
      writeScanStreamEvent(response, eventName, payload)
    } catch {
      scanEventClients.delete(response)
    }
  }
}

const broadcastScanStatus = () => {
  broadcastScanStreamEvent('status', getCurrentScanStatus())
}

const getStatePayload = (user: RequestWithUser['sessionUser'], csrfToken?: string | null) => ({
  ...getAppState(db, config, user, activeScanStatus),
  csrfToken: user ? csrfToken ?? null : null,
})

const getBootstrapPayload = (user: RequestWithUser['sessionUser'], csrfToken?: string | null) => ({
  appName: config.appName,
  bootstrapAdmin: config.bootstrapAdmin,
  openSignup: config.openSignup,
  user,
  csrfToken: user ? csrfToken ?? null : null,
})

const startBackgroundScan = (sourceId?: string) => {
  if (activeScanPromise) {
    return activeScanPromise
  }

  activeScanStatus = {
    active: true,
    runId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalSources: 0,
    completedSources: 0,
    currentSource: null,
    currentSourceFilesDiscovered: null,
    currentSourceSeriesTotal: null,
    currentSourceSeriesCompleted: 0,
    currentSeries: null,
    summary: sourceId ? 'Preparing folder scan…' : 'Preparing library scan…',
    events: [],
  }
  broadcastScanStatus()

  const scanReporter = {
    onRunStarted: ({ runId, startedAt, totalSources }) => {
      activeScanStatus = {
        ...(activeScanStatus || {
          active: true,
          runId: null,
          startedAt,
          finishedAt: null,
          totalSources: 0,
          completedSources: 0,
          currentSource: null,
          summary: null,
          events: [],
        }),
        active: true,
        runId,
        startedAt,
        finishedAt: null,
        totalSources,
        completedSources: 0,
        currentSource: null,
        currentSourceFilesDiscovered: null,
        currentSourceSeriesTotal: null,
        currentSourceSeriesCompleted: 0,
        currentSeries: null,
        summary: totalSources === 0 ? 'Nothing to scan.' : 'Scan started',
      }
      broadcastScanStatus()
    },
    onProgress: ({
      runId,
      totalSources,
      completedSources,
      currentSource,
      currentSourceFilesDiscovered,
      currentSourceSeriesTotal,
      currentSourceSeriesCompleted,
      currentSeries,
      summary,
    }) => {
      activeScanStatus = {
        ...(activeScanStatus || {
          active: true,
          runId,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          totalSources,
          completedSources,
          currentSource,
          currentSourceFilesDiscovered,
          currentSourceSeriesTotal,
          currentSourceSeriesCompleted,
          currentSeries,
          summary,
          events: [],
        }),
        active: true,
        runId,
        totalSources,
        completedSources,
        currentSource,
        currentSourceFilesDiscovered,
        currentSourceSeriesTotal,
        currentSourceSeriesCompleted,
        currentSeries,
        summary,
      }
      broadcastScanStatus()
    },
    onEvent: (event) => {
      activeScanStatus = {
        ...(activeScanStatus || {
          active: true,
          runId: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          totalSources: 0,
          completedSources: 0,
          currentSource: null,
          currentSourceFilesDiscovered: null,
          currentSourceSeriesTotal: null,
          currentSourceSeriesCompleted: 0,
          currentSeries: null,
          summary: null,
          events: [],
        }),
        events: trimScanEvents([...(activeScanStatus?.events || []), event]),
      }
      broadcastScanStreamEvent('scan-event', event)
      broadcastScanStatus()
    },
    onRunFinished: ({ runId, finishedAt, summary }) => {
      activeScanStatus = {
        ...(activeScanStatus || {
          active: false,
          runId,
          startedAt: new Date().toISOString(),
          finishedAt,
          totalSources: 0,
          completedSources: 0,
          currentSource: null,
          currentSourceFilesDiscovered: null,
          currentSourceSeriesTotal: null,
          currentSourceSeriesCompleted: 0,
          currentSeries: null,
          summary,
          events: [],
        }),
        active: false,
        runId,
        finishedAt,
        completedSources: activeScanStatus?.totalSources ?? activeScanStatus?.completedSources ?? 0,
        currentSource: null,
        currentSeries: null,
        summary,
        events: trimScanEvents(activeScanStatus?.events || []),
      }
      broadcastScanStatus()
    },
  }

  activeScanPromise = new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      runScan(db, config, sourceId, scanReporter).then(resolve, reject)
    })
  })
    .then(() => undefined)
    .catch((error) => {
      const finishedAt = new Date().toISOString()
      activeScanStatus = {
        ...(activeScanStatus || {
          active: false,
          runId: null,
          startedAt: finishedAt,
          finishedAt,
          totalSources: 0,
          completedSources: 0,
          currentSource: null,
          currentSourceFilesDiscovered: null,
          currentSourceSeriesTotal: null,
          currentSourceSeriesCompleted: 0,
          currentSeries: null,
          summary: null,
          events: [],
        }),
        active: false,
        finishedAt,
        currentSource: null,
        currentSeries: null,
        summary: error instanceof Error ? error.message : 'Scan failed.',
      }
      broadcastScanStatus()
    })
    .finally(() => {
      activeScanPromise = null
    })

  return activeScanPromise
}

const getSessionFromRequest = (request: RequestWithUser) => {
  const cookies = parseCookie(request.headers.cookie || '')
  const sessionId = cookies[SESSION_COOKIE_NAME] || null
  const sessionContext = findSessionContext(db, sessionId)

  request.sessionId = sessionId
  request.sessionUser = sessionContext?.user ?? null
  request.sessionCsrfToken = sessionContext?.csrfToken ?? null
}

app.use((request, _response, next) => {
  const typedRequest = request as RequestWithUser
  getSessionFromRequest(typedRequest)
  next()
})

const requireAuth = (request: Request, response: Response, next: NextFunction) => {
  const typedRequest = request as RequestWithUser

  if (!typedRequest.sessionUser) {
    response.status(401).json({ error: 'You need to sign in first.' })
    return
  }

  next()
}

const requireAdmin = (request: Request, response: Response, next: NextFunction) => {
  const typedRequest = request as RequestWithUser

  if (!typedRequest.sessionUser) {
    response.status(401).json({ error: 'You need to sign in first.' })
    return
  }

  if (typedRequest.sessionUser.role !== 'admin') {
    response.status(403).json({ error: 'Admin access is required for this action.' })
    return
  }

  next()
}

const unsafeHttpMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const csrfExemptPaths = new Set(['/api/auth/login', '/api/auth/signup'])

const safeTokenEquals = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

const getAllowedRequestOrigins = (request: Request) => {
  const host = request.get('host')

  if (!host) {
    return new Set<string>()
  }

  return new Set([`http://${host}`, `https://${host}`])
}

const requireCsrfForUnsafeMethods = (request: Request, response: Response, next: NextFunction) => {
  if (!unsafeHttpMethods.has(request.method) || csrfExemptPaths.has(request.path)) {
    next()
    return
  }

  const typedRequest = request as RequestWithUser

  if (!typedRequest.sessionUser) {
    next()
    return
  }

  const fetchSite = request.get('sec-fetch-site')
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    response.status(403).json({ error: 'Cross-site requests are not allowed.' })
    return
  }

  const origin = request.get('origin')
  if (origin && !getAllowedRequestOrigins(request).has(origin)) {
    response.status(403).json({ error: 'Request origin is not allowed.' })
    return
  }

  const requestToken = request.get('x-csrf-token') || ''
  const sessionToken = typedRequest.sessionCsrfToken || ''

  if (!requestToken || !sessionToken || !safeTokenEquals(requestToken, sessionToken)) {
    response.status(403).json({ error: 'Security token is missing or expired. Refresh and try again.' })
    return
  }

  next()
}

app.use('/api', requireCsrfForUnsafeMethods)

const setSessionCookie = (response: Response, sessionId: string, expiresAt: number) => {
  response.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      expires: new Date(expiresAt),
      secure: useSecureSessionCookie,
    }),
  )
}

const clearSessionCookie = (response: Response) => {
  response.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      expires: new Date(0),
      secure: useSecureSessionCookie,
    }),
  )
}

const startFreshSession = (request: Request, response: Response, userId: string) => {
  const typedRequest = request as RequestWithUser
  clearSession(db, typedRequest.sessionId)

  const session = createSession(db, userId)
  setSessionCookie(response, session.sessionId, session.expiresAt)
  typedRequest.sessionId = session.sessionId
  typedRequest.sessionCsrfToken = session.csrfToken

  return session
}

const sendError = (response: Response, error: unknown, status = 400) => {
  if (error instanceof RateLimitError) {
    response.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))))
    response.status(429).json({ error: error.message })
    return
  }

  response.status(status).json({
    error: error instanceof Error ? error.message : 'Unknown error',
  })
}

const getClientAddress = (request: Request) =>
  request.ip || request.socket.remoteAddress || 'unknown-client'

const getLoginRateLimiters = (request: Request, username: string) => {
  const clientAddress = getClientAddress(request)

  return [
    {
      key: createRateLimitKey('login-ip', clientAddress),
      policy: loginIpPolicy,
    },
    {
      key: createRateLimitKey('login-username', username, clientAddress),
      policy: loginUsernamePolicy,
    },
  ]
}

const assertRateLimitersAllowed = (
  rateLimiters: Array<{ key: string; policy: RateLimitPolicy }>,
) => {
  for (const rateLimiter of rateLimiters) {
    assertRateLimitAllowed(db, rateLimiter.key)
  }
}

const recordRateLimiterFailures = (
  rateLimiters: Array<{ key: string; policy: RateLimitPolicy }>,
) => {
  let rateLimitError: RateLimitError | null = null

  for (const rateLimiter of rateLimiters) {
    try {
      recordRateLimitFailure(db, rateLimiter.key, rateLimiter.policy)
    } catch (error) {
      if (error instanceof RateLimitError && !rateLimitError) {
        rateLimitError = error
      } else if (!(error instanceof RateLimitError)) {
        throw error
      }
    }
  }

  if (rateLimitError) {
    throw rateLimitError
  }
}

const parseRangeHeader = (rangeHeader: string, fileSize: number) => {
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)

  if (!match) {
    return null
  }

  const startText = match[1] || ''
  const endText = match[2] || ''

  if (!startText && !endText) {
    return null
  }

  let start = startText ? Number(startText) : 0
  let end = endText ? Number(endText) : fileSize - 1

  if (!startText) {
    const suffixLength = Number(endText)

    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null
    }

    start = Math.max(fileSize - suffixLength, 0)
    end = fileSize - 1
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= fileSize) {
    return null
  }

  return { start, end }
}

const buildMediaEntityTag = (stats: fs.Stats) =>
  `"${Math.round(stats.mtimeMs).toString(36)}-${stats.size.toString(36)}"`

const requestMatchesMediaValidators = (request: Request, stats: fs.Stats, entityTag: string) => {
  const ifNoneMatch = request.get('if-none-match')

  if (ifNoneMatch && ifNoneMatch.split(',').map((value) => value.trim()).includes(entityTag)) {
    return true
  }

  const ifModifiedSince = request.get('if-modified-since')

  if (!ifModifiedSince) {
    return false
  }

  const modifiedSince = Date.parse(ifModifiedSince)

  return Number.isFinite(modifiedSince) && Math.floor(stats.mtimeMs / 1000) <= Math.floor(modifiedSince / 1000)
}

const sendMediaFile = async (
  request: Request,
  response: Response,
  filePath: string,
  rangeHeader?: string,
) => {
  const stats = await fsPromises.stat(filePath)
  const contentType = mime.lookup(filePath) || 'application/octet-stream'
  const safeFileName = encodeURIComponent(path.basename(filePath))
  const entityTag = buildMediaEntityTag(stats)

  if (!response.hasHeader('Cache-Control')) {
    response.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate, no-transform')
  }

  response.setHeader('Accept-Ranges', 'bytes')
  response.setHeader('ETag', entityTag)
  response.setHeader('Last-Modified', stats.mtime.toUTCString())
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Vary', 'Cookie, Authorization')
  response.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${safeFileName}`,
  )

  if (!rangeHeader && requestMatchesMediaValidators(request, stats, entityTag)) {
    response.status(304).end()
    return
  }

  if (rangeHeader) {
    const range = parseRangeHeader(rangeHeader, stats.size)

    if (!range) {
      response.status(416).setHeader('Content-Range', `bytes */${stats.size}`).end()
      return
    }

    response.status(206)
    response.setHeader('Content-Type', contentType)
    response.setHeader('Content-Length', range.end - range.start + 1)
    response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`)
    if (request.method === 'HEAD') {
      response.end()
      return
    }

    fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(response)
    return
  }

  response.status(200)
  response.setHeader('Content-Type', contentType)
  response.setHeader('Content-Length', stats.size)
  if (request.method === 'HEAD') {
    response.end()
    return
  }

  fs.createReadStream(filePath).pipe(response)
}

const hasCacheVersion = (version: unknown) => typeof version === 'string' && version.trim().length > 0

const setPrivateVersionedCacheHeaders = (response: Response, version: unknown) => {
  response.setHeader(
    'Cache-Control',
    hasCacheVersion(version)
      ? 'private, max-age=2592000, immutable, no-transform'
      : 'private, no-cache, max-age=0, must-revalidate, no-transform',
  )
  response.setHeader('Vary', 'Cookie, Authorization')
}

app.get('/api/state', requireAuth, (request, response) => {
  const typedRequest = request as RequestWithUser
  response.json(getStatePayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
})

app.get('/api/bootstrap', (request, response) => {
  const typedRequest = request as RequestWithUser
  response.json(getBootstrapPayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
})

const sendHealthResponse = (_request: Request, response: Response) => {
  response.setHeader('Cache-Control', 'no-store')

  try {
    db.prepare('SELECT 1 AS ok').get()
    response.json({
      ok: true,
      appName: config.appName,
      database: 'ok',
      now: new Date().toISOString(),
    })
  } catch {
    response.status(503).json({
      ok: false,
      appName: config.appName,
      database: 'unavailable',
      now: new Date().toISOString(),
    })
  }
}

const checkDirectoryAccess = (directoryPath: string, mode: number) => {
  try {
    fs.accessSync(directoryPath, mode)
    return 'ok'
  } catch {
    return 'unavailable'
  }
}

const sendReadyResponse = (_request: Request, response: Response) => {
  response.setHeader('Cache-Control', 'no-store')

  const readiness = {
    database: 'unavailable',
    dataDirectory: checkDirectoryAccess(dataDirectory, fs.constants.R_OK | fs.constants.W_OK),
    coversDirectory: checkDirectoryAccess(coversDirectory, fs.constants.R_OK | fs.constants.W_OK),
    mediaRoot: config.managedSourceRoot
      ? checkDirectoryAccess(config.managedSourceRoot.storagePath, fs.constants.R_OK)
      : 'not-configured',
  }

  try {
    db.prepare('SELECT 1 AS ok').get()
    readiness.database = 'ok'
  } catch {
    readiness.database = 'unavailable'
  }

  const ok = Object.values(readiness).every((status) => status === 'ok' || status === 'not-configured')

  response.status(ok ? 200 : 503).json({
    ok,
    appName: config.appName,
    checks: readiness,
    now: new Date().toISOString(),
  })
}

app.get('/api/health', sendHealthResponse)
app.get('/healthz', sendHealthResponse)
app.get('/api/ready', sendReadyResponse)
app.get('/readyz', sendReadyResponse)

app.post('/api/auth/login', async (request, response) => {
  const username = String(request.body?.username || '')
  const rateLimiters = getLoginRateLimiters(request, username)
  let user: Awaited<ReturnType<typeof loginUser>>

  try {
    assertRateLimitersAllowed(rateLimiters)
    user = await loginUser(
      db,
      username,
      String(request.body?.password || ''),
    )
  } catch (error) {
    if (!(error instanceof RateLimitError)) {
      try {
        recordRateLimiterFailures(rateLimiters)
      } catch (rateLimitError) {
        sendError(response, rateLimitError)
        return
      }
    }

    sendError(response, error, 401)
    return
  }

  clearRateLimitBuckets(db, rateLimiters.map((rateLimiter) => rateLimiter.key))
  const session = startFreshSession(request, response, user.id)
  response.json(getStatePayload(user, session.csrfToken))
})

app.post('/api/auth/signup', async (request, response) => {
  if (!config.openSignup) {
    response.status(403).json({ error: 'Open signup is disabled.' })
    return
  }

  try {
    consumeRateLimit(
      db,
      createRateLimitKey('signup-ip', getClientAddress(request)),
      signupPolicy,
    )
    const user = await signupUser(
      db,
      String(request.body?.username || ''),
      String(request.body?.password || ''),
    )
    const session = startFreshSession(request, response, user.id)
    response.json(getStatePayload(user, session.csrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/auth/logout', (request, response) => {
  const typedRequest = request as RequestWithUser
  clearSession(db, typedRequest.sessionId)
  clearSessionCookie(response)
  response.json({ ok: true })
})

app.post('/api/auth/change-password', requireAuth, async (request, response) => {
  try {
    const typedRequest = request as RequestWithUser
    const sessionUser = typedRequest.sessionUser as NonNullable<RequestWithUser['sessionUser']>
    const rateLimitKey = createRateLimitKey('change-password', sessionUser.id, getClientAddress(request))

    assertRateLimitAllowed(db, rateLimitKey)

    try {
      await changeUserPassword(
        db,
        sessionUser.id,
        String(request.body?.currentPassword || ''),
        String(request.body?.newPassword || ''),
        typedRequest.sessionId,
      )
      clearRateLimitBuckets(db, [rateLimitKey])
    } catch (error) {
      if (error instanceof Error && error.message === 'Current password is incorrect.') {
        recordRateLimitFailure(db, rateLimitKey, passwordChangePolicy)
      }

      throw error
    }

    response.json(getStatePayload(sessionUser, typedRequest.sessionCsrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.get('/api/search', requireAuth, (request, response) => {
  try {
    const query = String(request.query.q || '').trim()
    const scope = String(request.query.scope || 'all') as 'all' | 'anime' | 'manga' | 'novels' | 'books' | 'magazines'

    if (!query) {
      response.json({ results: [] })
      return
    }

    response.json(searchSeries(db, query, scope))
  } catch (error) {
    sendError(response, error)
  }
})

app.get('/api/series/:seriesId', requireAuth, (request, response) => {
  try {
    response.json({
      series: getSeriesDetail(db, request.params.seriesId),
    })
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media-tracks/:entryId', requireAuth, async (request, response) => {
  try {
    const sidecarTracks = getEntrySidecarMediaTracks(db, request.params.entryId)
    const embeddedTracks = await getEntryEmbeddedMediaTracks(db, request.params.entryId)

    response.json({
      mediaTracks: {
        audio: [...sidecarTracks.audio, ...embeddedTracks.audio],
        subtitles: [...sidecarTracks.subtitles, ...embeddedTracks.subtitles],
      },
    })
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.post('/api/bookmarks', requireAuth, (request, response) => {
  try {
    const typedRequest = request as RequestWithUser
    response.json(
      saveBookmark(db, typedRequest.sessionUser as NonNullable<RequestWithUser['sessionUser']>, {
        seriesId: String(request.body?.seriesId || ''),
        entryId: String(request.body?.entryId || ''),
        entryIndex: Number(request.body?.entryIndex || 0),
        category: request.body?.category,
        progress: String(request.body?.progress || ''),
        cue: String(request.body?.cue || ''),
        position: request.body?.position,
      }),
    )
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/bookmarks/:seriesId', requireAuth, (request, response) => {
  try {
    const typedRequest = request as RequestWithUser
    response.json(
      removeBookmark(
        db,
        typedRequest.sessionUser as NonNullable<RequestWithUser['sessionUser']>,
        request.params.seriesId,
      ),
    )
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/comments', requireAuth, (request, response) => {
  try {
    const typedRequest = request as RequestWithUser
    response.json({
      series: addComment(db, typedRequest.sessionUser as NonNullable<RequestWithUser['sessionUser']>, {
        seriesId: String(request.body?.seriesId || ''),
        text: String(request.body?.text || ''),
      }),
    })
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/roots', requireAdmin, (request, response) => {
  try {
    createSourceRoot(db, config, {
      label: String(request.body?.label || '').trim(),
      path: String(request.body?.path || '').trim(),
    })
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/admin/roots/:rootId', requireAdmin, (request, response) => {
  try {
    removeSourceRoot(db, config, request.params.rootId)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.get('/api/admin/directories', requireAdmin, (request, response) => {
  try {
    response.json(
      listDirectoriesForRoot(
        db,
        String(request.query.rootId || ''),
        String(request.query.relativePath || ''),
      ),
    )
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/sources', requireAdmin, async (request, response) => {
  try {
    const createdSource = await createSourceFolder(db, config, {
      rootId: String(request.body?.rootId || ''),
      relativePath: String(request.body?.relativePath || ''),
      category: request.body?.category,
    })
    void startBackgroundScan(createdSource.sourceId)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.patch('/api/admin/sources/:sourceId', requireAdmin, (request, response) => {
  try {
    updateSourceFolderCategory(db, config, request.params.sourceId, {
      category: request.body?.category,
    })
    void startBackgroundScan(request.params.sourceId)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/admin/sources/:sourceId', requireAdmin, (request, response) => {
  try {
    removeSourceFolder(db, request.params.sourceId)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/scan', requireAdmin, async (request, response) => {
  try {
    void startBackgroundScan(request.body?.sourceId ? String(request.body.sourceId) : undefined)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.get('/api/admin/scan/status', requireAdmin, (_request, response) => {
  response.json({ scanStatus: getCurrentScanStatus() })
})

app.get('/api/admin/scan/events', requireAdmin, (request, response) => {
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Connection', 'keep-alive')
  response.setHeader('X-Accel-Buffering', 'no')
  response.flushHeaders?.()
  response.write('retry: 2000\n\n')
  writeScanStreamEvent(response, 'status', getCurrentScanStatus())
  scanEventClients.add(response)

  const heartbeat = setInterval(() => {
    if (response.destroyed) {
      clearInterval(heartbeat)
      scanEventClients.delete(response)
      return
    }

    response.write(': heartbeat\n\n')
  }, 15000)

  request.on('close', () => {
    clearInterval(heartbeat)
    scanEventClients.delete(response)
  })
})

app.post('/api/admin/users/:userId/reset-password', requireAdmin, async (request, response) => {
  try {
    const typedRequest = request as RequestWithUser
    const adminUser = typedRequest.sessionUser as NonNullable<RequestWithUser['sessionUser']>

    consumeRateLimit(
      db,
      createRateLimitKey('admin-reset-password', adminUser.id, request.params.userId, getClientAddress(request)),
      adminResetPolicy,
    )
    await resetUserPassword(
      db,
      request.params.userId,
      String(request.body?.password || ''),
    )
    response.json(getStatePayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/series/:seriesId/metadata-override', requireAdmin, async (request, response) => {
  try {
    await saveMetadataOverride(db, config, request.params.seriesId, {
      title: typeof request.body?.title === 'string' ? request.body.title : null,
      year:
        request.body?.year === '' || request.body?.year == null
          ? null
          : Number.isFinite(Number(request.body?.year))
            ? Number(request.body?.year)
            : null,
      description: typeof request.body?.description === 'string' ? request.body.description : null,
      externalUrl: typeof request.body?.externalUrl === 'string' ? request.body.externalUrl : null,
      sourceName: typeof request.body?.sourceName === 'string' ? request.body.sourceName : null,
      sourceRole: typeof request.body?.sourceRole === 'string' ? request.body.sourceRole : null,
      coverImageUrl: typeof request.body?.coverImageUrl === 'string' ? request.body.coverImageUrl : null,
      clearCover: request.body?.clearCover === true,
    })
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/admin/series/:seriesId/metadata-override', requireAdmin, async (request, response) => {
  try {
    await clearMetadataOverride(db, config, request.params.seriesId)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/series/:seriesId/metadata-refresh', requireAdmin, async (request, response) => {
  try {
    await refreshSeriesMetadata(db, config, request.params.seriesId)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
  } catch (error) {
    sendError(response, error)
  }
})

app.get('/api/offline/capabilities', requireAuth, (request, response) => {
  void request
  response.setHeader('Cache-Control', 'no-store')
  response.json(getOfflineCapabilities(db, config.appName))
})

app.post('/api/offline/estimate', requireAuth, async (request, response) => {
  try {
    const typedRequest = request as RequestWithUser
    response.setHeader('Cache-Control', 'no-store')
    response.json(await buildOfflineEstimate(db, typedRequest.sessionUser, request.body?.target))
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/offline/manifests', requireAuth, async (request, response) => {
  try {
    const typedRequest = request as RequestWithUser
    response.setHeader('Cache-Control', 'no-store')
    response.json(await buildOfflineManifest(db, typedRequest.sessionUser, request.body?.target))
  } catch (error) {
    sendError(response, error)
  }
})

const setOfflineResourceHeaders = (response: Response, entityTag: string) => {
  response.setHeader('Cache-Control', 'private, max-age=31536000, immutable, no-transform')
  response.setHeader('ETag', entityTag)
  response.setHeader('Vary', 'Cookie, Authorization')
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

const requestMatchesEntityTag = (request: Request, entityTag: string) =>
  request
    .get('if-none-match')
    ?.split(',')
    .map((tag) => tag.trim())
    .includes(entityTag) ?? false

const sendOfflineResource = async (request: Request, response: Response) => {
  try {
    const typedRequest = request as RequestWithUser
    const resource = await resolveOfflineResource(
      db,
      typedRequest.sessionUser,
      request.params.resourceKey,
    )

    setOfflineResourceHeaders(response, resource.entityTag)

    if (requestMatchesEntityTag(request, resource.entityTag)) {
      response.status(304).end()
      return
    }

    if (resource.kind === 'file') {
      response.setHeader('Content-Type', resource.contentType)
      await sendMediaFile(request, response, resource.filePath, request.headers.range)
      return
    }

    response.setHeader('Content-Type', resource.page.contentType)
    response.setHeader('Content-Length', resource.page.uncompressedSize)
    response.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(resource.page.fileName)}`,
    )

    if (request.method === 'HEAD') {
      response.status(200).end()
      return
    }

    await sendCbzPageImage(response, resource.filePath, resource.page)
  } catch (error) {
    if (!response.headersSent) {
      const message = error instanceof Error ? error.message : ''
      sendError(response, error, message.includes('stale') ? 409 : 404)
    }
  }
}

app.head('/api/offline/manifests/:manifestId/resources/:resourceKey', requireAuth, sendOfflineResource)
app.get('/api/offline/manifests/:manifestId/resources/:resourceKey', requireAuth, sendOfflineResource)

app.get('/api/media/cover/:seriesId', requireAuth, async (request, response) => {
  try {
    const cover = resolveSeriesCoverPath(db, request.params.seriesId)
    setPrivateVersionedCacheHeaders(response, request.query.v)
    response.setHeader('Content-Type', cover.mimeType)
    await sendMediaFile(request, response, cover.filePath)
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media/banner/:seriesId', requireAuth, async (request, response) => {
  try {
    const banner = resolveSeriesBannerPath(db, request.params.seriesId)
    setPrivateVersionedCacheHeaders(response, request.query.v)
    response.setHeader('Content-Type', banner.mimeType)
    await sendMediaFile(request, response, banner.filePath)
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media/cbz/:entryId/manifest', requireAuth, async (request, response) => {
  try {
    const entry = resolveEntryMediaFile(db, request.params.entryId)

    if (entry.format !== 'cbz') {
      throw new Error('Requested entry is not a CBZ archive.')
    }

    const stats = await fsPromises.stat(entry.filePath)
    const currentVersion = getCbzMediaVersion(stats)

    const archive = await loadCbzArchiveManifest(entry.filePath, stats)
    const versionQuery = `?v=${encodeURIComponent(currentVersion)}`
    if (isCurrentMediaVersion(request.query, currentVersion)) {
      setPrivateVersionedCacheHeaders(response, currentVersion)
    } else {
      response.setHeader('Cache-Control', 'private, no-cache')
    }
    response.json({
      version: currentVersion,
      pageCount: archive.pageCount,
      pages: archive.pages.map((page) => ({
        archiveIndex: page.archiveIndex,
        name: page.name,
        pageNumber: page.pageNumber,
        url: `/api/media/cbz/${encodeURIComponent(entry.entryId)}/pages/${page.pageNumber}${versionQuery}`,
      })),
    })
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media/cbz/:entryId/pages/:pageNumber', requireAuth, async (request, response) => {
  try {
    const entry = resolveEntryMediaFile(db, request.params.entryId)

    if (entry.format !== 'cbz') {
      throw new Error('Requested entry is not a CBZ archive.')
    }

    const pageNumber = Number(request.params.pageNumber)

    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new Error('Requested CBZ page was not found.')
    }

    const stats = await fsPromises.stat(entry.filePath)
    const currentVersion = getCbzMediaVersion(stats)

    if (isStaleMediaVersion(request.query, currentVersion)) {
      response.setHeader('Cache-Control', 'no-store')
      response.redirect(307, buildVersionedMediaPath(request.originalUrl, currentVersion))
      return
    }

    const archive = await loadCbzArchiveManifest(entry.filePath, stats)
    const page = archive.pages[pageNumber - 1]

    if (!page) {
      throw new Error('Requested CBZ page was not found.')
    }

    setPrivateVersionedCacheHeaders(
      response,
      isCurrentMediaVersion(request.query, currentVersion) ? currentVersion : '',
    )
    await sendCbzPageImage(response, entry.filePath, page)
  } catch (error) {
    if (!response.headersSent) {
      sendError(response, error, 404)
    }
  }
})

app.get('/api/media/file/:entryId', requireAuth, async (request, response) => {
  try {
    const filePath = resolveEntryFilePath(db, request.params.entryId)
    await sendMediaFile(request, response, filePath, request.headers.range)
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media/track/:entryId/:kind/:trackId', requireAuth, async (request, response) => {
  try {
    const kind = request.params.kind === 'audio' ? 'audio' : request.params.kind === 'subtitle' ? 'subtitle' : null

    if (!kind) {
      throw new Error('Unsupported media track kind.')
    }

    if (request.params.trackId.startsWith('embedded-')) {
      if (kind === 'audio') {
        const embeddedAudio = await streamEmbeddedAudioTrack(db, request.params.entryId, request.params.trackId)
        response.status(200)
        response.setHeader('Content-Type', embeddedAudio.contentType)
        response.setHeader('Cache-Control', 'no-store')
        embeddedAudio.process.stdout.pipe(response)
        embeddedAudio.process.stderr.on('data', () => undefined)
        embeddedAudio.process.on('error', () => {
          if (!response.headersSent) {
            sendError(response, new Error('Unable to render embedded audio track.'), 500)
          } else {
            response.end()
          }
        })
        embeddedAudio.process.on('close', (code) => {
          if (code !== 0 && !response.writableEnded) {
            response.end()
          }
        })
        request.on('close', () => {
          embeddedAudio.process.kill('SIGTERM')
        })
        return
      }

      const embeddedSubtitle = await renderEmbeddedSubtitleTrack(db, request.params.entryId, request.params.trackId)
      response.status(200)
      response.setHeader('Content-Type', 'text/vtt; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.send(embeddedSubtitle)
      return
    }

    if (kind === 'audio') {
      const track = resolveEntryTrack(db, request.params.entryId, kind, request.params.trackId)
      await sendMediaFile(request, response, track.filePath, request.headers.range)
      return
    }

    const trackPayload = await renderSubtitleTrackForBrowser(db, request.params.entryId, request.params.trackId)
    response.status(200)
    response.setHeader('Content-Type', 'text/vtt; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.send(trackPayload)
  } catch (error) {
    sendError(response, error, 404)
  }
})

const distDirectory = path.join(appRoot, 'dist')
if (fs.existsSync(distDirectory)) {
  app.use(
    express.static(distDirectory, {
      setHeaders: (response, filePath) => {
        const relativePath = path.relative(distDirectory, filePath).replace(/\\/g, '/')

        if (relativePath === 'sw.js') {
          response.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate')
          response.setHeader('Service-Worker-Allowed', '/')
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          return
        }

        if (relativePath.startsWith('assets/')) {
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          return
        }

        response.setHeader('Cache-Control', 'no-cache')
      },
    }),
  )
  app.get(/^(?!\/api\/).*/, (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache')
    response.sendFile(path.join(distDirectory, 'index.html'))
  })
} else {
  app.get('/', (_request, response) => {
    response.type('text/plain').send('API server is running. Start Vite for the frontend in development mode.')
  })
}

app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
  void next
  sendError(response, error, 500)
})

ensureConfiguredSourceRoot(db, config)
await bootstrapAdminUser(db, config)
await maybeSeedDemoContent(db, config)

app.listen(port, () => {
  console.log(`Orbital Library server listening on http://127.0.0.1:${port}`)
})
