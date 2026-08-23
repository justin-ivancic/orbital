import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  OfflineDownloadManifest,
  OfflineDownloadRecord,
  OfflineDownloadResource,
} from './appTypes'
import {
  isOfflineResourceComplete,
  isRetryableOfflineDownloadError,
  mergeOfflineDownloadRecord,
  mergeOfflineManifestWithStoredResources,
  OfflineResourceIntegrityError,
  planReusableOfflineResources,
  progressForOfflineResources,
} from './offlineDownloads'

const makeResource = (
  key: string,
  version: string,
  size: number,
): OfflineDownloadResource => ({
  key,
  kind: 'file',
  entryId: key,
  seriesId: 'series-1',
  label: key,
  url: `/api/${key}`,
  onlineUrl: `/media/${key}`,
  contentType: 'application/pdf',
  size,
  version,
  required: true,
})

const makeManifest = (resources: OfflineDownloadResource[]): OfflineDownloadManifest => ({
  protocolVersion: 1,
  manifestId: 'pkg_test',
  serverInstanceId: 'server-1',
  ownerUserId: 'user-1',
  ownerUsername: 'justin',
  target: { type: 'series', seriesId: 'series-1' },
  contentKey: 'content-1',
  title: 'Test series',
  seriesTitle: 'Test series',
  subtitle: '2 items',
  category: 'books',
  createdAt: '2026-08-23T00:00:00.000Z',
  estimatedBytes: resources.reduce((total, resource) => total + resource.size, 0),
  resourceCount: resources.length,
  entryCount: resources.length,
  entries: resources.map((resource) => ({
    entryId: resource.entryId || resource.key,
    label: resource.label,
    title: resource.label,
    format: 'pdf',
    version: resource.version,
    pageCount: null,
    resourceKeys: [resource.key],
  })),
  resources,
})

const makeRecord = (manifest: OfflineDownloadManifest): OfflineDownloadRecord => ({
  id: manifest.manifestId,
  manifest,
  ownerUserId: manifest.ownerUserId,
  ownerUsername: manifest.ownerUsername,
  status: 'queued',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  completedAt: null,
  downloadedBytes: 0,
  verifiedBytes: 0,
  resourceCount: manifest.resourceCount,
  downloadedResourceCount: 0,
  failureReason: null,
  retryAt: null,
})

test('offline resource completion requires matching key, version, and size', () => {
  const resource = makeResource('entry-1', 'v1', 100)

  assert.equal(
    isOfflineResourceComplete(resource, {
      resource: { ...resource, url: 'file:///complete.pdf' },
      size: 100,
    }),
    true,
  )
  assert.equal(
    isOfflineResourceComplete(resource, {
      resource: { ...resource, version: 'v0' },
      size: 100,
    }),
    false,
  )
  assert.equal(
    isOfflineResourceComplete(resource, {
      resource,
      size: 99,
    }),
    false,
  )
})

test('manifest merge preserves completed local resources and leaves incomplete resources remote', () => {
  const first = makeResource('entry-1', 'v1', 100)
  const second = makeResource('entry-2', 'v1', 200)
  const manifest = makeManifest([first, second])
  const merged = mergeOfflineManifestWithStoredResources(manifest, [
    {
      resource: { ...first, url: 'file:///complete.pdf' },
      size: 100,
    },
    {
      resource: { ...second, version: 'old' },
      size: 200,
    },
  ])

  assert.equal(merged.manifest.resources[0].url, 'file:///complete.pdf')
  assert.equal(merged.manifest.resources[1].url, '/api/entry-2')
  assert.deepEqual(merged.completedResources.map((resource) => resource.key), ['entry-1'])
})

test('resumed record counts only verified resources and keeps its original creation time', () => {
  const resources = [makeResource('entry-1', 'v1', 100), makeResource('entry-2', 'v1', 200)]
  const manifest = makeManifest(resources)
  const existing = {
    ...makeRecord(manifest),
    createdAt: '2026-08-22T00:00:00.000Z',
    status: 'partial' as const,
    downloadedBytes: 100,
    verifiedBytes: 100,
    downloadedResourceCount: 1,
  }
  const resumed = mergeOfflineDownloadRecord(
    manifest,
    existing,
    [resources[0]],
    {
      ...manifest,
      resources: [{ ...resources[0], url: 'file:///complete.pdf' }, resources[1]],
    },
    makeRecord,
  )

  assert.equal(resumed.createdAt, '2026-08-22T00:00:00.000Z')
  assert.equal(resumed.status, 'downloading')
  assert.equal(resumed.downloadedResourceCount, 1)
  assert.equal(resumed.downloadedBytes, 100)
  assert.equal(resumed.retryAt, null)
})

