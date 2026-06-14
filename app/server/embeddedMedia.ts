import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Database } from 'better-sqlite3'
import ffmpegPath from 'ffmpeg-static'
// @ts-expect-error ffprobe-static ships without TypeScript types.
import ffprobeStatic from 'ffprobe-static'
import type { MediaTrackCollection, MediaTrackKind, MediaTrackOption } from '../src/appTypes.ts'
import { fileExists } from './database'
import { compactWhitespace } from './utils'

const execFileAsync = promisify(execFile)

type ProbeDisposition = {
  default?: number
  forced?: number
}

type ProbeStream = {
  index: number
  codec_type: 'audio' | 'subtitle' | string
  codec_name?: string
  tags?: {
    language?: string
    title?: string
  }
  disposition?: ProbeDisposition
}

type ProbePayload = {
  streams?: ProbeStream[]
}

type CachedProbe = {
  mtimeMs: number
  tracks: MediaTrackCollection
}

type EmbeddedTrackResolution = {
  filePath: string
  streamIndex: number
  kind: MediaTrackKind
  format: string
  supported: boolean
}

const probeCache = new Map<string, CachedProbe>()
const unsupportedSubtitleCodecs = new Set([
  'dvd_subtitle',
  'dvb_subtitle',
  'hdmv_pgs_subtitle',
  'xsub',
  'pgssub',
])

const trackLanguageAliases: Record<string, string> = {
  en: 'English',
  eng: 'English',
  de: 'German',
  ger: 'German',
  deu: 'German',
  ja: 'Japanese',
  jpn: 'Japanese',
  jp: 'Japanese',
  es: 'Spanish',
  spa: 'Spanish',
  fr: 'French',
  fre: 'French',
  fra: 'French',
  it: 'Italian',
  ita: 'Italian',
  pt: 'Portuguese',
  por: 'Portuguese',
  zh: 'Chinese',
  zho: 'Chinese',
  chi: 'Chinese',
}

const buildEmbeddedTrackId = (kind: MediaTrackKind, streamIndex: number) =>
  `embedded-${kind}-${streamIndex}`

const parseEmbeddedTrackId = (kind: MediaTrackKind, trackId: string) => {
  const match = trackId.match(/^embedded-(audio|subtitle)-(\d+)$/)

  if (!match || match[1] !== kind) {
    throw new Error('Requested embedded track was not found.')
  }

  return Number(match[2])
}

const humanizeLanguage = (value?: string) => {
  if (!value) {
    return null
  }

  const normalized = value.trim().toLowerCase()
  return trackLanguageAliases[normalized] || normalized.toUpperCase()
}

const toTrackFormat = (codecName?: string) => (codecName ? codecName.toUpperCase() : 'EMBEDDED')

const buildTrackLabel = (stream: ProbeStream, fallback: string) => {
  const title = compactWhitespace(stream.tags?.title || '')
  const language = humanizeLanguage(stream.tags?.language)
  const normalizedTitle = title.toLowerCase()
  const normalizedLanguage = language?.toLowerCase() || null

  if (title && language && normalizedTitle !== normalizedLanguage) {
    return `${language} • ${title}`
  }

  if (title) {
    return title
  }

  if (language) {
    return language
  }

  return fallback
}

const buildTrackNote = (kind: MediaTrackKind, stream: ProbeStream, supported: boolean) => {
  const parts = [
    kind === 'audio' ? 'Embedded audio' : 'Embedded subtitles',
    toTrackFormat(stream.codec_name),
  ]

  if (stream.disposition?.default) {
    parts.push('Default')
  }

  if (stream.disposition?.forced) {
    parts.push('Forced')
  }

  if (!supported) {
    parts.push('Not browser-compatible yet')
  }

  return parts.join(' • ')
}

const getEntryFilePath = (db: Database, entryId: string) => {
  const entry = db
    .prepare(`SELECT file_path, format FROM entries WHERE id = ? LIMIT 1`)
    .get(entryId) as { file_path: string; format: string } | undefined

  if (!entry || entry.format !== 'video' || !fileExists(entry.file_path)) {
    throw new Error('Requested media file was not found.')
  }

  return entry.file_path
}

