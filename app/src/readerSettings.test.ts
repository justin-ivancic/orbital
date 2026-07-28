import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compatibleReadingStyles,
  defaultReaderSettings,
  migrateLegacyCbzSettings,
  normalizeReaderSettings,
  readerSettingsForStyle,
  settingsForFormat,
} from './readerSettings'

test('uses medium-aware defaults without tying behavior to a file extension alone', () => {
  assert.equal(defaultReaderSettings('manga', 'pdf').style, 'manga')
  assert.equal(defaultReaderSettings('books', 'pdf').style, 'book')
  assert.equal(defaultReaderSettings('novels', 'epub').style, 'text')
  assert.equal(defaultReaderSettings('books', 'epub').layout, 'paged')
})

test('exposes only reading styles that the renderer can honor', () => {
  assert.deepEqual(compatibleReadingStyles('cbz'), ['book', 'manga', 'webtoon'])
  assert.deepEqual(compatibleReadingStyles('epub'), ['text', 'book'])
})

test('normalizes untrusted persisted settings against a complete safe fallback', () => {
  const fallback = readerSettingsForStyle('manga')
  const normalized = normalizeReaderSettings(
    {
      style: 'manga',
      layout: 'paged',
      viewMode: 'spread',
      direction: 'sideways',
      zoom: 9_999,
      fontSize: 10,
    },
    fallback,
  )

  assert.equal(normalized.viewMode, 'spread')
  assert.equal(normalized.direction, 'rtl')
  assert.equal(normalized.zoom, 200)
  assert.equal(normalized.fontSize, 80)
})

test('forces webtoons and reflowable text into compatible rendering settings', () => {
  const webtoon = settingsForFormat(readerSettingsForStyle('webtoon'), 'manga', 'cbz')
  const text = settingsForFormat(readerSettingsForStyle('manga'), 'novels', 'html')

  assert.equal(webtoon.layout, 'continuous')
  assert.equal(webtoon.viewMode, 'single')
  assert.equal(text.style, 'text')
  assert.equal(text.viewMode, 'single')
})

test('migrates the previous device-local CBZ settings into the shared model', () => {
  const fallback = readerSettingsForStyle('manga')
  const migrated = migrateLegacyCbzSettings(
    {
      readingDirection: 'ltr',
      pageOrderMode: 'filename',
      spreadAlignment: 'straight-pairs',
      scaleMode: 'fit-width',
    },
    fallback,
  )

  assert.equal(migrated?.direction, 'ltr')
  assert.equal(migrated?.pageOrder, 'filename')
  assert.equal(migrated?.spreadAlignment, 'straight-pairs')
  assert.equal(migrated?.fitMode, 'fit-width')
})
