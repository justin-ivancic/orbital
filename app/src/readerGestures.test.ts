import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePagedSwipeAction } from './readerGestures.ts'

test('maps horizontal page swipes to the reading direction', () => {
  assert.equal(resolvePagedSwipeAction(-100, 5, 'ltr'), 'next')
  assert.equal(resolvePagedSwipeAction(100, 5, 'ltr'), 'previous')
  assert.equal(resolvePagedSwipeAction(100, 5, 'rtl'), 'next')
  assert.equal(resolvePagedSwipeAction(-100, 5, 'rtl'), 'previous')
})

test('ignores short and mostly vertical gestures', () => {
  assert.equal(resolvePagedSwipeAction(-40, 0, 'ltr'), null)
  assert.equal(resolvePagedSwipeAction(-100, 90, 'ltr'), null)
})
