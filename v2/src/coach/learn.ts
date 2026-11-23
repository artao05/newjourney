/**
 * What the app learns about a boat and its crew, session by session, and keeps
 * on this device. It feeds two things: the coach (tendencies over time, the
 * crew's answers to earlier questions) and the targets on the instruments,
 * which become "your boat's" targets as the learned polar factor settles.
 */
import type { Analysis, Category } from './analyze'

export interface SessionSummary {
  t: number
  durationS: number
  avgTws: number
  upwindPolarPct: number | null
  downwindPolarPct: number | null
  tacks: number
  avgTackLossM: number | null
  lostS: number
  findings: Array<{ id: string; category: Category; title: string; metric: string }>
  place?: string
}

export interface Answer {
  t: number
  question: string
  answer: string
}

export interface BoatProfile {
  boatId: string
  sessions: SessionSummary[]
  /** Achieved fraction of the book polar, by wind band: "0-6", "6-10", "10-14", "14-18", "18+". */
  polarFactor: Record<string, { up: number; down: number; n: number }>
  tackLossM: { mean: number; n: number } | null
  tendencies: Partial<Record<Category, number>>
  answers: Answer[]
  notes: string[]
}

const KEY = (boatId: string) => `nj2.profile.${boatId}`

export function windBand(tws: number): string {
  if (tws < 6) return '0-6'
  if (tws < 10) return '6-10'
  if (tws < 14) return '10-14'
  if (tws < 18) return '14-18'
  return '18+'
}

export function emptyProfile(boatId: string): BoatProfile {
  return { boatId, sessions: [], polarFactor: {}, tackLossM: null, tendencies: {}, answers: [], notes: [] }
}

export function loadProfile(boatId: string): BoatProfile {
  try {
    const raw = localStorage.getItem(KEY(boatId))
    if (raw) return { ...emptyProfile(boatId), ...(JSON.parse(raw) as BoatProfile) }
  } catch {
    // Private mode or blocked storage: start fresh, the app still works.
  }
  return emptyProfile(boatId)
}

export function saveProfile(p: BoatProfile): void {
  try {
    localStorage.setItem(KEY(p.boatId), JSON.stringify(p))
  } catch {
    // Nothing to do: the profile lives for this visit only.
  }
}

/** Fold one analysed session into the profile (pure: returns a new profile). */
export function learnFrom(p: BoatProfile, a: Analysis, place?: string): BoatProfile {
  const s = a.stats
  const band = windBand(s.avgTws)
  const prev = p.polarFactor[band] ?? { up: 1, down: 1, n: 0 }
  const k = 1 / (prev.n + 1) // running mean, then an EWMA once settled
  const w = Math.max(k, 0.25)
  const up = s.upwindPolarPct !== null ? prev.up + (s.upwindPolarPct / 100 - prev.up) * w : prev.up
  const down = s.downwindPolarPct !== null ? prev.down + (s.downwindPolarPct / 100 - prev.down) * w : prev.down
  const tackLossM =
    s.avgTackLossM === null
      ? p.tackLossM
      : p.tackLossM
        ? { mean: p.tackLossM.mean + (s.avgTackLossM - p.tackLossM.mean) * Math.max(1 / (p.tackLossM.n + 1), 0.25), n: p.tackLossM.n + 1 }
        : { mean: s.avgTackLossM, n: 1 }
  const tendencies = { ...p.tendencies }
  for (const cat of new Set(a.findings.map((f) => f.category))) tendencies[cat] = (tendencies[cat] ?? 0) + 1
  const summary: SessionSummary = {
    t: Date.now(),
    durationS: s.durationS,
    avgTws: s.avgTws,
    upwindPolarPct: s.upwindPolarPct,
    downwindPolarPct: s.downwindPolarPct,
    tacks: s.tacks,
    avgTackLossM: s.avgTackLossM,
    lostS: a.lostS,
    findings: a.findings.map((f) => ({ id: f.id, category: f.category, title: f.title, metric: f.metric })),
    ...(place ? { place } : {}),
  }
  return {
    ...p,
    sessions: [...p.sessions, summary].slice(-30),
    polarFactor: { ...p.polarFactor, [band]: { up, down, n: prev.n + 1 } },
    tackLossM,
    tendencies,
  }
}

/** The learned fraction of the polar to expect in this wind, upwind or down. */
export function learnedFactor(p: BoatProfile, tws: number, upwind: boolean): number | null {
  const f = p.polarFactor[windBand(tws)]
  if (!f || f.n === 0) return null
  return upwind ? f.up : f.down
}

export function addAnswer(p: BoatProfile, question: string, answer: string): BoatProfile {
  return { ...p, answers: [...p.answers, { t: Date.now(), question, answer }].slice(-40) }
}

export function addNotes(p: BoatProfile, notes: string[]): BoatProfile {
  const set = new Set([...p.notes, ...notes.map((n) => n.trim()).filter(Boolean)])
  return { ...p, notes: [...set].slice(-40) }
}

/** Categories that came up in at least half of the last sessions (min 2). */
export function recurring(p: BoatProfile): Category[] {
  const recent = p.sessions.slice(-6)
  if (recent.length < 2) return []
  const counts = new Map<Category, number>()
  for (const s of recent) for (const c of new Set(s.findings.map((f) => f.category))) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts].filter(([, n]) => n >= Math.max(2, recent.length / 2)).map(([c]) => c)
}
