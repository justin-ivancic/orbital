import { cpSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const pdfjsRoot = path.resolve(projectRoot, 'node_modules', 'pdfjs-dist')
const publicRoot = path.resolve(projectRoot, 'public', 'pdfjs')

const assetFolders = ['iccs', 'standard_fonts', 'wasm']

mkdirSync(publicRoot, { recursive: true })

for (const folder of assetFolders) {
  const source = path.join(pdfjsRoot, folder)
  const destination = path.join(publicRoot, folder)

  if (!existsSync(source)) {
    throw new Error(`Missing pdfjs-dist asset folder: ${source}`)
  }

  cpSync(source, destination, {
    force: true,
    recursive: true,
  })
}

console.log('Synced pdf.js assets to public/pdfjs')
