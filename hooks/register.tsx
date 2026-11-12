import type { EngineInterface, PromptSubmitInput, Register } from 'claude-code'

// Before a prompt is sent, a cheaper model (one tier below the session's model)
// asks the person a few questions, then writes the real prompt, very detailed.
// The detailed prompt replaces the typed one and is sent.

const CMD = 'preprompt'
const MIN_WORDS = 4
const MAX_QUESTIONS = 4
const ENABLED = { plugin: 'preprompt', key: 'enabled' } as const
const SKIPPED = 'skipped, no answer'

// fable -> opus, opus -> sonnet, sonnet -> haiku, haiku stays haiku.
export const helperModel = (current: string) => {
  const m = current.toLowerCase()
  if (m.includes('fable')) return 'opus'
  if (m.includes('opus')) return 'sonnet'
  if (m.includes('sonnet')) return 'haiku'
  return 'haiku'
}

const GAPS_SYSTEM = `You help a person prepare a prompt for a stronger AI assistant.
Read their short prompt. Ask only the questions whose answers would clearly change the result: missing goal, audience, format, scope, constraints, files or sources, or two parts that clash.

Return JSON only, no prose, no code fences, exactly:
{"questions":[{"q":"<short question ending in a question mark>","options":["<option>","<option>"]}]}

Rules:
- 0 to ${MAX_QUESTIONS} questions. If the prompt is already clear, return {"questions":[]}. Fewer is better.
- Never ask what the prompt already answers. Never ask about style nice-to-haves.
- Each question has 2 or 3 short options (1 to 5 words). No "Other" option; the person can type their own.
- Write the questions and options in the same language as the person's prompt.`

const WRITE_SYSTEM = `You turn a person's short prompt, plus their answers to follow-up questions, into the real prompt that is sent to a stronger AI assistant.

Output only the final prompt text, no preamble, no code fences, no commentary.

Rules:
- Write it in the same language as the person's prompt, in first person, as if they wrote it.
- Keep every fact, name, number, file, link and tool from the original. Add no new facts, names or requirements.
- Make it as detailed as the task needs, no more. A small task gets a few clear lines; a big or vague task gets sections for the goal, context, scope, constraints, expected format and what "done" means. Never pad, repeat yourself or add requirements the person did not imply. Where something is unknown, say so plainly instead of inventing it.
- Tell the assistant to be thorough where the task needs it, without padding or an unneeded long answer.
- Use each answer as the person's own words. Where an answer was skipped, leave that point open for the assistant to decide or ask.`

export type Gap = { q: string; options: string[] }
export type QA = { q: string; a: string | null }

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length
const fromPerson = (e: PromptSubmitInput) => e.origin.kind === 'composer' || e.origin.kind === 'bridge'

const stripFences = (raw: string) =>
  raw
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/, '')
    .trim()

export const parseGaps = (raw: string): Gap[] => {
  const t = stripFences(raw)
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('no JSON object in the reply')
  const json = JSON.parse(t.slice(a, b + 1)) as { questions?: unknown }
  if (!Array.isArray(json.questions)) throw new Error('no questions list in the reply')
  const out: Gap[] = []
  for (const item of json.questions) {
    if (out.length >= MAX_QUESTIONS) break
    const { q, options } = (item ?? {}) as { q?: unknown; options?: unknown }
    if (typeof q !== 'string' || !q.trim() || !Array.isArray(options)) continue
    const opts: string[] = []
    for (const o of options) {
      const label = typeof o === 'string' ? o.trim() : ''
      if (!label || /^other$/i.test(label) || opts.includes(label)) continue
      if (opts.length < 3) opts.push(label)
    }
    if (opts.length < 2) continue
    out.push({ q: q.trim(), options: opts })
  }
  return out
}

const failWhy = (r: { reason: string; error?: string; status?: number | null }) =>
  r.reason === 'api-error' ? `the model call failed (${r.error}${r.status ? ` ${r.status}` : ''})` : r.reason === 'aborted' ? 'the model call timed out' : 'the model gave no text'

export const writePrompt = (original: string, qa: QA[]) => {
  let p = `Here is the person's prompt:\n\n<prompt>\n${original}\n</prompt>`
  if (qa.length) {
    const lines = qa.map(x => `Q: ${x.q}\nA: ${x.a ?? SKIPPED}`).join('\n\n')
    p += `\n\nI asked them these follow-up questions:\n\n<answers>\n${lines}\n</answers>`
  }
  return `${p}\n\nWrite the final prompt now.`
}

async function isOn($: EngineInterface) {
  const v = await $.store.get('enabled').catch(() => undefined)
  return v !== false
}

async function findGaps($: EngineInterface, model: string, text: string): Promise<Gap[]> {
  try {
    const r = await $.model.complete({
      model,
      system: GAPS_SYSTEM,
      prompt: `Here is the prompt. Return the JSON.\n\n<prompt>\n${text}\n</prompt>`,
      maxTokens: 800,
      effort: 'low',
      timeoutMs: 45_000,
    })
    if (!r.isAnswered) return []
    return parseGaps(r.text)
  } catch {
    return []
  }
}

async function askGaps($: EngineInterface, gaps: Gap[]): Promise<QA[]> {
  const out: QA[] = []
  for (const [i, g] of gaps.entries()) {
    $.ui.status(`Preprompt: question ${i + 1} of ${gaps.length}`)
    let a: string | null = null
    try {
      const said = (await $.ui.ask(g.q, { options: g.options, header: `Q ${i + 1} of ${gaps.length}` })).trim()
      a = said || null
    } catch {
      a = null
    }
    out.push({ q: g.q, a })
  }
  return out
}

let handled = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: CMD, description: 'Turn preprompt on or off' })
    await $.state.set(ENABLED, await isOn($))
    return result
  })

  on('command.run', { command: CMD }, async $ => {
    const now = !(await isOn($))
    await $.store.set('enabled', now)
    await $.state.set(ENABLED, now)
    const text = now ? 'Preprompt is on.' : 'Preprompt is off.'
    $.ui.toast(text)
    return { text }
  })

  on('prompt.submit', async ($, e, next) => {
    const t = e.text.trim()
    if (e.command || e.isMeta || !fromPerson(e) || t.startsWith('/') || words(t) < MIN_WORDS) return next(e)
    if (!(await isOn($))) return next(e)
    // Only the first prompt of a chat.
    if (handled || (await $.session.turns().catch(() => 0)) > 1) return next(e)
    handled = true

    try {
      const model = helperModel(await $.session.model())
      $.ui.status(`Preprompt: reading your prompt (${model})`)
      const qa = await askGaps($, await findGaps($, model, t))
      $.ui.status(`Preprompt: writing the detailed prompt (${model})`)
      const r = await $.model.complete({
        model,
        system: WRITE_SYSTEM,
        prompt: writePrompt(t, qa),
        maxTokens: 3000,
        effort: 'low',
        timeoutMs: 90_000,
      })
      $.ui.status(undefined)
      if (!r.isAnswered) throw new Error(failWhy(r))
      const detailed = stripFences(r.text)
      if (!detailed) throw new Error('the model gave no text')
      $.ui.toast('Preprompt: sent the detailed prompt.')
      return next({ ...e, text: detailed })
    } catch (err) {
      $.ui.status(undefined)
      $.ui.toast(`Preprompt failed: ${err instanceof Error ? err.message : String(err)}. Sent as typed.`)
      return next(e)
    }
  })
}
