import { Minus, Plus } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { EntryFormat, ReaderSettings, ReadingStyle } from '../appTypes'
import type { TextStyle } from '../app/preferences'
import { compatibleReadingStyles, readerSettingsForStyle } from '../readerSettings'
import { useT } from '../i18n'
import { Segmented } from '../ui/bits'
import { Sheet } from '../ui/Sheet'
import { SettingRow, TextSettingsControls } from './TextSettingsControls'

type DisplaySheetProps = {
  format: EntryFormat
  settings: ReaderSettings
  textStyle: TextStyle
  onSettings: (settings: ReaderSettings) => void
  onClose: () => void
}

const imageFormats = new Set<EntryFormat>(['cbz', 'pdf'])
const textFormats = new Set<EntryFormat>(['epub', 'html', 'md', 'txt'])

/** Reading settings: typography for text, page layout for comics and PDFs. */
export function DisplaySheet({ format, settings, textStyle, onSettings, onClose }: DisplaySheetProps) {
  const t = useT()
  const s = t.reader.settings
  const isImage = imageFormats.has(format)
  const isText = textFormats.has(format)
  const styles = compatibleReadingStyles(format)
  const update = (patch: Partial<ReaderSettings>) => onSettings({ ...settings, ...patch })
  const styleLabels: Record<ReadingStyle, string> = {
    book: s.styleBook,
    manga: s.styleManga,
    webtoon: s.styleWebtoon,
    text: s.styleText,
  }

  return (
    <Sheet onClose={onClose} title={s.title}>
      {isText && (
        <section className="stack" style={{ '--stack-gap': 'var(--space-3)' } as CSSProperties}>
          <h3 className="kicker">{s.text}</h3>
          <TextSettingsControls allowPublisherFont={format === 'epub'} textStyle={textStyle} />
          <p className="text-muted text-small">{s.deviceNote}</p>
        </section>
      )}

      <section className="stack" style={{ '--stack-gap': 'var(--space-3)' } as CSSProperties}>
        {isImage && <h3 className="kicker">{s.layout}</h3>}
        {isImage && styles.length > 1 && (
          <SettingRow label={s.style}>
            <Segmented
              block
              label={s.style}
              onChange={(style) => onSettings(readerSettingsForStyle(style, settings))}
              options={styles.map((style) => ({ value: style, label: styleLabels[style] }))}
              value={settings.style}
            />
          </SettingRow>
        )}
        <SettingRow label={s.layout}>
          <Segmented
            block
            label={s.layout}
            onChange={(layout) => update({ layout })}
            options={[
              { value: 'paged', label: s.layoutPaged },
              { value: 'continuous', label: s.layoutScroll },
            ]}
            value={settings.layout}
          />
        </SettingRow>
        {isImage && settings.layout === 'paged' && (
          <>
            <SettingRow label={s.fit}>
              <Segmented
                block
                label={s.fit}
                onChange={(fitMode) => update({ fitMode, zoom: fitMode === 'manual' ? Math.max(settings.zoom, 130) : 100 })}
                options={[
                  { value: 'fit-page', label: s.fitPage },
                  { value: 'fit-width', label: s.fitWidth },
                  { value: 'manual', label: s.fitZoom },
                ]}
                value={settings.fitMode}
              />
            </SettingRow>
            {settings.fitMode === 'manual' && (
              <SettingRow label={s.fitZoom}>
                <div className="stepper">
                  <button
                    aria-label={s.zoomOut}
                    className="icon-btn icon-btn--outlined"
                    disabled={settings.zoom <= 100}
                    onClick={() => update({ zoom: Math.max(100, settings.zoom - 10) })}
                    type="button"
                  >
                    <Minus aria-hidden="true" />
                  </button>
                  <span className="stepper__value">{settings.zoom}%</span>
                  <button
                    aria-label={s.zoomIn}
                    className="icon-btn icon-btn--outlined"
                    disabled={settings.zoom >= 200}
                    onClick={() => update({ zoom: Math.min(200, settings.zoom + 10) })}
                    type="button"
                  >
                    <Plus aria-hidden="true" />
                  </button>
                </div>
              </SettingRow>
            )}
            <SettingRow label={s.view}>
              <Segmented
                block
                label={s.view}
                onChange={(viewMode) => update({ viewMode })}
                options={[
                  { value: 'single', label: s.viewSingle },
                  { value: 'spread', label: s.viewSpread },
                ]}
                value={settings.viewMode}
              />
            </SettingRow>
            {settings.viewMode === 'spread' && (
              <SettingRow label={s.pairing}>
                <Segmented
                  block
                  label={s.pairing}
                  onChange={(spreadAlignment) => update({ spreadAlignment })}
                  options={[
                    { value: 'cover-first', label: s.pairingCover },
                    { value: 'straight-pairs', label: s.pairingPairs },
                  ]}
                  value={settings.spreadAlignment}
                />
              </SettingRow>
            )}
            <SettingRow label={s.direction}>
              <Segmented
                block
                label={s.direction}
                onChange={(direction) => update({ direction })}
                options={[
                  { value: 'ltr', label: s.directionLtr },
                  { value: 'rtl', label: s.directionRtl },
                ]}
                value={settings.direction}
              />
            </SettingRow>
          </>
        )}
        {format === 'cbz' && (
          <SettingRow label={s.pageOrder}>
            <Segmented
              block
              label={s.pageOrder}
              onChange={(pageOrder) => update({ pageOrder })}
              options={[
                { value: 'filename', label: s.pageOrderName },
                { value: 'archive', label: s.pageOrderArchive },
              ]}
              value={settings.pageOrder}
            />
          </SettingRow>
        )}
        <p className="text-muted text-small">{s.seriesNote}</p>
      </section>
    </Sheet>
  )
}
