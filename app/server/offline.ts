import crypto from 'node:crypto'
import fsPromises from 'node:fs/promises'
import mime from 'mime-types'
import type {
  CategoryId,
  EntryFormat,
  OfflineCapabilities,
  OfflineDownloadEstimate,
  OfflineDownloadManifest,
  OfflineDownloadResource,
  OfflineDownloadTarget,
  OfflineManifestEntry,
  OfflineResourceKind,
  SessionUser,
} from '../src/appTypes.ts'
import {
  getCbzMediaVersion,
  loadCbzArchiveManifest,
  type CbzArchivePage,
} from './cbzArchive'
import type { OrbitalDatabase } from './database'

const protocolVersion = 1
const serverInstanceSettingKey = 'server_instance_id'
const resourceKeyVersion = 1

type OfflineEntryRow = {
  entryId: string
  seriesId: string
  category: CategoryId
  seriesTitle: string
  seriesTitleShort: string
  label: string
  title: string
  format: EntryFormat
  filePath: string
  size: number
  mtimeMs: number
  sortOrder: number
}

type OfflineResourceKeyPayload = {
  v: typeof resourceKeyVersion
  u: string
  k: OfflineResourceKind
  e?: string
  s?: string
  p?: number
  mv: string
}

export type ResolvedOfflineResource =
  | {
      kind: 'file'
      filePath: string
      contentType: string
      entityTag: string
      version: string
    }
  | {
      kind: 'cbz-page'
      filePath: string
      page: CbzArchivePage
      entityTag: string
      version: string
    }

const nowIso = () => new Date().toISOString()

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

const stableStringify = (value: unknown): string => {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`
}

const encodeResourceKey = (payload: OfflineResourceKeyPayload) =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')

export const decodeOfflineResourceKey = (resourceKey: string): OfflineResourceKeyPayload => {
  try {
    const decoded = JSON.parse(Buffer.from(resourceKey, 'base64url').toString('utf8')) as Partial<OfflineResourceKeyPayload>

    if (
      decoded.v !== resourceKeyVersion ||
      !decoded.u ||
      !decoded.k ||
      !decoded.mv ||
      !['cbz-page', 'file', 'cover', 'banner'].includes(decoded.k)
    ) {
      throw new Error('Invalid offline resource key.')
    }

    return decoded as OfflineResourceKeyPayload
  } catch {
    throw new Error('Invalid offline resource key.')
  }
}

export const getServerInstanceId = (db: OrbitalDatabase) => {
  const existing = db
    .prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1')
    .get(serverInstanceSettingKey) as { value: string } | undefined

  if (existing?.value) {
    return existing.value
  }

  const serverInstanceId = `orbital_${crypto.randomUUID()}`

  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)`,
  ).run(serverInstanceSettingKey, serverInstanceId, nowIso())

  return serverInstanceId
}

const getUserScope = (serverInstanceId: string, user: SessionUser) =>
  sha256(`${serverInstanceId}:${user.id}`).slice(0, 24)

const assertOfflineTarget = (target: unknown): OfflineDownloadTarget => {
  if (!target || typeof target !== 'object') {
    throw new Error('Offline download target is required.')
  }

  const typedTarget = target as Partial<OfflineDownloadTarget>

  if (typedTarget.type === 'entry' && typeof typedTarget.entryId === 'string' && typedTarget.entryId.trim()) {
    return {
      type: 'entry',
      entryId: typedTarget.entryId.trim(),
    }
  }

  if (typedTarget.type === 'series' && typeof typedTarget.seriesId === 'string' && typedTarget.seriesId.trim()) {
    return {
      type: 'series',
      seriesId: typedTarget.seriesId.trim(),
    }
  }

  throw new Error('Offline download target is invalid.')
}

const getTargetEntries = (db: OrbitalDatabase, target: OfflineDownloadTarget) => {
  const baseSql = `
    SELECT
      entries.id AS entryId,
      entries.series_id AS seriesId,
      series.category AS category,
      series.title AS seriesTitle,
      series.title_short AS seriesTitleShort,
      entries.label AS label,
      entries.title AS title,
      entries.format AS format,
      entries.file_path AS filePath,
      entries.size AS size,
      entries.mtime_ms AS mtimeMs,
      entries.sort_order AS sortOrder
    FROM entries
    JOIN series ON series.id = entries.series_id
  `

  const rows =
    target.type === 'entry'
      ? (db.prepare(`${baseSql} WHERE entries.id = ? LIMIT 1`).all(target.entryId) as OfflineEntryRow[])
      : (db
          .prepare(`${baseSql} WHERE series.id = ? ORDER BY entries.sort_order, entries.title COLLATE NOCASE, entries.id`)
          .all(target.seriesId) as OfflineEntryRow[])

  if (!rows.length) {
    throw new Error('Requested offline item was not found.')
  }

  return rows
}

