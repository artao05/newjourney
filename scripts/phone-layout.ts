/**
 * The app at phone sizes, in a real browser, against the production build.
 *
 *   npm run build && npm run test:phone
 *
 * jsdom has no layout, so nothing in the unit suite can see a button pushed off a
 * clipped edge, and that is how Route's SETTINGS came to be unreachable on any phone
 * under about 420 px wide with every test green. This fails on what stops a sailor:
 * a page that scrolls sideways, a tab bar pushed off the screen, a control that nothing
 * can scroll to, or something else lying on top of a control.
 *
 * Location is refused on purpose. That brings up the most warnings the screens carry,
 * so it is the most crowded the layout gets without a race under way.
 *
 * Uses the machine's Chrome rather than a browser downloaded for the job; GitHub's
 * Ubuntu runners have one. Set CHROME_PATH to use another.
 */

import { chromium, type Page } from 'playwright-core'
import { preview } from 'vite'

/** Small Android, common Android and iPhone widths, with their usable heights. */
const SIZES = [
  { width: 360, height: 640 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]

const LIVE = process.env.LIVE === '1'

const TABS = ['Start', 'Race', 'Weather', 'Route', 'Strip', 'Setup']

/** Buttons that open a sheet worth checking too: the tab they are on, and their name. */
const SHEETS = [
  ['Start', 'TIMER'],
  ['Start', 'LINE'],
  ['Route', 'SETTINGS'],
]

/** Runs in the page: what is wrong with what is on the screen now. */
function findProblems(): string[] {
  // In here because this function is sent to the page, and takes nothing with it.
  const MIN_TAP_PX = 34
  const problems: string[] = []
  const W = window.innerWidth
  const H = window.innerHeight
  const root = document.documentElement
  if (root.scrollWidth > W) problems.push(`the page scrolls sideways by ${root.scrollWidth - W}px`)
  if (root.scrollHeight > H) problems.push(`the page scrolls down by ${root.scrollHeight - H}px, past the app's own frame`)
  const tabbar = document.querySelector('.tabbar')?.getBoundingClientRect()
  if (tabbar && tabbar.bottom > H + 1) problems.push(`the tab bar ends at ${Math.round(tabbar.bottom)}px on a ${H}px screen`)

  const name = (el: Element) =>
    ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 30)

  /** Can scrolling bring this inside each clipping ancestor, and the screen? */
  const reachable = (el: Element): string | null => {
    const r = el.getBoundingClientRect()
    let scrollsX = false
    let scrollsY = false
    for (let a = el.parentElement; a; a = a.parentElement) {
      const s = getComputedStyle(a)
      const box = a.getBoundingClientRect()
      if (s.overflowX === 'auto' || s.overflowX === 'scroll') scrollsX = true
      else if ((s.overflowX === 'hidden' || s.overflowX === 'clip') && !scrollsX && (r.right > box.right + 1 || r.left < box.left - 1)) return `cut off sideways by .${a.className}`
      if (s.overflowY === 'auto' || s.overflowY === 'scroll') scrollsY = true
      else if ((s.overflowY === 'hidden' || s.overflowY === 'clip') && !scrollsY && (r.bottom > box.bottom + 1 || r.top < box.top - 1)) return `cut off below by .${a.className}`
    }
    if (!scrollsX && (r.right > W + 1 || r.left < -1)) return `off the screen sideways, ${Math.round(r.left)} to ${Math.round(r.right)}`
    if (!scrollsY && (r.bottom > H + 1 || r.top < -1)) return `off the screen, ${Math.round(r.top)} to ${Math.round(r.bottom)}`
    return null
  }

  // With a sheet up, what matters is the sheet: what it lies over is meant to be covered.
  const sheets = document.querySelectorAll('.sheet')
  const scope: ParentNode = sheets[sheets.length - 1] ?? document
  for (const el of scope.querySelectorAll('button, a[href], input, select, textarea')) {
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.pointerEvents === 'none') continue
    if (el.closest('.maplibregl-ctrl')) continue
    const why = reachable(el)
    if (why) {
      problems.push(`"${name(el)}" is ${why}`)
      continue
    }
    const isTapTarget = el.tagName === 'BUTTON' || el.tagName === 'SELECT'
    if (isTapTarget && (r.width < MIN_TAP_PX || r.height < MIN_TAP_PX)) {
      problems.push(`"${name(el)}" is only ${Math.round(r.width)}×${Math.round(r.height)}px to tap`)
    }
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const box = el.getBoundingClientRect()
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    if (at && !el.contains(at) && !at.contains(el) && !(el as HTMLInputElement).labels?.[0]?.contains(at)) {
      problems.push(`"${name(el)}" is covered by .${(at as HTMLElement).className || at.tagName}`)
    }
  }
  return problems
}

