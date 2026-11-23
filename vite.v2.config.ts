import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { coachApi } from './v2/server/coachApi'

/**
 * NewJourney v2: a new interface over the same tested engine in src/lib.
 *
 *   npm run dev:v2      http://localhost:5174
 *   npm run build:v2    dist-v2/
 *
 * The AI coach calls Claude from the dev/preview server (v2/server/coachApi.ts),
 * so the API key stays on this machine and never reaches the browser.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./v2', import.meta.url)),
  base: './',
  plugins: [react(), coachApi()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@v2': fileURLToPath(new URL('./v2/src', import.meta.url)),
    },
  },
  // The engine lives in ../src, outside this root.
  server: { port: 5174, strictPort: true, fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] } },
  worker: { format: 'es' },
  preview: { port: 4174, strictPort: false, host: '127.0.0.1' },
  build: {
    outDir: fileURLToPath(new URL('./dist-v2', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['v2/**/*.test.ts'],
    environment: 'node',
  },
})
