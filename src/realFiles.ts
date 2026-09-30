/** The real files in fixtures/real (see its SOURCES.md), for tests. Node only. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// From the project root, where vitest runs: under jsdom, import.meta.url is not a file URL.
const path = (name: string) => join(process.cwd(), 'fixtures', 'real', name)

export const realFile = (name: string) => new Uint8Array(readFileSync(path(name)))
export const realText = (name: string) => readFileSync(path(name), 'utf8')
