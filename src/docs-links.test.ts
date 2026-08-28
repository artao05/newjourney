/**
 * Link integrity across the documentation.
 *
 * This repo is roughly half prose — 34 markdown files that cite each other heavily,
 * and whose whole value is that a reader can follow a claim to its source. A link
 * that lands on the wrong page is a quiet failure of exactly the thing the docs are
 * for, and nothing checked any of them.
 *
 * Two levels, and the second is where the rot actually happens:
 *
 *   1. **The file exists.** Breaks when something is renamed or moved.
 *   2. **The heading exists.** Breaks when a heading is *reworded* — which happens
 *      constantly and leaves the link working, silently, by dumping the reader at
 *      the top of a long document instead of at the section that proves the point.
 *
 * A note on the slug rule below, because getting it wrong is worse than not checking.
 * GitHub lowercases, strips everything but word characters, spaces and hyphens, and
 * then turns **each** space into a hyphen. It does not collapse runs. So a heading
 * like `## 8. Polars — the data model` slugs to `8-polars--the-data-model`, with the
 * double hyphen left where the em-dash was. An implementation that collapses
 * whitespace reports seven perfectly good links as broken, which is how the first
 * draft of this file nearly "fixed" them.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(entry)) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) markdownFiles(p, out)
    else if (p.endsWith('.md')) out.push(p)
  }
  return out
}

/** GitHub's heading-to-anchor rule. Each space becomes a hyphen; runs are kept. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/ /g, '-')
}

interface Link {
  from: string
  target: string
}

const files = markdownFiles(root)

/** Every markdown link, minus the ones inside fenced code blocks. */
function linksIn(file: string): Link[] {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => ({ from: file, target: m[1] }))
}

const allLinks = files.flatMap(linksIn)
const relative = allLinks.filter((l) => !/^(https?:|mailto:|tel:)/.test(l.target))

const headings = new Map<string, Set<string>>()
for (const f of files) {
  const set = new Set<string>()
  for (const m of readFileSync(f, 'utf8').matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) set.add(slug(m[1]))
  headings.set(resolve(f), set)
}

const show = (p: string) => p.replace(root, '').replace(/\\/g, '/').replace(/^\//, '')

describe('the corpus is what these tests think it is', () => {
  it('found the documentation', () => {
    // A guard on the guard: if the walker breaks, every test below passes vacuously.
    expect(files.length).toBeGreaterThan(20)
    expect(relative.length).toBeGreaterThan(50)
  })

  it('slugs headings the way GitHub does', () => {
    expect(slug('8. Polars — the data model')).toBe('8-polars--the-data-model')
    // Trimmed before spaces become hyphens, so no leading hyphen survives.
    expect(slug('  Leading and trailing  ')).toBe('leading-and-trailing')
    expect(slug('5. Precedence — copy Expedition here')).toBe('5-precedence--copy-expedition-here')
    expect(slug("What's real and what isn't")).toBe('whats-real-and-what-isnt')
    expect(slug('Wind height scaling')).toBe('wind-height-scaling')
  })
})

describe('every internal link resolves', () => {
  it('points at a file that exists', () => {
    const broken: string[] = []
    for (const { from, target } of relative) {
      const [path] = target.split('#')
      if (!path) continue // pure anchor, checked below
      const abs = resolve(dirname(from), decodeURIComponent(path))
      if (!existsSync(abs)) broken.push(`${show(from)} -> ${target}`)
    }
    expect(broken, `broken file links:\n${broken.join('\n')}`).toEqual([])
  })

  it('points at a heading that exists', () => {
    /*
     * The one that rots. Three links here pointed at `#wind-height-scaling` and
     * `#weather-field-merging` after those headings were numbered, so each dropped
     * the reader at the top of a 400-line document rather than at the section being
     * cited.
     */
    const broken: string[] = []
    for (const { from, target } of relative) {
      if (!target.includes('#')) continue
      const [path, anchor] = target.split('#')
      if (!anchor) continue
      const abs = path ? resolve(dirname(from), decodeURIComponent(path)) : resolve(from)
      if (!abs.endsWith('.md') || !existsSync(abs)) continue
      const set = headings.get(abs)
      if (!set) continue
      if (!set.has(anchor.toLowerCase())) broken.push(`${show(from)} -> ${target}`)
    }
    expect(broken, `broken anchors:\n${broken.join('\n')}`).toEqual([])
  })
})

describe('the documents the README promises are present', () => {
  it('has every file the reading order names', () => {
    // The README's reading order is the front door; a 404 there is the first thing
    // a new contributor meets.
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const named = [...readme.matchAll(/\((docs\/[^)#]+)\)/g)].map((m) => m[1])
    expect(named.length).toBeGreaterThan(5)
    for (const rel of named) {
      expect(existsSync(join(root, rel)), `README names ${rel}`).toBe(true)
    }
  })
})
