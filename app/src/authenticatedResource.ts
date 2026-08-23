import { useEffect, useState } from 'react'
import { api } from './api'
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

export const fetchAuthenticatedResource = async (input: string) => {
  const resolvedUrl = resolveApiUrl(input)

  if (isNativeApp && isLocalWebViewResource(resolvedUrl)) {
    return fetchLocalResource(resolvedUrl)
  }

  return api.fetchResource(input)
}

export const useAuthenticatedResourceUrl = (input: string | null) => {
  const resolvedInput = input ? resolveApiUrl(input) : null
  const needsAuthentication = Boolean(
    resolvedInput && isNativeApp && !isLocalWebViewResource(resolvedInput),
  )
  const [state, setState] = useState<AuthenticatedResourceState>(() => ({
    url: needsAuthentication ? null : resolvedInput,
    loading: needsAuthentication,
    error: null,
  }))

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

    setState({ url: null, loading: true, error: null })

    void fetchAuthenticatedResource(resolvedInput)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load resource (${response.status})`)
        }

        return response.blob()
      })
      .then((blob) => {
        if (disposed) {
          return
        }

        objectUrl = URL.createObjectURL(blob)
        setState({ url: objectUrl, loading: false, error: null })
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
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [resolvedInput])

  return state
}
