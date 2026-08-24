import type { ImgHTMLAttributes } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useAuthenticatedResourceUrl } from './authenticatedResource'
import { isNativeApp } from './platform'

type IntersectionListener = (intersecting: boolean) => void

const nearbyImageListeners = new WeakMap<Element, IntersectionListener>()
const visibleImageListeners = new WeakMap<Element, IntersectionListener>()
let nearbyImageObserver: IntersectionObserver | null = null
let visibleImageObserver: IntersectionObserver | null = null

const getNearbyImageObserver = () => {
  if (!nearbyImageObserver && typeof IntersectionObserver !== 'undefined') {
    nearbyImageObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => nearbyImageListeners.get(entry.target)?.(entry.isIntersecting))
    }, { rootMargin: '1200px 0px' })
  }

  return nearbyImageObserver
}

const getVisibleImageObserver = () => {
  if (!visibleImageObserver && typeof IntersectionObserver !== 'undefined') {
    visibleImageObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => visibleImageListeners.get(entry.target)?.(entry.isIntersecting))
    })
  }

  return visibleImageObserver
}

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
    const nearbyObserver = getNearbyImageObserver()
    const visibleObserver = getVisibleImageObserver()
    if (!image || !nearbyObserver || !visibleObserver) {
      setNearViewport(true)
      return
    }

    nearbyImageListeners.set(image, setNearViewport)
    visibleImageListeners.set(image, setVisible)

    nearbyObserver.observe(image)
    visibleObserver.observe(image)
    return () => {
      nearbyObserver.unobserve(image)
      visibleObserver.unobserve(image)
      nearbyImageListeners.delete(image)
      visibleImageListeners.delete(image)
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