async function tapNamed(page: Page, label: string): Promise<boolean> {
  const b = page.getByRole('button', { name: label, exact: true }).first()
  if (!(await b.count())) return false
  // Through the DOM: the check is on what the tap opens, and findProblems judges reaching it.
  await b.evaluate((el) => (el as HTMLElement).click())
  return true
}

async function openTab(page: Page, tab: string): Promise<void> {
  await page.locator('.tabbar button', { hasText: tab }).evaluate((el) => (el as HTMLElement).click())
  await page.waitForFunction(() => !document.querySelector('.spinner'), undefined, { timeout: 30_000 })
  await page.waitForTimeout(LIVE ? 6000 : 400)
}

async function main(): Promise<void> {
  const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: 'error' })
  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error('vite preview gave no local URL')
  const browser = await chromium.launch(
    process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH, args: ['--enable-unsafe-swiftshader'] }
      : { channel: 'chrome', args: ['--enable-unsafe-swiftshader'] },
  )
  const failures: string[] = []
  const report = (where: string, problems: string[]) => {
    for (const p of new Set(problems)) failures.push(`${where}: ${p}`)
  }
  try {
    for (const size of SIZES) {
      const context = await browser.newContext({ viewport: size, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
      // Nothing past this machine: a layout check must not depend on, or spend, a
      // forecast API's quota. A failed forecast's message is part of the crowd anyway.
      // By hand, LIVE=1 lets the forecast in, to see the screens that only appear with one.
      if (!LIVE) await context.route((u) => u.hostname !== new URL(url).hostname, (route) => route.abort())
      const page = await context.newPage()
      const crashes: string[] = []
      page.on('pageerror', (e) => crashes.push(e.message))
      await page.goto(url)
      await page.getByRole('button', { name: /understand|accept/i }).first().evaluate((el) => (el as HTMLElement).click())
      for (const tab of TABS) {
        await openTab(page, tab)
        report(`${size.width}×${size.height} ${tab}`, await page.evaluate(findProblems))
        if (await page.getByText('screen hit a problem').count()) failures.push(`${size.width}×${size.height} ${tab}: the screen's error boundary caught something`)
      }
      for (const [tab, label] of SHEETS) {
        await openTab(page, tab)
        if (!(await tapNamed(page, label))) {
          failures.push(`${size.width}×${size.height} ${tab}: no ${label} button`)
          continue
        }
        await page.waitForTimeout(300)
        report(`${size.width}×${size.height} ${tab} ${label}`, await page.evaluate(findProblems))
        await page.reload()
      }
      report(`${size.width}×${size.height}`, crashes.map((m) => `uncaught error: ${m}`))
      await context.close()
    }
  } finally {
    await browser.close()
    await new Promise<void>((done, fail) => server.httpServer.close((e) => (e ? fail(e) : done())))
  }
  if (failures.length) {
    console.error(`${failures.length} phone layout problem(s):\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`Phone layout: ${TABS.length} tabs and ${SHEETS.length} sheets fine at ${SIZES.map((s) => `${s.width}×${s.height}`).join(', ')}.`)
}

await main()
