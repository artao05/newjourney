/**
 * The browser half of the AI coach. Talks to the dev/preview server's
 * /api/coach endpoints (v2/server/coachApi.ts); when they are missing or have
 * no credential, falls back to the rule-based coach so the app still works.
 */
import type { Analysis } from './analyze'
import { offlineChat, offlineDebrief, type CoachContext, type CoachDebrief } from './debrief'
import type { BoatProfile } from './learn'

export interface AiStatus {
  ai: boolean
  model: string | null
  reason: string | null
}

export async function aiStatus(): Promise<AiStatus> {
  try {
    const r = await fetch('/api/coach/status')
    if (!r.ok) return { ai: false, model: null, reason: 'No coach server (static build).' }
    const j = (await r.json()) as { ai: boolean; model: string }
    return { ai: j.ai, model: j.model, reason: j.ai ? null : 'No Anthropic credential on the server: set ANTHROPIC_API_KEY and restart.' }
  } catch {
    return { ai: false, model: null, reason: 'Coach server unreachable.' }
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j
}

export async function debrief(o: { analysis: Analysis; context: CoachContext; profile: BoatProfile; useAi: boolean }): Promise<{ debrief: CoachDebrief; note: string | null }> {
  if (o.useAi) {
    try {
      const d = await post<Omit<CoachDebrief, 'source'>>('/api/coach/debrief', { context: o.context })
      return { debrief: { ...d, source: 'ai' }, note: null }
    } catch (e) {
      return { debrief: offlineDebrief(o.analysis, o.context, o.profile), note: `AI coach unavailable (${e instanceof Error ? e.message : String(e)}); showing the built-in coach.` }
    }
  }
  return { debrief: offlineDebrief(o.analysis, o.context, o.profile), note: null }
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

export async function chat(o: { question: string; history: ChatTurn[]; context: CoachContext | null; analysis: Analysis | null; useAi: boolean }): Promise<string> {
  if (o.useAi && o.context) {
    try {
      const r = await post<{ reply: string }>('/api/coach/chat', { context: o.context, history: o.history, question: o.question })
      return r.reply
    } catch (e) {
      return `${offlineChat(o.question, o.analysis)}\n\n(AI coach unavailable: ${e instanceof Error ? e.message : String(e)})`
    }
  }
  return offlineChat(o.question, o.analysis)
}
