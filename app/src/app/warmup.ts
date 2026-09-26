import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { isNativeApp } from '../platform'

let warmed = false

/**
 * In the web app, pages and reader engines load on demand. Fetching them once
 * while online lets the service worker keep them, so downloaded books still
 * open after the connection drops. The Android app ships these files itself.
 */
export const warmOfflineAssets = () => {
  if (warmed || isNativeApp || typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) {
    return
  }

  warmed = true

  const run = () => {
    void import('../pages/ReaderPage').catch(() => undefined)
    void import('../pages/DownloadsPage').catch(() => undefined)
    void import('../pages/SettingsPage').catch(() => undefined)
    void import('../readers/PdfReader').catch(() => undefined)
    void import('../readers/EpubReader').catch(() => undefined)
    ;[pdfWorkerUrl, '/pdfjs/wasm/jbig2.wasm', '/pdfjs/wasm/openjpeg.wasm'].forEach((url) => {
      void fetch(url).catch(() => undefined)
    })
  }

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 15_000 })
  } else {
    setTimeout(run, 5_000)
  }
}
