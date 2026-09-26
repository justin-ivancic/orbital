import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useT } from '../i18n'

type SheetProps = {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  /** Close when the backdrop is tapped (off for forms with unsaved input). */
  dismissible?: boolean
}

let openSheets = 0

/**
 * A modal panel: a bottom sheet on narrow screens and a dialog on wide ones.
 * Escape and the close button always work; focus returns to the opener.
 */
export function Sheet({ title, onClose, children, footer, wide = false, dismissible = true }: SheetProps) {
  const t = useT()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const firstField = panel?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea, [data-autofocus]',
    )
    ;(firstField ?? panel)?.focus({ preventScroll: true })

    openSheets += 1
    document.documentElement.style.overflow = 'hidden'

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      openSheets -= 1

      if (openSheets === 0) {
        document.documentElement.style.overflow = ''
      }

      opener?.focus({ preventScroll: true })
    }
  }, [])

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) {
          onClose()
        }
      }}
      role="presentation"
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={`sheet${wide ? ' sheet--wide' : ''}`}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="sheet__head">
          <h2 className="sheet__title" id={titleId}>
            {title}
          </h2>
          <button aria-label={t.common.close} className="icon-btn" onClick={onClose} type="button">
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {footer && <div className="sheet__foot">{footer}</div>}
      </div>
    </div>
  )
}
