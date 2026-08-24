import type { ImgHTMLAttributes } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useAuthenticatedResourceUrl } from './authenticatedResource'
import { isNativeApp } from './platform'

type AuthenticatedResourceImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  cacheKey?: string
  offlineOnly?: boolean
  ownerUserId?: string | null
  sourceUrl: string
}

export function AuthenticatedResourceImage({
  cacheKey,
  offlineOnly,
  ownerUserId,
  sourceUrl,
  ...imageProps
}: AuthenticatedResourceImageProps) {
  const imageRef = useRef<HTMLImageElement | null>(null)
  const shouldLoadImmediately = !isNativeApp || imageProps.loading === 'eager'
  const [nearViewport, setNearViewport] = useState(shouldLoadImmediately)
  const [visible, setVisible] = useState(shouldLoadImmediately)

  useEffect(() => {
    if (shouldLoadImmediately) {
      setNearViewport(true)
      setVisible(true)
      return
    }

    setNearViewport(false)
    setVisible(false)
    const image = imageRef.current
    if (!image || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }

    const nearbyObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true)
          nearbyObserver.disconnect()
        }
      },
      { rootMargin: '1400px 0px' },
    )
    const visibleObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        visibleObserver.disconnect()
      }
    })

    nearbyObserver.observe(image)
    visibleObserver.observe(image)
    return () => {
      nearbyObserver.disconnect()
      visibleObserver.disconnect()
    }
  }, [shouldLoadImmediately, sourceUrl])

  const { url } = useAuthenticatedResourceUrl(nearViewport ? sourceUrl : null, {
    cacheKey,
    cacheMode: 'image',
    offlineOnly,
    ownerUserId,
    priority: visible ? 'visible' : 'nearby',
  })

  return (
    <img
      {...imageProps}
      loading={isNativeApp && nearViewport ? 'eager' : imageProps.loading}
      ref={imageRef}
      src={url || undefined}
    />
  )
}
