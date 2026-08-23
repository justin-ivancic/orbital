import assert from 'node:assert/strict'
import test from 'node:test'
import { getOfflineResourceStorageKey } from './offlineStorageKeys'

test('offline resource storage keys keep identical resources isolated by package', () => {
  const resourceKey = 'shared-resource'

  assert.notEqual(
    getOfflineResourceStorageKey('package-a', resourceKey),
    getOfflineResourceStorageKey('package-b', resourceKey),
  )
  assert.equal(
    getOfflineResourceStorageKey('package-a', resourceKey),
    getOfflineResourceStorageKey('package-a', resourceKey),
  )
})
