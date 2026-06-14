export const getQueryStringValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : ''
  }

  return typeof value === 'string' ? value : ''
}

export const getRequestedMediaVersion = (query: Record<string, unknown>) =>
  getQueryStringValue(query.v).trim()

export const isStaleMediaVersion = (
  query: Record<string, unknown>,
  currentVersion: string,
) => {
  const requestedVersion = getRequestedMediaVersion(query)

  return Boolean(requestedVersion && requestedVersion !== currentVersion)
}

export const isCurrentMediaVersion = (
  query: Record<string, unknown>,
  currentVersion: string,
) => getRequestedMediaVersion(query) === currentVersion

export const buildVersionedMediaPath = (originalUrl: string, currentVersion: string) => {
  const url = new URL(originalUrl, 'http://orbital.local')
  url.searchParams.set('v', currentVersion)

  return `${url.pathname}${url.search}`
}
