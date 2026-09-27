import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { precacheManifest } from './src/lib/pwa/precachePlugin'

export default defineConfig({
  // precacheManifest writes the build's file list into dist/sw.js, so one online
  // visit leaves everything needed to start offline (src/lib/pwa/precache.ts).
  plugins: [react(), precacheManifest()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    // Node by default, so the pure library suites stay fast; the handful of files
    // that need a DOM ask for one with a per-file @vitest-environment pragma.
    environment: 'node',
    // .tsx as well as .ts: a screen test has to render JSX, and until this
    // included it the first such file was silently collected by nothing at all -
    // vitest exits 0 on "no test files matched the filter" only when it is given
    // no filter, so a whole suite can go missing without a red run.
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