const getEntryVersion = (entry: Pick<OfflineEntryRow, 'mtimeMs' | 'size'>) =>
  `${Math.round(Number(entry.mtimeMs) || 0)}-${Math.max(0, Number(entry.size) || 0)}`

const getOfflineResourceUrl = (manifestId: string, resourceKey: string) =>
  `/api/offline/manifests/${encodeURIComponent(manifestId)}/resources/${encodeURIComponent(resourceKey)}`

const getResourceOnlineUrl = (
  resource: Pick<OfflineDownloadResource, 'kind' | 'entryId' | 'pageNumber' | 'version'>,
) => {
  if (resource.kind === 'cbz-page' && resource.entryId && resource.pageNumber) {
    return `/api/media/cbz/${encodeURIComponent(resource.entryId)}/pages/${resource.pageNumber}?v=${encodeURIComponent(resource.version)}`
  }

  if (resource.kind === 'file' && resource.entryId) {
    return `/api/media/file/${encodeURIComponent(resource.entryId)}?v=${encodeURIComponent(resource.version)}`
  }

  return ''
}

const makeResource = (
  manifestId: string,
  userScope: string,
  partial: Omit<OfflineDownloadResource, 'key' | 'url' | 'onlineUrl'>,
) => {
  const resourceKey = encodeResourceKey({
    v: resourceKeyVersion,
    u: userScope,
    k: partial.kind,
    e: partial.entryId,
    s: partial.seriesId,
    p: partial.pageNumber,
    mv: partial.version,
  })
  const resource = {
    ...partial,
    key: resourceKey,
    url: getOfflineResourceUrl(manifestId, resourceKey),
    onlineUrl: getResourceOnlineUrl(partial),
  } satisfies OfflineDownloadResource

  return resource
}

const getManifestIdentity = (
  serverInstanceId: string,
  user: SessionUser,
  target: OfflineDownloadTarget,
  entries: OfflineEntryRow[],
) => {
  const contentKey = sha256(
    stableStringify({
      target,
      entries: entries.map((entry) => ({
        id: entry.entryId,
        format: entry.format,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      })),
    }),
  )
  const manifestId = `pkg_${sha256(`${serverInstanceId}:${user.id}:${contentKey}`).slice(0, 32)}`

  return {
    contentKey,
    manifestId,
  }
}

const buildFileResource = (
  manifestId: string,
  userScope: string,
  entry: OfflineEntryRow,
) =>
  makeResource(manifestId, userScope, {
    kind: 'file',
    entryId: entry.entryId,
    seriesId: entry.seriesId,
    label: entry.label,
    contentType: mime.lookup(entry.filePath) || 'application/octet-stream',
    size: Math.max(0, Number(entry.size) || 0),
    version: getEntryVersion(entry),
    required: true,
  })

const buildCbzEntryResources = async (
  manifestId: string,
  userScope: string,
  entry: OfflineEntryRow,
) => {
  const stats = await fsPromises.stat(entry.filePath)
  const version = getCbzMediaVersion(stats)
  const archive = await loadCbzArchiveManifest(entry.filePath, stats)
  const resources = archive.pages.map((page) =>
    makeResource(manifestId, userScope, {
      kind: 'cbz-page',
      entryId: entry.entryId,
      seriesId: entry.seriesId,
      pageNumber: page.pageNumber,
      label: page.name,
      contentType: page.contentType,
      size: page.uncompressedSize,
      version,
      required: true,
    }),
  )

  return {
    pageCount: archive.pageCount,
    resources,
    version,
  }
}

