import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePreferences } from './preferences'

test('stored preferences are validated field by field', () => {
  const preferences = normalizePreferences({
    language: 'de',
    theme: 'neon',
    text: { fontScale: 173, font: 'sans', spacing: 'relaxed', margins: 'huge', justify: 'yes' },
    tapLayout: 'forward',
    browseView: 'list',
  })

  assert.equal(preferences.language, 'de')
  assert.equal(preferences.theme, 'light')
  assert.equal(preferences.text.fontScale, 175)
  assert.equal(preferences.text.font, 'sans')
  assert.equal(preferences.text.spacing, 'relaxed')
  assert.equal(preferences.text.margins, 'normal')
  assert.equal(preferences.text.justify, false)
  assert.equal(preferences.tapLayout, 'forward')
  assert.equal(preferences.browseView, 'list')
})

test('text size stays within the supported range', () => {
  assert.equal(normalizePreferences({ text: { fontScale: 20 } }).text.fontScale, 70)
  assert.equal(normalizePreferences({ text: { fontScale: 900 } }).text.fontScale, 200)
})

test('broken storage falls back to defaults', () => {
  const preferences = normalizePreferences('not an object')

  assert.equal(preferences.text.fontScale, 100)
  assert.equal(preferences.tapLayout, 'sides')
})
