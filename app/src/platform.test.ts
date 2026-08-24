import assert from 'node:assert/strict'
import test from 'node:test'
import { isLocalAppResourceUrl } from './platform.ts'

test('recognizes Android WebView file URLs as local offline resources', () => {
  assert.equal(
    isLocalAppResourceUrl('https://localhost/_capacitor_file_/data/user/0/orbital/chapter.txt'),
    true,
  )
  assert.equal(
    isLocalAppResourceUrl('http://localhost/_capacitor_file_/data/user/0/orbital/page.webp'),
    true,
  )
  assert.equal(isLocalAppResourceUrl('capacitor://localhost/_capacitor_file_/book.epub'), true)
  assert.equal(isLocalAppResourceUrl('file:///data/user/0/orbital/book.pdf'), true)
  assert.equal(isLocalAppResourceUrl('/__orbital_offline/resource-key'), true)
})

test('does not misclassify server media as a local offline resource', () => {
  assert.equal(isLocalAppResourceUrl('https://library.justinivancic.com/api/media/file/entry'), false)
  assert.equal(isLocalAppResourceUrl('/api/media/file/entry'), false)
})
