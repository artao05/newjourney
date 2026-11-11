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
  preview: {
    // A phone gets GPS, offline and lasting storage only over HTTPS or localhost, and a
    // tunnel to this server is the quickest HTTPS (RUNNING.md, "On a real phone"). Vite
    // answers only the hostnames it knows, so name the two tunnels that page describes.
    // The leading dot lets in any name under them.
    allowedHosts: ['.trycloudflare.com', '.ts.net'],
    // On Windows "localhost" listens on IPv6 alone ([::1]), and Tailscale forwards to
    // 127.0.0.1, so it would find nothing. Still this machine only, not the LAN.
    host: '127.0.0.1',
  },
  test: {
    // Node by default, so the pure library suites stay fast; the handful of files
    // that need a DOM ask for one with a per-file @vitest-environment pragma.
    environment: 'node',
    // .tsx as well as .ts: a screen test has to render JSX, and until this
    // included it the first such file was silently collected by nothing at all -
    // vitest exits 0 on "no test files matched the filter" only when it is given
    // no filter, so a whole suite can go missing without a red run.
    include: ['src/**/*.test.{ts,tsx}', 'bridge/**/*.test.ts'],
    // A macrotask between tests, so long synchronous suites cannot starve the
    // worker's RPC to the runner (src/test-setup.ts).
    setupFiles: ['src/test-setup.ts'],
    // CI runners are slower than a desktop, and several suites run whole route
    // solves; a longer limit there keeps the result about the code, not the
    // machine. Locally the default still fails a hang fast.
    testTimeout: process.env.CI ? 30_000 : 5_000,
  },
})