export const buildOfflineManifest = async (
  db: OrbitalDatabase,
  user: SessionUser,
  rawTarget: unknown,
): Promise<OfflineDownloadManifest> => {
  const target = assertOfflineTarget(rawTarget)
  const entries = getTargetEntries(db, target)
  const serverInstanceId = getServerInstanceId(db)
  const userScope = getUserScope(serverInstanceId, user)
  const { contentKey, manifestId } = getManifestIdentity(serverInstanceId, user, target, entries)
  const resources: OfflineDownloadResource[] = []
  const manifestEntries: OfflineManifestEntry[] = []

  for (const entry of entries) {
    if (entry.format === 'cbz') {
      const cbzPackage = await buildCbzEntryResources(manifestId, userScope, entry)
      resources.push(...cbzPackage.resources)
      manifestEntries.push({
        entryId: entry.entryId,
        label: entry.label,
        title: entry.title,
        format: entry.format,
        version: cbzPackage.version,
        pageCount: cbzPackage.pageCount,
        resourceKeys: cbzPackage.resources.map((resource) => resource.key),
      })
      continue
    }

    const resource = buildFileResource(manifestId, userScope, entry)
    resources.push(resource)
    manifestEntries.push({
      entryId: entry.entryId,
      label: entry.label,
      title: entry.title,
      format: entry.format,
      version: getEntryVersion(entry),
      pageCount: null,
      resourceKeys: [resource.key],
    })
  }

  const title =
    target.type === 'series'
      ? entries[0].seriesTitle
      : entries[0].seriesTitle === entries[0].title
        ? entries[0].seriesTitle
        : entries[0].title
  const subtitle =
    target.type === 'series'
      ? `${entries.length} ${entries.length === 1 ? 'item' : 'items'} from ${entries[0].seriesTitle}`
      : `${entries[0].seriesTitle} · ${entries[0].label}`
  const estimatedBytes = resources.reduce((total, resource) => total + Math.max(0, resource.size), 0)

  return {
    protocolVersion,
    manifestId,
    serverInstanceId,
    ownerUserId: user.id,
    ownerUsername: user.username,
    target,
    contentKey,
    title,
    seriesTitle: entries[0].seriesTitle,
    subtitle,
    category: entries[0].category,
    createdAt: nowIso(),
    estimatedBytes,
    resourceCount: resources.length,
    entryCount: manifestEntries.length,
    entries: manifestEntries,
    resources,
  }
}

export const buildOfflineEstimate = async (
  db: OrbitalDatabase,
  user: SessionUser,
  rawTarget: unknown,
): Promise<OfflineDownloadEstimate> => {
  const manifest = await buildOfflineManifest(db, user, rawTarget)

  return {
    target: manifest.target,
    title: manifest.title,
    subtitle: manifest.subtitle,
    category: manifest.category,
    estimatedBytes: manifest.estimatedBytes,
    resourceCount: manifest.resourceCount,
    entryCount: manifest.entryCount,
  }
}

export const getOfflineCapabilities = (
  db: OrbitalDatabase,
  appName: string,
): OfflineCapabilities => ({
  protocolVersion,
  serverInstanceId: getServerInstanceId(db),
  appName,
  supports: {
    cbzPages: true,
    wholeFiles: true,
    seriesPackages: true,
    rangeRequests: true,
  },
})

const getEntryForResource = (db: OrbitalDatabase, entryId: string) => {
  const entry = getTargetEntries(db, { type: 'entry', entryId })[0]

  if (!entry) {
    throw new Error('Requested offline resource was not found.')
  }

  return entry
}

export const resolveOfflineResource = async (
  db: OrbitalDatabase,
  user: SessionUser,
  resourceKey: string,
): Promise<ResolvedOfflineResource> => {
  const serverInstanceId = getServerInstanceId(db)
  const payload = decodeOfflineResourceKey(resourceKey)

  if (payload.u !== getUserScope(serverInstanceId, user)) {
    throw new Error('This offline resource belongs to a different account.')
  }

  if (!payload.e) {
    throw new Error('Requested offline resource was not found.')
  }

  const entry = getEntryForResource(db, payload.e)

  if (payload.k === 'file') {
    const currentVersion = getEntryVersion(entry)

    if (payload.mv !== currentVersion) {
      throw new Error('This offline resource is stale. Delete and download it again.')
    }

    return {
      kind: 'file',
      filePath: entry.filePath,
      contentType: mime.lookup(entry.filePath) || 'application/octet-stream',
      entityTag: `"offline-${sha256(`${entry.entryId}:${currentVersion}`).slice(0, 24)}"`,
      version: currentVersion,
    }
  }

  if (payload.k === 'cbz-page') {
    if (!payload.p || !Number.isInteger(payload.p) || payload.p < 1) {
      throw new Error('Requested offline page was not found.')
    }

    const stats = await fsPromises.stat(entry.filePath)
    const currentVersion = getCbzMediaVersion(stats)

    if (payload.mv !== currentVersion) {
      throw new Error('This offline resource is stale. Delete and download it again.')
    }

    const archive = await loadCbzArchiveManifest(entry.filePath, stats)
    const page = archive.pages[payload.p - 1]

    if (!page) {
      throw new Error('Requested offline page was not found.')
    }

    return {
      kind: 'cbz-page',
      filePath: entry.filePath,
      page,
      entityTag: `"offline-${sha256(`${entry.entryId}:${payload.p}:${currentVersion}`).slice(0, 24)}"`,
      version: currentVersion,
    }
  }

  throw new Error('Requested offline resource kind is not supported yet.')
}
