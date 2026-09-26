import { Minus, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { fontScaleStep, maxFontScale, minFontScale, setTextStyle, type TextStyle } from '../app/preferences'
import { useT } from '../i18n'
import { Segmented, Switch } from '../ui/bits'

export function SettingRow({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-row__text">
        <span className="setting-row__label">{label}</span>
        {hint && <span className="setting-row__hint">{hint}</span>}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  )
}

/** Typography controls shared by the reader's display sheet and Settings. */
export function TextSettingsControls({ textStyle, allowPublisherFont }: { textStyle: TextStyle; allowPublisherFont: boolean }) {
  const t = useT()
  const s = t.reader.settings

  return (
    <>
      <SettingRow label={s.fontSize}>
        <div className="stepper">
          <button
            aria-label={s.smaller}
            className="icon-btn icon-btn--outlined"
            disabled={textStyle.fontScale <= minFontScale}
            onClick={() => setTextStyle({ fontScale: textStyle.fontScale - fontScaleStep })}
            type="button"
          >
            <Minus aria-hidden="true" />
          </button>
          <span className="stepper__value" style={{ fontSize: `${Math.min(1.4, textStyle.fontScale / 100)}rem` }}>
            {textStyle.fontScale}%
          </span>
          <button
            aria-label={s.larger}
            className="icon-btn icon-btn--outlined"
            disabled={textStyle.fontScale >= maxFontScale}
            onClick={() => setTextStyle({ fontScale: textStyle.fontScale + fontScaleStep })}
            type="button"
          >
            <Plus aria-hidden="true" />
          </button>
        </div>
      </SettingRow>
      <SettingRow label={s.font}>
        <Segmented
          block
          label={s.font}
          onChange={(font) => setTextStyle({ font })}
          options={[
            ...(allowPublisherFont ? [{ value: 'publisher' as const, label: s.fontPublisher }] : []),
            { value: 'serif' as const, label: <span className="font-sample font-sample--serif">{s.fontSerif}</span> },
            { value: 'sans' as const, label: <span className="font-sample font-sample--sans">{s.fontSans}</span> },
          ]}
          value={!allowPublisherFont && textStyle.font === 'publisher' ? 'serif' : textStyle.font}
        />
      </SettingRow>
      <SettingRow label={s.spacing}>
        <Segmented
          block
          label={s.spacing}
          onChange={(spacing) => setTextStyle({ spacing })}
          options={[
            { value: 'compact', label: s.spacingCompact },
            { value: 'normal', label: s.spacingNormal },
            { value: 'relaxed', label: s.spacingRelaxed },
          ]}
          value={textStyle.spacing}
        />
      </SettingRow>
      <SettingRow label={s.margins}>
        <Segmented
          block
          label={s.margins}
          onChange={(margins) => setTextStyle({ margins })}
          options={[
            { value: 'narrow', label: s.marginsNarrow },
            { value: 'normal', label: s.marginsNormal },
            { value: 'wide', label: s.marginsWide },
          ]}
          value={textStyle.margins}
        />
      </SettingRow>
      <SettingRow label={s.justify}>
        <Switch checked={textStyle.justify} label={s.justify} onChange={(justify) => setTextStyle({ justify })} />
      </SettingRow>
    </>
  )
}
