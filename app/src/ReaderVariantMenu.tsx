import { useEffect, useRef, useState } from 'react'
import type { EntryVariant } from './appTypes'

type ReaderVariantMenuProps = {
  variants: EntryVariant[]
  selectedVariantId: string
  onSelect: (variantId: string) => void
}

export function ReaderVariantMenu({
  variants,
  selectedVariantId,
  onSelect,
}: ReaderVariantMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const selectedVariant =
    variants.find((variant) => variant.id === selectedVariantId) ?? variants[0]

  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  return (
    <div className="variant-menu" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="variant-menu__trigger"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        type="button"
      >
        {selectedVariant.variantLabel}
      </button>

      {open && (
        <div className="variant-menu__panel" role="menu">
          {variants.map((variant) => (
            <button
              className={`variant-menu__item ${variant.id === selectedVariantId ? 'is-active' : ''}`}
              key={variant.id}
              onClick={() => {
                onSelect(variant.id)
                setOpen(false)
              }}
              role="menuitemradio"
              type="button"
            >
              <span className="variant-menu__item-topline">
                <strong>{variant.variantLabel}</strong>
                <span>{variant.format.toUpperCase()}</span>
              </span>
              <span className="variant-menu__item-file">{variant.storageFile}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
