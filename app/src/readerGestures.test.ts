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

test('tap zones keep a centre area for the menu and mirror for right-to-left', async () => {
  const { resolveTapZone } = await import('./readerGestures')

  assert.equal(resolveTapZone(50, 500, 1000, 1000, 'sides', 'ltr'), 'back')
  assert.equal(resolveTapZone(950, 500, 1000, 1000, 'sides', 'ltr'), 'forward')
  assert.equal(resolveTapZone(500, 500, 1000, 1000, 'sides', 'ltr'), 'menu')
  assert.equal(resolveTapZone(500, 50, 1000, 1000, 'sides', 'ltr'), 'menu')
  assert.equal(resolveTapZone(50, 500, 1000, 1000, 'sides', 'rtl'), 'forward')
  assert.equal(resolveTapZone(950, 500, 1000, 1000, 'sides', 'rtl'), 'back')

  assert.equal(resolveTapZone(500, 500, 1000, 1000, 'forward', 'ltr'), 'menu')
  assert.equal(resolveTapZone(500, 50, 1000, 1000, 'forward', 'ltr'), 'forward')
  assert.equal(resolveTapZone(800, 500, 1000, 1000, 'forward', 'ltr'), 'forward')
  assert.equal(resolveTapZone(100, 900, 1000, 1000, 'forward', 'ltr'), 'back')
})
