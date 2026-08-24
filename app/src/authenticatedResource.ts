import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import {
  acquireCachedImage,
  getCachedImageSource,
  type CachedImageRequest,
  type ImageLoadPriority,
} from './imageCache'
import { isNativeApp, resolveApiUrl } from './platform'

type AuthenticatedResourceState = {
  url: string | null
  loading: boolean
  error: string | null
}

const localResourceUrlPattern = /^(?:blob|capacitor|data|file):/i

const isLocalWebViewResource = (url: string) => {
  if (localResourceUrlPattern.test(url)) {
    return true
  }

  try {
    return new URL(url).hostname === 'localhost'
  } catch {
    return false
  }
}

const fetchLocalResource = (url: string) =>
  fetch(url, {
    credentials: 'same-origin',
  })

export type AuthenticatedResourceOptions = {
  cacheKey?: string
  cacheMode?: 'image'
  ownerUserId?: string | null
  offlineOnly?: boolean
  priority?: ImageLoadPriority
}

export const fetchAuthenticatedResource = async (input: string) => {
  const resolvedUrl = resolveApiUrl(input)

  if (isNativeApp && isLocalWebViewResource(resolvedUrl)) {
    return fetchLocalResource(resolvedUrl)
  }

  return api.fetchResource(input)
}

export const useAuthenticatedResourceUrl = (
  input: string | null,
  options: AuthenticatedResourceOptions = {},
) => {
  const resolvedInput = input ? resolveApiUrl(input) : null
  const needsAuthentication = Boolean(
    resolvedInput && isNativeApp && !isLocalWebViewResource(resolvedInput),
  )
  const shouldCacheImage = Boolean(
    needsAuthentication &&
      options.cacheMode === 'image' &&
      options.ownerUserId,
  )
  const [state, setState] = useState<AuthenticatedResourceState>(() => ({
    url: needsAuthentication ? null : resolvedInput,
    loading: needsAuthentication,
    error: null,
  }))
  const imageRequestRef = useRef<CachedImageRequest | null>(null)
  const priorityRef = useRef<ImageLoadPriority>(options.priority ?? 'nearby')

  useEffect(() => {
    const priority = options.priority ?? 'nearby'
    priorityRef.current = priority
    imageRequestRef.current?.setPriority(priority)
  }, [options.priority])

  useEffect(() => {
    if (!resolvedInput) {
      setState({ url: null, loading: false, error: null })
      return
    }

    if (!isNativeApp || isLocalWebViewResource(resolvedInput)) {
      setState({ url: resolvedInput, loading: false, error: null })
      return
    }

    let disposed = false
    let objectUrl: string | null = null
    let imageRequest: CachedImageRequest | null = null

    setState({ url: null, loading: true, error: null })

    const loadResource = async () => {
      if (shouldCacheImage) {
        const ownerUserId = options.ownerUserId || ''
        const cacheKey = options.cacheKey || resolvedInput
        const cachedSource = await getCachedImageSource(
          ownerUserId,
          resolvedInput,
          cacheKey,
          Boolean(options.offlineOnly),
        )
        if (cachedSource) {
          return cachedSource
        }

        imageRequest = acquireCachedImage(
          ownerUserId,
          resolvedInput,
          options.offlineOnly ? undefined : () => fetchAuthenticatedResource(resolvedInput),
          cacheKey,
          priorityRef.current,
        )
        imageRequestRef.current = imageRequest
        const blob = await imageRequest.promise
        const storedSource = await getCachedImageSource(
          ownerUserId,
          resolvedInput,
          cacheKey,
          Boolean(options.offlineOnly),
        )
        if (storedSource) {
          return storedSource
        }

        objectUrl = URL.createObjectURL(blob)
        return objectUrl
      }

      const response = await fetchAuthenticatedResource(resolvedInput)
      if (!response.ok) {
        throw new Error(`Failed to load resource (${response.status})`)
      }

      objectUrl = URL.createObjectURL(await response.blob())
      return objectUrl
    }

    void loadResource()
      .then((resourceUrl) => {
        if (disposed) {
          if (objectUrl === resourceUrl) {
            URL.revokeObjectURL(resourceUrl)
            objectUrl = null
          }
          return
        }

        setState({ url: resourceUrl, loading: false, error: null })
      })
      .catch((loadError) => {
        if (disposed) {
          return
        }

        setState({
          url: null,
          loading: false,
          error: loadError instanceof Error ? loadError.message : 'Failed to load resource.',
        })
      })

    return () => {
      disposed = true
      imageRequest?.release()
      if (imageRequestRef.current === imageRequest) {
        imageRequestRef.current = null
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [
    options.cacheKey,
    options.cacheMode,
    options.offlineOnly,
    options.ownerUserId,
    resolvedInput,
    shouldCacheImage,
  ])

  return state
}
