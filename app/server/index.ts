import './loadEnv'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseCookie, serialize as serializeCookie } from 'cookie'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { ScanLogEntry, ScanStatus, SessionUser } from '../src/appTypes.ts'
import {
  deleteUploadedAndroidApk,
  getAndroidApkLocations,
  getAndroidAppInfo,
  resolveAndroidApk,
  saveUploadedAndroidApk,
} from './androidApp'
import { getRemoteMetadataSetting, setRemoteMetadataEnabled } from './appSettings'
import {
  getCbzMediaVersion,
  loadCbzArchiveManifest,
  readCbzPage,
  sendCbzPageBytes,
} from './cbzArchive'
import { resolveCardCoverPath } from './coverThumbnails'
import { getEntryEmbeddedMediaTracks, renderEmbeddedSubtitleTrack, streamEmbeddedAudioTrack } from './embeddedMedia'
import { openDatabase } from './database'
import { isClientAbortError, sendMediaFile } from './mediaResponses'
import {
  buildVersionedMediaPath,
  isCurrentMediaVersion,
  isStaleMediaVersion,
} from './mediaVersion'
import { shutdownMediaWorker } from './mediaWorkerPool'
import {
  buildOfflineEstimate,
  buildOfflineManifest,
  getOfflineCapabilities,
  resolveOfflineResource,
} from './offline'
import { getReaderPreference, saveReaderPreference } from './readerPreferences'
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
  addCommentCompact,
  bootstrapAdminUser,
  changeUserPassword,
  clearMetadataOverride,
  clearSession,
  createSession,
  createSourceFolder,
  createSourceRoot,
  createUserAccount,
  deleteUserAccount,
  ensureConfiguredSourceRoot,
  findSessionContext,
  getAppState,
  getEntrySidecarMediaTracks,
  getLatestScanStatus,
  getSeriesDetail,
  listDirectoriesForRoot,
  loginUser,
  markInterruptedScans,
  maybeSeedDemoContent,
  refreshSeriesMetadata,
  removeBookmark,
  removeSourceFolder,
  removeSourceRoot,
  renderSubtitleTrackForBrowser,
  resetUserPassword,
  resolveEntryMediaFile,
  resolveEntryTrack,
  resolveSeriesBannerPath,
  resolveSeriesCoverPath,
  runScan,
  saveBookmark,
  saveMetadataOverride,
  saveReadingProgress,
  searchSeries,
  signupUser,
  updateSourceFolderCategory,
  type ReadingProgressPayload,
  type ScanReporter,
} from './library'
import { SESSION_COOKIE_NAME } from './utils'

type RequestWithUser = Request & {
  sessionUser: SessionUser | null
  sessionId: string | null
  sessionCsrfToken: string | null
  authMode: 'browser' | 'mobile'
}

const port = Number(process.env.PORT || 4300)
const appRoot = process.cwd()
const dataDirectory = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(appRoot, 'data')
const demoFilesRoot = process.env.APP_DEMO_FILES_ROOT
  ? path.resolve(process.env.APP_DEMO_FILES_ROOT)
  : ''
const androidApkLocations = getAndroidApkLocations(dataDirectory, appRoot)
const {
  db,
  coversDirectory,
} = openDatabase(dataDirectory)
pruneRateLimitBuckets(db)
const interruptedScanResumptions = markInterruptedScans(db)

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
const mobileOrigins = new Set(
  (process.env.APP_MOBILE_ORIGINS || 'https://localhost,capacitor://localhost')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
)

const app = express()
app.disable('x-powered-by')

const trustProxy = process.env.APP_TRUST_PROXY?.trim()
if (trustProxy && trustProxy !== '0') {
  app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy)
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

// The APK upload streams its own body; everything else is small JSON.
app.use((request, response, next) => {
  if (request.path === '/api/admin/android-app') {
    next()
    return
  }

  express.json({ limit: '2mb' })(request, response, next)
})

