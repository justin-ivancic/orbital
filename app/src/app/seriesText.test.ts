import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bookmark, SeriesSummary } from '../appTypes'
import { de } from '../i18n/de'
import { en } from '../i18n/en'
import {
  creatorProfiles,
  entryDisplayTitle,
  entryLabel,
  entryUnitOf,
  formatUnitCount,
  seriesCreator,
  seriesDescription,
  seriesTopics,
  summarizeProgress,
  titleMeta,
} from './seriesText'

const series = (overrides: Partial<SeriesSummary> = {}): SeriesSummary => ({
  id: 'series-1',
  title: 'The Long Road',
  titleShort: 'The Long Road',
  category: 'manga',
  year: null,
  format: 'Manga',
  status: 'Ready',
  progressLabel: '',
  description: '',
  folder: '/media/manga/The Long Road',
  coverUrl: null,
  bannerUrl: null,
  coverSource: '',
  metadataSource: '',
  externalUrl: null,
  sourceName: null,
  sourceRole: null,
  genres: [],
  tags: [],
  stats: { fileCount: 10, lastScanAt: null },
  ...overrides,
})

const bookmark = (overrides: Partial<Bookmark> = {}): Bookmark => ({
  seriesId: 'series-1',
  category: 'manga',
  entryId: 'variant-4',
  entryIndex: 3,
  entryLabel: 'Chapter 04',
  entryTitle: 'Chapter 4',
  progress: '',
  cue: '',
  lastSeen: '2026-09-26T10:00:00.000Z',
  ...overrides,
})

test('entry titles drop the series name and a repeated label', () => {
  const parent = { title: 'The Long Road' }

  assert.equal(entryDisplayTitle({ label: 'Chapter 03', title: 'The Long Road - Chapter 3: Arrival' }, parent), 'Arrival')
  assert.equal(entryDisplayTitle({ label: 'Chapter 80', title: 'Vol. 08 Ch. 080 - The Cross' }, parent), 'The Cross')
  assert.equal(entryDisplayTitle({ label: 'Chapter 07', title: 'Chapter 7' }, parent), '')
  assert.equal(entryDisplayTitle({ label: 'Volume 02', title: 'Volume 02' }, parent), '')
})

test('entry labels lose zero padding and follow the language', () => {
  assert.equal(entryLabel('Chapter 007', en), 'Chapter 7')
  assert.equal(entryLabel('Volume 12', de), 'Band 12')
  assert.equal(entryLabel('Side story 02', de), 'Nebengeschichte 2')
  assert.equal(entryLabel('Prologue', de), 'Prolog')
})

test('series units come from the server or the loaded entries', () => {
  assert.equal(entryUnitOf(series({ entryUnit: 'volume' })), 'volume')
  assert.equal(entryUnitOf(series({ category: 'magazines' })), 'issue')
  assert.equal(formatUnitCount('volume', 3, de), '3 Bände')
  assert.equal(formatUnitCount('chapter', 1, en), '1 chapter')
  assert.equal(formatUnitCount('book', 4, en), '4 parts')
})

test('progress combines the chapter position and the page inside it', () => {
  const summary = summarizeProgress(bookmark(), series(), { page: 5, totalPages: 20, locationType: 'page' }, en)

  assert.equal(summary.where, 'Chapter 4 · p. 5 of 20')
  assert.equal(summary.remaining, '6 chapters')
  assert.ok(Math.abs(summary.ratio - (3 + 0.25) / 10) < 1e-9)
  assert.equal(summary.finished, false)
})

test('single books report pages or percentages and know when they are finished', () => {
  const book = series({ category: 'books', stats: { fileCount: 1, lastScanAt: null } })

  assert.equal(summarizeProgress(bookmark({ entryIndex: 0 }), book, { page: 0, locationType: 'percent' }, en).where, 'Started')
  assert.equal(summarizeProgress(bookmark({ entryIndex: 0 }), book, { page: 42, locationType: 'percent' }, de).where, '42 %')
  assert.equal(summarizeProgress(bookmark({ entryIndex: 0 }), book, { page: 100, locationType: 'percent' }, en).finished, true)
})

test('scanner placeholder descriptions are hidden and reveal the local author', () => {
  const book = series({ category: 'books', description: 'Local book file by Ada Lovelace.' })

  assert.equal(seriesDescription(book.description), '')
  assert.equal(seriesCreator(book), 'Ada Lovelace')
  assert.equal(seriesDescription('A quiet story about a harbour town.'), 'A quiet story about a harbour town.')
  assert.equal(titleMeta({ ...book, stats: { fileCount: 1, lastScanAt: null } }, en), 'Ada Lovelace')
})

test('topics skip generic scanner tags and the author', () => {
  const topics = seriesTopics(
    series({
      sourceName: 'Ada Lovelace',
      tags: ['Local book', 'Ada Lovelace', 'Mathematics'],
      genres: ['History', 'mathematics'],
    }),
  )

  assert.deepEqual(topics, ['History', 'Mathematics'])
})

test('creator profiles group titles by author', () => {
  const library = [
    series({ id: 'a', title: 'Second', sourceName: 'Ada Lovelace', year: 1843 }),
    series({ id: 'b', title: 'First', sourceName: 'ada lovelace', year: 1840, category: 'books' }),
    series({ id: 'c', title: 'Other', sourceName: 'Someone Else' }),
  ]
  const profile = creatorProfiles(library).get('ada-lovelace')

  assert.deepEqual(profile?.series.map((item) => item.id), ['b', 'a'])
  assert.deepEqual(profile?.categories, ['manga', 'books'])
})
