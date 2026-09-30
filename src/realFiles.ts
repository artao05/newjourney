/** The real files in fixtures/real (see its SOURCES.md), for tests. Node only. */
import { readFileSync } from 'node:fs'

export const realFile = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/real/${name}`, import.meta.url)))
export const realText = (name: string) => readFileSync(new URL(`../fixtures/real/${name}`, import.meta.url), 'utf8')
