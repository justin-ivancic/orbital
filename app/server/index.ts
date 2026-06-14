import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { parse as parseCookie, serialize as serializeCookie } from 'cookie'
import express, { type NextFunction, type Request, type Response } from 'express'
import mime from 'mime-types'
import type { ScanLogEntry, ScanStatus } from '../src/appTypes.ts'
import { getEntryEmbeddedMediaTracks, renderEmbeddedSubtitleTrack, streamEmbeddedAudioTrack } from './embeddedMedia'
import { openDatabase } from './database'
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
  getAppState,
  getEntrySidecarMediaTracks,
  getSeriesDetail,
  listDirectoriesForRoot,
  loginUser,
  maybeSeedDemoContent,
  clearMetadataOverride,
  removeBookmark,
  removeSourceRoot,
  removeSourceFolder,
  refreshSeriesMetadata,
  renderSubtitleTrackForBrowser,
  resetUserPassword,
  resolveEntryFilePath,
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
  openSignup: process.env.APP_OPEN_SIGNUP !== '0',
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

const app = express()
app.use(express.json({ limit: '2mb' }))

let activeScanStatus: ScanStatus | null = null
let activeScanPromise: Promise<void> | null = null

const trimScanEvents = (events: ScanLogEntry[]) => events.slice(-40)

const getStatePayload = (user: RequestWithUser['sessionUser']) =>
  getAppState(db, config, user, activeScanStatus)

const getBootstrapPayload = (user: RequestWithUser['sessionUser']) => ({
  appName: config.appName,
  bootstrapAdmin: config.bootstrapAdmin,
  openSignup: config.openSignup,
  user,
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
    })
    .finally(() => {
      activeScanPromise = null
    })

  return activeScanPromise
}

const getSessionFromRequest = (request: RequestWithUser) => {
  const cookies = parseCookie(request.headers.cookie || '')
  const sessionId = cookies[SESSION_COOKIE_NAME] || null
  request.sessionId = sessionId
  request.sessionUser = findSessionUser(db, sessionId)
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

const setSessionCookie = (response: Response, sessionId: string, expiresAt: number) => {
  response.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: new Date(expiresAt),
      secure: process.env.APP_COOKIE_SECURE === '1',
    }),
  )
}

const clearSessionCookie = (response: Response) => {
  response.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: new Date(0),
      secure: process.env.APP_COOKIE_SECURE === '1',
    }),
  )
}

const sendError = (response: Response, error: unknown, status = 400) => {
  response.status(status).json({
    error: error instanceof Error ? error.message : 'Unknown error',
  })
}

const parseRangeHeader = (rangeHeader: string, fileSize: number) => {
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)

  if (!match) {
    return null
  }

  const start = match[1] ? Number(match[1]) : 0
  const end = match[2] ? Number(match[2]) : fileSize - 1

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= fileSize) {
    return null
  }

  return { start, end }
}

const sendMediaFile = async (response: Response, filePath: string, rangeHeader?: string) => {
  const stats = await fsPromises.stat(filePath)
  const contentType = mime.lookup(filePath) || 'application/octet-stream'
  const safeFileName = encodeURIComponent(path.basename(filePath))
  response.setHeader('Accept-Ranges', 'bytes')
  response.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${safeFileName}`,
  )

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
    fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(response)
    return
  }

  response.status(200)
  response.setHeader('Content-Type', contentType)
  response.setHeader('Content-Length', stats.size)
  fs.createReadStream(filePath).pipe(response)
}

app.get('/api/state', (request, response) => {
  const typedRequest = request as RequestWithUser
  response.json(getStatePayload(typedRequest.sessionUser))
})

app.get('/api/bootstrap', (request, response) => {
  const typedRequest = request as RequestWithUser
  response.json(getBootstrapPayload(typedRequest.sessionUser))
})

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    appName: config.appName,
    now: new Date().toISOString(),
  })
})

app.post('/api/auth/login', async (request, response) => {
  try {
    const user = await loginUser(
      db,
      String(request.body?.username || ''),
      String(request.body?.password || ''),
    )
    const session = createSession(db, user.id)
    setSessionCookie(response, session.sessionId, session.expiresAt)
    response.json(getStatePayload(user))
  } catch (error) {
    sendError(response, error, 401)
  }
})

app.post('/api/auth/signup', async (request, response) => {
  if (!config.openSignup) {
    response.status(403).json({ error: 'Open signup is disabled.' })
    return
  }

  try {
    const user = await signupUser(
      db,
      String(request.body?.username || ''),
      String(request.body?.password || ''),
    )
    const session = createSession(db, user.id)
    setSessionCookie(response, session.sessionId, session.expiresAt)
    response.json(getStatePayload(user))
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

    await changeUserPassword(
      db,
      sessionUser.id,
      String(request.body?.currentPassword || ''),
      String(request.body?.newPassword || ''),
      typedRequest.sessionId,
    )

    response.json(getStatePayload(sessionUser))
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
    response.json(getStatePayload(typedRequest.sessionUser))
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/admin/roots/:rootId', requireAdmin, (request, response) => {
  try {
    removeSourceRoot(db, config, request.params.rootId)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser))
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
    response.json(getStatePayload(typedRequest.sessionUser))
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
    response.json(getStatePayload(typedRequest.sessionUser))
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/admin/sources/:sourceId', requireAdmin, (request, response) => {
  try {
    removeSourceFolder(db, request.params.sourceId)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser))
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/scan', requireAdmin, async (request, response) => {
  try {
    void startBackgroundScan(request.body?.sourceId ? String(request.body.sourceId) : undefined)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser))
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/users/:userId/reset-password', requireAdmin, async (request, response) => {
  try {
    await resetUserPassword(
      db,
      request.params.userId,
      String(request.body?.password || ''),
    )
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser))
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
    response.json(getStatePayload(typedRequest.sessionUser))
  } catch (error) {
    sendError(response, error)
  }
})

app.delete('/api/admin/series/:seriesId/metadata-override', requireAdmin, async (request, response) => {
  try {
    await clearMetadataOverride(db, config, request.params.seriesId)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser))
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/admin/series/:seriesId/metadata-refresh', requireAdmin, async (request, response) => {
  try {
    await refreshSeriesMetadata(db, config, request.params.seriesId)
    const typedRequest = request as RequestWithUser
    response.json(getStatePayload(typedRequest.sessionUser))
  } catch (error) {
    sendError(response, error)
  }
})

app.get('/api/media/cover/:seriesId', requireAuth, async (request, response) => {
  try {
    const cover = resolveSeriesCoverPath(db, request.params.seriesId)
    response.setHeader('Content-Type', cover.mimeType)
    await sendMediaFile(response, cover.filePath)
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media/banner/:seriesId', requireAuth, async (request, response) => {
  try {
    const banner = resolveSeriesBannerPath(db, request.params.seriesId)
    response.setHeader('Content-Type', banner.mimeType)
    await sendMediaFile(response, banner.filePath)
  } catch (error) {
    sendError(response, error, 404)
  }
})

app.get('/api/media/file/:entryId', requireAuth, async (request, response) => {
  try {
    const filePath = resolveEntryFilePath(db, request.params.entryId)
    await sendMediaFile(response, filePath, request.headers.range)
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
      await sendMediaFile(response, track.filePath, request.headers.range)
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
  app.use(express.static(distDirectory))
  app.get(/^(?!\/api\/).*/, (_request, response) => {
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
