import fs from 'node:fs'
import path from 'node:path'

// `npm run dev` reads app/.env the way Docker Compose does. Variables that are
// already set win, and production uses its environment as given. Imported
// first by index.ts, because some modules read their settings on load.
const envFile = path.join(process.cwd(), '.env')

if (process.env.NODE_ENV !== 'production' && fs.existsSync(envFile)) {
  process.loadEnvFile(envFile)
}
