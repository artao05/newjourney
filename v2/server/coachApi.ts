/**
 * The AI coach's server half: a Vite plugin that serves
 *
 *   GET  /api/coach/status   -> { ai: boolean, model }
 *   POST /api/coach/debrief  -> CoachDebrief (structured JSON)
 *   POST /api/coach/chat     -> { reply: string }
 *
 * It runs in the dev and preview servers, so the Anthropic credential stays on
 * this machine (ANTHROPIC_API_KEY, or an `ant auth login` profile). The browser
 * never holds a key. With no credential, the app falls back to its own
 * rule-based coach (v2/src/coach/offline.ts) and says so.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const MODEL = 'claude-opus-5-5'

const SYSTEM = `You are the on-the-water coach inside NewJourney, a sailing navigation and racing app.

Who you coach: sailors of every level, many of them new to racing. Speak plainly. When you use a sailing term (VMG, layline, header, lift, TWA, target speed), say what it means in a few words the first time. Be warm, direct and specific: name the moment, the number, and the fix. Never invent data: every claim must come from the telemetry analysis, the race log, the boat profile or the sailor's own answers you are given. If the data cannot tell you why something happened, say so and ask.

What you receive: an analysis the app computed from the boat's NMEA 2000 instrument log (speed, heading, true wind, polar targets), detected tacks and gybes with their measured loss, start statistics, leg-by-leg numbers, the fleet's results when racing against others, and a profile the app has learned about this boat and crew over past sessions, including earlier answers to your questions.

How to coach:
- Lead with the one or two changes that would have gained the most, in boat lengths or seconds when the data gives them.
- Separate tendencies (patterns across the race or across sessions) from one-off mistakes.
- Credit what went well, briefly and specifically.
- Ask clarifying questions where the cause is ambiguous: crew weight and positions, sail trim and settings, waves, traffic, whether a manoeuvre was forced by another boat, what the helm was looking at. Ask only questions whose answer would change your advice, at most three.
- Offer short drills the sailor can do next time out.
- Note facts about the boat worth remembering for next time (for example, "loses about 2 boat lengths per tack in 8 to 10 knots").`

const DEBRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'summary', 'tendencies', 'mistakes', 'strengths', 'questions', 'drills', 'boat_notes'],
  properties: {
    headline: { type: 'string', description: 'One sentence: the biggest takeaway.' },
    summary: { type: 'string', description: 'Three to five sentences on how the race went.' },
    tendencies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail'],
        properties: { title: { type: 'string' }, detail: { type: 'string' } },
      },
    },
    mistakes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding_id', 'title', 'what_happened', 'why_it_matters', 'fix'],
        properties: {
          finding_id: { type: 'string', description: 'The id of the analysis finding this is about, or "" if none.' },
          title: { type: 'string' },
          what_happened: { type: 'string' },
          why_it_matters: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    strengths: { type: 'array', items: { type: 'string' } },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'question', 'why'],
        properties: { id: { type: 'string' }, question: { type: 'string' }, why: { type: 'string' } },
      },
    },
    drills: { type: 'array', items: { type: 'string' } },
    boat_notes: { type: 'array', items: { type: 'string' } },
  },
} as const

let client: Anthropic | null = null
function anthropic(): Anthropic {
  client ??= new Anthropic()
  return client
}

function hasCredential(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function textOf(msg: Anthropic.Beta.BetaMessage): string {
  return msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

async function ask(o: {
  messages: Anthropic.Beta.BetaMessageParam[]
  effort: 'low' | 'medium'
  schema?: Record<string, unknown>
}): Promise<string> {
  const msg = await anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 16_000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: {
      effort: o.effort,
      ...(o.schema ? { format: { type: 'json_schema' as const, schema: o.schema } } : {}),
    },
    messages: o.messages,
  })
  if (msg.stop_reason === 'refusal') throw new CoachError(422, 'The coach declined this request.')
  if (msg.stop_reason === 'max_tokens') throw new CoachError(502, 'The coach ran out of room; try again.')
  return textOf(msg)
}

class CoachError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function errorStatus(e: unknown): { status: number; message: string } {
  if (e instanceof CoachError) return { status: e.status, message: e.message }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return { status: 401, message: 'No working Anthropic credential on the server.' }
  if (e instanceof Anthropic.RateLimitError) return { status: 429, message: 'The AI coach is rate limited; try again shortly.' }
  if (e instanceof Anthropic.BadRequestError) return { status: 400, message: e.message }
  if (e instanceof Anthropic.APIConnectionError) return { status: 503, message: 'Could not reach the AI service.' }
  if (e instanceof Anthropic.APIError) return { status: 502, message: e.message }
  // The SDK throws a plain Error when it finds no credential at all.
  return { status: 401, message: e instanceof Error ? e.message : String(e) }
}

interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
  const url = req.url ?? ''
  if (!url.startsWith('/api/coach')) return next()
  try {
    if (url.startsWith('/api/coach/status')) {
      return send(res, 200, { ai: hasCredential(), model: MODEL })
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
    const body = (await readJson(req)) as { context?: unknown; history?: ChatTurn[]; question?: string }
    const context = JSON.stringify(body.context ?? {}, null, 1)

    if (url.startsWith('/api/coach/debrief')) {
      const text = await ask({
        effort: 'medium',
        schema: DEBRIEF_SCHEMA as unknown as Record<string, unknown>,
        messages: [
          {
            role: 'user',
            content: `Here is the session to debrief, as JSON.\n\n<session>\n${context}\n</session>\n\nWrite the debrief.`,
          },
        ],
      })
      return send(res, 200, JSON.parse(text))
    }

    if (url.startsWith('/api/coach/chat')) {
      const history = (body.history ?? []).slice(-16)
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        {
          role: 'user',
          content: `Session context, as JSON. Answer the sailor's messages that follow using it.\n\n<session>\n${context}\n</session>`,
        },
        { role: 'assistant', content: 'Got it. I have the session in front of me.' },
        ...history.map((t) => ({ role: t.role, content: t.text }) as Anthropic.Beta.BetaMessageParam),
        { role: 'user', content: String(body.question ?? '') },
      ]
      const reply = await ask({ effort: 'low', messages })
      return send(res, 200, { reply })
    }
    return send(res, 404, { error: 'unknown coach endpoint' })
  } catch (e) {
    const { status, message } = errorStatus(e)
    return send(res, status, { error: message })
  }
}

export function coachApi(): Plugin {
  return {
    name: 'newjourney-coach-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next))
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next))
    },
  }
}