const probeFileTracks = async (filePath: string): Promise<MediaTrackCollection> => {
  if (!fileExists(filePath)) {
    return { audio: [], subtitles: [] }
  }

  const stats = await fs.promises.stat(filePath)
  const cachedProbe = probeCache.get(filePath)

  if (cachedProbe && cachedProbe.mtimeMs === stats.mtimeMs) {
    return cachedProbe.tracks
  }

  const probePath = ffprobeStatic.path as string | undefined
  if (!probePath) {
    return { audio: [], subtitles: [] }
  }

  const { stdout } = await execFileAsync(probePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    filePath,
  ])

  const payload = JSON.parse(stdout) as ProbePayload
  const streams = payload.streams ?? []
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio')
  const subtitleStreams = streams.filter((stream) => stream.codec_type === 'subtitle')

  const defaultAudioStreamIndex =
    audioStreams.find((stream) => stream.disposition?.default)?.index ?? audioStreams[0]?.index ?? null

  const tracks: MediaTrackCollection = {
    audio: audioStreams
      .filter((stream) => audioStreams.length > 1 && stream.index !== defaultAudioStreamIndex)
      .map(
        (stream): MediaTrackOption => ({
          id: buildEmbeddedTrackId('audio', stream.index),
          kind: 'audio',
          label: buildTrackLabel(stream, `Embedded audio ${stream.index}`),
          fileName: `embedded-audio-${stream.index}`,
          format: toTrackFormat(stream.codec_name),
          url: '',
          supported: true,
          note: buildTrackNote('audio', stream, true),
        }),
      ),
    subtitles: subtitleStreams.map(
      (stream): MediaTrackOption => {
        const supported = !unsupportedSubtitleCodecs.has((stream.codec_name || '').toLowerCase())
        return {
          id: buildEmbeddedTrackId('subtitle', stream.index),
          kind: 'subtitle',
          label: buildTrackLabel(stream, `Embedded subtitles ${stream.index}`),
          fileName: `embedded-subtitle-${stream.index}`,
          format: toTrackFormat(stream.codec_name),
          url: '',
          supported,
          note: buildTrackNote('subtitle', stream, supported),
        }
      },
    ),
  }

  probeCache.set(filePath, {
    mtimeMs: stats.mtimeMs,
    tracks,
  })

  return tracks
}

export const getEntryEmbeddedMediaTracks = async (
  db: Database,
  entryId: string,
): Promise<MediaTrackCollection> => {
  const filePath = getEntryFilePath(db, entryId)
  const tracks = await probeFileTracks(filePath)

  return {
    audio: tracks.audio.map((track) => ({
      ...track,
      url: `/api/media/track/${entryId}/audio/${track.id}`,
    })),
    subtitles: tracks.subtitles.map((track) => ({
      ...track,
      url: `/api/media/track/${entryId}/subtitle/${track.id}`,
    })),
  }
}

const resolveEmbeddedTrack = async (
  db: Database,
  entryId: string,
  kind: MediaTrackKind,
  trackId: string,
): Promise<EmbeddedTrackResolution> => {
  const filePath = getEntryFilePath(db, entryId)
  const streamIndex = parseEmbeddedTrackId(kind, trackId)
  const tracks = await probeFileTracks(filePath)
  const matchingTrack = (kind === 'audio' ? tracks.audio : tracks.subtitles).find(
    (track) => track.id === trackId,
  )

  if (!matchingTrack) {
    throw new Error('Requested embedded track was not found.')
  }

  return {
    filePath,
    streamIndex,
    kind,
    format: matchingTrack.format,
    supported: matchingTrack.supported,
  }
}

export const streamEmbeddedAudioTrack = async (
  db: Database,
  entryId: string,
  trackId: string,
): Promise<{
  process: ChildProcessWithoutNullStreams
  contentType: string
}> => {
  const resolution = await resolveEmbeddedTrack(db, entryId, 'audio', trackId)

  const process = spawn(ffmpegPath as string, [
    '-v',
    'error',
    '-i',
    resolution.filePath,
    '-map',
    `0:${resolution.streamIndex}`,
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-f',
    'adts',
    'pipe:1',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return {
    process,
    contentType: 'audio/aac',
  }
}

export const renderEmbeddedSubtitleTrack = async (
  db: Database,
  entryId: string,
  trackId: string,
) => {
  const resolution = await resolveEmbeddedTrack(db, entryId, 'subtitle', trackId)

  if (!resolution.supported) {
    throw new Error('This embedded subtitle track is not browser-compatible yet.')
  }

  const { stdout } = await execFileAsync(ffmpegPath as string, [
    '-v',
    'error',
    '-i',
    resolution.filePath,
    '-map',
    `0:${resolution.streamIndex}`,
    '-f',
    'webvtt',
    'pipe:1',
  ], {
    maxBuffer: 24 * 1024 * 1024,
  })

  return stdout.startsWith('WEBVTT') ? stdout : `WEBVTT\n\n${stdout.trim()}`
}
