import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionUser } from '../src/appTypes.ts'
import { buildOfflineManifest, decodeOfflineResourceKey } from './offline'
import type { OrbitalDatabase } from './database'

const user = {
  id: 'user-1',
  username: 'justin',
  role: 'admin',
} satisfies SessionUser

const makeMockDb = () =>
  ({
    prepare: (sql: string) => {
      if (sql.includes('FROM app_settings')) {
        return {
          get: () => ({ value: 'orbital_test_server' }),
        }
      }

      if (sql.includes('FROM entries')) {
        return {
          all: () => [
            {
              entryId: 'entry-1',
              seriesId: 'series-1',
              category: 'books',
              seriesTitle: 'Practical Offline Systems',
              seriesTitleShort: 'Practical Offline Systems',
              label: 'Book',
              title: 'Practical Offline Systems',
              format: 'pdf',
              filePath: '/library/books/practical-offline-systems.pdf',
              size: 123456,
              mtimeMs: 1781520000000,
              sortOrder: 1,
            },
          ],
        }
      }

      throw new Error(`Unexpected SQL in mock database: ${sql}`)
    },
  }) as unknown as OrbitalDatabase

test('offline manifest snapshots raw file resources with user-scoped resource keys', async () => {
  const manifest = await buildOfflineManifest(makeMockDb(), user, {
    type: 'entry',
    entryId: 'entry-1',
  })

  assert.equal(manifest.protocolVersion, 1)
  assert.equal(manifest.ownerUserId, user.id)
  assert.equal(manifest.title, 'Practical Offline Systems')
  assert.equal(manifest.seriesTitle, 'Practical Offline Systems')
  assert.equal(manifest.estimatedBytes, 123456)
  assert.equal(manifest.resourceCount, 1)
  assert.equal(manifest.entries[0].resourceKeys[0], manifest.resources[0].key)

  const resource = manifest.resources[0]
  assert.equal(resource.kind, 'file')
  assert.equal(resource.entryId, 'entry-1')
  assert.equal(resource.contentType, 'application/pdf')
  assert.equal(resource.size, 123456)
  assert.match(resource.url, /^\/api\/offline\/manifests\/pkg_[a-f0-9]+\/resources\//)

  const decodedKey = decodeOfflineResourceKey(resource.key)
  assert.equal(decodedKey.k, 'file')
  assert.equal(decodedKey.e, 'entry-1')
  assert.equal(decodedKey.mv, '1781520000000-123456')
})

test('offline resource key parser rejects malformed keys', () => {
  assert.throws(() => decodeOfflineResourceKey('not-base64url-json'), /Invalid offline resource key/)
})
