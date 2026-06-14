import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildVersionedMediaPath,
  getRequestedMediaVersion,
  isCurrentMediaVersion,
  isStaleMediaVersion,
} from './mediaVersion.ts'

test('media version helpers distinguish missing, current, and stale requests', () => {
  assert.equal(getRequestedMediaVersion({ v: ' 123-456 ' }), '123-456')
  assert.equal(isStaleMediaVersion({}, '123-456'), false)
  assert.equal(isStaleMediaVersion({ v: '123-456' }, '123-456'), false)
  assert.equal(isStaleMediaVersion({ v: '122-456' }, '123-456'), true)
  assert.equal(isCurrentMediaVersion({ v: '123-456' }, '123-456'), true)
})

test('versioned media redirects preserve the path and replace only the version', () => {
  assert.equal(
    buildVersionedMediaPath('/api/media/cbz/entry/pages/2?foo=bar&v=old', '123-456'),
    '/api/media/cbz/entry/pages/2?foo=bar&v=123-456',
  )
})
