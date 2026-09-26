import crypto from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Database } from 'better-sqlite3'
import type { Request } from 'express'
import { getAppSetting, setAppSetting } from './appSettings'
import { ensureDir } from './utils'

const apkFileName = 'orbital-android.apk'
const apkReleaseSettingKey = 'android_apk_release'
const maxApkBytes = 300 * 1024 * 1024
const zipLocalFileHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04])

export type AndroidApkLocations = {
  uploaded: string
  bundled: string
  externalUrl: string | null
}

type StoredRelease = {
  versionName: string | null
  versionCode: number | null
  uploadedAt: string
  size: number
  sha256: string
}

export type AndroidAppInfo = {
  available: boolean
  source: 'uploaded' | 'bundled' | 'external' | null
  size: number | null
  updatedAt: string | null
  versionName: string | null
  versionCode: number | null
  downloadUrl: string
}

export const getAndroidApkLocations = (dataDirectory: string, appRoot: string): AndroidApkLocations => {
  const externalUrl = process.env.APP_ANDROID_APK_URL?.trim() || null

  return {
    uploaded: path.join(dataDirectory, 'android', apkFileName),
    bundled: path.join(appRoot, 'mobile-distribution', apkFileName),
    externalUrl: externalUrl && /^https:\/\//i.test(externalUrl) ? externalUrl : null,
  }
}

const readRelease = (db: Database): StoredRelease | null => {
  try {
    const value = getAppSetting(db, apkReleaseSettingKey)
    return value ? JSON.parse(value) as StoredRelease : null
  } catch {
    return null
  }
}

const statOrNull = async (filePath: string) => {
  try {
    const stats = await fsPromises.stat(filePath)
    return stats.isFile() && stats.size > 0 ? stats : null
  } catch {
    return null
  }
}

/** The APK a device should download: an admin upload, then a bundled build, then an external URL. */
export const resolveAndroidApk = async (locations: AndroidApkLocations) => {
  const uploaded = await statOrNull(locations.uploaded)
  if (uploaded) {
    return { kind: 'file' as const, source: 'uploaded' as const, filePath: locations.uploaded, stats: uploaded }
  }

  const bundled = await statOrNull(locations.bundled)
  if (bundled) {
    return { kind: 'file' as const, source: 'bundled' as const, filePath: locations.bundled, stats: bundled }
  }

  if (locations.externalUrl) {
    return { kind: 'redirect' as const, source: 'external' as const, url: locations.externalUrl }
  }

  return null
}

export const getAndroidAppInfo = async (
  db: Database,
  locations: AndroidApkLocations,
): Promise<AndroidAppInfo> => {
  const apk = await resolveAndroidApk(locations)
  const release = apk?.source === 'uploaded' ? readRelease(db) : null

  return {
    available: Boolean(apk),
    source: apk?.source ?? null,
    size: apk?.kind === 'file' ? apk.stats.size : null,
    updatedAt: release?.uploadedAt ?? (apk?.kind === 'file' ? apk.stats.mtime.toISOString() : null),
    versionName: release?.versionName ?? null,
    versionCode: release?.versionCode ?? null,
    downloadUrl: '/api/mobile/app.apk',
  }
}

const sanitizeVersionName = (value: unknown) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^[\w.+-]{1,32}$/.test(text) ? text : null
}

const sanitizeVersionCode = (value: unknown) => {
  const code = Number(value)
  return Number.isInteger(code) && code > 0 && code < 2_100_000_000 ? code : null
}

/**
 * Streams an uploaded APK to the data volume without buffering it in memory,
 * validates that it is a ZIP container, and swaps it in atomically.
 */
export const saveUploadedAndroidApk = async (
  db: Database,
  locations: AndroidApkLocations,
  request: Request,
  metadata: { versionName?: unknown; versionCode?: unknown },
) => {
  const declaredLength = Number(request.get('content-length') || 0)
  if (declaredLength > maxApkBytes) {
    throw new Error('APK files can be at most 300 MB.')
  }

  ensureDir(path.dirname(locations.uploaded))
  const temporaryPath = `${locations.uploaded}.${crypto.randomUUID()}.part`
  const hash = crypto.createHash('sha256')
  let size = 0
  let header = Buffer.alloc(0)

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size > maxApkBytes) {
        callback(new Error('APK files can be at most 300 MB.'))
        return
      }
      if (header.length < 4) {
        header = Buffer.concat([header, chunk.subarray(0, 4 - header.length)])
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })

  try {
    await pipeline(request, meter, fs.createWriteStream(temporaryPath))

    if (size === 0 || !header.equals(zipLocalFileHeader)) {
      throw new Error('That file is not an Android APK.')
    }

    await fsPromises.rename(temporaryPath, locations.uploaded)
  } finally {
    await fsPromises.unlink(temporaryPath).catch(() => undefined)
  }

  const release: StoredRelease = {
    versionName: sanitizeVersionName(metadata.versionName),
    versionCode: sanitizeVersionCode(metadata.versionCode),
    uploadedAt: new Date().toISOString(),
    size,
    sha256: hash.digest('hex'),
  }
  setAppSetting(db, apkReleaseSettingKey, JSON.stringify(release))

  return release
}

export const deleteUploadedAndroidApk = async (db: Database, locations: AndroidApkLocations) => {
  await fsPromises.unlink(locations.uploaded).catch(() => undefined)
  setAppSetting(db, apkReleaseSettingKey, null)
}
