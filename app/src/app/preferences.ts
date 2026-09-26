import type { Language } from '../appTypes'
import { createStore } from './store'

export type ThemeMode = 'system' | 'light' | 'dark'
export type TextFont = 'publisher' | 'serif' | 'sans'
export type TextSpacing = 'compact' | 'normal' | 'relaxed'
export type TextMargins = 'narrow' | 'normal' | 'wide'
export type TapLayout = 'sides' | 'forward'
export type BrowseView = 'grid' | 'list'

/** Typography for text books (EPUB, HTML chapters, text files) on this device. */
export type TextStyle = {
  /** Percentage of the base reading size. */
  fontScale: number
  font: TextFont
  spacing: TextSpacing
  margins: TextMargins
  justify: boolean
}

export type DevicePreferences = {
  language: Language
  theme: ThemeMode
  text: TextStyle
  /**
   * `sides`: the left edge goes back, the right edge goes forward.
   * `forward`: only the left third goes back; the rest of the page goes forward.
   */
  tapLayout: TapLayout
  browseView: BrowseView
}

export const minFontScale = 70
export const maxFontScale = 200
export const fontScaleStep = 10

const storageKey = 'orbital:preferences:v1'

const detectLanguage = (): Language => {
  if (typeof navigator === 'undefined') {
    return 'en'
  }

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  return languages.some((language) => language?.toLowerCase().startsWith('de')) ? 'de' : 'en'
}

export const defaultTextStyle: TextStyle = {
  fontScale: 100,
  font: 'serif',
  spacing: 'normal',
  margins: 'normal',
  justify: false,
}

const defaultPreferences = (): DevicePreferences => ({
  language: detectLanguage(),
  theme: 'light',
  text: defaultTextStyle,
  tapLayout: 'sides',
  browseView: 'grid',
})

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback

const clampFontScale = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maxFontScale, Math.max(minFontScale, Math.round(value / 5) * 5))
    : fallback

export const normalizePreferences = (value: unknown): DevicePreferences => {
  const fallback = defaultPreferences()

  if (!value || typeof value !== 'object') {
    return fallback
  }

  const candidate = value as Partial<Record<keyof DevicePreferences, unknown>>
  const text = (candidate.text && typeof candidate.text === 'object'
    ? candidate.text
    : {}) as Partial<Record<keyof TextStyle, unknown>>

  return {
    language: oneOf(candidate.language, ['en', 'de'] as const, fallback.language),
    theme: oneOf(candidate.theme, ['system', 'light', 'dark'] as const, fallback.theme),
    text: {
      fontScale: clampFontScale(text.fontScale, fallback.text.fontScale),
      font: oneOf(text.font, ['publisher', 'serif', 'sans'] as const, fallback.text.font),
      spacing: oneOf(text.spacing, ['compact', 'normal', 'relaxed'] as const, fallback.text.spacing),
      margins: oneOf(text.margins, ['narrow', 'normal', 'wide'] as const, fallback.text.margins),
      justify: typeof text.justify === 'boolean' ? text.justify : fallback.text.justify,
    },
    tapLayout: oneOf(candidate.tapLayout, ['sides', 'forward'] as const, fallback.tapLayout),
    browseView: oneOf(candidate.browseView, ['grid', 'list'] as const, fallback.browseView),
  }
}

const readPreferences = () => {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(storageKey)
    return normalizePreferences(raw ? JSON.parse(raw) : null)
  } catch {
    return defaultPreferences()
  }
}

export const preferencesStore = createStore<DevicePreferences>(readPreferences())

preferencesStore.subscribe(() => {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(preferencesStore.get()))
  } catch {
    // Preferences still apply for this session when storage is unavailable.
  }
})

export const setPreference = <K extends keyof DevicePreferences>(key: K, value: DevicePreferences[K]) => {
  preferencesStore.update({ [key]: value } as Partial<DevicePreferences>)
}

export const setTextStyle = (patch: Partial<TextStyle>) => {
  preferencesStore.set((previous) => ({
    ...previous,
    text: normalizePreferences({ ...previous, text: { ...previous.text, ...patch } }).text,
  }))
}