test('changed content creates a replacement package instead of reusing the old package id', () => {
  const resource = makeResource('entry-1', 'v1', 100)
  const manifest = makeManifest([resource])
  const existing = makeRecord(manifest)
  const changedManifest = {
    ...manifest,
    manifestId: 'pkg_changed',
    contentKey: 'content-2',
    resources: [{ ...resource, version: 'v2', url: '/api/changed' }],
  }
  const replacement = mergeOfflineDownloadRecord(
    changedManifest,
    existing,
    [],
    changedManifest,
    makeRecord,
  )

  assert.equal(replacement.id, 'pkg_changed')
  assert.notEqual(replacement.id, existing.id)
  assert.equal(replacement.manifest.contentKey, 'content-2')
})

test('incremental series updates plan matching resources for local reuse', () => {
  const existing = makeResource('entry-1', 'v1', 100)
  const newEntry = makeResource('entry-2', 'v1', 200)
  const changed = makeResource('entry-3', 'v2', 300)
  const manifest = makeManifest([existing, newEntry, changed])

  const transfers = planReusableOfflineResources(manifest, [
    {
      downloadId: 'pkg_previous',
      resources: [
        { resource: { ...existing, url: 'file:///existing.pdf' }, size: 100 },
        { resource: { ...changed, version: 'v1', url: 'file:///old.pdf' }, size: 300 },
      ],
    },
  ])

  assert.deepEqual(
    transfers.map((transfer) => [transfer.sourceDownloadId, transfer.resource.key]),
    [['pkg_previous', existing.key]],
  )
})

test('incremental series updates do not copy resources already present in the replacement package', () => {
  const existing = makeResource('entry-1', 'v1', 100)
  const newEntry = makeResource('entry-2', 'v1', 200)
  const manifest = makeManifest([existing, newEntry])

  const transfers = planReusableOfflineResources(
    manifest,
    [{
      downloadId: 'pkg_previous',
      resources: [{ resource: { ...existing, url: 'file:///existing.pdf' }, size: 100 }],
    }],
    [{ resource: { ...existing, url: 'file:///replacement.pdf' }, size: 100 }],
  )

  assert.deepEqual(transfers, [])
})

test('incremental series updates select each reusable resource only once across packages', () => {
  const first = makeResource('entry-1', 'v1', 100)
  const second = makeResource('entry-2', 'v1', 200)
  const manifest = makeManifest([first, second])

  const transfers = planReusableOfflineResources(manifest, [
    {
      downloadId: 'pkg_newer_previous',
      resources: [{ resource: { ...first, url: 'file:///first.pdf' }, size: 100 }],
    },
    {
      downloadId: 'pkg_older_previous',
      resources: [
        { resource: { ...first, url: 'file:///duplicate.pdf' }, size: 100 },
        { resource: { ...second, url: 'file:///second.pdf' }, size: 200 },
      ],
    },
  ])

  assert.deepEqual(
    transfers.map((transfer) => [transfer.sourceDownloadId, transfer.resource.key]),
    [
      ['pkg_newer_previous', first.key],
      ['pkg_older_previous', second.key],
    ],
  )
})

test('offline retry classification distinguishes network failures from authorization failures', () => {
  assert.equal(isRetryableOfflineDownloadError(new TypeError('Failed to fetch')), true)
  assert.equal(isRetryableOfflineDownloadError({ status: 503 }), true)
  assert.equal(isRetryableOfflineDownloadError({ status: 401 }), false)
  assert.equal(isRetryableOfflineDownloadError(new OfflineResourceIntegrityError('page 1')), true)
})

test('offline progress counts only completed resources', () => {
  const resources = [makeResource('entry-1', 'v1', 100), makeResource('entry-2', 'v1', 200)]

  assert.deepEqual(progressForOfflineResources(resources, [resources[1]]), {
    downloadedBytes: 200,
    verifiedBytes: 200,
    downloadedResourceCount: 1,
  })
})
