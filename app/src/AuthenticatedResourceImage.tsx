import type { ImgHTMLAttributes } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useAuthenticatedResourceUrl } from './authenticatedResource'
import { isNativeApp } from './platform'

type AuthenticatedResourceImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  offlineOnly?: boolean
  ownerUserId?: string | null
  sourceUrl: string
}

export function AuthenticatedResourceImage({
  offlineOnly,
  ownerUserId,
  sourceUrl,
  ...imageProps
}: AuthenticatedResourceImageProps) {
  const imageRef = useRef<HTMLImageElement | null>(null)
  const shouldLoadImmediately = !isNativeApp || imageProps.loading === 'eager'
  const [nearViewport, setNearViewport] = useState(shouldLoadImmediately)

  useEffect(() => {
    if (shouldLoadImmediately) {
      setNearViewport(true)
      return
    }

    setNearViewport(false)
    const image = imageRef.current
    if (!image || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true)
          observer.disconnect()
        }
      },
      { rootMargin: '600px 0px' },
    )

    observer.observe(image)
    return () => observer.disconnect()
  }, [shouldLoadImmediately, sourceUrl])

  const { url } = useAuthenticatedResourceUrl(nearViewport ? sourceUrl : null, {
    cacheMode: 'image',
    offlineOnly,
    ownerUserId,
  })

  return <img {...imageProps} ref={imageRef} src={url || undefined} />
}
