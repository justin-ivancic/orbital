import assert from 'node:assert/strict'
import fsPromises from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { parseRangeHeader, sendMediaFile } from './mediaResponses.ts'

test('range headers follow RFC 7233 and clamp past-the-end requests', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRangeHeader('bytes=900-', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRangeHeader('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRangeHeader('bytes=500-5000', 1000), { start: 500, end: 999 })
  assert.equal(parseRangeHeader('bytes=1000-', 1000), null)
  assert.equal(parseRangeHeader('bytes=5-1', 1000), null)
  assert.equal(parseRangeHeader('bytes=0-1,4-5', 1000), null)
  assert.equal(parseRangeHeader('items=0-1', 1000), null)
})

const withServer = async (
  filePath: string,
  run: (baseUrl: string) => Promise<void>,
) => {
  const app = express()
  app.get('/file', (request, response) => {
    void sendMediaFile(request, response, filePath, { rangeHeader: request.headers.range })
  })
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('media files stream whole, by range, and revalidate with ETags', async () => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'orbital-media-'))
  const filePath = path.join(directory, 'book.pdf')
  const content = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251))
  await fsPromises.writeFile(filePath, content)

  try {
    await withServer(filePath, async (baseUrl) => {
      const whole = await fetch(`${baseUrl}/file`)
      assert.equal(whole.status, 200)
      assert.equal(whole.headers.get('content-type'), 'application/pdf')
      assert.deepEqual(Buffer.from(await whole.arrayBuffer()), content)

      const partial = await fetch(`${baseUrl}/file`, { headers: { Range: 'bytes=100-199' } })
      assert.equal(partial.status, 206)
      assert.equal(partial.headers.get('content-range'), 'bytes 100-199/4096')
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), content.subarray(100, 200))

      const unsatisfiable = await fetch(`${baseUrl}/file`, { headers: { Range: 'bytes=5000-' } })
      assert.equal(unsatisfiable.status, 416)

      const revalidated = await fetch(`${baseUrl}/file`, {
        headers: { 'If-None-Match': whole.headers.get('etag') ?? '' },
      })
      assert.equal(revalidated.status, 304)
    })
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

test('an aborted download does not crash the server or leak an error', async () => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'orbital-media-'))
  const filePath = path.join(directory, 'large.bin')
  await fsPromises.writeFile(filePath, Buffer.alloc(8 * 1024 * 1024, 7))

  try {
    await withServer(filePath, async (baseUrl) => {
      const controller = new AbortController()
      const response = await fetch(`${baseUrl}/file`, { signal: controller.signal })
      const reader = response.body?.getReader()
      await reader?.read()
      controller.abort()

      // The server keeps serving after the aborted transfer.
      const next = await fetch(`${baseUrl}/file`, { headers: { Range: 'bytes=0-9' } })
      assert.equal(next.status, 206)
      assert.equal((await next.arrayBuffer()).byteLength, 10)
    })
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
})
