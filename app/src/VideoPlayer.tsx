import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { EntryVariant, MediaTrackCollection } from './appTypes'

type VideoPlayerProps = {
  variant: EntryVariant
}

type EmbeddedTrackOption = {
  id: string
  index: number
  label: string
  note: string
}

type BrowserAudioTrackLike = {
  enabled: boolean
  id?: string
  label?: string
  language?: string
}

const originalAudioId = 'original-audio'
const subtitlesOffId = 'subtitles-off'
const embeddedAudioPrefix = 'embedded-audio-'
const embeddedSubtitlePrefix = 'embedded-subtitle-'
const japaneseAudioAliases = ['japanese', 'jpn', 'ja', 'jp']
const englishSubtitleAliases = ['english', 'eng']
const germanSubtitleAliases = ['german', 'deutsch', 'deu', 'ger']

const trackMatchesLanguage = (value: string, aliases: string[]) => {
  const normalizedValue = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  if (!normalizedValue) {
    return false
  }

  const words = normalizedValue.split(/\s+/)
  return aliases.some((alias) => words.includes(alias))
}

const selectPreferredAudioTrack = (
  tracks: MediaTrackCollection['audio'],
  embeddedTracks: EmbeddedTrackOption[],
) => {
  const preferredServerTrack = tracks.find((track) =>
    trackMatchesLanguage(`${track.label} ${track.note || ''}`, japaneseAudioAliases),
  )

  if (preferredServerTrack) {
    return preferredServerTrack.id
  }

  const preferredEmbeddedTrack = embeddedTracks.find((track) =>
    trackMatchesLanguage(`${track.label} ${track.note}`, japaneseAudioAliases),
  )

  if (preferredEmbeddedTrack) {
    return preferredEmbeddedTrack.id
  }

  return originalAudioId
}

const selectPreferredSubtitleTrack = (tracks: MediaTrackCollection['subtitles']) => {
  if (tracks.length === 0) {
    return null
  }

  const supportedTracks = tracks.filter((track) => track.supported)

  if (supportedTracks.length === 0) {
    return null
  }

  const preferredTrack =
    supportedTracks.find((track) =>
      trackMatchesLanguage(`${track.label} ${track.note || ''}`, englishSubtitleAliases),
    ) ||
    supportedTracks.find((track) =>
      trackMatchesLanguage(`${track.label} ${track.note || ''}`, germanSubtitleAliases),
    ) ||
    supportedTracks[0]

  return preferredTrack?.id || null
}

