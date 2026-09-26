import type { Language } from '../appTypes'
import { preferencesStore } from '../app/preferences'
import { useStore } from '../app/store'
import { de } from './de'
import { en, type Strings } from './en'

export type { Strings }

const catalogs: Record<Language, Strings> = { en, de }

export const stringsFor = (language: Language) => catalogs[language] ?? en

export const currentStrings = () => stringsFor(preferencesStore.get().language)

const selectLanguage = (state: { language: Language }) => state.language

export const useLanguage = () => useStore(preferencesStore, selectLanguage)

export const useT = () => stringsFor(useLanguage())

const unitThresholds: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.35],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
]

/** "3 hours ago" / "vor 3 Stunden". `now` is passed in so rendering stays pure. */
export const formatRelative = (value: string | number | null | undefined, strings: Strings, now: number) => {
  if (value == null || value === '') {
    return strings.common.never
  }

  const timestamp = typeof value === 'number' ? value : Date.parse(value)

  if (!Number.isFinite(timestamp)) {
    return strings.common.never
  }

  let delta = (timestamp - now) / 1000

  if (Math.abs(delta) < 45) {
    return strings.time.justNow
  }

  const formatter = new Intl.RelativeTimeFormat(strings.locale, { numeric: 'auto' })

  for (const [unit, size] of unitThresholds) {
    if (Math.abs(delta) < size) {
      return formatter.format(Math.round(delta), unit)
    }

    delta /= size
  }

  return formatter.format(Math.round(delta), 'year')
}

export const formatDate = (value: string | null | undefined, strings: Strings) => {
  const timestamp = value ? Date.parse(value) : Number.NaN

  if (!Number.isFinite(timestamp)) {
    return strings.common.unknown
  }

  return new Intl.DateTimeFormat(strings.locale, { dateStyle: 'medium' }).format(timestamp)
}

export const formatDateTime = (value: string | null | undefined, strings: Strings) => {
  const timestamp = value ? Date.parse(value) : Number.NaN

  if (!Number.isFinite(timestamp)) {
    return strings.common.unknown
  }

  return new Intl.DateTimeFormat(strings.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}

export const formatBytes = (value: number | null | undefined, strings: Strings) => {
  if (value == null || !Number.isFinite(value) || value < 0) {
    return strings.common.unknown
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  const formatter = new Intl.NumberFormat(strings.locale, {
    maximumFractionDigits: unitIndex === 0 || size >= 100 ? 0 : 1,
  })

  return `${formatter.format(size)} ${units[unitIndex]}`
}

export const formatNumber = (value: number, strings: Strings) =>
  new Intl.NumberFormat(strings.locale).format(value)