/** Express 5 types route params as string | string[]; routes here only use plain segments. */
const routeParam = (request: Request, name: string) => {
  const value = request.params[name]
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

const queryText = (request: Request, name: string) => {
  const value = request.query[name]
  return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : ''
}

const isCompactRequest = (request: Request) => queryText(request, 'compact') === '1'

const currentUser = (request: Request) => {
  const user = (request as RequestWithUser).sessionUser
  if (!user) {
    throw new Error('You need to sign in first.')
  }
  return user
}

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

const emptyScanStatus = (overrides: Partial<ScanStatus> = {}): ScanStatus => ({
  active: false,
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
  ...overrides,
})

const statePayloadOptions = (request: Request) => ({
  compact: isCompactRequest(request),
  knownLibraryRevision: queryText(request, 'libraryRevision') || null,
})

const getStatePayload = (request: Request, user: SessionUser | null) => ({
  ...getAppState(db, config, user, activeScanStatus, statePayloadOptions(request)),
  csrfToken: user ? (request as RequestWithUser).sessionCsrfToken ?? null : null,
})

const getBootstrapPayload = (user: SessionUser | null, csrfToken?: string | null) => ({
  appName: config.appName,
  bootstrapAdmin: config.bootstrapAdmin,
  openSignup: config.openSignup,
  user,
  csrfToken: user ? csrfToken ?? null : null,
})

const startBackgroundScan = (
  sourceId?: string,
  options: { resumeAttempt?: number; lineageId?: string; resumedFromRunId?: string | null } = {},
) => {
  if (activeScanPromise) {
    return activeScanPromise
  }

  activeScanStatus = emptyScanStatus({
    active: true,
    summary: sourceId ? 'Preparing folder scan…' : 'Preparing library scan…',
  })
  broadcastScanStatus()

  const scanReporter: ScanReporter = {
    onRunStarted: ({ runId, startedAt, totalSources }) => {
      activeScanStatus = {
        ...(activeScanStatus ?? emptyScanStatus()),
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
    onProgress: (progress) => {
      activeScanStatus = {
        ...(activeScanStatus ?? emptyScanStatus()),
        active: true,
        ...progress,
      }
      broadcastScanStatus()
    },
    onEvent: (event) => {
      activeScanStatus = {
        ...(activeScanStatus ?? emptyScanStatus({ active: true })),
        events: trimScanEvents([...(activeScanStatus?.events || []), event]),
      }
      broadcastScanStreamEvent('scan-event', event)
      broadcastScanStatus()
    },
    onRunFinished: ({ runId, finishedAt, summary }) => {
      activeScanStatus = {
        ...(activeScanStatus ?? emptyScanStatus()),
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
      runScan(db, config, sourceId, scanReporter, options).then(() => resolve(), reject)
    })
  })
    .catch((error) => {
      const finishedAt = new Date().toISOString()
      activeScanStatus = {
        ...(activeScanStatus ?? emptyScanStatus()),
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

app.use((request, response, next) => {
  const typedRequest = request as RequestWithUser
  const cookies = parseCookie(request.headers.cookie || '')
  const authorization = request.get('authorization') || ''
  const bearerToken = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] || null
  const sessionId = bearerToken || cookies[SESSION_COOKIE_NAME] || null
  const sessionContext = findSessionContext(db, sessionId)

  typedRequest.sessionId = sessionId
  typedRequest.sessionUser = sessionContext?.user ?? null
  typedRequest.sessionCsrfToken = sessionContext?.csrfToken ?? null
  typedRequest.authMode = bearerToken ? 'mobile' : 'browser'

  // Keep the browser cookie in step with the server-side sliding expiry.
  if (sessionContext?.renewed && !bearerToken && sessionId) {
    setSessionCookie(response, sessionId, sessionContext.expiresAt)
  }

  next()
})

const requireAuth = (request: Request, response: Response, next: NextFunction) => {
  if (!(request as RequestWithUser).sessionUser) {
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
const csrfExemptPaths = new Set([
  '/api/auth/login',
  '/api/auth/signup',
  '/api/mobile/auth/login',
])

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

app.use('/api', (request: Request, response: Response, next: NextFunction) => {
  if (!unsafeHttpMethods.has(request.method) || csrfExemptPaths.has(request.originalUrl.split('?')[0])) {
    next()
    return
  }

  const typedRequest = request as RequestWithUser

  if (!typedRequest.sessionUser || typedRequest.authMode === 'mobile') {
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
})

// The Android app is a different origin (https://localhost). It authenticates
// with a bearer token, so no cookies are shared; Range and the exposed headers
// let pdf.js stream large PDFs page by page instead of downloading them whole.
app.use('/api', (request, response, next) => {
  const origin = request.get('origin')

  if (!origin || !mobileOrigins.has(origin)) {
    next()
    return
  }

  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Access-Control-Allow-Credentials', 'false')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, Range, If-None-Match')
  response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS')
  response.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Content-Disposition',
  )
  response.setHeader('Access-Control-Max-Age', '600')
  response.append('Vary', 'Origin')

  if (request.method === 'OPTIONS') {
    response.status(204).end()
    return
  }

  next()
})

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
  if (response.headersSent) {
    if (!response.writableEnded) {
      response.destroy()
    }
    return
  }

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

const authenticate = async (request: Request, response: Response) => {
  const username = String(request.body?.username || '')
  const rateLimiters = getLoginRateLimiters(request, username)

  try {
    assertRateLimitersAllowed(rateLimiters)
    const user = await loginUser(db, username, String(request.body?.password || ''))
    clearRateLimitBuckets(db, rateLimiters.map((rateLimiter) => rateLimiter.key))
    return user
  } catch (error) {
    if (!(error instanceof RateLimitError)) {
      try {
        recordRateLimiterFailures(rateLimiters)
      } catch (rateLimitError) {
        sendError(response, rateLimitError)
        return null
      }
    }

    sendError(response, error, 401)
    return null
  }
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

/* ---------------------------------------------------------------- health -- */

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

/* ----------------------------------------------------------- android app -- */

app.get('/api/mobile/app.apk', async (request, response) => {
  try {
    const apk = await resolveAndroidApk(androidApkLocations)

    if (!apk) {
      response.status(404).json({ error: 'The Android app download is not available yet.' })
      return
    }

    if (apk.kind === 'redirect') {
      response.redirect(302, apk.url)
      return
    }

    response.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate')
    await sendMediaFile(request, response, apk.filePath, {
      stats: apk.stats,
      contentType: 'application/vnd.android.package-archive',
      fileName: 'orbital-android.apk',
      disposition: 'attachment',
    })
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/mobile/app-info', requireAuth, async (_request, response) => {
  try {
    response.json(await getAndroidAppInfo(db, androidApkLocations))
  } catch (error) {
    sendError(response, error)
  }
})

/* ------------------------------------------------------------------ auth -- */

app.get('/api/state', requireAuth, (request, response) => {
  response.json(getStatePayload(request, (request as RequestWithUser).sessionUser))
})

app.get('/api/bootstrap', (request, response) => {
  const typedRequest = request as RequestWithUser
  response.json(getBootstrapPayload(typedRequest.sessionUser, typedRequest.sessionCsrfToken))
})

app.post('/api/auth/login', async (request, response) => {
  const user = await authenticate(request, response)
  if (!user) {
    return
  }

  startFreshSession(request, response, user.id)
  response.json(getStatePayload(request, user))
})

app.post('/api/mobile/auth/login', async (request, response) => {
  const user = await authenticate(request, response)
  if (!user) {
    return
  }

  const session = createSession(db, user.id)
  ;(request as RequestWithUser).sessionCsrfToken = session.csrfToken
  response.json({
    ...getStatePayload(request, user),
    accessToken: session.sessionId,
    accessTokenExpiresAt: session.expiresAt,
  })
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
    startFreshSession(request, response, user.id)
    response.json(getStatePayload(request, user))
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/auth/logout', (request, response) => {
  clearSession(db, (request as RequestWithUser).sessionId)
  clearSessionCookie(response)
  response.json({ ok: true })
})

app.post('/api/auth/change-password', requireAuth, async (request, response) => {
  try {
    const typedRequest = request as RequestWithUser
    const sessionUser = currentUser(request)
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

    response.json(getStatePayload(request, sessionUser))
  } catch (error) {
    sendError(response, error)
  }
})

/* --------------------------------------------------------------- library -- */

app.get('/api/search', requireAuth, (request, response) => {
  try {
    const query = queryText(request, 'q').trim()
    const scope = (queryText(request, 'scope') || 'all') as 'all' | 'anime' | 'manga' | 'novels' | 'books' | 'magazines'

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
    response.json({ series: getSeriesDetail(db, routeParam(request, 'seriesId')) })
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media-tracks/:entryId', requireAuth, async (request, response) => {
  try {
    const entryId = routeParam(request, 'entryId')
    const sidecarTracks = getEntrySidecarMediaTracks(db, entryId)
    const embeddedTracks = await getEntryEmbeddedMediaTracks(db, entryId)

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

const readProgressPayload = (request: Request): ReadingProgressPayload => ({
  seriesId: String(request.body?.seriesId || ''),
  entryId: String(request.body?.entryId || ''),
  entryIndex: Number(request.body?.entryIndex || 0),
  progress: String(request.body?.progress || ''),
  cue: String(request.body?.cue || ''),
  position: request.body?.position,
  lastSeen: typeof request.body?.lastSeen === 'string' ? request.body.lastSeen : undefined,
})

app.post('/api/bookmarks', requireAuth, (request, response) => {
  try {
    const user = currentUser(request)
    const payload = readProgressPayload(request)
    response.json(isCompactRequest(request) ? saveReadingProgress(db, user, payload) : saveBookmark(db, user, payload))
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/bookmarks/:seriesId', requireAuth, (request, response) => {
  try {
    const result = removeBookmark(db, currentUser(request), routeParam(request, 'seriesId'))
    response.json(isCompactRequest(request) ? { ok: true } : result)
  } catch (error) {
    sendError(response, error)
  }
})

app.get('/api/reader-preferences/:seriesId', requireAuth, (request, response) => {
  try {
    response.json({
      preference: getReaderPreference(db, currentUser(request), routeParam(request, 'seriesId')),
    })
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.put('/api/reader-preferences/:seriesId', requireAuth, (request, response) => {
  try {
    response.json({
      preference: saveReaderPreference(db, currentUser(request), routeParam(request, 'seriesId'), request.body?.settings),
    })
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/comments', requireAuth, (request, response) => {
  try {
    const payload = {
      seriesId: String(request.body?.seriesId || ''),
      text: String(request.body?.text || ''),
    }
    response.json(
      isCompactRequest(request)
        ? { comments: addCommentCompact(db, currentUser(request), payload) }
        : { series: addComment(db, currentUser(request), payload) },
    )
  } catch (error) {
    sendError(response, error)
  }
})

/* ----------------------------------------------------------------- admin -- */

const respondWithState = (request: Request, response: Response) => {
  response.json(getStatePayload(request, (request as RequestWithUser).sessionUser))
}

app.post('/api/admin/roots', requireAdmin, (request, response) => {
  try {
    createSourceRoot(db, config, {
      label: String(request.body?.label || '').trim(),
      path: String(request.body?.path || '').trim(),
    })
    respondWithState(request, response)
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/admin/roots/:rootId', requireAdmin, (request, response) => {
  try {
    removeSourceRoot(db, config, routeParam(request, 'rootId'))
    respondWithState(request, response)
  } catch (error) {
    sendError(response, error)
  }
})

app.get('/api/admin/directories', requireAdmin, (request, response) => {
  try {
    response.json(
      listDirectoriesForRoot(db, queryText(request, 'rootId'), queryText(request, 'relativePath')),
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
    respondWithState(request, response)
  } catch (error) {
    sendError(response, error)
  }
})

app.patch('/api/admin/sources/:sourceId', requireAdmin, (request, response) => {
  try {
    const sourceId = routeParam(request, 'sourceId')
    updateSourceFolderCategory(db, config, sourceId, { category: request.body?.category })
    void startBackgroundScan(sourceId)
    respondWithState(request, response)
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/admin/sources/:sourceId', requireAdmin, (request, response) => {
  try {
    removeSourceFolder(db, routeParam(request, 'sourceId'))
    respondWithState(request, response)
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/scan', requireAdmin, (request, response) => {
  try {
    void startBackgroundScan(request.body?.sourceId ? String(request.body.sourceId) : undefined)
    respondWithState(request, response)
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

app.post('/api/admin/users', requireAdmin, async (request, response) => {
  try {
    await createUserAccount(db, {
      username: String(request.body?.username || ''),
      password: String(request.body?.password || ''),
      role: String(request.body?.role || 'member'),
    })
    respondWithState(request, response)
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/admin/users/:userId', requireAdmin, (request, response) => {
  try {
    deleteUserAccount(db, config, currentUser(request), routeParam(request, 'userId'))
    respondWithState(request, response)
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/users/:userId/reset-password', requireAdmin, async (request, response) => {
  try {
    const adminUser = currentUser(request)
    const userId = routeParam(request, 'userId')

    consumeRateLimit(
      db,
      createRateLimitKey('admin-reset-password', adminUser.id, userId, getClientAddress(request)),
      adminResetPolicy,
    )
    await resetUserPassword(db, userId, String(request.body?.password || ''))
    respondWithState(request, response)
  } catch (error) {
    sendError(response, error)
  }
})

app.get('/api/admin/settings', requireAdmin, async (_request, response) => {
  try {
    response.json({
      remoteMetadata: getRemoteMetadataSetting(db),
      openSignup: config.openSignup,
      androidApp: await getAndroidAppInfo(db, androidApkLocations),
    })
  } catch (error) {
    sendError(response, error)
  }
})

app.put('/api/admin/settings', requireAdmin, async (request, response) => {
  try {
    if (typeof request.body?.remoteMetadataEnabled === 'boolean') {
      setRemoteMetadataEnabled(db, request.body.remoteMetadataEnabled)
    }

    response.json({
      remoteMetadata: getRemoteMetadataSetting(db),
      openSignup: config.openSignup,
      androidApp: await getAndroidAppInfo(db, androidApkLocations),
    })
  } catch (error) {
    sendError(response, error)
  }
})

app.put('/api/admin/android-app', requireAdmin, async (request, response) => {
  try {
    await saveUploadedAndroidApk(db, androidApkLocations, request, {
      versionName: queryText(request, 'versionName'),
      versionCode: queryText(request, 'versionCode'),
    })
    response.json({ androidApp: await getAndroidAppInfo(db, androidApkLocations) })
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/admin/android-app', requireAdmin, async (_request, response) => {
  try {
    await deleteUploadedAndroidApk(db, androidApkLocations)
    response.json({ androidApp: await getAndroidAppInfo(db, androidApkLocations) })
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/series/:seriesId/metadata-override', requireAdmin, async (request, response) => {
  try {
    await saveMetadataOverride(db, config, routeParam(request, 'seriesId'), {
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
    respondWithState(request, response)
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/admin/series/:seriesId/metadata-override', requireAdmin, async (request, response) => {
  try {
    await clearMetadataOverride(db, config, routeParam(request, 'seriesId'))
    respondWithState(request, response)
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/series/:seriesId/metadata-refresh', requireAdmin, async (request, response) => {
  try {
    await refreshSeriesMetadata(db, config, routeParam(request, 'seriesId'))
    respondWithState(request, response)
  } catch (error) {
    sendError(response, error)
  }
})

/* --------------------------------------------------------------- offline -- */

app.get('/api/offline/capabilities', requireAuth, (_request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.json(getOfflineCapabilities(db, config.appName))
})

app.post('/api/offline/estimate', requireAuth, async (request, response) => {
  try {
    response.setHeader('Cache-Control', 'no-store')
    response.json(await buildOfflineEstimate(db, currentUser(request), request.body?.target))
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/offline/manifests', requireAuth, async (request, response) => {
  try {
    response.setHeader('Cache-Control', 'no-store')
    response.json(await buildOfflineManifest(db, currentUser(request), request.body?.target))
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
    const resource = await resolveOfflineResource(db, currentUser(request), routeParam(request, 'resourceKey'))

    setOfflineResourceHeaders(response, resource.entityTag)

    if (requestMatchesEntityTag(request, resource.entityTag)) {
      response.status(304).end()
      return
    }

    if (resource.kind === 'file') {
      await sendMediaFile(request, response, resource.filePath, {
        contentType: resource.contentType,
        rangeHeader: request.headers.range,
      })
      return
    }

    const bytes = await readCbzPage(resource.filePath, resource.stats, resource.manifest, resource.page)
    sendCbzPageBytes(response, resource.page, bytes, request.method === 'HEAD')
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    sendError(response, error, message.includes('stale') ? 409 : 404)
  }
}

app.head('/api/offline/manifests/:manifestId/resources/:resourceKey', requireAuth, sendOfflineResource)
app.get('/api/offline/manifests/:manifestId/resources/:resourceKey', requireAuth, sendOfflineResource)

/* ----------------------------------------------------------------- media -- */

app.get('/api/media/cover/:seriesId', requireAuth, async (request, response) => {
  try {
    const seriesId = routeParam(request, 'seriesId')
    const cover = resolveSeriesCoverPath(db, seriesId)
    const coverPath = queryText(request, 'variant') === 'card'
      ? await resolveCardCoverPath(coversDirectory, seriesId, cover.filePath)
      : cover.filePath
    setPrivateVersionedCacheHeaders(response, request.query.v)
    await sendMediaFile(request, response, coverPath, {
      contentType: coverPath === cover.filePath ? cover.mimeType : 'image/webp',
    })
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media/banner/:seriesId', requireAuth, async (request, response) => {
  try {
    const banner = resolveSeriesBannerPath(db, routeParam(request, 'seriesId'))
    setPrivateVersionedCacheHeaders(response, request.query.v)
    await sendMediaFile(request, response, banner.filePath, { contentType: banner.mimeType })
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media/cbz/:entryId/manifest', requireAuth, async (request, response) => {
  try {
    const entry = await resolveEntryMediaFile(db, routeParam(request, 'entryId'))

    if (entry.format !== 'cbz') {
      throw new Error('Requested entry is not a CBZ archive.')
    }

    const currentVersion = getCbzMediaVersion(entry.stats)
    const archive = await loadCbzArchiveManifest(entry.filePath, entry.stats)
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
        size: page.uncompressedSize,
        url: `/api/media/cbz/${encodeURIComponent(entry.entryId)}/pages/${page.pageNumber}${versionQuery}`,
      })),
    })
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media/cbz/:entryId/pages/:pageNumber', requireAuth, async (request, response) => {
  try {
    const entry = await resolveEntryMediaFile(db, routeParam(request, 'entryId'))

    if (entry.format !== 'cbz') {
      throw new Error('Requested entry is not a CBZ archive.')
    }

    const pageNumber = Number(routeParam(request, 'pageNumber'))

    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new Error('Requested CBZ page was not found.')
    }

    const currentVersion = getCbzMediaVersion(entry.stats)

    if (isStaleMediaVersion(request.query, currentVersion)) {
      response.setHeader('Cache-Control', 'no-store')
      response.redirect(307, buildVersionedMediaPath(request.originalUrl, currentVersion))
      return
    }

    const archive = await loadCbzArchiveManifest(entry.filePath, entry.stats)
    const page = archive.pages[pageNumber - 1]

    if (!page) {
      throw new Error('Requested CBZ page was not found.')
    }

    const bytes = await readCbzPage(entry.filePath, entry.stats, archive, page)
    setPrivateVersionedCacheHeaders(
      response,
      isCurrentMediaVersion(request.query, currentVersion) ? currentVersion : '',
    )
    sendCbzPageBytes(response, page, bytes, request.method === 'HEAD')
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media/file/:entryId', requireAuth, async (request, response) => {
  try {
    const entry = await resolveEntryMediaFile(db, routeParam(request, 'entryId'))
    await sendMediaFile(request, response, entry.filePath, {
      stats: entry.stats,
      rangeHeader: request.headers.range,
    })
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media/track/:entryId/:kind/:trackId', requireAuth, async (request, response) => {
  try {
    const entryId = routeParam(request, 'entryId')
    const trackId = routeParam(request, 'trackId')
    const kindParam = routeParam(request, 'kind')
    const kind = kindParam === 'audio' ? 'audio' : kindParam === 'subtitle' ? 'subtitle' : null

    if (!kind) {
      throw new Error('Unsupported media track kind.')
    }

    if (trackId.startsWith('embedded-')) {
      if (kind === 'audio') {
        const embeddedAudio = await streamEmbeddedAudioTrack(db, entryId, trackId)
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

      const embeddedSubtitle = await renderEmbeddedSubtitleTrack(db, entryId, trackId)
      response.status(200)
      response.setHeader('Content-Type', 'text/vtt; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.send(embeddedSubtitle)
      return
    }

    if (kind === 'audio') {
      const track = await resolveEntryTrack(db, entryId, kind, trackId)
      await sendMediaFile(request, response, track.filePath, { rangeHeader: request.headers.range })
      return
    }

    const trackPayload = await renderSubtitleTrackForBrowser(db, entryId, trackId)
    response.status(200)
    response.setHeader('Content-Type', 'text/vtt; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.send(trackPayload)
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'Not found.' })
})

/* ---------------------------------------------------------------- client -- */

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

/* --------------------------------------------------------------- startup -- */

process.on('unhandledRejection', (reason) => {
  if (!isClientAbortError(reason)) {
    console.error('Unhandled promise rejection:', reason)
  }
})

ensureConfiguredSourceRoot(db, config)
await bootstrapAdminUser(db, config)
const demoSeedNeedsScan = await maybeSeedDemoContent(db, config)

const httpServer = app.listen(port, () => {
  console.log(`Orbital Library server listening on http://127.0.0.1:${port}`)
})

const interruptedScanToResume = interruptedScanResumptions.find((run) => run.shouldResume)

if (interruptedScanToResume) {
  const resumeDelayMs = Math.min(
    30_000,
    1_000 * (2 ** Math.min(interruptedScanToResume.resumeAttempt, 5)),
  )
  setTimeout(() => {
    void startBackgroundScan(
      interruptedScanToResume.sourceId ?? undefined,
      {
        resumeAttempt: interruptedScanToResume.resumeAttempt + 1,
        lineageId: interruptedScanToResume.lineageId,
        resumedFromRunId: interruptedScanToResume.runId,
      },
    )
  }, resumeDelayMs)
} else if (demoSeedNeedsScan) {
  void startBackgroundScan()
}

let stopping = false

const stopServer = () => {
  if (stopping) {
    return
  }
  stopping = true

  for (const client of scanEventClients) {
    client.end()
  }
  scanEventClients.clear()
  shutdownMediaWorker()

  const forceExit = setTimeout(() => {
    httpServer.closeAllConnections()
    process.exit(0)
  }, 8000)
  forceExit.unref()

  httpServer.close(() => {
    db.close()
    process.exit(0)
  })
  httpServer.closeIdleConnections()
}

process.once('SIGINT', stopServer)
process.once('SIGTERM', stopServer)
