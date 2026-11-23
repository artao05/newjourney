import { defineConfig, loadEnv } from 'vite'
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
 *
 * The key can come from the shell's environment or from v2/.env.local (git
 * ignores it). Only the ANTHROPIC_* names are read, into this server process:
 * they have no VITE_ prefix, so Vite never puts them in the page.
 */
const V2_ROOT = fileURLToPath(new URL('./v2', import.meta.url))
const FROM_FILE = 'NJ2_ENV_FROM_FILE'

export default defineConfig(({ mode }) => {
  // Vite reloads this file when v2/.env.local changes, in the same process:
  // forget what the file set last time, so an edited or removed key applies.
  for (const k of (process.env[FROM_FILE] ?? '').split(',').filter(Boolean)) delete process.env[k]
  const fromFile: string[] = []
  for (const [k, v] of Object.entries(loadEnv(mode, V2_ROOT, 'ANTHROPIC_'))) {
    if (v && !process.env[k]) {
      process.env[k] = v
      fromFile.push(k)
    }
  }
  process.env[FROM_FILE] = fromFile.join(',')
  return {
    root: V2_ROOT,
    base: './',
    plugins: [react(), coachApi()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@v2': fileURLToPath(new URL('./v2/src', import.meta.url)),
      },
    },
    // The engine lives in ../src, outside this root.
    server: {
      port: 5174,
      strictPort: true,
      fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
    },
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
  }
})