export function VideoPlayer({ variant }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const defaultEmbeddedAudioIndexRef = useRef<number | null>(null)
  const [tracksOpen, setTracksOpen] = useState(false)
  const [selectedAudioTrackId, setSelectedAudioTrackId] = useState(originalAudioId)
  const [audioSelectionTouched, setAudioSelectionTouched] = useState(false)
  const [selectedSubtitleTrackId, setSelectedSubtitleTrackId] = useState(subtitlesOffId)
  const [subtitleSelectionTouched, setSubtitleSelectionTouched] = useState(false)
  const [embeddedAudioTracks, setEmbeddedAudioTracks] = useState<EmbeddedTrackOption[]>([])
  const [embeddedSubtitleTracks, setEmbeddedSubtitleTracks] = useState<EmbeddedTrackOption[]>([])
  const [resolvedMediaTracks, setResolvedMediaTracks] = useState<MediaTrackCollection>(
    variant.mediaTracks ?? { audio: [], subtitles: [] },
  )
  const [tracksLoading, setTracksLoading] = useState(false)
  const progressStorageKey = `video-progress:${variant.id}`

  const mediaTracks = resolvedMediaTracks
  const audioTracks = mediaTracks.audio
  const subtitleTracks = mediaTracks.subtitles
  const hasServerEmbeddedTracks =
    audioTracks.some((track) => track.id.startsWith('embedded-')) ||
    subtitleTracks.some((track) => track.id.startsWith('embedded-'))

  const selectedAudioTrack = audioTracks.find((track) => track.id === selectedAudioTrackId) ?? null
  const selectedEmbeddedAudioTrack =
    embeddedAudioTracks.find((track) => track.id === selectedAudioTrackId) ?? null
  const supportedSubtitleTracks = useMemo(
    () => subtitleTracks.filter((track) => track.supported),
    [subtitleTracks],
  )
  const selectedEmbeddedSubtitleTrack =
    embeddedSubtitleTracks.find((track) => track.id === selectedSubtitleTrackId) ?? null

  useEffect(() => {
    setTracksOpen(false)
    setSelectedAudioTrackId(originalAudioId)
    setAudioSelectionTouched(false)
    setSelectedSubtitleTrackId(subtitlesOffId)
    setSubtitleSelectionTouched(false)
    setEmbeddedAudioTracks([])
    setEmbeddedSubtitleTracks([])
    defaultEmbeddedAudioIndexRef.current = null
    setResolvedMediaTracks(variant.mediaTracks ?? { audio: [], subtitles: [] })
  }, [variant.id, variant.mediaTracks])

  useEffect(() => {
    const video = videoRef.current

    if (!video || typeof window === 'undefined') {
      return
    }

    const restoreProgress = () => {
      const savedProgress = Number(window.sessionStorage.getItem(progressStorageKey) || 0)

      if (
        Number.isFinite(savedProgress) &&
        savedProgress > 5 &&
        (!Number.isFinite(video.duration) || savedProgress < video.duration - 8)
      ) {
        video.currentTime = savedProgress
      }
    }

    const saveProgress = () => {
      if (Number.isFinite(video.currentTime) && video.currentTime > 0) {
        window.sessionStorage.setItem(progressStorageKey, String(Math.floor(video.currentTime)))
      }
    }

    video.addEventListener('loadedmetadata', restoreProgress)
    video.addEventListener('timeupdate', saveProgress)
    video.addEventListener('pause', saveProgress)

    return () => {
      saveProgress()
      video.removeEventListener('loadedmetadata', restoreProgress)
      video.removeEventListener('timeupdate', saveProgress)
      video.removeEventListener('pause', saveProgress)
    }
  }, [progressStorageKey])

  useEffect(() => {
    let active = true
    setTracksLoading(true)

    void api
      .getEntryTracks(variant.id)
      .then((response) => {
        if (active) {
          setResolvedMediaTracks(response.mediaTracks)
        }
      })
      .catch(() => {
        if (active) {
          setResolvedMediaTracks(variant.mediaTracks ?? { audio: [], subtitles: [] })
        }
      })
      .finally(() => {
        if (active) {
          setTracksLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [variant.id, variant.mediaTracks])

  useEffect(() => {
    if (audioSelectionTouched) {
      return
    }

    const preferredTrackId = selectPreferredAudioTrack(audioTracks, embeddedAudioTracks)

    if (preferredTrackId !== selectedAudioTrackId) {
      setSelectedAudioTrackId(preferredTrackId)
    }
  }, [audioSelectionTouched, audioTracks, embeddedAudioTracks, selectedAudioTrackId])

  useEffect(() => {
    if (subtitleSelectionTouched || selectedSubtitleTrackId !== subtitlesOffId) {
      return
    }

    const preferredTrackId = selectPreferredSubtitleTrack(supportedSubtitleTracks)

    if (preferredTrackId) {
      setSelectedSubtitleTrackId(preferredTrackId)
    }
  }, [selectedSubtitleTrackId, subtitleSelectionTouched, supportedSubtitleTracks])

  useEffect(() => {
    if (hasServerEmbeddedTracks) {
      setEmbeddedAudioTracks([])
      setEmbeddedSubtitleTracks([])
      return
    }

    const video = videoRef.current as (HTMLVideoElement & {
      audioTracks?: ArrayLike<BrowserAudioTrackLike>
    }) | null

    if (!video) {
      return
    }

    const inspectEmbeddedTracks = () => {
      const nextAudioTracks = Array.from(video.audioTracks ?? [])
      const enabledAudioIndex = nextAudioTracks.findIndex((track) => track.enabled)

      if (enabledAudioIndex >= 0 && defaultEmbeddedAudioIndexRef.current == null) {
        defaultEmbeddedAudioIndexRef.current = enabledAudioIndex
      }

      setEmbeddedAudioTracks(
        nextAudioTracks.length > 1
          ? nextAudioTracks.map((track, index) => ({
              id: `${embeddedAudioPrefix}${index}`,
              index,
              label:
                track.label?.trim() ||
                track.language?.trim().toUpperCase() ||
                `Embedded audio ${index + 1}`,
              note: track.language
                ? `Embedded browser track • ${track.language.toUpperCase()}`
                : 'Embedded browser track',
            }))
          : [],
      )

      const sidecarTrackLabels = new Set(
        supportedSubtitleTracks.map((track) => `${track.label} (${track.format})`.trim().toLowerCase()),
      )
      const nextEmbeddedSubtitleTracks = Array.from(video.textTracks)
        .map((track, index) => ({
          track,
          index,
        }))
        .filter(({ track }) => {
          const normalizedLabel = track.label.trim().toLowerCase()
          return !sidecarTrackLabels.has(normalizedLabel)
        })
        .map(({ track, index }) => ({
          id: `${embeddedSubtitlePrefix}${index}`,
          index,
          label:
            track.label?.trim() ||
            track.language?.trim().toUpperCase() ||
            `Embedded subtitles ${index + 1}`,
          note: track.language
            ? `Embedded browser track • ${track.language.toUpperCase()}`
            : 'Embedded browser track',
        }))

      setEmbeddedSubtitleTracks(nextEmbeddedSubtitleTracks)
    }

    inspectEmbeddedTracks()
    video.addEventListener('loadedmetadata', inspectEmbeddedTracks)

    return () => {
      video.removeEventListener('loadedmetadata', inspectEmbeddedTracks)
    }
  }, [hasServerEmbeddedTracks, supportedSubtitleTracks, variant.id])

  useEffect(() => {
    const video = videoRef.current as (HTMLVideoElement & {
      audioTracks?: ArrayLike<BrowserAudioTrackLike>
    }) | null
    const audio = audioRef.current

    if (!video || !audio) {
      return
    }

    if (!selectedAudioTrack) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      video.muted = false

      const browserAudioTracks = Array.from(video.audioTracks ?? [])
      if (browserAudioTracks.length > 0) {
        const targetIndex =
          selectedEmbeddedAudioTrack?.index ??
          defaultEmbeddedAudioIndexRef.current ??
          browserAudioTracks.findIndex((track) => track.enabled) ??
          0

        browserAudioTracks.forEach((track, index) => {
          track.enabled = index === Math.max(targetIndex, 0)
        })
      }

      return
    }

    if (audio.src !== new URL(selectedAudioTrack.url, window.location.origin).toString()) {
      audio.src = selectedAudioTrack.url
    }

    video.muted = true
    audio.volume = video.volume
    audio.playbackRate = video.playbackRate

    const syncCurrentTime = () => {
      if (Math.abs(audio.currentTime - video.currentTime) > 0.35) {
        audio.currentTime = video.currentTime
      }
    }

    const handlePlay = () => {
      syncCurrentTime()
      void audio.play().catch(() => undefined)
    }

    const handlePause = () => {
      audio.pause()
    }

    const handleSeeking = () => {
      syncCurrentTime()
    }

    const handleRateChange = () => {
      audio.playbackRate = video.playbackRate
    }

    const handleVolumeChange = () => {
      audio.volume = video.volume
    }

    const handleEnded = () => {
      audio.pause()
      audio.currentTime = 0
    }

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('seeking', handleSeeking)
    video.addEventListener('seeked', handleSeeking)
    video.addEventListener('ratechange', handleRateChange)
    video.addEventListener('volumechange', handleVolumeChange)
    video.addEventListener('ended', handleEnded)

    if (!video.paused) {
      handlePlay()
    }

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('seeking', handleSeeking)
      video.removeEventListener('seeked', handleSeeking)
      video.removeEventListener('ratechange', handleRateChange)
      video.removeEventListener('volumechange', handleVolumeChange)
      video.removeEventListener('ended', handleEnded)
      audio.pause()
    }
  }, [selectedAudioTrack, selectedEmbeddedAudioTrack])

  useEffect(() => {
    const video = videoRef.current

    if (!video) {
      return
    }

    const applySubtitleSelection = () => {
      const tracks = Array.from(video.textTracks)
      tracks.forEach((track) => {
        track.mode = 'disabled'
      })

      const sidecarIndex = supportedSubtitleTracks.findIndex(
        (track) => track.id === selectedSubtitleTrackId,
      )

      if (sidecarIndex >= 0 && tracks[sidecarIndex]) {
        tracks[sidecarIndex].mode = 'showing'
        return
      }

      if (selectedEmbeddedSubtitleTrack && tracks[selectedEmbeddedSubtitleTrack.index]) {
        tracks[selectedEmbeddedSubtitleTrack.index].mode = 'showing'
      }
    }

    applySubtitleSelection()
    video.addEventListener('loadedmetadata', applySubtitleSelection)

    return () => {
      video.removeEventListener('loadedmetadata', applySubtitleSelection)
    }
  }, [selectedEmbeddedSubtitleTrack, selectedSubtitleTrackId, supportedSubtitleTracks, variant.id])

  const hasTrackChoices =
    audioTracks.length > 0 ||
    subtitleTracks.length > 0 ||
    embeddedAudioTracks.length > 0 ||
    embeddedSubtitleTracks.length > 0
  const selectedAudioLabel =
    selectedAudioTrack?.label || selectedEmbeddedAudioTrack?.label || 'Original audio'
  const selectedSubtitleLabel =
    selectedSubtitleTrackId === subtitlesOffId
      ? 'Off'
      : subtitleTracks.find((track) => track.id === selectedSubtitleTrackId)?.label ||
        selectedEmbeddedSubtitleTrack?.label ||
        'Off'

  return (
    <article className="player-card">
      <video
        className="player-screen player-screen--video"
        controls
        playsInline
        preload="metadata"
        ref={videoRef}
        src={variant.fileUrl}
      >
        {supportedSubtitleTracks.map((track) => (
          <track
            default={false}
            key={track.id}
            kind="subtitles"
            label={`${track.label} (${track.format})`}
            src={track.url}
          />
        ))}
      </video>
      <audio aria-hidden="true" preload="metadata" ref={audioRef} />
      <div className="player-controls">
        <span>{variant.details}</span>
        <span>{variant.storageFile}</span>
      </div>

      <div className="player-track-bar">
        <button
          aria-expanded={tracksOpen}
          className="ghost-button player-track-bar__trigger"
          onClick={() => setTracksOpen((currentOpen) => !currentOpen)}
          type="button"
        >
          Audio & subtitles
        </button>
        {!hasTrackChoices && (
          <span className="player-track-bar__hint">
            {tracksLoading
              ? 'Checking embedded and sidecar tracks for this video…'
              : 'Sidecar and embedded audio or subtitle tracks will appear here when available.'}
          </span>
        )}
      </div>

      {tracksOpen && (
        <div className="player-track-panel">
          <section className="player-track-group">
            <div className="player-track-group__header">
              <strong>Audio</strong>
              <span>{selectedAudioLabel}</span>
            </div>
            <div className="player-track-options">
              <TrackOptionButton
                active={!selectedAudioTrack && !selectedEmbeddedAudioTrack}
                label="Original audio"
                note="Use the embedded audio from the video file."
                onClick={() => {
                  setAudioSelectionTouched(true)
                  setSelectedAudioTrackId(originalAudioId)
                }}
              />
              {audioTracks.length > 0 &&
                audioTracks.map((track) => (
                  <TrackOptionButton
                    active={track.id === selectedAudioTrackId}
                    disabled={!track.supported}
                    key={track.id}
                    label={track.label}
                    note={track.note || `${track.format} • ${track.fileName}`}
                    onClick={() => {
                      setAudioSelectionTouched(true)
                      setSelectedAudioTrackId(track.id)
                    }}
                  />
                ))
              }
              {embeddedAudioTracks.map((track) => (
                <TrackOptionButton
                  active={track.id === selectedAudioTrackId}
                  key={track.id}
                  label={track.label}
                  note={track.note}
                  onClick={() => {
                    setAudioSelectionTouched(true)
                    setSelectedAudioTrackId(track.id)
                  }}
                />
              ))}
              {audioTracks.length === 0 && embeddedAudioTracks.length === 0 && (
                <p className="player-track-group__empty">
                  {tracksLoading
                    ? 'Checking the video container for audio tracks…'
                    : 'No alternate audio files or embedded tracks found for this video yet.'}
                </p>
              )}
            </div>
          </section>

          <section className="player-track-group">
            <div className="player-track-group__header">
              <strong>Subtitles</strong>
              <span>{selectedSubtitleLabel}</span>
            </div>
            <div className="player-track-options">
              <TrackOptionButton
                active={selectedSubtitleTrackId === subtitlesOffId}
                label="No subtitles"
                note="Keep the player clean."
                onClick={() => {
                  setSubtitleSelectionTouched(true)
                  setSelectedSubtitleTrackId(subtitlesOffId)
                }}
              />
              {subtitleTracks.length > 0 &&
                subtitleTracks.map((track) => (
                  <TrackOptionButton
                    active={track.id === selectedSubtitleTrackId}
                    disabled={!track.supported}
                    key={track.id}
                    label={track.label}
                    note={track.note || `${track.format} • ${track.fileName}`}
                    onClick={() => {
                      setSubtitleSelectionTouched(true)
                      setSelectedSubtitleTrackId(track.id)
                    }}
                  />
                ))
              }
              {embeddedSubtitleTracks.map((track) => (
                <TrackOptionButton
                  active={track.id === selectedSubtitleTrackId}
                  key={track.id}
                  label={track.label}
                  note={track.note}
                  onClick={() => {
                    setSubtitleSelectionTouched(true)
                    setSelectedSubtitleTrackId(track.id)
                  }}
                />
              ))}
              {subtitleTracks.length === 0 && embeddedSubtitleTracks.length === 0 && (
                <p className="player-track-group__empty">
                  {tracksLoading
                    ? 'Checking the video container for subtitle tracks…'
                    : 'No subtitle files or embedded tracks found for this video yet.'}
                </p>
              )}
            </div>
          </section>
        </div>
      )}
    </article>
  )
}

type TrackOptionButtonProps = {
  active: boolean
  disabled?: boolean
  label: string
  note: string
  onClick: () => void
}

function TrackOptionButton({
  active,
  disabled = false,
  label,
  note,
  onClick,
}: TrackOptionButtonProps) {
  return (
    <button
      className={`player-track-option ${active ? 'is-active' : ''}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="player-track-option__label">{label}</span>
      <span className="player-track-option__note">{note}</span>
    </button>
  )
}
