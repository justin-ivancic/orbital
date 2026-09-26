import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Keep the browser's Host header so the API's same-origin CSRF check
      // accepts state-changing requests made through the dev server.
      '/api': { target: 'http://127.0.0.1:4300', changeOrigin: false },
    },
    fs: {
      allow: [path.resolve(__dirname)],
    },
  },
})
