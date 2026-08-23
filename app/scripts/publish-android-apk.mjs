import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(appRoot, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const distributionDirectory = path.join(appRoot, 'mobile-distribution')
const destinationPath = path.join(distributionDirectory, 'orbital-android.apk')

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Android APK not found at ${sourcePath}. Run npm run mobile:assemble first.`)
}

fs.mkdirSync(distributionDirectory, { recursive: true })
fs.copyFileSync(sourcePath, destinationPath)

const sizeInMb = fs.statSync(destinationPath).size / (1024 * 1024)
console.log(`Published ${destinationPath} (${sizeInMb.toFixed(1)} MB)`)
