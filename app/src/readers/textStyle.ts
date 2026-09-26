import type { CSSProperties } from 'react'
import type { TextStyle } from '../app/preferences'

export const lineHeights = { compact: 1.35, normal: 1.6, relaxed: 1.85 } as const
export const pageMargins = { narrow: 16, normal: 36, wide: 64 } as const
export const serifStack = "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', 'Noto Serif', Georgia, serif"
export const sansStack = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', Arial, sans-serif"

/** CSS custom properties that carry the device typography into a text reader. */
export const textStyleVariables = (style: TextStyle): CSSProperties =>
  ({
    '--flow-font-size': `${(style.fontScale / 100) * 1.125}rem`,
    '--flow-line-height': String(lineHeights[style.spacing]),
    '--flow-font-family': style.font === 'sans' ? sansStack : serifStack,
    '--flow-align': style.justify ? 'justify' : 'start',
    '--flow-margin': `${pageMargins[style.margins]}px`,
  }) as CSSProperties
