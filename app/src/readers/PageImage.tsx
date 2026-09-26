import { useEffect, useState } from 'react'
import { loadPageImage, pinPageImage } from './pageImages'

type PageImageProps = {
  url: string
  alt: string
  className?: string
  onFailed?: () => void
}

/**
 * Shows a page once it is decoded. The previous page stays on screen until
 * then, so e-ink panels redraw once instead of flashing an empty frame.
 */
export function PageImage({ url, alt, className, onFailed }: PageImageProps) {
  const [shown, setShown] = useState<{ url: string; src: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    let release = () => {}

    loadPageImage(url)
      .then((src) => {
        if (cancelled) {
          return
        }

        release = pinPageImage(url)
        setShown({ url, src })
      })
      .catch(() => {
        if (!cancelled) {
          onFailed?.()
        }
      })

    return () => {
      cancelled = true
      release()
    }
  }, [onFailed, url])

  if (!shown) {
    return <span aria-hidden="true" className={`page-image page-image--pending ${className ?? ''}`} />
  }

  return <img alt={alt} className={`page-image ${className ?? ''}`} draggable={false} src={shown.src} />
}
