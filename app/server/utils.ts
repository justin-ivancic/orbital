import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SESSION_COOKIE_NAME = 'orbital_session'
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30

export const nowIso = () => new Date().toISOString()

export const createId = (prefix: string) =>
  `${prefix}_${crypto.randomBytes(10).toString('hex')}`

export const createSecretToken = () => crypto.randomBytes(32).toString('base64url')

export const hashString = (value: string) =>
  crypto.createHash('sha1').update(value).digest('hex')

export const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item'

export const ensureDir = (directoryPath: string) => {
  fs.mkdirSync(directoryPath, { recursive: true })
}

export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

export const joinInsideRoot = (rootPath: string, relativePath: string) => {
  const safeRelativePath = relativePath.replace(/^\/+/, '')
  const resolvedPath = path.resolve(rootPath, safeRelativePath)
  const normalizedRoot = path.resolve(rootPath)

  if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('Requested path is outside the mounted root.')
  }

  return resolvedPath
}

export const stripExtension = (fileName: string) => fileName.replace(/\.[^.]+$/, '')

export const titleCase = (value: string) =>
  value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

export const naturalCompare = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })

export const firstNumber = (value: string) => {
  const match = value.match(/(\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

export const inferYear = (value: string) => {
  const match = value.match(/\b(19|20)\d{2}\b/)
  return match ? Number(match[0]) : null
}

export const compactWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()
